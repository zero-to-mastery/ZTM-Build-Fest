//! orb's saved projects, agents and sessions, kept in SQLite across
//! launches.
//!
//! For each project it keeps the directory its sessions start in. For each
//! agent it keeps the session ids, the titles, the git branch, how far the
//! transcript has been read, when the running turn started, when it last had
//! activity and was last visited, and the model its session started with.
//! It also keeps the sidebar's width and project filter. For each project it
//! also keeps its
//! kind (one the user added, or orb's Research or Learn folder). It also
//! keeps the jump list's rows, oldest first. Each session
//! keeps its directory and its tabs in order, each tab its split tree,
//! focused pane, swap layout and whether it was changed by hand, and each
//! pane its directory, zmx session, name and the command that brings its
//! agent back; an agent keeps the pane it runs in.
//! The schema grows through an ordered list of migrations. Before any
//! upgrade the database is copied aside to `<file>.bak-v<old version>`, and
//! only the three newest copies are kept. A database from a newer orb is
//! refused with the name of the copy to put back, and a test build (one not
//! run from cargo's bin directory or `~/.local/bin`) refuses to upgrade unless
//! asked. Times are milliseconds since the Unix epoch.
//!
//! One orb at a time owns a store: it holds a lock beside the database for as
//! long as it runs, since a second orb on the same store would stop the
//! first one's panes.

use std::collections::HashMap;
use std::fs::{File, TryLockError};
use std::path::{Path, PathBuf};

use error_stack::{Report, ResultExt};
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use wherror::Error;

use super::state::{ProjectKind, SessionKind, SidebarItem};
use crate::common::Log;
use crate::feat::harness::HarnessId;
use crate::feat::layout::floats::{FloatLayout, FloatRect};
use crate::feat::layout::tree::{Node, SwapLayout, TileLayout};
use crate::ids::{AgentId, PaneId, ProjectId, SessionId};

mod agents;
mod migrate;
mod projects;
mod sessions;
mod ui;

use self::agents::agent_row;
use self::migrate::{
    MIGRATIONS, back_up_before_upgrade, migrate, newer_database, prune_copies, schema_version,
};
use self::projects::project_row;

#[derive(Debug, Error)]
#[error(debug)]
pub struct StoreError;

/// A saved project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRow {
    pub id: ProjectId,
    /// The directory the project's sessions start in.
    pub root: PathBuf,
    pub title: String,
    pub created_at: i64,
    /// When the project was removed; `None` = not removed.
    pub removed_at: Option<i64>,
    pub kind: ProjectKind,
}

/// A saved agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRow {
    pub id: AgentId,
    pub project_id: ProjectId,
    /// The id the harness gave the session when it started it.
    pub short_id: String,
    /// The harness's session id, once a poll has seen it.
    pub session_id: Option<String>,
    /// The harness's latest generated title, else the first prompt.
    pub title: Option<String>,
    /// The latest title the user gave with `/rename`.
    pub custom_title: Option<String>,
    /// The name the user gave with `r`; beats every other title.
    pub renamed_title: Option<String>,
    pub cwd: PathBuf,
    /// The transcript file, once it has been found.
    pub transcript_path: Option<PathBuf>,
    /// How many bytes of the transcript have been read.
    pub transcript_offset: u64,
    pub created_at: i64,
    /// When orb first saw the current turn running; `None` between turns.
    pub turn_started_at: Option<i64>,
    /// The git branch the transcript last named.
    pub branch: Option<String>,
    /// When orb last saw a turn end, else when the agent was created.
    pub last_activity_at: i64,
    /// When the user last selected the agent.
    pub last_visited_at: i64,
    /// Whether the harness has generated a title for the agent.
    pub ai_titled: bool,
    /// The `--model` a session from before the overhaul started with;
    /// `None` = unknown.
    pub model: Option<String>,
    /// The harness its session runs in.
    pub harness: HarnessId,
    /// The pane it runs in; `None` once it has ended.
    pub pane_id: Option<PaneId>,
    /// The session it runs in, or ran in before it ended; `None` until it
    /// first runs in a pane.
    pub orb_session: Option<SessionId>,
}

/// An agent's settle state as set by the user or by activity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettledOverride {
    /// Settled onto the shelf.
    Settled,
    /// Un-settled by the user, until the next turn activity.
    Active,
}

impl SettledOverride {
    fn as_str(self) -> &'static str {
        match self {
            Self::Settled => "settled",
            Self::Active => "active",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "settled" => Some(Self::Settled),
            "active" => Some(Self::Active),
            _ => None,
        }
    }
}

/// An agent that a harness report started in an existing pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewPaneAgent {
    pub pane: PaneId,
    /// The harness's id for the conversation; also its short id.
    pub session_id: String,
    pub transcript_path: Option<PathBuf>,
    pub harness: HarnessId,
    pub cwd: PathBuf,
    pub created_at: i64,
}

/// A saved session: what its layout needs, and its settle lifecycle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub id: SessionId,
    pub project_id: ProjectId,
    pub kind: SessionKind,
    /// The session that made it, if it's a colonist.
    pub parent: Option<SessionId>,
    /// The name the user gave with `r`.
    pub name: Option<String>,
    /// The branch it was last recorded on.
    pub branch: Option<String>,
    pub created_at: i64,
    /// The directory its panes start in.
    pub dir: PathBuf,
    /// The position of the tab it shows.
    pub active_tab: usize,
    /// Where its floats go when laid out.
    pub float_layout: FloatLayout,
    /// Whether its floats were moved or resized by hand since they were last laid out.
    pub floats_hand_changed: bool,
    pub pinned_at: Option<i64>,
    pub settled_override: Option<SettledOverride>,
    pub settled_at: Option<i64>,
    pub unsettled_at: Option<i64>,
    /// When a turn last ended in one of its agent panes.
    pub last_activity_at: i64,
}

/// A saved tab of a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabRow {
    pub session_id: SessionId,
    /// Where the tab sits in the tab bar, from 0.
    pub position: usize,
    /// The name the user gave it.
    pub name: Option<String>,
    /// Its split tree, as `TileLayout::to_json` writes it.
    pub layout: String,
    /// Its focused pane.
    pub focus_pane: Option<PaneId>,
    /// Where it is in the swap layout list.
    pub swap_layout: SwapLayout,
    /// Whether it was changed by hand since its last relayout.
    pub hand_changed: bool,
}

/// A saved float of a session.
#[derive(Debug, Clone, PartialEq)]
pub struct FloatRow {
    pub session_id: SessionId,
    /// Its place in the floats, from 0 at the bottom.
    pub position: usize,
    pub pane_id: PaneId,
    /// Its place as shares of the tab body.
    pub rect: FloatRect,
    /// Whether it stays drawn while the floats are hidden.
    pub pinned: bool,
}

/// A session's floats as saved: each float, their layout, and whether they
/// were changed by hand since last laid out.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionFloats {
    pub rows: Vec<FloatRow>,
    pub layout: FloatLayout,
    pub hand_changed: bool,
}

/// A saved pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneRow {
    pub id: PaneId,
    pub session_id: SessionId,
    /// The directory its program starts in.
    pub cwd: PathBuf,
    /// Its zmx session's name; `None` = `orb-p<id>`.
    pub zmx_name: Option<String>,
    /// Its zmx socket dir, relative to orb's folder unless absolute; `None`
    /// = orb's own pane dir.
    pub zmx_dir: Option<PathBuf>,
    /// The command to type into a fresh shell to bring its agent back.
    pub resume: Option<String>,
    /// The name the user gave it.
    pub name: Option<String>,
}

/// Every saved session, tab, float and pane, for restoring layouts.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SavedLayouts {
    pub sessions: Vec<SessionRow>,
    /// Ordered by session, then position.
    pub tabs: Vec<TabRow>,
    /// Ordered by session, then position.
    pub floats: Vec<FloatRow>,
    pub panes: Vec<PaneRow>,
}

/// How the user last left orb's layout; `None` = never set.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Ui {
    /// The sidebar's width in columns.
    pub sidebar_width: Option<u16>,
    /// The project the sidebar is filtered to.
    pub project_filter: Option<ProjectId>,
}

/// Everything [`Store::load`] returns: projects and agents.
pub type Saved = (Vec<ProjectRow>, Vec<AgentRow>);

/// orb's database of projects, agents and sessions.
#[derive(Debug)]
pub struct Store {
    conn: Connection,
}

/// Takes the store at `path` for this process: an exclusive lock on the
/// `.lock` file beside it, held until the returned file is dropped (or the
/// process ends).
///
/// # Errors
///
/// Returns an error if another process holds the lock, or the lock file
/// can't be created.
pub fn lock(path: &Path) -> Result<File, Report<StoreError>> {
    let lock_path = path.with_extension("lock");
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)
            .change_context(StoreError)
            .attach_with(|| format!("failed to create {}", parent.display()))?;
    }
    let file = File::create(&lock_path)
        .change_context(StoreError)
        .attach_with(|| format!("failed to create {}", lock_path.display()))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(Report::new(StoreError)
            .attach("another orb is already running; quit it before starting this one")),
        Err(TryLockError::Error(error)) => Err(Report::new(error)
            .change_context(StoreError)
            .attach(format!("failed to lock {}", lock_path.display()))),
    }
}

/// Whether opening the store may upgrade an older database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Upgrade {
    Allowed,
    /// A test build: refuse to upgrade, so the installed orb can still open it.
    AskFirst,
}

/// The installed orb (run from one of the `installed` folders, such as
/// cargo's bin folder or `~/.local/bin` where install.sh puts it) may
/// upgrade; any other orb asks first unless started with `--upgrade-data`
/// (`upgrade_flag`). An exe whose folder can't be resolved counts as a test
/// build.
#[must_use]
pub fn upgrade_policy(exe: Option<&Path>, installed: &[PathBuf], upgrade_flag: bool) -> Upgrade {
    if upgrade_flag {
        return Upgrade::Allowed;
    }
    let installed = exe
        .and_then(Path::parent)
        .and_then(|dir| dir.canonicalize().ok())
        .is_some_and(|dir| {
            installed
                .iter()
                .filter_map(|bin| bin.canonicalize().ok())
                .any(|bin| bin == dir)
        });
    if installed {
        Upgrade::Allowed
    } else {
        Upgrade::AskFirst
    }
}

impl Store {
    /// Opens the database at `path` like `open_live` for the installed orb,
    /// logging nowhere.
    ///
    /// # Errors
    ///
    /// As `open_live` with `Upgrade::Allowed`.
    pub fn open(path: &Path) -> Result<Self, Report<StoreError>> {
        Self::open_live(path, Upgrade::Allowed, &Log::default())
    }

    /// Opens the database at `path`, creating it and its directories if
    /// needed, and brings its schema up to date. Before upgrading it copies
    /// the database aside and keeps the three newest copies, writing each copy
    /// and removal to `log`.
    ///
    /// # Errors
    ///
    /// Returns an error if the directories or the database can't be created;
    /// if the database is from a newer orb (naming the copy to put back); if
    /// it needs an upgrade and `upgrade` is `AskFirst`; or if the copy or a
    /// migration fails.
    pub fn open_live(path: &Path, upgrade: Upgrade, log: &Log) -> Result<Self, Report<StoreError>> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .change_context(StoreError)
                .attach_with(|| format!("failed to create {}", parent.display()))?;
        }
        let conn = Connection::open(path)
            .change_context(StoreError)
            .attach_with(|| format!("failed to open {}", path.display()))?;
        let version = schema_version(&conn)?;
        if version > MIGRATIONS.len() {
            return Err(newer_database(path, version));
        }
        if version > 0 && version < MIGRATIONS.len() {
            if upgrade == Upgrade::AskFirst {
                return Err(Report::new(StoreError).attach(format!(
                    "this test build won't upgrade orb's saved data from version {version} \
                     to {}; start it with --upgrade-data to allow it (a copy is kept first)",
                    MIGRATIONS.len()
                )));
            }
            back_up_before_upgrade(&conn, path, version, log)?;
            prune_copies(path, version, log);
        }
        Self::from_connection(conn)
    }

    /// Opens a fresh database that lives only in memory.
    ///
    /// # Errors
    ///
    /// Returns an error if SQLite can't open it or a migration fails.
    pub fn open_in_memory() -> Result<Self, Report<StoreError>> {
        let conn = Connection::open_in_memory()
            .change_context(StoreError)
            .attach("failed to open an in-memory database")?;
        Self::from_connection(conn)
    }

    fn from_connection(mut conn: Connection) -> Result<Self, Report<StoreError>> {
        conn.pragma_update(None, "foreign_keys", true)
            .change_context(StoreError)
            .attach("failed to enable foreign keys")?;
        migrate(&mut conn)?;
        Ok(Self { conn })
    }

    /// Every saved project (oldest first) and agent (newest first).
    ///
    /// # Errors
    ///
    /// Returns an error if the database can't be read.
    pub fn load(&self) -> Result<Saved, Report<StoreError>> {
        let projects = self
            .query(
                "SELECT id, root, title, created_at, removed_at, kind
                 FROM projects ORDER BY created_at, id",
                project_row,
            )
            .attach("failed to load projects")?;
        let agents = self
            .query(
                "SELECT id, project_id, short_id, session_id, title, cwd, transcript_path,
                        transcript_offset, created_at, turn_started_at, custom_title,
                        branch, last_activity_at, last_visited_at, ai_titled, model,
                        renamed_title, harness, pane_id, orb_session_id
                 FROM threads ORDER BY created_at DESC, id DESC",
                agent_row,
            )
            .attach("failed to load agents")?;
        Ok((projects, agents))
    }

    fn query<T, F>(&self, sql: &str, map: F) -> Result<Vec<T>, Report<StoreError>>
    where
        F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
    {
        let mut statement = self.conn.prepare(sql).change_context(StoreError)?;
        let rows = statement
            .query_map([], map)
            .change_context(StoreError)?
            .collect::<rusqlite::Result<Vec<T>>>()
            .change_context(StoreError)?;
        Ok(rows)
    }
}

fn utf8(path: &Path) -> Result<&str, Report<StoreError>> {
    path.to_str().ok_or_else(|| {
        Report::new(StoreError).attach(format!("the path {} isn't UTF-8", path.display()))
    })
}

/// Fails the test unless every pane row in `store` is held by a saved tab's
/// tree, a float row, or `unread` (panes of tabs whose tree doesn't read).
#[cfg(test)]
pub(crate) fn assert_every_pane_row_held(store: &Store, unread: &[PaneId]) {
    let saved = store.layouts();
    assert!(saved.is_ok(), "the saved layouts should read: {saved:?}");
    let Ok(saved) = saved else {
        return;
    };
    let held: std::collections::HashSet<PaneId> = saved
        .tabs
        .iter()
        .filter_map(|tab| {
            TileLayout::from_json(&tab.layout, tab.focus_pane.unwrap_or(PaneId(0))).ok()
        })
        .flat_map(|tree| tree.pane_ids())
        .chain(saved.floats.iter().map(|float| float.pane_id))
        .chain(unread.iter().copied())
        .collect();
    let orphans: Vec<PaneId> = saved
        .panes
        .iter()
        .map(|pane| pane.id)
        .filter(|id| !held.contains(id))
        .collect();
    assert!(
        orphans.is_empty(),
        "pane rows no tab, float or unread tab holds: {orphans:?}"
    );
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate store failures with `?` and assert on the outcome"
)]
mod tests;
