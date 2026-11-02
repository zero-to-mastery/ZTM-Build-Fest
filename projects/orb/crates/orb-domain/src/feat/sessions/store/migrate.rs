//! The schema's migrations, in order, and the copies kept before an
//! upgrade.

use super::*;

/// One schema step: SQL, or Rust for what SQL can't do (layout JSON).
#[derive(Clone, Copy)]
pub(super) enum Migration {
    Sql(&'static str),
    Code(fn(&Connection) -> rusqlite::Result<()>),
}

impl Migration {
    pub(super) fn apply(self, conn: &Connection) -> rusqlite::Result<()> {
        match self {
            Self::Sql(sql) => conn.execute_batch(sql),
            Self::Code(step) => step(conn),
        }
    }
}

/// Schema migrations in order: entry `i` moves `user_version` from `i` to `i + 1`.
pub(super) const MIGRATIONS: &[Migration] = &[
    Migration::Sql("
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, root TEXT NOT NULL UNIQUE, title TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE threads (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      short_id TEXT NOT NULL UNIQUE, session_id TEXT, title TEXT, cwd TEXT NOT NULL,
      transcript_path TEXT, transcript_offset INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, turn_started_at INTEGER);
"),
    Migration::Sql("ALTER TABLE threads ADD COLUMN custom_title TEXT;"),
    Migration::Sql("
    ALTER TABLE threads ADD COLUMN branch TEXT;
    ALTER TABLE threads ADD COLUMN pinned_at INTEGER;
    ALTER TABLE threads ADD COLUMN settled_override TEXT;
    ALTER TABLE threads ADD COLUMN settled_at INTEGER;
    ALTER TABLE threads ADD COLUMN unsettled_at INTEGER;
    ALTER TABLE threads ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE threads ADD COLUMN last_visited_at INTEGER NOT NULL DEFAULT 0;
    UPDATE threads SET last_activity_at = created_at, last_visited_at = created_at;
"),
    Migration::Sql("ALTER TABLE threads ADD COLUMN ai_titled INTEGER NOT NULL DEFAULT 0;"),
    Migration::Sql("
    CREATE TABLE drafts (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id),
      workspace TEXT NOT NULL, workspace_path TEXT,
      branch TEXT, model TEXT, permission_mode TEXT,
      created_at INTEGER NOT NULL);
    ALTER TABLE projects ADD COLUMN last_workspace TEXT;
    ALTER TABLE projects ADD COLUMN last_model TEXT;
    ALTER TABLE projects ADD COLUMN last_permission_mode TEXT;
    ALTER TABLE projects ADD COLUMN last_used_at INTEGER;
    ALTER TABLE threads ADD COLUMN model TEXT;
    ALTER TABLE threads ADD COLUMN permission_mode TEXT;
"),
    Migration::Sql("
    ALTER TABLE projects ADD COLUMN removed_at INTEGER;
    CREATE TABLE ui (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sidebar_width INTEGER,
      project_filter INTEGER REFERENCES projects(id));
"),
    Migration::Sql("ALTER TABLE threads ADD COLUMN renamed_title TEXT;"),
    Migration::Sql("
    ALTER TABLE projects ADD COLUMN kind TEXT;
    CREATE TABLE groups (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL, name TEXT NOT NULL, dir TEXT, branch TEXT,
      created_at INTEGER NOT NULL,
      pinned_at INTEGER, settled_override TEXT, settled_at INTEGER, unsettled_at INTEGER,
      draft_model TEXT, draft_permission_mode TEXT,
      UNIQUE (project_id, kind, name));
    ALTER TABLE threads ADD COLUMN group_id INTEGER REFERENCES groups(id);
"),
    Migration::Sql("CREATE TABLE jumps (position INTEGER PRIMARY KEY, kind TEXT NOT NULL, item_id INTEGER NOT NULL);"),
    Migration::Sql("
    ALTER TABLE threads ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude';
    ALTER TABLE drafts ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude';
    ALTER TABLE projects ADD COLUMN last_harness TEXT;
    ALTER TABLE groups ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude';
    ALTER TABLE groups ADD COLUMN has_draft INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE groups ADD COLUMN own_harness TEXT;
    ALTER TABLE groups ADD COLUMN own_model_set INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE groups ADD COLUMN own_model TEXT;
    ALTER TABLE groups ADD COLUMN own_permission_set INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE groups ADD COLUMN own_permission TEXT;
    UPDATE groups SET has_draft = 1
     WHERE id NOT IN (SELECT group_id FROM threads WHERE group_id IS NOT NULL);
"),
    Migration::Code(v11),
    Migration::Sql("
    ALTER TABLE tabs ADD COLUMN swap_layout TEXT NOT NULL DEFAULT 'vertical';
    ALTER TABLE tabs ADD COLUMN hand_changed INTEGER NOT NULL DEFAULT 0;
"),
    Migration::Sql("
    CREATE TABLE floats (
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      position INTEGER NOT NULL,
      pane_id INTEGER NOT NULL REFERENCES panes(id),
      x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0);
    ALTER TABLE sessions ADD COLUMN float_layout TEXT NOT NULL DEFAULT 'staggered';
    ALTER TABLE sessions ADD COLUMN floats_hand_changed INTEGER NOT NULL DEFAULT 0;
"),
    Migration::Sql("
    CREATE TABLE threads_new (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      short_id TEXT NOT NULL UNIQUE, session_id TEXT, title TEXT, cwd TEXT NOT NULL,
      transcript_path TEXT, transcript_offset INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, turn_started_at INTEGER, custom_title TEXT, branch TEXT,
      last_activity_at INTEGER NOT NULL DEFAULT 0, last_visited_at INTEGER NOT NULL DEFAULT 0,
      ai_titled INTEGER NOT NULL DEFAULT 0, model TEXT, renamed_title TEXT,
      harness TEXT NOT NULL DEFAULT 'claude',
      pane_id INTEGER REFERENCES panes(id), orb_session_id INTEGER REFERENCES sessions(id));
    INSERT INTO threads_new (id, project_id, short_id, session_id, title, cwd, transcript_path,
      transcript_offset, created_at, turn_started_at, custom_title, branch, last_activity_at,
      last_visited_at, ai_titled, model, renamed_title, harness, pane_id, orb_session_id)
    SELECT id, project_id, short_id, session_id, title, cwd, transcript_path,
      transcript_offset, created_at, turn_started_at, custom_title, branch, last_activity_at,
      last_visited_at, ai_titled, model, renamed_title, harness, pane_id, orb_session_id
    FROM threads;
    DROP TABLE threads;
    ALTER TABLE threads_new RENAME TO threads;
    DROP TABLE groups;
    DROP TABLE drafts;
    ALTER TABLE projects DROP COLUMN last_workspace;
    ALTER TABLE projects DROP COLUMN last_model;
    ALTER TABLE projects DROP COLUMN last_permission_mode;
    ALTER TABLE projects DROP COLUMN last_used_at;
    ALTER TABLE projects DROP COLUMN last_harness;
    ALTER TABLE panes DROP COLUMN migrated_bg;
"),
    Migration::Sql("
    ALTER TABLE sessions ADD COLUMN parent_id INTEGER;
    UPDATE sessions SET kind = 'colony' WHERE kind IN ('research', 'learn');
"),
];

/// Applies the migrations the database hasn't seen, all in one transaction.
pub(super) fn migrate(conn: &mut Connection) -> Result<(), Report<StoreError>> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .change_context(StoreError)
        .attach("failed to start the migration")?;
    let version: usize = tx
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .change_context(StoreError)
        .attach("failed to read the schema version")?;
    let pending = MIGRATIONS.get(version..).ok_or_else(|| {
        Report::new(StoreError).attach(format!(
            "the database's schema version {version} is newer than this orb knows"
        ))
    })?;
    if pending.is_empty() {
        return Ok(());
    }
    for migration in pending {
        migration
            .apply(&tx)
            .change_context(StoreError)
            .attach("failed to apply a migration")?;
    }
    tx.pragma_update(None, "user_version", MIGRATIONS.len())
        .change_context(StoreError)
        .attach("failed to record the schema version")?;
    tx.commit()
        .change_context(StoreError)
        .attach("failed to commit the migration")
}

pub(super) fn schema_version(conn: &Connection) -> Result<usize, Report<StoreError>> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .change_context(StoreError)
        .attach("failed to read the schema version")
}

/// `<file>.bak-v<version>` beside `path`.
fn copy_path(path: &Path, version: usize) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".bak-v{version}"));
    PathBuf::from(name)
}

/// The refusal for a database at `version`, past what this orb knows,
/// naming the newest copy this orb can open.
pub(super) fn newer_database(path: &Path, version: usize) -> Report<StoreError> {
    let latest = MIGRATIONS.len();
    let hint = match copies(path).into_iter().find(|(n, _)| *n <= latest) {
        Some((_, copy)) => format!(
            "Quit, then put back {} as {} to use this orb.",
            copy.display(),
            path.display()
        ),
        None => "No copy from before that upgrade was found.".to_owned(),
    };
    Report::new(StoreError).attach(format!(
        "orb's saved data is from a newer orb (version {version}; this orb knows {latest}). {hint}"
    ))
}

/// Copies the database (at `version`) to `<file>.bak-v<version>` beside it
/// before an upgrade, once: an existing copy is kept. The copy is written to
/// a `.tmp` file with `VACUUM INTO` (a consistent snapshot, `user_version`
/// included) and renamed into place, so a half-written copy never counts.
pub(super) fn back_up_before_upgrade(
    conn: &Connection,
    path: &Path,
    version: usize,
    log: &Log,
) -> Result<(), Report<StoreError>> {
    let backup = copy_path(path, version);
    let upgrading = format!(
        "upgrading {} from version {version} to {}",
        path.display(),
        MIGRATIONS.len()
    );
    if backup.exists() {
        log.line(
            "upgrade",
            &format!("{upgrading}; kept the existing copy {}", backup.display()),
        );
        return Ok(());
    }
    let partial = {
        let mut name = backup.as_os_str().to_owned();
        name.push(".tmp");
        PathBuf::from(name)
    };
    if partial.exists() {
        std::fs::remove_file(&partial)
            .change_context(StoreError)
            .attach_with(|| format!("failed to remove {}", partial.display()))?;
    }
    conn.execute("VACUUM INTO ?1", params![utf8(&partial)?])
        .change_context(StoreError)
        .attach_with(|| format!("failed to back the database up to {}", partial.display()))?;
    std::fs::rename(&partial, &backup)
        .change_context(StoreError)
        .attach_with(|| format!("failed to move the backup to {}", backup.display()))?;
    log.line(
        "upgrade",
        &format!("{upgrading}; copied it to {}", backup.display()),
    );
    Ok(())
}

/// Every `<file>.bak-v<N>` beside `path`, newest version first. Other names
/// (`.tmp` files included) are never listed; an unreadable folder lists none.
fn copies(path: &Path) -> Vec<(usize, PathBuf)> {
    let (Some(dir), Some(file)) = (path.parent(), path.file_name()) else {
        return Vec::new();
    };
    let prefix = format!("{}.bak-v", file.to_string_lossy());
    let listed = if dir.as_os_str().is_empty() {
        std::fs::read_dir(".")
    } else {
        std::fs::read_dir(dir)
    };
    let mut found: Vec<(usize, PathBuf)> = listed
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let digits = name.to_str()?.strip_prefix(&prefix)?;
            let all_digits = !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
            let version = all_digits.then(|| digits.parse().ok()).flatten()?;
            Some((version, dir.join(&name)))
        })
        .collect();
    found.sort_by_key(|(version, _)| std::cmp::Reverse(*version));
    found
}

/// Removes all but the three newest copies, never the one for `kept` (the
/// version being upgraded from), logging each removal. A failed removal is
/// logged and never stops the upgrade.
pub(super) fn prune_copies(path: &Path, kept: usize, log: &Log) {
    for (_, old) in copies(path)
        .into_iter()
        .skip(3)
        .filter(|(version, _)| *version != kept)
    {
        match std::fs::remove_file(&old) {
            Ok(()) => log.line("delete", &format!("old copy {}: ok", old.display())),
            Err(error) => log.error(
                &format!("delete old copy {}: failed", old.display()),
                &Report::new(error).change_context(StoreError),
            ),
        }
    }
}

/// Turns every group into a session with a tab for each of its agents,
/// newest first, and every agent outside a group (or in a group that is
/// gone) into a session with one tab. Each agent gets a pane of its own,
/// alone in its tab. Agent ids don't change. Pane
/// ids start above every agent id, since earlier versions named zmx sessions
/// `orb-p<agent id>`. The `groups` and `drafts` tables and the agents' old
/// columns stay until v14 drops them.
fn v11(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
          kind TEXT NOT NULL DEFAULT 'plain', dir TEXT NOT NULL, name TEXT, branch TEXT,
          created_at INTEGER NOT NULL, pinned_at INTEGER, settled_override TEXT,
          settled_at INTEGER, unsettled_at INTEGER,
          last_activity_at INTEGER NOT NULL DEFAULT 0, last_visited_at INTEGER NOT NULL DEFAULT 0,
          active_tab INTEGER);
        CREATE TABLE tabs (
          id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id),
          position INTEGER NOT NULL, name TEXT, layout TEXT NOT NULL, focus_pane INTEGER);
        CREATE TABLE panes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES sessions(id),
          cwd TEXT NOT NULL, zmx_name TEXT, zmx_dir TEXT, resume TEXT, migrated_bg TEXT,
          name TEXT);
        ALTER TABLE threads ADD COLUMN pane_id INTEGER REFERENCES panes(id);
        ALTER TABLE threads ADD COLUMN orb_session_id INTEGER REFERENCES sessions(id);
        INSERT INTO sqlite_sequence (name, seq)
        VALUES ('panes', (SELECT COALESCE(MAX(id), 0) FROM threads));
        ",
    )?;
    let mut group_sessions = HashMap::new();
    let groups = collect(
        conn,
        "SELECT g.id, g.project_id, g.kind, COALESCE(g.dir, p.root), g.name, g.branch,
                g.created_at, g.pinned_at, g.settled_override, g.settled_at, g.unsettled_at,
                COALESCE((SELECT MAX(last_activity_at) FROM threads WHERE group_id = g.id),
                         g.created_at),
                COALESCE((SELECT MAX(last_visited_at) FROM threads WHERE group_id = g.id),
                         g.created_at)
         FROM groups g JOIN projects p ON p.id = g.project_id ORDER BY g.id",
        [],
        |row| Ok((row.get::<_, i64>(0)?, migrated_session(row, 1)?)),
    )?;
    for (group, session) in groups {
        let agents = collect(
            conn,
            "SELECT id, cwd, harness, short_id, session_id FROM threads
             WHERE group_id = ?1 ORDER BY created_at DESC, id DESC",
            [group],
            migrated_pane,
        )?;
        let panes: Vec<NewPane> = if agents.is_empty() {
            vec![NewPane::shell(session.dir.clone())]
        } else {
            agents
        };
        let (id, _) = insert_session(conn, &session, &panes)?;
        group_sessions.insert(group, id);
    }
    let mut agent_sessions = HashMap::new();
    let lone = collect(
        conn,
        "SELECT t.id, t.project_id,
                CASE p.kind WHEN 'incognito' THEN 'incognito' ELSE 'plain' END,
                t.cwd, t.renamed_title, t.branch, t.created_at, t.pinned_at,
                t.settled_override, t.settled_at, t.unsettled_at, t.last_activity_at,
                t.last_visited_at, t.id, t.cwd, t.harness, t.short_id, t.session_id
         FROM threads t JOIN projects p ON p.id = t.project_id
         WHERE t.group_id IS NULL OR t.group_id NOT IN (SELECT id FROM groups)
         ORDER BY t.id",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                migrated_session(row, 1)?,
                migrated_pane_at(row, 13)?,
            ))
        },
    )?;
    for (agent, session, pane) in lone {
        let (id, _) = insert_session(conn, &session, &[pane])?;
        agent_sessions.insert(agent, id);
    }
    let grouped = collect(
        conn,
        "SELECT id, group_id FROM threads WHERE group_id IS NOT NULL",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    for (agent, group) in grouped {
        if let Some(session) = group_sessions.get(&group) {
            agent_sessions.insert(agent, *session);
        }
    }
    rewrite_jumps(conn, &agent_sessions, &group_sessions)
}

/// Points agent and group jump rows at their sessions and deletes the rest
/// (drafts, rows whose agent or group is gone).
fn rewrite_jumps(
    conn: &Connection,
    agent_sessions: &HashMap<i64, SessionId>,
    group_sessions: &HashMap<i64, SessionId>,
) -> rusqlite::Result<()> {
    let jumps = collect(
        conn,
        "SELECT position, kind, item_id FROM jumps ORDER BY position",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )?;
    for (position, kind, item) in jumps {
        let session = match kind.as_str() {
            "thread" => agent_sessions.get(&item),
            "group" | "group_draft" => group_sessions.get(&item),
            _ => None,
        };
        match session {
            Some(session) => conn.execute(
                "UPDATE jumps SET kind = 'session', item_id = ?2 WHERE position = ?1",
                params![position, session.0],
            )?,
            None => conn.execute("DELETE FROM jumps WHERE position = ?1", [position])?,
        };
    }
    Ok(())
}

/// Every row `sql` returns, mapped.
pub(super) fn collect<T, P, F>(
    conn: &Connection,
    sql: &str,
    params: P,
    map: F,
) -> rusqlite::Result<Vec<T>>
where
    P: rusqlite::Params,
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    conn.prepare(sql)?.query_map(params, map)?.collect()
}

/// A session to create: the `sessions` row's columns.
struct NewSession {
    project_id: i64,
    /// `plain`, `research`, `learn` or `incognito`.
    kind: String,
    dir: String,
    name: Option<String>,
    branch: Option<String>,
    created_at: i64,
    pinned_at: Option<i64>,
    settled_override: Option<String>,
    settled_at: Option<i64>,
    unsettled_at: Option<i64>,
    last_activity_at: i64,
    last_visited_at: i64,
}

/// A pane to create in a new session, and the agent that runs in it.
struct NewPane {
    agent: Option<i64>,
    cwd: String,
    zmx_name: Option<String>,
    zmx_dir: Option<String>,
    resume: Option<String>,
    migrated_bg: Option<String>,
}

impl NewPane {
    /// A pane running a shell in `cwd`, with no agent.
    fn shell(cwd: String) -> Self {
        Self {
            agent: None,
            cwd,
            zmx_name: None,
            zmx_dir: None,
            resume: None,
            migrated_bg: None,
        }
    }
}

/// A migrated session from the 12 columns starting at `at`: project, kind,
/// dir, name, branch, created, pinned, settle override, settled, un-settled,
/// last activity and last visit. A group kind other than Research or Learn
/// becomes `plain`.
fn migrated_session(row: &Row<'_>, at: usize) -> rusqlite::Result<NewSession> {
    let kind = match row.get::<_, String>(at + 1)?.as_str() {
        kind @ ("research" | "learn" | "incognito") => kind.to_owned(),
        _ => "plain".to_owned(),
    };
    Ok(NewSession {
        project_id: row.get(at)?,
        kind,
        dir: row.get(at + 2)?,
        name: row.get(at + 3)?,
        branch: row.get(at + 4)?,
        created_at: row.get(at + 5)?,
        pinned_at: row.get(at + 6)?,
        settled_override: row.get(at + 7)?,
        settled_at: row.get(at + 8)?,
        unsettled_at: row.get(at + 9)?,
        last_activity_at: row.get(at + 10)?,
        last_visited_at: row.get(at + 11)?,
    })
}

fn migrated_pane(row: &Row<'_>) -> rusqlite::Result<NewPane> {
    migrated_pane_at(row, 0)
}

/// A migrated agent's pane from the 5 columns starting at `at`: agent id,
/// cwd, harness, short id and session id. A Claude pane starts as a shell
/// that will resume the session, its `--bg` session still to stop; a pi pane
/// keeps the zmx session pi already runs in, under `~/.orb/pi`.
fn migrated_pane_at(row: &Row<'_>, at: usize) -> rusqlite::Result<NewPane> {
    let short_id: String = row.get(at + 3)?;
    let session_id: Option<String> = row.get(at + 4)?;
    let shell = NewPane {
        agent: Some(row.get(at)?),
        ..NewPane::shell(row.get(at + 1)?)
    };
    Ok(match row.get::<_, String>(at + 2)?.as_str() {
        "claude" => NewPane {
            resume: session_id.map(|id| format!("claude --resume {id}")),
            migrated_bg: Some(short_id),
            ..shell
        },
        "pi" => NewPane {
            resume: Some(format!("pi --session-id {short_id}")),
            zmx_name: Some(short_id),
            zmx_dir: Some("pi".to_owned()),
            ..shell
        },
        _ => shell,
    })
}

/// Inserts `session` with a tab for each of `panes`, in order, the first tab
/// active, and points each pane's agent at its pane.
fn insert_session(
    conn: &Connection,
    session: &NewSession,
    panes: &[NewPane],
) -> rusqlite::Result<(SessionId, Vec<PaneId>)> {
    let id = SessionId(conn.query_row(
        "INSERT INTO sessions
           (project_id, kind, dir, name, branch, created_at, pinned_at, settled_override,
            settled_at, unsettled_at, last_activity_at, last_visited_at, active_tab)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0) RETURNING id",
        params![
            session.project_id,
            session.kind,
            session.dir,
            session.name,
            session.branch,
            session.created_at,
            session.pinned_at,
            session.settled_override,
            session.settled_at,
            session.unsettled_at,
            session.last_activity_at,
            session.last_visited_at,
        ],
        |row| row.get(0),
    )?);
    let mut ids = Vec::with_capacity(panes.len());
    for pane in panes {
        let pane_id = PaneId(conn.query_row(
            "INSERT INTO panes (session_id, cwd, zmx_name, zmx_dir, resume, migrated_bg)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id",
            params![
                id.0,
                pane.cwd,
                pane.zmx_name,
                pane.zmx_dir,
                pane.resume,
                pane.migrated_bg
            ],
            |row| row.get(0),
        )?);
        if let Some(agent) = pane.agent {
            conn.execute(
                "UPDATE threads SET pane_id = ?2, orb_session_id = ?3 WHERE id = ?1",
                params![agent, pane_id.0, id.0],
            )?;
        }
        conn.execute(
            "INSERT INTO tabs (session_id, position, layout, focus_pane) VALUES (?1, ?2, ?3, ?4)",
            params![
                id.0,
                ids.len(),
                TileLayout::from_saved(Node::Pane(pane_id), pane_id).to_json(),
                pane_id.0
            ],
        )?;
        ids.push(pane_id);
    }
    Ok((id, ids))
}
