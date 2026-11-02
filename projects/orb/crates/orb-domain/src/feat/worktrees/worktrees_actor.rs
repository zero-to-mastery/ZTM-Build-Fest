//! The worktrees actor — owns `AppState.worktrees`.
//!
//! It lists orb's worktrees, reads their git facts and sizes, sweeps at start
//! and every hour after, and deletes a worktree when the user asks. A sweep
//! never forces a removal, and nothing here deletes a branch.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use kameo::mailbox;
use kameo::prelude::{Actor, ActorRef, Context, Message, Spawn};
use tokio::time::MissedTickBehavior;

use super::state::{Verdict, Worktree, users, verdict};
use crate::command::WorktreesCommand;
use crate::common::{Outcome, Reporter, State};
use crate::feat::git::git_service::{GitService, git_reason};

/// How often the sweep runs after the first, at start.
pub const SWEEP_EVERY: Duration = Duration::from_hours(1);

/// What the worktrees actor needs to start.
pub struct WorktreesActorDeps {
    pub git: GitService,
    pub state: State,
    /// `~/.orb/worktrees`: its `*/*` directories are the worktrees.
    pub worktrees_root: PathBuf,
    /// Tells the frontend loop what changed.
    pub report: Reporter,
    /// The time between sweeps.
    pub sweep_every: Duration,
}

/// Owns [`Worktrees`](super::state::Worktrees): the list of orb's worktrees
/// with their facts and sizes. Its notices go to the frontend loop as
/// reports.
pub struct WorktreesActor {
    git: GitService,
    state: State,
    worktrees_root: PathBuf,
    report: Reporter,
    sweep_every: Duration,
}

/// Rescan, read facts, prune, then read sizes.
#[derive(Debug)]
pub struct Sweep;

/// Spawns the worktrees actor with a mailbox that never refuses a message.
/// Must be called inside a tokio runtime.
pub fn spawn_worktrees_actor(deps: WorktreesActorDeps) -> ActorRef<WorktreesActor> {
    WorktreesActor::spawn_with_mailbox(deps, mailbox::unbounded())
}

impl Actor for WorktreesActor {
    type Args = WorktreesActorDeps;
    type Error = kameo::error::Infallible;

    fn on_start(
        args: Self::Args,
        actor_ref: ActorRef<Self>,
    ) -> impl Future<Output = Result<Self, Self::Error>> + Send {
        let actor = Self::new(args);
        let every = actor.sweep_every;
        tokio::spawn(async move {
            let mut ticks = tokio::time::interval(every);
            ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                ticks.tick().await;
                if actor_ref.ask(Sweep).await.is_err() {
                    break;
                }
            }
        });
        std::future::ready(Ok(actor))
    }
}

impl Message<WorktreesCommand> for WorktreesActor {
    type Reply = ();

    fn handle(
        &mut self,
        msg: WorktreesCommand,
        _ctx: &mut Context<Self, Self::Reply>,
    ) -> impl Future<Output = Self::Reply> + Send {
        match msg {
            WorktreesCommand::RefreshWorktrees => self.refresh(),
            WorktreesCommand::DeleteWorktree { path } => self.delete(&path),
        }
        std::future::ready(())
    }
}

impl Message<Sweep> for WorktreesActor {
    type Reply = ();

    async fn handle(&mut self, _msg: Sweep, _ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.sweep();
    }
}

impl WorktreesActor {
    fn new(deps: WorktreesActorDeps) -> Self {
        Self {
            git: deps.git,
            state: deps.state,
            worktrees_root: deps.worktrees_root,
            report: deps.report,
            sweep_every: deps.sweep_every,
        }
    }

    /// Rescans and reads facts, removes every worktree due, says how many,
    /// then rescans and reads sizes last, since `du` is slow.
    fn sweep(&self) {
        self.scan();
        self.read_facts();
        let n = self.prune();
        if n > 0 {
            let s = if n == 1 { "" } else { "s" };
            self.report
                .report(Outcome::Notice(format!("pruned {n} worktree{s}")));
        }
        self.scan();
        self.read_sizes();
    }

    /// Removes, without forcing, every worktree whose verdict is to prune
    /// now, keeping its branch. The verdict is worked out from the state read
    /// right before each removal, so an agent attached meanwhile saves it.
    /// Prunes nothing while no projects are loaded, or after some saved
    /// layouts couldn't be read at start, since then a worktree in use could
    /// read as unused, nor while a session is starting, since
    /// a worktree made for it has no agent until the start ends. Returns how
    /// many were removed.
    fn prune(&self) -> usize {
        {
            let app = self.state.read();
            if app.sessions.projects.is_empty() || app.sessions.partial_load {
                return 0;
            }
        }
        let candidates: Vec<(PathBuf, PathBuf)> = self
            .state
            .read()
            .worktrees
            .list
            .iter()
            .filter_map(|w| Some((w.repo.clone()?, w.path.clone())))
            .collect();
        candidates
            .into_iter()
            .filter(|(repo, path)| {
                let due = {
                    let app = self.state.read();
                    let facts = app
                        .worktrees
                        .list
                        .iter()
                        .find(|w| &w.path == path)
                        .and_then(|w| w.facts.as_ref());
                    !app.sessions.starting
                        && verdict(&users(&app, path), facts, &app.attached, SystemTime::now())
                            == Verdict::PruneNow
                };
                due && self
                    .git
                    .remove_worktree(repo, path, false, "unused, swept")
                    .is_ok()
            })
            .count()
    }

    /// Rescans, then reads facts, then sizes.
    fn refresh(&self) {
        self.scan();
        self.read_facts();
        self.read_sizes();
    }

    /// Force-removes the worktree at `path` through its main repository,
    /// keeping its branch, then rescans and re-reads facts. A failure, or a
    /// path with no known repository, is reported as a notice.
    fn delete(&self, path: &Path) {
        let repo = self
            .state
            .read()
            .worktrees
            .list
            .iter()
            .find(|w| w.path == path)
            .and_then(|w| w.repo.clone());
        let failure = match repo {
            None => Some("not a git worktree".to_owned()),
            Some(repo) => self
                .git
                .remove_worktree(&repo, path, true, "deleted from the worktree picker")
                .err()
                .map(|report| git_reason(&report)),
        };
        if let Some(failure) = failure {
            self.report.report(Outcome::Notice(failure));
        }
        self.scan();
        self.read_facts();
    }

    /// Lists the `*/*` directories under the root, keeping what's already
    /// known about paths still there, and reports the new list, so an open
    /// worktree picker re-lists. Only a directory whose `.git` is a file
    /// (a linked worktree) gets a repo, so git never answers for an enclosing
    /// repository.
    fn scan(&self) {
        let paths = {
            let mut paths: Vec<PathBuf> = subdirs(&self.worktrees_root)
                .iter()
                .flat_map(|repo| subdirs(repo))
                .collect();
            paths.sort();
            paths
        };
        let old = self.state.read().worktrees.list.clone();
        let list = paths
            .into_iter()
            .map(|path| match old.iter().find(|w| w.path == path) {
                Some(known) => known.clone(),
                None => Worktree {
                    repo: path
                        .join(".git")
                        .is_file()
                        .then(|| self.git.project_path(&path))
                        .flatten(),
                    path,
                    facts: None,
                    size_kb: None,
                },
            })
            .collect();
        self.state.write().worktrees.list = list;
        self.report.report(Outcome::WorktreesChanged);
    }

    /// Reads git's facts for every worktree with a known repo, writing each
    /// as it lands.
    fn read_facts(&self) {
        for path in self.paths(|w| w.repo.is_some()) {
            let facts = self.git.worktree_facts(&path).ok();
            self.update(&path, |w| w.facts = facts);
        }
    }

    /// Measures every worktree on disk, writing each size as it lands.
    fn read_sizes(&self) {
        for path in self.paths(|_| true) {
            let size_kb = self.git.disk_usage(&path);
            self.update(&path, |w| w.size_kb = size_kb);
        }
    }

    /// The listed worktrees' paths that pass `keep`.
    fn paths<F>(&self, keep: F) -> Vec<PathBuf>
    where
        F: Fn(&Worktree) -> bool,
    {
        self.state
            .read()
            .worktrees
            .list
            .iter()
            .filter(|w| keep(w))
            .map(|w| w.path.clone())
            .collect()
    }

    /// Edits the listed worktree at `path`, if still listed, then reports the change.
    fn update<F>(&self, path: &Path, edit: F)
    where
        F: FnOnce(&mut Worktree),
    {
        if let Some(w) = self
            .state
            .write()
            .worktrees
            .list
            .iter_mut()
            .find(|w| w.path == path)
        {
            edit(w);
        }
        self.report.changed();
    }
}

/// The directories directly inside `dir`; none when it can't be read.
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate setup failures with `?` and assert on the outcome"
)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, OnceLock, PoisonError};
    use std::time::{Duration, Instant, UNIX_EPOCH};

    use error_stack::Report;
    use tempfile::TempDir;

    use super::{SWEEP_EVERY, WorktreesActor, WorktreesActorDeps, spawn_worktrees_actor};
    use crate::AppState;
    use crate::common::{Log, Outcome, Reporter, State};
    use crate::feat::git::git_service::{Git, GitError, GitRef, GitService, WorktreeFacts};
    use crate::feat::sessions::state::{Project, ProjectKind, Sessions};
    use crate::feat::worktrees::state::Worktree;
    use crate::ids::ProjectId;

    /// The main repository the fake git names for every linked worktree.
    const REPO: &str = "/repo";

    /// A git call the actor made.
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Call {
        Facts(PathBuf),
        Size(PathBuf),
        Remove { path: PathBuf, force: bool },
        DeleteBranch(String),
    }

    /// Answers every worktree as clean on `main`, every remove with success
    /// and every size as 42 KB, unless told otherwise per path.
    #[derive(Default)]
    struct FakeGit {
        /// Facts that differ from clean on `main`.
        facts: HashMap<PathBuf, WorktreeFacts>,
        /// Paths whose remove git refuses with this reason.
        refused: HashMap<PathBuf, String>,
        calls: Mutex<Vec<Call>>,
        /// The app state `disk_usage` looks at, once a test watches one.
        watched: OnceLock<State>,
        /// Whether the measured path's facts were in the state as each
        /// watched `disk_usage` ran.
        facts_seen: Mutex<Vec<bool>>,
    }

    impl FakeGit {
        fn calls(&self) -> Vec<Call> {
            self.calls
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }

        fn record(&self, call: Call) {
            self.calls
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(call);
        }

        fn facts_calls(&self) -> usize {
            self.calls()
                .iter()
                .filter(|call| matches!(call, Call::Facts(_)))
                .count()
        }

        /// Looks at `state` on every later `disk_usage`.
        fn watch(&self, state: &State) {
            let _ = self.watched.set(state.clone());
        }

        fn facts_seen(&self) -> Vec<bool> {
            self.facts_seen
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }
    }

    fn refused(reason: &str) -> Report<GitError> {
        Report::new(GitError).attach(reason.to_owned())
    }

    impl Git for FakeGit {
        fn name(&self) -> &'static str {
            "fake"
        }

        fn refs(&self, _cwd: &Path) -> Result<Vec<GitRef>, Report<GitError>> {
            Ok(Vec::new())
        }

        fn default_branch(&self, _repo: &Path) -> Result<String, Report<GitError>> {
            Ok("main".to_owned())
        }

        fn has_origin(&self, _repo: &Path) -> bool {
            false
        }

        fn fetch(&self, _repo: &Path, _branch: &str) -> Result<bool, Report<GitError>> {
            Ok(false)
        }

        fn add_worktree(
            &self,
            _repo: &Path,
            _path: &Path,
            _branch: &str,
            _base: &str,
        ) -> Result<(), Report<GitError>> {
            Ok(())
        }

        fn remove_worktree(
            &self,
            _repo: &Path,
            path: &Path,
            force: bool,
        ) -> Result<(), Report<GitError>> {
            self.record(Call::Remove {
                path: path.to_owned(),
                force,
            });
            match self.refused.get(path) {
                Some(reason) => Err(refused(reason)),
                None => Ok(()),
            }
        }

        fn add_worktree_on(
            &self,
            _repo: &Path,
            _path: &Path,
            _branch: &str,
        ) -> Result<(), Report<GitError>> {
            Ok(())
        }

        fn prune_worktrees(&self, _repo: &Path) -> Result<(), Report<GitError>> {
            Ok(())
        }

        fn worktree_facts(&self, path: &Path) -> Result<WorktreeFacts, Report<GitError>> {
            self.record(Call::Facts(path.to_owned()));
            Ok(self.facts.get(path).cloned().unwrap_or_else(clean))
        }

        fn disk_usage(&self, path: &Path) -> Option<u64> {
            self.record(Call::Size(path.to_owned()));
            if let Some(state) = self.watched.get() {
                let known = state
                    .read()
                    .worktrees
                    .list
                    .iter()
                    .any(|w| w.path == path && w.facts.is_some());
                self.facts_seen
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(known);
            }
            Some(42)
        }

        fn delete_branch(
            &self,
            _repo: &Path,
            branch: &str,
            _force: bool,
        ) -> Result<(), Report<GitError>> {
            self.record(Call::DeleteBranch(branch.to_owned()));
            Ok(())
        }

        fn branch_exists(&self, _repo: &Path, _branch: &str) -> bool {
            true
        }

        fn is_merged(&self, _repo: &Path, _branch: &str) -> bool {
            true
        }

        fn has_remote_branch(&self, _repo: &Path, _branch: &str) -> bool {
            false
        }

        fn init(&self, _dir: &Path) -> Result<(), Report<GitError>> {
            Ok(())
        }

        fn checkout(&self, _cwd: &Path, git_ref: &GitRef) -> Result<String, Report<GitError>> {
            Ok(git_ref.name.clone())
        }

        fn rename_branch(
            &self,
            _cwd: &Path,
            _old: &str,
            _new: &str,
        ) -> Result<(), Report<GitError>> {
            Ok(())
        }

        fn project_path(&self, _cwd: &Path) -> Option<PathBuf> {
            Some(PathBuf::from(REPO))
        }
    }

    fn clean() -> WorktreeFacts {
        WorktreeFacts {
            branch: Some("main".to_owned()),
            changes: 0,
            last_commit: None,
        }
    }

    fn dirty() -> WorktreeFacts {
        WorktreeFacts {
            changes: 2,
            ..clean()
        }
    }

    /// A linked worktree `orb/<name>` under `root`: a directory with a
    /// `.git` file.
    fn worktree(root: &TempDir, name: &str) -> io::Result<PathBuf> {
        let path = plain_dir(root, name)?;
        fs::write(path.join(".git"), "gitdir: /repo/.git/worktrees/x\n")?;
        Ok(path)
    }

    /// A directory `orb/<name>` under `root` that isn't a linked worktree.
    fn plain_dir(root: &TempDir, name: &str) -> io::Result<PathBuf> {
        let path = root.path().join("orb").join(name);
        fs::create_dir_all(&path)?;
        Ok(path)
    }

    /// One project with no agents.
    fn one_project() -> AppState {
        AppState {
            sessions: Sessions {
                projects: vec![Project {
                    id: ProjectId(1),
                    title: "orb".to_owned(),
                    root: PathBuf::from(REPO),
                    created_at: UNIX_EPOCH,
                    agents: Vec::new(),
                    repo: true,
                    removed: false,
                    kind: ProjectKind::Normal,
                }],
                ..Sessions::default()
            },
            ..AppState::default()
        }
    }

    /// The notices `actor` reported, oldest first.
    fn notices(actor: &WorktreesActor) -> Vec<String> {
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

    fn deps(
        git: &Arc<FakeGit>,
        root: &TempDir,
        state: &State,
        every: Duration,
    ) -> WorktreesActorDeps {
        WorktreesActorDeps {
            git: GitService::new(git.clone(), Log::default()),
            state: state.clone(),
            worktrees_root: root.path().to_owned(),
            report: Reporter::new(|_| {}),
            sweep_every: every,
        }
    }

    /// An actor without its timer over `root`, and the state it writes.
    fn start(git: &Arc<FakeGit>, root: &TempDir, app: AppState) -> (WorktreesActor, State) {
        let state = State::new(app);
        let actor = WorktreesActor::new(deps(git, root, &state, SWEEP_EVERY));
        (actor, state)
    }

    /// Waits up to five seconds for `done`; whether it came true.
    async fn eventually<F>(done: F) -> bool
    where
        F: Fn() -> bool,
    {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            if Instant::now() > deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        true
    }

    #[rstest::rstest]
    fn sweep_removes_a_clean_candidate_without_force() -> io::Result<()> {
        // Given a clean worktree nothing uses.
        let root = tempfile::tempdir()?;
        let path = worktree(&root, "orb-a1")?;
        let git = Arc::new(FakeGit::default());
        let (actor, _state) = start(&git, &root, one_project());

        // When sweeping.
        actor.sweep();

        // Then git removed it without force.
        assert!(
            git.calls().contains(&Call::Remove { path, force: false }),
            "the sweep should remove the orphan without force"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn sweep_keeps_the_branch() -> io::Result<()> {
        // Given a clean worktree nothing uses.
        let root = tempfile::tempdir()?;
        worktree(&root, "orb-a1")?;
        let git = Arc::new(FakeGit::default());
        let (actor, _state) = start(&git, &root, one_project());

        // When sweeping.
        actor.sweep();

        // Then no branch was deleted.
        assert!(
            !git.calls()
                .iter()
                .any(|call| matches!(call, Call::DeleteBranch(_))),
            "the sweep should never delete a branch"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn sweep_skips_a_refused_remove() -> io::Result<()> {
        // Given two orphans, git refusing to remove the first.
        let root = tempfile::tempdir()?;
        let first = worktree(&root, "orb-a1")?;
        let second = worktree(&root, "orb-b2")?;
        let git = Arc::new(FakeGit {
            refused: HashMap::from([(first, "fatal: busy".to_owned())]),
            ..FakeGit::default()
        });
        let (actor, _state) = start(&git, &root, one_project());

        // When sweeping.
        actor.sweep();

        // Then the second is still removed.
        assert!(
            git.calls().contains(&Call::Remove {
                path: second,
                force: false
            }),
            "a refused remove should not stop the sweep"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn sweep_reports_how_many_were_pruned() -> io::Result<()> {
        // Given two clean orphans.
        let root = tempfile::tempdir()?;
        worktree(&root, "orb-a1")?;
        worktree(&root, "orb-b2")?;
        let git = Arc::new(FakeGit::default());
        let (actor, _state) = start(&git, &root, one_project());

        // When sweeping.
        actor.sweep();

        // Then the reported notice counts both.
        assert_eq!(
            notices(&actor),
            ["pruned 2 worktrees"],
            "the notice should say how many were pruned"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn sweep_that_removes_nothing_reports_no_notice() -> io::Result<()> {
        // Given an orphan with uncommitted changes.
        let root = tempfile::tempdir()?;
        let path = worktree(&root, "orb-a1")?;
        let git = Arc::new(FakeGit {
            facts: HashMap::from([(path, dirty())]),
            ..FakeGit::default()
        });
        let (actor, _state) = start(&git, &root, one_project());

        // When sweeping.
        actor.sweep();

        // Then no notice is reported.
        assert_eq!(
            notices(&actor),
            Vec::<String>::new(),
            "a sweep that removes nothing should say nothing"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn sweep_prunes_nothing_while_no_projects_are_loaded() -> io::Result<()> {
        // Given a clean worktree and no projects loaded.
        let root = tempfile::tempdir()?;
        worktree(&root, "orb-a1")?;
        let git = Arc::new(FakeGit::default());
        let (actor, _state) = start(&git, &root, AppState::default());

        // When sweeping.
        actor.sweep();

        // Then nothing is removed.
        assert!(
            !git.calls()
                .iter()
                .any(|call| matches!(call, Call::Remove { .. })),
            "with no projects loaded every worktree looks unused, so none is pruned"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn sweep_prunes_nothing_after_a_partial_load() -> io::Result<()> {
        // Given a clean worktree nothing uses, and saved layouts orb couldn't
        // all read at start.
        let root = tempfile::tempdir()?;
        worktree(&root, "orb-a1")?;
        let git = Arc::new(FakeGit::default());
        let (actor, state) = start(&git, &root, one_project());
        state.write().sessions.partial_load = true;

        // When sweeping.
        actor.sweep();

        // Then nothing is removed.
        assert!(
            !git.calls()
                .iter()
                .any(|call| matches!(call, Call::Remove { .. })),
            "a session orb couldn't read may use the worktree, so none is pruned"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn sweep_prunes_nothing_while_a_session_is_starting() -> io::Result<()> {
        // Given a clean worktree nothing uses yet, made for a session that is
        // still starting.
        let root = tempfile::tempdir()?;
        worktree(&root, "orb-a1")?;
        let git = Arc::new(FakeGit::default());
        let (actor, state) = start(&git, &root, one_project());
        state.write().sessions.starting = true;

        // When sweeping.
        actor.sweep();

        // Then nothing is removed.
        assert!(
            !git.calls()
                .iter()
                .any(|call| matches!(call, Call::Remove { .. })),
            "a worktree made for a starting session has no agent yet, so none is pruned"
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test]
    async fn second_sweep_inside_the_hour_does_not_run() -> io::Result<()> {
        // Given a worktree and an actor sweeping hourly.
        let root = tempfile::tempdir()?;
        worktree(&root, "orb-a1")?;
        let git = Arc::new(FakeGit::default());
        let state = State::new(one_project());

        // When it starts and the first sweep has read the facts.
        let _actor = spawn_worktrees_actor(deps(&git, &root, &state, Duration::from_hours(1)));
        let first = eventually(|| git.facts_calls() >= 1).await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        // Then exactly one sweep has run.
        assert!(
            first && git.facts_calls() == 1,
            "only the startup sweep should run inside the hour, saw {} fact reads",
            git.facts_calls()
        );
        Ok(())
    }

    #[rstest::rstest]
    #[tokio::test]
    async fn sweep_runs_again_after_the_interval() -> io::Result<()> {
        // Given a worktree and an actor sweeping every 50 ms.
        let root = tempfile::tempdir()?;
        worktree(&root, "orb-a1")?;
        let git = Arc::new(FakeGit::default());
        let state = State::new(one_project());

        // When it starts.
        let _actor = spawn_worktrees_actor(deps(&git, &root, &state, Duration::from_millis(50)));

        // Then a second sweep reads the facts again.
        assert!(
            eventually(|| git.facts_calls() >= 2).await,
            "the sweep should run again after the interval"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn refresh_writes_facts_then_sizes() -> io::Result<()> {
        // Given two worktrees and a git watching the state.
        let root = tempfile::tempdir()?;
        worktree(&root, "orb-a1")?;
        worktree(&root, "orb-b2")?;
        let git = Arc::new(FakeGit::default());
        let (actor, state) = start(&git, &root, one_project());
        git.watch(&state);

        // When refreshing.
        actor.refresh();

        // Then each worktree's facts were in the state when it was measured.
        assert_eq!(
            git.facts_seen(),
            vec![true, true],
            "facts should land before each size is read"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn refresh_writes_the_size() -> io::Result<()> {
        // Given a worktree.
        let root = tempfile::tempdir()?;
        worktree(&root, "orb-a1")?;
        let git = Arc::new(FakeGit::default());
        let (actor, state) = start(&git, &root, one_project());

        // When refreshing.
        actor.refresh();

        // Then its size is in the state.
        let sizes: Vec<Option<u64>> = state
            .read()
            .worktrees
            .list
            .iter()
            .map(|w| w.size_kb)
            .collect();
        assert_eq!(sizes, vec![Some(42)], "the measured size should be written");
        Ok(())
    }

    #[rstest::rstest]
    fn delete_worktree_forces_the_remove() -> io::Result<()> {
        // Given a scanned worktree.
        let root = tempfile::tempdir()?;
        let path = worktree(&root, "orb-a1")?;
        let git = Arc::new(FakeGit::default());
        let (actor, _state) = start(&git, &root, one_project());
        actor.scan();

        // When deleting it.
        actor.delete(&path);

        // Then git removed it with force.
        assert!(
            git.calls().contains(&Call::Remove { path, force: true }),
            "a delete should force the remove"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn failed_delete_reports_gits_reason() -> io::Result<()> {
        // Given a scanned worktree git refuses to remove.
        let root = tempfile::tempdir()?;
        let path = worktree(&root, "orb-a1")?;
        let git = Arc::new(FakeGit {
            refused: HashMap::from([(path.clone(), "fatal: locked".to_owned())]),
            ..FakeGit::default()
        });
        let (actor, _state) = start(&git, &root, one_project());
        actor.scan();

        // When deleting it.
        actor.delete(&path);

        // Then git's reason is reported as a notice.
        assert_eq!(
            notices(&actor),
            ["fatal: locked"],
            "the notice should carry git's reason"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn scan_reports_the_new_worktree_list() -> io::Result<()> {
        // Given a new worktree on disk.
        let root = tempfile::tempdir()?;
        worktree(&root, "orb-a1")?;
        let git = Arc::new(FakeGit::default());
        let (actor, _state) = start(&git, &root, one_project());

        // When scanning.
        actor.scan();

        // Then the loop is told the list changed, so an open picker re-lists.
        assert!(
            actor.report.outcomes().contains(&Outcome::WorktreesChanged),
            "a rescan should report the new list"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn scan_keeps_known_facts_for_unchanged_paths() -> io::Result<()> {
        // Given a listed worktree with known repo, facts and size.
        let root = tempfile::tempdir()?;
        let path = worktree(&root, "orb-a1")?;
        let known = Worktree {
            path,
            repo: Some(PathBuf::from("/known")),
            facts: Some(dirty()),
            size_kb: Some(7),
        };
        let git = Arc::new(FakeGit::default());
        let (actor, state) = start(&git, &root, one_project());
        state.write().worktrees.list = vec![known.clone()];

        // When scanning.
        actor.scan();

        // Then the entry is unchanged.
        assert_eq!(
            state.read().worktrees.list,
            vec![known],
            "a rescan should keep what's known about a path still there"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn scan_reads_no_facts_for_a_directory_that_is_not_a_worktree() -> io::Result<()> {
        // Given a directory without a `.git` file.
        let root = tempfile::tempdir()?;
        let path = plain_dir(&root, "notes")?;
        let git = Arc::new(FakeGit::default());
        let (actor, state) = start(&git, &root, one_project());

        // When refreshing.
        actor.refresh();

        // Then git was never asked for its facts, and it has none.
        let facts: Vec<Option<WorktreeFacts>> = state
            .read()
            .worktrees
            .list
            .iter()
            .map(|w| w.facts.clone())
            .collect();
        assert!(
            !git.calls().contains(&Call::Facts(path)) && facts == vec![None],
            "a directory that isn't a linked worktree should get no facts"
        );
        Ok(())
    }
}
