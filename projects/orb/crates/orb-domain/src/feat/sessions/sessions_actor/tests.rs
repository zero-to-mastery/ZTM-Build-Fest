use crate::feat::harness::HarnessId;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, SystemTime};

use error_stack::{Report, ResultExt};
use ratatui::layout::Rect;

use super::poll::notice_kind;
use super::projects::project_title;
use super::settle::settle_session_row;
use super::{
    ApiAdd, ApiPlace, ApiStart, ApiStartError, ColonyFolderReady, ColonyJob, FAST_POLL, Placement,
    RemoveFolder, SAVE_FAILED, SLOW_POLL, SessionsActor, SessionsActorDeps, WorktreeJob,
    WorktreeReady, current_branch, now_ms, spawn_sessions_actor,
};
use crate::Focus;
use crate::TextInput;
use crate::command::{SessionsCommand, Workspace};
use crate::common::{Log, Outcome, Reporter, Services, State};
use crate::feat::git::git_service::{Git, GitError, GitRef, GitService, WorktreeFacts};
use crate::feat::harness::claude::ClaudeCode;
use crate::feat::harness::claude::fake::FakeClaude;
use crate::feat::harness::claude::transcript::transcript_path;
use crate::feat::harness::fake::FakeHarness;
use crate::feat::harness::{Harness, Harnesses, RunningAgent};
use crate::feat::jumps::state::JumpList;
use crate::feat::layout::floats::{FloatLayout, FloatRect};
use crate::feat::layout::state::{SessionLayout, Tab, test_entry};
use crate::feat::layout::tree::{NavDirection, Split, SwapLayout};
use crate::feat::sessions::state::{
    Agent, AgentStatus, Notice, NoticeKind, PaneLaunch, Project, ProjectKind, Session, SessionKind,
    SidebarItem,
};
use crate::feat::sessions::store::{
    AgentRow, FloatRow, NewPaneAgent, SessionFloats, SessionRow, SettledOverride, Store,
    StoreError, TabRow, Ui, assert_every_pane_row_held,
};
use crate::feat::sessions::validator::{COLONIST_WORKING, SETTLE_IN_PROGRESS};
use crate::feat::sidebar::state::{Rename, RenameTarget};
use crate::feat::zmx::zmx_service::fake::FakeZmx;
use crate::feat::zmx::zmx_service::{Zmx, ZmxError, ZmxOutput, ZmxService, ZmxSession};
use crate::ids::{AgentId, PaneId, ProjectId, SessionId};
use kameo::error::SendError;
use kameo::prelude::{ActorRef, Message};
use std::ffi::OsString;

/// The orb project's root, a folder that exists so its sessions can start.
const PROJECT_ROOT: &str = env!("CARGO_MANIFEST_DIR");
/// The web project's root, another folder that exists.
const WEB_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
/// The branch checked out wherever the fake git lists refs.
const CURRENT_BRANCH: &str = "dev";
const NO_CLAUDE_DIR: &str = "/nonexistent/claude";
const WORKTREES_ROOT: &str = "/nonexistent/worktrees";
const ORB_ROOT: &str = "/nonexistent/orb";
const INCOGNITO_ROOT: &str = "/nonexistent/orb-incognito";
/// Why git refuses outside a repository.
const NOT_A_REPO: &str = "fatal: not a git repository";
/// Why git fails inside a repository whose files are damaged.
const BROKEN_REPO: &str = "fatal: bad object HEAD";
const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// A git call the actor made.
#[derive(Debug, Clone, PartialEq, Eq)]
enum GitCall {
    Fetch(String),
    AddWorktree {
        path: PathBuf,
        branch: String,
        base: String,
    },
    RemoveWorktree {
        path: PathBuf,
        force: bool,
    },
    AddWorktreeOn {
        path: PathBuf,
        branch: String,
    },
    PruneWorktrees(PathBuf),
    DeleteBranch {
        branch: String,
        force: bool,
    },
    RenameBranch {
        old: String,
        new: String,
    },
    Init(PathBuf),
}

/// A git whose default branch is `main`, with [`CURRENT_BRANCH`] checked
/// out everywhere, whose answers the test scripts, and that records the
/// calls that change a repository.
struct FakeGit {
    origin: bool,
    fetch: Result<bool, String>,
    /// The one branch that already exists.
    existing: Option<String>,
    /// Whether the project is a git repository before any `init`.
    repo: bool,
    /// How `init` answers.
    init: Result<(), String>,
    /// The branches origin had at the last fetch.
    remote: Vec<String>,
    /// Whether `is_merged` and `delete_branch` without force find the
    /// branch merged.
    merged: bool,
    /// What `project_path` answers.
    project: Option<PathBuf>,
    /// Why `refs` fails inside the repository, if it does.
    refs_error: Option<String>,
    calls: Mutex<Vec<GitCall>>,
    /// The app state `fetch` looks at, once a test watches one.
    watched: OnceLock<State>,
    /// What `sessions.fetching` was each time `fetch` ran, while watched.
    fetching_seen: Mutex<Vec<Option<String>>>,
    /// While set, the first `add_worktree` waits until its sender is
    /// used or dropped.
    gate: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    /// Whether `add_worktree` panics, as a worktree job that dies.
    panics: bool,
    /// While set, the first `project_path` says so on the sender, then
    /// waits until the receiver's sender is used or dropped.
    project_gate: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
}

impl FakeGit {
    /// A repository without an `origin`.
    fn answering() -> Self {
        Self {
            origin: false,
            fetch: Ok(true),
            existing: None,
            repo: true,
            init: Ok(()),
            remote: Vec::new(),
            merged: true,
            project: None,
            refs_error: None,
            calls: Mutex::default(),
            watched: OnceLock::new(),
            fetching_seen: Mutex::default(),
            gate: Mutex::default(),
            panics: false,
            project_gate: Mutex::default(),
        }
    }

    /// A repository without an `origin`.
    fn local() -> Arc<Self> {
        Arc::new(Self::answering())
    }

    /// A repository without an `origin` whose first `add_worktree` waits
    /// until the returned sender is used or dropped.
    fn gated() -> (Arc<Self>, std::sync::mpsc::Sender<()>) {
        let (open, gate) = std::sync::mpsc::channel();
        let git = Self {
            gate: Mutex::new(Some(gate)),
            ..Self::answering()
        };
        (Arc::new(git), open)
    }

    /// A repository without an `origin` whose first `project_path` sends
    /// on the returned receiver's sender once asked, then waits until the
    /// returned sender is used or dropped.
    fn slow_project_check() -> (
        Arc<Self>,
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::Sender<()>,
    ) {
        let (asked, asking) = std::sync::mpsc::channel();
        let (open, gate) = std::sync::mpsc::channel();
        let git = Self {
            project_gate: Mutex::new(Some((asked, gate))),
            ..Self::answering()
        };
        (Arc::new(git), asking, open)
    }

    /// A repository without an `origin` whose `add_worktree` panics.
    fn panicking() -> Arc<Self> {
        Arc::new(Self {
            panics: true,
            ..Self::answering()
        })
    }

    /// A repository with an `origin` that answers fetches with `fetch`.
    fn with_origin(fetch: Result<bool, &str>) -> Arc<Self> {
        Arc::new(Self {
            origin: true,
            fetch: fetch.map_err(str::to_owned),
            ..Self::answering()
        })
    }

    /// A repository without an `origin` where `branch` already exists.
    fn having(branch: &str) -> Arc<Self> {
        Arc::new(Self {
            existing: Some(branch.to_owned()),
            ..Self::answering()
        })
    }

    /// A directory that isn't a git repository until `init` answers
    /// `init`.
    fn plain(init: Result<(), &str>) -> Arc<Self> {
        Arc::new(Self {
            repo: false,
            init: init.map_err(str::to_owned),
            ..Self::answering()
        })
    }

    /// A repository whose refs can't be read.
    fn broken() -> Arc<Self> {
        Arc::new(Self {
            project: Some(PathBuf::from(PROJECT_ROOT)),
            refs_error: Some(BROKEN_REPO.to_owned()),
            ..Self::answering()
        })
    }

    /// Whether the directory is a repository now.
    fn is_repo(&self) -> bool {
        self.repo
            || (self.init.is_ok()
                && self
                    .calls()
                    .iter()
                    .any(|call| matches!(call, GitCall::Init(_))))
    }

    fn calls(&self) -> Vec<GitCall> {
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn record(&self, call: GitCall) {
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(call);
    }

    /// Looks at `state` on every later fetch.
    fn watch(&self, state: &State) {
        let _ = self.watched.set(state.clone());
    }

    /// What `sessions.fetching` read while each watched fetch ran.
    fn fetching_seen(&self) -> Vec<Option<String>> {
        self.fetching_seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The branch the actor renamed, and its new name.
    fn renamed(&self) -> Option<(String, String)> {
        self.calls().into_iter().find_map(|call| match call {
            GitCall::RenameBranch { old, new } => Some((old, new)),
            _ => None,
        })
    }

    /// The worktree the actor added, and its branch.
    fn added(&self) -> Option<(PathBuf, String)> {
        self.calls().into_iter().find_map(|call| match call {
            GitCall::AddWorktree { path, branch, .. } => Some((path, branch)),
            _ => None,
        })
    }
}

impl Git for FakeGit {
    fn name(&self) -> &'static str {
        "fake"
    }

    fn refs(&self, _cwd: &Path) -> Result<Vec<GitRef>, Report<GitError>> {
        if !self.is_repo() {
            return Err(Report::new(GitError).attach(NOT_A_REPO.to_owned()));
        }
        if let Some(error) = &self.refs_error {
            return Err(Report::new(GitError).attach(error.clone()));
        }
        Ok(vec![GitRef {
            current: true,
            ..git_ref(CURRENT_BRANCH, false)
        }])
    }

    fn default_branch(&self, _repo: &Path) -> Result<String, Report<GitError>> {
        if !self.is_repo() {
            return Err(Report::new(GitError).attach(NOT_A_REPO.to_owned()));
        }
        Ok("main".to_owned())
    }

    fn has_origin(&self, _repo: &Path) -> bool {
        self.origin
    }

    fn fetch(&self, _repo: &Path, branch: &str) -> Result<bool, Report<GitError>> {
        self.record(GitCall::Fetch(branch.to_owned()));
        if let Some(state) = self.watched.get() {
            let fetching = state.read().sessions.fetching.clone();
            self.fetching_seen
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(fetching);
        }
        self.fetch
            .clone()
            .map_err(|reason| Report::new(GitError).attach(reason))
    }

    fn add_worktree(
        &self,
        _repo: &Path,
        path: &Path,
        branch: &str,
        base: &str,
    ) -> Result<(), Report<GitError>> {
        self.record(GitCall::AddWorktree {
            path: path.to_owned(),
            branch: branch.to_owned(),
            base: base.to_owned(),
        });
        let gate = self
            .gate
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(gate) = gate {
            let _ = gate.recv();
        }
        assert!(!self.panics, "the worktree job died");
        Ok(())
    }

    fn remove_worktree(
        &self,
        _repo: &Path,
        path: &Path,
        force: bool,
    ) -> Result<(), Report<GitError>> {
        self.record(GitCall::RemoveWorktree {
            path: path.to_owned(),
            force,
        });
        Ok(())
    }

    fn add_worktree_on(
        &self,
        _repo: &Path,
        path: &Path,
        branch: &str,
    ) -> Result<(), Report<GitError>> {
        self.record(GitCall::AddWorktreeOn {
            path: path.to_owned(),
            branch: branch.to_owned(),
        });
        Ok(())
    }

    fn prune_worktrees(&self, repo: &Path) -> Result<(), Report<GitError>> {
        self.record(GitCall::PruneWorktrees(repo.to_owned()));
        Ok(())
    }

    fn worktree_facts(&self, _path: &Path) -> Result<WorktreeFacts, Report<GitError>> {
        Err(Report::new(GitError)
            .attach("the sessions actor never reads worktree facts".to_owned()))
    }

    fn disk_usage(&self, _path: &Path) -> Option<u64> {
        None
    }

    fn delete_branch(
        &self,
        _repo: &Path,
        branch: &str,
        force: bool,
    ) -> Result<(), Report<GitError>> {
        self.record(GitCall::DeleteBranch {
            branch: branch.to_owned(),
            force,
        });
        if !force && !self.merged {
            return Err(Report::new(GitError)
                .attach(format!("error: the branch '{branch}' is not fully merged")));
        }
        Ok(())
    }

    fn branch_exists(&self, _repo: &Path, branch: &str) -> bool {
        self.existing.as_deref() == Some(branch)
    }

    fn is_merged(&self, _repo: &Path, _branch: &str) -> bool {
        self.merged
    }

    fn has_remote_branch(&self, _repo: &Path, branch: &str) -> bool {
        self.remote.iter().any(|remote| remote == branch)
    }

    fn init(&self, dir: &Path) -> Result<(), Report<GitError>> {
        self.record(GitCall::Init(dir.to_owned()));
        self.init
            .clone()
            .map_err(|reason| Report::new(GitError).attach(reason))
    }

    fn checkout(&self, _cwd: &Path, git_ref: &GitRef) -> Result<String, Report<GitError>> {
        let local = match git_ref.name.split_once('/') {
            Some((_, branch)) if git_ref.remote => branch,
            _ => &git_ref.name,
        };
        Ok(local.to_owned())
    }

    fn rename_branch(&self, _cwd: &Path, old: &str, new: &str) -> Result<(), Report<GitError>> {
        self.record(GitCall::RenameBranch {
            old: old.to_owned(),
            new: new.to_owned(),
        });
        Ok(())
    }

    fn project_path(&self, _cwd: &Path) -> Option<PathBuf> {
        let gate = self
            .project_gate
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some((asked, gate)) = gate {
            let _ = asked.send(());
            let _ = gate.recv();
        }
        self.project.clone()
    }
}

/// A zmx whose `list` prints `stdout` on every socket dir, on the pane
/// socket dir /zmx.
fn zmx_listing(stdout: &str) -> ZmxService {
    ZmxService::new(
        Arc::new(FakeZmx::new(ZmxOutput {
            success: true,
            stdout: stdout.to_owned(),
            stderr: String::new(),
        })),
        PathBuf::from("/zmx"),
        Log::default(),
    )
}

/// An agent and the one-pane session it runs in.
#[derive(Debug, Clone, Copy)]
struct Seeded {
    agent: AgentId,
    session: SessionId,
    pane: PaneId,
}

/// The process the fake zmx runs the pane of agent `short_id` as.
fn pid_of(short_id: &str) -> u32 {
    short_id.bytes().fold(7_u32, |pid, byte| {
        pid.wrapping_mul(31).wrapping_add(u32::from(byte)) % 1_000_000
    }) + 1_000
}

/// The Claude running in agent `short_id`'s pane, `status`.
fn record(short_id: &str, status: AgentStatus) -> RunningAgent {
    RunningAgent {
        status,
        ancestry: vec![pid_of(short_id)],
    }
}

/// A `claude` running `agents`.
fn listing(agents: Vec<RunningAgent>) -> Arc<FakeClaude> {
    Arc::new(FakeClaude::running(agents))
}

/// A zmx running the pane of every agent `store` has bound to one, as
/// process [`pid_of`] its short id, on the pane socket dir /zmx.
fn zmx_running(store: &Store) -> ZmxService {
    let panes = store.layouts().map(|saved| saved.panes).unwrap_or_default();
    let rows = store.load().map(|(_, rows)| rows).unwrap_or_default();
    let listed: String = rows
        .iter()
        .filter_map(|row| {
            let pane = panes.iter().find(|pane| Some(pane.id) == row.pane_id)?;
            let name = pane.zmx_name.clone().unwrap_or_else(|| pane.id.zmx_name());
            Some(format!(
                "  name={name}\tpid={}\tclients=1\tcreated=1\n",
                pid_of(&row.short_id)
            ))
        })
        .collect();
    zmx_listing(&listed)
}

/// A store holding one agent in the orb project, created an hour ago.
fn store_with_agent(short_id: &str) -> Result<(Store, AgentId), Report<StoreError>> {
    let store = Store::open_in_memory()?;
    let id = add_agent(&store, short_id, now_ms() - HOUR_MS)?;
    Ok((store, id))
}

/// Saves the orb project rooted at [`PROJECT_ROOT`].
fn orb_project(store: &Store) -> Result<ProjectId, Report<StoreError>> {
    store.add_project(Path::new(PROJECT_ROOT), "orb", ProjectKind::Normal, 0)
}

/// Saves agent `short_id` of `harness`, created at `created_at`, in a
/// new `kind` session of project `project` in `dir`, one saved tab of one
/// pane.
fn seed_with(
    store: &Store,
    harness: &str,
    project: ProjectId,
    kind: SessionKind,
    dir: &Path,
    short_id: &str,
    created_at: i64,
) -> Result<Seeded, Report<StoreError>> {
    let (session, pane) = store.insert_session(project, kind, dir, None, None, None, created_at)?;
    store.save_layout(
        session,
        0,
        &[TabRow {
            session_id: session,
            position: 0,
            name: None,
            layout: format!("{{\"pane\":{}}}", pane.0),
            focus_pane: Some(pane),
            swap_layout: SwapLayout::Vertical,
            hand_changed: false,
        }],
        &SessionFloats::default(),
        &[(pane, None)],
    )?;
    let (agent, _) = store.insert_pane_agent(&NewPaneAgent {
        pane,
        session_id: short_id.to_owned(),
        transcript_path: None,
        harness: HarnessId::new(harness),
        cwd: dir.to_owned(),
        created_at,
    })?;
    Ok(Seeded {
        agent,
        session,
        pane,
    })
}

/// Saves agent `short_id` of `harness`, created at `created_at`, in a
/// new session of the orb project of its own, one tab of one pane.
fn seed(
    store: &Store,
    harness: &str,
    short_id: &str,
    created_at: i64,
) -> Result<Seeded, Report<StoreError>> {
    let project = orb_project(store)?;
    seed_with(
        store,
        harness,
        project,
        SessionKind::Plain,
        Path::new(PROJECT_ROOT),
        short_id,
        created_at,
    )
}

/// Saves a Claude agent created at `created_at` in the orb project.
fn add_agent(
    store: &Store,
    short_id: &str,
    created_at: i64,
) -> Result<AgentId, Report<StoreError>> {
    seed(store, "claude", short_id, created_at).map(|seeded| seeded.agent)
}

/// Saves `change` over the saved row of the agent `short_id`.
fn resave<F>(store: &Store, short_id: &str, change: F) -> Result<(), Report<StoreError>>
where
    F: FnOnce(AgentRow) -> AgentRow,
{
    store.save_agent(&change(saved(store, short_id)?))
}

/// The saved row of the agent `short_id`.
fn saved(store: &Store, short_id: &str) -> Result<AgentRow, Report<StoreError>> {
    store
        .load()?
        .1
        .into_iter()
        .find(|row| row.short_id == short_id)
        .ok_or_else(|| Report::new(StoreError).attach(format!("{short_id} isn't saved")))
}

/// Starts the actor on `store` the way `on_start` does, without the ticker.
fn start(store: Store, claude: &Arc<FakeClaude>, claude_dir: &Path) -> (SessionsActor, State) {
    start_with(store, claude, &FakeGit::local(), claude_dir)
}

/// Starts the actor on `store` with `git`, making worktrees under
/// [`WORKTREES_ROOT`].
fn start_with(
    store: Store,
    claude: &Arc<FakeClaude>,
    git: &Arc<FakeGit>,
    claude_dir: &Path,
) -> (SessionsActor, State) {
    start_in(
        store,
        claude,
        git,
        claude_dir,
        Path::new(ORB_ROOT),
        Path::new(INCOGNITO_ROOT),
    )
}

/// Starts the actor on `store` with `git`, making worktrees under
/// [`WORKTREES_ROOT`] and Research and Learn folders under `orb_root`.
/// zmx runs every bound agent's pane (see [`zmx_running`]).
fn start_in(
    store: Store,
    claude: &Arc<FakeClaude>,
    git: &Arc<FakeGit>,
    claude_dir: &Path,
    orb_root: &Path,
    incognito_root: &Path,
) -> (SessionsActor, State) {
    let state = State::default();
    let zmx = zmx_running(&store);
    let actor = SessionsActor::restore(SessionsActorDeps {
        services: Services {
            harnesses: Harnesses::new(vec![Arc::new(ClaudeCode::new(
                claude.clone(),
                claude_dir.to_owned(),
            ))]),
            git: GitService::new(git.clone(), Log::default()),
            zmx,
            log: Log::default(),
        },
        state: state.clone(),
        store,
        worktrees_root: PathBuf::from(WORKTREES_ROOT),
        orb_root: orb_root.to_owned(),
        incognito_root: incognito_root.to_owned(),
        report: Reporter::new(|_| {}),
        integration_missing: false,
    });
    (actor, state)
}

/// The harness the routing tests run beside Claude.
const OTHER: &str = "other";

/// What the actor needs to run Claude over `claude` and `other` beside
/// it, sharing `state`.
fn deps_beside(
    store: Store,
    claude: &Arc<FakeClaude>,
    other: &Arc<FakeHarness>,
    state: &State,
) -> SessionsActorDeps {
    let git = FakeGit::local();
    let zmx = zmx_running(&store);
    SessionsActorDeps {
        services: Services {
            harnesses: Harnesses::new(vec![
                Arc::new(ClaudeCode::new(
                    claude.clone(),
                    PathBuf::from(NO_CLAUDE_DIR),
                )),
                other.clone(),
            ]),
            git: GitService::new(git, Log::default()),
            zmx,
            log: Log::default(),
        },
        state: state.clone(),
        store,
        worktrees_root: PathBuf::from(WORKTREES_ROOT),
        orb_root: PathBuf::from(ORB_ROOT),
        incognito_root: PathBuf::from(INCOGNITO_ROOT),
        report: Reporter::new(|_| {}),
        integration_missing: false,
    }
}

/// Starts the actor on `store` with Claude over `claude` and `other`
/// beside it, the way `on_start` does, without the ticker.
fn start_beside(
    store: Store,
    claude: &Arc<FakeClaude>,
    other: &Arc<FakeHarness>,
) -> (SessionsActor, State) {
    let state = State::default();
    let actor = SessionsActor::restore(deps_beside(store, claude, other, &state));
    (actor, state)
}

/// Saves an agent `short_id` of `harness` in the orb project, created an
/// hour ago.
fn add_agent_in(
    store: &Store,
    harness: &str,
    short_id: &str,
) -> Result<AgentId, Report<StoreError>> {
    seed(store, harness, short_id, now_ms() - HOUR_MS).map(|seeded| seeded.agent)
}

/// Saves a Claude agent `short_id` in the orb project, created an hour
/// ago, in a session of its own.
fn insert_agent(store: &Store, short_id: &str) -> Result<Seeded, Report<StoreError>> {
    seed(store, "claude", short_id, now_ms() - HOUR_MS)
}

/// Where pane `pane` runs, as the restored layouts say.
fn zmx_of(state: &State, pane: PaneId) -> Option<ZmxSession> {
    state
        .read()
        .layouts
        .entry(pane)
        .map(|entry| entry.zmx.clone())
}

#[rstest::rstest]
fn agent_pane_runs_in_its_pane_rows_zmx_session() -> Result<(), Report<StoreError>> {
    // Given a saved agent whose harness runs no zmx session of its own.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());

    // When restoring.
    let (_actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // Then its pane runs in orb-p<pane id> on orb's pane socket dir.
    assert_eq!(
        zmx_of(&state, inserted.pane),
        Some(ZmxSession {
            name: format!("orb-p{}", inserted.pane.0),
            dir: PathBuf::from("/zmx"),
        }),
        "a pane without a kept session gets its own on orb's dir"
    );
    Ok(())
}

#[rstest::rstest]
fn kept_pi_session_resolves_under_orbs_folder() -> Result<(), Report<StoreError>> {
    // Given an agent whose pane keeps zmx session `orb-abc` on dir `pi`,
    // as the migration leaves a pi agent's.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    let store = Store::open(&path)?;
    let inserted = insert_agent(&store, "aa")?;
    rusqlite::Connection::open(&path)
        .and_then(|conn| {
            conn.execute(
                "UPDATE panes SET zmx_name = 'orb-abc', zmx_dir = 'pi' WHERE id = ?1",
                [inserted.pane.0],
            )
        })
        .change_context(StoreError)?;
    let host = listing(Vec::new());

    // When restoring.
    let (_actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // Then it runs in orb-abc under orb's folder.
    assert_eq!(
        zmx_of(&state, inserted.pane),
        Some(ZmxSession {
            name: "orb-abc".into(),
            dir: Path::new(ORB_ROOT).join("pi"),
        }),
        "a relative socket dir is under orb's folder"
    );
    Ok(())
}

#[rstest::rstest]
fn agent_pane_starts_a_shell() -> Result<(), Report<StoreError>> {
    // Given a saved agent in a pane.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());

    // When restoring.
    let (_actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // Then it shows only its pane and session: nothing runs but the
    // shell zmx starts, where the user types the agent.
    assert_eq!(
        shown(&state, inserted.agent).and_then(|agent| agent.pane),
        Some(PaneLaunch {
            pane: inserted.pane,
            session: inserted.session,
        }),
        "an agent's pane should carry no command of its harness"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_loads_each_sessions_tabs_into_layouts() -> Result<(), Report<StoreError>> {
    // Given an agent's session saved with two tabs, the second shown.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let second = store.insert_pane(inserted.session, Path::new(PROJECT_ROOT))?;
    let tab = |position, pane: PaneId| TabRow {
        session_id: inserted.session,
        position,
        name: None,
        layout: format!("{{\"pane\":{}}}", pane.0),
        focus_pane: Some(pane),
        swap_layout: SwapLayout::Vertical,
        hand_changed: false,
    };
    store.save_layout(
        inserted.session,
        1,
        &[tab(0, inserted.pane), tab(1, second)],
        &SessionFloats::default(),
        &[(inserted.pane, None), (second, None)],
    )?;
    let host = listing(Vec::new());

    // When restoring.
    let (_actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // Then its layout has both tabs, the second shown and focused on its pane.
    let restored = state
        .read()
        .layouts
        .get(inserted.session)
        .map(|layout| (layout.tabs().len(), layout.active(), layout.focused()));
    assert_eq!(
        restored,
        Some((2, 1, Some(second))),
        "the saved tabs should come back"
    );
    Ok(())
}

/// Adds a second pane to `seeded`'s session and saves the session as two
/// tabs, one per pane, the first shown. Returns the second pane.
fn second_tab(store: &Store, seeded: &Seeded) -> Result<PaneId, Report<StoreError>> {
    let second = store.insert_pane(seeded.session, Path::new(PROJECT_ROOT))?;
    let tab = |position, pane: PaneId| TabRow {
        session_id: seeded.session,
        position,
        name: None,
        layout: format!("{{\"pane\":{}}}", pane.0),
        focus_pane: Some(pane),
        swap_layout: SwapLayout::Vertical,
        hand_changed: false,
    };
    store.save_layout(
        seeded.session,
        0,
        &[tab(0, seeded.pane), tab(1, second)],
        &SessionFloats::default(),
        &[(seeded.pane, None), (second, None)],
    )?;
    Ok(second)
}

/// Saves agent `aa`'s session with a first tab on its pane, readable
/// only when `first_reads`, and a second tab on a second pane, named
/// [`UNREAD_PANE_NAME`], whose tree doesn't read. Returns the agent and
/// the second pane.
fn with_unread_tab(
    store: &Store,
    first_reads: bool,
) -> Result<(Seeded, PaneId), Report<StoreError>> {
    let inserted = insert_agent(store, "aa")?;
    let second = store.insert_pane(inserted.session, Path::new(PROJECT_ROOT))?;
    let tab = |position, layout: String, pane| TabRow {
        session_id: inserted.session,
        position,
        name: None,
        layout,
        focus_pane: Some(pane),
        swap_layout: SwapLayout::Vertical,
        hand_changed: false,
    };
    let first = if first_reads {
        format!("{{\"pane\":{}}}", inserted.pane.0)
    } else {
        UNREAD_TREE.to_owned()
    };
    store.save_layout(
        inserted.session,
        0,
        &[
            tab(0, first, inserted.pane),
            tab(1, UNREAD_TREE.to_owned(), second),
        ],
        &SessionFloats::default(),
        &[
            (inserted.pane, None),
            (second, Some(UNREAD_PANE_NAME.to_owned())),
        ],
    )?;
    Ok((inserted, second))
}

/// A saved split tree orb can't read.
const UNREAD_TREE: &str = "not a tree";

/// The name of the pane whose tab doesn't read.
const UNREAD_PANE_NAME: &str = "server";

#[rstest::rstest]
fn restore_with_a_tab_that_doesnt_read_is_a_partial_load() -> Result<(), Report<StoreError>> {
    // Given a session saved with a tab whose tree doesn't read.
    let store = Store::open_in_memory()?;
    with_unread_tab(&store, true)?;

    // When restoring.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the load counts as partial.
    assert!(
        state.read().sessions.partial_load,
        "a tab orb couldn't read makes the load partial"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_with_every_tab_read_is_not_a_partial_load() -> Result<(), Report<StoreError>> {
    // Given a session saved with one readable tab.
    let store = Store::open_in_memory()?;
    insert_agent(&store, "aa")?;

    // When restoring.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the load is whole.
    assert!(
        !state.read().sessions.partial_load,
        "a load that read everything isn't partial"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_with_unreadable_layouts_is_a_partial_load() -> Result<(), Report<StoreError>> {
    // Given a store whose floats table is gone, so its layouts can't be
    // read.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    let store = Store::open(&path)?;
    insert_agent(&store, "aa")?;
    rusqlite::Connection::open(&path)
        .and_then(|conn| conn.execute("DROP TABLE floats", []))
        .change_context(StoreError)?;

    // When restoring.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the load counts as partial.
    assert!(
        state.read().sessions.partial_load,
        "layouts orb couldn't read make the load partial"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_with_a_tab_that_doesnt_read_says_why() -> Result<(), Report<StoreError>> {
    // Given a session saved with a tab whose tree doesn't read.
    let store = Store::open_in_memory()?;
    with_unread_tab(&store, true)?;

    // When restoring.
    let (actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the mode line says the layouts couldn't all be read, and why.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some(
            "couldn't fully read orb's saved layouts (failed to read a saved layout tree: \
                 expected ident at line 1 column 2); orb keeps what it couldn't read"
        ),
        "the message should give the reason"
    );
    Ok(())
}

#[rstest::rstest]
fn layout_save_keeps_the_pane_of_a_tab_that_didnt_read() -> Result<(), Report<StoreError>> {
    // Given a session whose second tab, on a second pane, didn't read.
    let store = Store::open_in_memory()?;
    let (inserted, second) = with_unread_tab(&store, true)?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // When its layout is saved.
    actor.save_layout(inserted.session);

    // Then the second pane is still saved.
    let panes = actor.store.layouts()?.panes;
    assert!(
        panes.iter().any(|pane| pane.id == second),
        "a pane orb couldn't read must not be deleted"
    );
    Ok(())
}

#[rstest::rstest]
fn layout_save_keeps_the_name_of_a_pane_whose_tab_didnt_read() -> Result<(), Report<StoreError>> {
    // Given a session whose second tab, on a pane named server, didn't
    // read, and whose readable pane was renamed.
    let store = Store::open_in_memory()?;
    let (inserted, second) = with_unread_tab(&store, true)?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    state
        .write()
        .layouts
        .rename_pane(inserted.pane, Some("api".to_owned()));

    // When its layout is saved.
    actor.save_layout(inserted.session);

    // Then the second pane is still saved, still named server.
    let name = actor
        .store
        .layouts()?
        .panes
        .into_iter()
        .find(|pane| pane.id == second)
        .map(|pane| pane.name);
    assert_eq!(
        name,
        Some(Some(UNREAD_PANE_NAME.to_owned())),
        "a pane orb couldn't read must keep its row and name"
    );
    Ok(())
}

/// A seeded session and the panes of its tabs that don't read.
type SeededSession = Result<(SessionId, Vec<PaneId>), Report<StoreError>>;

/// Seeds agent `aa` in a session of its own; no tab is unread.
fn one_agent(store: &Store) -> SeededSession {
    insert_agent(store, "aa").map(|seeded| (seeded.session, Vec::new()))
}

/// Seeds agent `aa` with a second tab whose tree doesn't read.
fn one_unread_tab(store: &Store) -> SeededSession {
    with_unread_tab(store, true).map(|(seeded, second)| (seeded.session, vec![second]))
}

#[rstest::rstest]
#[case::split(one_agent, |actor: &mut SessionsActor, _: &State, s| actor.add_pane(s, Placement::Split(Split::Right)))]
#[case::stack(one_agent, |actor: &mut SessionsActor, _: &State, s| actor.add_pane(s, Placement::Stack))]
#[case::float(one_agent, |actor: &mut SessionsActor, _: &State, s| actor.add_pane(s, Placement::Float))]
#[case::close(one_agent, |actor: &mut SessionsActor, state: &State, s| {
        actor.add_pane(s, Placement::Split(Split::Right));
        let added = state.read().layouts.get(s).and_then(SessionLayout::focused);
        if let Some(added) = added {
            state.write().layouts.close_pane(added);
        }
        actor.save_layout(s);
    })]
#[case::partial_load(one_unread_tab, |actor: &mut SessionsActor, _: &State, s| actor.save_layout(s))]
#[case::partial_load_after_rename(one_unread_tab, |actor: &mut SessionsActor, state: &State, s| {
        let readable = state.read().layouts.get(s).and_then(SessionLayout::focused);
        if let Some(readable) = readable {
            state.write().layouts.rename_pane(readable, Some("api".to_owned()));
        }
        actor.save_layout(s);
    })]
fn layout_save_leaves_every_pane_row_held(
    #[case] given: fn(&Store) -> SeededSession,
    #[case] change: fn(&mut SessionsActor, &State, SessionId),
) -> Result<(), Report<StoreError>> {
    // Given a saved session.
    let store = Store::open_in_memory()?;
    let (session, unread) = given(&store)?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // When its layout changes and is saved.
    change(&mut actor, &state, session);

    // Then every saved pane is held by a tab, a float or an unread tab.
    assert_every_pane_row_held(&actor.store, &unread);
    Ok(())
}

#[rstest::rstest]
fn layout_save_keeps_a_tab_that_didnt_read() -> Result<(), Report<StoreError>> {
    // Given a session whose second tab didn't read.
    let store = Store::open_in_memory()?;
    let (inserted, _second) = with_unread_tab(&store, true)?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // When its layout is saved.
    actor.save_layout(inserted.session);

    // Then the tab is saved after the read one as it was.
    let tabs: Vec<(usize, String)> = actor
        .store
        .layouts()?
        .tabs
        .into_iter()
        .map(|tab| (tab.position, tab.layout))
        .collect();
    assert_eq!(
        tabs,
        vec![
            (0, format!("{{\"pane\":{}}}", inserted.pane.0)),
            (1, UNREAD_TREE.to_owned()),
        ],
        "a tab orb couldn't read must be kept as saved"
    );
    Ok(())
}

#[rstest::rstest]
fn new_tab_of_a_session_with_no_tab_read_keeps_its_panes() -> Result<(), Report<StoreError>> {
    // Given a session none of whose tabs read.
    let store = Store::open_in_memory()?;
    let (inserted, second) = with_unread_tab(&store, false)?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // When its empty layout is saved, which gives it a new shell tab.
    actor.save_layout(inserted.session);

    // Then both of its old panes are still saved.
    let panes = actor.store.layouts()?.panes;
    assert!(
        [inserted.pane, second]
            .iter()
            .all(|id| panes.iter().any(|pane| pane.id == *id)),
        "panes orb couldn't read must not be deleted"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_keeps_each_tabs_swap_layout_and_mark() -> Result<(), Report<StoreError>> {
    // Given an agent's session saved with one horizontal tab changed by hand.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let tab = TabRow {
        session_id: inserted.session,
        position: 0,
        name: None,
        layout: format!("{{\"pane\":{}}}", inserted.pane.0),
        focus_pane: Some(inserted.pane),
        swap_layout: SwapLayout::Horizontal,
        hand_changed: true,
    };
    store.save_layout(
        inserted.session,
        0,
        &[tab],
        &SessionFloats::default(),
        &[(inserted.pane, None)],
    )?;
    let host = listing(Vec::new());

    // When restoring.
    let (_actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // Then its tab is horizontal and marked.
    let restored = state
        .read()
        .layouts
        .get(inserted.session)
        .and_then(SessionLayout::active_tab)
        .map(|tab| (tab.swap_layout(), tab.hand_changed()));
    assert_eq!(
        restored,
        Some((SwapLayout::Horizontal, true)),
        "the tab's swap layout and mark should come back"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_brings_floats_back_hidden() -> Result<(), Report<StoreError>> {
    // Given an agent's session saved with a second pane as a float.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let float = store.insert_pane(inserted.session, Path::new(PROJECT_ROOT))?;
    let tab = TabRow {
        session_id: inserted.session,
        position: 0,
        name: None,
        layout: format!("{{\"pane\":{}}}", inserted.pane.0),
        focus_pane: Some(inserted.pane),
        swap_layout: SwapLayout::Vertical,
        hand_changed: false,
    };
    let row = FloatRow {
        session_id: inserted.session,
        position: 0,
        pane_id: float,
        rect: FloatRect {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.5,
        },
        pinned: false,
    };
    store.save_layout(
        inserted.session,
        0,
        &[tab],
        &SessionFloats {
            rows: vec![row],
            ..SessionFloats::default()
        },
        &[(inserted.pane, None), (float, None)],
    )?;
    let host = listing(Vec::new());

    // When restoring.
    let (_actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // Then the float's pane is back in the session, with the floats hidden.
    let restored = {
        let app = state.read();
        (
            app.layouts.session_panes(inserted.session).contains(&float),
            app.layouts
                .get(inserted.session)
                .is_some_and(SessionLayout::float_focused),
        )
    };
    assert_eq!(
        restored,
        (true, false),
        "a saved float should come back hidden"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_shows_each_saved_session() -> Result<(), Report<StoreError>> {
    // Given an agent's session in the orb project.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());

    // When restoring.
    let (_actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // Then the session is shown in its directory.
    let shown: Vec<(SessionId, PathBuf)> = state
        .read()
        .sessions
        .sessions
        .iter()
        .map(|session| (session.id, session.dir.clone()))
        .collect();
    assert_eq!(
        shown,
        [(inserted.session, PathBuf::from(PROJECT_ROOT))],
        "every saved session should be shown"
    );
    Ok(())
}

#[rstest::rstest]
fn emptied_layout_gets_one_shell_in_the_agents_directory() -> Result<(), Report<StoreError>> {
    // Given a session whose last pane closed.
    let (mut actor, state, inserted) = emptied_session()?;
    let dir = actor
        .sessions
        .get(&inserted.session)
        .map(|row| row.dir.clone());

    // When saving its layout.
    actor.save_layout(inserted.session);

    // Then its layout holds one tab of one pane in the session's directory.
    let app = state.read();
    let shape = app.layouts.get(inserted.session).map(|layout| {
        (
            layout.tabs().len(),
            layout
                .panes()
                .map(|pane| pane.cwd.clone())
                .collect::<Vec<_>>(),
        )
    });
    assert_eq!(
        shape,
        dir.map(|dir| (1, vec![dir])),
        "an emptied session should get one shell tab in its directory"
    );
    Ok(())
}

#[rstest::rstest]
fn emptied_layout_does_not_settle_its_session() -> Result<(), Report<StoreError>> {
    // Given a session whose last pane closed.
    let (mut actor, _state, inserted) = emptied_session()?;

    // When saving its layout.
    actor.save_layout(inserted.session);

    // Then the store keeps it unsettled.
    let settled = actor
        .store
        .layouts()?
        .sessions
        .iter()
        .find(|row| row.id == inserted.session)
        .and_then(|row| row.settled_override);
    assert_eq!(settled, None, "an emptied session should not settle");
    Ok(())
}

#[rstest::rstest]
fn emptied_layout_asks_to_attach_its_session() -> Result<(), Report<StoreError>> {
    // Given a session whose last pane closed.
    let (mut actor, _state, inserted) = emptied_session()?;

    // When saving its layout.
    actor.save_layout(inserted.session);

    // Then the frontend is asked to attach it.
    assert_eq!(
        ready_of(&actor),
        Some(inserted.session),
        "the new shell should be attached"
    );
    Ok(())
}

#[rstest::rstest]
fn saving_a_gone_sessions_layout_adds_nothing() -> Result<(), Report<StoreError>> {
    // Given a store with one agent's session.
    let store = Store::open_in_memory()?;
    insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When saving the layout of a session that doesn't exist.
    actor.save_layout(SessionId(999));

    // Then the store still holds only the agent's pane.
    assert_eq!(
        actor.store.layouts()?.panes.len(),
        1,
        "a gone session should get no pane"
    );
    Ok(())
}

#[rstest::rstest]
fn emptied_layout_of_a_deleting_session_adds_nothing() -> Result<(), Report<StoreError>> {
    // Given a session being deleted whose last pane closed.
    let (mut actor, state, inserted) = emptied_session()?;
    state.write().sessions.deleting.insert(inserted.session);

    // When saving its layout.
    actor.save_layout(inserted.session);

    // Then it gets no layout.
    assert!(
        state.read().layouts.get(inserted.session).is_none(),
        "a session being deleted should get no shell"
    );
    Ok(())
}

/// A zmx that lists no sessions and records each command, on the pane
/// socket dir /zmx.
fn recording_zmx() -> (Arc<FakeZmx>, ZmxService) {
    let zmx = Arc::new(FakeZmx::new(ZmxOutput {
        success: true,
        stdout: String::new(),
        stderr: String::new(),
    }));
    (
        zmx.clone(),
        ZmxService::new(zmx, PathBuf::from("/zmx"), Log::default()),
    )
}

/// A zmx that answers every command with one output and, on each kill,
/// notes whether one session was still on the right side of the watched
/// state.
struct WatchingZmx {
    output: ZmxOutput,
    session: SessionId,
    watched: OnceLock<State>,
    shown_at_kill: Mutex<Vec<bool>>,
}

impl WatchingZmx {
    /// A zmx watching session `session`, whose commands all succeed
    /// printing `stdout`.
    fn new(session: SessionId, stdout: String) -> Arc<Self> {
        Arc::new(Self {
            output: ZmxOutput {
                success: true,
                stdout,
                stderr: String::new(),
            },
            session,
            watched: OnceLock::new(),
            shown_at_kill: Mutex::default(),
        })
    }

    /// Watches `state` from now on.
    fn watch(&self, state: &State) {
        let _ = self.watched.set(state.clone());
    }

    /// For each kill so far, in order, whether the session was shown.
    fn shown_at_kill(&self) -> Vec<bool> {
        self.shown_at_kill
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// A service over this zmx on the pane socket dir /zmx.
    fn service(self: &Arc<Self>) -> ZmxService {
        ZmxService::new(self.clone(), PathBuf::from("/zmx"), Log::default())
    }
}

impl Zmx for WatchingZmx {
    fn name(&self) -> &'static str {
        "watching"
    }

    fn run(&self, argv: &[OsString]) -> Result<ZmxOutput, Report<ZmxError>> {
        if argv.iter().any(|word| word == "kill")
            && let Some(state) = self.watched.get()
        {
            let shown = state.read().attached.contains(&self.session);
            self.shown_at_kill
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(shown);
        }
        Ok(self.output.clone())
    }
}

/// The zmx session names `zmx` was asked to kill, in order.
fn killed(zmx: &FakeZmx) -> Vec<String> {
    zmx.calls()
        .into_iter()
        .filter_map(|argv| {
            let at = argv.iter().position(|word| word == "kill")?;
            argv.get(at + 1)
                .map(|name| name.to_string_lossy().into_owned())
        })
        .collect()
}

/// The saved row of session `id`.
fn saved_session_row(store: &Store, id: SessionId) -> Option<SessionRow> {
    store
        .layouts()
        .ok()?
        .sessions
        .into_iter()
        .find(|row| row.id == id)
}

#[rstest::rstest]
fn pin_session_saves_its_pin() -> Result<(), Report<StoreError>> {
    // Given agent aa's session.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When pinning it.
    actor.pin_session(inserted.session);

    // Then its row is saved pinned.
    assert!(
        saved_session_row(&actor.store, inserted.session)
            .is_some_and(|row| row.pinned_at.is_some()),
        "a pinned session should be saved pinned"
    );
    Ok(())
}

#[rstest::rstest]
fn pin_on_a_settled_session_unsettles_it() -> Result<(), Report<StoreError>> {
    // Given agent aa's session, settled.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.edit_session(inserted.session, settle_session_row);

    // When pinning it.
    actor.pin_session(inserted.session);

    // Then it shows active again.
    assert_eq!(
        state
            .read()
            .sessions
            .session(inserted.session)
            .map(|session| session.settled_at),
        Some(None),
        "pinning a settled session should bring it back"
    );
    Ok(())
}

#[rstest::rstest]
fn unpin_session_clears_its_pin() -> Result<(), Report<StoreError>> {
    // Given agent aa's session, pinned.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.pin_session(inserted.session);

    // When unpinning it.
    actor.unpin_session(inserted.session);

    // Then its row is saved unpinned.
    assert!(
        saved_session_row(&actor.store, inserted.session)
            .is_some_and(|row| row.pinned_at.is_none()),
        "an unpinned session should be saved unpinned"
    );
    Ok(())
}

#[rstest::rstest]
fn rename_session_saves_the_name() -> Result<(), Report<StoreError>> {
    // Given agent aa's session.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When naming it "auth".
    actor.rename_session(inserted.session, Some("auth".to_owned()));

    // Then the store returns the name.
    assert_eq!(
        saved_session_row(&actor.store, inserted.session).and_then(|row| row.name),
        Some("auth".to_owned()),
        "a session's r name should be saved"
    );
    Ok(())
}

#[rstest::rstest]
fn rename_session_shows_the_name_as_its_title() -> Result<(), Report<StoreError>> {
    // Given agent aa's session.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When naming it "auth".
    actor.rename_session(inserted.session, Some("auth".to_owned()));

    // Then its title is the name.
    let app = state.read();
    let title = app
        .sessions
        .session(inserted.session)
        .map(|session| app.sessions.title(session));
    assert_eq!(title.as_deref(), Some("auth"), "the r name is the title");
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn settle_session_marks_it_settled() -> Result<(), Report<StoreError>> {
    // Given agent aa's session, idle.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.poll().await;

    // When settling it.
    actor.settle_session(inserted.session);

    // Then it shows and is saved settled.
    let settled = (
        state
            .read()
            .sessions
            .session(inserted.session)
            .is_some_and(|session| session.settled_at.is_some()),
        saved_session_row(&actor.store, inserted.session).and_then(|row| row.settled_override),
    );
    assert_eq!(
        settled,
        (true, Some(SettledOverride::Settled)),
        "a settled session should show and be saved settled"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn settle_session_with_a_working_agent_is_ignored() -> Result<(), Report<StoreError>> {
    // Given agent aa's session, its agent working.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.poll().await;

    // When settling it.
    actor.settle_session(inserted.session);

    // Then it stays unsettled.
    assert_eq!(
        saved_session_row(&actor.store, inserted.session).and_then(|row| row.settled_override),
        None,
        "a turn that started after the key press wins"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn settle_refused_by_a_working_agent_shows_why() -> Result<(), Report<StoreError>> {
    // Given agent aa's session, its agent working.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.poll().await;

    // When settling it.
    actor.settle_session(inserted.session);

    // Then the message box says a session is working.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some(SETTLE_IN_PROGRESS),
        "a settle a turn beat to the worker should say why, as the key does"
    );
    Ok(())
}

/// Agents aa, bb and cc's polled sessions, bb a colonist of aa and cc of bb,
/// cc's agent `cc_status` and the others idle.
async fn colony_of_three(
    cc_status: AgentStatus,
) -> Result<(SessionsActor, [SessionId; 3]), Report<StoreError>> {
    let store = Store::open_in_memory()?;
    let ids = [
        insert_agent(&store, "aa")?.session,
        insert_agent(&store, "bb")?.session,
        insert_agent(&store, "cc")?.session,
    ];
    let host = listing(vec![
        record("aa", AgentStatus::Idle),
        record("bb", AgentStatus::Idle),
        record("cc", cc_status),
    ]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.poll().await;
    for session in &mut state.write().sessions.sessions {
        session.parent = match session.id {
            id if id == ids[1] => Some(ids[0]),
            id if id == ids[2] => Some(ids[1]),
            _ => None,
        };
    }
    Ok((actor, ids))
}

#[rstest::rstest]
#[tokio::test]
async fn settling_with_colonists_settles_the_whole_subtree() -> Result<(), Report<StoreError>> {
    // Given colony aa with colonist bb, whose colonist is cc, all idle.
    let (mut actor, ids) = colony_of_three(AgentStatus::Idle).await?;

    // When settling aa with its colonists.
    actor.settle_with_colonists(ids[0]);

    // Then all three are saved settled.
    let saved = ids.map(|id| saved_session_row(&actor.store, id)?.settled_override);
    assert_eq!(
        saved,
        [Some(SettledOverride::Settled); 3],
        "settling with colonists settles every session under the colony"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn settling_with_colonists_settles_none_while_one_works() -> Result<(), Report<StoreError>> {
    // Given colony aa with colonist bb, whose colonist cc is working.
    let (mut actor, ids) = colony_of_three(AgentStatus::Working).await?;

    // When settling aa with its colonists.
    actor.settle_with_colonists(ids[0]);

    // Then none is saved settled.
    let saved = ids.map(|id| saved_session_row(&actor.store, id)?.settled_override);
    assert_eq!(
        saved, [None; 3],
        "a colonist's turn that started after the key press wins"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn settling_with_colonists_refused_by_a_working_colonist_shows_why()
-> Result<(), Report<StoreError>> {
    // Given colony aa with colonist bb, whose colonist cc is working.
    let (mut actor, ids) = colony_of_three(AgentStatus::Working).await?;

    // When settling aa with its colonists.
    actor.settle_with_colonists(ids[0]);

    // Then the message box says a colonist is working.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some(COLONIST_WORKING),
        "a settle a colonist's turn beat to the worker should say why"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn unsettling_a_colony_brings_its_colonists_back_under_it() -> Result<(), Report<StoreError>>
{
    // Given colony aa settled alone, its colonist bb lifted to the top level.
    let (mut actor, ids) = colony_of_three(AgentStatus::Idle).await?;
    actor.settle_session(ids[0]);

    // When un-settling aa.
    actor.unsettle_session(ids[0]);

    // Then bb is under aa again.
    assert!(
        !actor.state.read().sessions.top(ids[1]),
        "an un-settled colony's kept colonists move back under it"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn deleting_with_colonists_deletes_the_whole_subtree() -> Result<(), Report<StoreError>> {
    // Given colony aa with colonist bb, whose colonist is cc.
    let (mut actor, ids) = colony_of_three(AgentStatus::Idle).await?;

    // When deleting aa with its colonists.
    delete_all(&mut actor, ids[0]);

    // Then none of the three is left in the app state or the store.
    let left = ids.map(|id| {
        actor.state.read().sessions.session(id).is_some()
            || saved_session_row(&actor.store, id).is_some()
    });
    assert_eq!(
        left, [false; 3],
        "deleting with colonists deletes every session under the colony"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn settle_session_kills_every_pane() -> Result<(), Report<StoreError>> {
    // Given agent aa's idle session with a second pane, and agent bb's
    // session.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let second = second_tab(&store, &inserted)?;
    insert_agent(&store, "bb")?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    let (zmx, service) = recording_zmx();
    actor.services.zmx = service;

    // When settling aa's session.
    actor.settle_session(inserted.session);

    // Then both its panes are killed, and nothing of bb's.
    assert_eq!(
        killed(&zmx),
        vec![inserted.pane.zmx_name(), second.zmx_name()],
        "settling a session kills each of its panes"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn settling_kills_a_pane_no_saved_tab_holds() -> Result<(), Report<StoreError>> {
    // Given agent aa's session, all of whose tabs read, with a second
    // pane row that no saved tab or float holds.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let loose = store.insert_pane(inserted.session, Path::new(PROJECT_ROOT))?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    let (zmx, service) = recording_zmx();
    actor.services.zmx = service;

    // When settling the session.
    actor.settle_session(inserted.session);

    // Then the loose pane's program is killed along with the held one.
    assert_eq!(
        killed(&zmx),
        vec![inserted.pane.zmx_name(), loose.zmx_name()],
        "settling a session kills a pane no saved tab holds too"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn deleting_kills_a_pane_no_saved_tab_holds() -> Result<(), Report<StoreError>> {
    // Given agent aa's session, all of whose tabs read, with a second
    // pane row that no saved tab or float holds.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let loose = store.insert_pane(inserted.session, Path::new(PROJECT_ROOT))?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    let (zmx, service) = recording_zmx();
    actor.services.zmx = service;

    // When deleting the session.
    delete(&mut actor, inserted.session);

    // Then the loose pane's program is killed along with the held one.
    assert_eq!(
        killed(&zmx),
        vec![inserted.pane.zmx_name(), loose.zmx_name()],
        "deleting a session kills a pane no saved tab holds too"
    );
    Ok(())
}

#[rstest::rstest]
fn layout_save_drops_the_row_of_a_pane_no_saved_tab_held() -> Result<(), Report<StoreError>> {
    // Given agent aa's session, all of whose tabs read, with a second
    // pane row that no saved tab or float held at start.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let loose = store.insert_pane(inserted.session, Path::new(PROJECT_ROOT))?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // When its layout is saved.
    actor.save_layout(inserted.session);

    // Then the loose pane's row is gone from the store.
    let kept = actor
        .store
        .layouts()?
        .panes
        .iter()
        .any(|pane| pane.id == loose);
    assert!(!kept, "a save must not keep a pane row no tab holds");
    Ok(())
}

#[rstest::rstest]
#[case::one_tab_unread(true)]
#[case::no_tab_read(false)]
#[tokio::test]
async fn settling_a_partly_read_session_kills_its_unread_pane(
    #[case] first_reads: bool,
) -> Result<(), Report<StoreError>> {
    // Given agent aa's session with a second pane whose tab didn't read.
    let store = Store::open_in_memory()?;
    let (inserted, second) = with_unread_tab(&store, first_reads)?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    let (zmx, service) = recording_zmx();
    actor.services.zmx = service;

    // When settling the session.
    actor.settle_session(inserted.session);

    // Then the unread pane is killed along with the read one.
    assert_eq!(
        killed(&zmx),
        vec![inserted.pane.zmx_name(), second.zmx_name()],
        "settling a session kills the panes of its unread tabs too"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn settle_session_unpins_it() -> Result<(), Report<StoreError>> {
    // Given agent aa's pinned idle session.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.poll().await;
    actor.pin_session(inserted.session);

    // When settling it.
    actor.settle_session(inserted.session);

    // Then it is saved without its pin.
    assert_eq!(
        saved_session_row(&actor.store, inserted.session).map(|row| row.pinned_at),
        Some(None),
        "a settle should remove the pin"
    );
    Ok(())
}

#[rstest::rstest]
fn unsettle_session_keeps_it_active() -> Result<(), Report<StoreError>> {
    // Given agent aa's session, settled.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.edit_session(inserted.session, settle_session_row);

    // When un-settling it.
    actor.unsettle_session(inserted.session);

    // Then it is kept active.
    assert_eq!(
        saved_session_row(&actor.store, inserted.session).and_then(|row| row.settled_override),
        Some(SettledOverride::Active),
        "an un-settled session should be kept active"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn visiting_an_agent_pane_marks_that_agent_seen() -> Result<(), Report<StoreError>> {
    // Given agent aa whose turn ended unseen.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, state) = start_unselected(store, &host);
    actor.poll().await;
    host.set_running(Ok(vec![record("aa", AgentStatus::Idle)]));
    actor.poll().await;

    // When visiting its pane.
    actor.visit(inserted.pane);

    // Then aa is seen.
    assert_eq!(
        shown(&state, inserted.agent).map(|agent| agent.unseen),
        Some(false),
        "visiting an agent's pane should see its turn"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn visiting_one_agent_pane_leaves_its_sessions_other_agents_unseen()
-> Result<(), Report<StoreError>> {
    // Given agents aa and bb in two tabs of one session, both turns
    // ended unseen.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let second = second_tab(&store, &inserted)?;
    let (bb, _) = store.insert_pane_agent(&NewPaneAgent {
        pane: second,
        session_id: "bb".to_owned(),
        transcript_path: None,
        harness: HarnessId::new("claude"),
        cwd: PathBuf::from(PROJECT_ROOT),
        created_at: now_ms() - HOUR_MS,
    })?;
    let host = listing(vec![
        record("aa", AgentStatus::Working),
        record("bb", AgentStatus::Working),
    ]);
    let (mut actor, state) = start_unselected(store, &host);
    actor.poll().await;
    host.set_running(Ok(vec![
        record("aa", AgentStatus::Idle),
        record("bb", AgentStatus::Idle),
    ]));
    actor.poll().await;

    // When visiting aa's pane.
    actor.visit(inserted.pane);

    // Then bb is still unseen.
    assert_eq!(
        shown(&state, bb).map(|agent| agent.unseen),
        Some(true),
        "visiting one agent's pane should leave the others unseen"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn delete_session_kills_every_pane() -> Result<(), Report<StoreError>> {
    // Given agent aa's session with a second pane, and agent bb's
    // session.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let second = second_tab(&store, &inserted)?;
    insert_agent(&store, "bb")?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    let (zmx, service) = recording_zmx();
    actor.services.zmx = service;

    // When deleting aa's session.
    delete(&mut actor, inserted.session);

    // Then both its panes are killed, and nothing of bb's.
    assert_eq!(
        killed(&zmx),
        vec![inserted.pane.zmx_name(), second.zmx_name()],
        "deleting a session kills each of its panes"
    );
    Ok(())
}

#[rstest::rstest]
#[case::one_tab_unread(true)]
#[case::no_tab_read(false)]
#[tokio::test]
async fn deleting_a_partly_read_session_kills_its_unread_pane(
    #[case] first_reads: bool,
) -> Result<(), Report<StoreError>> {
    // Given agent aa's session with a second pane whose tab didn't read.
    let store = Store::open_in_memory()?;
    let (inserted, second) = with_unread_tab(&store, first_reads)?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    let (zmx, service) = recording_zmx();
    actor.services.zmx = service;

    // When deleting the session.
    delete(&mut actor, inserted.session);

    // Then the unread pane is killed along with the read one.
    assert_eq!(
        killed(&zmx),
        vec![inserted.pane.zmx_name(), second.zmx_name()],
        "deleting a session kills the panes of its unread tabs too"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn delete_session_removes_its_agents_tabs_panes_and_row() -> Result<(), Report<StoreError>> {
    // Given agent aa's session.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When deleting it.
    delete(&mut actor, inserted.session);

    // Then the store keeps no session, tab, pane or agent of it.
    let layouts = actor.store.layouts()?;
    let left = (
        layouts.sessions.len(),
        layouts.tabs.len(),
        layouts.panes.len(),
        actor.store.load()?.1.len(),
    );
    assert_eq!(left, (0, 0, 0, 0), "a deleted session leaves nothing");
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn delete_agentless_session_removes_it() -> Result<(), Report<StoreError>> {
    // Given a session whose agent has ended, so no agent runs in it.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    resave(&store, "aa", |row| AgentRow {
        pane_id: None,
        ..row
    })?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When deleting it.
    delete(&mut actor, inserted.session);

    // Then it is neither shown nor saved.
    let kept = (
        state.read().sessions.session(inserted.session).is_some(),
        saved_session_row(&actor.store, inserted.session).is_some(),
    );
    assert_eq!(kept, (false, false), "a session without agents still goes");
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn delete_session_removes_its_ended_agents() -> Result<(), Report<StoreError>> {
    // Given agent aa's session, aa having ended in it.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    resave(&store, "aa", |row| AgentRow {
        pane_id: None,
        ..row
    })?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When deleting the session.
    delete(&mut actor, inserted.session);

    // Then aa is neither shown nor saved.
    let kept = (
        shown(&state, inserted.agent).is_some(),
        actor.store.load()?.1.len(),
    );
    assert_eq!(kept, (false, 0), "a deleted session takes its ended agents");
    Ok(())
}

/// A store holding a colony of orb's Research project in `dir`, made for
/// agent aa.
fn research_sessions(orb_root: &Path, dir: &Path) -> Result<(Store, Seeded), Report<StoreError>> {
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(
        &orb_root.join("research"),
        "Research",
        ProjectKind::Research,
        0,
    )?;
    let inserted = seed_with(
        &store,
        "claude",
        project_id,
        SessionKind::Colony,
        dir,
        "aa",
        now_ms() - HOUR_MS,
    )?;
    Ok((store, inserted))
}

/// An actor on `store` with orb's folder at `orb_root`.
fn start_at(store: Store, orb_root: &Path) -> (SessionsActor, State) {
    start_in(
        store,
        &listing(Vec::new()),
        &FakeGit::local(),
        Path::new(NO_CLAUDE_DIR),
        orb_root,
        Path::new(INCOGNITO_ROOT),
    )
}

#[rstest::rstest]
#[tokio::test]
async fn delete_research_session_removes_its_folder() -> Result<(), Report<StoreError>> {
    // Given a Research session in its own folder under orb's.
    let orb = tempfile::tempdir().change_context(StoreError)?;
    let dir = orb.path().join("research").join("tokio-cancel");
    fs::create_dir_all(&dir).change_context(StoreError)?;
    let (store, inserted) = research_sessions(orb.path(), &dir)?;
    let (mut actor, _state) = start_at(store, orb.path());

    // When deleting it.
    delete(&mut actor, inserted.session);

    // Then its folder is gone.
    assert!(!dir.exists(), "a Research session takes its folder");
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn delete_research_session_leaves_a_folder_outside_orbs_own() -> Result<(), Report<StoreError>>
{
    // Given a Research session whose folder isn't under orb's research
    // folder.
    let orb = tempfile::tempdir().change_context(StoreError)?;
    let outside = tempfile::tempdir().change_context(StoreError)?;
    let (store, inserted) = research_sessions(orb.path(), outside.path())?;
    let (mut actor, _state) = start_at(store, orb.path());

    // When deleting it.
    delete(&mut actor, inserted.session);

    // Then that folder is still there.
    assert!(
        outside.path().is_dir(),
        "only a session's own folder under orb's is removed"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn delete_research_session_whose_folder_is_gone_shows_no_error()
-> Result<(), Report<StoreError>> {
    // Given a Research session whose own folder was already removed by
    // hand.
    let orb = tempfile::tempdir().change_context(StoreError)?;
    let dir = orb.path().join("research").join("tokio-cancel");
    let (store, inserted) = research_sessions(orb.path(), &dir)?;
    let (mut actor, _state) = start_at(store, orb.path());

    // When deleting it.
    delete(&mut actor, inserted.session);

    // Then no error shows.
    assert_eq!(
        error_of(&actor),
        None,
        "an already-removed folder counts as removed"
    );
    Ok(())
}

/// An actor with orb's folder at `orb_root` and Research colony aa in
/// `dir`, with a plain colonist helper running in that same folder.
fn colony_with_helper(
    orb_root: &Path,
    dir: &Path,
) -> Result<(SessionsActor, SessionId), Report<StoreError>> {
    fs::create_dir_all(dir).change_context(StoreError)?;
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(
        &orb_root.join("research"),
        "Research",
        ProjectKind::Research,
        0,
    )?;
    let colony = seed_with(
        &store,
        "claude",
        project_id,
        SessionKind::Colony,
        dir,
        "aa",
        now_ms() - HOUR_MS,
    )?
    .session;
    store.insert_session(
        project_id,
        SessionKind::Plain,
        dir,
        None,
        None,
        Some(colony),
        now_ms(),
    )?;
    let (actor, _state) = start_at(store, orb_root);
    Ok((actor, colony))
}

#[rstest::rstest]
#[tokio::test]
async fn deleting_a_colony_alone_removes_its_folder_while_a_colonist_runs_in_it()
-> Result<(), Report<StoreError>> {
    // Given a Research colony whose helper runs in the colony's folder.
    let orb = tempfile::tempdir().change_context(StoreError)?;
    let dir = orb.path().join("research").join("tokio-cancel");
    let (mut actor, colony) = colony_with_helper(orb.path(), &dir)?;

    // When deleting the colony only.
    delete(&mut actor, colony);

    // Then the folder is gone, though the helper stays.
    assert!(
        !dir.exists(),
        "a fresh colony takes its folder even while a helper runs in it"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn deleting_a_colony_with_its_colonists_removes_its_folder() -> Result<(), Report<StoreError>>
{
    // Given a Research colony whose helper runs in the colony's folder.
    let orb = tempfile::tempdir().change_context(StoreError)?;
    let dir = orb.path().join("research").join("tokio-cancel");
    let (mut actor, colony) = colony_with_helper(orb.path(), &dir)?;

    // When deleting the colony with its colonists.
    delete_all(&mut actor, colony);

    // Then the folder is gone.
    assert!(
        !dir.exists(),
        "deleting a colony with its colonists takes its folder"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn deleting_a_fresh_colony_leaves_its_folder_to_a_removal_job()
-> Result<(), Report<StoreError>> {
    // Given a Research colony with its folder.
    let orb = tempfile::tempdir().change_context(StoreError)?;
    let dir = orb.path().join("research").join("tokio-cancel");
    let (mut actor, colony) = colony_with_helper(orb.path(), &dir)?;

    // When deleting the colony.
    let removal = actor.delete_session(colony);

    // Then the folder is still there, handed back for removal.
    assert_eq!(
        (dir.exists(), removal.map(|removal| removal.dir)),
        (true, Some(dir.clone())),
        "deleting a fresh colony should leave its folder to a removal job"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn folder_removal_that_fails_shows_why() -> Result<(), Report<StoreError>> {
    // Given a deleted Research colony whose folder sits in a read-only
    // folder.
    use std::os::unix::fs::PermissionsExt;
    let orb = tempfile::tempdir().change_context(StoreError)?;
    let parent = orb.path().join("research");
    let dir = parent.join("tokio-cancel");
    let (mut actor, colony) = colony_with_helper(orb.path(), &dir)?;
    let removal = actor.delete_session(colony);
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o555)).change_context(StoreError)?;

    // When the removal runs.
    removal.into_iter().for_each(RemoveFolder::run);

    // Then the mode line says the folder couldn't be removed.
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).change_context(StoreError)?;
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("couldn't remove the folder"),
        "a failed folder removal should say why"
    );
    Ok(())
}

/// A store with world `kit` of `kind` at `root` and colony aa in `dir`.
fn world_colony(
    kind: ProjectKind,
    root: &Path,
    dir: &Path,
) -> Result<(Store, Seeded), Report<StoreError>> {
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(root, "kit", kind, 0)?;
    let inserted = seed_with(
        &store,
        "claude",
        project_id,
        SessionKind::Colony,
        dir,
        "aa",
        now_ms() - HOUR_MS,
    )?;
    Ok((store, inserted))
}

#[rstest::rstest]
#[tokio::test]
async fn delete_fresh_world_colony_removes_its_folder() -> Result<(), Report<StoreError>> {
    // Given a colony of fresh world kit in its own folder under orb's
    // worlds folder.
    let orb = tempfile::tempdir().change_context(StoreError)?;
    let kit = tempfile::tempdir().change_context(StoreError)?;
    let dir = orb.path().join("worlds").join("kit").join("x");
    fs::create_dir_all(&dir).change_context(StoreError)?;
    let (store, inserted) = world_colony(ProjectKind::FreshWorld, kit.path(), &dir)?;
    let (mut actor, _state) = start_at(store, orb.path());

    // When deleting it.
    delete(&mut actor, inserted.session);

    // Then its folder is gone.
    assert!(!dir.exists(), "a fresh-world colony takes its folder");
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn delete_shared_world_colony_keeps_its_folder() -> Result<(), Report<StoreError>> {
    // Given a colony of shared world kit, running in the world's folder.
    let orb = tempfile::tempdir().change_context(StoreError)?;
    let world = tempfile::tempdir().change_context(StoreError)?;
    let (store, inserted) = world_colony(ProjectKind::SharedWorld, world.path(), world.path())?;
    let (mut actor, _state) = start_at(store, orb.path());

    // When deleting it.
    delete(&mut actor, inserted.session);

    // Then the world's folder stays.
    assert!(
        world.path().is_dir(),
        "a shared-world colony leaves the world's folder"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn delete_session_removes_its_pane_files() -> Result<(), Report<StoreError>> {
    // Given agent aa's pane has a report.
    let mut fx = PaneReports::new()?;
    fx.report(fx.agent.pane, "start", "aa", Some("startup"))?;
    fx.actor.poll().await;

    // When deleting aa's session.
    delete(&mut fx.actor, fx.agent.session);

    // Then the pane's file is gone.
    assert!(
        !fx.file(fx.agent.pane).exists(),
        "a deleted session's pane files should go"
    );
    Ok(())
}

#[rstest::rstest]
fn layout_save_deletes_a_dropped_panes_report_file() -> Result<(), Report<StoreError>> {
    // Given the shell pane has a report file.
    let mut fx = PaneReports::new()?;
    fx.report(fx.shell, "start", "aa", Some("startup"))?;

    // When the shell pane closes and the layout is saved.
    fx.state.write().layouts.close_pane(fx.shell);
    fx.actor.save_layout(fx.agent.session);

    // Then the shell pane's report file is gone.
    assert!(
        !fx.file(fx.shell).exists(),
        "a pane's report file should go with its dropped row"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn delete_session_unhides_it() -> Result<(), Report<StoreError>> {
    // Given agent aa's session, hidden as being deleted.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    state.write().sessions.deleting.insert(inserted.session);

    // When deleting it.
    delete(&mut actor, inserted.session);

    // Then nothing is left hidden.
    assert!(
        state.read().sessions.deleting.is_empty(),
        "a deleted session shouldn't stay marked as being deleted"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_keeps_a_migrated_session_jump() -> Result<(), Report<StoreError>> {
    // Given a saved jump to agent aa's session.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    store.save_jumps(&[SidebarItem::Session(inserted.session)])?;

    // When the actor starts.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the jump is in the list.
    assert_eq!(
        state.read().jumps.entries(),
        [SidebarItem::Session(inserted.session)],
        "a saved session jump should come back"
    );
    Ok(())
}

#[rstest::rstest]
fn split_pane_saves_a_new_focused_pane() -> Result<(), Report<StoreError>> {
    // Given an agent's one-pane session.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When splitting it right.
    actor.add_pane(inserted.session, Placement::Split(Split::Right));

    // Then the store has a second pane, which the tab focuses.
    let saved = actor.store.layouts()?;
    let new_pane = saved
        .panes
        .iter()
        .map(|pane| pane.id)
        .find(|id| *id != inserted.pane);
    let focus: Vec<Option<PaneId>> = saved.tabs.iter().map(|tab| tab.focus_pane).collect();
    assert_eq!(
        (new_pane.is_some(), focus),
        (true, vec![new_pane]),
        "a split should save a new focused pane"
    );
    Ok(())
}

#[rstest::rstest]
fn float_add_pane_shows_a_float_with_the_keys() -> Result<(), Report<StoreError>> {
    // Given an agent's one-pane session.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When adding a pane as a float.
    actor.add_pane(inserted.session, Placement::Float);

    // Then a new pane, a float, has the keys.
    let shown = state.read().layouts.get(inserted.session).map(|layout| {
        (
            layout.float_focused(),
            layout.focused().is_some_and(|pane| pane != inserted.pane),
        )
    });
    assert_eq!(
        shown,
        Some((true, true)),
        "the new float should be shown with the keys"
    );
    Ok(())
}

#[rstest::rstest]
fn saving_a_layout_with_a_float_keeps_its_pane_row() -> Result<(), Report<StoreError>> {
    // Given an agent's session with a pane added as a float.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.add_pane(inserted.session, Placement::Float);
    let float = state
        .read()
        .layouts
        .get(inserted.session)
        .and_then(SessionLayout::focused);

    // When saving the layout.
    actor.save_layout(inserted.session);

    // Then the float's pane row is kept.
    let panes: Vec<PaneId> = actor
        .store
        .layouts()?
        .panes
        .into_iter()
        .map(|pane| pane.id)
        .collect();
    assert!(
        float.is_some_and(|float| panes.contains(&float)),
        "a float's pane should keep its row"
    );
    Ok(())
}

#[rstest::rstest]
fn closing_the_last_tiled_pane_with_floats_adds_a_shell_tab() -> Result<(), Report<StoreError>> {
    // Given an agent's session with a float whose only tiled pane closed.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.add_pane(inserted.session, Placement::Float);
    state.write().layouts.close_pane(inserted.pane);

    // When saving the layout.
    actor.save_layout(inserted.session);

    // Then the layout has one new tab, without the closed pane.
    let tabs = state.read().layouts.get(inserted.session).map(|layout| {
        (
            layout.tabs().len(),
            layout.tabs().iter().any(|tab| tab.holds(inserted.pane)),
        )
    });
    assert_eq!(
        tabs,
        Some((1, false)),
        "a session left with only floats should get a new shell tab"
    );
    Ok(())
}

#[rstest::rstest]
fn save_layout_writes_the_floats_mark() -> Result<(), Report<StoreError>> {
    // Given an agent's session with a float moved by hand.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    state.write().layouts.fit_to(Rect::new(0, 0, 80, 24));
    actor.add_pane(inserted.session, Placement::Float);
    state
        .write()
        .layouts
        .move_pane(inserted.session, NavDirection::Right);

    // When saving the layout.
    actor.save_layout(inserted.session);

    // Then the session row is marked.
    let marked = actor
        .store
        .layouts()?
        .sessions
        .iter()
        .any(|row| row.id == inserted.session && row.floats_hand_changed);
    assert!(marked, "saving should write the floats' mark");
    Ok(())
}

#[rstest::rstest]
fn save_layout_writes_the_float_layout() -> Result<(), Report<StoreError>> {
    // Given an agent's session with a float cycled to enlarged.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    state.write().layouts.fit_to(Rect::new(0, 0, 80, 24));
    actor.add_pane(inserted.session, Placement::Float);
    state
        .write()
        .layouts
        .cycle_float_layout(inserted.session, false);

    // When saving the layout.
    actor.save_layout(inserted.session);

    // Then the session row has the enlarged float layout.
    let layout = actor
        .store
        .layouts()?
        .sessions
        .iter()
        .find(|row| row.id == inserted.session)
        .map(|row| row.float_layout);
    assert_eq!(
        layout,
        Some(FloatLayout::Enlarged),
        "saving should write the float layout"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_brings_back_the_floats_mark() -> Result<(), Report<StoreError>> {
    // Given an agent's session saved with a float and the floats marked.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let float = store.insert_pane(inserted.session, Path::new(PROJECT_ROOT))?;
    let tab = TabRow {
        session_id: inserted.session,
        position: 0,
        name: None,
        layout: format!("{{\"pane\":{}}}", inserted.pane.0),
        focus_pane: Some(inserted.pane),
        swap_layout: SwapLayout::Vertical,
        hand_changed: false,
    };
    let row = FloatRow {
        session_id: inserted.session,
        position: 0,
        pane_id: float,
        rect: FloatRect {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.5,
        },
        pinned: false,
    };
    store.save_layout(
        inserted.session,
        0,
        &[tab],
        &SessionFloats {
            rows: vec![row],
            hand_changed: true,
            ..SessionFloats::default()
        },
        &[(inserted.pane, None), (float, None)],
    )?;
    let host = listing(Vec::new());

    // When restoring.
    let (_actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // Then the floats come back marked.
    let marked = state
        .read()
        .layouts
        .get(inserted.session)
        .is_some_and(|layout| layout.floats().hand_changed());
    assert!(marked, "restored floats should keep their mark");
    Ok(())
}

#[rstest::rstest]
fn restore_brings_back_the_float_layout() -> Result<(), Report<StoreError>> {
    // Given an agent's session saved with a float and the floats spread.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let float = store.insert_pane(inserted.session, Path::new(PROJECT_ROOT))?;
    let tab = TabRow {
        session_id: inserted.session,
        position: 0,
        name: None,
        layout: format!("{{\"pane\":{}}}", inserted.pane.0),
        focus_pane: Some(inserted.pane),
        swap_layout: SwapLayout::Vertical,
        hand_changed: false,
    };
    let row = FloatRow {
        session_id: inserted.session,
        position: 0,
        pane_id: float,
        rect: FloatRect {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.5,
        },
        pinned: false,
    };
    store.save_layout(
        inserted.session,
        0,
        &[tab],
        &SessionFloats {
            rows: vec![row],
            layout: FloatLayout::Spread,
            ..SessionFloats::default()
        },
        &[(inserted.pane, None), (float, None)],
    )?;
    let host = listing(Vec::new());

    // When restoring.
    let (_actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // Then the floats come back spread.
    let layout = state
        .read()
        .layouts
        .get(inserted.session)
        .map(|layout| layout.floats().layout());
    assert_eq!(
        layout,
        Some(FloatLayout::Spread),
        "restored floats should keep their layout"
    );
    Ok(())
}

#[rstest::rstest]
fn new_tab_saves_a_new_tab() -> Result<(), Report<StoreError>> {
    // Given an agent's one-pane session.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When opening a tab.
    actor.add_pane(inserted.session, Placement::Tab);

    // Then the store has two tabs, the second shown.
    let saved = actor.store.layouts()?;
    let active: Vec<usize> = saved.sessions.iter().map(|row| row.active_tab).collect();
    assert_eq!(
        (saved.tabs.len(), active),
        (2, vec![1]),
        "a new tab should be saved and shown"
    );
    Ok(())
}

/// An agent's session whose last pane closed and wasn't saved yet, so it
/// has no layout while the store still holds that one pane.
fn emptied_session() -> Result<(SessionsActor, State, Seeded), Report<StoreError>> {
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    state.write().layouts.close_pane(inserted.pane);
    Ok((actor, state, inserted))
}

#[rstest::rstest]
fn new_tab_on_a_session_without_a_layout_opens_one_shell_tab() -> Result<(), Report<StoreError>> {
    // Given a session whose last pane closed.
    let (mut actor, state, inserted) = emptied_session()?;

    // When opening a tab.
    actor.add_pane(inserted.session, Placement::Tab);

    // Then the session's layout holds one pane.
    assert_eq!(
        state.read().layouts.session_panes(inserted.session).len(),
        1,
        "an emptied session should get one shell"
    );
    Ok(())
}

#[rstest::rstest]
fn new_tab_on_a_session_without_a_layout_asks_to_attach_it() -> Result<(), Report<StoreError>> {
    // Given a session whose last pane closed.
    let (mut actor, _state, inserted) = emptied_session()?;

    // When opening a tab.
    actor.add_pane(inserted.session, Placement::Tab);

    // Then the frontend is asked to attach it.
    assert_eq!(
        ready_of(&actor),
        Some(inserted.session),
        "the new shell should be attached"
    );
    Ok(())
}

#[rstest::rstest]
fn split_on_a_session_without_a_layout_does_nothing() -> Result<(), Report<StoreError>> {
    // Given a session whose last pane closed.
    let (mut actor, state, inserted) = emptied_session()?;

    // When splitting its pane.
    actor.add_pane(inserted.session, Placement::Split(Split::Right));

    // Then it still has no layout and no pane is added to the store.
    assert_eq!(
        (
            state.read().layouts.get(inserted.session).is_none(),
            actor.store.layouts()?.panes.len()
        ),
        (true, 1),
        "there is no pane to split"
    );
    Ok(())
}

#[rstest::rstest]
fn tiled_add_pane_lays_the_tab_out_by_count() -> Result<(), Report<StoreError>> {
    // Given an agent's one-pane session.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When adding two tiled panes.
    actor.add_pane(inserted.session, Placement::Tile);
    actor.add_pane(inserted.session, Placement::Tile);

    // Then the shown tab holds one column then two, where two right
    // splits would make three columns.
    let columns: Vec<usize> = state
        .read()
        .layouts
        .get(inserted.session)
        .map(|layout| {
            layout
                .placed(ratatui::layout::Rect::new(0, 0, 80, 24), |_| 0)
                .panes
        })
        .unwrap_or_default()
        .chunk_by(|a, b| a.area.x == b.area.x)
        .map(<[_]>::len)
        .collect();
    assert_eq!(columns, vec![1, 2], "three panes should tile [1][2]");
    Ok(())
}

#[rstest::rstest]
fn tiled_add_pane_on_a_session_without_a_layout_does_nothing() -> Result<(), Report<StoreError>> {
    // Given a session whose last pane closed.
    let (mut actor, state, inserted) = emptied_session()?;

    // When adding a tiled pane.
    actor.add_pane(inserted.session, Placement::Tile);

    // Then it still has no layout and no pane is added to the store.
    assert_eq!(
        (
            state.read().layouts.get(inserted.session).is_none(),
            actor.store.layouts()?.panes.len()
        ),
        (true, 1),
        "there is no tab to add a pane to"
    );
    Ok(())
}

#[rstest::rstest]
fn save_layout_writes_the_sessions_tabs() -> Result<(), Report<StoreError>> {
    // Given an agent's session whose tab was renamed in the app state.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    state
        .write()
        .layouts
        .rename_tab(inserted.session, 0, Some("agent".into()));

    // When saving its layout.
    actor.save_layout(inserted.session);

    // Then the store has the name.
    let names: Vec<Option<String>> = actor
        .store
        .layouts()?
        .tabs
        .into_iter()
        .map(|tab| tab.name)
        .collect();
    assert_eq!(
        names,
        vec![Some("agent".to_owned())],
        "the tab's name should be saved"
    );
    Ok(())
}

#[rstest::rstest]
fn save_layout_writes_each_tabs_swap_layout_and_mark() -> Result<(), Report<StoreError>> {
    // Given an agent's one-pane session moved to horizontal, then split.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    state.write().layouts.next_swap_layout(inserted.session);
    actor.add_pane(inserted.session, Placement::Split(Split::Right));

    // When saving its layout.
    actor.save_layout(inserted.session);

    // Then the store has the tab horizontal and marked.
    let tabs: Vec<(SwapLayout, bool)> = actor
        .store
        .layouts()?
        .tabs
        .into_iter()
        .map(|tab| (tab.swap_layout, tab.hand_changed))
        .collect();
    assert_eq!(
        tabs,
        vec![(SwapLayout::Horizontal, true)],
        "the tab's swap layout and mark should be saved"
    );
    Ok(())
}

#[rstest::rstest]
fn agent_of_an_unknown_harness_shows_gone() -> Result<(), Report<StoreError>> {
    // Given a saved agent of a harness orb doesn't know.
    let store = Store::open_in_memory()?;
    let id = add_agent_in(&store, "gone-harness", "aa")?;
    let host = listing(Vec::new());

    // When restoring.
    let (_actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // Then it shows gone.
    assert_eq!(
        status_of(&state, id),
        Some(AgentStatus::Gone),
        "an agent of an unknown harness should be gone"
    );
    Ok(())
}

/// Claude's agent `aa` and the other harness's agent `bb`, both shown
/// idle by one poll, after which the other harness's list fails while
/// Claude lists `aa` working and polls again.
async fn poll_with_a_failed_list() -> Result<(State, AgentId, AgentId), Report<StoreError>> {
    let store = Store::open_in_memory()?;
    let claude_agent = add_agent_in(&store, "claude", "aa")?;
    let other_agent = add_agent_in(&store, OTHER, "bb")?;
    let claude = listing(vec![record("aa", AgentStatus::Idle)]);
    let other = Arc::new(FakeHarness::new(
        OTHER,
        vec![record("bb", AgentStatus::Idle)],
    ));
    let (mut actor, state) = start_beside(store, &claude, &other);
    actor.poll().await;
    other.set_running(Err("supervisor down".to_owned()));
    claude.set_running(Ok(vec![record("aa", AgentStatus::Working)]));
    actor.poll().await;
    Ok((state, claude_agent, other_agent))
}

#[rstest::rstest]
#[tokio::test]
async fn failed_list_keeps_its_agents_statuses() -> Result<(), Report<StoreError>> {
    // Given agents of two harnesses a poll showed idle.
    // When the other harness's list fails on the next poll.
    let (state, _, other_agent) = poll_with_a_failed_list().await?;

    // Then its agent keeps the status it had.
    assert_eq!(
        status_of(&state, other_agent),
        Some(AgentStatus::Idle),
        "a failed list should leave its harness's agents as they were"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn failed_list_of_one_harness_still_updates_the_others_agents()
-> Result<(), Report<StoreError>> {
    // Given agents of two harnesses a poll showed idle.
    // When the other harness's list fails while Claude lists its agent working.
    let (state, claude_agent, _) = poll_with_a_failed_list().await?;

    // Then Claude's agent shows working.
    assert_eq!(
        status_of(&state, claude_agent),
        Some(AgentStatus::Working),
        "one harness's failed list shouldn't hold back the others' agents"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_shows_each_harness_mark() -> Result<(), Report<StoreError>> {
    // Given Claude and the other harness.
    let claude = listing(Vec::new());
    let other = Arc::new(FakeHarness::new(OTHER, Vec::new()));

    // When restoring.
    let (_actor, state) = start_beside(Store::open_in_memory()?, &claude, &other);

    // Then each harness shows with its mark, in registration order.
    let marks: Vec<(HarnessId, Option<String>)> = state
        .read()
        .harnesses
        .iter()
        .map(|info| (info.id.clone(), info.icon.clone()))
        .collect();
    assert_eq!(
        marks,
        vec![
            (HarnessId::new("claude"), Some("✳".to_owned())),
            (HarnessId::new(OTHER), None),
        ],
        "restore should publish each harness's mark"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_without_integrations_shows_the_install_nudge() -> Result<(), Report<StoreError>> {
    // Given neither orb's Claude hook nor its pi extension is installed.
    let claude = listing(Vec::new());
    let other = Arc::new(FakeHarness::new(OTHER, Vec::new()));
    let state = State::default();
    let deps = SessionsActorDeps {
        integration_missing: true,
        ..deps_beside(Store::open_in_memory()?, &claude, &other, &state)
    };

    // When restoring.
    let actor = SessionsActor::restore(deps);

    // Then the mode line says how to install them.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some(crate::feat::integration::NUDGE),
        "a missing integration should show the install nudge"
    );
    Ok(())
}

/// The error the message box shows after what `actor` reported.
fn error_of(actor: &SessionsActor) -> Option<String> {
    actor.report.shown_error()
}

/// The last session `actor` reported ready to open.
fn ready_of(actor: &SessionsActor) -> Option<SessionId> {
    actor
        .report
        .outcomes()
        .into_iter()
        .filter_map(|outcome| match outcome {
            Outcome::Ready { session, .. } => Some(session),
            _ => None,
        })
        .next_back()
}

/// The notices for the message box `actor` reported, oldest first.
fn message_notices(actor: &SessionsActor) -> Vec<String> {
    actor
        .report
        .outcomes()
        .into_iter()
        .filter_map(|outcome| match outcome {
            Outcome::Notice(text) => Some(text),
            _ => None,
        })
        .collect()
}

/// The agent `id` as the sidebar shows it.
fn shown(state: &State, id: AgentId) -> Option<Agent> {
    state
        .read()
        .sessions
        .all_agents()
        .find(|agent| agent.id == id)
        .cloned()
}

fn status_of(state: &State, id: AgentId) -> Option<AgentStatus> {
    state
        .read()
        .sessions
        .all_agents()
        .find(|agent| agent.id == id)
        .map(|agent| agent.status)
}

fn stamp_of(state: &State, id: AgentId) -> Option<SystemTime> {
    state
        .read()
        .sessions
        .all_agents()
        .find(|agent| agent.id == id)
        .and_then(|agent| agent.turn_started_at)
}

/// The orb worktree the rename tests' agent is in, and its branch.
const HEX_WORKTREE: &str = "/nonexistent/worktrees/orb/orb-1a2b3c4d";
const HEX_BRANCH: &str = "orb/1a2b3c4d";
const PROMPT_LINE: &str = "{\"type\":\"user\",\"message\":{\"content\":\"Fix the parser\"}}\n";
const AI_TITLE_LINE: &str = "{\"type\":\"ai-title\",\"aiTitle\":\"Parser fix\"}\n";

/// A Claude directory holding `lines` as the transcript of conversation
/// `aa` in [`HEX_WORKTREE`], and a store whose agent `aa` is there on
/// `branch`.
fn worktree_agent(
    lines: &str,
    branch: &str,
) -> Result<(tempfile::TempDir, Store, AgentId), Report<StoreError>> {
    let claude_dir = tempfile::tempdir().change_context(StoreError)?;
    let path = transcript_path(claude_dir.path(), Path::new(HEX_WORKTREE), "aa");
    fs::create_dir_all(path.parent().unwrap_or(claude_dir.path())).change_context(StoreError)?;
    fs::write(&path, lines).change_context(StoreError)?;
    let (store, id) = store_with_agent("aa")?;
    resave(&store, "aa", |row| AgentRow {
        cwd: PathBuf::from(HEX_WORKTREE),
        branch: Some(branch.to_owned()),
        ..row
    })?;
    Ok((claude_dir, store, id))
}

/// The Claude in agent `aa`'s pane, `status`.
fn in_session(status: AgentStatus) -> RunningAgent {
    record("aa", status)
}

/// Polls once while agent `aa` works, then once after its turn ended.
async fn end_turn(actor: &mut SessionsActor, host: &FakeClaude) {
    host.set_running(Ok(vec![in_session(AgentStatus::Working)]));
    actor.poll().await;
    host.set_running(Ok(vec![in_session(AgentStatus::Idle)]));
    actor.poll().await;
}

#[rstest::rstest]
#[tokio::test]
async fn poll_shows_the_status_of_each_agents_record() -> Result<(), Report<StoreError>> {
    // Given a saved agent and a host reporting it waiting for an approval.
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::NeedsApproval)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When polling.
    actor.poll().await;

    // Then the agent shows that status.
    assert_eq!(
        status_of(&state, id),
        Some(AgentStatus::NeedsApproval),
        "the agent should show its record's status"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_marks_a_claude_agent_without_a_record_stopped() -> Result<(), Report<StoreError>> {
    // Given a saved agent the host doesn't list, its pane's zmx session gone.
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("bb", AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When polling.
    actor.poll().await;

    // Then the agent is stopped.
    assert_eq!(
        status_of(&state, id),
        Some(AgentStatus::Stopped),
        "an agent with nothing running should be stopped"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_stamps_a_turn_when_it_starts() -> Result<(), Report<StoreError>> {
    // Given an unstamped agent the host now reports busy.
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When polling.
    actor.poll().await;

    // Then the turn is stamped.
    assert!(
        stamp_of(&state, id).is_some(),
        "a turn seen running should be stamped"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_keeps_the_turn_stamp_while_the_turn_waits() -> Result<(), Report<StoreError>> {
    // Given an agent a poll saw running.
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.poll().await;
    let stamp = stamp_of(&state, id)
        .ok_or_else(|| Report::new(StoreError).attach("the busy poll didn't stamp the turn"))?;

    // When a poll sees it waiting for input.
    host.set_running(Ok(vec![record("aa", AgentStatus::NeedsInput)]));
    actor.poll().await;

    // Then the stamp is unchanged.
    assert_eq!(
        stamp_of(&state, id),
        Some(stamp),
        "waiting is part of the same turn"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_clears_the_turn_stamp_when_the_turn_ends() -> Result<(), Report<StoreError>> {
    // Given an agent a poll saw running.
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.poll().await;

    // When a poll sees it idle.
    host.set_running(Ok(vec![record("aa", AgentStatus::Idle)]));
    actor.poll().await;

    // Then the stamp is cleared.
    assert_eq!(
        stamp_of(&state, id),
        None,
        "an idle agent has no turn running"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_keeps_an_earlier_error() -> Result<(), Report<StoreError>> {
    // Given a failure on the mode line.
    let (store, _) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.report.report(Outcome::Failed(
        "A session is working in this directory".to_owned(),
    ));

    // When a poll succeeds.
    actor.poll().await;

    // Then the failure still shows.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("A session is working in this directory"),
        "a poll shouldn't hide an error the user hasn't seen"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_keeps_a_saved_turn_stamp() -> Result<(), Report<StoreError>> {
    // Given an agent saved mid-turn, stamped 1 s after the epoch, still busy.
    let (store, id) = store_with_agent("aa")?;
    let row = AgentRow {
        turn_started_at: Some(1_000),
        ..saved(&store, "aa")?
    };
    store.save_agent(&row)?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When polling after the relaunch.
    actor.poll().await;

    // Then the saved stamp is kept.
    assert_eq!(
        stamp_of(&state, id),
        Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1)),
        "a relaunch mid-turn should keep the saved stamp"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_saves_a_new_turn_stamp() -> Result<(), Report<StoreError>> {
    // Given an unstamped agent the host now reports busy.
    let (store, _) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When polling.
    actor.poll().await;

    // Then the stamp is saved.
    assert!(
        saved(&actor.store, "aa")?.turn_started_at.is_some(),
        "the stamp should survive a relaunch"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_waits_five_seconds_when_nothing_is_underway() -> Result<(), Report<StoreError>> {
    // Given an idle agent and orb detached.
    let (store, _) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When polling.
    let next = actor.poll().await;

    // Then the next poll is in 5 s.
    assert_eq!(next, SLOW_POLL, "nothing to watch closely");
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_waits_one_second_while_an_agent_is_busy() -> Result<(), Report<StoreError>> {
    // Given an agent the host reports busy.
    let (store, _) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When polling.
    let next = actor.poll().await;

    // Then the next poll is in 1 s.
    assert_eq!(next, FAST_POLL, "a running turn is watched closely");
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_waits_five_seconds_while_no_turn_is_underway() -> Result<(), Report<StoreError>> {
    // Given an idle agent and orb attached.
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    {
        let mut app = state.write();
        app.focus = Focus::Sidebar;
        let session = app
            .sessions
            .all_agents()
            .find(|agent| agent.id == id)
            .and_then(Agent::session);
        app.attached.extend(session);
    }

    // When polling.
    let next = actor.poll().await;

    // Then the next poll is in 5 s.
    assert_eq!(
        next, SLOW_POLL,
        "being attached alone isn't watched closely"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn failed_poll_keeps_the_last_statuses() -> Result<(), Report<StoreError>> {
    // Given an agent a poll saw idle.
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.poll().await;

    // When the next poll fails.
    host.set_running(Err("claude: command not found".to_owned()));
    actor.poll().await;

    // Then the agent still shows idle.
    assert_eq!(
        status_of(&state, id),
        Some(AgentStatus::Idle),
        "a failed poll shouldn't change statuses"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn failed_poll_shows_the_reason() -> Result<(), Report<StoreError>> {
    // Given a host that can't list sessions.
    let (store, _) = store_with_agent("aa")?;
    let host = listing(Vec::new());
    host.set_running(Err("claude: command not found".to_owned()));
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When polling.
    actor.poll().await;

    // Then the reason is the error.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("claude: command not found"),
        "the mode line should show why the poll failed"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_doesnt_ask_claude_while_no_pane_holds_a_claude_agent()
-> Result<(), Report<StoreError>> {
    // Given a Claude agent whose program has ended, so no pane holds it.
    let store = Store::open_in_memory()?;
    insert_agent(&store, "aa")?;
    resave(&store, "aa", |row| AgentRow {
        pane_id: None,
        ..row
    })?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When polling.
    actor.poll().await;

    // Then claude is never asked what it runs.
    assert_eq!(
        host.lists(),
        0,
        "no pane holds a Claude agent, so the poll shouldn't ask claude"
    );
    Ok(())
}

/// The fetches and worktree adds git saw, in order.
fn fetch_and_add_steps(git: &FakeGit) -> Vec<String> {
    git.calls()
        .into_iter()
        .filter_map(|call| match call {
            GitCall::Fetch(branch) => Some(format!("fetch {branch}")),
            GitCall::AddWorktree { base, .. } => Some(format!("add from {base}")),
            _ => None,
        })
        .collect()
}

/// The actor on a store holding the orb project alone, with `git`, after
/// making a session of it in `workspace`.
fn made_session(
    git: &Arc<FakeGit>,
    workspace: Workspace,
) -> Result<(SessionsActor, State), Report<StoreError>> {
    made_named_session(git, workspace, None)
}

/// The actor on a store holding the orb project alone, with `git`, after
/// making a session of it named `name` in `workspace`.
fn made_named_session(
    git: &Arc<FakeGit>,
    workspace: Workspace,
    name: Option<&str>,
) -> Result<(SessionsActor, State), Report<StoreError>> {
    let (store, id) = store_with_project()?;
    let (mut actor, state) = start_with(store, &listing(Vec::new()), git, Path::new(NO_CLAUDE_DIR));
    let job = actor.new_session(id, workspace, name.map(str::to_owned), None);
    finish(&mut actor, job);
    Ok((actor, state))
}

#[rstest::rstest]
fn new_session_reports_the_session_active_when_asked() -> Result<(), Report<StoreError>> {
    // Given the orb project, with session 7 active when the user asked.
    let (store, project) = store_with_project()?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    let asked = Some(SessionId(7));

    // When making a session of it in its checkout.
    let job = actor.new_session(project, Workspace::Checkout, None, asked);
    finish(&mut actor, job);

    // Then the new session is ready to open while session 7 is active.
    let session = only_session(&state)?.id;
    assert!(
        actor.report.outcomes().contains(&Outcome::Ready {
            session,
            if_active: asked,
        }),
        "the new session should open only while the asking session is active"
    );
    Ok(())
}

#[rstest::rstest]
fn named_new_session_shows_the_name_as_its_title() -> Result<(), Report<StoreError>> {
    // Given / When making a session named `api` in the checkout.
    let (_actor, state) = made_named_session(&FakeGit::local(), Workspace::Checkout, Some("api"))?;

    // Then its title is the name.
    let app = state.read();
    let titles: Vec<String> = app
        .sessions
        .sessions
        .iter()
        .map(|session| app.sessions.title(session))
        .collect();
    assert_eq!(titles, ["api"], "the New session name is the title");
    Ok(())
}

#[rstest::rstest]
fn named_new_session_saves_the_name() -> Result<(), Report<StoreError>> {
    // Given / When making a session named `api` in the checkout.
    let (actor, state) = made_named_session(&FakeGit::local(), Workspace::Checkout, Some("api"))?;

    // Then the store returns the name.
    let id = state
        .read()
        .sessions
        .sessions
        .first()
        .map(|session| session.id);
    assert_eq!(
        id.and_then(|id| saved_session_row(&actor.store, id))
            .and_then(|row| row.name),
        Some("api".to_owned()),
        "the New session name should be saved"
    );
    Ok(())
}

/// The sessions the sidebar has, in store order.
fn sessions_of(state: &State) -> Vec<Session> {
    state.read().sessions.sessions.clone()
}

/// The only session the sidebar has.
fn only_session(state: &State) -> Result<Session, Report<StoreError>> {
    match sessions_of(state).as_slice() {
        [session] => Ok(session.clone()),
        other => Err(Report::new(StoreError).attach(format!("{} sessions", other.len()))),
    }
}

#[rstest::rstest]
fn new_session_in_the_checkout_runs_in_the_project_root() -> Result<(), Report<StoreError>> {
    // Given / When making a session of the orb project in its checkout.
    let (_actor, state) = made_session(&FakeGit::local(), Workspace::Checkout)?;

    // Then it runs in the project's root.
    assert_eq!(
        only_session(&state)?.dir,
        PathBuf::from(PROJECT_ROOT),
        "a checkout session runs in the root"
    );
    Ok(())
}

#[rstest::rstest]
fn new_session_has_one_tab_with_one_pane() -> Result<(), Report<StoreError>> {
    // Given / When making a session of the orb project in its checkout.
    let (_actor, state) = made_session(&FakeGit::local(), Workspace::Checkout)?;

    // Then its layout holds one tab of one pane in the root.
    let id = only_session(&state)?.id;
    let app = state.read();
    let shape = app.layouts.get(id).map(|layout| {
        (
            layout.tabs().len(),
            layout
                .panes()
                .map(|pane| pane.cwd.clone())
                .collect::<Vec<_>>(),
        )
    });
    assert_eq!(
        shape,
        Some((1, vec![PathBuf::from(PROJECT_ROOT)])),
        "a new session holds one tab of one shell pane"
    );
    Ok(())
}

#[rstest::rstest]
fn new_session_saves_its_first_tab_as_base() -> Result<(), Report<StoreError>> {
    // Given / When making a session of the orb project in its checkout.
    let (actor, state) = made_session(&FakeGit::local(), Workspace::Checkout)?;

    // Then its saved first tab has the BASE swap layout, as in memory.
    let id = only_session(&state)?.id;
    let saved: Vec<SwapLayout> = actor
        .store
        .layouts()?
        .tabs
        .into_iter()
        .filter(|tab| tab.session_id == id)
        .map(|tab| tab.swap_layout)
        .collect();
    let shown: Vec<SwapLayout> = state
        .read()
        .layouts
        .get(id)
        .map(|layout| layout.tabs().iter().map(Tab::swap_layout).collect())
        .unwrap_or_default();
    assert_eq!(
        (saved, shown),
        (vec![SwapLayout::Base], vec![SwapLayout::Base]),
        "a new session's first tab should be saved with the swap layout it has in memory"
    );
    Ok(())
}

#[rstest::rstest]
fn new_session_whose_first_tab_wont_save_shows_the_save_error() -> Result<(), Report<StoreError>> {
    // Given a store holding the orb project that refuses to save any tab.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    let store = Store::open(&path)?;
    let id = orb_project(&store)?;
    rusqlite::Connection::open(&path)
        .and_then(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER refuse BEFORE INSERT ON tabs
                     BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
        })
        .change_context(StoreError)?;
    let (mut actor, _state) = start_with(
        store,
        &listing(Vec::new()),
        &FakeGit::local(),
        Path::new(NO_CLAUDE_DIR),
    );

    // When making a session of it in its checkout.
    let job = actor.new_session(id, Workspace::Checkout, None, None);
    finish(&mut actor, job);

    // Then the message box says orb couldn't save its state.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some(SAVE_FAILED),
        "a new session whose first tab wasn't saved should say so"
    );
    Ok(())
}

#[rstest::rstest]
fn new_session_pane_runs_in_orbs_own_zmx_session() -> Result<(), Report<StoreError>> {
    // Given / When making a session of the orb project in its checkout.
    let (_actor, state) = made_session(&FakeGit::local(), Workspace::Checkout)?;

    // Then its pane runs in `orb-p<id>` on orb's pane socket dir.
    let id = only_session(&state)?.id;
    let app = state.read();
    let runs: Vec<(String, ZmxSession)> = app
        .layouts
        .get(id)
        .map(|layout| {
            layout
                .panes()
                .map(|pane| (pane.id.zmx_name(), pane.zmx.clone()))
                .collect()
        })
        .unwrap_or_default();
    let expected: Vec<(String, ZmxSession)> = runs
        .iter()
        .map(|(name, _)| {
            (
                name.clone(),
                ZmxSession {
                    name: name.clone(),
                    dir: PathBuf::from("/zmx"),
                },
            )
        })
        .collect();
    assert_eq!(
        (runs.len(), &runs),
        (1, &expected),
        "a new pane runs in orb's own zmx session"
    );
    Ok(())
}

#[rstest::rstest]
fn new_session_is_selected() -> Result<(), Report<StoreError>> {
    // Given / When making a session of the orb project.
    let (_actor, state) = made_session(&FakeGit::local(), Workspace::Checkout)?;

    // Then the cursor is on it.
    let id = only_session(&state)?.id;
    assert_eq!(
        state.read().sessions.cursor,
        Some(SidebarItem::Session(id)),
        "a new session is selected"
    );
    Ok(())
}

#[rstest::rstest]
fn new_session_asks_the_frontend_to_attach() -> Result<(), Report<StoreError>> {
    // Given / When making a session of the orb project.
    let (actor, state) = made_session(&FakeGit::local(), Workspace::Checkout)?;

    // Then the frontend is asked to attach it.
    let id = only_session(&state)?.id;
    assert_eq!(ready_of(&actor), Some(id), "a new session is attached");
    Ok(())
}

#[rstest::rstest]
fn new_session_ends_the_start() -> Result<(), Report<StoreError>> {
    // Given a start in flight.
    let (store, id) = store_with_project()?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    state.write().sessions.starting = true;

    // When making a session.
    let job = actor.new_session(id, Workspace::Checkout, None, None);
    finish(&mut actor, job);

    // Then nothing is starting any more.
    assert!(
        !state.read().sessions.starting,
        "a made session ends the start"
    );
    Ok(())
}

#[rstest::rstest]
fn new_session_in_a_new_worktree_runs_in_the_worktree_orb_made() -> Result<(), Report<StoreError>> {
    // Given / When making a session in a new worktree from `main`.
    let git = FakeGit::local();
    let (_actor, state) = made_session(
        &git,
        Workspace::NewWorktree {
            base: "main".to_owned(),
        },
    )?;

    // Then it runs in the worktree orb added, on its branch.
    let session = only_session(&state)?;
    assert_eq!(
        Some((session.dir, session.branch.unwrap_or_default())),
        git.added(),
        "the session runs in the new worktree"
    );
    Ok(())
}

/// The branch of the only session after making one named `name` in a
/// new worktree from `main` with `git`, and the `orb/<hex>` branch of
/// its directory.
fn named_worktree_branch(
    git: &Arc<FakeGit>,
    name: Option<&str>,
) -> Result<(Option<String>, Option<String>), Report<StoreError>> {
    let (actor, state) = made_named_session(
        git,
        Workspace::NewWorktree {
            base: "main".to_owned(),
        },
        name,
    )?;
    let session = only_session(&state)?;
    let hex = super::hex_branch(&actor.worktrees_root, &session.dir);
    Ok((session.branch, hex))
}

#[rstest::rstest]
fn named_new_session_worktree_is_on_the_name_slug_branch() -> Result<(), Report<StoreError>> {
    // Given / When making a session named `Fix Login!` in a new worktree.
    let (branch, _) = named_worktree_branch(&FakeGit::local(), Some("Fix Login!"))?;

    // Then it is on `orb/fix-login`.
    assert_eq!(
        branch.as_deref(),
        Some("orb/fix-login"),
        "a named session's worktree branch is its name's slug"
    );
    Ok(())
}

#[rstest::rstest]
fn named_new_session_worktree_is_on_a_hex_branch_when_the_slug_branch_exists()
-> Result<(), Report<StoreError>> {
    // Given `orb/fix-login` already exists.
    let git = FakeGit::having("orb/fix-login");

    // When making a session named `Fix Login!` in a new worktree.
    let (branch, hex) = named_worktree_branch(&git, Some("Fix Login!"))?;

    // Then it is on its directory's `orb/<hex>` branch.
    assert!(
        branch.is_some() && branch == hex,
        "an existing slug branch falls back to orb/<hex>, got {branch:?} vs {hex:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn unnamed_new_session_worktree_is_on_a_hex_branch() -> Result<(), Report<StoreError>> {
    // Given / When making an unnamed session in a new worktree.
    let (branch, hex) = named_worktree_branch(&FakeGit::local(), None)?;

    // Then it is on its directory's `orb/<hex>` branch.
    assert!(
        branch.is_some() && branch == hex,
        "an unnamed session's worktree is on orb/<hex>, got {branch:?} vs {hex:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn new_session_in_a_new_worktree_starts_from_its_base() -> Result<(), Report<StoreError>> {
    // Given / When making a session in a new worktree from `feat`, which
    // origin has.
    let git = FakeGit::with_origin(Ok(true));
    made_session(
        &git,
        Workspace::NewWorktree {
            base: "feat".to_owned(),
        },
    )?;

    // Then `feat` is fetched and the worktree starts from origin's.
    assert_eq!(
        fetch_and_add_steps(&git),
        ["fetch feat", "add from origin/feat"],
        "a new worktree starts from its base as origin has it"
    );
    Ok(())
}

#[rstest::rstest]
fn new_worktree_whose_fetch_fails_makes_no_session() -> Result<(), Report<StoreError>> {
    // Given / When making a session in a new worktree whose fetch fails.
    let git = FakeGit::with_origin(Err("fatal: unable to access origin"));
    let (_actor, state) = made_session(
        &git,
        Workspace::NewWorktree {
            base: "main".to_owned(),
        },
    )?;

    // Then no session is made.
    assert!(
        sessions_of(&state).is_empty(),
        "a failed fetch makes nothing"
    );
    Ok(())
}

#[rstest::rstest]
fn new_worktree_whose_fetch_fails_shows_the_reason() -> Result<(), Report<StoreError>> {
    // Given / When making a session in a new worktree whose fetch fails.
    let git = FakeGit::with_origin(Err("fatal: unable to access origin"));
    let (actor, _state) = made_session(
        &git,
        Workspace::NewWorktree {
            base: "main".to_owned(),
        },
    )?;

    // Then git's reason shows.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("fatal: unable to access origin"),
        "a failed fetch shows why"
    );
    Ok(())
}

#[rstest::rstest]
fn failed_save_removes_the_new_worktree_and_branch() -> Result<(), Report<StoreError>> {
    // Given a project the sidebar shows but the store doesn't have.
    let git = FakeGit::local();
    let (mut actor, state) = start_with(
        Store::open_in_memory()?,
        &listing(Vec::new()),
        &git,
        Path::new(NO_CLAUDE_DIR),
    );
    state.write().sessions.projects.push(Project {
        id: ProjectId(99),
        title: "ghost".into(),
        root: PROJECT_ROOT.into(),
        created_at: SystemTime::UNIX_EPOCH,
        agents: vec![],
        repo: true,
        removed: false,
        kind: ProjectKind::Normal,
    });

    // When making a session of it in a new worktree.
    let job = actor.new_session(
        ProjectId(99),
        Workspace::NewWorktree {
            base: "main".to_owned(),
        },
        None,
        None,
    );
    finish(&mut actor, job);

    // Then the worktree and branch orb made are force-removed.
    let (path, branch) = git
        .added()
        .ok_or_else(|| Report::new(StoreError).attach("no worktree was added"))?;
    let calls = git.calls();
    assert!(
        calls.contains(&GitCall::RemoveWorktree { path, force: true })
            && calls.contains(&GitCall::DeleteBranch {
                branch,
                force: true
            }),
        "an unsaved session leaves no worktree or branch, got {calls:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn new_session_in_a_missing_checkout_fails_with_its_path() -> Result<(), Report<StoreError>> {
    // Given a project whose root is gone.
    let store = Store::open_in_memory()?;
    let id = store.add_project(
        Path::new("/nonexistent/gone"),
        "gone",
        ProjectKind::Normal,
        0,
    )?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // When making a session in its checkout.
    let job = actor.new_session(id, Workspace::Checkout, None, None);
    finish(&mut actor, job);

    // Then the mode line names the missing folder.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("project folder no longer exists: /nonexistent/gone"),
        "a missing checkout shows its path"
    );
    Ok(())
}

#[rstest::rstest]
fn new_incognito_session_makes_its_folder() -> Result<(), Report<StoreError>> {
    // Given orb's Incognito folder gone after the actor started.
    let tmp = tempfile::tempdir().change_context(StoreError)?;
    let incognito = tmp.path().join("orb-incognito");
    let (mut actor, state) = start_in(
        Store::open_in_memory()?,
        &listing(Vec::new()),
        &FakeGit::local(),
        Path::new(NO_CLAUDE_DIR),
        Path::new(ORB_ROOT),
        &incognito,
    );
    fs::remove_dir_all(&incognito).change_context(StoreError)?;
    let id = state
        .read()
        .sessions
        .own_project(ProjectKind::Incognito)
        .map(|project| project.id)
        .ok_or_else(|| Report::new(StoreError).attach("no Incognito project"))?;

    // When making an Incognito session.
    let job = actor.new_session(id, Workspace::Checkout, None, None);
    finish(&mut actor, job);

    // Then its folder is back and the session runs there.
    assert_eq!(
        (incognito.is_dir(), only_session(&state)?.dir),
        (true, incognito.clone()),
        "an Incognito session makes its folder first"
    );
    Ok(())
}

#[rstest::rstest]
fn new_session_in_the_checkout_is_on_its_checked_out_branch() -> Result<(), Report<StoreError>> {
    // Given / When making a session of the orb project in its checkout.
    let (_actor, state) = made_session(&FakeGit::local(), Workspace::Checkout)?;

    // Then it shows the branch checked out there.
    assert_eq!(
        only_session(&state)?.branch.as_deref(),
        Some(CURRENT_BRANCH),
        "a checkout session is on the checkout's branch"
    );
    Ok(())
}

#[rstest::rstest]
fn new_session_in_a_missing_worktree_fails_with_its_path() -> Result<(), Report<StoreError>> {
    // Given / When making a session in a worktree that is gone.
    let (actor, _state) = made_session(
        &FakeGit::local(),
        Workspace::Existing(PathBuf::from("/nonexistent/worktree")),
    )?;

    // Then the mode line names the missing worktree.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("worktree no longer exists: /nonexistent/worktree"),
        "a missing worktree shows its path"
    );
    Ok(())
}

#[rstest::rstest]
fn new_session_in_a_new_worktree_without_origin_starts_from_the_local_base()
-> Result<(), Report<StoreError>> {
    // Given / When making a session in a new worktree from `feat` in a
    // repository without an origin.
    let git = FakeGit::local();
    made_session(
        &git,
        Workspace::NewWorktree {
            base: "feat".to_owned(),
        },
    )?;

    // Then nothing is fetched and the worktree starts from local `feat`.
    assert_eq!(
        fetch_and_add_steps(&git),
        ["add from feat"],
        "without an origin the base is used as it is locally"
    );
    Ok(())
}

#[rstest::rstest]
fn new_session_from_another_remotes_ref_uses_it_as_it_is() -> Result<(), Report<StoreError>> {
    // Given / When making a session in a new worktree from `upstream/x`.
    let git = FakeGit::with_origin(Ok(true));
    made_session(
        &git,
        Workspace::NewWorktree {
            base: "upstream/x".to_owned(),
        },
    )?;

    // Then origin isn't asked and the worktree starts from `upstream/x`.
    assert_eq!(
        fetch_and_add_steps(&git),
        ["add from upstream/x"],
        "another remote's ref is used as it is"
    );
    Ok(())
}

#[rstest::rstest]
fn new_worktree_session_shows_the_fetch_while_it_runs() -> Result<(), Report<StoreError>> {
    // Given an origin, and git watching the app state.
    let (store, id) = store_with_project()?;
    let git = FakeGit::with_origin(Ok(true));
    let (mut actor, state) =
        start_with(store, &listing(Vec::new()), &git, Path::new(NO_CLAUDE_DIR));
    git.watch(&state);

    // When making a session in a new worktree from `main`.
    let job = actor.new_session(
        id,
        Workspace::NewWorktree {
            base: "main".to_owned(),
        },
        None,
        None,
    );
    finish(&mut actor, job);

    // Then, while git fetched, origin/main showed as being fetched.
    assert_eq!(
        git.fetching_seen(),
        vec![Some("origin/main".to_owned())],
        "the fetch shows while it runs"
    );
    Ok(())
}

#[rstest::rstest]
fn new_worktree_whose_fetch_fails_clears_the_fetch() -> Result<(), Report<StoreError>> {
    // Given / When making a session in a new worktree whose fetch fails.
    let (_actor, state) = made_session(
        &FakeGit::with_origin(Err("fatal: unable to access origin")),
        Workspace::NewWorktree {
            base: "main".to_owned(),
        },
    )?;

    // Then no fetch shows any more.
    assert_eq!(
        state.read().sessions.fetching,
        None,
        "a failed fetch stops showing"
    );
    Ok(())
}

#[rstest::rstest]
fn failed_save_in_an_existing_worktree_removes_no_worktree() -> Result<(), Report<StoreError>> {
    // Given a project the sidebar shows but the store doesn't have, and a
    // worktree that already exists.
    let worktree = tempfile::tempdir().change_context(StoreError)?;
    let git = FakeGit::local();
    let (mut actor, state) = start_with(
        Store::open_in_memory()?,
        &listing(Vec::new()),
        &git,
        Path::new(NO_CLAUDE_DIR),
    );
    state.write().sessions.projects.push(Project {
        id: ProjectId(99),
        title: "ghost".into(),
        root: PROJECT_ROOT.into(),
        created_at: SystemTime::UNIX_EPOCH,
        agents: vec![],
        repo: true,
        removed: false,
        kind: ProjectKind::Normal,
    });

    // When making a session of it in that worktree.
    let job = actor.new_session(
        ProjectId(99),
        Workspace::Existing(worktree.path().to_owned()),
        None,
        None,
    );
    finish(&mut actor, job);

    // Then git is asked to remove no worktree and delete no branch.
    let calls = git.calls();
    assert!(
        !calls.iter().any(|call| matches!(
            call,
            GitCall::RemoveWorktree { .. } | GitCall::DeleteBranch { .. }
        )),
        "a worktree orb didn't make stays, got {calls:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn new_incognito_session_whose_folder_cant_be_made_shows_why() -> Result<(), Report<StoreError>> {
    // Given orb's Incognito folder under a regular file.
    let tmp = tempfile::tempdir().change_context(StoreError)?;
    let file = tmp.path().join("file");
    fs::write(&file, "").change_context(StoreError)?;
    let (mut actor, state) = start_in(
        Store::open_in_memory()?,
        &listing(Vec::new()),
        &FakeGit::local(),
        Path::new(NO_CLAUDE_DIR),
        Path::new(ORB_ROOT),
        &file.join("orb-incognito"),
    );
    let id = state
        .read()
        .sessions
        .own_project(ProjectKind::Incognito)
        .map(|project| project.id)
        .ok_or_else(|| Report::new(StoreError).attach("no Incognito project"))?;

    // When making an Incognito session.
    let job = actor.new_session(id, Workspace::Checkout, None, None);
    finish(&mut actor, job);

    // Then the mode line says the folder couldn't be made.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("couldn't make the folder"),
        "an Incognito session needs its folder"
    );
    Ok(())
}

/// A store holding the orb project alone.
fn store_with_project() -> Result<(Store, ProjectId), Report<StoreError>> {
    let store = Store::open_in_memory()?;
    let id = orb_project(&store)?;
    Ok((store, id))
}

/// Runs `job`, if any, here and hands its result to `actor`, as if it
/// had arrived through the mailbox.
fn finish(actor: &mut SessionsActor, job: Option<WorktreeJob>) {
    if let Some(WorktreeJob { start, work }) = job {
        let made = work.run();
        actor.worktree_ready(WorktreeReady { start, made });
    }
}

/// Makes colony `name` in `world`, running a fresh colony's copy here and
/// handing its folder to `actor` as if it had arrived through the mailbox.
fn make_colony(actor: &mut SessionsActor, world: ProjectId, name: &str) {
    let job = actor.new_colony(world, name, None);
    finish_colony(actor, job);
}

/// Runs `job`, if any, here and hands its folder to `actor`, as if it had
/// arrived through the mailbox; runs any removal it hands back.
fn finish_colony(actor: &mut SessionsActor, job: Option<ColonyJob>) {
    if let Some(ColonyJob {
        world,
        if_active,
        copy,
    }) = job
    {
        let made = copy.run();
        let ready = ColonyFolderReady {
            world,
            if_active,
            made,
        };
        actor
            .colony_folder_ready(ready)
            .into_iter()
            .for_each(RemoveFolder::run);
    }
}

/// Deletes session `id`, running the folder removal it hands back here.
fn delete(actor: &mut SessionsActor, id: SessionId) {
    actor
        .delete_session(id)
        .into_iter()
        .for_each(RemoveFolder::run);
}

/// Deletes session `id` with its colonists, running the folder removals
/// they hand back here.
fn delete_all(actor: &mut SessionsActor, id: SessionId) {
    actor
        .delete_with_colonists(id)
        .into_iter()
        .for_each(RemoveFolder::run);
}

/// Whether git was asked to force-remove the worktree it added, and its
/// branch.
fn made_worktree_removed(git: &FakeGit) -> Result<bool, Report<StoreError>> {
    let (path, branch) = git
        .added()
        .ok_or_else(|| Report::new(StoreError).attach("no worktree was added"))?;
    let calls = git.calls();
    Ok(
        calls.contains(&GitCall::RemoveWorktree { path, force: true })
            && calls.contains(&GitCall::DeleteBranch {
                branch,
                force: true,
            }),
    )
}

/// A new worktree from `main`.
fn new_worktree() -> Workspace {
    Workspace::NewWorktree {
        base: "main".to_owned(),
    }
}

#[rstest::rstest]
fn starting_stays_on_while_the_worktree_is_made() -> Result<(), Report<StoreError>> {
    // Given a start of the orb project marked as starting.
    let (store, id) = store_with_project()?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    state.write().sessions.starting = true;

    // When asking for a session in a new worktree, its job not yet run.
    let _job = actor.new_session(id, new_worktree(), None, None);

    // Then it still shows as starting.
    assert!(
        state.read().sessions.starting,
        "a start stays on while its worktree is being made"
    );
    Ok(())
}

#[rstest::rstest]
fn starting_ends_once_the_worktree_result_is_applied() -> Result<(), Report<StoreError>> {
    // Given a start of the orb project in a new worktree, marked as
    // starting.
    let (store, id) = store_with_project()?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    state.write().sessions.starting = true;
    let job = actor.new_session(id, new_worktree(), None, None);

    // When its worktree is made and the result applied.
    finish(&mut actor, job);

    // Then nothing is starting any more.
    assert!(
        !state.read().sessions.starting,
        "a start ends once its worktree result is applied"
    );
    Ok(())
}

#[rstest::rstest]
fn start_whose_project_was_removed_meanwhile_removes_its_worktree() -> Result<(), Report<StoreError>>
{
    // Given a start of the orb project in a new worktree, and the
    // project removed while the worktree is made.
    let (store, id) = store_with_project()?;
    let git = FakeGit::local();
    let (mut actor, _state) =
        start_with(store, &listing(Vec::new()), &git, Path::new(NO_CLAUDE_DIR));
    let job = actor.new_session(id, new_worktree(), None, None);
    actor.remove_project(id);

    // When the worktree result is applied.
    finish(&mut actor, job);

    // Then the worktree and branch orb made are force-removed.
    assert!(
        made_worktree_removed(&git)?,
        "a start whose project is gone leaves no worktree, got {:?}",
        git.calls()
    );
    Ok(())
}

#[rstest::rstest]
fn start_whose_project_was_removed_meanwhile_shows_the_project_is_gone()
-> Result<(), Report<StoreError>> {
    // Given a start of the orb project in a new worktree, and the
    // project removed while the worktree is made.
    let (store, id) = store_with_project()?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    let job = actor.new_session(id, new_worktree(), None, None);
    actor.remove_project(id);

    // When the worktree result is applied.
    finish(&mut actor, job);

    // Then the start says the project is gone.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("the project is gone"),
        "a start whose project was removed says so"
    );
    Ok(())
}

/// Whether project `id` shows as a git repository.
fn repo_of(state: &State, id: ProjectId) -> Option<bool> {
    state
        .read()
        .sessions
        .project(id)
        .map(|project| project.repo)
}

#[rstest::rstest]
fn restore_marks_a_project_outside_git_not_a_repo() -> Result<(), Report<StoreError>> {
    // Given a saved project whose root isn't a git repository.
    let (store, id) = store_with_project()?;

    // When the actor starts.
    let (_actor, state) = start_with(
        store,
        &listing(Vec::new()),
        &FakeGit::plain(Ok(())),
        Path::new(NO_CLAUDE_DIR),
    );

    // Then the project shows as outside git.
    assert_eq!(
        repo_of(&state, id),
        Some(false),
        "a restored project should learn it isn't a repository"
    );
    Ok(())
}

#[rstest::rstest]
fn init_git_runs_git_init_in_the_root() -> Result<(), Report<StoreError>> {
    // Given a project that isn't a git repository.
    let (store, id) = store_with_project()?;
    let git = FakeGit::plain(Ok(()));
    let (mut actor, _state) =
        start_with(store, &listing(Vec::new()), &git, Path::new(NO_CLAUDE_DIR));

    // When initializing git for it.
    actor.init_git(id);

    // Then git init ran in the project's root.
    assert_eq!(
        git.calls(),
        vec![GitCall::Init(PathBuf::from(PROJECT_ROOT))],
        "git init should run in the root"
    );
    Ok(())
}

#[rstest::rstest]
fn init_git_marks_the_project_a_repo() -> Result<(), Report<StoreError>> {
    // Given a project that isn't a git repository.
    let (store, id) = store_with_project()?;
    let (mut actor, state) = start_with(
        store,
        &listing(Vec::new()),
        &FakeGit::plain(Ok(())),
        Path::new(NO_CLAUDE_DIR),
    );

    // When initializing git for it.
    actor.init_git(id);

    // Then the project shows as a git repository.
    assert_eq!(
        repo_of(&state, id),
        Some(true),
        "an initialized project should be a repository"
    );
    Ok(())
}

#[rstest::rstest]
fn failed_git_init_shows_why() -> Result<(), Report<StoreError>> {
    // Given a non-git project where git init fails.
    let (store, id) = store_with_project()?;
    let (mut actor, _state) = start_with(
        store,
        &listing(Vec::new()),
        &FakeGit::plain(Err("fatal: cannot mkdir .git: Permission denied")),
        Path::new(NO_CLAUDE_DIR),
    );

    // When initializing git for it.
    actor.init_git(id);

    // Then the mode line says why.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("Git initialization failed: fatal: cannot mkdir .git: Permission denied"),
        "a failed git init should show git's reason"
    );
    Ok(())
}

#[rstest::rstest]
fn adding_a_directory_shows_it_as_a_project() -> Result<(), Report<StoreError>> {
    // Given no projects and an existing directory.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let (mut actor, state) = start(
        Store::open_in_memory()?,
        &listing(Vec::new()),
        Path::new(NO_CLAUDE_DIR),
    );

    // When adding it as a project.
    actor.add_project(dir.path().to_owned());

    // Then it's the one project shown.
    let roots: Vec<PathBuf> = state
        .read()
        .sessions
        .projects
        .iter()
        .filter(|project| project.kind == ProjectKind::Normal)
        .map(|project| project.root.clone())
        .collect();
    assert_eq!(
        roots,
        vec![dir.path().to_owned()],
        "the added directory should show as a project"
    );
    Ok(())
}

#[rstest::rstest]
fn adding_an_existing_project_shows_it_once() -> Result<(), Report<StoreError>> {
    // Given a directory that's already a saved project.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let store = Store::open_in_memory()?;
    store.add_project(dir.path(), "web", ProjectKind::Normal, 0)?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // When adding it again.
    actor.add_project(dir.path().to_owned());

    // Then it's shown once.
    let shown = state
        .read()
        .sessions
        .projects
        .iter()
        .filter(|project| project.root == dir.path())
        .count();
    assert_eq!(shown, 1, "an existing project shouldn't be shown twice");
    Ok(())
}

#[rstest::rstest]
fn adding_a_missing_directory_shows_an_error() -> Result<(), Report<StoreError>> {
    // Given no projects.
    let (mut actor, _state) = start(
        Store::open_in_memory()?,
        &listing(Vec::new()),
        Path::new(NO_CLAUDE_DIR),
    );

    // When adding a path that doesn't exist.
    actor.add_project(PathBuf::from("/nonexistent/project"));

    // Then the error names it.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("not a directory: /nonexistent/project"),
        "the mode line should say the path isn't a directory"
    );
    Ok(())
}

#[rstest::rstest]
fn adding_a_missing_directory_saves_nothing() -> Result<(), Report<StoreError>> {
    // Given no projects.
    let (mut actor, _state) = start(
        Store::open_in_memory()?,
        &listing(Vec::new()),
        Path::new(NO_CLAUDE_DIR),
    );

    // When adding a path that doesn't exist.
    actor.add_project(PathBuf::from("/nonexistent/project"));

    // Then no project is saved.
    assert!(
        !actor
            .store
            .load()?
            .0
            .iter()
            .any(|project| project.root == Path::new("/nonexistent/project")),
        "a missing directory shouldn't be saved"
    );
    Ok(())
}

#[rstest::rstest]
fn adding_a_directory_shows_added_notice() -> Result<(), Report<StoreError>> {
    // Given no projects and an existing directory.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let (mut actor, _state) = start(
        Store::open_in_memory()?,
        &listing(Vec::new()),
        Path::new(NO_CLAUDE_DIR),
    );

    // When adding it as a project.
    actor.add_project(dir.path().to_owned());

    // Then the notice names the project.
    let expected = format!("Added project {}", project_title(dir.path()));
    assert_eq!(
        message_notices(&actor),
        [expected],
        "adding a project should say it was added"
    );
    Ok(())
}

#[rstest::rstest]
fn add_project_reports_projects_changed() -> Result<(), Report<StoreError>> {
    // Given no projects and an existing directory.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let (mut actor, _state) = start(
        Store::open_in_memory()?,
        &listing(Vec::new()),
        Path::new(NO_CLAUDE_DIR),
    );

    // When adding it as a project.
    actor.add_project(dir.path().to_owned());

    // Then the frontend is told the projects changed.
    assert!(
        actor.report.outcomes().contains(&Outcome::ProjectsChanged),
        "an open projects screen should re-list the new project"
    );
    Ok(())
}

#[rstest::rstest]
fn remove_project_reports_projects_changed() -> Result<(), Report<StoreError>> {
    // Given a saved project.
    let (store, id) = store_with_project()?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // When removing it.
    actor.remove_project(id);

    // Then the frontend is told the projects changed.
    assert!(
        actor.report.outcomes().contains(&Outcome::ProjectsChanged),
        "an open projects screen should drop the removed project"
    );
    Ok(())
}

#[rstest::rstest]
fn adding_an_existing_project_shows_added_notice() -> Result<(), Report<StoreError>> {
    // Given a directory that's already a saved project.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let store = Store::open_in_memory()?;
    store.add_project(dir.path(), "web", ProjectKind::Normal, 0)?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // When adding it again.
    actor.add_project(dir.path().to_owned());

    // Then the notice says it was added.
    let expected = format!("Added project {}", project_title(dir.path()));
    assert_eq!(
        message_notices(&actor),
        [expected],
        "re-adding a project should still say it was added"
    );
    Ok(())
}

#[rstest::rstest]
fn adding_a_missing_directory_leaves_no_notice() -> Result<(), Report<StoreError>> {
    // Given no projects.
    let (mut actor, _state) = start(
        Store::open_in_memory()?,
        &listing(Vec::new()),
        Path::new(NO_CLAUDE_DIR),
    );

    // When adding a path that doesn't exist.
    actor.add_project(PathBuf::from("/nonexistent/project"));

    // Then there's no notice.
    assert!(
        message_notices(&actor).is_empty(),
        "a failed add shouldn't say Added"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_titles_an_agent_with_its_transcripts_prompt() -> Result<(), Report<StoreError>> {
    // Given an agent whose session's transcript has a prompt.
    let claude_dir = tempfile::tempdir().change_context(StoreError)?;
    let path = transcript_path(claude_dir.path(), Path::new(PROJECT_ROOT), "aa");
    fs::create_dir_all(path.parent().unwrap_or(claude_dir.path())).change_context(StoreError)?;
    fs::write(
        &path,
        "{\"type\":\"user\",\"message\":{\"content\":\"Fix the sidebar\"}}\n",
    )
    .change_context(StoreError)?;
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, claude_dir.path());

    // When polling.
    actor.poll().await;

    // Then the agent is titled with the prompt.
    let title = state
        .read()
        .sessions
        .all_agents()
        .find(|agent| agent.id == id)
        .and_then(|agent| agent.title.clone());
    assert_eq!(
        title.as_deref(),
        Some("Fix the sidebar"),
        "the first prompt should title the agent"
    );
    Ok(())
}

/// The directory of Claude's transcripts, holding session `aa` with
/// `lines`.
fn claude_dir_with(lines: &str) -> Result<tempfile::TempDir, Report<StoreError>> {
    let claude_dir = tempfile::tempdir().change_context(StoreError)?;
    let path = transcript_path(claude_dir.path(), Path::new(PROJECT_ROOT), "aa");
    fs::create_dir_all(path.parent().unwrap_or(claude_dir.path())).change_context(StoreError)?;
    fs::write(&path, lines).change_context(StoreError)?;
    Ok(claude_dir)
}

const SOCRATIC_PLAN: &str = "{\"type\":\"user\",\"message\":{\"content\":\"<command-message>socratic-plan</command-message>\\n<command-name>/socratic-plan</command-name>\\n<command-args>fix the sidebar</command-args>\"}}\n";

#[rstest::rstest]
#[tokio::test]
async fn poll_titles_an_agent_with_its_slash_commands_text() -> Result<(), Report<StoreError>> {
    // Given an agent whose transcript starts with `/socratic-plan fix the sidebar`.
    let claude_dir = claude_dir_with(SOCRATIC_PLAN)?;
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, claude_dir.path());

    // When polling.
    actor.poll().await;

    // Then the agent is titled with the text typed after the command.
    assert_eq!(
        shown(&state, id).and_then(|agent| agent.title).as_deref(),
        Some("fix the sidebar"),
        "the command's text should title the agent"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn custom_title_beats_a_slash_commands_text() -> Result<(), Report<StoreError>> {
    // Given an agent whose transcript has a slash command with text, then a `/rename`.
    let claude_dir = claude_dir_with(&format!(
        "{SOCRATIC_PLAN}{{\"type\":\"custom-title\",\"customTitle\":\"orb-m1\"}}\n"
    ))?;
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, claude_dir.path());

    // When polling.
    actor.poll().await;

    // Then the agent shows the `/rename`.
    assert_eq!(
        shown(&state, id).and_then(|agent| agent.title).as_deref(),
        Some("orb-m1"),
        "`/rename` should beat the command's text"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn orb_name_beats_a_slash_commands_text() -> Result<(), Report<StoreError>> {
    // Given an agent renamed with `r` whose transcript starts with a slash command with text.
    let claude_dir = claude_dir_with(SOCRATIC_PLAN)?;
    let (store, id) = store_with_agent("aa")?;
    resave(&store, "aa", |row| AgentRow {
        renamed_title: Some("Sidebar search".to_owned()),
        ..row
    })?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, claude_dir.path());

    // When polling.
    actor.poll().await;

    // Then the agent keeps the orb name.
    assert_eq!(
        shown(&state, id).and_then(|agent| agent.title).as_deref(),
        Some("Sidebar search"),
        "the `r` name should beat the command's text"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_titles_an_agent_with_its_custom_title() -> Result<(), Report<StoreError>> {
    // Given an agent whose transcript has a prompt, an ai-title, then a `/rename`.
    let claude_dir = tempfile::tempdir().change_context(StoreError)?;
    let path = transcript_path(claude_dir.path(), Path::new(PROJECT_ROOT), "aa");
    fs::create_dir_all(path.parent().unwrap_or(claude_dir.path())).change_context(StoreError)?;
    fs::write(
        &path,
        concat!(
            "{\"type\":\"user\",\"message\":{\"content\":\"Fix the sidebar\"}}\n",
            "{\"type\":\"ai-title\",\"aiTitle\":\"Sidebar fix\"}\n",
            "{\"type\":\"custom-title\",\"customTitle\":\"orb-m1\"}\n",
        ),
    )
    .change_context(StoreError)?;
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, claude_dir.path());

    // When polling.
    actor.poll().await;

    // Then the agent is titled with the custom title.
    let title = state
        .read()
        .sessions
        .all_agents()
        .find(|agent| agent.id == id)
        .and_then(|agent| agent.title.clone());
    assert_eq!(
        title.as_deref(),
        Some("orb-m1"),
        "`/rename` should beat the ai-title"
    );
    Ok(())
}

/// The directory of Claude's transcripts, holding session `s1` of agent
/// `aa` with `lines`, and a store where `aa` was given `custom_title`
/// by `/rename` and `renamed` with `r`.
fn renamed_agent(
    lines: &str,
    custom_title: &str,
    renamed: &str,
) -> Result<(tempfile::TempDir, Store, AgentId), Report<StoreError>> {
    let claude_dir = tempfile::tempdir().change_context(StoreError)?;
    let path = transcript_path(claude_dir.path(), Path::new(PROJECT_ROOT), "aa");
    fs::create_dir_all(path.parent().unwrap_or(claude_dir.path())).change_context(StoreError)?;
    fs::write(&path, lines).change_context(StoreError)?;
    let (store, id) = store_with_agent("aa")?;
    resave(&store, "aa", |row| AgentRow {
        custom_title: Some(custom_title.to_owned()),
        renamed_title: Some(renamed.to_owned()),
        ..row
    })?;
    Ok((claude_dir, store, id))
}

#[rstest::rstest]
#[tokio::test]
async fn new_custom_title_replaces_the_orb_name() -> Result<(), Report<StoreError>> {
    // Given an agent renamed with `r` after a `/rename` to `orb-m1`,
    // whose transcript now has a `/rename` to `orb-m2`.
    let (claude_dir, store, id) = renamed_agent(
        "{\"type\":\"custom-title\",\"customTitle\":\"orb-m2\"}\n",
        "orb-m1",
        "Sidebar search",
    )?;
    let host = listing(vec![in_session(AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, claude_dir.path());

    // When polling.
    actor.poll().await;

    // Then the agent shows the new `/rename`.
    assert_eq!(
        shown(&state, id).and_then(|agent| agent.title).as_deref(),
        Some("orb-m2"),
        "a different `/rename` should replace the orb name"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn repeated_custom_title_keeps_the_orb_name() -> Result<(), Report<StoreError>> {
    // Given an agent renamed with `r` after a `/rename` to `orb-m1`,
    // whose transcript has Claude writing `orb-m1` again.
    let (claude_dir, store, id) = renamed_agent(
        "{\"type\":\"custom-title\",\"customTitle\":\"orb-m1\"}\n",
        "orb-m1",
        "Sidebar search",
    )?;
    let host = listing(vec![in_session(AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, claude_dir.path());

    // When polling.
    actor.poll().await;

    // Then the agent keeps the orb name.
    assert_eq!(
        shown(&state, id).and_then(|agent| agent.title).as_deref(),
        Some("Sidebar search"),
        "Claude re-writing its old name shouldn't replace the orb name"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn saved_orb_name_is_the_title_after_a_restart() -> Result<(), Report<StoreError>> {
    // Given a store holding an agent Claude titled and the user renamed.
    let (store, id) = store_with_agent("aa")?;
    resave(&store, "aa", |row| AgentRow {
        title: Some("Fix the sidebar".to_owned()),
        renamed_title: Some("Sidebar search".to_owned()),
        ..row
    })?;
    let host = listing(Vec::new());

    // When orb starts on that store.
    let (_actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // Then the sidebar shows the orb name.
    assert_eq!(
        shown(&state, id).and_then(|agent| agent.title).as_deref(),
        Some("Sidebar search"),
        "the orb name should survive a restart"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_end_notice_names_the_agent_by_its_orb_name() -> Result<(), Report<StoreError>> {
    // Given an agent `/rename`d "Parser fix" and renamed "Lexer" with `r`.
    let (store, _) = store_with_agent("aa")?;
    resave(&store, "aa", |row| AgentRow {
        custom_title: Some("Parser fix".to_owned()),
        renamed_title: Some("Lexer".to_owned()),
        ..row
    })?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When polls see its turn run and then end.
    end_turn(&mut actor, &host).await;

    // Then the notice names the agent by its orb name.
    let titles: Vec<_> = notices_of(&actor)
        .into_iter()
        .map(|notice| notice.title)
        .collect();
    assert_eq!(titles, ["Lexer"], "the notice's agent title");
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_shows_the_located_transcript_on_the_agent() -> Result<(), Report<StoreError>> {
    // Given an agent whose session has a transcript.
    let claude_dir = tempfile::tempdir().change_context(StoreError)?;
    let path = transcript_path(claude_dir.path(), Path::new(PROJECT_ROOT), "aa");
    fs::create_dir_all(path.parent().unwrap_or(claude_dir.path())).change_context(StoreError)?;
    fs::write(&path, "").change_context(StoreError)?;
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, claude_dir.path());

    // When polling.
    actor.poll().await;

    // Then the agent carries the transcript's path.
    let transcript = state
        .read()
        .sessions
        .all_agents()
        .find(|agent| agent.id == id)
        .and_then(|agent| agent.transcript.clone());
    assert_eq!(
        transcript,
        Some(path),
        "a located transcript should be shown on its agent"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_lists_projects_by_first_use_and_agents_newest_first() -> Result<(), Report<StoreError>> {
    // Given project B saved before project A but first used after it,
    // with A's agents created at 10 and 30 and B's at 20.
    let store = Store::open_in_memory()?;
    let b = store.add_project(Path::new("/b"), "b", ProjectKind::Normal, 2)?;
    let a = store.add_project(Path::new("/a"), "a", ProjectKind::Normal, 1)?;
    let insert = |project_id, short_id: &str, created_at| {
        seed_with(
            &store,
            "claude",
            project_id,
            SessionKind::Plain,
            Path::new("/a"),
            short_id,
            created_at,
        )
        .map(|seeded| seeded.agent)
    };
    let a_old = insert(a, "a1", 10)?;
    let b_only = insert(b, "b1", 20)?;
    let a_new = insert(a, "a2", 30)?;

    // When the actor starts.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the sidebar lists A's agents newest first, then B's.
    let order: Vec<AgentId> = state
        .read()
        .sessions
        .all_agents()
        .map(|agent| agent.id)
        .collect();
    assert_eq!(
        order,
        vec![a_new, a_old, b_only],
        "projects by first use, agents newest first"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_selects_the_first_sidebar_item() -> Result<(), Report<StoreError>> {
    // Given an old pinned session and a newer unpinned one.
    let store = Store::open_in_memory()?;
    let pinned = add_agent(&store, "old", 10)?;
    add_agent(&store, "new", 20)?;
    store.save_session(&SessionRow {
        pinned_at: Some(30),
        ..saved_session(&store, "old")?
    })?;

    // When the actor starts.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the pinned session, first in the sidebar, is selected.
    assert_eq!(
        state.read().sessions.cursor,
        Some(SidebarItem::Session(SessionId(pinned.0))),
        "the sidebar's first row should be selected"
    );
    Ok(())
}

/// A store whose sidebar was saved `width` columns wide.
fn store_with_width(width: u16) -> Result<Store, Report<StoreError>> {
    let store = Store::open_in_memory()?;
    store.save_ui(&Ui {
        sidebar_width: Some(width),
        project_filter: None,
    })?;
    Ok(store)
}

#[rstest::rstest]
fn restore_drops_a_saved_jump_to_a_missing_agent() -> Result<(), Report<StoreError>> {
    // Given a saved jump list naming agent aa and an agent that's gone.
    let (store, id) = store_with_agent("aa")?;
    let gone = SidebarItem::Session(SessionId(id.0 + 1));
    store.save_jumps(&[SidebarItem::Session(SessionId(id.0)), gone])?;

    // When the actor starts.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then only agent aa is in the jump list.
    assert_eq!(
        state.read().jumps.entries(),
        [SidebarItem::Session(SessionId(id.0))],
        "a saved jump to a missing agent should be dropped"
    );
    Ok(())
}

#[rstest::rstest]
fn saving_jumps_writes_the_jump_list() -> Result<(), Report<StoreError>> {
    // Given a started actor whose jump list holds agent aa.
    let (store, id) = store_with_agent("aa")?;
    let (actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    state.write().jumps = JumpList::from_saved(vec![SidebarItem::Session(SessionId(id.0))]);

    // When saving the jump list.
    actor.save_jumps();

    // Then the store holds it.
    assert_eq!(
        actor.store.jumps()?,
        vec![SidebarItem::Session(SessionId(id.0))],
        "the jump list should be saved"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_applies_the_saved_sidebar_width() -> Result<(), Report<StoreError>> {
    // Given a sidebar saved 40 columns wide.
    let store = store_with_width(40)?;

    // When the actor starts.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the sidebar is 40 columns wide.
    assert_eq!(
        state.read().sidebar.width,
        40,
        "the saved width should be restored"
    );
    Ok(())
}

#[rstest::rstest]
#[case(10, 24)]
#[case(200, 80)]
fn restore_keeps_a_saved_sidebar_width_within_its_bounds(
    #[case] saved: u16,
    #[case] expected: u16,
) -> Result<(), Report<StoreError>> {
    // Given a sidebar saved outside 24–80 columns (a hand-edited store).
    let store = store_with_width(saved)?;

    // When the actor starts.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the sidebar is at the nearest bound.
    assert_eq!(
        state.read().sidebar.width,
        expected,
        "a saved width of {saved} should be clamped"
    );
    Ok(())
}

#[rstest::rstest]
fn save_ui_saves_the_sidebar_width() -> Result<(), Report<StoreError>> {
    // Given the actor on a fresh store and a sidebar resized to 44 columns.
    let (actor, state) = start(
        Store::open_in_memory()?,
        &listing(Vec::new()),
        Path::new(NO_CLAUDE_DIR),
    );
    state.write().sidebar.width = 44;

    // When saving the layout.
    actor.save_ui();

    // Then the store holds the 44-column width and no filter.
    assert_eq!(
        actor.store.ui()?,
        Ui {
            sidebar_width: Some(44),
            project_filter: None,
        },
        "SaveUi should save the sidebar's width"
    );
    Ok(())
}

/// Whether project `id` shows as removed.
fn removed_of(state: &State, id: ProjectId) -> Option<bool> {
    state
        .read()
        .sessions
        .projects
        .iter()
        .find(|project| project.id == id)
        .map(|project| project.removed)
}

#[rstest::rstest]
fn remove_project_marks_it_removed() -> Result<(), Report<StoreError>> {
    // Given a project.
    let (store, id) = store_with_project()?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // When removing it.
    actor.remove_project(id);

    // Then it shows as removed.
    assert_eq!(
        removed_of(&state, id),
        Some(true),
        "a removed project should leave <C-g> n and the filter"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_shows_a_removed_project_as_removed() -> Result<(), Report<StoreError>> {
    // Given a removed project.
    let store = Store::open_in_memory()?;
    let id = orb_project(&store)?;
    store.remove_project(id, 1_000)?;

    // When the actor starts.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the project shows as removed.
    assert_eq!(
        removed_of(&state, id),
        Some(true),
        "the removal should survive a restart"
    );
    Ok(())
}

/// Starts the actor on `store` with `incognito_root` as orb's Incognito
/// folder.
fn start_incognito(
    store: Store,
    host: &Arc<FakeClaude>,
    incognito_root: &Path,
) -> (SessionsActor, State) {
    start_in(
        store,
        host,
        &FakeGit::local(),
        Path::new(NO_CLAUDE_DIR),
        Path::new(ORB_ROOT),
        incognito_root,
    )
}

/// The titles of the Incognito projects the sidebar has.
fn incognito_titles(state: &State) -> Vec<String> {
    state
        .read()
        .sessions
        .projects
        .iter()
        .filter(|project| project.kind == ProjectKind::Incognito)
        .map(|project| project.title.clone())
        .collect()
}

#[rstest::rstest]
fn restore_adds_the_incognito_project() -> Result<(), Report<StoreError>> {
    // Given an empty store.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let root = dir.path().join("incognito");

    // When the actor starts.
    let (_actor, state) = start_incognito(Store::open_in_memory()?, &listing(Vec::new()), &root);

    // Then it has an Incognito project titled Incognito.
    assert_eq!(
        incognito_titles(&state),
        vec!["Incognito".to_owned()],
        "start should add orb's Incognito project"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_keeps_one_incognito_project() -> Result<(), Report<StoreError>> {
    // Given a store that already holds the Incognito project.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let root = dir.path().join("incognito");
    let store = Store::open_in_memory()?;
    store.add_project(&root, "Incognito", ProjectKind::Incognito, 0)?;

    // When the actor starts.
    let (_actor, state) = start_incognito(store, &listing(Vec::new()), &root);

    // Then there's still one Incognito project.
    assert_eq!(
        incognito_titles(&state).len(),
        1,
        "start shouldn't add the Incognito project twice"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_makes_the_incognito_folder() -> Result<(), Report<StoreError>> {
    // Given a missing Incognito folder.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let root = dir.path().join("incognito");

    // When the actor starts.
    let (_actor, _state) = start_incognito(Store::open_in_memory()?, &listing(Vec::new()), &root);

    // Then the folder exists.
    assert!(root.is_dir(), "start should make the Incognito folder");
    Ok(())
}

#[rstest::rstest]
fn restore_un_removes_the_incognito_project() -> Result<(), Report<StoreError>> {
    // Given a removed Incognito project.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let root = dir.path().join("incognito");
    let store = Store::open_in_memory()?;
    let id = store.add_project(&root, "Incognito", ProjectKind::Incognito, 0)?;
    store.remove_project(id, 1)?;

    // When the actor starts.
    let (_actor, state) = start_incognito(store, &listing(Vec::new()), &root);

    // Then it isn't removed.
    assert_eq!(
        removed_of(&state, id),
        Some(false),
        "start should bring back a removed Incognito project"
    );
    Ok(())
}

/// The root of orb's own `kind` project the sidebar shows, if any.
fn own_root(state: &State, kind: ProjectKind) -> Option<PathBuf> {
    state
        .read()
        .sessions
        .own_project(kind)
        .map(|project| project.root.clone())
}

#[rstest::rstest]
fn restore_adds_the_research_and_learn_projects() -> Result<(), Report<StoreError>> {
    // Given an empty store and orb's folder in a temporary directory.
    let orb = tempfile::tempdir().change_context(StoreError)?;

    // When the actor starts.
    let (_actor, state) = start_at(Store::open_in_memory()?, orb.path());

    // Then Research and Learn exist, rooted under orb's folder.
    assert_eq!(
        (
            own_root(&state, ProjectKind::Research),
            own_root(&state, ProjectKind::Learn)
        ),
        (
            Some(orb.path().join("research")),
            Some(orb.path().join("learn"))
        ),
        "start should add orb's Research and Learn projects"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_un_removes_the_research_project() -> Result<(), Report<StoreError>> {
    // Given a removed Research project.
    let orb = tempfile::tempdir().change_context(StoreError)?;
    let store = Store::open_in_memory()?;
    let id = store.add_project(
        &orb.path().join("research"),
        "Research",
        ProjectKind::Research,
        0,
    )?;
    store.remove_project(id, 1)?;

    // When the actor starts.
    let (_actor, state) = start_at(store, orb.path());

    // Then it isn't removed.
    assert_eq!(
        removed_of(&state, id),
        Some(false),
        "start should bring back a removed Research project"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn deleting_a_session_clears_its_colonists_parent_in_the_sidebar()
-> Result<(), Report<StoreError>> {
    // Given saved session A and session B made by A.
    let store = Store::open_in_memory()?;
    let project = orb_project(&store)?;
    let dir = Path::new(PROJECT_ROOT);
    let (parent, _) =
        store.insert_session(project, SessionKind::Colony, dir, None, None, None, 1_000)?;
    let (child, _) = store.insert_session(
        project,
        SessionKind::Plain,
        dir,
        None,
        None,
        Some(parent),
        1_100,
    )?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // When deleting A.
    delete(&mut actor, parent);

    // Then B shows with no parent.
    assert_eq!(
        state
            .read()
            .sessions
            .session(child)
            .map(|session| session.parent),
        Some(None),
        "deleting a session should leave its colonists top level"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn deleting_colony_only_leaves_its_colonists_top_level() -> Result<(), Report<StoreError>> {
    // Given saved colony A and its colonist B, the actor started through
    // its mailbox.
    let store = Store::open_in_memory()?;
    let project = orb_project(&store)?;
    let dir = Path::new(PROJECT_ROOT);
    let (colony, _) =
        store.insert_session(project, SessionKind::Colony, dir, None, None, None, 1_000)?;
    let (colonist, _) = store.insert_session(
        project,
        SessionKind::Plain,
        dir,
        None,
        None,
        Some(colony),
        1_100,
    )?;
    let zmx = zmx_running(&store);
    let (actor, state) = spawned(store, &listing(Vec::new()), zmx).await?;

    // When deleting A alone through the mailbox.
    ask_within(
        &actor,
        SessionsCommand::DeleteSession {
            session: colony,
            with_colonists: false,
        },
    )
    .await?;

    // Then B stays, top level.
    assert_eq!(
        state
            .read()
            .sessions
            .session(colonist)
            .map(|session| session.parent),
        Some(None),
        "Colony only should leave the colonist as a top-level session"
    );
    Ok(())
}

#[rstest::rstest]
fn adding_a_removed_project_restores_it() -> Result<(), Report<StoreError>> {
    // Given a directory that's a removed project.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let store = Store::open_in_memory()?;
    let id = store.add_project(dir.path(), "web", ProjectKind::Normal, 0)?;
    store.remove_project(id, 1_000)?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // When adding it again.
    actor.add_project(dir.path().to_owned());

    // Then it's no longer removed.
    assert_eq!(
        removed_of(&state, id),
        Some(false),
        "adding a removed project's directory should restore it"
    );
    Ok(())
}

/// A store with projects orb and web, each holding one agent, and its
/// layout saved filtered to web. Returns web's id and agent.
fn store_filtered_to_web() -> Result<(Store, ProjectId, AgentId), Report<StoreError>> {
    let store = Store::open_in_memory()?;
    add_agent(&store, "aa", 1_000)?;
    let web = store.add_project(Path::new(WEB_ROOT), "web", ProjectKind::Normal, 0)?;
    let agent = seed_with(
        &store,
        "claude",
        web,
        SessionKind::Plain,
        Path::new(WEB_ROOT),
        "bb",
        500,
    )
    .map(|seeded| seeded.agent)?;
    store.save_ui(&Ui {
        sidebar_width: None,
        project_filter: Some(web),
    })?;
    Ok((store, web, agent))
}

#[rstest::rstest]
fn restore_applies_the_saved_filter() -> Result<(), Report<StoreError>> {
    // Given a sidebar saved filtered to web.
    let (store, web, _) = store_filtered_to_web()?;

    // When the actor starts.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the sidebar is filtered to web.
    assert_eq!(
        state.read().sessions.filter,
        Some(web),
        "the saved filter should be restored"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_selects_the_first_filtered_row() -> Result<(), Report<StoreError>> {
    // Given a sidebar saved filtered to web, whose agent is older than
    // orb's, so it would otherwise be the second row.
    let (store, _, agent) = store_filtered_to_web()?;

    // When the actor starts.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the cursor is on web's agent.
    assert_eq!(
        state.read().sessions.cursor,
        Some(SidebarItem::Session(SessionId(agent.0))),
        "the cursor should start on the filtered sidebar's first row"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_ignores_a_filter_to_a_removed_project() -> Result<(), Report<StoreError>> {
    // Given a sidebar saved filtered to web, which was then removed.
    let (store, web, _) = store_filtered_to_web()?;
    store.remove_project(web, 2_000)?;

    // When the actor starts.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the sidebar lists every project.
    assert_eq!(
        state.read().sessions.filter,
        None,
        "a filter to a removed project should be dropped"
    );
    Ok(())
}

#[rstest::rstest]
fn save_ui_saves_the_filter() -> Result<(), Report<StoreError>> {
    // Given the actor with the orb project and the sidebar filtered to it.
    let store = Store::open_in_memory()?;
    let id = orb_project(&store)?;
    let (actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    state.write().sessions.filter = Some(id);

    // When saving the layout.
    actor.save_ui();

    // Then the store holds the filter.
    assert_eq!(
        actor.store.ui()?.project_filter,
        Some(id),
        "SaveUi should save the project filter"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_shows_when_each_project_was_added() -> Result<(), Report<StoreError>> {
    // Given a project saved at 1.5 s.
    let store = Store::open_in_memory()?;
    store.add_project(Path::new(PROJECT_ROOT), "orb", ProjectKind::Normal, 1_500)?;

    // When the actor starts.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the project shows it was added at 1.5 s.
    let added: Vec<SystemTime> = state
        .read()
        .sessions
        .projects
        .iter()
        .filter(|project| project.kind == ProjectKind::Normal)
        .map(|project| project.created_at)
        .collect();
    assert_eq!(
        added,
        vec![SystemTime::UNIX_EPOCH + Duration::from_millis(1_500)],
        "a restored project should keep when it was added"
    );
    Ok(())
}

#[rstest::rstest]
fn restore_keeps_when_each_agent_was_created() -> Result<(), Report<StoreError>> {
    // Given an agent created at 1.5 s.
    let store = Store::open_in_memory()?;
    let project_id = store.add_project(Path::new(PROJECT_ROOT), "orb", ProjectKind::Normal, 1)?;
    seed_with(
        &store,
        "claude",
        project_id,
        SessionKind::Plain,
        Path::new(PROJECT_ROOT),
        "t1",
        1_500,
    )
    .map(|seeded| seeded.agent)?;

    // When the actor starts.
    let (_actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // Then the agent shows it was created at 1.5 s.
    let created: Vec<SystemTime> = state
        .read()
        .sessions
        .all_agents()
        .map(|agent| agent.created_at)
        .collect();
    assert_eq!(
        created,
        vec![SystemTime::UNIX_EPOCH + Duration::from_millis(1_500)],
        "a restored agent should keep when it was created"
    );
    Ok(())
}

/// Makes the agent `short_id` idle since four days ago; returns that time.
fn idle_for_four_days(store: &Store, short_id: &str) -> Result<i64, Report<StoreError>> {
    let since = now_ms() - 4 * DAY_MS;
    resave(store, short_id, |row| AgentRow {
        last_activity_at: since,
        last_visited_at: since,
        ..row
    })?;
    Ok(since)
}

/// Shows `seeded`'s session with the keys in its pane, or in the sidebar
/// with the cursor on the session when `in_pane` is false.
fn shown_with_keys(state: &State, seeded: &Seeded, in_pane: bool) {
    let mut app = state.write();
    app.attached.insert(seeded.session);
    app.sessions.enter(seeded.session);
    app.sessions.cursor = Some(SidebarItem::Session(seeded.session));
    app.focus = if in_pane { Focus::Pane } else { Focus::Sidebar };
}

#[rstest::rstest]
#[tokio::test]
async fn turn_end_with_keys_in_its_pane_is_seen() -> Result<(), Report<StoreError>> {
    // Given agent aa working, with the keys in its pane.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    shown_with_keys(&state, &inserted, true);
    actor.poll().await;

    // When a poll sees its turn end.
    host.set_running(Ok(vec![record("aa", AgentStatus::Idle)]));
    actor.poll().await;

    // Then it is seen.
    assert_eq!(
        shown(&state, inserted.agent).map(|agent| agent.unseen),
        Some(false),
        "a turn that ends with the keys in its pane counts as seen"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_end_with_keys_in_sidebar_is_unseen() -> Result<(), Report<StoreError>> {
    // Given agent aa working, its session shown and the keys in the
    // sidebar on it.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    shown_with_keys(&state, &inserted, false);
    actor.poll().await;

    // When a poll sees its turn end.
    host.set_running(Ok(vec![record("aa", AgentStatus::Idle)]));
    actor.poll().await;

    // Then it is unseen.
    assert_eq!(
        shown(&state, inserted.agent).map(|agent| agent.unseen),
        Some(true),
        "a turn that ends while the keys are in the sidebar waits to be seen"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_end_with_keys_in_another_sessions_pane_is_unseen() -> Result<(), Report<StoreError>> {
    // Given agent aa working, with the keys in agent bb's pane.
    let store = Store::open_in_memory()?;
    let aa = insert_agent(&store, "aa")?;
    let bb = insert_agent(&store, "bb")?;
    let host = listing(vec![
        record("aa", AgentStatus::Working),
        record("bb", AgentStatus::Idle),
    ]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    shown_with_keys(&state, &bb, true);
    actor.poll().await;

    // When a poll sees aa's turn end.
    host.set_running(Ok(vec![
        record("aa", AgentStatus::Idle),
        record("bb", AgentStatus::Idle),
    ]));
    actor.poll().await;

    // Then aa is unseen.
    assert_eq!(
        shown(&state, aa.agent).map(|agent| agent.unseen),
        Some(true),
        "a turn that ends while the keys are in another pane waits to be seen"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_end_stamps_last_activity() -> Result<(), Report<StoreError>> {
    // Given an agent a poll saw working.
    let (store, _) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.poll().await;
    let before = now_ms();

    // When a poll sees its turn end.
    host.set_running(Ok(vec![record("aa", AgentStatus::Idle)]));
    actor.poll().await;

    // Then its last activity is the turn's end.
    assert!(
        saved(&actor.store, "aa")?.last_activity_at >= before,
        "the turn end should be the agent's last activity"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_end_without_a_scanned_branch_takes_the_branch_from_git()
-> Result<(), Report<StoreError>> {
    // Given a branchless agent a poll saw working, whose transcript names no branch.
    let claude_dir = tempfile::tempdir().change_context(StoreError)?;
    let path = transcript_path(claude_dir.path(), Path::new(PROJECT_ROOT), "aa");
    fs::create_dir_all(path.parent().unwrap_or(claude_dir.path())).change_context(StoreError)?;
    fs::write(&path, PROMPT_LINE).change_context(StoreError)?;
    let (store, _) = store_with_agent("aa")?;
    let working = record("aa", AgentStatus::Working);
    let host = listing(vec![working.clone()]);
    let (mut actor, _state) = start(store, &host, claude_dir.path());
    actor.poll().await;

    // When a poll sees its turn end.
    host.set_running(Ok(vec![RunningAgent {
        status: AgentStatus::Idle,
        ..working
    }]));
    actor.poll().await;

    // Then the agent takes the branch git has checked out there.
    assert_eq!(
        saved(&actor.store, "aa")?.branch.as_deref(),
        Some(CURRENT_BRANCH),
        "a turn end with no scanned branch should ask git"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn a_failed_branch_read_after_a_turn_is_logged() -> Result<(), Report<StoreError>> {
    // Given a branchless agent a poll saw working, in a repository whose
    // refs can't be read, whose transcript names no branch, and a log.
    let claude_dir = tempfile::tempdir().change_context(StoreError)?;
    let path = transcript_path(claude_dir.path(), Path::new(PROJECT_ROOT), "aa");
    fs::create_dir_all(path.parent().unwrap_or(claude_dir.path())).change_context(StoreError)?;
    fs::write(&path, PROMPT_LINE).change_context(StoreError)?;
    let (store, _) = store_with_agent("aa")?;
    let working = record("aa", AgentStatus::Working);
    let host = listing(vec![working.clone()]);
    let (mut actor, _state) = start_with(store, &host, &FakeGit::broken(), claude_dir.path());
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let log = dir.path().join("orb.log");
    actor.services.log = Log::new(log.clone());
    actor.poll().await;

    // When a poll sees its turn end.
    host.set_running(Ok(vec![RunningAgent {
        status: AgentStatus::Idle,
        ..working
    }]));
    actor.poll().await;

    // Then the log says the branch couldn't be read, and why.
    let content = fs::read_to_string(&log).unwrap_or_default();
    assert!(
        content.contains("couldn't read the branch in") && content.contains(BROKEN_REPO),
        "the failed branch read should be logged with its cause, got {content:?}"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn a_branch_read_outside_git_after_a_turn_is_not_logged() -> Result<(), Report<StoreError>> {
    // Given a branchless agent a poll saw working, in a folder that isn't a
    // git repository, whose transcript names no branch, and a log.
    let claude_dir = tempfile::tempdir().change_context(StoreError)?;
    let path = transcript_path(claude_dir.path(), Path::new(PROJECT_ROOT), "aa");
    fs::create_dir_all(path.parent().unwrap_or(claude_dir.path())).change_context(StoreError)?;
    fs::write(&path, PROMPT_LINE).change_context(StoreError)?;
    let (store, _) = store_with_agent("aa")?;
    let working = record("aa", AgentStatus::Working);
    let host = listing(vec![working.clone()]);
    let (mut actor, _state) =
        start_with(store, &host, &FakeGit::plain(Err("no")), claude_dir.path());
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let log = dir.path().join("orb.log");
    actor.services.log = Log::new(log.clone());
    actor.poll().await;

    // When a poll sees its turn end.
    host.set_running(Ok(vec![RunningAgent {
        status: AgentStatus::Idle,
        ..working
    }]));
    actor.poll().await;

    // Then nothing is logged.
    let content = fs::read_to_string(&log).unwrap_or_default();
    assert!(
        content.is_empty(),
        "a folder outside git has no branch to read, got {content:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn failed_branch_reads_in_two_folders_are_each_logged_once() -> Result<(), Report<StoreError>> {
    // Given a repository whose refs can't be read, and a log.
    let claude_dir = tempfile::tempdir().change_context(StoreError)?;
    let (store, _) = store_with_agent("aa")?;
    let host = listing(vec![]);
    let (mut actor, _state) = start_with(store, &host, &FakeGit::broken(), claude_dir.path());
    let log = claude_dir.path().join("orb.log");
    actor.services.log = Log::new(log.clone());

    // When the branch is read in two folders in turn, twice.
    for folder in ["/repo/a", "/repo/b", "/repo/a", "/repo/b"] {
        let _ = current_branch(&actor.services.git, &actor.services.log, Path::new(folder));
    }

    // Then each folder's failure is logged once.
    let content = fs::read_to_string(&log).unwrap_or_default();
    assert_eq!(
        content.matches("couldn't read the branch in").count(),
        2,
        "each folder's failure should be logged once, got {content:?}"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn an_unreadable_transcript_is_logged() -> Result<(), Report<StoreError>> {
    // Given an agent whose transcript a poll found, then became a folder,
    // and a log.
    let claude_dir = tempfile::tempdir().change_context(StoreError)?;
    let path = transcript_path(claude_dir.path(), Path::new(PROJECT_ROOT), "aa");
    fs::create_dir_all(path.parent().unwrap_or(claude_dir.path())).change_context(StoreError)?;
    fs::write(&path, PROMPT_LINE).change_context(StoreError)?;
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, _state) = start(store, &host, claude_dir.path());
    actor.poll().await;
    fs::remove_file(&path).change_context(StoreError)?;
    fs::create_dir_all(&path).change_context(StoreError)?;
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let log = dir.path().join("orb.log");
    actor.services.log = Log::new(log.clone());

    // When polling.
    actor.poll().await;

    // Then the log says the agent's transcript couldn't be read.
    let content = fs::read_to_string(&log).unwrap_or_default();
    let expected = format!("couldn't read agent {}'s transcript", id.0);
    assert!(
        content.contains(&expected),
        "expected {expected:?} in the log, got {content:?}"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_shows_the_transcript_branch() -> Result<(), Report<StoreError>> {
    // Given an agent whose transcript's prompt names a branch.
    let claude_dir = tempfile::tempdir().change_context(StoreError)?;
    let path = transcript_path(claude_dir.path(), Path::new(PROJECT_ROOT), "aa");
    fs::create_dir_all(path.parent().unwrap_or(claude_dir.path())).change_context(StoreError)?;
    fs::write(
        &path,
        "{\"type\":\"user\",\"gitBranch\":\"main\",\"message\":{\"content\":\"Fix it\"}}\n",
    )
    .change_context(StoreError)?;
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, claude_dir.path());

    // When polling.
    actor.poll().await;

    // Then the agent shows the branch.
    assert_eq!(
        shown(&state, id).and_then(|agent| agent.branch),
        Some("main".to_owned()),
        "the transcript's branch should show on the agent"
    );
    Ok(())
}

/// A store whose session holds untitled agent `aa` in the orb project's
/// checkout, with a second pane.
fn movable() -> Result<(Store, Seeded, PaneId), Report<StoreError>> {
    let store = Store::open_in_memory()?;
    let seeded = insert_agent(&store, "aa")?;
    let second = second_tab(&store, &seeded)?;
    Ok((store, seeded, second))
}

/// What [`moved_to`] leaves: the actor, its state, the session's agent
/// and first pane, its second pane, and the zmx it called after start.
type Moved = (SessionsActor, State, Seeded, PaneId, Arc<FakeZmx>);

/// An actor on [`movable`]'s store whose session moved to `to`.
fn moved_to(to: Workspace, git: &Arc<FakeGit>) -> Result<Moved, Report<StoreError>> {
    let (store, seeded, second) = movable()?;
    let (mut actor, state) = start_with(store, &listing(Vec::new()), git, Path::new(NO_CLAUDE_DIR));
    let (zmx, service) = recording_zmx();
    actor.services.zmx = service;
    let job = actor.change_workspace(seeded.session, to, None);
    finish(&mut actor, job);
    Ok((actor, state, seeded, second, zmx))
}

/// The directory session `id` shows.
fn dir_of(state: &State, id: SessionId) -> Option<PathBuf> {
    state
        .read()
        .sessions
        .session(id)
        .map(|session| session.dir.clone())
}

#[rstest::rstest]
fn change_workspace_kills_every_pane() -> Result<(), Report<StoreError>> {
    // Given a session with two panes, before any agent turn.
    let to = tempfile::tempdir().change_context(StoreError)?;

    // When moving it to another existing directory.
    let (_actor, _state, seeded, second, zmx) =
        moved_to(Workspace::Existing(to.path().to_owned()), &FakeGit::local())?;

    // Then both its panes are killed.
    assert_eq!(
        killed(&zmx),
        vec![seeded.pane.zmx_name(), second.zmx_name()],
        "a moved session's panes start over"
    );
    Ok(())
}

#[rstest::rstest]
fn change_workspace_moves_the_sessions_dir() -> Result<(), Report<StoreError>> {
    // Given a session in the checkout, before any agent turn.
    let to = tempfile::tempdir().change_context(StoreError)?;

    // When moving it to another existing directory.
    let (_actor, state, seeded, _, _) =
        moved_to(Workspace::Existing(to.path().to_owned()), &FakeGit::local())?;

    // Then it shows in that directory.
    assert_eq!(
        dir_of(&state, seeded.session),
        Some(to.path().to_owned()),
        "the session should run in its new workspace"
    );
    Ok(())
}

#[rstest::rstest]
fn change_workspace_saves_every_panes_cwd() -> Result<(), Report<StoreError>> {
    // Given a session with two panes, before any agent turn.
    let to = tempfile::tempdir().change_context(StoreError)?;

    // When moving it to another existing directory.
    let (actor, _state, _, _, _) =
        moved_to(Workspace::Existing(to.path().to_owned()), &FakeGit::local())?;

    // Then both panes are saved there.
    let cwds: Vec<PathBuf> = actor
        .store
        .layouts()?
        .panes
        .into_iter()
        .map(|pane| pane.cwd)
        .collect();
    assert_eq!(
        cwds,
        vec![to.path().to_owned(); 2],
        "every pane should start in the new workspace"
    );
    Ok(())
}

#[rstest::rstest]
fn change_workspace_unbinds_the_agents_in_its_panes() -> Result<(), Report<StoreError>> {
    // Given agent aa in a session's pane, before any agent turn.
    let to = tempfile::tempdir().change_context(StoreError)?;

    // When moving the session.
    let (actor, _state, _, _, _) =
        moved_to(Workspace::Existing(to.path().to_owned()), &FakeGit::local())?;

    // Then aa runs in no pane.
    assert_eq!(
        saved(&actor.store, "aa")?.pane_id,
        None,
        "a killed agent leaves its pane"
    );
    Ok(())
}

#[rstest::rstest]
fn change_workspace_asks_the_frontend_to_attach() -> Result<(), Report<StoreError>> {
    // Given a session before any agent turn.
    let to = tempfile::tempdir().change_context(StoreError)?;

    // When moving it.
    let (actor, _state, seeded, _, _) =
        moved_to(Workspace::Existing(to.path().to_owned()), &FakeGit::local())?;

    // Then the frontend is asked to attach it again.
    assert_eq!(
        ready_of(&actor),
        Some(seeded.session),
        "fresh shells start when the frontend attaches"
    );
    Ok(())
}

#[rstest::rstest]
fn change_workspace_after_a_turn_is_refused() -> Result<(), Report<StoreError>> {
    // Given a session whose agent is titled, so a turn has run.
    let (store, seeded, _) = movable()?;
    resave(&store, "aa", |row| AgentRow {
        title: Some("Fix the parser".to_owned()),
        ..row
    })?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    let to = tempfile::tempdir().change_context(StoreError)?;

    // When moving it.
    let job = actor.change_workspace(
        seeded.session,
        Workspace::Existing(to.path().to_owned()),
        None,
    );
    finish(&mut actor, job);

    // Then it stays, locked.
    assert_eq!(
        (dir_of(&state, seeded.session), error_of(&actor)),
        (
            Some(PathBuf::from(PROJECT_ROOT)),
            Some("Workspace locked · Local checkout".to_owned())
        ),
        "a session that had a turn keeps its workspace"
    );
    Ok(())
}

#[rstest::rstest]
fn move_whose_session_was_deleted_meanwhile_removes_its_worktree() -> Result<(), Report<StoreError>>
{
    // Given a move of aa's session to a new worktree, and the session
    // deleted while the worktree is made.
    let (store, seeded, _) = movable()?;
    let git = FakeGit::local();
    let (mut actor, _state) =
        start_with(store, &listing(Vec::new()), &git, Path::new(NO_CLAUDE_DIR));
    let job = actor.change_workspace(seeded.session, new_worktree(), None);
    delete(&mut actor, seeded.session);

    // When the worktree result is applied.
    finish(&mut actor, job);

    // Then the worktree and branch orb made are force-removed.
    assert!(
        made_worktree_removed(&git)?,
        "a move of a deleted session leaves no worktree, got {:?}",
        git.calls()
    );
    Ok(())
}

#[rstest::rstest]
fn move_whose_session_was_deleted_meanwhile_shows_the_session_is_gone()
-> Result<(), Report<StoreError>> {
    // Given a move of aa's session to a new worktree, and the session
    // deleted while the worktree is made.
    let (store, seeded, _) = movable()?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    let job = actor.change_workspace(seeded.session, new_worktree(), None);
    delete(&mut actor, seeded.session);

    // When the worktree result is applied.
    finish(&mut actor, job);

    // Then the move says the session is gone.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("the session is gone"),
        "a move of a deleted session says so"
    );
    Ok(())
}

/// Gives agent `agent` a title in the app state, as its first turn
/// does.
fn title_in_state(state: &State, agent: AgentId) {
    if let Some(agent) = super::agent_mut(&mut state.write().sessions, agent) {
        agent.title = Some("Fix the parser".to_owned());
    }
}

#[rstest::rstest]
fn move_whose_session_had_a_turn_meanwhile_is_refused() -> Result<(), Report<StoreError>> {
    // Given a move of aa's session to a new worktree, and aa's first
    // turn while the worktree is made.
    let (store, seeded, _) = movable()?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    let job = actor.change_workspace(seeded.session, new_worktree(), None);
    title_in_state(&state, seeded.agent);

    // When the worktree result is applied.
    finish(&mut actor, job);

    // Then it stays, locked.
    assert_eq!(
        (dir_of(&state, seeded.session), error_of(&actor)),
        (
            Some(PathBuf::from(PROJECT_ROOT)),
            Some("Workspace locked · Local checkout".to_owned())
        ),
        "a session that had a turn meanwhile keeps its workspace"
    );
    Ok(())
}

#[rstest::rstest]
fn move_whose_session_had_a_turn_meanwhile_removes_its_worktree() -> Result<(), Report<StoreError>>
{
    // Given a move of aa's session to a new worktree, and aa's first
    // turn while the worktree is made.
    let (store, seeded, _) = movable()?;
    let git = FakeGit::local();
    let (mut actor, state) =
        start_with(store, &listing(Vec::new()), &git, Path::new(NO_CLAUDE_DIR));
    let job = actor.change_workspace(seeded.session, new_worktree(), None);
    title_in_state(&state, seeded.agent);

    // When the worktree result is applied.
    finish(&mut actor, job);

    // Then the worktree and branch orb made are force-removed.
    assert!(
        made_worktree_removed(&git)?,
        "a refused move leaves no worktree, got {:?}",
        git.calls()
    );
    Ok(())
}

/// A store holding sessions of the orb project in the orb worktree
/// `old`, for agents aa and, when `shared`, bb.
fn in_orb_worktree(old: &Path, shared: bool) -> Result<(Store, Seeded), Report<StoreError>> {
    let store = Store::open_in_memory()?;
    let project = orb_project(&store)?;
    let insert = |short_id: &str| {
        seed_with(
            &store,
            "claude",
            project,
            SessionKind::Plain,
            old,
            short_id,
            now_ms() - HOUR_MS,
        )
    };
    let seeded = insert("aa")?;
    if shared {
        insert("bb")?;
    }
    Ok((store, seeded))
}

#[rstest::rstest]
fn change_workspace_removes_the_old_orb_worktree() -> Result<(), Report<StoreError>> {
    // Given a session alone in an orb worktree.
    let old = PathBuf::from("/nonexistent/worktrees/orb/orb-0a1b2c3d");
    let (store, seeded) = in_orb_worktree(&old, false)?;
    let git = FakeGit::local();
    let (mut actor, _state) =
        start_with(store, &listing(Vec::new()), &git, Path::new(NO_CLAUDE_DIR));

    // When moving it to the checkout.
    let job = actor.change_workspace(seeded.session, Workspace::Checkout, None);
    finish(&mut actor, job);

    // Then the old worktree and its branch are removed, without force.
    assert_eq!(
        git.calls(),
        vec![
            GitCall::RemoveWorktree {
                path: old,
                force: false
            },
            GitCall::DeleteBranch {
                branch: "orb/0a1b2c3d".to_owned(),
                force: false
            },
        ],
        "an orb worktree no session uses should go"
    );
    Ok(())
}

#[rstest::rstest]
fn change_workspace_keeps_an_old_worktree_another_session_uses() -> Result<(), Report<StoreError>> {
    // Given two sessions in the same orb worktree.
    let old = PathBuf::from("/nonexistent/worktrees/orb/orb-0a1b2c3d");
    let (store, seeded) = in_orb_worktree(&old, true)?;
    let git = FakeGit::local();
    let (mut actor, _state) =
        start_with(store, &listing(Vec::new()), &git, Path::new(NO_CLAUDE_DIR));

    // When moving one of them to the checkout.
    let job = actor.change_workspace(seeded.session, Workspace::Checkout, None);
    finish(&mut actor, job);

    // Then git removes nothing.
    assert!(
        git.calls().is_empty(),
        "a worktree another session uses stays"
    );
    Ok(())
}

#[rstest::rstest]
fn failed_change_workspace_removes_the_new_worktree() -> Result<(), Report<StoreError>> {
    // Given a session whose store refuses to move it.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    let store = Store::open(&path)?;
    let seeded = insert_agent(&store, "aa")?;
    rusqlite::Connection::open(&path)
        .and_then(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER refuse BEFORE UPDATE OF dir ON sessions
                     BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
        })
        .change_context(StoreError)?;
    let git = FakeGit::local();
    let (mut actor, _state) =
        start_with(store, &listing(Vec::new()), &git, Path::new(NO_CLAUDE_DIR));

    // When moving it to a new worktree.
    let job = actor.change_workspace(
        seeded.session,
        Workspace::NewWorktree {
            base: "main".to_owned(),
        },
        None,
    );
    finish(&mut actor, job);

    // Then the worktree and branch orb made are force-removed.
    let (path, branch) = git
        .added()
        .ok_or_else(|| Report::new(StoreError).attach("no worktree was added"))?;
    let calls = git.calls();
    assert!(
        calls.contains(&GitCall::RemoveWorktree { path, force: true })
            && calls.contains(&GitCall::DeleteBranch {
                branch,
                force: true
            }),
        "a failed move leaves no worktree or branch, got {calls:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn failed_change_workspace_to_an_existing_worktree_removes_no_worktree()
-> Result<(), Report<StoreError>> {
    // Given a session whose store refuses to move it, and a worktree that
    // already exists.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let worktree = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    let store = Store::open(&path)?;
    let seeded = insert_agent(&store, "aa")?;
    rusqlite::Connection::open(&path)
        .and_then(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER refuse BEFORE UPDATE OF dir ON sessions
                     BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
        })
        .change_context(StoreError)?;
    let git = FakeGit::local();
    let (mut actor, _state) =
        start_with(store, &listing(Vec::new()), &git, Path::new(NO_CLAUDE_DIR));

    // When moving it to that worktree.
    let job = actor.change_workspace(
        seeded.session,
        Workspace::Existing(worktree.path().to_owned()),
        None,
    );
    finish(&mut actor, job);

    // Then git is asked to remove no worktree and delete no branch.
    let calls = git.calls();
    assert!(
        !calls.iter().any(|call| matches!(
            call,
            GitCall::RemoveWorktree { .. } | GitCall::DeleteBranch { .. }
        )),
        "a worktree orb didn't make stays, got {calls:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn change_workspace_whose_fetch_fails_keeps_the_session_where_it_was()
-> Result<(), Report<StoreError>> {
    // Given a session in the checkout of a project whose fetch fails.
    let git = FakeGit::with_origin(Err("fatal: unable to access origin"));

    // When moving it to a new worktree from main.
    let (actor, state, seeded, _, _) = moved_to(
        Workspace::NewWorktree {
            base: "main".to_owned(),
        },
        &git,
    )?;

    // Then it stays in the checkout, with git's reason shown.
    assert_eq!(
        (dir_of(&state, seeded.session), error_of(&actor)),
        (
            Some(PathBuf::from(PROJECT_ROOT)),
            Some("fatal: unable to access origin".to_owned())
        ),
        "a move that can't reach its workspace keeps the session"
    );
    Ok(())
}

/// A ref named `name`, on a remote when `remote`, checked out nowhere.
fn git_ref(name: &str, remote: bool) -> GitRef {
    GitRef {
        name: name.to_owned(),
        remote,
        current: false,
        default: false,
        worktree: None,
    }
}

/// The branch session `id` shows.
fn branch_of(state: &State, id: SessionId) -> Option<String> {
    state.read().sessions.session(id)?.branch.clone()
}

#[rstest::rstest]
fn switch_branch_checks_out_in_the_sessions_dir() -> Result<(), Report<StoreError>> {
    // Given a session in the orb project's checkout.
    let store = Store::open_in_memory()?;
    let seeded = insert_agent(&store, "aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When switching it to `feat`.
    actor.switch_branch(seeded.session, &git_ref("feat", false), false, None);

    // Then the sidebar shows it on feat.
    assert_eq!(
        branch_of(&state, seeded.session).as_deref(),
        Some("feat"),
        "the session should show its new branch"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn switch_branch_refused_after_the_directory_became_busy() -> Result<(), Report<StoreError>> {
    // Given a session whose agent's turn started after the picker opened.
    let store = Store::open_in_memory()?;
    let seeded = insert_agent(&store, "aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.poll().await;

    // When switching it to `feat`.
    actor.switch_branch(seeded.session, &git_ref("feat", false), false, None);

    // Then the mode line says an agent is working there.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("A session is working in this directory"),
        "a checkout under a running turn should be refused"
    );
    Ok(())
}

#[rstest::rstest]
fn switch_to_a_remote_ref_shows_the_local_branch_name() -> Result<(), Report<StoreError>> {
    // Given a session in the orb project's checkout.
    let store = Store::open_in_memory()?;
    let seeded = insert_agent(&store, "aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When switching it to `origin/feat`.
    actor.switch_branch(seeded.session, &git_ref("origin/feat", true), false, None);

    // Then the sidebar shows the tracking branch feat.
    assert_eq!(
        branch_of(&state, seeded.session).as_deref(),
        Some("feat"),
        "a remote ref checks out as its local branch"
    );
    Ok(())
}

#[rstest::rstest]
fn switch_branch_to_root_moves_the_session_to_the_checkout() -> Result<(), Report<StoreError>> {
    // Given a session with no turn in an orb worktree of a project on disk.
    let root = tempfile::tempdir().change_context(StoreError)?;
    let store = Store::open_in_memory()?;
    let project = store.add_project(root.path(), "orb", ProjectKind::Normal, 0)?;
    let seeded = seed_with(
        &store,
        "claude",
        project,
        SessionKind::Plain,
        &Path::new(WORKTREES_ROOT).join("orb/orb-0123abcd"),
        "aa",
        now_ms() - HOUR_MS,
    )?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));

    // When picking the default branch, checked out nowhere.
    actor.switch_branch(seeded.session, &git_ref("main", false), true, None);

    // Then the session runs in the checkout.
    assert_eq!(
        dir_of(&state, seeded.session),
        Some(root.path().to_owned()),
        "the session should move back to the checkout"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_end_renames_the_hex_branch_to_the_title_slug() -> Result<(), Report<StoreError>> {
    // Given an agent in an orb worktree on its hex branch, titled by Claude.
    let (claude_dir, store, id) =
        worktree_agent(&format!("{PROMPT_LINE}{AI_TITLE_LINE}"), HEX_BRANCH)?;
    let host = listing(Vec::new());
    let (mut actor, state) = start_with(store, &host, &FakeGit::local(), claude_dir.path());

    // When a poll sees its turn end.
    end_turn(&mut actor, &host).await;

    // Then the agent shows the branch named after its title.
    assert_eq!(
        shown(&state, id).and_then(|agent| agent.branch).as_deref(),
        Some("orb/parser-fix"),
        "the hex branch should be renamed to the title's slug"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_end_renames_the_hex_branch_to_the_orb_name_slug() -> Result<(), Report<StoreError>> {
    // Given an agent on its hex branch titled only by its first prompt,
    // then renamed with `r`.
    let (claude_dir, store, id) = worktree_agent(PROMPT_LINE, HEX_BRANCH)?;
    resave(&store, "aa", |row| AgentRow {
        renamed_title: Some("Sidebar search".to_owned()),
        ..row
    })?;
    let host = listing(Vec::new());
    let (mut actor, state) = start_with(store, &host, &FakeGit::local(), claude_dir.path());

    // When a poll sees its turn end.
    end_turn(&mut actor, &host).await;

    // Then the agent shows the branch named after the orb name.
    assert_eq!(
        shown(&state, id).and_then(|agent| agent.branch).as_deref(),
        Some("orb/sidebar-search"),
        "the hex branch should be renamed to the orb name's slug"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_end_rename_moves_the_session_to_the_new_branch() -> Result<(), Report<StoreError>> {
    // Given a Claude-titled agent in its own session in an orb worktree,
    // both on the hex branch.
    let claude_dir = tempfile::tempdir().change_context(StoreError)?;
    let path = transcript_path(claude_dir.path(), Path::new(HEX_WORKTREE), "aa");
    fs::create_dir_all(path.parent().unwrap_or(claude_dir.path())).change_context(StoreError)?;
    fs::write(&path, format!("{PROMPT_LINE}{AI_TITLE_LINE}")).change_context(StoreError)?;
    let store = Store::open_in_memory()?;
    let session = insert_in(&store, "aa", Path::new(HEX_WORKTREE), Some(HEX_BRANCH))?.session;
    resave_sessions(&store, |row| SessionRow {
        branch: Some(HEX_BRANCH.to_owned()),
        ..row
    })?;
    let host = listing(Vec::new());
    let (mut actor, state) = start_with(store, &host, &FakeGit::local(), claude_dir.path());

    // When a poll sees its turn end.
    end_turn(&mut actor, &host).await;

    // Then the session shows the renamed branch.
    assert_eq!(
        branch_of(&state, session).as_deref(),
        Some("orb/parser-fix"),
        "the session's branch should follow the rename"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn no_rename_when_the_branch_is_not_the_hex_branch() -> Result<(), Report<StoreError>> {
    // Given a Claude-titled agent in an orb worktree on another branch.
    let (claude_dir, store, _) = worktree_agent(&format!("{PROMPT_LINE}{AI_TITLE_LINE}"), "main")?;
    let host = listing(Vec::new());
    let git = FakeGit::local();
    let (mut actor, _state) = start_with(store, &host, &git, claude_dir.path());

    // When a poll sees its turn end.
    end_turn(&mut actor, &host).await;

    // Then no branch was renamed.
    assert_eq!(git.renamed(), None, "only orb's hex branch is renamed");
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn no_rename_with_only_a_prompt_title() -> Result<(), Report<StoreError>> {
    // Given an agent on its hex branch titled only by its first prompt.
    let (claude_dir, store, _) = worktree_agent(PROMPT_LINE, HEX_BRANCH)?;
    let host = listing(Vec::new());
    let git = FakeGit::local();
    let (mut actor, _state) = start_with(store, &host, &git, claude_dir.path());

    // When a poll sees its turn end.
    end_turn(&mut actor, &host).await;

    // Then no branch was renamed.
    assert_eq!(git.renamed(), None, "a prompt title isn't enough to rename");
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn no_rename_when_the_slug_branch_exists() -> Result<(), Report<StoreError>> {
    // Given a Claude-titled agent on its hex branch, and `orb/parser-fix` taken.
    let (claude_dir, store, _) =
        worktree_agent(&format!("{PROMPT_LINE}{AI_TITLE_LINE}"), HEX_BRANCH)?;
    let host = listing(Vec::new());
    let git = FakeGit::having("orb/parser-fix");
    let (mut actor, _state) = start_with(store, &host, &git, claude_dir.path());

    // When a poll sees its turn end.
    end_turn(&mut actor, &host).await;

    // Then no branch was renamed.
    assert_eq!(
        git.renamed(),
        None,
        "an existing slug branch keeps the old name"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn no_rename_without_a_turn_end() -> Result<(), Report<StoreError>> {
    // Given a Claude-titled agent on its hex branch.
    let (claude_dir, store, _) =
        worktree_agent(&format!("{PROMPT_LINE}{AI_TITLE_LINE}"), HEX_BRANCH)?;
    let host = listing(vec![in_session(AgentStatus::Working)]);
    let git = FakeGit::local();
    let (mut actor, _state) = start_with(store, &host, &git, claude_dir.path());

    // When polls see its turn still underway.
    actor.poll().await;
    actor.poll().await;

    // Then no branch was renamed.
    assert_eq!(git.renamed(), None, "the rename waits for the turn to end");
    Ok(())
}

/// The status changes `actor` reported for announcing, oldest first.
fn notices_of(actor: &SessionsActor) -> Vec<Notice> {
    actor
        .report
        .outcomes()
        .into_iter()
        .filter_map(|outcome| match outcome {
            Outcome::Announce(notice) => Some(notice),
            _ => None,
        })
        .collect()
}

#[rstest::rstest]
#[case(AgentStatus::Unknown, AgentStatus::Idle, None)]
#[case(AgentStatus::Unknown, AgentStatus::NeedsApproval, None)]
#[case(AgentStatus::Working, AgentStatus::Idle, Some(NoticeKind::Finished))]
#[case(
    AgentStatus::NeedsApproval,
    AgentStatus::Idle,
    Some(NoticeKind::Finished)
)]
#[case(
    AgentStatus::Working,
    AgentStatus::NeedsApproval,
    Some(NoticeKind::NeedsApproval)
)]
#[case(
    AgentStatus::Working,
    AgentStatus::NeedsInput,
    Some(NoticeKind::NeedsInput)
)]
#[case(AgentStatus::NeedsApproval, AgentStatus::NeedsApproval, None)]
#[case(
    AgentStatus::NeedsApproval,
    AgentStatus::NeedsInput,
    Some(NoticeKind::NeedsInput)
)]
#[case(AgentStatus::Idle, AgentStatus::Idle, None)]
#[case(AgentStatus::Working, AgentStatus::Failed, None)]
#[case(AgentStatus::Working, AgentStatus::Stopped, None)]
fn notice_kind_names_why_a_status_change_needs_the_user(
    #[case] old: AgentStatus,
    #[case] new: AgentStatus,
    #[case] expected: Option<NoticeKind>,
) {
    assert_eq!(notice_kind(old, new), expected, "{old:?} → {new:?}");
}

#[rstest::rstest]
#[tokio::test]
async fn first_poll_after_restore_queues_no_notice() -> Result<(), Report<StoreError>> {
    // Given a saved agent that was already waiting for an approval at launch.
    let (store, _) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::NeedsApproval)]);
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When polling for the first time.
    actor.poll().await;

    // Then no notice is queued.
    assert_eq!(
        notices_of(&actor),
        [],
        "a state that existed at launch shouldn't notify"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_end_queues_a_finished_notice_naming_project_and_agent()
-> Result<(), Report<StoreError>> {
    // Given orb's agent titled "Parser fix".
    let (store, id) = store_with_agent("aa")?;
    resave(&store, "aa", |row| AgentRow {
        custom_title: Some("Parser fix".to_owned()),
        ..row
    })?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // When polls see its turn run and then end.
    end_turn(&mut actor, &host).await;

    // Then one Finished notice names the project and the agent.
    assert_eq!(
        notices_of(&actor),
        [Notice {
            agent: id,
            kind: NoticeKind::Finished,
            project: "orb".to_owned(),
            title: "Parser fix".to_owned(),
        }],
        "the ended turn's notice"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_reports_each_notice_as_an_announcement() -> Result<(), Report<StoreError>> {
    // Given two agents whose turns are running.
    let (store, aa) = store_with_agent("aa")?;
    let bb = add_agent(&store, "bb", now_ms() - HOUR_MS)?;
    let host = listing(vec![
        record("aa", AgentStatus::Working),
        record("bb", AgentStatus::Working),
    ]);
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.poll().await;

    // When one poll sees both turns end.
    host.set_running(Ok(vec![
        record("aa", AgentStatus::Idle),
        record("bb", AgentStatus::Idle),
    ]));
    actor.poll().await;

    // Then each ended turn is reported for announcing on its own.
    let mut announced: Vec<AgentId> = actor
        .report
        .outcomes()
        .into_iter()
        .filter_map(|outcome| match outcome {
            Outcome::Announce(notice) => Some(notice.agent),
            _ => None,
        })
        .collect();
    announced.sort_by_key(|agent| agent.0);
    assert_eq!(announced, [aa, bb], "one announcement per ended turn");
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn a_wait_seen_by_two_polls_queues_one_notice() -> Result<(), Report<StoreError>> {
    // Given an agent whose turn is running.
    let (store, _) = store_with_agent("aa")?;
    let host = listing(vec![in_session(AgentStatus::Working)]);
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.poll().await;

    // When two polls in a row see it waiting for an approval.
    host.set_running(Ok(vec![in_session(AgentStatus::NeedsApproval)]));
    actor.poll().await;
    actor.poll().await;

    // Then one NeedsApproval notice is queued.
    let kinds: Vec<NoticeKind> = notices_of(&actor)
        .into_iter()
        .map(|notice| notice.kind)
        .collect();
    assert_eq!(
        kinds,
        [NoticeKind::NeedsApproval],
        "the same wait should notify once"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_end_of_an_agent_being_deleted_queues_no_notice() -> Result<(), Report<StoreError>> {
    // Given an agent whose turn is running, then marked for deletion.
    let (store, id) = store_with_agent("aa")?;
    let host = listing(vec![in_session(AgentStatus::Working)]);
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.poll().await;
    state.write().sessions.deleting.insert(SessionId(id.0));

    // When a poll sees its turn end.
    host.set_running(Ok(vec![in_session(AgentStatus::Idle)]));
    actor.poll().await;

    // Then no notice is queued.
    assert_eq!(
        notices_of(&actor),
        [],
        "an agent being deleted shouldn't notify"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_end_outside_the_project_filter_still_queues_a_notice()
-> Result<(), Report<StoreError>> {
    // Given orb's agent, with the sidebar filtered to another project.
    let (store, id) = store_with_agent("aa")?;
    let web = store.add_project(Path::new(WEB_ROOT), "web", ProjectKind::Normal, 0)?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    state.write().sessions.filter = Some(web);

    // When polls see its turn run and then end.
    end_turn(&mut actor, &host).await;

    // Then its notice is queued anyway.
    let notified: Vec<AgentId> = notices_of(&actor)
        .into_iter()
        .map(|notice| notice.agent)
        .collect();
    assert_eq!(notified, [id], "the filter shouldn't hide notices");
    Ok(())
}

/// The orb project, with the actor started on `git` and a temp folder as
/// orb's own directory.
fn creating(
    git: &Arc<FakeGit>,
) -> Result<(tempfile::TempDir, ProjectId, SessionsActor, State), Report<StoreError>> {
    let orb_root = tempfile::tempdir().change_context(StoreError)?;
    let store = Store::open_in_memory()?;
    let orb = orb_project(&store)?;
    let (actor, state) = start_in(
        store,
        &listing(Vec::new()),
        git,
        Path::new(NO_CLAUDE_DIR),
        orb_root.path(),
        Path::new(INCOGNITO_ROOT),
    );
    Ok((orb_root, orb, actor, state))
}

/// orb's own world of `kind`, which start adds.
fn world_of(state: &State, kind: ProjectKind) -> ProjectId {
    state
        .read()
        .sessions
        .own_project(kind)
        .map_or(ProjectId(0), |project| project.id)
}

#[rstest::rstest]
fn new_research_session_seeds_a_missing_template() -> Result<(), Report<StoreError>> {
    // Given no Research template.
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;

    // When making Research session `tokio-cancel`.
    make_colony(
        &mut actor,
        world_of(&state, ProjectKind::Research),
        "tokio-cancel",
    );

    // Then the template is written.
    assert!(
        orb_root
            .path()
            .join("templates/research/AGENTS.md")
            .is_file(),
        "a missing template should be seeded"
    );
    Ok(())
}

#[rstest::rstest]
fn new_research_session_copies_the_template_into_its_folder() -> Result<(), Report<StoreError>> {
    // Given no Research template.
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;

    // When making Research session `tokio-cancel`.
    make_colony(
        &mut actor,
        world_of(&state, ProjectKind::Research),
        "tokio-cancel",
    );

    // Then its folder has AGENTS.md and a CLAUDE.md link to it.
    let dir = orb_root.path().join("research/tokio-cancel");
    let link = fs::read_link(dir.join("CLAUDE.md")).change_context(StoreError)?;
    assert_eq!(
        (dir.join("AGENTS.md").is_file(), link),
        (true, PathBuf::from("AGENTS.md")),
        "the folder should be the template's copy"
    );
    Ok(())
}

#[rstest::rstest]
fn new_research_session_copies_the_kit() -> Result<(), Report<StoreError>> {
    // Given no Research template.
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;

    // When making Research session `tokio-cancel`.
    make_colony(
        &mut actor,
        world_of(&state, ProjectKind::Research),
        "tokio-cancel",
    );

    // Then its folder has the kit's investigator subagent.
    assert!(
        orb_root
            .path()
            .join("research/tokio-cancel/.claude/agents/investigator.md")
            .is_file(),
        "the folder should get the research kit"
    );
    Ok(())
}

#[rstest::rstest]
fn new_learn_session_uses_the_learn_folder() -> Result<(), Report<StoreError>> {
    // Given no Learn project.
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;

    // When making Learn session `rust-async`.
    make_colony(
        &mut actor,
        world_of(&state, ProjectKind::Learn),
        "rust-async",
    );

    // Then its folder is under orb's learn folder.
    assert!(
        orb_root.path().join("learn/rust-async").is_dir(),
        "a Learn session's folder should be under learn/"
    );
    Ok(())
}

#[rstest::rstest]
fn new_research_session_is_a_colony() -> Result<(), Report<StoreError>> {
    // Given no Research project.
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;

    // When making Research session `tokio-cancel`.
    make_colony(
        &mut actor,
        world_of(&state, ProjectKind::Research),
        "tokio-cancel",
    );

    // Then a colony runs in its folder.
    let session = only_session(&state)?;
    assert_eq!(
        (session.kind, session.dir),
        (
            SessionKind::Colony,
            orb_root.path().join("research/tokio-cancel")
        ),
        "the session should be a colony in its folder"
    );
    Ok(())
}

#[rstest::rstest]
fn new_learn_session_has_one_tab_with_one_shell_pane() -> Result<(), Report<StoreError>> {
    // Given no Learn project.
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;

    // When making Learn session `rust-async`.
    make_colony(
        &mut actor,
        world_of(&state, ProjectKind::Learn),
        "rust-async",
    );

    // Then its layout holds one tab of one pane in its folder.
    let id = only_session(&state)?.id;
    let app = state.read();
    let shape = app.layouts.get(id).map(|layout| {
        (
            layout.tabs().len(),
            layout
                .panes()
                .map(|pane| pane.cwd.clone())
                .collect::<Vec<_>>(),
        )
    });
    assert_eq!(
        shape,
        Some((1, vec![orb_root.path().join("learn/rust-async")])),
        "a Learn session holds one tab of one shell pane"
    );
    Ok(())
}

#[rstest::rstest]
fn new_folder_session_keeps_a_curated_template() -> Result<(), Report<StoreError>> {
    // Given a Research template the user wrote.
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;
    let template = orb_root.path().join("templates/research");
    fs::create_dir_all(&template).change_context(StoreError)?;
    fs::write(template.join("AGENTS.md"), "mine").change_context(StoreError)?;

    // When making Research session `tokio-cancel`.
    make_colony(
        &mut actor,
        world_of(&state, ProjectKind::Research),
        "tokio-cancel",
    );

    // Then the folder gets the user's AGENTS.md.
    let text = fs::read_to_string(orb_root.path().join("research/tokio-cancel/AGENTS.md"))
        .change_context(StoreError)?;
    assert_eq!(text, "mine", "a curated template should be copied as is");
    Ok(())
}

#[rstest::rstest]
fn new_folder_session_refused_when_its_folder_exists() -> Result<(), Report<StoreError>> {
    // Given a folder `x` already under orb's research folder, with orb's
    // folder as home.
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;
    fs::create_dir_all(orb_root.path().join("research/x")).change_context(StoreError)?;
    state.write().home = orb_root.path().to_path_buf();

    // When making Research session `x`.
    make_colony(&mut actor, world_of(&state, ProjectKind::Research), "x");

    // Then the mode line says the folder exists.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("~/research/x already exists"),
        "an existing folder should be refused"
    );
    Ok(())
}

#[rstest::rstest]
fn refused_folder_session_adds_no_session() -> Result<(), Report<StoreError>> {
    // Given a folder `x` already under orb's research folder.
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;
    fs::create_dir_all(orb_root.path().join("research/x")).change_context(StoreError)?;

    // When making Research session `x`.
    make_colony(&mut actor, world_of(&state, ProjectKind::Research), "x");

    // Then no session shows.
    assert!(
        state.read().sessions.sessions.is_empty(),
        "a refused session should leave nothing"
    );
    Ok(())
}

/// Opens the `New colony` box for a colony in `world` holding `text`, as
/// `⏎` leaves it: waiting for the actor, with the keys.
fn waiting_name_box(state: &State, world: ProjectId, text: &str) {
    let mut app = state.write();
    app.rename = Some(Rename {
        target: RenameTarget::NewColony(world),
        input: TextInput::new(text),
        creating: true,
    });
    app.focus = Focus::Rename;
}

/// The name box's text and whether it waits, and the focus.
fn name_box_of(state: &State) -> (Option<(String, bool)>, Focus) {
    let app = state.read();
    let shown = app
        .rename
        .as_ref()
        .map(|rename| (rename.input.text().to_owned(), rename.creating));
    (shown, app.focus)
}

#[rstest::rstest]
fn made_folder_session_closes_the_name_box() -> Result<(), Report<StoreError>> {
    // Given the name box waiting for Research session `tokio-cancel`.
    let (_orb_root, _, mut actor, state) = creating(&FakeGit::local())?;
    waiting_name_box(
        &state,
        world_of(&state, ProjectKind::Research),
        "tokio cancel",
    );

    // When making it.
    make_colony(
        &mut actor,
        world_of(&state, ProjectKind::Research),
        "tokio-cancel",
    );

    // Then the box is closed and the sidebar has the keys.
    assert_eq!(
        name_box_of(&state),
        (None, Focus::Sidebar),
        "a made session should close its name box"
    );
    Ok(())
}

#[rstest::rstest]
fn refused_folder_name_keeps_the_name_box_open() -> Result<(), Report<StoreError>> {
    // Given the name box waiting for Research session `x`, whose folder
    // exists.
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;
    fs::create_dir_all(orb_root.path().join("research/x")).change_context(StoreError)?;
    waiting_name_box(&state, world_of(&state, ProjectKind::Research), "x");

    // When making it.
    make_colony(&mut actor, world_of(&state, ProjectKind::Research), "x");

    // Then the box stays open with the name, no longer waiting.
    assert_eq!(
        name_box_of(&state),
        (Some(("x".to_owned(), false)), Focus::Rename),
        "an existing folder should keep the name box open"
    );
    Ok(())
}

#[rstest::rstest]
fn new_folder_session_outside_the_filter_clears_it() -> Result<(), Report<StoreError>> {
    // Given the sidebar filtered to orb.
    let (_orb_root, orb, mut actor, state) = creating(&FakeGit::local())?;
    state.write().sessions.filter = Some(orb);

    // When making Research session `tokio-cancel`, outside orb.
    make_colony(
        &mut actor,
        world_of(&state, ProjectKind::Research),
        "tokio-cancel",
    );

    // Then the filter goes back to all projects.
    assert_eq!(
        state.read().sessions.filter,
        None,
        "a session outside the filter should clear it"
    );
    Ok(())
}

#[rstest::rstest]
fn new_folder_session_outside_the_filter_saves_the_cleared_filter() -> Result<(), Report<StoreError>>
{
    // Given the sidebar filtered to orb, and that saved.
    let (_orb_root, orb, mut actor, state) = creating(&FakeGit::local())?;
    state.write().sessions.filter = Some(orb);
    actor.save_ui();

    // When making Research session `tokio-cancel`, outside orb.
    make_colony(
        &mut actor,
        world_of(&state, ProjectKind::Research),
        "tokio-cancel",
    );

    // Then the store holds no filter.
    assert_eq!(
        actor.store.ui()?.project_filter,
        None,
        "the cleared filter should be saved"
    );
    Ok(())
}

#[rstest::rstest]
fn refused_folder_session_keeps_the_filter() -> Result<(), Report<StoreError>> {
    // Given the sidebar filtered to orb, and Research folder `x` on disk.
    let (orb_root, orb, mut actor, state) = creating(&FakeGit::local())?;
    fs::create_dir_all(orb_root.path().join("research/x")).change_context(StoreError)?;
    state.write().sessions.filter = Some(orb);

    // When making Research session `x`.
    make_colony(&mut actor, world_of(&state, ProjectKind::Research), "x");

    // Then the filter stays on orb.
    assert_eq!(
        state.read().sessions.filter,
        Some(orb),
        "a refused session should leave the filter alone"
    );
    Ok(())
}

/// Saves agent `short_id` in the orb project, created an hour ago, in a
/// session of its own in `cwd`, on `branch`.
fn insert_in(
    store: &Store,
    short_id: &str,
    cwd: &Path,
    branch: Option<&str>,
) -> Result<Seeded, Report<StoreError>> {
    let project_id = orb_project(store)?;
    let inserted = seed_with(
        store,
        "claude",
        project_id,
        SessionKind::Plain,
        cwd,
        short_id,
        now_ms() - HOUR_MS,
    )?;
    resave(store, short_id, |row| AgentRow {
        branch: branch.map(str::to_owned),
        ..row
    })?;
    Ok(inserted)
}

/// A store whose agent `aa` has a session in [`HEX_WORKTREE`], now
/// gone, on `branch`.
fn pruned_agent(branch: Option<&str>) -> Result<(Store, SessionId), Report<StoreError>> {
    let store = Store::open_in_memory()?;
    let inserted = insert_in(&store, "aa", Path::new(HEX_WORKTREE), branch)?;
    Ok((store, inserted.session))
}

/// The git calls an actor on `store` and `git` makes restoring `id`.
fn restore_calls(store: Store, git: &Arc<FakeGit>, id: SessionId) -> Vec<GitCall> {
    let (mut actor, _state) = start_with(store, &listing(vec![]), git, Path::new(NO_CLAUDE_DIR));
    let job = actor.restore_worktree(id);
    finish(&mut actor, job);
    git.calls()
}

#[rstest::rstest]
#[tokio::test]
async fn restore_on_an_existing_branch_adds_the_worktree_on_it() -> Result<(), Report<StoreError>> {
    // Given agent aa's pruned worktree, whose branch still exists.
    let (store, id) = pruned_agent(Some("fix-parser"))?;
    let git = FakeGit::having("fix-parser");

    // When restoring its worktree.
    let calls = restore_calls(store, &git, id);

    // Then the worktree is added back on that branch.
    assert!(
        calls.contains(&GitCall::AddWorktreeOn {
            path: PathBuf::from(HEX_WORKTREE),
            branch: "fix-parser".to_owned(),
        }),
        "an existing branch should be checked out in the restored worktree"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn restore_on_a_missing_branch_creates_it_from_the_default_branch()
-> Result<(), Report<StoreError>> {
    // Given agent aa's pruned worktree, whose branch is gone.
    let (store, id) = pruned_agent(Some("fix-parser"))?;
    let git = FakeGit::local();

    // When restoring its worktree.
    let calls = restore_calls(store, &git, id);

    // Then the branch is made again from the default branch.
    assert!(
        calls.contains(&GitCall::AddWorktree {
            path: PathBuf::from(HEX_WORKTREE),
            branch: "fix-parser".to_owned(),
            base: "main".to_owned(),
        }),
        "a gone branch should be made again from main"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn restore_with_a_gone_session_branch_uses_the_agents_existing_branch()
-> Result<(), Report<StoreError>> {
    // Given agent aa's pruned worktree, the session recorded on a hex
    // branch that is gone, the agent on fix-parser, which exists.
    let (store, id) = pruned_agent(Some("fix-parser"))?;
    resave_sessions(&store, |row| SessionRow {
        branch: Some(HEX_BRANCH.to_owned()),
        ..row
    })?;
    let git = FakeGit::having("fix-parser");

    // When restoring its worktree.
    let calls = restore_calls(store, &git, id);

    // Then the worktree comes back on the agent's branch.
    assert!(
        calls.contains(&GitCall::AddWorktreeOn {
            path: PathBuf::from(HEX_WORKTREE),
            branch: "fix-parser".to_owned(),
        }),
        "the work lives on the agent's branch, so the worktree goes there"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn restore_on_the_agents_branch_shows_it_on_the_session() -> Result<(), Report<StoreError>> {
    // Given agent aa's pruned worktree, the session recorded on a hex
    // branch that is gone, the agent on fix-parser, which exists.
    let (store, id) = pruned_agent(Some("fix-parser"))?;
    resave_sessions(&store, |row| SessionRow {
        branch: Some(HEX_BRANCH.to_owned()),
        ..row
    })?;
    let (mut actor, state) = start_with(
        store,
        &listing(vec![]),
        &FakeGit::having("fix-parser"),
        Path::new(NO_CLAUDE_DIR),
    );

    // When restoring its worktree.
    let job = actor.restore_worktree(id);
    finish(&mut actor, job);

    // Then the session shows fix-parser.
    assert_eq!(
        branch_of(&state, id).as_deref(),
        Some("fix-parser"),
        "the session should show the branch it came back on"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn restore_on_a_missing_branch_starts_from_origin() -> Result<(), Report<StoreError>> {
    // Given agent aa's pruned worktree, whose branch is gone, in a
    // project with an origin.
    let (store, id) = pruned_agent(Some("fix-parser"))?;
    let git = FakeGit::with_origin(Ok(true));

    // When restoring its worktree.
    let calls = restore_calls(store, &git, id);

    // Then the branch is made again from origin's default branch.
    assert!(
        calls.contains(&GitCall::AddWorktree {
            path: PathBuf::from(HEX_WORKTREE),
            branch: "fix-parser".to_owned(),
            base: "origin/main".to_owned(),
        }),
        "a gone branch should start from the fetched origin/main"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn restore_without_a_recorded_branch_uses_the_hex_branch() -> Result<(), Report<StoreError>> {
    // Given agent aa's pruned worktree, with no branch recorded.
    let (store, id) = pruned_agent(None)?;
    let git = FakeGit::local();

    // When restoring its worktree.
    let calls = restore_calls(store, &git, id);

    // Then the worktree comes back on orb's branch for its directory.
    assert!(
        calls.contains(&GitCall::AddWorktree {
            path: PathBuf::from(HEX_WORKTREE),
            branch: HEX_BRANCH.to_owned(),
            base: "main".to_owned(),
        }),
        "an agent with no branch should get orb/<hex> back"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn restore_prunes_stale_worktree_metadata_first() -> Result<(), Report<StoreError>> {
    // Given agent aa's pruned worktree.
    let (store, id) = pruned_agent(Some("fix-parser"))?;
    let git = FakeGit::local();

    // When restoring its worktree.
    let calls = restore_calls(store, &git, id);

    // Then git's record of the old worktree is pruned before anything
    // else.
    assert_eq!(
        calls.first(),
        Some(&GitCall::PruneWorktrees(PathBuf::from(PROJECT_ROOT))),
        "stale worktree metadata should be pruned first"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn restore_reports_ready_for_the_restored_session() -> Result<(), Report<StoreError>> {
    // Given agent aa's pruned worktree.
    let (store, id) = pruned_agent(Some("fix-parser"))?;
    let (mut actor, _state) = start_with(
        store,
        &listing(vec![]),
        &FakeGit::local(),
        Path::new(NO_CLAUDE_DIR),
    );

    // When restoring its worktree.
    let job = actor.restore_worktree(id);
    finish(&mut actor, job);

    // Then the session is ready to open while it is still the active one.
    assert!(
        actor.report.outcomes().contains(&Outcome::Ready {
            session: id,
            if_active: Some(id),
        }),
        "a restored session should open while it is still active"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn restore_failure_sets_the_error_and_no_attach() -> Result<(), Report<StoreError>> {
    // Given agent aa's pruned worktree, in a project git can't read.
    let (store, id) = pruned_agent(Some("fix-parser"))?;
    let (mut actor, _state) = start_with(
        store,
        &listing(vec![]),
        &FakeGit::plain(Ok(())),
        Path::new(NO_CLAUDE_DIR),
    );

    // When restoring its worktree.
    let job = actor.restore_worktree(id);
    finish(&mut actor, job);

    // Then git's reason shows and nothing opens.
    assert_eq!(
        (error_of(&actor).as_deref(), ready_of(&actor)),
        (Some(NOT_A_REPO), None),
        "a failed restore should show why and not attach"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn restore_ends_the_start() -> Result<(), Report<StoreError>> {
    // Given agent aa's pruned worktree, its restore marked as starting.
    let (store, id) = pruned_agent(Some("fix-parser"))?;
    let (mut actor, state) = start_with(
        store,
        &listing(vec![]),
        &FakeGit::local(),
        Path::new(NO_CLAUDE_DIR),
    );
    state.write().sessions.starting = true;

    // When restoring its worktree.
    let job = actor.restore_worktree(id);
    finish(&mut actor, job);

    // Then nothing is starting any more.
    assert!(
        !state.read().sessions.starting,
        "a finished restore should stop showing as starting"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn restore_of_a_directory_that_exists_runs_no_git() -> Result<(), Report<StoreError>> {
    // Given agent aa in a directory that is on disk.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let store = Store::open_in_memory()?;
    let id = insert_in(&store, "aa", dir.path(), Some("fix-parser"))?.session;
    let git = FakeGit::local();

    // When restoring its worktree.
    let calls = restore_calls(store, &git, id);

    // Then git is never asked to do anything.
    assert!(
        calls.is_empty(),
        "a worktree already back should need no git"
    );
    Ok(())
}

/// Claude agent `aa` in a pane of its own and a shell pane beside it in
/// the same session, the actor reading pane files under a scratch orb
/// folder.
struct PaneReports {
    dir: tempfile::TempDir,
    agent: Seeded,
    shell: PaneId,
    actor: SessionsActor,
    state: State,
}

impl PaneReports {
    fn new() -> Result<Self, Report<StoreError>> {
        Self::with(|_, _| Ok(()))
    }

    /// The fixture, with `setup` run on its store and `aa`'s pane first.
    fn with<F>(setup: F) -> Result<Self, Report<StoreError>>
    where
        F: FnOnce(&Store, &Seeded) -> Result<(), Report<StoreError>>,
    {
        let dir = tempfile::tempdir().change_context(StoreError)?;
        let store = Store::open_in_memory()?;
        let agent = insert_agent(&store, "aa")?;
        let shell = second_tab(&store, &agent)?;
        setup(&store, &agent)?;
        let host = listing(Vec::new());
        let (actor, state) = start_in(
            store,
            &host,
            &FakeGit::local(),
            Path::new(NO_CLAUDE_DIR),
            dir.path(),
            Path::new(INCOGNITO_ROOT),
        );
        Ok(Self {
            dir,
            agent,
            shell,
            actor,
            state,
        })
    }

    /// Pane `pane`'s file.
    fn file(&self, pane: PaneId) -> PathBuf {
        self.dir
            .path()
            .join("panes")
            .join(format!("{}.json", pane.0))
    }

    /// Writes Claude's `event` report of conversation `session_id` from
    /// `pane`, started for `source`, its transcript `/t/<id>.jsonl`.
    fn report(
        &self,
        pane: PaneId,
        event: &str,
        session_id: &str,
        source: Option<&str>,
    ) -> Result<(), Report<StoreError>> {
        fs::create_dir_all(self.dir.path().join("panes")).change_context(StoreError)?;
        let json = serde_json::json!({
            "agent": "claude",
            "event": event,
            "session_id": session_id,
            "transcript": format!("/t/{session_id}.jsonl"),
            "source": source,
            "at": now_ms(),
        });
        fs::write(self.file(pane), json.to_string()).change_context(StoreError)
    }

    /// The saved agents.
    fn rows(&self) -> Result<Vec<AgentRow>, Report<StoreError>> {
        Ok(self.actor.store.load()?.1)
    }

    /// The saved agent `id`.
    fn row(&self, id: AgentId) -> Result<AgentRow, Report<StoreError>> {
        self.rows()?
            .into_iter()
            .find(|row| row.id == id)
            .ok_or_else(|| Report::new(StoreError).attach("the agent isn't saved"))
    }

    /// Pane `pane`'s saved resume command.
    fn resume(&self, pane: PaneId) -> Result<Option<String>, Report<StoreError>> {
        Ok(self
            .actor
            .store
            .layouts()?
            .panes
            .into_iter()
            .find(|row| row.id == pane)
            .and_then(|row| row.resume))
    }
}

#[rstest::rstest]
#[tokio::test]
async fn pane_report_start_creates_an_agent_in_that_pane() -> Result<(), Report<StoreError>> {
    // Given Claude started conversation s-new in the shell pane.
    let mut fx = PaneReports::new()?;
    fx.report(fx.shell, "start", "s-new", Some("startup"))?;

    // When polling.
    fx.actor.poll().await;

    // Then a Claude agent for s-new runs in that pane, with its transcript.
    let found: Vec<_> = fx
        .rows()?
        .into_iter()
        .filter(|row| row.short_id == "s-new")
        .map(|row| {
            (
                row.pane_id,
                row.session_id,
                row.harness,
                row.transcript_path,
            )
        })
        .collect();
    let expected = vec![(
        Some(fx.shell),
        Some("s-new".to_owned()),
        HarnessId::new("claude"),
        Some(PathBuf::from("/t/s-new.jsonl")),
    )];
    assert_eq!(
        found, expected,
        "the report should start an agent in the pane"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn pane_report_start_shows_the_new_agent() -> Result<(), Report<StoreError>> {
    // Given Claude started conversation s-new in the shell pane.
    let mut fx = PaneReports::new()?;
    fx.report(fx.shell, "start", "s-new", Some("startup"))?;

    // When polling.
    fx.actor.poll().await;

    // Then the new agent is shown.
    let id = fx
        .rows()?
        .into_iter()
        .find(|row| row.short_id == "s-new")
        .map(|row| row.id)
        .ok_or_else(|| Report::new(StoreError).attach("no agent for s-new"))?;
    assert!(
        shown(&fx.state, id).is_some(),
        "the new agent should be shown in its project"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn pane_report_resume_binds_the_agent_holding_that_session() -> Result<(), Report<StoreError>>
{
    // Given Claude resumed agent aa's conversation in the shell pane.
    let mut fx = PaneReports::new()?;
    fx.report(fx.shell, "start", "aa", Some("resume"))?;

    // When polling.
    fx.actor.poll().await;

    // Then aa, still the only agent, runs in the shell pane.
    let found: Vec<_> = fx
        .rows()?
        .into_iter()
        .map(|row| (row.id, row.pane_id))
        .collect();
    assert_eq!(
        found,
        vec![(fx.agent.agent, Some(fx.shell))],
        "the agent holding the session should move into the pane"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn pane_report_resume_takes_the_pane_from_its_previous_agent()
-> Result<(), Report<StoreError>> {
    // Given agent s-old runs in the shell pane, and Claude then resumed
    // aa's conversation there.
    let mut old = None;
    let mut fx = PaneReports::with(|store, agent| {
        let shell = store
            .layouts()?
            .panes
            .into_iter()
            .map(|row| row.id)
            .find(|&pane| pane != agent.pane)
            .ok_or_else(|| Report::new(StoreError).attach("no shell pane"))?;
        old = Some(
            store
                .insert_pane_agent(&NewPaneAgent {
                    pane: shell,
                    session_id: "s-old".to_owned(),
                    transcript_path: None,
                    harness: HarnessId::new("claude"),
                    cwd: PathBuf::from(PROJECT_ROOT),
                    created_at: now_ms(),
                })?
                .0,
        );
        Ok(())
    })?;
    let old = old.ok_or_else(|| Report::new(StoreError))?;
    fx.report(fx.shell, "start", "aa", Some("resume"))?;

    // When polling.
    fx.actor.poll().await;

    // Then s-old's agent no longer has a pane.
    assert_eq!(
        fx.row(old)?.pane_id,
        None,
        "the pane's earlier agent should leave it"
    );
    Ok(())
}

#[rstest::rstest]
#[case::claude_clear("clear")]
#[case::pi_new("new")]
#[tokio::test]
async fn pane_report_after_clear_keeps_the_same_agent(
    #[case] source: &str,
) -> Result<(), Report<StoreError>> {
    // Given aa's pane started a fresh conversation s-2 in its place.
    let mut fx = PaneReports::new()?;
    fx.report(fx.agent.pane, "start", "s-2", Some(source))?;

    // When polling.
    fx.actor.poll().await;

    // Then agent aa holds s-2.
    assert_eq!(
        fx.row(fx.agent.agent)?.session_id.as_deref(),
        Some("s-2"),
        "the same agent should take the new conversation"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn pane_report_after_clear_swaps_the_transcript() -> Result<(), Report<StoreError>> {
    // Given aa's pane ran /clear into conversation s-2.
    let mut fx = PaneReports::new()?;
    fx.report(fx.agent.pane, "start", "s-2", Some("clear"))?;

    // When polling.
    fx.actor.poll().await;

    // Then agent aa reads s-2's transcript.
    assert_eq!(
        fx.row(fx.agent.agent)?.transcript_path,
        Some(PathBuf::from("/t/s-2.jsonl")),
        "the agent should read the new conversation's transcript"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn pane_report_end_unbinds_the_agent() -> Result<(), Report<StoreError>> {
    // Given aa's conversation ended in its pane.
    let mut fx = PaneReports::new()?;
    fx.report(fx.agent.pane, "end", "aa", None)?;

    // When polling.
    fx.actor.poll().await;

    // Then aa no longer has a pane.
    assert_eq!(
        fx.row(fx.agent.agent)?.pane_id,
        None,
        "an ended agent should leave its pane"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn end_report_leaves_the_session_listed() -> Result<(), Report<StoreError>> {
    // Given aa's conversation ended in its session's only agent pane.
    let mut fx = PaneReports::new()?;
    fx.report(fx.agent.pane, "end", "aa", None)?;

    // When polling.
    fx.actor.poll().await;

    // Then the session is still in the sidebar.
    let listed = {
        let app = fx.state.read();
        app.sessions
            .sidebar(&app.layouts)
            .iter()
            .any(|row| row.item() == SidebarItem::Session(fx.agent.session))
    };
    assert!(listed, "a session whose agents all ended keeps its card");
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn settle_session_keeps_each_panes_resume_command() -> Result<(), Report<StoreError>> {
    // Given aa running in its pane, then its session settled, which ends
    // aa's conversation in the pane.
    let mut fx = PaneReports::new()?;
    fx.report(fx.agent.pane, "start", "aa", Some("resume"))?;
    fx.actor.poll().await;
    fx.actor.settle_session(fx.agent.session);
    fx.report(fx.agent.pane, "end", "aa", None)?;

    // When polling.
    fx.actor.poll().await;

    // Then the pane still resumes aa.
    assert_eq!(
        fx.resume(fx.agent.pane)?.as_deref(),
        Some("claude --resume aa"),
        "a settled pane should keep its resume command"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn agent_resumed_in_another_session_takes_that_session() -> Result<(), Report<StoreError>> {
    // Given agent bb's session, and aa's conversation resumed in bb's
    // pane.
    let mut other = None;
    let mut fx = PaneReports::with(|store, _| {
        other = Some(insert_agent(store, "bb")?);
        Ok(())
    })?;
    let other = other.ok_or_else(|| Report::new(StoreError).attach("bb wasn't made"))?;
    fx.report(other.pane, "start", "aa", Some("resume"))?;

    // When polling.
    fx.actor.poll().await;

    // Then aa belongs to bb's session.
    assert_eq!(
        fx.row(fx.agent.agent)?.orb_session,
        Some(other.session),
        "an agent should take the session of the pane it is bound to"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn end_report_keeps_the_agents_session() -> Result<(), Report<StoreError>> {
    // Given aa's conversation ended in its pane.
    let mut fx = PaneReports::new()?;
    fx.report(fx.agent.pane, "end", "aa", None)?;

    // When polling.
    fx.actor.poll().await;

    // Then aa still shows in its session.
    assert_eq!(
        shown(&fx.state, fx.agent.agent).and_then(|agent| agent.home()),
        Some(fx.agent.session),
        "an ended agent should keep the session it ran in"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn end_report_in_a_settled_session_keeps_the_agent_bound() -> Result<(), Report<StoreError>> {
    // Given aa's session settled, then aa's conversation ending in its
    // pane.
    let mut fx = PaneReports::new()?;
    fx.actor.edit_session(fx.agent.session, settle_session_row);
    fx.report(fx.agent.pane, "end", "aa", None)?;

    // When polling.
    fx.actor.poll().await;

    // Then aa keeps its pane.
    assert_eq!(
        fx.row(fx.agent.agent)?.pane_id,
        Some(fx.agent.pane),
        "settling ended it, so the agent waits to come back"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn pane_report_end_of_another_session_changes_nothing() -> Result<(), Report<StoreError>> {
    // Given aa's pane reports the end of some other conversation.
    let mut fx = PaneReports::new()?;
    fx.report(fx.agent.pane, "end", "zz", None)?;

    // When polling.
    fx.actor.poll().await;

    // Then aa keeps its pane.
    assert_eq!(
        fx.row(fx.agent.agent)?.pane_id,
        Some(fx.agent.pane),
        "a stale end should change nothing"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn pane_report_start_sets_the_panes_resume_command() -> Result<(), Report<StoreError>> {
    // Given Claude started conversation s-new in the shell pane.
    let mut fx = PaneReports::new()?;
    fx.report(fx.shell, "start", "s-new", Some("startup"))?;

    // When polling.
    fx.actor.poll().await;

    // Then the pane resumes s-new.
    assert_eq!(
        fx.resume(fx.shell)?.as_deref(),
        Some("claude --resume s-new"),
        "the pane should resume its conversation"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn pane_report_end_clears_the_panes_resume_command() -> Result<(), Report<StoreError>> {
    // Given aa's pane resumes aa, and aa's conversation ended.
    let mut fx = PaneReports::with(|store, agent| {
        store.set_pane_resume(agent.pane, Some("claude --resume aa"))
    })?;
    fx.report(fx.agent.pane, "end", "aa", None)?;

    // When polling.
    fx.actor.poll().await;

    // Then the pane has nothing to resume.
    assert_eq!(
        fx.resume(fx.agent.pane)?,
        None,
        "an ended conversation shouldn't be resumed"
    );
    Ok(())
}

/// Pane `pane`'s resume command, as its layout entry shows it.
fn layout_resume(state: &State, pane: PaneId) -> Option<String> {
    state
        .read()
        .layouts
        .entry(pane)
        .and_then(|entry| entry.resume.clone())
}

#[rstest::rstest]
fn restored_pane_entry_carries_its_resume_command() -> Result<(), Report<StoreError>> {
    // Given a saved agent whose pane resumes aa.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    store.set_pane_resume(inserted.pane, Some("claude --resume aa"))?;
    let host = listing(Vec::new());

    // When restoring.
    let (_actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));

    // Then the pane's layout entry carries the resume command.
    assert_eq!(
        layout_resume(&state, inserted.pane).as_deref(),
        Some("claude --resume aa"),
        "the restored entry should know how to resume its pane"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn pane_report_start_shows_the_resume_command_in_the_layout() -> Result<(), Report<StoreError>>
{
    // Given the shell pane open in a tab of its own, and Claude started
    // conversation s-new in it.
    let mut fx = PaneReports::new()?;
    fx.state
        .write()
        .layouts
        .new_tab(fx.agent.session, test_entry(fx.shell.0));
    fx.report(fx.shell, "start", "s-new", Some("startup"))?;

    // When polling.
    fx.actor.poll().await;

    // Then the shell pane's layout entry resumes s-new.
    assert_eq!(
        layout_resume(&fx.state, fx.shell).as_deref(),
        Some("claude --resume s-new"),
        "the layout should carry the pane's new resume command"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn pane_report_end_clears_the_resume_command_in_the_layout() -> Result<(), Report<StoreError>>
{
    // Given aa's pane resumes aa, and aa's conversation ended.
    let mut fx = PaneReports::with(|store, agent| {
        store.set_pane_resume(agent.pane, Some("claude --resume aa"))
    })?;
    fx.report(fx.agent.pane, "end", "aa", None)?;

    // When polling.
    fx.actor.poll().await;

    // Then the pane's layout entry has nothing to resume.
    assert_eq!(
        layout_resume(&fx.state, fx.agent.pane),
        None,
        "an ended conversation shouldn't be resumed from the layout"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn pane_report_from_an_unknown_pane_is_ignored() -> Result<(), Report<StoreError>> {
    // Given a report from a pane orb has no row for.
    let mut fx = PaneReports::new()?;
    fx.report(PaneId(999), "start", "s-new", Some("startup"))?;

    // When polling.
    fx.actor.poll().await;

    // Then no agent is added.
    assert_eq!(
        fx.rows()?.len(),
        1,
        "an unknown pane's report should be ignored"
    );
    Ok(())
}

/// Agent `aa` in a pane of its own, its harness `claude` (status from
/// the agents it sees running) or `pi` (status from pane reports),
/// polled through a harness seeing `records` and a zmx whose listing `zmx`
/// makes from the pane, the actor reading pane files under a scratch orb
/// folder.
struct PaneStatus {
    dir: tempfile::TempDir,
    agent: Seeded,
    actor: SessionsActor,
    state: State,
}

impl PaneStatus {
    fn new<F>(reports: bool, records: Vec<RunningAgent>, zmx: F) -> Result<Self, Report<StoreError>>
    where
        F: FnOnce(PaneId) -> ZmxService,
    {
        let dir = tempfile::tempdir().change_context(StoreError)?;
        let store = Store::open_in_memory()?;
        let harness_name = if reports { "pi" } else { "claude" };
        let agent = seed_with(
            &store,
            harness_name,
            orb_project(&store)?,
            SessionKind::Plain,
            Path::new(PROJECT_ROOT),
            "aa",
            now_ms() - HOUR_MS,
        )?;
        let harness: Arc<dyn Harness> = Arc::new(if reports {
            FakeHarness::reporting(harness_name)
        } else {
            FakeHarness::new(harness_name, records)
        });
        let state = State::default();
        let git = FakeGit::local();
        let actor = SessionsActor::restore(SessionsActorDeps {
            services: Services {
                harnesses: Harnesses::new(vec![harness]),
                git: GitService::new(git, Log::default()),
                zmx: zmx(agent.pane),
                log: Log::default(),
            },
            state: state.clone(),
            store,
            worktrees_root: PathBuf::from(WORKTREES_ROOT),
            orb_root: dir.path().to_owned(),
            incognito_root: PathBuf::from(INCOGNITO_ROOT),
            report: Reporter::new(|_| {}),
            integration_missing: false,
        });
        Ok(Self {
            dir,
            agent,
            actor,
            state,
        })
    }

    /// Writes pi's `event` report of conversation `aa` from the agent's pane.
    fn report(&self, event: &str) -> Result<(), Report<StoreError>> {
        let panes = self.dir.path().join("panes");
        fs::create_dir_all(&panes).change_context(StoreError)?;
        let json = serde_json::json!({
            "agent": "pi",
            "event": event,
            "session_id": "aa",
            "transcript": null,
            "source": "startup",
            "at": now_ms(),
        });
        fs::write(
            panes.join(format!("{}.json", self.agent.pane.0)),
            json.to_string(),
        )
        .change_context(StoreError)
    }

    fn status(&self) -> Option<AgentStatus> {
        status_of(&self.state, self.agent.agent)
    }
}

/// A zmx running `pane`'s session as process 100, made at unix second 1.
fn running(pane: PaneId) -> ZmxService {
    zmx_listing(&format!(
        "  name={}\tpid=100\tclients=1\tcreated=1\n",
        pane.zmx_name()
    ))
}

/// A zmx that can't list any socket dir.
fn unlistable(_pane: PaneId) -> ZmxService {
    ZmxService::new(
        Arc::new(FakeZmx::new(ZmxOutput::default())),
        PathBuf::from("/zmx"),
        Log::default(),
    )
}

/// A Claude the user started, whose process and parents are `ancestry`.
fn interactive(ancestry: &[u32], status: AgentStatus) -> RunningAgent {
    RunningAgent {
        status,
        ancestry: ancestry.to_vec(),
    }
}

#[rstest::rstest]
#[tokio::test]
async fn poll_shows_a_claude_panes_interactive_status() -> Result<(), Report<StoreError>> {
    // Given a Claude working under the shell of aa's running pane.
    let mut fx = PaneStatus::new(
        false,
        vec![interactive(&[300, 100, 1], AgentStatus::Working)],
        running,
    )?;

    // When polling.
    fx.actor.poll().await;

    // Then aa shows the Claude's status.
    assert_eq!(
        fx.status(),
        Some(AgentStatus::Working),
        "the record under the pane should give the status"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_shows_a_claude_pane_without_a_record_stopped() -> Result<(), Report<StoreError>> {
    // Given aa's pane runs, but no Claude runs under it.
    let mut fx = PaneStatus::new(
        false,
        vec![interactive(&[400, 1], AgentStatus::Working)],
        running,
    )?;

    // When polling.
    fx.actor.poll().await;

    // Then aa is stopped.
    assert_eq!(
        fx.status(),
        Some(AgentStatus::Stopped),
        "a pane with no Claude under it should be stopped"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_shows_a_pi_panes_reported_status() -> Result<(), Report<StoreError>> {
    // Given pi in aa's running pane reported a turn underway.
    let mut fx = PaneStatus::new(true, Vec::new(), running)?;
    fx.report("working")?;

    // When polling.
    fx.actor.poll().await;

    // Then aa is working.
    assert_eq!(
        fx.status(),
        Some(AgentStatus::Working),
        "pi's latest report should give the status"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_leaves_a_pane_agent_as_it_was_when_zmx_cant_list() -> Result<(), Report<StoreError>> {
    // Given zmx can't list aa's pane's socket dir.
    let mut fx = PaneStatus::new(false, Vec::new(), unlistable)?;

    // When polling.
    fx.actor.poll().await;

    // Then aa keeps its status from before the poll.
    assert_eq!(
        fx.status(),
        Some(AgentStatus::Unknown),
        "an unlistable pane should leave its agent as it was"
    );
    Ok(())
}

/// Leaves the saved agent `short_id` and every saved session idle for
/// four days, and returns since when.
fn session_idle_for_four_days(store: &Store, short_id: &str) -> Result<i64, Report<StoreError>> {
    let since = idle_for_four_days(store, short_id)?;
    for row in store.layouts()?.sessions {
        store.save_session(&SessionRow {
            last_activity_at: since,
            ..row
        })?;
    }
    Ok(since)
}

/// Saves `change` over every saved session row.
fn resave_sessions<F>(store: &Store, change: F) -> Result<(), Report<StoreError>>
where
    F: Fn(SessionRow) -> SessionRow,
{
    for row in store.layouts()?.sessions {
        store.save_session(&change(row))?;
    }
    Ok(())
}

/// The saved session agent `short_id` runs in.
fn saved_session(store: &Store, short_id: &str) -> Result<SessionRow, Report<StoreError>> {
    let pane = saved(store, short_id)?.pane_id;
    let layouts = store.layouts()?;
    let session = layouts
        .panes
        .iter()
        .find(|row| Some(row.id) == pane)
        .map(|row| row.session_id);
    layouts
        .sessions
        .into_iter()
        .find(|row| Some(row.id) == session)
        .ok_or_else(|| Report::new(StoreError).attach(format!("{short_id} has no session")))
}

/// Starts the actor on `store` over `host` with nothing selected.
fn start_unselected(store: Store, host: &Arc<FakeClaude>) -> (SessionsActor, State) {
    let (actor, state) = start(store, host, Path::new(NO_CLAUDE_DIR));
    state.write().sessions.cursor = None;
    (actor, state)
}

#[rstest::rstest]
#[tokio::test]
async fn session_idle_for_four_days_stays_unsettled_after_a_poll() -> Result<(), Report<StoreError>>
{
    // Given agent aa's session idle for four days.
    let (store, _) = store_with_agent("aa")?;
    session_idle_for_four_days(&store, "aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, _state) = start_unselected(store, &host);

    // When polling.
    actor.poll().await;

    // Then the session is still unsettled.
    let row = saved_session(&actor.store, "aa")?;
    assert_eq!(
        (row.settled_override, row.settled_at),
        (None, None),
        "a long-idle session should stay unsettled"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn poll_kills_no_pane_of_an_idle_session() -> Result<(), Report<StoreError>> {
    // Given agent aa's session idle for four days.
    let (store, _) = store_with_agent("aa")?;
    session_idle_for_four_days(&store, "aa")?;
    let host = listing(vec![record("aa", AgentStatus::Idle)]);
    let (mut actor, _state) = start_unselected(store, &host);
    let (zmx, service) = recording_zmx();
    actor.services.zmx = service;

    // When polling.
    actor.poll().await;

    // Then no pane is killed.
    assert!(
        killed(&zmx).is_empty(),
        "a poll should kill no pane of an idle session"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_in_a_pane_unsettles_its_session() -> Result<(), Report<StoreError>> {
    // Given agent aa's settled session, and aa now working.
    let (store, _) = store_with_agent("aa")?;
    resave_sessions(&store, |row| SessionRow {
        settled_override: Some(SettledOverride::Settled),
        settled_at: Some(now_ms() - HOUR_MS),
        ..row
    })?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, _state) = start_unselected(store, &host);

    // When polling.
    actor.poll().await;

    // Then the session is no longer settled.
    let row = saved_session(&actor.store, "aa")?;
    assert_eq!(
        (row.settled_override, row.settled_at),
        (None, None),
        "a turn in one of its panes should un-settle the session"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_in_a_pane_ends_its_sessions_kept_active_mark() -> Result<(), Report<StoreError>> {
    // Given agent aa's kept-active session, and aa now working.
    let (store, _) = store_with_agent("aa")?;
    resave_sessions(&store, |row| SessionRow {
        settled_override: Some(SettledOverride::Active),
        ..row
    })?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, _state) = start_unselected(store, &host);

    // When polling.
    actor.poll().await;

    // Then the mark is cleared.
    assert_eq!(
        saved_session(&actor.store, "aa")?.settled_override,
        None,
        "turn activity should end the kept-active mark"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn turn_end_is_its_sessions_latest_activity() -> Result<(), Report<StoreError>> {
    // Given agent aa polled while working.
    let (store, _) = store_with_agent("aa")?;
    let host = listing(vec![record("aa", AgentStatus::Working)]);
    let (mut actor, _state) = start_unselected(store, &host);
    actor.poll().await;

    // When polling after its turn ended.
    host.set_running(Ok(vec![record("aa", AgentStatus::Idle)]));
    actor.poll().await;

    // Then the turn's end is the session's latest activity.
    assert_eq!(
        saved_session(&actor.store, "aa")?.last_activity_at,
        saved(&actor.store, "aa")?.last_activity_at,
        "the session's activity should follow its agent's turn end"
    );
    Ok(())
}

#[rstest::rstest]
fn kill_settled_kills_listed_panes_of_settled_sessions() -> Result<(), Report<StoreError>> {
    // Given settled session aa and unsettled session bb, zmx listing both
    // their panes.
    let store = Store::open_in_memory()?;
    let settled = insert_agent(&store, "aa")?;
    let active = insert_agent(&store, "bb")?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.edit_session(settled.session, settle_session_row);
    let zmx = Arc::new(FakeZmx::new(ZmxOutput {
        success: true,
        stdout: format!(
            "  name={}\tpid=100\tclients=0\tcreated=1\n  name={}\tpid=101\tclients=0\tcreated=1\n",
            settled.pane.zmx_name(),
            active.pane.zmx_name()
        ),
        stderr: String::new(),
    }));
    actor.services.zmx = ZmxService::new(zmx.clone(), PathBuf::from("/zmx"), Log::default());

    // When killing the settled sessions' panes.
    actor.kill_settled();

    // Then only aa's pane is killed.
    assert_eq!(
        killed(&zmx),
        vec![settled.pane.zmx_name()],
        "only a settled session's listed pane should be killed"
    );
    Ok(())
}

#[rstest::rstest]
fn kill_settled_kills_nothing_when_zmx_cant_list() -> Result<(), Report<StoreError>> {
    // Given settled session aa, and a zmx that can't list its sessions.
    let store = Store::open_in_memory()?;
    let settled = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    actor.edit_session(settled.session, settle_session_row);
    let zmx = Arc::new(FakeZmx::new(ZmxOutput {
        success: false,
        stdout: String::new(),
        stderr: "boom".into(),
    }));
    actor.services.zmx = ZmxService::new(zmx.clone(), PathBuf::from("/zmx"), Log::default());

    // When killing the settled sessions' panes.
    actor.kill_settled();

    // Then nothing is killed.
    assert!(
        killed(&zmx).is_empty(),
        "nothing should be killed when zmx can't list what runs"
    );
    Ok(())
}

/// How long a mailbox test waits for any one answer.
const LIMIT: Duration = Duration::from_secs(5);

/// Starts the actor through its real mailbox, as main does, over `store`,
/// `claude`, a local fake git and `zmx`; `on_start` sends `KillSettled`
/// and starts the poll loop. Returns the actor and its state.
async fn spawned(
    store: Store,
    claude: &Arc<FakeClaude>,
    zmx: ZmxService,
) -> Result<(ActorRef<SessionsActor>, State), Report<StoreError>> {
    spawned_with(store, claude, FakeGit::local(), zmx).await
}

/// [`spawned`], with `git` in place of the local fake git.
async fn spawned_with(
    store: Store,
    claude: &Arc<FakeClaude>,
    git: Arc<FakeGit>,
    zmx: ZmxService,
) -> Result<(ActorRef<SessionsActor>, State), Report<StoreError>> {
    let (actor, state, _) = spawned_reporting(store, claude, git, zmx).await?;
    Ok((actor, state))
}

/// [`spawned_with`], also returning a clone of the actor's reporter,
/// which sees everything the actor reports.
async fn spawned_reporting(
    store: Store,
    claude: &Arc<FakeClaude>,
    git: Arc<FakeGit>,
    zmx: ZmxService,
) -> Result<(ActorRef<SessionsActor>, State, Reporter), Report<StoreError>> {
    let state = State::default();
    let report = Reporter::new(|_| {});
    let actor = spawn_sessions_actor(SessionsActorDeps {
        services: Services {
            harnesses: Harnesses::new(vec![Arc::new(ClaudeCode::new(
                claude.clone(),
                PathBuf::from(NO_CLAUDE_DIR),
            ))]),
            git: GitService::new(git, Log::default()),
            zmx,
            log: Log::default(),
        },
        state: state.clone(),
        store,
        worktrees_root: PathBuf::from(WORKTREES_ROOT),
        orb_root: PathBuf::from(ORB_ROOT),
        incognito_root: PathBuf::from(INCOGNITO_ROOT),
        report: report.clone(),
        integration_missing: false,
    });
    tokio::time::timeout(LIMIT, actor.wait_for_startup())
        .await
        .change_context(StoreError)
        .attach("the actor didn't start in time")?;
    Ok((actor, state, report))
}

/// Asks `actor` to save session `session`'s layout and waits, at most
/// [`LIMIT`], for it to be done.
async fn save_through_mailbox(
    actor: &ActorRef<SessionsActor>,
    session: SessionId,
) -> Result<(), Report<StoreError>> {
    tokio::time::timeout(LIMIT, actor.ask(SessionsCommand::SaveLayout(session)))
        .await
        .change_context(StoreError)
        .attach("the actor didn't answer in time")?
        .map_err(|error| Report::new(StoreError).attach(format!("{error:?}")))
}

/// Asks `actor` `msg` and waits, at most [`LIMIT`], for it to be handled.
async fn ask_within<M>(actor: &ActorRef<SessionsActor>, msg: M) -> Result<(), Report<StoreError>>
where
    SessionsActor: Message<M, Reply = ()>,
    M: std::fmt::Debug + Send + 'static,
{
    tokio::time::timeout(LIMIT, actor.ask(msg))
        .await
        .change_context(StoreError)
        .attach("the actor didn't answer in time")?
        .map_err(|error| Report::new(StoreError).attach(format!("{error:?}")))
}

#[rstest::rstest]
#[tokio::test]
async fn layout_saved_through_the_mailbox_is_stored() -> Result<(), Report<StoreError>> {
    // Given a store file with agent aa, the actor started through its
    // mailbox, and aa's tab renamed in the app state.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    let store = Store::open(&path)?;
    let inserted = insert_agent(&store, "aa")?;
    let zmx = zmx_running(&store);
    let host = listing(Vec::new());
    let (actor, state) = spawned(store, &host, zmx).await?;
    state
        .write()
        .layouts
        .rename_tab(inserted.session, 0, Some("agent".into()));

    // When asking the actor to save aa's layout.
    save_through_mailbox(&actor, inserted.session).await?;

    // Then the store file has the tab's name.
    let names: Vec<Option<String>> = Store::open(&path)?
        .layouts()?
        .tabs
        .into_iter()
        .map(|tab| tab.name)
        .collect();
    assert_eq!(
        names,
        vec![Some("agent".to_owned())],
        "a layout saved through the mailbox should reach the store"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn a_layout_save_sent_before_shutdown_is_stored_after_it() -> Result<(), Report<StoreError>> {
    // Given a store file with agent aa, the actor started through its
    // mailbox, and aa's tab renamed in the app state.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    let store = Store::open(&path)?;
    let inserted = insert_agent(&store, "aa")?;
    let zmx = zmx_running(&store);
    let host = listing(Vec::new());
    let (actor, state) = spawned(store, &host, zmx).await?;
    state
        .write()
        .layouts
        .rename_tab(inserted.session, 0, Some("agent".into()));

    // When sending a save for aa's layout without waiting, then shutting
    // the actor down.
    actor
        .tell(SessionsCommand::SaveLayout(inserted.session))
        .await
        .map_err(|error| Report::new(StoreError).attach(format!("{error:?}")))?;
    tokio::time::timeout(LIMIT, crate::stop_gracefully(&actor))
        .await
        .change_context(StoreError)
        .attach("the actor didn't stop in time")?;

    // Then the store file has the tab's name.
    let names: Vec<Option<String>> = Store::open(&path)?
        .layouts()?
        .tabs
        .into_iter()
        .map(|tab| tab.name)
        .collect();
    assert_eq!(
        names,
        vec![Some("agent".to_owned())],
        "a layout save sent before shutdown should be stored after it"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn kill_settled_at_start_kills_only_settled_panes() -> Result<(), Report<StoreError>> {
    // Given session aa settled before start and session bb not, zmx
    // listing both their panes.
    let store = Store::open_in_memory()?;
    let settled = insert_agent(&store, "aa")?;
    let active = insert_agent(&store, "bb")?;
    let mut row = store
        .layouts()?
        .sessions
        .into_iter()
        .find(|row| row.id == settled.session)
        .ok_or_else(|| Report::new(StoreError).attach("aa's session isn't saved"))?;
    settle_session_row(&mut row, now_ms());
    store.save_session(&row)?;
    let zmx = Arc::new(FakeZmx::new(ZmxOutput {
        success: true,
        stdout: format!(
            "  name={}\tpid=100\tclients=0\tcreated=1\n  name={}\tpid=101\tclients=0\tcreated=1\n",
            settled.pane.zmx_name(),
            active.pane.zmx_name()
        ),
        stderr: String::new(),
    }));
    let host = listing(Vec::new());

    // When the actor starts through its mailbox and has handled what
    // `on_start` sent it.
    let (actor, _state) = spawned(
        store,
        &host,
        ZmxService::new(zmx.clone(), PathBuf::from("/zmx"), Log::default()),
    )
    .await?;
    let waited = tokio::time::Instant::now();
    while killed(&zmx).is_empty() && waited.elapsed() < LIMIT {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    save_through_mailbox(&actor, active.session).await?;

    // Then only aa's pane is killed.
    assert_eq!(
        killed(&zmx),
        vec![settled.pane.zmx_name()],
        "only a settled session's listed pane should be killed at start"
    );
    Ok(())
}

/// Waits, at most [`LIMIT`], until `condition` holds.
async fn wait_until<F>(condition: F)
where
    F: Fn() -> bool,
{
    let waited = tokio::time::Instant::now();
    while !condition() && waited.elapsed() < LIMIT {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[rstest::rstest]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn split_is_handled_while_a_new_worktree_is_being_made() -> Result<(), Report<StoreError>> {
    // Given agent aa's session, the actor started through its mailbox
    // with a git whose worktree add waits until the test ends, and a new
    // session in a new worktree asked for and reaching that add.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let project = orb_project(&store)?;
    let zmx = zmx_running(&store);
    let (git, _open) = FakeGit::gated();
    let (actor, state) = spawned_with(store, &listing(Vec::new()), git.clone(), zmx).await?;
    actor
        .tell(SessionsCommand::NewSession {
            project,
            workspace: Workspace::NewWorktree {
                base: "main".to_owned(),
            },
            name: None,
            if_active: None,
        })
        .await
        .map_err(|error| Report::new(StoreError).attach(format!("{error:?}")))?;
    wait_until(|| git.added().is_some()).await;

    // When splitting aa's pane through the mailbox.
    ask_within(
        &actor,
        SessionsCommand::SplitPane {
            session: inserted.session,
            split: Split::Right,
        },
    )
    .await?;

    // Then aa's session has two panes.
    assert_eq!(
        state.read().layouts.session_panes(inserted.session).len(),
        2,
        "a split should be handled while a new worktree is being made"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn split_is_handled_while_the_status_check_runs() -> Result<(), Report<StoreError>> {
    // Given agent aa's session and the actor started through its
    // mailbox, its poll asking a claude whose listing waits until the
    // test ends.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let zmx = zmx_running(&store);
    let (claude, _open) = FakeClaude::gated(Vec::new());
    let claude = Arc::new(claude);
    let (actor, state) = spawned(store, &claude, zmx).await?;
    wait_until(|| claude.lists() >= 1).await;

    // When splitting aa's pane through the mailbox.
    ask_within(
        &actor,
        SessionsCommand::SplitPane {
            session: inserted.session,
            split: Split::Right,
        },
    )
    .await?;

    // Then aa's session has two panes.
    assert_eq!(
        state.read().layouts.session_panes(inserted.session).len(),
        2,
        "a split should be handled while the status check runs"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn restore_through_the_mailbox_asks_to_attach_after_its_job() -> Result<(), Report<StoreError>>
{
    // Given agent aa's pruned worktree and the actor started through
    // its mailbox.
    let (store, id) = pruned_agent(Some("fix-parser"))?;
    let zmx = zmx_running(&store);
    let (actor, _state, report) =
        spawned_reporting(store, &listing(Vec::new()), FakeGit::local(), zmx).await?;

    // When asking it to restore the worktree, and its job finishing.
    ask_within(&actor, SessionsCommand::RestoreWorktree(id)).await?;
    let ready = || {
        report
            .outcomes()
            .into_iter()
            .find_map(|outcome| match outcome {
                Outcome::Ready { session, .. } => Some(session),
                _ => None,
            })
    };
    wait_until(|| ready().is_some()).await;

    // Then the session is reported ready to open.
    assert_eq!(
        ready(),
        Some(id),
        "a restored session opens once its worktree is back"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn a_worktree_job_that_panics_still_ends_the_start() -> Result<(), Report<StoreError>> {
    // Given the actor started through its mailbox, with a git whose
    // worktree add panics, and a start marked as starting.
    let store = Store::open_in_memory()?;
    let project = orb_project(&store)?;
    let zmx = zmx_running(&store);
    let (actor, state, report) =
        spawned_reporting(store, &listing(Vec::new()), FakeGit::panicking(), zmx).await?;
    state.write().sessions.starting = true;

    // When asking for a session in a new worktree, and its job dying.
    ask_within(
        &actor,
        SessionsCommand::NewSession {
            project,
            workspace: new_worktree(),
            name: None,
            if_active: None,
        },
    )
    .await?;
    wait_until(|| !state.read().sessions.starting).await;

    // Then the start ends with the failure shown.
    assert_eq!(
        (state.read().sessions.starting, report.shown_error()),
        (false, Some("couldn't make the worktree".to_owned())),
        "a job that dies still ends its start"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn screen_reads_the_state_while_a_project_is_checked_for_git()
-> Result<(), Report<StoreError>> {
    // Given the actor started through its mailbox with a git whose
    // project check waits until the test ends, and an existing
    // directory being added as a project, reaching that check.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let store = Store::open_in_memory()?;
    let zmx = zmx_running(&store);
    let (git, asking, _open) = FakeGit::slow_project_check();
    let (actor, state) = spawned_with(store, &listing(Vec::new()), git, zmx).await?;
    actor
        .tell(SessionsCommand::AddProject(dir.path().to_owned()))
        .await
        .map_err(|error| Report::new(StoreError).attach(format!("{error:?}")))?;
    tokio::task::spawn_blocking(move || asking.recv_timeout(LIMIT))
        .await
        .change_context(StoreError)?
        .change_context(StoreError)
        .attach("the project check wasn't asked in time")?;

    // When the screen reads the app state.
    let read = tokio::time::timeout(
        LIMIT,
        tokio::task::spawn_blocking(move || state.read().sessions.projects.len()),
    )
    .await;

    // Then the read finishes without waiting for git.
    assert!(
        read.is_ok(),
        "the screen should read the state while git checks a project"
    );
    Ok(())
}

/// What a kill-order test starts from: the actor started through its
/// mailbox with session aa (two panes) on the right side, and the zmx
/// watching aa.
async fn shown_movable_through_mailbox()
-> Result<(ActorRef<SessionsActor>, SessionId, Arc<WatchingZmx>), Report<StoreError>> {
    let (store, seeded, _) = movable()?;
    let zmx = WatchingZmx::new(seeded.session, String::new());
    let (actor, state) = spawned(store, &listing(Vec::new()), zmx.service()).await?;
    zmx.watch(&state);
    state.write().attached.insert(seeded.session);
    Ok((actor, seeded.session, zmx))
}

#[rstest::rstest]
#[tokio::test]
async fn settling_takes_the_session_off_the_right_side_before_killing_its_panes()
-> Result<(), Report<StoreError>> {
    // Given session aa with two panes on the right side.
    let (actor, session, zmx) = shown_movable_through_mailbox().await?;

    // When settling it through the mailbox.
    ask_within(
        &actor,
        SessionsCommand::SettleSession {
            session,
            with_colonists: false,
        },
    )
    .await?;

    // Then it was off the right side at each of its two kills.
    assert_eq!(
        zmx.shown_at_kill(),
        vec![false, false],
        "a settled session should leave the right side before its panes are killed"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn deleting_takes_the_session_off_the_right_side_before_killing_its_panes()
-> Result<(), Report<StoreError>> {
    // Given session aa with two panes on the right side.
    let (actor, session, zmx) = shown_movable_through_mailbox().await?;

    // When deleting it through the mailbox.
    ask_within(
        &actor,
        SessionsCommand::DeleteSession {
            session,
            with_colonists: false,
        },
    )
    .await?;

    // Then it was off the right side at each of its two kills.
    assert_eq!(
        zmx.shown_at_kill(),
        vec![false, false],
        "a deleted session should leave the right side before its panes are killed"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn moving_takes_the_session_off_the_right_side_before_killing_its_panes()
-> Result<(), Report<StoreError>> {
    // Given session aa with two panes on the right side, before any turn.
    let (actor, session, zmx) = shown_movable_through_mailbox().await?;
    let to = tempfile::tempdir().change_context(StoreError)?;

    // When moving it to another existing directory through the mailbox.
    ask_within(
        &actor,
        SessionsCommand::ChangeWorkspace {
            session,
            to: Workspace::Existing(to.path().to_owned()),
            if_active: None,
        },
    )
    .await?;

    // Then it was off the right side at each of its two kills.
    assert_eq!(
        zmx.shown_at_kill(),
        vec![false, false],
        "a moved session should leave the right side before its panes are killed"
    );
    Ok(())
}

#[rstest::rstest]
fn start_kill_takes_settled_sessions_off_the_right_side_before_killing_their_panes()
-> Result<(), Report<StoreError>> {
    // Given settled session aa on the right side, zmx listing its pane.
    let store = Store::open_in_memory()?;
    let settled = insert_agent(&store, "aa")?;
    let (mut actor, state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    actor.edit_session(settled.session, settle_session_row);
    let zmx = WatchingZmx::new(
        settled.session,
        format!(
            "  name={}\tpid=100\tclients=0\tcreated=1\n",
            settled.pane.zmx_name()
        ),
    );
    actor.services.zmx = zmx.service();
    zmx.watch(&state);
    state.write().attached.insert(settled.session);

    // When killing the settled sessions' panes, as at start.
    actor.kill_settled();

    // Then aa was off the right side at its one kill.
    assert_eq!(
        zmx.shown_at_kill(),
        vec![false],
        "a settled session should leave the right side before its panes are killed at start"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn deleting_a_session_logs_it_and_its_panes() -> Result<(), Report<StoreError>> {
    // Given agent aa's session with a second pane, and a log.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let second = second_tab(&store, &inserted)?;
    let host = listing(Vec::new());
    let (mut actor, _state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("orb.log");
    actor.services.log = Log::new(path.clone());

    // When deleting aa's session.
    delete(&mut actor, inserted.session);

    // Then the log names the session, its agent and both panes.
    let content = fs::read_to_string(&path).unwrap_or_default();
    let expected = format!(
        "delete session {} with agents [{}] and panes [{}, {}]: ok",
        inserted.session.0, inserted.agent.0, inserted.pane.0, second.0
    );
    assert!(
        content.contains(&expected),
        "expected {expected:?} in the log, got {content:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn saving_a_layout_logs_each_dropped_pane_row() -> Result<(), Report<StoreError>> {
    // Given agent aa's session split in two, its first pane closed, and
    // a log.
    let store = Store::open_in_memory()?;
    let inserted = insert_agent(&store, "aa")?;
    let host = listing(Vec::new());
    let (mut actor, state) = start(store, &host, Path::new(NO_CLAUDE_DIR));
    state.write().layouts.fit_to(Rect::new(0, 0, 80, 24));
    actor.add_pane(inserted.session, Placement::Split(Split::Right));
    state.write().layouts.close_pane(inserted.pane);
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("orb.log");
    actor.services.log = Log::new(path.clone());

    // When saving the layout.
    actor.save_layout(inserted.session);

    // Then the log names the dropped pane row and its session.
    let content = fs::read_to_string(&path).unwrap_or_default();
    let expected = format!(
        "delete pane row {} (session {})",
        inserted.pane.0, inserted.session.0
    );
    assert!(
        content.contains(&expected),
        "expected {expected:?} in the log, got {content:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn failed_save_logs_the_cause_behind_the_message() -> Result<(), Report<StoreError>> {
    // Given a store whose jumps table is gone, and a log.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let db = dir.path().join("state.sqlite");
    let store = Store::open(&db)?;
    insert_agent(&store, "aa")?;
    let (mut actor, _state) = start(store, &listing(Vec::new()), Path::new(NO_CLAUDE_DIR));
    rusqlite::Connection::open(&db)
        .and_then(|conn| conn.execute("DROP TABLE jumps", []))
        .change_context(StoreError)?;
    let path = dir.path().join("orb.log");
    actor.services.log = Log::new(path.clone());

    // When saving the jump list.
    actor.save_jumps();

    // Then the log has the message and the cause behind it.
    let content = fs::read_to_string(&path).unwrap_or_default();
    assert!(
        content.contains("couldn't save orb's state") && content.contains("no such table: jumps"),
        "expected the message and its cause in the log, got {content:?}"
    );
    Ok(())
}

/// Asks `actor` for an agent's new shell `add` and waits, at most
/// [`LIMIT`], for the new pane.
async fn api_add(
    actor: &ActorRef<SessionsActor>,
    add: ApiAdd,
) -> Result<PaneId, Report<StoreError>> {
    tokio::time::timeout(LIMIT, actor.ask(add))
        .await
        .change_context(StoreError)
        .attach("the actor didn't answer in time")?
        .map_err(|error| Report::new(StoreError).attach(format!("{error:?}")))
}

/// Asks `actor` for an agent's new session of `project` (in a new
/// worktree when `worktree`), made by session `parent`, and waits, at most
/// [`LIMIT`], for the session and its first pane.
async fn api_start(
    actor: &ActorRef<SessionsActor>,
    project: ProjectId,
    worktree: bool,
    parent: Option<SessionId>,
) -> Result<(SessionId, PaneId), Report<StoreError>> {
    let start = ApiStart {
        project,
        worktree,
        name: None,
        parent,
        dir: None,
    };
    tokio::time::timeout(LIMIT, actor.ask(start))
        .await
        .change_context(StoreError)
        .attach("the actor didn't answer in time")?
        .map_err(|error| Report::new(StoreError).attach(format!("{error:?}")))
}

/// Asks `actor` for an agent's new top-level session of `project` (in a new
/// worktree when `worktree`) and waits, at most [`LIMIT`], for its answer,
/// a refusal included.
async fn api_start_answer(
    actor: &ActorRef<SessionsActor>,
    project: ProjectId,
    worktree: bool,
) -> Result<Result<(SessionId, PaneId), SendError<ApiStart, ApiStartError>>, Report<StoreError>> {
    let start = ApiStart {
        project,
        worktree,
        name: None,
        parent: None,
        dir: None,
    };
    tokio::time::timeout(LIMIT, actor.ask(start))
        .await
        .change_context(StoreError)
        .attach("the actor didn't answer in time")
}

#[rstest::rstest]
#[tokio::test]
async fn api_add_split_replies_with_the_saved_pane() -> Result<(), Report<StoreError>> {
    // Given a store file with agent aa and the actor started through its
    // mailbox.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    let store = Store::open(&path)?;
    let inserted = insert_agent(&store, "aa")?;
    let zmx = zmx_running(&store);
    let (actor, _state) = spawned(store, &listing(Vec::new()), zmx).await?;

    // When an agent asks to split aa's pane right.
    let add = ApiAdd {
        session: inserted.session,
        place: ApiPlace::Split {
            at: inserted.pane,
            split: Split::Right,
        },
    };
    let pane = api_add(&actor, add).await?;

    // Then the pane it replies with is saved in the store file.
    let saved: Vec<PaneId> = Store::open(&path)?
        .layouts()?
        .panes
        .into_iter()
        .map(|row| row.id)
        .collect();
    assert!(
        saved.contains(&pane),
        "the new pane {pane:?} should be saved, got {saved:?}"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn api_start_in_the_checkout_opens_nothing() -> Result<(), Report<StoreError>> {
    // Given the orb project and the actor started through its mailbox.
    let (store, project) = store_with_project()?;
    let zmx = zmx_running(&store);
    let (actor, _state, report) =
        spawned_reporting(store, &listing(Vec::new()), FakeGit::local(), zmx).await?;

    // When an agent asks for a session in its checkout.
    let started = api_start(&actor, project, false, None).await;

    // Then it gets the session, and nothing is reported ready to open.
    let opened = report
        .outcomes()
        .iter()
        .any(|outcome| matches!(outcome, Outcome::Ready { .. }));
    assert_eq!(
        (started.is_ok(), opened),
        (true, false),
        "an agent's new session is made but not opened"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn api_start_leaves_the_sidebar_cursor() -> Result<(), Report<StoreError>> {
    // Given the orb project and the actor started through its mailbox.
    let (store, project) = store_with_project()?;
    let zmx = zmx_running(&store);
    let (actor, state) = spawned(store, &listing(Vec::new()), zmx).await?;
    let before = state.read().sessions.cursor;

    // When an agent asks for a session in its checkout.
    api_start(&actor, project, false, None).await?;

    // Then the sidebar's cursor stays where it was.
    assert_eq!(
        state.read().sessions.cursor,
        before,
        "an agent's new session isn't selected"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn api_start_in_a_new_worktree_replies_with_its_session() -> Result<(), Report<StoreError>> {
    // Given the orb project and the actor started through its mailbox.
    let (store, project) = store_with_project()?;
    let zmx = zmx_running(&store);
    let git = FakeGit::local();
    let (actor, state) = spawned_with(store, &listing(Vec::new()), git.clone(), zmx).await?;

    // When an agent asks for a session in a new worktree.
    let (session, _pane) = api_start(&actor, project, true, None).await?;

    // Then the session it gets runs in the worktree orb made.
    let dir = sessions_of(&state)
        .into_iter()
        .find(|shown| shown.id == session)
        .map(|shown| shown.dir);
    assert_eq!(
        dir,
        git.added().map(|(path, _)| path),
        "the replied session runs in the new worktree"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn api_start_while_a_session_starts_is_refused_with_starting()
-> Result<(), Report<StoreError>> {
    // Given the orb project, the actor started through its mailbox, and a
    // session already starting.
    let (store, project) = store_with_project()?;
    let zmx = zmx_running(&store);
    let (actor, state) = spawned(store, &listing(Vec::new()), zmx).await?;
    state.write().sessions.starting = true;

    // When an agent asks for a session in its checkout.
    let started = api_start_answer(&actor, project, false).await?;

    // Then it is refused because another session is starting.
    assert!(
        matches!(
            started,
            Err(SendError::HandlerError(ApiStartError::Starting))
        ),
        "only one session starts at a time, got {started:?}"
    );
    Ok(())
}

#[rstest::rstest]
fn api_start_claims_starting_while_its_worktree_is_made() -> Result<(), Report<StoreError>> {
    // Given the orb project and no session starting.
    let (store, project) = store_with_project()?;
    let (mut actor, state) = start_with(
        store,
        &listing(Vec::new()),
        &FakeGit::local(),
        Path::new(NO_CLAUDE_DIR),
    );

    // When an agent asks for a session in a new worktree, before the job
    // making it has run.
    let start = ApiStart {
        project,
        worktree: true,
        name: None,
        parent: None,
        dir: None,
    };
    let _job = actor.api_start(start, None);

    // Then a session shows as starting.
    assert!(
        state.read().sessions.starting,
        "the agent's start holds the one starting slot while its worktree is made"
    );
    Ok(())
}

#[rstest::rstest]
fn api_start_in_a_new_worktree_leaves_the_default_branch_to_its_job()
-> Result<(), Report<StoreError>> {
    // Given a project whose default branch git can't read.
    let (store, project) = store_with_project()?;
    let (mut actor, _state) = start_with(
        store,
        &listing(Vec::new()),
        &FakeGit::plain(Ok(())),
        Path::new(NO_CLAUDE_DIR),
    );

    // When an agent asks for a session in a new worktree.
    let start = ApiStart {
        project,
        worktree: true,
        name: None,
        parent: None,
        dir: None,
    };
    let job = actor.api_start(start, None);

    // Then the start goes on to a worktree job, which reads the branch.
    assert!(
        job.is_some(),
        "the default branch is read in the job, not on the sessions queue"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn api_start_in_a_new_worktree_of_a_non_repo_fails_with_gits_reason()
-> Result<(), Report<StoreError>> {
    // Given a project that isn't a git repository, and the actor started
    // through its mailbox.
    let (store, project) = store_with_project()?;
    let zmx = zmx_running(&store);
    let git = FakeGit::plain(Ok(()));
    let (actor, _state) = spawned_with(store, &listing(Vec::new()), git, zmx).await?;

    // When an agent asks for a session in a new worktree.
    let started = api_start_answer(&actor, project, true).await?;

    // Then it fails with git's reason.
    assert!(
        matches!(
            &started,
            Err(SendError::HandlerError(ApiStartError::Failed(why))) if why == NOT_A_REPO
        ),
        "the agent hears why git refused, got {started:?}"
    );
    Ok(())
}

#[rstest::rstest]
#[tokio::test]
async fn api_start_saves_its_parent() -> Result<(), Report<StoreError>> {
    // Given a store file with the orb project and colony aa, and the actor
    // started through its mailbox.
    let dir = tempfile::tempdir().change_context(StoreError)?;
    let path = dir.path().join("state.sqlite");
    let store = Store::open(&path)?;
    let project = orb_project(&store)?;
    let colony = insert_agent(&store, "aa")?.session;
    let zmx = zmx_running(&store);
    let (actor, state) = spawned(store, &listing(Vec::new()), zmx).await?;

    // When an agent in aa asks for a session in the checkout.
    let (session, _pane) = api_start(&actor, project, false, Some(colony)).await?;

    // Then the new session has aa as its parent, shown and saved.
    let shown = sessions_of(&state)
        .into_iter()
        .find(|shown| shown.id == session)
        .and_then(|shown| shown.parent);
    let saved = Store::open(&path)?
        .layouts()?
        .sessions
        .into_iter()
        .find(|row| row.id == session)
        .and_then(|row| row.parent);
    assert_eq!(
        (shown, saved),
        (Some(colony), Some(colony)),
        "an agent's new session is its maker's colonist"
    );
    Ok(())
}

#[rstest::rstest]
fn api_start_whose_parent_was_deleted_meanwhile_is_top_level() -> Result<(), Report<StoreError>> {
    // Given the orb project and colony aa.
    let (store, project) = store_with_project()?;
    let colony = insert_agent(&store, "aa")?.session;
    let (mut actor, state) = start_with(
        store,
        &listing(Vec::new()),
        &FakeGit::local(),
        Path::new(NO_CLAUDE_DIR),
    );

    // When an agent in aa asks for a session in a new worktree, and aa is
    // deleted before the worktree is made.
    let start = ApiStart {
        project,
        worktree: true,
        name: None,
        parent: Some(colony),
        dir: None,
    };
    let job = actor.api_start(start, None);
    delete(&mut actor, colony);
    finish(&mut actor, job);

    // Then the new session has no parent.
    let parent = only_session(&state)?.parent;
    assert_eq!(
        parent, None,
        "a session made by a since-deleted session is top level"
    );
    Ok(())
}

#[rstest::rstest]
fn api_start_in_a_new_worktree_saves_its_parent() -> Result<(), Report<StoreError>> {
    // Given the orb project and colony aa.
    let (store, project) = store_with_project()?;
    let colony = insert_agent(&store, "aa")?.session;
    let (mut actor, state) = start_with(
        store,
        &listing(Vec::new()),
        &FakeGit::local(),
        Path::new(NO_CLAUDE_DIR),
    );

    // When an agent in aa asks for a session in a new worktree.
    let start = ApiStart {
        project,
        worktree: true,
        name: None,
        parent: Some(colony),
        dir: None,
    };
    let job = actor.api_start(start, None);
    finish(&mut actor, job);

    // Then the new session is aa's colonist.
    let parents: Vec<Option<SessionId>> = state
        .read()
        .sessions
        .sessions
        .iter()
        .filter(|session| session.id != colony)
        .map(|session| session.parent)
        .collect();
    assert_eq!(
        parents,
        [Some(colony)],
        "a worktree session an agent in a colony asks for is its colonist"
    );
    Ok(())
}

/// The session an agent in a Research colony's folder `dir` (under orb's
/// folder `orb_root`) gets when it asks for one there.
fn started_in_colony_folder(orb_root: &Path, dir: &Path) -> Result<Session, Report<StoreError>> {
    fs::create_dir_all(dir).change_context(StoreError)?;
    let (store, colony) = research_sessions(orb_root, dir)?;
    let (mut actor, state) = start_at(store, orb_root);
    let project = state
        .read()
        .sessions
        .session(colony.session)
        .map(|session| session.project)
        .ok_or_else(|| Report::new(StoreError).attach("no colony"))?;
    let start = ApiStart {
        project,
        worktree: false,
        name: None,
        parent: Some(colony.session),
        dir: Some(dir.to_path_buf()),
    };
    let job = actor.api_start(start, None);
    finish(&mut actor, job);
    sessions_of(&state)
        .into_iter()
        .find(|shown| shown.id != colony.session)
        .ok_or_else(|| Report::new(StoreError).attach("no new session"))
}

#[rstest::rstest]
fn api_start_in_a_folder_runs_there() -> Result<(), Report<StoreError>> {
    // Given a Research colony in its own folder under orb's.
    let orb = tempfile::tempdir().change_context(StoreError)?;
    let dir = orb.path().join("research").join("x");

    // When an agent in it asks for a session in that folder.
    let started = started_in_colony_folder(orb.path(), &dir)?;

    // Then the new session runs in the colony's folder.
    assert_eq!(started.dir, dir, "a helper runs in its colony's folder");
    Ok(())
}

#[rstest::rstest]
fn api_start_in_a_folder_is_a_plain_session() -> Result<(), Report<StoreError>> {
    // Given a Research colony in its own folder under orb's.
    let orb = tempfile::tempdir().change_context(StoreError)?;
    let dir = orb.path().join("research").join("x");

    // When an agent in it asks for a session in that folder.
    let started = started_in_colony_folder(orb.path(), &dir)?;

    // Then the new session is plain, not a colony.
    assert_eq!(
        started.kind,
        SessionKind::Plain,
        "a helper in a Research world is a plain session"
    );
    Ok(())
}

/// A new directory `base/<sub>/<name>`, for a world named `name`.
fn world_dir(base: &Path, sub: &str, name: &str) -> Result<PathBuf, Report<StoreError>> {
    let dir = base.join(sub).join(name);
    fs::create_dir_all(&dir).change_context(StoreError)?;
    Ok(dir)
}

#[rstest::rstest]
#[case("Kit", Some("kit"))]
#[case("research", None)]
fn add_world_refuses_a_taken_name(
    #[case] name: &str,
    #[case] existing: Option<&str>,
) -> Result<(), Report<StoreError>> {
    // Given the built-in worlds and maybe a world named `existing`.
    let (_orb_root, _, mut actor, _state) = creating(&FakeGit::local())?;
    let base = tempfile::tempdir().change_context(StoreError)?;
    if let Some(existing) = existing {
        actor.add_world(
            world_dir(base.path(), "a", existing)?,
            ProjectKind::FreshWorld,
        );
    }

    // When adding a world from another folder named `name`.
    actor.add_world(world_dir(base.path(), "b", name)?, ProjectKind::FreshWorld);

    // Then it's refused because the name is taken.
    assert_eq!(
        error_of(&actor),
        Some(format!("World {name} already exists")),
        "a world name should be taken whatever its case"
    );
    Ok(())
}

#[rstest::rstest]
fn add_world_refuses_orbs_own_folder() -> Result<(), Report<StoreError>> {
    // Given the built-in Research world in orb's folder.
    let (orb_root, _, mut actor, _state) = creating(&FakeGit::local())?;

    // When adding Research's folder as a fresh world.
    actor.add_world(orb_root.path().join("research"), ProjectKind::FreshWorld);

    // Then it's refused as one of orb's own folders.
    assert!(
        error_of(&actor).is_some_and(|error| error.ends_with("is one of orb's own folders")),
        "orb's own folders can't become worlds"
    );
    Ok(())
}

#[rstest::rstest]
fn add_world_turns_a_normal_project_into_a_world() -> Result<(), Report<StoreError>> {
    // Given the orb project.
    let (_orb_root, orb, mut actor, state) = creating(&FakeGit::local())?;

    // When adding its folder as a shared world.
    actor.add_world(PathBuf::from(PROJECT_ROOT), ProjectKind::SharedWorld);

    // Then it's the one project at that folder, now a shared world.
    let at_root: Vec<(ProjectId, ProjectKind)> = state
        .read()
        .sessions
        .projects
        .iter()
        .filter(|project| project.root == Path::new(PROJECT_ROOT))
        .map(|project| (project.id, project.kind))
        .collect();
    assert_eq!(
        at_root,
        [(orb, ProjectKind::SharedWorld)],
        "the project should become the world"
    );
    Ok(())
}

#[rstest::rstest]
fn add_world_shows_a_notice() -> Result<(), Report<StoreError>> {
    // Given no world named kit.
    let (_orb_root, _, mut actor, _state) = creating(&FakeGit::local())?;
    let base = tempfile::tempdir().change_context(StoreError)?;

    // When adding folder kit as a fresh world.
    actor.add_world(world_dir(base.path(), "a", "kit")?, ProjectKind::FreshWorld);

    // Then the notice names the world.
    assert_eq!(
        message_notices(&actor),
        ["Added world kit"],
        "adding a world should say it was added"
    );
    Ok(())
}

/// Adds `root` as a world of `kind` and returns its id.
fn added_world(
    actor: &mut SessionsActor,
    state: &State,
    root: &Path,
    kind: ProjectKind,
) -> ProjectId {
    actor.add_world(root.to_path_buf(), kind);
    state
        .read()
        .sessions
        .projects
        .iter()
        .find(|project| project.root == root)
        .map_or(ProjectId(0), |project| project.id)
}

/// A fresh world `kit` whose kit holds `AGENTS.md` and a `.git` folder.
fn fresh_kit(
    actor: &mut SessionsActor,
    state: &State,
    base: &Path,
) -> Result<ProjectId, Report<StoreError>> {
    let kit = world_dir(base, "a", "kit")?;
    fs::write(kit.join("AGENTS.md"), "kit").change_context(StoreError)?;
    fs::create_dir_all(kit.join(".git")).change_context(StoreError)?;
    fs::write(kit.join(".git/HEAD"), "ref").change_context(StoreError)?;
    Ok(added_world(actor, state, &kit, ProjectKind::FreshWorld))
}

#[rstest::rstest]
fn fresh_colony_copies_the_kit_without_git() -> Result<(), Report<StoreError>> {
    // Given a fresh world `kit` whose kit is a git repository.
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;
    let base = tempfile::tempdir().change_context(StoreError)?;
    let world = fresh_kit(&mut actor, &state, base.path())?;

    // When making colony `a` in it.
    make_colony(&mut actor, world, "a");

    // Then its folder has the kit's files but not its `.git`.
    let dir = orb_root.path().join("worlds/kit/a");
    assert_eq!(
        (dir.join("AGENTS.md").is_file(), dir.join(".git").exists()),
        (true, false),
        "a fresh colony should copy the kit without .git"
    );
    Ok(())
}

#[rstest::rstest]
fn fresh_colony_refused_when_its_folder_exists() -> Result<(), Report<StoreError>> {
    // Given a fresh world `kit` whose colony folder `a` already exists.
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;
    let base = tempfile::tempdir().change_context(StoreError)?;
    let world = fresh_kit(&mut actor, &state, base.path())?;
    fs::create_dir_all(orb_root.path().join("worlds/kit/a")).change_context(StoreError)?;

    // When making colony `a` in it.
    make_colony(&mut actor, world, "a");

    // Then it's refused and no session shows.
    assert_eq!(
        (
            error_of(&actor).is_some_and(|error| error.ends_with("already exists")),
            state.read().sessions.sessions.is_empty(),
        ),
        (true, true),
        "an existing colony folder should be refused"
    );
    Ok(())
}

#[rstest::rstest]
fn new_fresh_colony_copies_its_folder_beside_the_queue() -> Result<(), Report<StoreError>> {
    // Given a fresh world `kit`.
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;
    let base = tempfile::tempdir().change_context(StoreError)?;
    let world = fresh_kit(&mut actor, &state, base.path())?;

    // When asking for colony `a` in it.
    let job = actor.new_colony(world, "a", None);

    // Then a copy job comes back and the folder isn't made yet.
    assert_eq!(
        (job.is_some(), orb_root.path().join("worlds/kit/a").exists()),
        (true, false),
        "a fresh colony's folder should be copied by a job, not on the queue"
    );
    Ok(())
}

/// A fresh world `kit` whose colony `a` was copied, then the world removed
/// before the copy landed: the actor, the landed copy, and the folder.
fn copy_after_world_removed() -> Result<
    (
        tempfile::TempDir,
        tempfile::TempDir,
        SessionsActor,
        ColonyFolderReady,
        PathBuf,
    ),
    Report<StoreError>,
> {
    let (orb_root, _, mut actor, state) = creating(&FakeGit::local())?;
    let base = tempfile::tempdir().change_context(StoreError)?;
    let world = fresh_kit(&mut actor, &state, base.path())?;
    let Some(ColonyJob {
        world,
        if_active,
        copy,
    }) = actor.new_colony(world, "a", None)
    else {
        return Err(Report::new(StoreError).attach("a fresh colony should copy in a job"));
    };
    let made = copy.run();
    actor.remove_project(world);
    let dir = orb_root.path().join("worlds/kit/a");
    let ready = ColonyFolderReady {
        world,
        if_active,
        made,
    };
    Ok((orb_root, base, actor, ready, dir))
}

#[rstest::rstest]
fn fresh_colony_copy_landing_after_its_world_was_removed_removes_the_folder()
-> Result<(), Report<StoreError>> {
    // Given colony `a`'s folder copied, then its world removed.
    let (_orb_root, _base, mut actor, ready, dir) = copy_after_world_removed()?;

    // When the copy lands and the removal it hands back runs.
    finish_ready(&mut actor, ready);

    // Then the copied folder is gone.
    assert!(
        !dir.exists(),
        "a copy for a world removed meanwhile should be removed again"
    );
    Ok(())
}

#[rstest::rstest]
fn fresh_colony_copy_landing_after_its_world_was_removed_shows_why()
-> Result<(), Report<StoreError>> {
    // Given colony `a`'s folder copied, then its world removed.
    let (_orb_root, _base, mut actor, ready, _dir) = copy_after_world_removed()?;

    // When the copy lands.
    finish_ready(&mut actor, ready);

    // Then the mode line says the world is gone.
    assert_eq!(
        error_of(&actor).as_deref(),
        Some("couldn't find that world"),
        "a colony whose world was removed meanwhile should say why"
    );
    Ok(())
}

/// Hands `ready` to `actor` and runs any removal it hands back.
fn finish_ready(actor: &mut SessionsActor, ready: ColonyFolderReady) {
    actor
        .colony_folder_ready(ready)
        .into_iter()
        .for_each(RemoveFolder::run);
}

#[rstest::rstest]
fn shared_colony_runs_in_the_worlds_folder() -> Result<(), Report<StoreError>> {
    // Given a shared world.
    let (_orb_root, _, mut actor, state) = creating(&FakeGit::local())?;
    let base = tempfile::tempdir().change_context(StoreError)?;
    let root = world_dir(base.path(), "a", "orchestrators")?;
    let world = added_world(&mut actor, &state, &root, ProjectKind::SharedWorld);

    // When making colony `triage` in it.
    make_colony(&mut actor, world, "triage");

    // Then a colony named `triage` runs in the world's folder.
    let session = only_session(&state)?;
    assert_eq!(
        (session.kind, session.dir, session.name),
        (SessionKind::Colony, root, Some("triage".to_owned())),
        "a shared colony should run in the world's folder"
    );
    Ok(())
}

#[rstest::rstest]
fn shared_colony_refused_when_its_folder_is_gone() -> Result<(), Report<StoreError>> {
    // Given a shared world whose folder was removed after adding it.
    let (_orb_root, _, mut actor, state) = creating(&FakeGit::local())?;
    let base = tempfile::tempdir().change_context(StoreError)?;
    let root = world_dir(base.path(), "a", "orchestrators")?;
    let world = added_world(&mut actor, &state, &root, ProjectKind::SharedWorld);
    fs::remove_dir(&root).change_context(StoreError)?;

    // When making colony `triage` in it.
    make_colony(&mut actor, world, "triage");

    // Then it's refused and no session shows.
    assert_eq!(
        (
            error_of(&actor).is_some_and(|error| error.starts_with("couldn't find")),
            state.read().sessions.sessions.is_empty(),
        ),
        (true, true),
        "a shared world without its folder should refuse colonies"
    );
    Ok(())
}

#[rstest::rstest]
fn removing_a_world_keeps_its_colonies() -> Result<(), Report<StoreError>> {
    // Given a shared world with a colony.
    let (_orb_root, _, mut actor, state) = creating(&FakeGit::local())?;
    let base = tempfile::tempdir().change_context(StoreError)?;
    let root = world_dir(base.path(), "a", "orchestrators")?;
    let world = added_world(&mut actor, &state, &root, ProjectKind::SharedWorld);
    make_colony(&mut actor, world, "triage");

    // When removing the world.
    actor.remove_project(world);

    // Then the colony is still there.
    assert_eq!(
        state.read().sessions.sessions.len(),
        1,
        "removing a world should keep its colonies"
    );
    Ok(())
}
