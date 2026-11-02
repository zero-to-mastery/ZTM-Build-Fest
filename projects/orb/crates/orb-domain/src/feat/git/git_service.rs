//! What orb asks of git: the branches an agent could switch to, a project's
//! default branch, making, checking out, renaming, removing and pruning
//! worktrees and branches, whether a branch is merged, a worktree's state and
//! its size on disk, making a directory a repository, and the repository
//! harnesses take a directory to belong to.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use error_stack::Report;
use wherror::Error;

use crate::Log;

/// A git call failed. Every report carries a one-line reason as its latest
/// `String` attachment, fit for the mode line.
#[derive(Debug, Error)]
#[error(debug)]
pub struct GitError;

/// A branch an agent could be on: a local branch or a remote ref.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRef {
    /// `main` for a local branch, `origin/feature` for a remote ref.
    pub name: String,
    pub remote: bool,
    /// The branch checked out where the refs were listed.
    pub current: bool,
    /// The repository's default branch (`origin/HEAD`'s), local or on origin.
    pub default: bool,
    /// Where a local branch is checked out, the root checkout included.
    pub worktree: Option<PathBuf>,
}

/// What git says about one worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeFacts {
    /// The checked-out branch; `None` on a detached HEAD.
    pub branch: Option<String>,
    /// Lines of `git status --porcelain`, untracked files included.
    pub changes: usize,
    /// The last commit's time and subject; `None` when there is none.
    pub last_commit: Option<(SystemTime, String)>,
}

/// Runs git against repositories on disk.
pub trait Git: Send + Sync {
    fn name(&self) -> &'static str;

    /// The refs of the repository containing `cwd`: the current branch, the
    /// default branch, other local branches newest commit first, then remote
    /// refs newest commit first. `origin/<b>` is left out when a local `<b>`
    /// exists.
    ///
    /// # Errors
    ///
    /// Returns an error if git can't list the refs.
    fn refs(&self, cwd: &Path) -> Result<Vec<GitRef>, Report<GitError>>;

    /// `origin/HEAD`'s branch, else the current branch.
    ///
    /// # Errors
    ///
    /// Returns an error if the repository has neither.
    fn default_branch(&self, repo: &Path) -> Result<String, Report<GitError>>;

    /// Whether the repository has an `origin` remote.
    fn has_origin(&self, repo: &Path) -> bool;

    /// Fetches `branch` from origin into `origin/<branch>`. `Ok(false)` when
    /// origin has no such branch.
    ///
    /// # Errors
    ///
    /// Returns an error if the fetch fails for any other reason, or takes
    /// longer than its time limit.
    fn fetch(&self, repo: &Path, branch: &str) -> Result<bool, Report<GitError>>;

    /// Adds a worktree at `path` on a new `branch` started from `base`.
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses, e.g. when `branch` or `path` exists.
    fn add_worktree(
        &self,
        repo: &Path,
        path: &Path,
        branch: &str,
        base: &str,
    ) -> Result<(), Report<GitError>>;

    /// Removes the worktree at `path`. Without `force`, git refuses a dirty
    /// worktree.
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses.
    fn remove_worktree(
        &self,
        repo: &Path,
        path: &Path,
        force: bool,
    ) -> Result<(), Report<GitError>>;

    /// Adds a worktree at `path` on the existing `branch`.
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses, e.g. when `branch` is checked out
    /// elsewhere or `path` is still registered.
    fn add_worktree_on(
        &self,
        repo: &Path,
        path: &Path,
        branch: &str,
    ) -> Result<(), Report<GitError>>;

    /// Forgets worktrees whose directories are gone (`git worktree prune`).
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses.
    fn prune_worktrees(&self, repo: &Path) -> Result<(), Report<GitError>>;

    /// The branch, uncommitted changes and last commit of the worktree at
    /// `path`.
    ///
    /// # Errors
    ///
    /// Returns an error if `path` isn't in a git repository.
    fn worktree_facts(&self, path: &Path) -> Result<WorktreeFacts, Report<GitError>>;

    /// Kilobytes `path` takes on disk; `None` when it can't be measured.
    fn disk_usage(&self, path: &Path) -> Option<u64>;

    /// Deletes a local branch. Without `force`, git refuses an unmerged one.
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses.
    fn delete_branch(&self, repo: &Path, branch: &str, force: bool)
    -> Result<(), Report<GitError>>;

    /// Whether the local branch exists.
    fn branch_exists(&self, repo: &Path, branch: &str) -> bool;

    /// Whether `git branch -d` would take the local `branch` as merged: it is
    /// in its upstream's history when it has one, else in `HEAD`'s.
    fn is_merged(&self, repo: &Path, branch: &str) -> bool;

    /// Whether `origin/<branch>` is known, as of the last fetch.
    fn has_remote_branch(&self, repo: &Path, branch: &str) -> bool;

    /// Makes `dir` a new, empty git repository (`git init`).
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses.
    fn init(&self, dir: &Path) -> Result<(), Report<GitError>>;

    /// Checks out `git_ref` in `cwd`; a remote ref gets a local branch that
    /// tracks it. Returns the local branch's name.
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses, e.g. over uncommitted changes.
    fn checkout(&self, cwd: &Path, git_ref: &GitRef) -> Result<String, Report<GitError>>;

    /// Renames the local branch `old` to `new`.
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses, e.g. when `new` exists.
    fn rename_branch(&self, cwd: &Path, old: &str, new: &str) -> Result<(), Report<GitError>>;

    /// The project path of `cwd`: the root of its repository, or the main
    /// repository's root for a worktree, as a real path. `None` outside
    /// git.
    fn project_path(&self, cwd: &Path) -> Option<PathBuf>;
}

/// The one-line reason a git failure carries.
pub fn git_reason(report: &Report<GitError>) -> String {
    report
        .downcast_ref::<String>()
        .cloned()
        .unwrap_or_else(|| "git failed".to_owned())
}

/// Shared handle to the [`Git`] in use.
#[derive(Clone)]
pub struct GitService {
    git: Arc<dyn Git>,
    log: Log,
}

impl GitService {
    pub fn new(git: Arc<dyn Git>, log: Log) -> Self {
        Self { git, log }
    }

    /// The refs of the repository containing `cwd`, in the order [`Git::refs`]
    /// gives.
    ///
    /// # Errors
    ///
    /// Returns an error if git can't list the refs.
    pub fn refs(&self, cwd: &Path) -> Result<Vec<GitRef>, Report<GitError>> {
        self.git.refs(cwd)
    }

    /// `origin/HEAD`'s branch, else the current branch.
    ///
    /// # Errors
    ///
    /// Returns an error if the repository has neither.
    pub fn default_branch(&self, repo: &Path) -> Result<String, Report<GitError>> {
        self.git.default_branch(repo)
    }

    /// Whether the repository has an `origin` remote.
    pub fn has_origin(&self, repo: &Path) -> bool {
        self.git.has_origin(repo)
    }

    /// Fetches `branch` from origin. `Ok(false)` when origin has no such branch.
    ///
    /// # Errors
    ///
    /// Returns an error if the fetch fails for any other reason, or takes
    /// longer than its time limit.
    pub fn fetch(&self, repo: &Path, branch: &str) -> Result<bool, Report<GitError>> {
        self.git.fetch(repo, branch)
    }

    /// Adds a worktree at `path` on a new `branch` started from `base`.
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses.
    pub fn add_worktree(
        &self,
        repo: &Path,
        path: &Path,
        branch: &str,
        base: &str,
    ) -> Result<(), Report<GitError>> {
        self.git.add_worktree(repo, path, branch, base)
    }

    /// Removes the worktree at `path` and logs it with `why`
    /// (`prune <path> <why>: ok`, or `failed` with git's whole error).
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses.
    pub fn remove_worktree(
        &self,
        repo: &Path,
        path: &Path,
        force: bool,
        why: &str,
    ) -> Result<(), Report<GitError>> {
        let removed = self.git.remove_worktree(repo, path, force);
        let what = format!("{} {why}", path.display());
        match &removed {
            Ok(()) => self.log.line("prune", &format!("{what}: ok")),
            Err(report) => self.log.error(&format!("prune {what}: failed"), report),
        }
        removed
    }

    /// Adds a worktree at `path` on the existing `branch`.
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses.
    pub fn add_worktree_on(
        &self,
        repo: &Path,
        path: &Path,
        branch: &str,
    ) -> Result<(), Report<GitError>> {
        self.git.add_worktree_on(repo, path, branch)
    }

    /// Forgets worktrees whose directories are gone.
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses.
    pub fn prune_worktrees(&self, repo: &Path) -> Result<(), Report<GitError>> {
        self.git.prune_worktrees(repo)
    }

    /// The branch, uncommitted changes and last commit of the worktree at
    /// `path`. A failure is logged, once until its text changes.
    ///
    /// # Errors
    ///
    /// Returns an error if `path` isn't in a git repository.
    pub fn worktree_facts(&self, path: &Path) -> Result<WorktreeFacts, Report<GitError>> {
        let facts = self.git.worktree_facts(path);
        if let Err(report) = &facts {
            self.log.error_on_change(
                &format!("worktree facts {}", path.display()),
                &format!("couldn't read git's facts for {}", path.display()),
                report,
            );
        }
        facts
    }

    /// Kilobytes `path` takes on disk; `None` when it can't be measured.
    pub fn disk_usage(&self, path: &Path) -> Option<u64> {
        self.git.disk_usage(path)
    }

    /// Deletes a local branch and logs it with `why`
    /// (`delete branch <branch> (<repo>) <why>: ok`, or `failed` with git's
    /// whole error).
    pub fn delete_branch(&self, repo: &Path, branch: &str, force: bool, why: &str) {
        let what = format!("branch {branch} ({}) {why}", repo.display());
        match self.git.delete_branch(repo, branch, force) {
            Ok(()) => self.log.line("delete", &format!("{what}: ok")),
            Err(report) => self.log.error(&format!("delete {what}: failed"), &report),
        }
    }

    /// Whether the local branch exists.
    pub fn branch_exists(&self, repo: &Path, branch: &str) -> bool {
        self.git.branch_exists(repo, branch)
    }

    /// Whether `git branch -d` would take the local `branch` as merged.
    pub fn is_merged(&self, repo: &Path, branch: &str) -> bool {
        self.git.is_merged(repo, branch)
    }

    /// Whether `origin/<branch>` is known, as of the last fetch.
    pub fn has_remote_branch(&self, repo: &Path, branch: &str) -> bool {
        self.git.has_remote_branch(repo, branch)
    }

    /// Makes `dir` a new, empty git repository.
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses.
    pub fn init(&self, dir: &Path) -> Result<(), Report<GitError>> {
        self.git.init(dir)
    }

    /// Checks out `git_ref` in `cwd`. Returns the local branch's name.
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses.
    pub fn checkout(&self, cwd: &Path, git_ref: &GitRef) -> Result<String, Report<GitError>> {
        self.git.checkout(cwd, git_ref)
    }

    /// Renames the local branch `old` to `new`.
    ///
    /// # Errors
    ///
    /// Returns an error if git refuses.
    pub fn rename_branch(&self, cwd: &Path, old: &str, new: &str) -> Result<(), Report<GitError>> {
        self.git.rename_branch(cwd, old, new)
    }

    /// The project path of `cwd`; `None` outside git.
    pub fn project_path(&self, cwd: &Path) -> Option<PathBuf> {
        self.git.project_path(cwd)
    }
}

impl fmt::Debug for GitService {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Git<{}>", self.git.name())
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests propagate setup failures with `?` and assert on the outcome"
)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use error_stack::Report;

    use super::{Git, GitError, GitRef, GitService, WorktreeFacts};
    use crate::Log;

    /// A git whose removals give `result`; every other call is a harmless
    /// default.
    struct FakeGit {
        result: Result<(), String>,
    }

    impl FakeGit {
        fn outcome(&self) -> Result<(), Report<GitError>> {
            self.result
                .clone()
                .map_err(|reason| Report::new(GitError).attach(reason))
        }
    }

    impl Git for FakeGit {
        fn name(&self) -> &'static str {
            "fake"
        }
        fn refs(&self, _: &Path) -> Result<Vec<GitRef>, Report<GitError>> {
            Ok(Vec::new())
        }
        fn default_branch(&self, _: &Path) -> Result<String, Report<GitError>> {
            Ok("main".to_owned())
        }
        fn has_origin(&self, _: &Path) -> bool {
            false
        }
        fn fetch(&self, _: &Path, _: &str) -> Result<bool, Report<GitError>> {
            Ok(false)
        }
        fn add_worktree(
            &self,
            _: &Path,
            _: &Path,
            _: &str,
            _: &str,
        ) -> Result<(), Report<GitError>> {
            Ok(())
        }
        fn remove_worktree(&self, _: &Path, _: &Path, _: bool) -> Result<(), Report<GitError>> {
            self.outcome()
        }
        fn add_worktree_on(&self, _: &Path, _: &Path, _: &str) -> Result<(), Report<GitError>> {
            Ok(())
        }
        fn prune_worktrees(&self, _: &Path) -> Result<(), Report<GitError>> {
            Ok(())
        }
        fn worktree_facts(&self, _: &Path) -> Result<WorktreeFacts, Report<GitError>> {
            self.outcome().map(|()| WorktreeFacts {
                branch: None,
                changes: 0,
                last_commit: None,
            })
        }
        fn disk_usage(&self, _: &Path) -> Option<u64> {
            None
        }
        fn delete_branch(&self, _: &Path, _: &str, _: bool) -> Result<(), Report<GitError>> {
            self.outcome()
        }
        fn branch_exists(&self, _: &Path, _: &str) -> bool {
            false
        }
        fn is_merged(&self, _: &Path, _: &str) -> bool {
            false
        }
        fn has_remote_branch(&self, _: &Path, _: &str) -> bool {
            false
        }
        fn init(&self, _: &Path) -> Result<(), Report<GitError>> {
            Ok(())
        }
        fn checkout(&self, _: &Path, _: &GitRef) -> Result<String, Report<GitError>> {
            Ok("main".to_owned())
        }
        fn rename_branch(&self, _: &Path, _: &str, _: &str) -> Result<(), Report<GitError>> {
            Ok(())
        }
        fn project_path(&self, _: &Path) -> Option<PathBuf> {
            None
        }
    }

    /// A service over a git giving `result`, logging to `path`.
    fn service_logging(result: Result<(), String>, path: &Path) -> GitService {
        GitService::new(Arc::new(FakeGit { result }), Log::new(path.to_path_buf()))
    }

    #[rstest::rstest]
    fn a_failed_worktree_facts_read_is_logged() -> Result<(), std::io::Error> {
        // Given a git that can't read a worktree's facts.
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("orb.log");
        let service = service_logging(Err("broken".to_owned()), &path);

        // When reading /w/orb-1's facts.
        let facts = service.worktree_facts(Path::new("/w/orb-1"));

        // Then the log names the worktree and carries git's reason.
        let log = std::fs::read_to_string(&path)?;
        assert!(
            facts.is_err()
                && log.contains("couldn't read git's facts for /w/orb-1")
                && log.contains("broken"),
            "the failed facts read should be logged, got {log:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn remove_worktree_logs_the_path_and_why()
    -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Given a git that removes worktrees and a log file.
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("orb.log");

        // When removing /w/orb-1 because it was unused.
        service_logging(Ok(()), &path).remove_worktree(
            Path::new("/repo"),
            Path::new("/w/orb-1"),
            false,
            "unused, swept",
        )?;

        // Then the log names the path, why and the outcome.
        let log = std::fs::read_to_string(&path)?;
        assert!(
            log.contains(" prune /w/orb-1 unused, swept: ok\n"),
            "the prune line should be logged, got {log:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn failed_remove_worktree_logs_the_reason() -> Result<(), std::io::Error> {
        // Given a git that refuses a dirty worktree.
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("orb.log");
        let service = service_logging(Err("contains modified files".to_owned()), &path);

        // When removing /w/orb-1.
        let removed = service.remove_worktree(
            Path::new("/repo"),
            Path::new("/w/orb-1"),
            false,
            "unused, swept",
        );

        // Then the log carries the failure and git's reason.
        let log = std::fs::read_to_string(&path)?;
        assert!(
            removed.is_err()
                && log.contains(" prune /w/orb-1 unused, swept: failed")
                && log.contains("contains modified files"),
            "the failure and its reason should be logged, got {log:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn delete_branch_logs_the_branch() -> Result<(), std::io::Error> {
        // Given a git that deletes branches and a log file.
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("orb.log");

        // When deleting orb/abc because its start failed.
        service_logging(Ok(()), &path).delete_branch(
            Path::new("/repo"),
            "orb/abc",
            false,
            "start failed",
        );

        // Then the log names the branch, its repo, why and the outcome.
        let log = std::fs::read_to_string(&path)?;
        assert!(
            log.contains(" delete branch orb/abc (/repo) start failed: ok\n"),
            "the delete line should be logged, got {log:?}"
        );
        Ok(())
    }
}
