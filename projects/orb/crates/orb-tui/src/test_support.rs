//! Fixtures and fakes the frontend's tests share.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use error_stack::Report;
use orb_domain::feat::git::git_service::{Git, GitError, GitRef, WorktreeFacts};
use orb_domain::feat::layout::state::{Layouts, PaneEntry, SessionLayout};
use orb_domain::feat::sessions::state::{Project, ProjectKind, Session, SessionKind};
use orb_domain::feat::zmx::zmx_service::{Zmx, ZmxError, ZmxOutput, ZmxSession};
use orb_domain::ids::{PaneId, SessionId};

/// Session `n`, for `n < 100`: 200 + n. The same ranges as the domain's
/// test ids (`feat::sessions::test_ids`), so a mixed-up id fails.
pub(crate) fn session(n: i64) -> SessionId {
    SessionId(200 + below_100(n))
}

/// Pane `n`, for `n < 100`: 300 + n.
pub(crate) fn pane(n: i64) -> PaneId {
    PaneId(300 + below_100(n))
}

fn below_100(n: i64) -> i64 {
    assert!(
        (0..100).contains(&n),
        "test ids hold 0..100 per kind, got {n}"
    );
    n
}

/// Layouts holding every pane `projects`' agents run in: one tab per pane,
/// in its agent's session.
pub(crate) fn layouts_for(projects: &[Project]) -> Layouts {
    let mut layouts = Layouts::default();
    for launch in projects
        .iter()
        .flat_map(|project| &project.agents)
        .filter_map(|agent| agent.pane.as_ref())
    {
        let entry = PaneEntry {
            id: launch.pane,
            zmx: ZmxSession {
                name: launch.pane.zmx_name(),
                dir: "/tmp/zmx".into(),
            },
            cwd: "/work".into(),
            name: None,
            resume: None,
        };
        match layouts.get(launch.session) {
            Some(_) => layouts.new_tab(launch.session, entry),
            None => layouts.insert(launch.session, SessionLayout::of(entry)),
        }
    }
    layouts
}

/// A zmx whose `list` answers as scripted and that records every command.
pub(crate) struct FakeZmx {
    list: Result<String, String>,
    calls: Mutex<Vec<Vec<OsString>>>,
}

impl FakeZmx {
    /// `list` prints `stdout` (one `name=…` line per running session).
    pub(crate) fn listing(stdout: &str) -> Self {
        Self {
            list: Ok(stdout.to_owned()),
            calls: Mutex::default(),
        }
    }

    /// `list` fails with `stderr`.
    pub(crate) fn failing(stderr: &str) -> Self {
        Self {
            list: Err(stderr.to_owned()),
            calls: Mutex::default(),
        }
    }

    /// The session names `kill` was run on, in order.
    pub(crate) fn killed(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter_map(|argv| {
                let at = argv.iter().position(|word| word == "kill")?;
                argv.get(at + 1)
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .collect()
    }
}

impl Zmx for FakeZmx {
    fn name(&self) -> &'static str {
        "fake"
    }

    fn run(&self, argv: &[OsString]) -> Result<ZmxOutput, Report<ZmxError>> {
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(argv.to_vec());
        let output = match (argv.iter().any(|word| word == "list"), &self.list) {
            (true, Ok(stdout)) => ZmxOutput {
                success: true,
                stdout: stdout.clone(),
                ..ZmxOutput::default()
            },
            (true, Err(stderr)) => ZmxOutput {
                success: false,
                stderr: stderr.clone(),
                ..ZmxOutput::default()
            },
            (false, _) => ZmxOutput {
                success: true,
                ..ZmxOutput::default()
            },
        };
        Ok(output)
    }
}

/// A git that finds no repository anywhere, so no test reaches the real
/// `git`.
pub(crate) struct NoGit;

fn not_a_repository<T>() -> Result<T, Report<GitError>> {
    Err(Report::new(GitError).attach("not a git repository".to_owned()))
}

impl Git for NoGit {
    fn name(&self) -> &'static str {
        "none"
    }

    fn refs(&self, _cwd: &Path) -> Result<Vec<GitRef>, Report<GitError>> {
        not_a_repository()
    }

    fn default_branch(&self, _repo: &Path) -> Result<String, Report<GitError>> {
        not_a_repository()
    }

    fn has_origin(&self, _repo: &Path) -> bool {
        false
    }

    fn fetch(&self, _repo: &Path, _branch: &str) -> Result<bool, Report<GitError>> {
        not_a_repository()
    }

    fn add_worktree(
        &self,
        _repo: &Path,
        _path: &Path,
        _branch: &str,
        _base: &str,
    ) -> Result<(), Report<GitError>> {
        not_a_repository()
    }

    fn remove_worktree(
        &self,
        _repo: &Path,
        _path: &Path,
        _force: bool,
    ) -> Result<(), Report<GitError>> {
        not_a_repository()
    }

    fn add_worktree_on(
        &self,
        _repo: &Path,
        _path: &Path,
        _branch: &str,
    ) -> Result<(), Report<GitError>> {
        not_a_repository()
    }

    fn prune_worktrees(&self, _repo: &Path) -> Result<(), Report<GitError>> {
        not_a_repository()
    }

    fn worktree_facts(&self, _path: &Path) -> Result<WorktreeFacts, Report<GitError>> {
        not_a_repository()
    }

    fn disk_usage(&self, _path: &Path) -> Option<u64> {
        None
    }

    fn delete_branch(
        &self,
        _repo: &Path,
        _branch: &str,
        _force: bool,
    ) -> Result<(), Report<GitError>> {
        not_a_repository()
    }

    fn branch_exists(&self, _repo: &Path, _branch: &str) -> bool {
        false
    }

    fn is_merged(&self, _repo: &Path, _branch: &str) -> bool {
        false
    }

    fn has_remote_branch(&self, _repo: &Path, _branch: &str) -> bool {
        false
    }

    fn init(&self, _dir: &Path) -> Result<(), Report<GitError>> {
        not_a_repository()
    }

    fn checkout(&self, _cwd: &Path, _git_ref: &GitRef) -> Result<String, Report<GitError>> {
        not_a_repository()
    }

    fn rename_branch(&self, _cwd: &Path, _old: &str, _new: &str) -> Result<(), Report<GitError>> {
        not_a_repository()
    }

    fn project_path(&self, _cwd: &Path) -> Option<PathBuf> {
        None
    }
}

/// The sessions `projects`' agents run in, one per pane session, as the
/// sessions actor would show them: each in its first agent's directory,
/// neither pinned nor settled, active since the agent's creation.
pub(crate) fn sessions_for(projects: &[Project]) -> Vec<Session> {
    let mut shown: Vec<Session> = Vec::new();
    for project in projects {
        for agent in &project.agents {
            let Some(id) = agent.session() else {
                continue;
            };
            if shown.iter().any(|session| session.id == id) {
                continue;
            }
            shown.push(Session {
                id,
                project: project.id,
                kind: match project.kind {
                    ProjectKind::Normal | ProjectKind::SharedWorld => SessionKind::Plain,
                    ProjectKind::Research | ProjectKind::Learn | ProjectKind::FreshWorld => {
                        SessionKind::Colony
                    }
                    ProjectKind::Incognito => SessionKind::Incognito,
                },
                dir: agent.cwd.clone(),
                name: None,
                branch: None,
                created_at: agent.created_at,
                pinned_at: None,
                settled_at: None,
                parent: None,
                active_since: agent.created_at,
                last_activity_at: agent.last_activity_at,
            });
        }
    }
    shown
}
