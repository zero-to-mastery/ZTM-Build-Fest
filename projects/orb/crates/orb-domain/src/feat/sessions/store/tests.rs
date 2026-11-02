use crate::feat::harness::HarnessId;
use std::path::{Path, PathBuf};

use error_stack::{Report, ResultExt};
use rusqlite::Connection;

use crate::feat::layout::floats::{FloatLayout, FloatRect};
use crate::feat::layout::tree::SwapLayout;

use super::{
    AgentRow, FloatRow, MIGRATIONS, NewPaneAgent, PaneId, ProjectId, ProjectKind, SavedLayouts,
    SessionFloats, SessionId, SessionKind, SessionRow, SettledOverride, SidebarItem, Store,
    StoreError, TabRow, Ui, Upgrade, lock, upgrade_policy,
};
use crate::common::Log;

fn user_version(path: &Path) -> Result<usize, Report<StoreError>> {
    Connection::open(path)
        .and_then(|conn| conn.pragma_query_value(None, "user_version", |row| row.get(0)))
        .change_context(StoreError)
}

/// An agent and the one-pane session it runs in.
struct Seeded {
    agent: super::AgentId,
    session: SessionId,
    pane: PaneId,
}

/// Saves agent `28bf38e2` of Claude, created at 1000, in a new plain
/// session of project `project_id` in `/tmp/orb`, one saved tab of one
/// pane.
fn insert_agent(store: &Store, project_id: ProjectId) -> Result<Seeded, Report<StoreError>> {
    let (session, pane) = store.insert_session(
        project_id,
        SessionKind::Plain,
        Path::new("/tmp/orb"),
        None,
        None,
        None,
        1_000,
    )?;
    store.save_layout(
        session,
        0,
        &[lone_tab(session, pane)],
        &SessionFloats::default(),
        &[(pane, None)],
    )?;
    let (agent, _) = store.insert_pane_agent(&NewPaneAgent {
        pane,
        session_id: "28bf38e2".to_owned(),
        transcript_path: None,
        harness: HarnessId::new("claude"),
        cwd: PathBuf::from("/tmp/orb"),
        created_at: 1_000,
    })?;
    Ok(Seeded {
        agent,
        session,
        pane,
    })
}

#[rstest::rstest]
fn lock_is_refused_while_another_holder_has_it() -> Result<(), Report<StoreError>> {
    // Given one orb holding the store's lock.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    let _held = lock(&path)?;

    // When a second orb tries to take it.
    let second = lock(&path);

    // Then it is refused.
    assert!(
        second.is_err(),
        "a second lock on the same store should fail"
    );
    Ok(())
}

#[rstest::rstest]
fn lock_is_free_again_once_its_holder_drops_it() -> Result<(), Report<StoreError>> {
    // Given an orb that held the store's lock and quit.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    drop(lock(&path)?);

    // When another orb takes it.
    let next = lock(&path);

    // Then it gets the lock.
    assert!(next.is_ok(), "a released lock should be free to take");
    Ok(())
}

#[rstest::rstest]
fn migrating_a_fresh_database_sets_the_latest_schema_version() -> Result<(), Report<StoreError>> {
    // Given a path with no database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");

    // When opening the store.
    drop(Store::open(&path)?);

    // Then the database is at the latest schema version.
    assert_eq!(
        user_version(&path)?,
        MIGRATIONS.len(),
        "a fresh database should run every migration"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_a_v1_database_adds_the_custom_title_column() -> Result<(), Report<StoreError>> {
    // Given a database at schema version 1.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    {
        let v1 = MIGRATIONS
            .first()
            .ok_or_else(|| Report::new(StoreError).attach("no v1 migration"))?;
        let conn = Connection::open(&path).change_context(StoreError)?;
        v1.apply(&conn).change_context(StoreError)?;
        conn.pragma_update(None, "user_version", 1)
            .change_context(StoreError)?;
    }

    // When opening the store.
    drop(Store::open(&path)?);

    // Then it's at the latest version with a custom_title column.
    let has_column = Connection::open(&path)
        .change_context(StoreError)?
        .prepare("SELECT custom_title FROM threads")
        .is_ok();
    assert_eq!(
        (user_version(&path)?, has_column),
        (MIGRATIONS.len(), true),
        "migration v2 should add threads.custom_title"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_a_v2_database_seeds_activity_and_visit_from_created_at()
-> Result<(), Report<StoreError>> {
    // Given a database at schema version 2 holding an agent created at 1 s.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    {
        let conn = Connection::open(&path).change_context(StoreError)?;
        for sql in MIGRATIONS
            .get(..2)
            .ok_or_else(|| Report::new(StoreError).attach("no v2 migrations"))?
        {
            sql.apply(&conn).change_context(StoreError)?;
        }
        conn.execute_batch(
            "INSERT INTO projects (id, root, title, created_at) VALUES (1, '/tmp/orb', 'orb', 500);
                 INSERT INTO threads (project_id, short_id, cwd, created_at)
                 VALUES (1, '28bf38e2', '/tmp/orb', 1000);
                 PRAGMA user_version = 2;",
        )
        .change_context(StoreError)?;
    }

    // When opening the store and loading.
    let (_, agents) = Store::open(&path)?.load()?;

    // Then it's at the latest version and both stamps are the creation time.
    let stamps: Vec<(i64, i64)> = agents
        .iter()
        .map(|row| (row.last_activity_at, row.last_visited_at))
        .collect();
    assert_eq!(
        (user_version(&path)?, stamps),
        (MIGRATIONS.len(), vec![(1_000, 1_000)]),
        "migration v3 should seed last activity and last visit from created_at"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_a_v3_database_adds_ai_titled() -> Result<(), Report<StoreError>> {
    // Given a database at schema version 3 holding an agent.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    {
        let conn = Connection::open(&path).change_context(StoreError)?;
        for sql in MIGRATIONS
            .get(..3)
            .ok_or_else(|| Report::new(StoreError).attach("no v3 migrations"))?
        {
            sql.apply(&conn).change_context(StoreError)?;
        }
        conn.execute_batch(
            "INSERT INTO projects (id, root, title, created_at) VALUES (1, '/tmp/orb', 'orb', 500);
                 INSERT INTO threads (project_id, short_id, cwd, created_at)
                 VALUES (1, '28bf38e2', '/tmp/orb', 1000);
                 PRAGMA user_version = 3;",
        )
        .change_context(StoreError)?;
    }

    // When opening the store and loading.
    let (_, agents) = Store::open(&path)?.load()?;

    // Then it's at the latest version and the agent isn't AI-titled.
    let ai_titled: Vec<bool> = agents.iter().map(|row| row.ai_titled).collect();
    assert_eq!(
        (user_version(&path)?, ai_titled),
        (MIGRATIONS.len(), vec![false]),
        "migration v4 should add ai_titled, false for existing agents"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_a_v4_database_adds_the_agent_model_and_keeps_its_agents()
-> Result<(), Report<StoreError>> {
    // Given a database at schema version 4 holding an agent.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    {
        let conn = Connection::open(&path).change_context(StoreError)?;
        for sql in MIGRATIONS
            .get(..4)
            .ok_or_else(|| Report::new(StoreError).attach("no v4 migrations"))?
        {
            sql.apply(&conn).change_context(StoreError)?;
        }
        conn.execute_batch(
            "INSERT INTO projects (id, root, title, created_at) VALUES (1, '/tmp/orb', 'orb', 500);
                 INSERT INTO threads (project_id, short_id, cwd, created_at)
                 VALUES (1, '28bf38e2', '/tmp/orb', 1000);
                 PRAGMA user_version = 4;",
        )
        .change_context(StoreError)?;
    }

    // When opening the store.
    let (_, agents) = Store::open(&path)?.load()?;

    // Then it's at the latest version, the agent survives, and the
    // agent model column exists.
    let conn = Connection::open(&path).change_context(StoreError)?;
    let has_schema = conn.prepare("SELECT model FROM threads").is_ok();
    let short_ids: Vec<String> = agents.into_iter().map(|row| row.short_id).collect();
    assert_eq!(
        (user_version(&path)?, short_ids, has_schema),
        (MIGRATIONS.len(), vec!["28bf38e2".to_owned()], true),
        "migration v5 should keep agents and add the agent model column"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_a_v5_database_adds_ui_and_removed_at() -> Result<(), Report<StoreError>> {
    // Given a database at schema version 5 holding a project, an agent and
    // a draft.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    {
        let conn = Connection::open(&path).change_context(StoreError)?;
        for sql in MIGRATIONS
            .get(..5)
            .ok_or_else(|| Report::new(StoreError).attach("no v5 migrations"))?
        {
            sql.apply(&conn).change_context(StoreError)?;
        }
        conn.execute_batch(
            "INSERT INTO projects (id, root, title, created_at) VALUES (1, '/tmp/orb', 'orb', 500);
                 INSERT INTO threads (project_id, short_id, cwd, created_at)
                 VALUES (1, '28bf38e2', '/tmp/orb', 1000);
                 INSERT INTO drafts (project_id, workspace, created_at) VALUES (1, 'local', 2000);
                 PRAGMA user_version = 5;",
        )
        .change_context(StoreError)?;
    }

    // When opening the store.
    let (projects, agents) = Store::open(&path)?.load()?;

    // Then it's at the latest version, the project and agent survive, and
    // the ui table and removed_at column exist.
    let conn = Connection::open(&path).change_context(StoreError)?;
    let has_schema = [
        "SELECT id, sidebar_width, project_filter FROM ui",
        "SELECT removed_at FROM projects",
    ]
    .iter()
    .all(|sql| conn.prepare(sql).is_ok());
    assert_eq!(
        (
            user_version(&path)?,
            projects.len(),
            agents.len(),
            has_schema
        ),
        (MIGRATIONS.len(), 1, 1, true),
        "migration v6 should keep projects and agents and add ui and projects.removed_at"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_a_v7_database_adds_the_project_kind_and_keeps_its_agents()
-> Result<(), Report<StoreError>> {
    // Given a database at schema version 7 holding a project and an agent.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    {
        let conn = Connection::open(&path).change_context(StoreError)?;
        for sql in MIGRATIONS
            .get(..7)
            .ok_or_else(|| Report::new(StoreError).attach("no v7 migrations"))?
        {
            sql.apply(&conn).change_context(StoreError)?;
        }
        conn.execute_batch(
            "INSERT INTO projects (id, root, title, created_at) VALUES (1, '/tmp/orb', 'orb', 500);
                 INSERT INTO threads (project_id, short_id, cwd, created_at)
                 VALUES (1, '28bf38e2', '/tmp/orb', 1000);
                 PRAGMA user_version = 7;",
        )
        .change_context(StoreError)?;
    }

    // When opening the store and loading.
    let agents = Store::open(&path)?.load()?.1;

    // Then it's at the latest version, the agent survives, and the
    // project kind column exists.
    let conn = Connection::open(&path).change_context(StoreError)?;
    let has_schema = conn.prepare("SELECT kind FROM projects").is_ok();
    assert_eq!(
        (user_version(&path)?, agents.len(), has_schema),
        (MIGRATIONS.len(), 1, true),
        "migration v8 should keep agents and add projects.kind"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_a_v8_database_adds_jumps_and_keeps_its_agents() -> Result<(), Report<StoreError>> {
    // Given a database at schema version 8 holding a project and an agent.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    {
        let conn = Connection::open(&path).change_context(StoreError)?;
        for sql in MIGRATIONS
            .get(..8)
            .ok_or_else(|| Report::new(StoreError).attach("no v8 migrations"))?
        {
            sql.apply(&conn).change_context(StoreError)?;
        }
        conn.execute_batch(
            "INSERT INTO projects (id, root, title, created_at) VALUES (1, '/tmp/orb', 'orb', 500);
                 INSERT INTO threads (project_id, short_id, cwd, created_at)
                 VALUES (1, '28bf38e2', '/tmp/orb', 1000);
                 PRAGMA user_version = 8;",
        )
        .change_context(StoreError)?;
    }

    // When opening the store and loading.
    let store = Store::open(&path)?;
    let agents = store.load()?.1;

    // Then it's at the latest version, the agent survives, and the jump
    // list reads back empty.
    assert_eq!(
        (user_version(&path)?, agents.len(), store.jumps()?),
        (MIGRATIONS.len(), 1, Vec::new()),
        "migration v9 should keep agents and add an empty jumps table"
    );
    Ok(())
}

/// A database at schema version 9 holding the orb project with a draft,
/// the groups `with-agent` (holding agent `28bf38e2`) and `empty`.
fn v9_database(path: &Path) -> Result<(), Report<StoreError>> {
    let conn = Connection::open(path).change_context(StoreError)?;
    for sql in MIGRATIONS
        .get(..9)
        .ok_or_else(|| Report::new(StoreError).attach("no v9 migrations"))?
    {
        sql.apply(&conn).change_context(StoreError)?;
    }
    conn.execute_batch(
        "INSERT INTO projects (id, root, title, created_at) VALUES (1, '/tmp/orb', 'orb', 500);
             INSERT INTO drafts (project_id, workspace, created_at) VALUES (1, 'local', 600);
             INSERT INTO groups (id, project_id, kind, name, branch, created_at)
             VALUES (1, 1, 'feature', 'with-thread', 'with-thread', 700),
                    (2, 1, 'feature', 'empty', 'empty', 800);
             INSERT INTO threads (project_id, short_id, cwd, created_at, group_id)
             VALUES (1, '28bf38e2', '/tmp/orb', 1000, 1);
             PRAGMA user_version = 9;",
    )
    .change_context(StoreError)
}

#[rstest::rstest]
fn migrating_a_v9_database_backfills_claude_as_every_harness() -> Result<(), Report<StoreError>> {
    // Given a v9 database with an agent, a draft and groups.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    v9_database(&path)?;

    // When opening the store and loading.
    let (_, agents) = Store::open(&path)?.load()?;

    // Then the agent runs in claude.
    let harnesses: Vec<String> = agents.iter().map(|row| row.harness.to_string()).collect();
    assert_eq!(
        harnesses,
        vec!["claude"],
        "migration v10 should store claude as the harness of everything saved before it"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_a_v11_database_loads_its_tabs_vertical_and_untouched() -> Result<(), Report<StoreError>>
{
    // Given a database at schema version 11 holding one tab.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    {
        let conn = Connection::open(&path).change_context(StoreError)?;
        for sql in MIGRATIONS
            .get(..11)
            .ok_or_else(|| Report::new(StoreError).attach("no v11 migrations"))?
        {
            sql.apply(&conn).change_context(StoreError)?;
        }
        conn.execute_batch(
                "INSERT INTO projects (id, root, title, created_at) VALUES (1, '/tmp/orb', 'orb', 500);
                 INSERT INTO sessions (id, project_id, dir, created_at) VALUES (1, 1, '/tmp/orb', 1000);
                 INSERT INTO panes (id, session_id, cwd) VALUES (7, 1, '/tmp/orb');
                 INSERT INTO tabs (session_id, position, layout, focus_pane)
                 VALUES (1, 0, '{\"pane\":7}', 7);
                 PRAGMA user_version = 11;",
            )
            .change_context(StoreError)?;
    }

    // When opening the store and loading its layouts.
    let tabs: Vec<(String, SwapLayout, bool)> = Store::open(&path)?
        .layouts()?
        .tabs
        .into_iter()
        .map(|tab| (tab.layout, tab.swap_layout, tab.hand_changed))
        .collect();

    // Then it's at the latest version and the tab is vertical, unmarked
    // and keeps its tree.
    assert_eq!(
        (user_version(&path)?, tabs),
        (
            MIGRATIONS.len(),
            vec![("{\"pane\":7}".to_owned(), SwapLayout::Vertical, false)]
        ),
        "migration v12 should load old tabs vertical and untouched"
    );
    Ok(())
}

/// A database at schema version 12 holding one session with one pane in one tab.
fn v12_database(dir: &Path) -> Result<PathBuf, Report<StoreError>> {
    let path = dir.join("state.sqlite");
    let conn = Connection::open(&path).change_context(StoreError)?;
    for sql in MIGRATIONS
        .get(..12)
        .ok_or_else(|| Report::new(StoreError).attach("no v12 migrations"))?
    {
        sql.apply(&conn).change_context(StoreError)?;
    }
    conn.execute_batch(
        "INSERT INTO projects (id, root, title, created_at) VALUES (1, '/tmp/orb', 'orb', 500);
             INSERT INTO sessions (id, project_id, dir, created_at) VALUES (1, 1, '/tmp/orb', 1000);
             INSERT INTO panes (id, session_id, cwd) VALUES (7, 1, '/tmp/orb');
             INSERT INTO tabs (session_id, position, layout, focus_pane)
             VALUES (1, 0, '{\"pane\":7}', 7);
             PRAGMA user_version = 12;",
    )
    .change_context(StoreError)?;
    Ok(path)
}

#[rstest::rstest]
fn migrating_a_v12_database_adds_an_empty_floats_table() -> Result<(), Report<StoreError>> {
    // Given a database at schema version 12 holding one tab.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = v12_database(dir.path())?;

    // When opening the store and loading its layouts.
    let saved = Store::open(&path)?.layouts()?;

    // Then it's at the latest version with no floats and its tab kept.
    assert_eq!(
        (user_version(&path)?, saved.floats.len(), saved.tabs.len()),
        (MIGRATIONS.len(), 0, 1),
        "migration v13 should add an empty floats table and keep the tabs"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_a_v12_database_gives_sessions_the_float_defaults() -> Result<(), Report<StoreError>> {
    // Given a database at schema version 12 holding one session.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = v12_database(dir.path())?;

    // When opening the store.
    drop(Store::open(&path)?);

    // Then the session has the staggered float layout and is unmarked.
    let columns: Vec<(String, bool)> = {
        let conn = Connection::open(&path).change_context(StoreError)?;
        let mut statement = conn
            .prepare("SELECT float_layout, floats_hand_changed FROM sessions")
            .change_context(StoreError)?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .and_then(Iterator::collect)
            .change_context(StoreError)?
    };
    assert_eq!(
        columns,
        vec![("staggered".to_owned(), false)],
        "migration v13 should give old sessions the float defaults"
    );
    Ok(())
}

/// Every table orb keeps and its columns in order, tables by name.
const LIVE_SCHEMA: &[(&str, &[&str])] = &[
    (
        "floats",
        &[
            "session_id",
            "position",
            "pane_id",
            "x",
            "y",
            "width",
            "height",
            "pinned",
        ],
    ),
    ("jumps", &["position", "kind", "item_id"]),
    (
        "panes",
        &[
            "id",
            "session_id",
            "cwd",
            "zmx_name",
            "zmx_dir",
            "resume",
            "name",
        ],
    ),
    (
        "projects",
        &["id", "root", "title", "created_at", "removed_at", "kind"],
    ),
    (
        "sessions",
        &[
            "id",
            "project_id",
            "kind",
            "dir",
            "name",
            "branch",
            "created_at",
            "pinned_at",
            "settled_override",
            "settled_at",
            "unsettled_at",
            "last_activity_at",
            "last_visited_at",
            "active_tab",
            "float_layout",
            "floats_hand_changed",
            "parent_id",
        ],
    ),
    ("sqlite_sequence", &["name", "seq"]),
    (
        "tabs",
        &[
            "id",
            "session_id",
            "position",
            "name",
            "layout",
            "focus_pane",
            "swap_layout",
            "hand_changed",
        ],
    ),
    (
        "threads",
        &[
            "id",
            "project_id",
            "short_id",
            "session_id",
            "title",
            "cwd",
            "transcript_path",
            "transcript_offset",
            "created_at",
            "turn_started_at",
            "custom_title",
            "branch",
            "last_activity_at",
            "last_visited_at",
            "ai_titled",
            "model",
            "renamed_title",
            "harness",
            "pane_id",
            "orb_session_id",
        ],
    ),
    ("ui", &["id", "sidebar_width", "project_filter"]),
];

/// `LIVE_SCHEMA` as owned names, to compare with `schema`.
fn live_schema() -> Vec<(String, Vec<String>)> {
    LIVE_SCHEMA
        .iter()
        .map(|(table, columns)| {
            (
                (*table).to_owned(),
                columns.iter().map(|&column| column.to_owned()).collect(),
            )
        })
        .collect()
}

/// Every table in the database at `path` and its columns in order,
/// tables by name.
fn schema(path: &Path) -> Result<Vec<(String, Vec<String>)>, Report<StoreError>> {
    let conn = Connection::open(path).change_context(StoreError)?;
    let mut statement = conn
        .prepare(
            "SELECT m.name, p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p
                 WHERE m.type = 'table' ORDER BY m.name, p.cid",
        )
        .change_context(StoreError)?;
    let columns: Vec<(String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .and_then(Iterator::collect)
        .change_context(StoreError)?;
    Ok(columns
        .into_iter()
        .fold(Vec::new(), |mut tables, (table, column)| {
            match tables.last_mut() {
                Some((name, names)) if *name == table => names.push(column),
                _ => tables.push((table, vec![column])),
            }
            tables
        }))
}

/// A database at schema version 13 holding live and leftover data:
/// project 1 and removed Research project 2, both with their last-used
/// values; group 41 and a draft of project 1; settled session 11 and
/// pinned, named session 12; panes 101 (session 11, named, resumes a
/// Claude session, marked as a `--bg` session), 102 and float pane 103
/// (session 12); a tab of each session; Claude agent 301 in pane 101,
/// every column set and in group 41; pi agent 302 in pane 102; two jumps;
/// the ui row. Panes up to 150 were made once, so the pane sequence is at 150.
fn v13_database(path: &Path) -> Result<(), Report<StoreError>> {
    database_at(path, 13)?;
    Connection::open(path)
            .and_then(|conn| {
                conn.execute_batch(
                    "INSERT INTO projects (id, root, title, created_at, last_workspace, last_model,
                                           last_permission_mode, last_used_at, removed_at, kind,
                                           last_harness)
                     VALUES (1, '/work/orb', 'orb', 100, 'local', 'opus', 'plan', 900, NULL,
                             NULL, 'pi'),
                            (2, '/r/papers', 'papers', 110, 'local', 'sonnet', 'default', 910,
                             950, 'research', 'claude');
                     INSERT INTO groups (id, project_id, kind, name, created_at)
                     VALUES (41, 1, 'feature', 'login', 200);
                     INSERT INTO drafts (project_id, workspace, created_at) VALUES (1, 'local', 210);
                     INSERT INTO sessions (id, project_id, kind, dir, name, branch, created_at,
                                           pinned_at, settled_override, settled_at, unsettled_at,
                                           last_activity_at, last_visited_at, active_tab,
                                           float_layout, floats_hand_changed)
                     VALUES (11, 1, 'plain', '/work/orb', NULL, NULL, 1000, NULL, 'settled',
                             8000, NULL, 1500, 1600, 0, 'staggered', 0),
                            (12, 1, 'plain', '/wt/login', 'login', 'login', 1100, 5000, NULL,
                             NULL, 7000, 1700, 1800, 0, 'spread', 1);
                     INSERT INTO panes (id, session_id, cwd, zmx_name, zmx_dir, resume,
                                        migrated_bg, name)
                     VALUES (101, 11, '/work/orb', 'orb-p101', 'pi', 'claude --resume s-aa11',
                             'aa11', 'build'),
                            (102, 12, '/wt/login', NULL, NULL, NULL, NULL, NULL),
                            (103, 12, '/wt/login', NULL, NULL, NULL, NULL, 'notes');
                     INSERT INTO tabs (id, session_id, position, name, layout, focus_pane,
                                       swap_layout, hand_changed)
                     VALUES (201, 11, 0, 'main', '{\"pane\":101}', 101, 'base', 1),
                            (202, 12, 0, NULL, '{\"pane\":102}', 102, 'vertical', 0);
                     INSERT INTO floats (session_id, position, pane_id, x, y, width, height,
                                         pinned)
                     VALUES (12, 0, 103, 0.1, 0.2, 0.5, 0.4, 1);
                     INSERT INTO threads (id, project_id, short_id, session_id, title, cwd,
                                          transcript_path, transcript_offset, created_at,
                                          turn_started_at, custom_title, branch, pinned_at,
                                          settled_override, settled_at, unsettled_at,
                                          last_activity_at, last_visited_at, ai_titled, model,
                                          permission_mode, renamed_title, group_id, harness,
                                          pane_id, orb_session_id)
                     VALUES (301, 1, 'aa11', 's-aa11', 'Fix login', '/work/orb', '/t/aa11.jsonl',
                             4096, 1000, 1400, 'Login fix', 'main', 5000, 'settled', 8000, 7000,
                             1500, 1600, 1, 'opus', 'plan', 'Fix the login', 41, 'claude', 101,
                             11),
                            (302, 1, 'bb22', NULL, NULL, '/wt/login', NULL, 0, 1100, NULL, NULL,
                             NULL, NULL, NULL, NULL, NULL, 1700, 1800, 0, NULL, NULL, NULL, NULL,
                             'pi', 102, 12);
                     INSERT INTO jumps (position, kind, item_id)
                     VALUES (0, 'session', 11), (1, 'agent', 101);
                     INSERT INTO ui (id, sidebar_width, project_filter) VALUES (1, 44, 1);
                     UPDATE sqlite_sequence SET seq = 150 WHERE name = 'panes';",
                )
            })
            .change_context(StoreError)
}

/// Every live row in the database at `path`, only its live columns, each
/// table in key order, tagged with its table.
fn live_values(path: &Path) -> Result<Vec<Vec<String>>, Report<StoreError>> {
    [
        "SELECT 'projects', id, root, title, created_at, removed_at, kind
             FROM projects ORDER BY id",
        "SELECT 'threads', id, project_id, short_id, session_id, title, cwd, transcript_path,
                    transcript_offset, created_at, turn_started_at, custom_title, branch,
                    last_activity_at, last_visited_at, ai_titled, model, renamed_title, harness,
                    pane_id, orb_session_id
             FROM threads ORDER BY id",
        "SELECT 'sessions', id, project_id, kind, dir, name, branch, created_at, pinned_at,
                    settled_override, settled_at, unsettled_at, last_activity_at,
                    last_visited_at, active_tab, float_layout, floats_hand_changed
             FROM sessions ORDER BY id",
        "SELECT 'tabs', * FROM tabs ORDER BY id",
        "SELECT 'panes', id, session_id, cwd, zmx_name, zmx_dir, resume, name
             FROM panes ORDER BY id",
        "SELECT 'floats', * FROM floats ORDER BY session_id, position",
        "SELECT 'jumps', * FROM jumps ORDER BY position",
        "SELECT 'ui', * FROM ui",
        "SELECT 'sqlite_sequence', * FROM sqlite_sequence ORDER BY name",
    ]
    .iter()
    .map(|sql| rows(path, sql))
    .collect::<Result<Vec<_>, _>>()
    .map(|tables| tables.concat())
}

#[rstest::rstest]
fn fresh_database_has_exactly_the_live_schema() -> Result<(), Report<StoreError>> {
    // Given a path with no database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");

    // When opening the store.
    drop(Store::open(&path)?);

    // Then its tables and columns are exactly the live ones.
    assert_eq!(
        schema(&path)?,
        live_schema(),
        "a fresh database should hold only the live tables and columns"
    );
    Ok(())
}

#[rstest::rstest]
fn upgrading_a_v13_database_keeps_every_live_value() -> Result<(), Report<StoreError>> {
    // Given a v13 database holding live and leftover data.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    v13_database(&path)?;
    let before = live_values(&path)?;

    // When opening the store.
    drop(Store::open(&path)?);

    // Then every live row keeps its id and values.
    assert_eq!(
        live_values(&path)?,
        before,
        "the upgrade should keep every live row, id and value"
    );
    Ok(())
}

#[rstest::rstest]
fn upgrading_a_v13_database_leaves_no_broken_reference() -> Result<(), Report<StoreError>> {
    // Given a v13 database holding live and leftover data.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    v13_database(&path)?;

    // When opening the store.
    drop(Store::open(&path)?);

    // Then the foreign key check finds nothing.
    assert_eq!(
        rows(&path, "PRAGMA foreign_key_check")?,
        Vec::<Vec<String>>::new(),
        "the upgrade should leave every reference pointing at a row"
    );
    Ok(())
}

#[rstest::rstest]
fn upgrading_a_v13_database_gives_it_the_live_schema() -> Result<(), Report<StoreError>> {
    // Given a v13 database holding live and leftover data.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    v13_database(&path)?;

    // When opening the store.
    drop(Store::open(&path)?);

    // Then it's at the latest version with exactly the live tables and columns.
    assert_eq!(
        (user_version(&path)?, schema(&path)?),
        (MIGRATIONS.len(), live_schema()),
        "the upgrade should reach the latest version and drop every leftover table and column"
    );
    Ok(())
}

#[rstest::rstest]
fn upgrading_a_v13_database_keeps_new_pane_ids_above_old_ones() -> Result<(), Report<StoreError>> {
    // Given a v13 database whose panes up to 150 were once made.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    v13_database(&path)?;

    // When opening the store and saving a new session.
    let (_, pane) = Store::open(&path)?.insert_session(
        ProjectId(1),
        SessionKind::Plain,
        Path::new("/work/orb"),
        None,
        None,
        None,
        2_000,
    )?;

    // Then its pane's id is above every pane made before.
    assert!(
        pane.0 > 150,
        "a pane made after the upgrade should get an id above 150, got {}",
        pane.0
    );
    Ok(())
}

/// A v14 database at `path` with one project and four sessions: 1 plain,
/// 2 research, 3 learn, 4 incognito.
fn v14_database(path: &Path) -> Result<(), Report<StoreError>> {
    database_at(path, 14)?;
    Connection::open(path)
        .and_then(|conn| {
            conn.execute_batch(
                "INSERT INTO projects (id, root, title, created_at) VALUES (1, '/work/orb', 'orb', 100);
                 INSERT INTO sessions (id, project_id, kind, dir, created_at)
                 VALUES (1, 1, 'plain', '/work/orb', 1000),
                        (2, 1, 'research', '/r/papers', 1100),
                        (3, 1, 'learn', '/l/rust', 1200),
                        (4, 1, 'incognito', '/tmp/orb-incognito', 1300);",
            )
        })
        .change_context(StoreError)
}

#[rstest::rstest]
fn upgrading_a_v14_database_makes_research_and_learn_sessions_colonies()
-> Result<(), Report<StoreError>> {
    // Given a v14 database with a plain, a research, a learn and an incognito session.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    v14_database(&path)?;

    // When opening the store.
    drop(Store::open(&path)?);

    // Then all four sessions are kept, and the research and learn ones are colonies.
    assert_eq!(
        rows(&path, "SELECT id, kind FROM sessions ORDER BY id")?,
        [(1, "plain"), (2, "colony"), (3, "colony"), (4, "incognito")]
            .map(|(id, kind)| vec![format!("Integer({id})"), format!("Text({kind:?})")]),
        "the upgrade should keep every session and turn Research and Learn into colonies"
    );
    Ok(())
}

#[rstest::rstest]
fn upgrading_a_v14_database_leaves_every_session_top_level() -> Result<(), Report<StoreError>> {
    // Given a v14 database with four sessions.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    v14_database(&path)?;

    // When opening the store.
    drop(Store::open(&path)?);

    // Then no session has a parent.
    assert_eq!(
        value::<i64>(
            &path,
            "SELECT COUNT(*) FROM sessions WHERE parent_id IS NOT NULL"
        )?,
        0,
        "upgraded sessions should all be top level"
    );
    Ok(())
}

#[rstest::rstest]
fn reopening_a_migrated_database_keeps_its_schema_version() -> Result<(), Report<StoreError>> {
    // Given a database that was already migrated.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    drop(Store::open(&path)?);

    // When opening the store again.
    drop(Store::open(&path)?);

    // Then it opens and stays at the latest schema version.
    assert_eq!(
        user_version(&path)?,
        MIGRATIONS.len(),
        "migrating twice should be a no-op"
    );
    Ok(())
}

#[rstest::rstest]
fn inserted_agent_loads_back_after_reopening() -> Result<(), Report<StoreError>> {
    // Given an agent saved in a store that was then closed.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    let (project_id, inserted) = {
        let store = Store::open(&path)?;
        let project_id =
            store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
        (project_id, insert_agent(&store, project_id)?)
    };

    // When reopening the store and loading.
    let (_, agents) = Store::open(&path)?.load()?;

    // Then the agent comes back with the fields it was saved with.
    let expected = AgentRow {
        harness: HarnessId::new("claude"),
        id: inserted.agent,
        pane_id: Some(inserted.pane),
        orb_session: Some(inserted.session),
        project_id,
        short_id: "28bf38e2".to_owned(),
        session_id: Some("28bf38e2".to_owned()),
        title: None,
        custom_title: None,
        cwd: PathBuf::from("/tmp/orb"),
        transcript_path: None,
        transcript_offset: 0,
        created_at: 1_000,
        turn_started_at: None,
        branch: None,
        last_activity_at: 1_000,
        last_visited_at: 1_000,
        ai_titled: false,
        model: None,
        renamed_title: None,
    };
    assert_eq!(agents, vec![expected], "the saved agent should load back");
    Ok(())
}

#[rstest::rstest]
fn adding_the_same_root_twice_returns_the_same_id() -> Result<(), Report<StoreError>> {
    // Given a store with a project rooted at /tmp/orb.
    let store = Store::open_in_memory()?;
    let first = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;

    // When adding the same root again.
    let second = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 900)?;

    // Then it gets the same id.
    assert_eq!(first, second, "one root should be one project");
    Ok(())
}

#[rstest::rstest]
fn adding_an_existing_root_keeps_its_title() -> Result<(), Report<StoreError>> {
    // Given a store with a project titled "T3 orb" rooted at /tmp/orb.
    let store = Store::open_in_memory()?;
    store.add_project(Path::new("/tmp/orb"), "T3 orb", ProjectKind::Normal, 500)?;

    // When adding the same root under the title "orb".
    store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 900)?;

    // Then the project keeps its first title.
    let titles: Vec<String> = store
        .load()?
        .0
        .into_iter()
        .map(|project| project.title)
        .collect();
    assert_eq!(
        titles,
        vec!["T3 orb".to_owned()],
        "adding an existing root shouldn't retitle it"
    );
    Ok(())
}

#[rstest::rstest]
fn adding_an_existing_root_as_research_sets_its_kind() -> Result<(), Report<StoreError>> {
    // Given a store with a normal project rooted at /tmp/research.
    let store = Store::open_in_memory()?;
    store.add_project(
        Path::new("/tmp/research"),
        "research",
        ProjectKind::Normal,
        500,
    )?;

    // When adding the same root as Research.
    store.add_project(
        Path::new("/tmp/research"),
        "Research",
        ProjectKind::Research,
        900,
    )?;

    // Then the project loads as Research.
    let kinds: Vec<ProjectKind> = store
        .load()?
        .0
        .into_iter()
        .map(|project| project.kind)
        .collect();
    assert_eq!(
        kinds,
        vec![ProjectKind::Research],
        "adding an existing root as Research should set its kind"
    );
    Ok(())
}

#[rstest::rstest]
fn incognito_project_kind_loads_back() -> Result<(), Report<StoreError>> {
    // Given a store with an Incognito project.
    let store = Store::open_in_memory()?;
    store.add_project(
        Path::new("/tmp/orb-incognito"),
        "Incognito",
        ProjectKind::Incognito,
        500,
    )?;

    // When loading.
    let kinds: Vec<ProjectKind> = store
        .load()?
        .0
        .into_iter()
        .map(|project| project.kind)
        .collect();

    // Then its kind is Incognito.
    assert_eq!(
        kinds,
        vec![ProjectKind::Incognito],
        "an Incognito project should load back as Incognito"
    );
    Ok(())
}

#[rstest::rstest]
#[case::shared(ProjectKind::SharedWorld)]
#[case::fresh(ProjectKind::FreshWorld)]
fn world_project_kinds_load_back(#[case] kind: ProjectKind) -> Result<(), Report<StoreError>> {
    // Given a store with a world of `kind`.
    let store = Store::open_in_memory()?;
    store.add_project(Path::new("/tmp/world"), "world", kind, 500)?;

    // When loading.
    let kinds: Vec<ProjectKind> = store
        .load()?
        .0
        .into_iter()
        .map(|project| project.kind)
        .collect();

    // Then its kind loads back unchanged.
    assert_eq!(kinds, vec![kind], "a world should load back as {kind:?}");
    Ok(())
}

#[rstest::rstest]
fn inserted_sessions_parent_loads_back() -> Result<(), Report<StoreError>> {
    // Given a store with session A.
    let store = Store::open_in_memory()?;
    let project = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let (parent, _) = store.insert_session(
        project,
        SessionKind::Colony,
        Path::new("/tmp/orb"),
        None,
        None,
        None,
        1_000,
    )?;

    // When inserting session B made by A.
    let (child, _) = store.insert_session(
        project,
        SessionKind::Plain,
        Path::new("/tmp/orb"),
        None,
        None,
        Some(parent),
        1_100,
    )?;

    // Then B loads back with A as its parent.
    let parents: Vec<(SessionId, Option<SessionId>)> = store
        .layouts()?
        .sessions
        .into_iter()
        .map(|row| (row.id, row.parent))
        .collect();
    assert_eq!(
        parents,
        vec![(parent, None), (child, Some(parent))],
        "the colonist's parent should load back"
    );
    Ok(())
}

#[rstest::rstest]
fn deleting_a_session_clears_its_colonists_parent() -> Result<(), Report<StoreError>> {
    // Given session A and session B made by A.
    let store = Store::open_in_memory()?;
    let project = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let (parent, _) = store.insert_session(
        project,
        SessionKind::Colony,
        Path::new("/tmp/orb"),
        None,
        None,
        None,
        1_000,
    )?;
    let (child, _) = store.insert_session(
        project,
        SessionKind::Plain,
        Path::new("/tmp/orb"),
        None,
        None,
        Some(parent),
        1_100,
    )?;

    // When deleting A.
    store.delete_session(parent)?;

    // Then B is left with no parent.
    let parents: Vec<(SessionId, Option<SessionId>)> = store
        .layouts()?
        .sessions
        .into_iter()
        .map(|row| (row.id, row.parent))
        .collect();
    assert_eq!(
        parents,
        vec![(child, None)],
        "deleting a session should clear its colonists' parent"
    );
    Ok(())
}

#[rstest::rstest]
fn adding_a_research_root_again_as_normal_keeps_its_kind() -> Result<(), Report<StoreError>> {
    // Given a store with a Research project rooted at /tmp/research.
    let store = Store::open_in_memory()?;
    store.add_project(
        Path::new("/tmp/research"),
        "Research",
        ProjectKind::Research,
        500,
    )?;

    // When adding the same root as Normal.
    store.add_project(
        Path::new("/tmp/research"),
        "research",
        ProjectKind::Normal,
        900,
    )?;

    // Then the project still loads as Research.
    let kinds: Vec<ProjectKind> = store
        .load()?
        .0
        .into_iter()
        .map(|project| project.kind)
        .collect();
    assert_eq!(
        kinds,
        vec![ProjectKind::Research],
        "re-adding a Research root as Normal should keep its kind"
    );
    Ok(())
}

#[rstest::rstest]
fn removed_project_loads_with_when_it_was_removed() -> Result<(), Report<StoreError>> {
    // Given a store with a project.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;

    // When removing it at 2 s.
    store.remove_project(project_id, 2_000)?;

    // Then it loads as removed at 2 s.
    let removed: Vec<Option<i64>> = store
        .load()?
        .0
        .into_iter()
        .map(|project| project.removed_at)
        .collect();
    assert_eq!(removed, vec![Some(2_000)], "the removal should be saved");
    Ok(())
}

#[rstest::rstest]
fn removing_a_project_keeps_its_agents() -> Result<(), Report<StoreError>> {
    // Given a store with a project that has an agent.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    insert_agent(&store, project_id)?;

    // When removing the project.
    store.remove_project(project_id, 2_000)?;

    // Then the agent still loads.
    assert_eq!(
        store.load()?.1.len(),
        1,
        "a removed project's agents should stay"
    );
    Ok(())
}

#[rstest::rstest]
fn adding_a_removed_root_restores_it() -> Result<(), Report<StoreError>> {
    // Given a store whose project at /tmp/orb was removed.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    store.remove_project(project_id, 2_000)?;

    // When adding the same root again.
    store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 3_000)?;

    // Then it's no longer removed.
    let removed: Vec<Option<i64>> = store
        .load()?
        .0
        .into_iter()
        .map(|project| project.removed_at)
        .collect();
    assert_eq!(removed, vec![None], "re-adding should restore the project");
    Ok(())
}

#[rstest::rstest]
fn adding_a_removed_root_keeps_its_id() -> Result<(), Report<StoreError>> {
    // Given a store whose project at /tmp/orb was removed.
    let store = Store::open_in_memory()?;
    let first = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    store.remove_project(first, 2_000)?;

    // When adding the same root again.
    let second = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 3_000)?;

    // Then it's the same project.
    assert_eq!(first, second, "a restored project should keep its id");
    Ok(())
}

#[rstest::rstest]
fn saved_agent_updates_load_back() -> Result<(), Report<StoreError>> {
    // Given a store with one agent.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;

    // When saving its session id, titles, transcript cursor, and turn start.
    let updated = AgentRow {
        orb_session: None,
        harness: HarnessId::new("claude"),
        id: inserted.agent,
        pane_id: Some(inserted.pane),
        project_id,
        short_id: "28bf38e2".to_owned(),
        session_id: Some("5f0c1c1e-session".to_owned()),
        title: Some("Fix the sidebar".to_owned()),
        custom_title: Some("sidebar".to_owned()),
        cwd: PathBuf::from("/tmp/orb"),
        transcript_path: Some(PathBuf::from(
            "/tmp/claude/projects/-tmp-orb/5f0c1c1e.jsonl",
        )),
        transcript_offset: 4_096,
        created_at: 1_000,
        turn_started_at: Some(2_000),
        branch: None,
        last_activity_at: 1_000,
        last_visited_at: 1_000,
        ai_titled: false,
        model: None,
        renamed_title: None,
    };
    store.save_agent(&updated)?;

    // Then loading returns the updated values.
    let (_, agents) = store.load()?;
    assert_eq!(agents, vec![updated], "the updates should load back");
    Ok(())
}

#[rstest::rstest]
fn renamed_title_loads_back_after_saving() -> Result<(), Report<StoreError>> {
    // Given a store with one agent.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    insert_agent(&store, project_id)?;
    let inserted = store
        .load()?
        .1
        .pop()
        .ok_or_else(|| Report::new(StoreError).attach("the agent wasn't saved"))?;

    // When saving the name the user gave it with `r`.
    store.save_agent(&AgentRow {
        renamed_title: Some("Sidebar search".to_owned()),
        ..inserted
    })?;

    // Then loading returns that name.
    let renamed: Vec<_> = store
        .load()?
        .1
        .into_iter()
        .map(|row| row.renamed_title)
        .collect();
    assert_eq!(
        renamed,
        vec![Some("Sidebar search".to_owned())],
        "the orb name should load back"
    );
    Ok(())
}

#[rstest::rstest]
fn inserted_agent_starts_seen_and_active_at_creation() -> Result<(), Report<StoreError>> {
    // Given a store with a project.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;

    // When inserting an agent created at 1 s.
    insert_agent(&store, project_id)?;

    // Then its last activity and last visit are its creation time.
    let (_, agents) = store.load()?;
    let stamps: Vec<(i64, i64)> = agents
        .iter()
        .map(|row| (row.last_activity_at, row.last_visited_at))
        .collect();
    assert_eq!(
        stamps,
        vec![(1_000, 1_000)],
        "a new agent should start seen and active at its creation"
    );
    Ok(())
}

#[rstest::rstest]
fn saved_ui_reads_back() -> Result<(), Report<StoreError>> {
    // Given a store with a project.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;

    // When saving a 40-column sidebar filtered to the project.
    let ui = Ui {
        sidebar_width: Some(40),
        project_filter: Some(project_id),
    };
    store.save_ui(&ui)?;

    // Then the layout settings are those.
    assert_eq!(store.ui()?, ui, "the saved layout should read back");
    Ok(())
}

#[rstest::rstest]
fn saving_ui_again_replaces_it() -> Result<(), Report<StoreError>> {
    // Given a store whose sidebar was saved 40 columns wide.
    let store = Store::open_in_memory()?;
    store.save_ui(&Ui {
        sidebar_width: Some(40),
        project_filter: None,
    })?;

    // When saving it 28 columns wide.
    let ui = Ui {
        sidebar_width: Some(28),
        project_filter: None,
    };
    store.save_ui(&ui)?;

    // Then the second save is what reads back.
    assert_eq!(store.ui()?, ui, "the latest layout should replace the old");
    Ok(())
}

#[rstest::rstest]
fn unsaved_ui_is_the_default() -> Result<(), Report<StoreError>> {
    // Given a fresh store.
    let store = Store::open_in_memory()?;

    // When reading the layout settings.
    let ui = store.ui()?;

    // Then nothing is set.
    assert_eq!(ui, Ui::default(), "a fresh store has no layout settings");
    Ok(())
}

#[rstest::rstest]
fn insert_session_saves_one_shell_pane_and_no_tab() -> Result<(), Report<StoreError>> {
    // Given a store with one project.
    let store = Store::open_in_memory()?;
    let project = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;

    // When inserting a session in the project's root.
    let (session, pane) = store.insert_session(
        project,
        SessionKind::Plain,
        Path::new("/tmp/orb"),
        None,
        None,
        None,
        1_000,
    )?;

    // Then it holds one shell pane in that directory and no tab.
    let saved = store.layouts()?;
    let tabs: Vec<(SessionId, Option<PaneId>)> = saved
        .tabs
        .iter()
        .map(|tab| (tab.session_id, tab.focus_pane))
        .collect();
    let panes: Vec<(PaneId, SessionId, PathBuf, Option<String>)> = saved
        .panes
        .iter()
        .map(|row| (row.id, row.session_id, row.cwd.clone(), row.resume.clone()))
        .collect();
    assert_eq!(
        (tabs, panes),
        (
            vec![],
            vec![(pane, session, PathBuf::from("/tmp/orb"), None)]
        ),
        "a new session row should hold one shell pane and leave its tab to the layout save"
    );
    Ok(())
}

#[rstest::rstest]
fn insert_session_saves_its_kind_and_branch() -> Result<(), Report<StoreError>> {
    // Given a store with one project.
    let store = Store::open_in_memory()?;
    let project = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;

    // When inserting a colony on `orb/0a1b2c3d`.
    let (session, _) = store.insert_session(
        project,
        SessionKind::Colony,
        Path::new("/tmp/orb/wt"),
        Some("orb/0a1b2c3d"),
        None,
        None,
        1_000,
    )?;

    // Then its row loads back with that kind, branch and directory.
    let rows: Vec<(SessionId, SessionKind, Option<String>, PathBuf, i64)> = store
        .layouts()?
        .sessions
        .into_iter()
        .map(|row| (row.id, row.kind, row.branch, row.dir, row.last_activity_at))
        .collect();
    assert_eq!(
        rows,
        vec![(
            session,
            SessionKind::Colony,
            Some("orb/0a1b2c3d".to_owned()),
            PathBuf::from("/tmp/orb/wt"),
            1_000
        )],
        "the session row should keep its kind and branch"
    );
    Ok(())
}

#[rstest::rstest]
fn move_session_sets_dir_branch_and_pane_cwds() -> Result<(), Report<StoreError>> {
    // Given a session in the checkout with a second pane.
    let store = Store::open_in_memory()?;
    let project = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let (session, _) = store.insert_session(
        project,
        SessionKind::Plain,
        Path::new("/tmp/orb"),
        None,
        None,
        None,
        1_000,
    )?;
    store.insert_pane(session, Path::new("/tmp/orb"))?;

    // When moving it to a worktree on `orb/0a1b2c3d`.
    store.move_session(session, Path::new("/tmp/wt"), Some("orb/0a1b2c3d"))?;

    // Then its row and every pane point at the worktree.
    let layouts = store.layouts()?;
    let moved = (
        layouts
            .sessions
            .iter()
            .map(|row| (row.dir.clone(), row.branch.clone()))
            .collect::<Vec<_>>(),
        layouts
            .panes
            .iter()
            .map(|row| row.cwd.clone())
            .collect::<Vec<_>>(),
    );
    assert_eq!(
        moved,
        (
            vec![(PathBuf::from("/tmp/wt"), Some("orb/0a1b2c3d".to_owned()))],
            vec![PathBuf::from("/tmp/wt"), PathBuf::from("/tmp/wt")],
        ),
        "the session and its panes should move together"
    );
    Ok(())
}

#[rstest::rstest]
fn jumps_round_trip_session_rows() -> Result<(), Report<StoreError>> {
    // Given a fresh store.
    let store = Store::open_in_memory()?;

    // When saving a jump list of every kind of row.
    let jumps = vec![
        SidebarItem::Session(SessionId(3)),
        SidebarItem::Session(SessionId(4)),
    ];
    store.save_jumps(&jumps)?;

    // Then the same rows read back in the same order.
    assert_eq!(
        store.jumps()?,
        jumps,
        "the saved jump list should read back"
    );
    Ok(())
}

#[rstest::rstest]
fn jumps_round_trip_agent_rows() -> Result<(), Report<StoreError>> {
    // Given a store with a session and a second pane in it.
    let store = Store::open_in_memory()?;
    let project = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let (session, _) = store.insert_session(
        project,
        SessionKind::Plain,
        Path::new("/tmp/orb"),
        None,
        None,
        None,
        1_000,
    )?;
    let pane = store.insert_pane(session, Path::new("/tmp/orb"))?;

    // When saving the session's card, then the pane's agent row.
    let jumps = vec![
        SidebarItem::Session(session),
        SidebarItem::Agent { session, pane },
    ];
    store.save_jumps(&jumps)?;

    // Then both rows read back in the same order.
    assert_eq!(
        store.jumps()?,
        jumps,
        "an agent row should read back with its pane's session"
    );
    Ok(())
}

#[rstest::rstest]
fn saved_jumps_drop_an_unknown_pane() -> Result<(), Report<StoreError>> {
    // Given a fresh store.
    let store = Store::open_in_memory()?;

    // When saving an agent row whose pane isn't in the store, and a
    // session row.
    store.save_jumps(&[
        SidebarItem::Agent {
            session: SessionId(1),
            pane: PaneId(1),
        },
        SidebarItem::Session(SessionId(2)),
    ])?;

    // Then only the session row reads back.
    assert_eq!(
        store.jumps()?,
        vec![SidebarItem::Session(SessionId(2))],
        "an agent row with an unknown pane should not read back"
    );
    Ok(())
}

#[rstest::rstest]
fn saving_jumps_again_replaces_them() -> Result<(), Report<StoreError>> {
    // Given a store with sessions 1 and 2 saved as the jump list.
    let store = Store::open_in_memory()?;
    store.save_jumps(&[
        SidebarItem::Session(SessionId(1)),
        SidebarItem::Session(SessionId(2)),
    ])?;

    // When saving session 3 alone.
    let jumps = vec![SidebarItem::Session(SessionId(3))];
    store.save_jumps(&jumps)?;

    // Then only session 3 reads back.
    assert_eq!(
        store.jumps()?,
        jumps,
        "the latest jump list should replace the old"
    );
    Ok(())
}

/// The pi agent's short id in the v10 fixture.
const PI_SHORT_ID: &str = "orb-0123456789abcdef0123456789abcdef";

/// A v10 database: project 1 `/work/orb` with a draft, project 2 the
/// Incognito folder; lone Claude agent 3 (`aa11`, pinned, renamed), lone
/// pi agent 4, Incognito agent 5, Feature group 1 in `/wt/x` holding
/// agents 6, 7 and 8 (created in that order), settled Research group 2
/// holding agent 9, agentless Feature group 3 with no dir, settled lone
/// agent 10; jumps to agent 3, group 1, the draft and agent 9.
fn v10_database(path: &Path) -> Result<(), Report<StoreError>> {
    let conn = Connection::open(path).change_context(StoreError)?;
    for migration in MIGRATIONS
        .get(..10)
        .ok_or_else(|| Report::new(StoreError).attach("no v10 migrations"))?
    {
        migration.apply(&conn).change_context(StoreError)?;
    }
    conn.execute_batch(&format!(
        "INSERT INTO projects (id, root, title, created_at, kind)
             VALUES (1, '/work/orb', 'orb', 100, NULL),
                    (2, '/tmp/orb-incognito', 'Incognito', 100, 'incognito');
             INSERT INTO drafts (project_id, workspace, created_at) VALUES (1, 'local', 150);
             INSERT INTO groups (id, project_id, kind, name, dir, branch, created_at,
                                 settled_override, settled_at)
             VALUES (1, 1, 'feature', 'login', '/wt/x', 'login', 200, NULL, NULL),
                    (2, 1, 'research', 'papers', '/r/papers', NULL, 300, 'settled', 8000),
                    (3, 1, 'feature', 'later', NULL, NULL, 400, NULL, NULL);
             INSERT INTO threads (id, project_id, short_id, session_id, cwd, created_at,
                                  renamed_title, pinned_at, settled_override, settled_at,
                                  last_activity_at, last_visited_at, group_id, harness)
             VALUES (3, 1, 'aa11', 's-aa11', '/work/orb', 1000, 'Fix login', 5000,
                     NULL, NULL, 6000, 7000, NULL, 'claude'),
                    (4, 1, '{PI_SHORT_ID}', NULL, '/work/orb', 1100, NULL, NULL,
                     NULL, NULL, 1100, 1100, NULL, 'pi'),
                    (5, 2, 'cc33', 's-cc33', '/tmp/orb-incognito', 1200, NULL, NULL,
                     NULL, NULL, 1200, 1200, NULL, 'claude'),
                    (6, 1, 'dd44', 's-dd44', '/wt/x', 1300, NULL, NULL,
                     NULL, NULL, 1300, 1300, 1, 'claude'),
                    (7, 1, 'ee55', 's-ee55', '/wt/x', 1400, NULL, NULL,
                     NULL, NULL, 1400, 1400, 1, 'claude'),
                    (8, 1, 'ff66', 's-ff66', '/wt/x', 1500, NULL, NULL,
                     NULL, NULL, 1500, 1500, 1, 'claude'),
                    (9, 1, 'gg77', 's-gg77', '/r/papers', 1600, NULL, NULL,
                     NULL, NULL, 1600, 1600, 2, 'claude'),
                    (10, 1, 'hh88', 's-hh88', '/work/orb', 1700, NULL, NULL,
                     'settled', 9000, 1700, 1700, NULL, 'claude');
             INSERT INTO jumps (position, kind, item_id)
             VALUES (0, 'thread', 3), (1, 'group', 1), (2, 'draft', 1), (3, 'thread', 9);
             PRAGMA user_version = 10;"
    ))
    .change_context(StoreError)
}

/// A v10 fixture at `<dir>/state.sqlite`, opened (and so migrated).
fn migrated_v10(dir: &Path) -> Result<PathBuf, Report<StoreError>> {
    let path = dir.join("state.sqlite");
    v10_database(&path)?;
    drop(Store::open(&path)?);
    Ok(path)
}

/// Every row `sql` returns from the database at `path`, each column
/// debug-printed.
fn rows(path: &Path, sql: &str) -> Result<Vec<Vec<String>>, Report<StoreError>> {
    let conn = Connection::open(path).change_context(StoreError)?;
    let mut statement = conn.prepare(sql).change_context(StoreError)?;
    let columns = statement.column_count();
    statement
        .query_map([], |row| {
            (0..columns)
                .map(|at| {
                    row.get::<_, rusqlite::types::Value>(at)
                        .map(|value| format!("{value:?}"))
                })
                .collect()
        })
        .and_then(Iterator::collect)
        .change_context(StoreError)
}

/// The one value `sql` returns from the database at `path`.
fn value<T>(path: &Path, sql: &str) -> Result<T, Report<StoreError>>
where
    T: rusqlite::types::FromSql,
{
    Connection::open(path)
        .and_then(|conn| conn.query_row(sql, [], |row| row.get(0)))
        .change_context(StoreError)
}

/// The session agent `id` runs in, after migrating.
fn session_of(path: &Path, thread: i64) -> Result<i64, Report<StoreError>> {
    value(
        path,
        &format!(
            "SELECT p.session_id FROM threads t JOIN panes p ON p.id = t.pane_id
                 WHERE t.id = {thread}"
        ),
    )
}

/// The pane agent `id` runs in, after migrating.
fn pane_of(path: &Path, thread: i64) -> Result<i64, Report<StoreError>> {
    value(
        path,
        &format!("SELECT pane_id FROM threads WHERE id = {thread}"),
    )
}

/// A database at `path` with the first `version` migrations applied.
fn database_at(path: &Path, version: usize) -> Result<(), Report<StoreError>> {
    let conn = Connection::open(path).change_context(StoreError)?;
    for migration in MIGRATIONS
        .get(..version)
        .ok_or_else(|| Report::new(StoreError).attach("no such version"))?
    {
        migration.apply(&conn).change_context(StoreError)?;
    }
    conn.pragma_update(None, "user_version", version)
        .change_context(StoreError)
}

/// The sorted names in `dir` that contain `.bak-v`.
fn copy_names(dir: &Path) -> Result<Vec<String>, Report<StoreError>> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .change_context(StoreError)?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".bak-v"))
        .collect();
    names.sort();
    Ok(names)
}

/// The log file's text, empty if it was never written.
fn log_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

#[rstest::rstest]
#[case(1)]
#[case(2)]
#[case(3)]
#[case(4)]
#[case(5)]
#[case(6)]
#[case(7)]
#[case(8)]
#[case(9)]
#[case(10)]
#[case(11)]
#[case(12)]
fn upgrading_a_past_version_leaves_its_copy(
    #[case] version: usize,
) -> Result<(), Report<StoreError>> {
    // Given a database at a past schema version.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    database_at(&path, version)?;

    // When opening the store.
    drop(Store::open(&path)?);

    // Then a copy at that version sits beside it.
    let copy = dir.path().join(format!("state.sqlite.bak-v{version}"));
    assert_eq!(
        user_version(&copy)?,
        version,
        "the copy should be the database as it was before the upgrade"
    );
    Ok(())
}

#[rstest::rstest]
fn opening_a_current_database_writes_no_copy() -> Result<(), Report<StoreError>> {
    // Given a database already brought up to date, with no copies beside it.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    drop(Store::open(&path)?);
    for name in copy_names(dir.path())? {
        std::fs::remove_file(dir.path().join(name)).change_context(StoreError)?;
    }

    // When opening the store again.
    drop(Store::open(&path)?);

    // Then no copy is written.
    let names = copy_names(dir.path())?;
    assert!(
        names.is_empty(),
        "a current database needs no copy: {names:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn upgrade_keeps_only_the_three_newest_copies() -> Result<(), Report<StoreError>> {
    // Given a v12 database with copies v7 to v10, a partial copy and an
    // unrelated file beside it.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    database_at(&path, 12)?;
    for name in [
        "state.sqlite.bak-v7",
        "state.sqlite.bak-v8",
        "state.sqlite.bak-v9",
        "state.sqlite.bak-v10",
        "state.sqlite.bak-v9.tmp",
        "other.txt",
    ] {
        std::fs::write(dir.path().join(name), b"").change_context(StoreError)?;
    }

    // When opening the store.
    drop(Store::open(&path)?);

    // Then only the three newest copies are left, and nothing else is touched.
    let mut names: Vec<String> = std::fs::read_dir(dir.path())
        .change_context(StoreError)?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.ends_with("-wal") && !name.ends_with("-shm"))
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "other.txt",
            "state.sqlite",
            "state.sqlite.bak-v10",
            "state.sqlite.bak-v12",
            "state.sqlite.bak-v9",
            "state.sqlite.bak-v9.tmp",
        ],
        "only the three newest copies should be kept"
    );
    Ok(())
}

#[rstest::rstest]
fn upgrade_never_prunes_the_copy_it_is_upgrading_from() -> Result<(), Report<StoreError>> {
    // Given a v10 database with newer copies v11 to v13 beside it.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    database_at(&path, 10)?;
    for version in 11..=13 {
        std::fs::write(dir.path().join(format!("state.sqlite.bak-v{version}")), b"")
            .change_context(StoreError)?;
    }

    // When opening the store.
    drop(Store::open(&path)?);

    // Then the v10 copy is still there.
    assert!(
        dir.path().join("state.sqlite.bak-v10").exists(),
        "the copy of the version being upgraded should never be pruned"
    );
    Ok(())
}

#[rstest::rstest]
fn upgrade_logs_its_copy() -> Result<(), Report<StoreError>> {
    // Given a v12 database and a log.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    database_at(&path, 12)?;
    let log_path = dir.path().join("orb.log");
    let log = Log::new(log_path.clone());

    // When opening the store.
    drop(Store::open_live(&path, Upgrade::Allowed, &log)?);

    // Then the log has an upgrade line naming the copy.
    let text = log_text(&log_path);
    assert!(
        text.lines()
            .any(|line| line.contains(" upgrade ") && line.contains("state.sqlite.bak-v12")),
        "the upgrade should be logged with its copy: {text}"
    );
    Ok(())
}

#[rstest::rstest]
fn upgrade_logs_each_pruned_copy() -> Result<(), Report<StoreError>> {
    // Given a v12 database with copies v7 to v10 beside it, and a log.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    database_at(&path, 12)?;
    for version in 7..=10 {
        std::fs::write(dir.path().join(format!("state.sqlite.bak-v{version}")), b"")
            .change_context(StoreError)?;
    }
    let log_path = dir.path().join("orb.log");
    let log = Log::new(log_path.clone());

    // When opening the store.
    drop(Store::open_live(&path, Upgrade::Allowed, &log)?);

    // Then each pruned copy has its own delete line.
    let text = log_text(&log_path);
    assert!(
        ["bak-v7", "bak-v8"].iter().all(|copy| text
            .lines()
            .any(|line| line.contains("delete old copy") && line.contains(&format!("{copy}: ok")))),
        "each pruned copy should be logged: {text}"
    );
    Ok(())
}

/// A current database at `path` marked as one version past this orb.
fn newer_database_at(path: &Path) -> Result<(), Report<StoreError>> {
    database_at(path, MIGRATIONS.len())?;
    Connection::open(path)
        .and_then(|conn| conn.pragma_update(None, "user_version", MIGRATIONS.len() + 1))
        .change_context(StoreError)
}

#[rstest::rstest]
fn newer_database_refusal_names_the_copy_to_restore() -> Result<(), Report<StoreError>> {
    // Given a database from a newer orb with a copy this orb can open.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    newer_database_at(&path)?;
    let copy = dir
        .path()
        .join(format!("state.sqlite.bak-v{}", MIGRATIONS.len()));
    std::fs::write(&copy, b"").change_context(StoreError)?;

    // When opening the store.
    let opened = Store::open(&path);

    // Then it is refused, naming the copy.
    let text = opened.err().map(|report| format!("{report:?}"));
    assert!(
        text.as_deref()
            .is_some_and(|text| text.contains(&copy.display().to_string())),
        "the refusal should name the copy to put back: {text:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn newer_database_refusal_without_a_copy_says_so() -> Result<(), Report<StoreError>> {
    // Given a database from a newer orb with no copy beside it.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    newer_database_at(&path)?;

    // When opening the store.
    let opened = Store::open(&path);

    // Then it is refused, saying no copy was found.
    let text = opened.err().map(|report| format!("{report:?}"));
    assert!(
        text.as_deref()
            .is_some_and(|text| text.contains("No copy from before that upgrade was found")),
        "the refusal should say there is no copy: {text:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn newer_database_writes_no_copy() -> Result<(), Report<StoreError>> {
    // Given a database from a newer orb with no copy beside it.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    newer_database_at(&path)?;

    // When opening the store.
    let _refused = Store::open(&path);

    // Then no copy is written.
    let names = copy_names(dir.path())?;
    assert!(
        names.is_empty(),
        "a newer database should be refused before any copy: {names:?}"
    );
    Ok(())
}

#[rstest::rstest]
#[expect(
    clippy::redundant_test_prefix,
    reason = "a test build is the orb being tested, not a name prefix"
)]
fn test_build_refuses_to_upgrade() -> Result<(), Report<StoreError>> {
    // Given a database one version behind.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    database_at(&path, MIGRATIONS.len() - 1)?;

    // When a test build opens the store.
    let opened = Store::open_live(&path, Upgrade::AskFirst, &Log::default());

    // Then it is refused, pointing at --upgrade-data, with the database untouched and no copy.
    let outcome = (
        opened.is_err(),
        user_version(&path)?,
        copy_names(dir.path())?.is_empty(),
        opened
            .err()
            .is_some_and(|report| format!("{report:?}").contains("--upgrade-data")),
    );
    assert_eq!(
        outcome,
        (true, MIGRATIONS.len() - 1, true, true),
        "a test build should refuse to upgrade and leave the data as it was"
    );
    Ok(())
}

#[rstest::rstest]
#[expect(
    clippy::redundant_test_prefix,
    reason = "a test build is the orb being tested, not a name prefix"
)]
fn test_build_opens_a_current_database() -> Result<(), Report<StoreError>> {
    // Given a current database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    database_at(&path, MIGRATIONS.len())?;

    // When a test build opens the store.
    let opened = Store::open_live(&path, Upgrade::AskFirst, &Log::default());

    // Then it opens.
    assert!(
        opened.is_ok(),
        "a test build should open a current database"
    );
    Ok(())
}

#[rstest::rstest]
#[expect(
    clippy::redundant_test_prefix,
    reason = "a test build is the orb being tested, not a name prefix"
)]
fn test_build_creates_a_fresh_database() -> Result<(), Report<StoreError>> {
    // Given no database yet.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");

    // When a test build opens the store.
    let opened = Store::open_live(&path, Upgrade::AskFirst, &Log::default());

    // Then a current database is created.
    let created = (opened.is_ok(), user_version(&path)?);
    assert_eq!(
        created,
        (true, MIGRATIONS.len()),
        "a test build should create a fresh, current database"
    );
    Ok(())
}

#[rstest::rstest]
#[case(Some("cargo/bin/orb"), false, Upgrade::Allowed)]
#[case(Some("local/bin/orb"), false, Upgrade::Allowed)]
#[case(Some("repo/target/debug/orb"), false, Upgrade::AskFirst)]
#[case(Some("repo/target/debug/orb"), true, Upgrade::Allowed)]
#[case(None, false, Upgrade::AskFirst)]
#[case(Some("nowhere/orb"), false, Upgrade::AskFirst)]
fn upgrade_policy_from_where_orb_runs(
    #[case] exe: Option<&str>,
    #[case] flag: bool,
    #[case] expected: Upgrade,
) -> Result<(), Report<StoreError>> {
    // Given installed orbs in cargo's bin folder and ~/.local/bin, and a test
    // build in target/.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    for built in ["cargo/bin/orb", "local/bin/orb", "repo/target/debug/orb"] {
        let file = dir.path().join(built);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).change_context(StoreError)?;
        }
        std::fs::write(file, b"").change_context(StoreError)?;
    }

    // When deciding the upgrade policy for the running orb.
    let exe = exe.map(|exe| dir.path().join(exe));
    let installed = [dir.path().join("cargo/bin"), dir.path().join("local/bin")];
    let policy = upgrade_policy(exe.as_deref(), &installed, flag);

    // Then it matches where orb runs from.
    assert_eq!(
        policy, expected,
        "upgrade policy for {exe:?} with flag {flag}"
    );
    Ok(())
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".bak-v10");
    PathBuf::from(name)
}

const THREAD_COLUMNS: &str = "SELECT * FROM threads ORDER BY id";

#[rstest::rstest]
fn migrating_v10_writes_the_backup_before_changing_anything() -> Result<(), Report<StoreError>> {
    // Given a v10 database and its agents as they were.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    v10_database(&path)?;
    let before = rows(&path, THREAD_COLUMNS)?;

    // When opening the store.
    drop(Store::open(&path)?);

    // Then the backup is a v10 database holding the same agents.
    let backup = backup_path(&path);
    assert_eq!(
        (user_version(&backup)?, rows(&backup, THREAD_COLUMNS)?),
        (10, before),
        "the backup should be the v10 database as it was"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_keeps_an_existing_backup() -> Result<(), Report<StoreError>> {
    // Given a v10 database with a backup already beside it.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    v10_database(&path)?;
    let backup = backup_path(&path);
    std::fs::write(&backup, b"an earlier backup").change_context(StoreError)?;

    // When opening the store.
    drop(Store::open(&path)?);

    // Then the backup is left as it was.
    assert_eq!(
        std::fs::read(&backup).change_context(StoreError)?,
        b"an earlier backup".to_vec(),
        "an existing backup should never be overwritten"
    );
    Ok(())
}

#[rstest::rstest]
fn failed_backup_leaves_a_v10_database_unmigrated() -> Result<(), Report<StoreError>> {
    // Given a v10 database whose backup can't be written (a directory
    // sits where the partial copy goes).
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    v10_database(&path)?;
    let mut partial = backup_path(&path).into_os_string();
    partial.push(".tmp");
    std::fs::create_dir_all(PathBuf::from(partial).join("blocker")).change_context(StoreError)?;

    // When opening the store.
    let opened = Store::open(&path);

    // Then opening fails and the database is still at v10.
    assert_eq!(
        (opened.is_err(), user_version(&path)?),
        (true, 10),
        "no migration should run without a backup"
    );
    Ok(())
}

#[rstest::rstest]
fn opening_a_fresh_database_writes_no_backup() -> Result<(), Report<StoreError>> {
    // Given a path with no database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");

    // When opening the store.
    drop(Store::open(&path)?);

    // Then the directory holds only the database.
    let names: Vec<String> = std::fs::read_dir(dir.path())
        .change_context(StoreError)?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".bak"))
        .collect();
    assert!(
        names.is_empty(),
        "a fresh database needs no backup: {names:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_keeps_every_agent_id() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading its agents.
    let agents = rows(
        &path,
        "SELECT id, pane_id IS NOT NULL FROM threads ORDER BY id",
    )?;

    // Then agents 3 to 10 are there, each in a pane.
    let expected: Vec<Vec<String>> = (3..=10)
        .map(|id| vec![format!("Integer({id})"), "Integer(1)".to_owned()])
        .collect();
    assert_eq!(
        agents, expected,
        "every agent should keep its id and get a pane"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_records_each_agents_session() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading which agents' session differs from their pane's.
    let mismatched = rows(
        &path,
        "SELECT t.id FROM threads t LEFT JOIN panes p ON p.id = t.pane_id
             WHERE t.orb_session_id IS NOT p.session_id OR t.orb_session_id IS NULL",
    )?;

    // Then every agent records the session of its pane.
    assert!(
        mismatched.is_empty(),
        "every migrated agent should record its pane's session: {mismatched:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_gives_a_lone_claude_agent_one_session_tab_and_pane()
-> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading agent 3's session and its tabs.
    let session = session_of(&path, 3)?;
    let pane = pane_of(&path, 3)?;
    let found = rows(
        &path,
        &format!(
            "SELECT s.dir, s.name, s.active_tab, t.position, t.layout, t.focus_pane,
                        (SELECT COUNT(*) FROM panes WHERE session_id = s.id)
                 FROM sessions s JOIN tabs t ON t.session_id = s.id WHERE s.id = {session}"
        ),
    )?;

    // Then it has one tab of its one pane, in the agent's directory.
    let expected = vec![vec![
        "Text(\"/work/orb\")".to_owned(),
        "Text(\"Fix login\")".to_owned(),
        "Integer(0)".to_owned(),
        "Integer(0)".to_owned(),
        format!("Text(\"{{\\\"pane\\\":{pane}}}\")"),
        format!("Integer({pane})"),
        "Integer(1)".to_owned(),
    ]];
    assert_eq!(
        found, expected,
        "a lone agent should become a one-pane session"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_records_a_claude_panes_resume() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading agent 3's pane.
    let pane = pane_of(&path, 3)?;
    let found = rows(
        &path,
        &format!("SELECT cwd, zmx_name, zmx_dir, resume FROM panes WHERE id = {pane}"),
    )?;

    // Then it resumes the Claude session.
    let expected = vec![vec![
        "Text(\"/work/orb\")".to_owned(),
        "Null".to_owned(),
        "Null".to_owned(),
        "Text(\"claude --resume s-aa11\")".to_owned(),
    ]];
    assert_eq!(found, expected, "a Claude pane should resume its session");
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_keeps_a_pi_panes_zmx_session() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading pi agent 4's pane.
    let pane = pane_of(&path, 4)?;
    let found = rows(
        &path,
        &format!("SELECT zmx_name, zmx_dir, resume FROM panes WHERE id = {pane}"),
    )?;

    // Then it keeps pi's zmx session under orb's pi dir.
    let expected = vec![vec![
        format!("Text(\"{PI_SHORT_ID}\")"),
        "Text(\"pi\")".to_owned(),
        format!("Text(\"pi --session-id {PI_SHORT_ID}\")"),
    ]];
    assert_eq!(found, expected, "a pi pane should keep its zmx session");
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_puts_a_groups_agents_in_one_session() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading the sessions of group 1's agents.
    let sessions: Vec<i64> = [6, 7, 8]
        .into_iter()
        .map(|agent| session_of(&path, agent))
        .collect::<Result<_, _>>()?;

    // Then all three are in the same session.
    assert!(
        sessions.windows(2).all(|pair| pair.first() == pair.last()),
        "a group's agents should share one session, got {sessions:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_gives_each_of_a_groups_agents_a_tab_newest_first() -> Result<(), Report<StoreError>>
{
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading the tabs of group 1's session.
    let session = session_of(&path, 6)?;
    let found = rows(
        &path,
        &format!(
            "SELECT position, name, layout, focus_pane FROM tabs
                 WHERE session_id = {session} ORDER BY position"
        ),
    )?;

    // Then each agent's pane is alone in its own unnamed tab, newest agent first.
    let expected: Vec<Vec<String>> = [8, 7, 6]
        .into_iter()
        .enumerate()
        .map(|(position, agent)| {
            pane_of(&path, agent).map(|pane| {
                vec![
                    format!("Integer({position})"),
                    "Null".to_owned(),
                    format!("Text(\"{{\\\"pane\\\":{pane}}}\")"),
                    format!("Integer({pane})"),
                ]
            })
        })
        .collect::<Result<_, _>>()?;
    assert_eq!(
        found, expected,
        "a group should become one tab per agent, newest first"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_opens_a_groups_session_on_its_first_tab() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading group 1's session's active tab.
    let session = session_of(&path, 6)?;
    let active: i64 = value(
        &path,
        &format!("SELECT active_tab FROM sessions WHERE id = {session}"),
    )?;

    // Then it is the first tab, the newest agent's.
    assert_eq!(active, 0, "a group's session should open on its first tab");
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_copies_a_settled_groups_settle_state() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading the session of settled group 2's agent.
    let session = session_of(&path, 9)?;
    let found = rows(
        &path,
        &format!("SELECT settled_override, settled_at FROM sessions WHERE id = {session}"),
    )?;

    // Then it is settled when the group was.
    let expected = vec![vec![
        "Text(\"settled\")".to_owned(),
        "Integer(8000)".to_owned(),
    ]];
    assert_eq!(
        found, expected,
        "a settled group's session should stay settled"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_copies_a_settled_agents_settle_state() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading settled agent 10's session.
    let session = session_of(&path, 10)?;
    let found = rows(
        &path,
        &format!("SELECT settled_override, settled_at FROM sessions WHERE id = {session}"),
    )?;

    // Then it is settled when the agent was.
    let expected = vec![vec![
        "Text(\"settled\")".to_owned(),
        "Integer(9000)".to_owned(),
    ]];
    assert_eq!(
        found, expected,
        "a settled agent's session should stay settled"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_copies_a_pinned_agents_pin_activity_and_visit() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading pinned agent 3's session.
    let session = session_of(&path, 3)?;
    let found = rows(
        &path,
        &format!(
            "SELECT pinned_at, last_activity_at, last_visited_at FROM sessions
                 WHERE id = {session}"
        ),
    )?;

    // Then it has the agent's pin, activity and visit times.
    let expected = vec![vec![
        "Integer(5000)".to_owned(),
        "Integer(6000)".to_owned(),
        "Integer(7000)".to_owned(),
    ]];
    assert_eq!(
        found, expected,
        "an agent's pin, activity and visit should carry over"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_makes_an_incognito_agents_session_incognito() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading Incognito agent 5's session.
    let session = session_of(&path, 5)?;
    let kind: String = value(
        &path,
        &format!("SELECT kind FROM sessions WHERE id = {session}"),
    )?;

    // Then it is an Incognito session.
    assert_eq!(
        kind, "incognito",
        "an Incognito agent's session should be Incognito"
    );
    Ok(())
}

#[rstest::rstest]
#[case::feature(6, "plain")]
#[case::research(9, "colony")]
fn migrating_v10_maps_group_kinds(
    #[case] agent: i64,
    #[case] expected: &str,
) -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading the kind of the session the group's agent is in.
    let session = session_of(&path, agent)?;
    let kind: String = value(
        &path,
        &format!("SELECT kind FROM sessions WHERE id = {session}"),
    )?;

    // Then it is the group's kind, a Feature becoming plain and a Research
    // group becoming a colony.
    assert_eq!(
        kind, expected,
        "a group's kind should map to a session kind"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_gives_an_agentless_group_one_pane_in_the_project_root()
-> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading agentless group 3's session and panes.
    let found = rows(
        &path,
        "SELECT s.dir, p.cwd, p.resume FROM sessions s JOIN panes p ON p.session_id = s.id
             WHERE s.name = 'later'",
    )?;

    // Then it has one shell pane in the project's root.
    let expected = vec![vec![
        "Text(\"/work/orb\")".to_owned(),
        "Text(\"/work/orb\")".to_owned(),
        "Null".to_owned(),
    ]];
    assert_eq!(
        found, expected,
        "an agentless group should get one shell pane"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_rewrites_jumps_to_sessions() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading its jump rows.
    let jumps = rows(&path, "SELECT kind, item_id FROM jumps ORDER BY position")?;

    // Then agent and group rows point at their sessions and the draft's row is gone.
    let expected: Vec<Vec<String>> = [
        session_of(&path, 3)?,
        session_of(&path, 6)?,
        session_of(&path, 9)?,
    ]
    .into_iter()
    .map(|session| {
        vec![
            "Text(\"session\")".to_owned(),
            format!("Integer({session})"),
        ]
    })
    .collect();
    assert_eq!(jumps, expected, "jumps should point at sessions");
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_numbers_panes_above_every_agent_id() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database whose highest agent id is 10.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;

    // When reading the lowest pane id.
    let lowest: i64 = value(&path, "SELECT MIN(id) FROM panes")?;

    // Then it is above every agent id.
    assert!(
        lowest > 10,
        "pane ids should start above agent ids, got {lowest}"
    );
    Ok(())
}

#[rstest::rstest]
fn migrating_v10_gives_an_agent_of_a_missing_group_its_own_session()
-> Result<(), Report<StoreError>> {
    // Given a v10 database with an agent whose group row is gone.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    v10_database(&path)?;
    Connection::open(&path)
        .and_then(|conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys = OFF;
                 INSERT INTO threads (id, project_id, short_id, cwd, created_at, group_id)
                     VALUES (11, 1, 'ii99', '/work/orb', 1800, 42)",
            )
        })
        .change_context(StoreError)?;

    // When opening the store.
    drop(Store::open(&path)?);

    // Then that agent runs in a one-pane session of its own.
    let panes: i64 = value(
        &path,
        &format!(
            "SELECT COUNT(*) FROM panes WHERE session_id = {}",
            session_of(&path, 11)?
        ),
    )?;
    assert_eq!(panes, 1, "an agent of a missing group should get a session");
    Ok(())
}

#[rstest::rstest]
fn reopening_a_migrated_v10_database_writes_no_second_backup() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database whose backup was then removed.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;
    std::fs::remove_file(backup_path(&path)).change_context(StoreError)?;

    // When opening the store again.
    drop(Store::open(&path)?);

    // Then no backup is written.
    assert!(
        !backup_path(&path).exists(),
        "a database already at v11 should not be backed up again"
    );
    Ok(())
}

#[rstest::rstest]
fn reopening_a_migrated_v10_database_makes_no_more_sessions() -> Result<(), Report<StoreError>> {
    // Given a migrated v10 database and its session count.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = migrated_v10(dir.path())?;
    let before: i64 = value(&path, "SELECT COUNT(*) FROM sessions")?;

    // When opening the store again.
    drop(Store::open(&path)?);

    // Then the sessions are the same.
    let after: i64 = value(&path, "SELECT COUNT(*) FROM sessions")?;
    assert_eq!(after, before, "the migration should run only once");
    Ok(())
}

#[rstest::rstest]
fn inserted_agent_gets_a_session_with_one_pane() -> Result<(), Report<StoreError>> {
    // Given a store with a project.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;

    // When inserting an agent.
    let inserted = insert_agent(&store, project_id)?;

    // Then its session has one tab holding its one pane, in its directory.
    let layouts = store.layouts()?;
    let tabs: Vec<(SessionId, String, Option<PaneId>)> = layouts
        .tabs
        .into_iter()
        .map(|tab| (tab.session_id, tab.layout, tab.focus_pane))
        .collect();
    let panes: Vec<(PaneId, SessionId, PathBuf)> = layouts
        .panes
        .into_iter()
        .map(|pane| (pane.id, pane.session_id, pane.cwd))
        .collect();
    assert_eq!(
        (tabs, panes),
        (
            vec![(
                inserted.session,
                format!("{{\"pane\":{}}}", inserted.pane.0),
                Some(inserted.pane)
            )],
            vec![(inserted.pane, inserted.session, PathBuf::from("/tmp/orb"))]
        ),
        "a new agent should get a one-pane session"
    );
    Ok(())
}

#[rstest::rstest]
fn saved_layout_loads_back() -> Result<(), Report<StoreError>> {
    // Given an agent's session with a second pane.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;
    let second = store.insert_pane(inserted.session, Path::new("/tmp/orb"))?;

    // When saving two tabs, the second active, and a name for the second pane.
    let tabs = vec![
        TabRow {
            session_id: inserted.session,
            position: 0,
            name: Some("agent".to_owned()),
            layout: format!("{{\"pane\":{}}}", inserted.pane.0),
            focus_pane: Some(inserted.pane),
            swap_layout: SwapLayout::Vertical,
            hand_changed: false,
        },
        TabRow {
            session_id: inserted.session,
            position: 1,
            name: None,
            layout: format!("{{\"pane\":{}}}", second.0),
            focus_pane: Some(second),
            swap_layout: SwapLayout::Vertical,
            hand_changed: false,
        },
    ];
    store.save_layout(
        inserted.session,
        1,
        &tabs,
        &SessionFloats::default(),
        &[(inserted.pane, None), (second, Some("logs".to_owned()))],
    )?;

    // Then the tabs, the active tab and the name load back.
    let layouts = store.layouts()?;
    let active: Vec<usize> = layouts.sessions.iter().map(|row| row.active_tab).collect();
    let names: Vec<Option<String>> = layouts.panes.into_iter().map(|pane| pane.name).collect();
    assert_eq!(
        (layouts.tabs, active, names),
        (tabs, vec![1], vec![None, Some("logs".to_owned())]),
        "the saved layout should load back"
    );
    Ok(())
}

#[rstest::rstest]
fn saved_tab_keeps_its_swap_layout_and_mark() -> Result<(), Report<StoreError>> {
    // Given an agent's session.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;

    // When saving its tab half-stacked and changed by hand.
    let tab = TabRow {
        session_id: inserted.session,
        position: 0,
        name: None,
        layout: format!("{{\"pane\":{}}}", inserted.pane.0),
        focus_pane: Some(inserted.pane),
        swap_layout: SwapLayout::HalfStacked,
        hand_changed: true,
    };
    store.save_layout(
        inserted.session,
        0,
        &[tab],
        &SessionFloats::default(),
        &[(inserted.pane, None)],
    )?;

    // Then the tab loads back half-stacked and marked.
    let tabs: Vec<(SwapLayout, bool)> = store
        .layouts()?
        .tabs
        .into_iter()
        .map(|tab| (tab.swap_layout, tab.hand_changed))
        .collect();
    assert_eq!(
        tabs,
        vec![(SwapLayout::HalfStacked, true)],
        "the tab's swap layout and mark should load back"
    );
    Ok(())
}

#[rstest::rstest]
fn saved_session_lifecycle_is_loaded_back() -> Result<(), Report<StoreError>> {
    // Given an agent's session.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;
    let before = store
        .layouts()?
        .sessions
        .into_iter()
        .find(|row| row.id == inserted.session)
        .ok_or_else(|| Report::new(StoreError).attach("the session isn't saved"))?;

    // When saving it named, pinned, settled and with new activity.
    let changed = SessionRow {
        name: Some("auth".to_owned()),
        pinned_at: Some(1_000),
        settled_override: Some(SettledOverride::Settled),
        settled_at: Some(2_000),
        unsettled_at: Some(1_500),
        last_activity_at: 3_000,
        ..before
    };
    store.save_session(&changed)?;

    // Then it loads back as saved.
    assert_eq!(
        store.layouts()?.sessions,
        vec![changed],
        "the session's lifecycle should load back"
    );
    Ok(())
}

#[rstest::rstest]
fn saving_a_layout_without_a_pane_deletes_its_row() -> Result<(), Report<StoreError>> {
    // Given an agent's session with a second pane.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;
    let second = store.insert_pane(inserted.session, Path::new("/tmp/orb"))?;

    // When saving a layout holding only the agent's pane.
    let tab = TabRow {
        session_id: inserted.session,
        position: 0,
        name: None,
        layout: format!("{{\"pane\":{}}}", inserted.pane.0),
        focus_pane: Some(inserted.pane),
        swap_layout: SwapLayout::Vertical,
        hand_changed: false,
    };
    let dropped = store.save_layout(
        inserted.session,
        0,
        &[tab],
        &SessionFloats::default(),
        &[(inserted.pane, None)],
    )?;

    // Then the second pane's row is gone.
    let panes: Vec<PaneId> = store
        .layouts()?
        .panes
        .into_iter()
        .map(|pane| pane.id)
        .collect();
    assert_eq!(
        (dropped, panes),
        (vec![second], vec![inserted.pane]),
        "a pane no tab holds should be deleted"
    );
    Ok(())
}

#[rstest::rstest]
fn deleted_session_takes_its_tabs_and_panes() -> Result<(), Report<StoreError>> {
    // Given an agent's session.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;

    // When deleting the session.
    store.delete_session(inserted.session)?;

    // Then no session, tab or pane is left.
    assert_eq!(
        store.layouts()?,
        SavedLayouts::default(),
        "a deleted session should take its tabs and panes"
    );
    Ok(())
}

/// One tab holding only `pane`, in `session`.
fn lone_tab(session: SessionId, pane: PaneId) -> TabRow {
    TabRow {
        session_id: session,
        position: 0,
        name: None,
        layout: format!("{{\"pane\":{}}}", pane.0),
        focus_pane: Some(pane),
        swap_layout: SwapLayout::Vertical,
        hand_changed: false,
    }
}

/// `pane` as `session`'s float at `position`, a quarter of the body.
fn float_row(session: SessionId, position: usize, pane: PaneId, pinned: bool) -> FloatRow {
    FloatRow {
        session_id: session,
        position,
        pane_id: pane,
        rect: FloatRect {
            x: 0.25 * position as f32,
            y: 0.5,
            width: 0.25,
            height: 0.5,
        },
        pinned,
    }
}

#[rstest::rstest]
fn saved_floats_load_back_in_order_with_their_pins() -> Result<(), Report<StoreError>> {
    // Given an agent's session with two more panes.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;
    let first = store.insert_pane(inserted.session, Path::new("/tmp/orb"))?;
    let second = store.insert_pane(inserted.session, Path::new("/tmp/orb"))?;

    // When saving the two panes as floats, the top one pinned.
    let floats = vec![
        float_row(inserted.session, 0, first, false),
        float_row(inserted.session, 1, second, true),
    ];
    store.save_layout(
        inserted.session,
        0,
        &[lone_tab(inserted.session, inserted.pane)],
        &SessionFloats {
            rows: floats.clone(),
            ..SessionFloats::default()
        },
        &[(inserted.pane, None), (first, None), (second, None)],
    )?;

    // Then the floats load back in order with their places and pins.
    assert_eq!(
        store.layouts()?.floats,
        floats,
        "saved floats should load back as saved"
    );
    Ok(())
}

#[rstest::rstest]
fn saving_a_layout_keeps_its_float_panes_rows() -> Result<(), Report<StoreError>> {
    // Given an agent's session with a second pane.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;
    let float = store.insert_pane(inserted.session, Path::new("/tmp/orb"))?;

    // When saving a layout holding the second pane only as a float.
    let dropped = store.save_layout(
        inserted.session,
        0,
        &[lone_tab(inserted.session, inserted.pane)],
        &SessionFloats {
            rows: vec![float_row(inserted.session, 0, float, false)],
            ..SessionFloats::default()
        },
        &[(inserted.pane, None), (float, None)],
    )?;

    // Then no pane is dropped and the float's row is kept.
    let panes: Vec<PaneId> = store
        .layouts()?
        .panes
        .into_iter()
        .map(|pane| pane.id)
        .collect();
    assert_eq!(
        (dropped, panes),
        (vec![], vec![inserted.pane, float]),
        "a float's pane should keep its row"
    );
    Ok(())
}

#[rstest::rstest]
fn saved_floats_mark_loads_back() -> Result<(), Report<StoreError>> {
    // Given an agent's session.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;

    // When saving its layout with the floats marked changed by hand.
    store.save_layout(
        inserted.session,
        0,
        &[lone_tab(inserted.session, inserted.pane)],
        &SessionFloats {
            hand_changed: true,
            ..SessionFloats::default()
        },
        &[(inserted.pane, None)],
    )?;

    // Then the session loads back marked.
    let marked = store
        .layouts()?
        .sessions
        .first()
        .is_some_and(|row| row.floats_hand_changed);
    assert!(marked, "the floats' mark should load back");
    Ok(())
}

#[rstest::rstest]
fn saved_float_layout_loads_back() -> Result<(), Report<StoreError>> {
    // Given an agent's session.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;

    // When saving its layout with the floats spread.
    store.save_layout(
        inserted.session,
        0,
        &[lone_tab(inserted.session, inserted.pane)],
        &SessionFloats {
            layout: FloatLayout::Spread,
            ..SessionFloats::default()
        },
        &[(inserted.pane, None)],
    )?;

    // Then the session loads back spread.
    let layout = store
        .layouts()?
        .sessions
        .first()
        .map(|row| row.float_layout);
    assert_eq!(
        layout,
        Some(FloatLayout::Spread),
        "the float layout should load back"
    );
    Ok(())
}

#[rstest::rstest]
fn saving_without_a_closed_float_drops_its_pane() -> Result<(), Report<StoreError>> {
    // Given an agent's session saved with a float.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;
    let float = store.insert_pane(inserted.session, Path::new("/tmp/orb"))?;
    store.save_layout(
        inserted.session,
        0,
        &[lone_tab(inserted.session, inserted.pane)],
        &SessionFloats {
            rows: vec![float_row(inserted.session, 0, float, false)],
            ..SessionFloats::default()
        },
        &[(inserted.pane, None), (float, None)],
    )?;

    // When saving it again with the float closed.
    let dropped = store.save_layout(
        inserted.session,
        0,
        &[lone_tab(inserted.session, inserted.pane)],
        &SessionFloats::default(),
        &[(inserted.pane, None)],
    )?;

    // Then the float's pane is dropped.
    assert_eq!(
        dropped,
        vec![float],
        "a closed float's pane should be deleted"
    );
    Ok(())
}

#[rstest::rstest]
fn deleted_session_takes_its_floats() -> Result<(), Report<StoreError>> {
    // Given an agent's session saved with a float.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;
    let float = store.insert_pane(inserted.session, Path::new("/tmp/orb"))?;
    store.save_layout(
        inserted.session,
        0,
        &[lone_tab(inserted.session, inserted.pane)],
        &SessionFloats {
            rows: vec![float_row(inserted.session, 0, float, false)],
            ..SessionFloats::default()
        },
        &[(inserted.pane, None), (float, None)],
    )?;

    // When deleting the session.
    store.delete_session(inserted.session)?;

    // Then no float is left.
    assert!(
        store.layouts()?.floats.is_empty(),
        "a deleted session should take its floats"
    );
    Ok(())
}

#[rstest::rstest]
fn deleted_session_takes_its_agents() -> Result<(), Report<StoreError>> {
    // Given an agent's session.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;

    // When deleting the session.
    store.delete_session(inserted.session)?;

    // Then the agent that ran in it is gone too.
    let (_, agents, ..) = store.load()?;
    assert!(
        agents.is_empty(),
        "a deleted session should take the agents in its panes"
    );
    Ok(())
}

#[rstest::rstest]
fn deleted_session_takes_its_ended_agents() -> Result<(), Report<StoreError>> {
    // Given an agent whose pane ended, out of its session.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;
    let mut row = store
        .load()?
        .1
        .into_iter()
        .find(|row| row.id == inserted.agent)
        .ok_or_else(|| Report::new(StoreError))?;
    row.pane_id = None;
    store.save_agent(&row)?;

    // When deleting the session.
    store.delete_session(inserted.session)?;

    // Then the ended agent is gone too.
    let (_, agents, ..) = store.load()?;
    assert!(
        agents.is_empty(),
        "a deleted session should take the agents that ended in it"
    );
    Ok(())
}

#[rstest::rstest]
fn inserted_agent_loads_its_session() -> Result<(), Report<StoreError>> {
    // Given a project.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;

    // When inserting an agent.
    let inserted = insert_agent(&store, project_id)?;

    // Then it loads back in its new session.
    let sessions: Vec<Option<SessionId>> = store
        .load()?
        .1
        .into_iter()
        .map(|row| row.orb_session)
        .collect();
    assert_eq!(
        sessions,
        vec![Some(inserted.session)],
        "a new agent should know its session"
    );
    Ok(())
}

#[rstest::rstest]
fn ended_agent_keeps_its_session() -> Result<(), Report<StoreError>> {
    // Given an agent in its session.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;
    let mut row = store
        .load()?
        .1
        .into_iter()
        .find(|row| row.id == inserted.agent)
        .ok_or_else(|| Report::new(StoreError))?;

    // When its pane ends.
    row.pane_id = None;
    store.save_agent(&row)?;

    // Then it still loads with that session.
    let sessions: Vec<Option<SessionId>> = store
        .load()?
        .1
        .into_iter()
        .map(|row| row.orb_session)
        .collect();
    assert_eq!(
        sessions,
        vec![Some(inserted.session)],
        "an ended agent should keep its session"
    );
    Ok(())
}

#[rstest::rstest]
fn pane_agent_loads_the_session_of_its_pane() -> Result<(), Report<StoreError>> {
    // Given a pane in a session of the orb project.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;
    let pane = store.insert_pane(inserted.session, Path::new("/tmp/orb"))?;

    // When a report starts an agent in that pane.
    let (agent, _) = store.insert_pane_agent(&NewPaneAgent {
        pane,
        session_id: "s-new".to_owned(),
        transcript_path: None,
        harness: HarnessId::new("claude"),
        cwd: PathBuf::from("/tmp/orb"),
        created_at: 2_000,
    })?;

    // Then it loads with the pane's session.
    let session = store
        .load()?
        .1
        .into_iter()
        .find(|row| row.id == agent)
        .and_then(|row| row.orb_session);
    assert_eq!(
        session,
        Some(inserted.session),
        "a pane's agent should know the pane's session"
    );
    Ok(())
}

#[rstest::rstest]
fn inserted_agents_session_loads_its_project_and_creation() -> Result<(), Report<StoreError>> {
    // Given an agent inserted at 1000 in project orb.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    insert_agent(&store, project_id)?;

    // When loading the sessions.
    let found: Vec<(ProjectId, SessionKind, i64)> = store
        .layouts()?
        .sessions
        .into_iter()
        .map(|row| (row.project_id, row.kind, row.created_at))
        .collect();

    // Then its session is a plain one of that project, made at 1000.
    assert_eq!(
        found,
        [(project_id, SessionKind::Plain, 1_000)],
        "a session loads its project, kind and creation time"
    );
    Ok(())
}

#[rstest::rstest]
fn inserted_pane_loads_back_in_its_session() -> Result<(), Report<StoreError>> {
    // Given an agent's session.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;

    // When inserting a pane in /tmp/logs.
    let pane = store.insert_pane(inserted.session, Path::new("/tmp/logs"))?;

    // Then it loads back in that session and directory.
    let found: Vec<(SessionId, PathBuf)> = store
        .layouts()?
        .panes
        .into_iter()
        .filter(|row| row.id == pane)
        .map(|row| (row.session_id, row.cwd))
        .collect();
    assert_eq!(
        found,
        vec![(inserted.session, PathBuf::from("/tmp/logs"))],
        "the new pane should load back"
    );
    Ok(())
}

#[rstest::rstest]
fn save_agent_saves_its_pane() -> Result<(), Report<StoreError>> {
    // Given an agent and a second pane in its session.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;
    let pane = store.insert_pane(inserted.session, Path::new("/tmp/orb"))?;
    let mut row = store
        .load()?
        .1
        .into_iter()
        .find(|row| row.id == inserted.agent)
        .ok_or_else(|| Report::new(StoreError))?;

    // When saving the agent in that pane.
    row.pane_id = Some(pane);
    store.save_agent(&row)?;

    // Then it loads back in that pane.
    let panes: Vec<Option<PaneId>> = store.load()?.1.into_iter().map(|row| row.pane_id).collect();
    assert_eq!(panes, vec![Some(pane)], "the agent's pane should be saved");
    Ok(())
}

#[rstest::rstest]
fn insert_pane_agent_joins_the_project_of_the_panes_session() -> Result<(), Report<StoreError>> {
    // Given a pane in a session of the orb project.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;
    let pane = store.insert_pane(inserted.session, Path::new("/tmp/orb"))?;

    // When a report starts an agent in that pane.
    let (agent, project) = store.insert_pane_agent(&NewPaneAgent {
        pane,
        session_id: "s-new".to_owned(),
        transcript_path: Some(PathBuf::from("/t/s-new.jsonl")),
        harness: HarnessId::new("claude"),
        cwd: PathBuf::from("/tmp/orb"),
        created_at: 2_000,
    })?;

    // Then it is saved in the orb project, running in that pane.
    let found = store
        .load()?
        .1
        .into_iter()
        .find(|row| row.id == agent)
        .map(|row| (row.project_id, row.pane_id, row.session_id));
    assert_eq!(
        (project, found),
        (
            project_id,
            Some((project_id, Some(pane), Some("s-new".to_owned())))
        ),
        "the agent should join the pane's project and run in the pane"
    );
    Ok(())
}

#[rstest::rstest]
fn set_pane_resume_is_loaded_back_with_the_pane() -> Result<(), Report<StoreError>> {
    // Given an agent's pane.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new("/tmp/orb"), "orb", ProjectKind::Normal, 500)?;
    let inserted = insert_agent(&store, project_id)?;

    // When setting its resume command.
    store.set_pane_resume(inserted.pane, Some("claude --resume s-1"))?;

    // Then it loads back with the pane.
    let resume: Vec<Option<String>> = store
        .layouts()?
        .panes
        .into_iter()
        .filter(|row| row.id == inserted.pane)
        .map(|row| row.resume)
        .collect();
    assert_eq!(
        resume,
        vec![Some("claude --resume s-1".to_owned())],
        "the resume command should be saved"
    );
    Ok(())
}

#[rstest::rstest]
fn opening_under_a_missing_directory_creates_it() -> Result<(), Report<StoreError>> {
    // Given a database path whose parent directories don't exist.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir
        .path()
        .join("userdata")
        .join("nested")
        .join("state.sqlite");

    // When opening the store.
    drop(Store::open(&path)?);

    // Then the directories and the database file exist.
    assert!(path.is_file(), "opening should create {}", path.display());
    Ok(())
}
