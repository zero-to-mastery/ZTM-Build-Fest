//! The `git` command line as orb's [`Git`].
//!
//! Every `git` process runs against the directory it's given (`git -C`), with
//! orb's child environment, no stdin, and no terminal prompts, so a remote
//! that wants credentials fails instead of drawing over orb. When git fails,
//! the first line it printed to stderr becomes the reason.
//!
//! Every git call has a time limit and is killed past it, so a git stuck on a
//! lock or a slow disk fails instead of hanging its caller. A call that only
//! reads gets 5 s and is run once more if it times out; one that changes a
//! repository gets 60 s and is never run again; a fetch gets 15 s, so an
//! origin that can't be reached fails the fetch. Listing refs runs its four
//! reads at the same time.
//!
//! A worktree's size comes from `du`, run with the same environment. `du` gets
//! 10 s, and a worktree it can't size in time has no size.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, SystemTime};

use error_stack::Report;

use super::git_service::{Git, GitError, GitRef, WorktreeFacts};
use crate::common::{Finished, run_within};

/// What `git fetch` prints when the remote lacks the branch.
const MISSING_REMOTE_REF: &str = "couldn't find remote ref";

/// How long a git call that only reads may take; one that times out is run once more.
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a git call that changes a repository may take.
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
/// How long `git fetch` may take before orb gives up on origin.
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
/// How long `du` may take to size a worktree.
const DU_TIMEOUT: Duration = Duration::from_secs(10);

/// Runs the `git` on `PATH`.
#[derive(Debug, Clone)]
pub struct GitCli {
    /// The environment every `git` process gets.
    env: Vec<(OsString, OsString)>,
    /// How long a read may take before it's killed.
    read_limit: Duration,
    /// How long a write may take before it's killed.
    write_limit: Duration,
    /// How long a fetch may take before it's killed.
    fetch_limit: Duration,
    /// How long `du` may take before it's killed.
    du_limit: Duration,
}

impl GitCli {
    /// A git whose processes run with exactly `env`.
    pub fn new(env: Vec<(OsString, OsString)>) -> Self {
        Self {
            env,
            read_limit: READ_TIMEOUT,
            write_limit: WRITE_TIMEOUT,
            fetch_limit: FETCH_TIMEOUT,
            du_limit: DU_TIMEOUT,
        }
    }

    /// A `git` in `dir` with orb's environment and no terminal prompts.
    fn command<I, S>(&self, dir: &Path, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(dir)
            .args(args)
            .env_clear()
            .envs(self.env.iter().map(|(key, value)| (key, value)))
            .env("GIT_TERMINAL_PROMPT", "0");
        command
    }

    /// Runs git in `dir` for at most `limit`, `tries` times in all while it times out.
    fn output<I, S>(
        &self,
        dir: &Path,
        args: I,
        limit: Duration,
        tries: u32,
    ) -> Result<Output, Report<GitError>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args: Vec<OsString> = args
            .into_iter()
            .map(|arg| arg.as_ref().to_owned())
            .collect();
        for _ in 0..tries {
            if let Finished::Exited(output) =
                run_within(self.command(dir, &args), limit).map_err(couldnt_run)?
            {
                return Ok(output);
            }
        }
        let reason = format!(
            "git {} timed out after {} s",
            subcommand(&args),
            limit.as_secs()
        );
        Err(Report::new(GitError).attach(reason))
    }

    /// Runs git in `dir` like [`Self::output`]; returns its stdout.
    fn stdout<I, S>(
        &self,
        dir: &Path,
        args: I,
        limit: Duration,
        tries: u32,
    ) -> Result<String, Report<GitError>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args: Vec<OsString> = args
            .into_iter()
            .map(|arg| arg.as_ref().to_owned())
            .collect();
        let output = self.output(dir, &args, limit, tries)?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(failure(&output, &subcommand(&args)))
        }
    }

    /// Runs a git that changes a repository in `dir`; returns its stdout.
    fn run<I, S>(&self, dir: &Path, args: I) -> Result<String, Report<GitError>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.stdout(dir, args, self.write_limit, 1)
    }

    /// Runs a git that only reads in `dir`, once more if it times out; returns its stdout.
    fn read<I, S>(&self, dir: &Path, args: I) -> Result<String, Report<GitError>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.stdout(dir, args, self.read_limit, 2)
    }

    /// Whether a git that only reads exits 0 in `dir`.
    fn succeeds<I, S>(&self, dir: &Path, args: I) -> bool
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.output(dir, args, self.read_limit, 2)
            .is_ok_and(|output| output.status.success())
    }

    /// `origin/HEAD`'s branch.
    fn origin_head(&self, repo: &Path) -> Option<String> {
        let target = self
            .read(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"])
            .ok()?;
        non_empty(target.trim().strip_prefix("refs/remotes/origin/")?)
    }

    /// The branch checked out in `dir`; none on a detached HEAD.
    fn current_branch(&self, dir: &Path) -> Option<String> {
        non_empty(self.read(dir, ["branch", "--show-current"]).ok()?.trim())
    }
}

impl Git for GitCli {
    fn name(&self) -> &'static str {
        "git"
    }

    /// Runs its four git reads at the same time, so listing refs takes about
    /// one call's time.
    fn refs(&self, cwd: &Path) -> Result<Vec<GitRef>, Report<GitError>> {
        thread::scope(|scope| {
            let worktrees =
                scope.spawn(|| self.read(cwd, ["worktree", "list", "--porcelain", "-z"]));
            let current = scope.spawn(|| self.current_branch(cwd));
            let origin = scope.spawn(|| self.origin_head(cwd));
            let listed = self.read(
                cwd,
                [
                    "for-each-ref",
                    "--format=%(refname)%09%(committerdate:unix)%09%(symref)",
                    "refs/heads",
                    "refs/remotes",
                ],
            );
            let worktrees = worktrees.join().unwrap_or_else(|_| {
                Err(Report::new(GitError).attach("git worktree list crashed".to_owned()))
            });
            let current = current.join().ok().flatten();
            let origin = origin.join().ok().flatten();
            Ok(ordered(
                &listed?,
                current.as_deref(),
                origin.as_deref(),
                &checked_out(&worktrees?),
            ))
        })
    }

    fn default_branch(&self, repo: &Path) -> Result<String, Report<GitError>> {
        self.origin_head(repo)
            .or_else(|| self.current_branch(repo))
            .ok_or_else(|| {
                Report::new(GitError).attach("no branch to start a worktree from".to_owned())
            })
    }

    fn has_origin(&self, repo: &Path) -> bool {
        self.succeeds(repo, ["remote", "get-url", "origin"])
    }

    fn fetch(&self, repo: &Path, branch: &str) -> Result<bool, Report<GitError>> {
        let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
        let command = self.command(repo, ["fetch", "--quiet", "origin", &refspec]);
        let output = match run_within(command, self.fetch_limit).map_err(couldnt_run)? {
            Finished::Exited(output) => output,
            Finished::TimedOut => {
                let reason = format!(
                    "git fetch origin {branch} timed out after {} s",
                    self.fetch_limit.as_secs()
                );
                return Err(Report::new(GitError).attach(reason));
            }
        };
        if output.status.success() {
            Ok(true)
        } else if String::from_utf8_lossy(&output.stderr).contains(MISSING_REMOTE_REF) {
            Ok(false)
        } else {
            Err(failure(&output, "fetch"))
        }
    }

    fn add_worktree(
        &self,
        repo: &Path,
        path: &Path,
        branch: &str,
        base: &str,
    ) -> Result<(), Report<GitError>> {
        let args = ["worktree", "add", "-b", branch]
            .map(OsStr::new)
            .into_iter()
            .chain([path.as_os_str(), OsStr::new(base)]);
        self.run(repo, args)?;
        Ok(())
    }

    fn remove_worktree(
        &self,
        repo: &Path,
        path: &Path,
        force: bool,
    ) -> Result<(), Report<GitError>> {
        let args = ["worktree", "remove"]
            .into_iter()
            .chain(force.then_some("--force"))
            .map(OsStr::new)
            .chain([path.as_os_str()]);
        self.run(repo, args)?;
        Ok(())
    }

    fn add_worktree_on(
        &self,
        repo: &Path,
        path: &Path,
        branch: &str,
    ) -> Result<(), Report<GitError>> {
        let args = [
            OsStr::new("worktree"),
            OsStr::new("add"),
            path.as_os_str(),
            OsStr::new(branch),
        ];
        self.run(repo, args)?;
        Ok(())
    }

    fn prune_worktrees(&self, repo: &Path) -> Result<(), Report<GitError>> {
        self.run(repo, ["worktree", "prune"])?;
        Ok(())
    }

    fn worktree_facts(&self, path: &Path) -> Result<WorktreeFacts, Report<GitError>> {
        // `status` goes first: it is the call that fails outside a repository.
        let changes = self.read(path, ["status", "--porcelain"])?.lines().count();
        let branch = self
            .read(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])
            .ok()
            .and_then(|out| non_empty(out.trim()));
        let last_commit = self
            .read(path, ["log", "-1", "--format=%ct%x00%s"])
            .ok()
            .and_then(|out| last_commit(&out));
        Ok(WorktreeFacts {
            branch,
            changes,
            last_commit,
        })
    }

    fn disk_usage(&self, path: &Path) -> Option<u64> {
        let command = {
            let mut command = Command::new("du");
            command
                .arg("-sk")
                .arg(path)
                .env_clear()
                .envs(self.env.iter().map(|(key, value)| (key, value)));
            command
        };
        let Finished::Exited(output) = run_within(command, self.du_limit).ok()? else {
            return None;
        };
        // `du` exits 1 when it can't read some files but still prints the total.
        String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    }

    fn delete_branch(
        &self,
        repo: &Path,
        branch: &str,
        force: bool,
    ) -> Result<(), Report<GitError>> {
        let flag = if force { "-D" } else { "-d" };
        self.run(repo, ["branch", flag, branch])?;
        Ok(())
    }

    fn branch_exists(&self, repo: &Path, branch: &str) -> bool {
        let refname = format!("refs/heads/{branch}");
        self.succeeds(repo, ["show-ref", "--verify", "--quiet", &refname])
    }

    fn is_merged(&self, repo: &Path, branch: &str) -> bool {
        let upstream = format!("{branch}@{{upstream}}");
        let target = if self.succeeds(repo, ["rev-parse", "--verify", "--quiet", &upstream]) {
            upstream
        } else {
            "HEAD".to_owned()
        };
        let refname = format!("refs/heads/{branch}");
        self.succeeds(repo, ["merge-base", "--is-ancestor", &refname, &target])
    }

    fn has_remote_branch(&self, repo: &Path, branch: &str) -> bool {
        let refname = format!("refs/remotes/origin/{branch}");
        self.succeeds(repo, ["show-ref", "--verify", "--quiet", &refname])
    }

    fn init(&self, dir: &Path) -> Result<(), Report<GitError>> {
        self.run(dir, ["init", "--quiet"])?;
        Ok(())
    }

    fn checkout(&self, cwd: &Path, git_ref: &GitRef) -> Result<String, Report<GitError>> {
        let name = git_ref.name.as_str();
        match (git_ref.remote, name.split_once('/')) {
            (true, Some((_, branch))) => {
                self.run(cwd, ["checkout", "--track", name, "--"])?;
                Ok(branch.to_owned())
            }
            _ => {
                self.run(cwd, ["checkout", name, "--"])?;
                Ok(name.to_owned())
            }
        }
    }

    fn rename_branch(&self, cwd: &Path, old: &str, new: &str) -> Result<(), Report<GitError>> {
        self.run(cwd, ["branch", "-m", old, new])?;
        Ok(())
    }

    fn project_path(&self, cwd: &Path) -> Option<PathBuf> {
        let common = self
            .read(
                cwd,
                ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )
            .ok()?;
        Path::new(common.strip_suffix('\n').unwrap_or(&common))
            .parent()
            .map(Path::to_owned)
    }
}

/// A report whose reason is git's first stderr line, else
/// `git <subcommand> failed`.
fn failure(output: &Output, subcommand: &str) -> Report<GitError> {
    let reason = String::from_utf8_lossy(&output.stderr)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map_or_else(|| format!("git {subcommand} failed"), str::to_owned);
    Report::new(GitError).attach(reason)
}

/// The git subcommand `args` start with, for a reason; empty when there are none.
fn subcommand(args: &[OsString]) -> String {
    args.first()
        .map_or_else(String::new, |arg| arg.to_string_lossy().into_owned())
}

/// The reason when git can't be started at all.
fn couldnt_run(error: std::io::Error) -> Report<GitError> {
    let reason = format!("couldn't run git: {error}");
    Report::new(error).change_context(GitError).attach(reason)
}

fn non_empty(text: &str) -> Option<String> {
    (!text.is_empty()).then(|| text.to_owned())
}

/// The time and subject in `git log -1 --format=%ct%x00%s` output.
fn last_commit(log: &str) -> Option<(SystemTime, String)> {
    let (seconds, subject) = log.split_once('\0')?;
    let at = SystemTime::UNIX_EPOCH + Duration::from_secs(seconds.parse().ok()?);
    Some((at, subject.strip_suffix('\n').unwrap_or(subject).to_owned()))
}

/// One entry of `git worktree list --porcelain`.
struct Worktree {
    path: PathBuf,
    branch: Option<String>,
    prunable: bool,
}

/// Each branch checked out in a worktree that's still on disk, with its path.
fn checked_out(porcelain: &str) -> Vec<(String, PathBuf)> {
    let mut worktrees: Vec<Worktree> = Vec::new();
    for field in porcelain.split('\0') {
        match field.split_once(' ').unwrap_or((field, "")) {
            ("worktree", path) => worktrees.push(Worktree {
                path: PathBuf::from(path),
                branch: None,
                prunable: false,
            }),
            ("branch", refname) => {
                if let Some(worktree) = worktrees.last_mut() {
                    worktree.branch = refname.strip_prefix("refs/heads/").map(str::to_owned);
                }
            }
            ("prunable", _) => {
                if let Some(worktree) = worktrees.last_mut() {
                    worktree.prunable = true;
                }
            }
            _ => {}
        }
    }
    worktrees
        .into_iter()
        .filter(|worktree| !worktree.prunable && worktree.path.exists())
        .filter_map(|worktree| Some((worktree.branch?, worktree.path)))
        .collect()
}

/// The refs in `for-each-ref`'s `listed` output, in T3's order: current,
/// default, other local branches newest first, then remote refs newest first.
/// A current branch with no commit yet is listed too.
/// Symbolic refs (`origin/HEAD`) and `origin/<b>` where a local `<b>` exists
/// are left out.
fn ordered(
    listed: &str,
    current: Option<&str>,
    default: Option<&str>,
    worktrees: &[(String, PathBuf)],
) -> Vec<GitRef> {
    let (mut locals, mut remotes) = listed
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let (refname, time, symref) = (fields.next()?, fields.next()?, fields.next()?);
            if !symref.is_empty() {
                return None;
            }
            let time = time.parse().unwrap_or_default();
            match (
                refname.strip_prefix("refs/heads/"),
                refname.strip_prefix("refs/remotes/"),
            ) {
                (Some(name), _) => Some((
                    time,
                    GitRef {
                        name: name.to_owned(),
                        remote: false,
                        current: current == Some(name),
                        default: default == Some(name),
                        worktree: worktrees
                            .iter()
                            .find(|(branch, _)| branch == name)
                            .map(|(_, path)| path.clone()),
                    },
                )),
                (None, Some(name)) => Some((
                    time,
                    GitRef {
                        name: name.to_owned(),
                        remote: true,
                        current: false,
                        default: default.is_some_and(|default| {
                            name.split_once('/') == Some(("origin", default))
                        }),
                        worktree: None,
                    },
                )),
                (None, None) => None,
            }
        })
        .partition::<Vec<(i64, GitRef)>, _>(|(_, git_ref)| !git_ref.remote);
    // A new repository's branch has no commit yet, so `for-each-ref` skips it.
    if let Some(unborn) = current.filter(|name| !locals.iter().any(|(_, l)| l.name == *name)) {
        locals.push((
            0,
            GitRef {
                name: unborn.to_owned(),
                remote: false,
                current: true,
                default: default == Some(unborn),
                worktree: worktrees
                    .iter()
                    .find(|(branch, _)| branch == unborn)
                    .map(|(_, path)| path.clone()),
            },
        ));
    }
    remotes.retain(|(_, remote)| {
        remote
            .name
            .strip_prefix("origin/")
            .is_none_or(|branch| !locals.iter().any(|(_, local)| local.name == branch))
    });
    for refs in [&mut locals, &mut remotes] {
        refs.sort_by(|(time_a, a), (time_b, b)| {
            time_b.cmp(time_a).then_with(|| a.name.cmp(&b.name))
        });
    }
    let mut refs: Vec<GitRef> = locals
        .into_iter()
        .chain(remotes)
        .map(|(_, git_ref)| git_ref)
        .collect();
    refs.sort_by_key(|git_ref| match (git_ref.current, git_ref.default) {
        (true, _) => 0,
        (false, true) => 1,
        (false, false) => 2,
    });
    refs
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests set repos up with `?` and assert on the outcome"
)]
mod tests {
    use std::ffi::{OsStr, OsString};
    use std::fs;
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{Duration, Instant, SystemTime};

    use error_stack::{Report, ResultExt};
    use tempfile::TempDir;

    use super::GitCli;
    use crate::feat::git::git_service::{Git, GitError, GitRef};

    /// A home directory for test repos, and a git that ignores the user's
    /// config.
    struct Sandbox {
        home: TempDir,
        env: Vec<(OsString, OsString)>,
    }

    impl Sandbox {
        fn new() -> Result<Self, Report<GitError>> {
            let home = TempDir::new().change_context(GitError)?;
            let env = vec![
                ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
                ("HOME".into(), home.path().into()),
                ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ];
            Ok(Self { home, env })
        }

        fn git(&self) -> GitCli {
            GitCli::new(self.env.clone())
        }

        /// A git whose `program` (on `PATH` before the real one) is a shell
        /// `script`, and whose reads, writes and `du` may take `limit`.
        fn faking(
            &self,
            program: &str,
            script: &str,
            limit: Duration,
        ) -> Result<GitCli, Report<GitError>> {
            let bin = self.path("bin");
            fs::create_dir_all(&bin).change_context(GitError)?;
            let fake = bin.join(program);
            fs::write(
                &fake,
                format!("#!/bin/sh\n[ -n \"$WARMING\" ] && exit 0\n{script}\n"),
            )
            .change_context(GitError)?;
            fs::set_permissions(&fake, fs::Permissions::from_mode(0o755))
                .change_context(GitError)?;
            // macOS checks a new program on its first run, which can take
            // longer than a test's limit; run it once so the tests time only
            // the script.
            Command::new(&fake)
                .env("WARMING", "1")
                .status()
                .change_context(GitError)?;
            let path = {
                let mut path = OsString::from(bin);
                path.push(":");
                path.push(std::env::var_os("PATH").unwrap_or_default());
                path
            };
            let env = self
                .env
                .iter()
                .filter(|(key, _)| key != "PATH")
                .cloned()
                .chain([("PATH".into(), path)])
                .collect();
            Ok(GitCli {
                read_limit: limit,
                write_limit: limit,
                du_limit: limit,
                ..GitCli::new(env)
            })
        }

        /// How many times a fake that logs each run to `$HOME/runs` ran.
        fn runs(&self) -> Result<usize, Report<GitError>> {
            let runs = fs::read_to_string(self.path("runs")).change_context(GitError)?;
            Ok(runs.lines().count())
        }

        fn path(&self, name: &str) -> PathBuf {
            self.home.path().join(name)
        }

        fn run<I, S>(&self, dir: &Path, args: I) -> Result<(), Report<GitError>>
        where
            I: IntoIterator<Item = S>,
            S: AsRef<OsStr>,
        {
            self.git().run(dir, args).map(drop)
        }

        /// A new repo `name` on `branch`, with one commit.
        fn repo(&self, name: &str, branch: &str) -> Result<PathBuf, Report<GitError>> {
            let path = self.path(name);
            self.run(self.home.path(), ["init", "-q", "-b", branch, name])?;
            self.run(&path, ["config", "user.name", "orb"])?;
            self.run(&path, ["config", "user.email", "orb@example.com"])?;
            self.commit(&path, 1000)?;
            Ok(path)
        }

        /// An empty commit in `repo` dated `time` (unix seconds).
        fn commit(&self, repo: &Path, time: u32) -> Result<(), Report<GitError>> {
            let date = OsString::from(format!("@{time} +0000"));
            let env = self
                .env
                .iter()
                .cloned()
                .chain([
                    ("GIT_COMMITTER_DATE".into(), date.clone()),
                    ("GIT_AUTHOR_DATE".into(), date),
                ])
                .collect();
            GitCli::new(env)
                .run(repo, ["commit", "-q", "--allow-empty", "-m", "commit"])
                .map(drop)
        }

        /// Adds `url` as the remote `name` of `repo` and fetches it.
        fn add_remote(&self, repo: &Path, name: &str, url: &Path) -> Result<(), Report<GitError>> {
            self.run(
                repo,
                [
                    OsStr::new("remote"),
                    OsStr::new("add"),
                    OsStr::new(name),
                    url.as_os_str(),
                ],
            )?;
            self.run(repo, ["fetch", "-q", name])
        }
    }

    fn names(refs: &[GitRef]) -> Vec<&str> {
        refs.iter().map(|git_ref| git_ref.name.as_str()).collect()
    }

    fn named<'a>(refs: &'a [GitRef], name: &str) -> Option<&'a GitRef> {
        refs.iter().find(|git_ref| git_ref.name == name)
    }

    fn reason<T>(result: Result<T, Report<GitError>>) -> Option<String> {
        result.err()?.downcast_ref::<String>().cloned()
    }

    #[rstest::rstest]
    fn refs_put_current_then_default_then_locals_by_recency_then_remotes()
    -> Result<(), Report<GitError>> {
        // Given a repo on `feature`, whose origin's HEAD is `main`, with older
        // and newer local branches and two remote-only branches.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        sandbox.run(&repo, ["checkout", "-q", "-b", "old"])?;
        sandbox.commit(&repo, 2000)?;
        sandbox.run(&repo, ["checkout", "-q", "-b", "new", "main"])?;
        sandbox.commit(&repo, 3000)?;
        sandbox.run(&repo, ["checkout", "-q", "-b", "feature", "main"])?;
        sandbox.commit(&repo, 1500)?;
        let origin = sandbox.repo("origin", "main")?;
        sandbox.run(&origin, ["checkout", "-q", "-b", "r1"])?;
        sandbox.commit(&origin, 4000)?;
        sandbox.run(&origin, ["checkout", "-q", "-b", "r2"])?;
        sandbox.commit(&origin, 5000)?;
        sandbox.add_remote(&repo, "origin", &origin)?;
        sandbox.run(&repo, ["remote", "set-head", "origin", "main"])?;

        // When listing the refs.
        let refs = sandbox.git().refs(&repo)?;

        // Then the current branch leads, then the default, then the other
        // locals newest first, then the remotes newest first.
        assert_eq!(
            names(&refs),
            ["feature", "main", "new", "old", "origin/r2", "origin/r1"],
            "refs should be in T3's order"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn refs_hide_origin_ref_matching_a_local_branch() -> Result<(), Report<GitError>> {
        // Given a local `main` and an origin with `main`.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let origin = sandbox.repo("origin", "main")?;
        sandbox.add_remote(&repo, "origin", &origin)?;

        // When listing the refs.
        let refs = sandbox.git().refs(&repo)?;

        // Then `origin/main` isn't listed.
        assert!(
            named(&refs, "origin/main").is_none(),
            "origin/main should be hidden behind the local main, got {:?}",
            names(&refs)
        );
        Ok(())
    }

    #[rstest::rstest]
    fn refs_keep_non_origin_remote_refs() -> Result<(), Report<GitError>> {
        // Given a local `main` and an `upstream` remote with `main`.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let upstream = sandbox.repo("upstream", "main")?;
        sandbox.add_remote(&repo, "upstream", &upstream)?;

        // When listing the refs.
        let refs = sandbox.git().refs(&repo)?;

        // Then `upstream/main` is listed.
        assert!(
            named(&refs, "upstream/main").is_some(),
            "upstream/main should be kept, got {:?}",
            names(&refs)
        );
        Ok(())
    }

    #[rstest::rstest]
    fn refs_drop_origin_head() -> Result<(), Report<GitError>> {
        // Given an origin whose HEAD is set.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let origin = sandbox.repo("origin", "main")?;
        sandbox.add_remote(&repo, "origin", &origin)?;
        sandbox.run(&repo, ["remote", "set-head", "origin", "main"])?;

        // When listing the refs.
        let refs = sandbox.git().refs(&repo)?;

        // Then `origin/HEAD` isn't listed.
        assert!(
            named(&refs, "origin/HEAD").is_none(),
            "origin/HEAD should be dropped, got {:?}",
            names(&refs)
        );
        Ok(())
    }

    #[rstest::rstest]
    fn refs_mark_a_branch_checked_out_in_another_worktree() -> Result<(), Report<GitError>> {
        // Given `side` checked out in a second worktree.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let worktree = sandbox.path("worktree");
        sandbox
            .git()
            .add_worktree(&repo, &worktree, "side", "main")?;

        // When listing the refs from the root checkout.
        let refs = sandbox.git().refs(&repo)?;

        // Then `side` names that worktree.
        let expected = worktree.canonicalize().change_context(GitError)?;
        assert_eq!(
            named(&refs, "side")
                .and_then(|side| side.worktree.as_deref())
                .and_then(|path| path.canonicalize().ok()),
            Some(expected),
            "side should be marked as checked out in the worktree"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn refs_skip_a_worktree_whose_directory_is_gone() -> Result<(), Report<GitError>> {
        // Given `side`'s worktree directory deleted without git knowing.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let worktree = sandbox.path("worktree");
        sandbox
            .git()
            .add_worktree(&repo, &worktree, "side", "main")?;
        fs::remove_dir_all(&worktree).change_context(GitError)?;

        // When listing the refs.
        let refs = sandbox.git().refs(&repo)?;

        // Then `side` isn't marked as checked out anywhere.
        assert_eq!(
            named(&refs, "side").map(|side| side.worktree.clone()),
            Some(None),
            "a missing worktree shouldn't claim its branch"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn default_branch_reads_origin_head() -> Result<(), Report<GitError>> {
        // Given a repo on `main` whose origin's HEAD is `trunk`.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let origin = sandbox.repo("origin", "trunk")?;
        sandbox.add_remote(&repo, "origin", &origin)?;
        sandbox.run(&repo, ["remote", "set-head", "origin", "trunk"])?;

        // When asking for the default branch.
        let default = sandbox.git().default_branch(&repo)?;

        // Then it's origin's HEAD.
        assert_eq!(
            default, "trunk",
            "the default should be origin/HEAD's branch"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn default_branch_falls_back_to_the_current_branch() -> Result<(), Report<GitError>> {
        // Given a repo without an origin, on `feature`.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        sandbox.run(&repo, ["checkout", "-q", "-b", "feature"])?;

        // When asking for the default branch.
        let default = sandbox.git().default_branch(&repo)?;

        // Then it's the current branch.
        assert_eq!(
            default, "feature",
            "the default should fall back to the current branch"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn refs_list_the_branch_of_a_repository_with_no_commits() -> Result<(), Report<GitError>> {
        // Given a repository just made with `git init`, on the unborn `trunk`.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.path("fresh");
        fs::create_dir_all(&repo).change_context(GitError)?;
        sandbox.run(&repo, ["init", "-q", "-b", "trunk"])?;

        // When listing the refs.
        let refs = sandbox.git().refs(&repo)?;

        // Then `trunk` is the one, current branch.
        assert_eq!(
            refs.iter()
                .map(|git_ref| (git_ref.name.as_str(), git_ref.current))
                .collect::<Vec<_>>(),
            [("trunk", true)],
            "the unborn branch should be listed as current"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn init_makes_a_directory_a_repository() -> Result<(), Report<GitError>> {
        // Given a plain directory.
        let sandbox = Sandbox::new()?;
        let dir = sandbox.path("plain");
        fs::create_dir_all(&dir).change_context(GitError)?;

        // When initializing git there.
        sandbox.git().init(&dir)?;

        // Then git can list its refs.
        assert!(
            sandbox.git().refs(&dir).is_ok(),
            "the directory should be a repository"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn refs_fail_outside_a_repository() -> Result<(), Report<GitError>> {
        // Given a plain directory.
        let sandbox = Sandbox::new()?;
        let dir = sandbox.path("plain");
        fs::create_dir_all(&dir).change_context(GitError)?;

        // When listing its refs.
        let refs = sandbox.git().refs(&dir);

        // Then git refuses.
        assert!(refs.is_err(), "a plain directory has no refs");
        Ok(())
    }

    #[rstest::rstest]
    fn refs_from_a_slow_git_take_about_one_calls_time() -> Result<(), Report<GitError>> {
        // Given a git that takes 300 ms to answer anything and prints nothing.
        let sandbox = Sandbox::new()?;
        let git = sandbox.faking("git", "sleep 0.3", Duration::from_secs(5))?;

        // When listing refs.
        let started = Instant::now();
        let refs = git.refs(sandbox.home.path());
        let took = started.elapsed();

        // Then they come back in about one call's time, not four.
        assert!(
            refs.is_ok() && took < Duration::from_millis(900),
            "four 300 ms reads should run at the same time, took {took:?} for {refs:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn project_path_of_a_worktree_is_its_main_repository() -> Result<(), Report<GitError>> {
        // Given a worktree of `repo`.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let worktree = sandbox.path("worktree");
        sandbox
            .git()
            .add_worktree(&repo, &worktree, "side", "main")?;

        // When resolving the worktree's project path.
        let project = sandbox.git().project_path(&worktree);

        // Then it is the main repository's real path.
        let expected = repo.canonicalize().change_context(GitError)?;
        assert_eq!(
            project,
            Some(expected),
            "a worktree belongs to its main repository"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn project_path_outside_a_repository_is_none() -> Result<(), Report<GitError>> {
        // Given a plain directory.
        let sandbox = Sandbox::new()?;
        let dir = sandbox.path("plain");
        fs::create_dir_all(&dir).change_context(GitError)?;

        // When resolving its project path.
        let project = sandbox.git().project_path(&dir);

        // Then there is none.
        assert_eq!(project, None, "a plain directory has no project path");
        Ok(())
    }

    #[rstest::rstest]
    #[case("main", true)]
    #[case("local-only", false)]
    fn has_remote_branch_tells_whether_origin_had_it_at_the_last_fetch(
        #[case] branch: &str,
        #[case] expected: bool,
    ) -> Result<(), Report<GitError>> {
        // Given a clone-like repo that fetched origin's `main`, and a branch
        // only it has.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        sandbox.run(&repo, ["branch", "local-only"])?;
        let origin = sandbox.repo("origin", "main")?;
        sandbox.add_remote(&repo, "origin", &origin)?;

        // When asking whether origin has `branch`.
        let known = sandbox.git().has_remote_branch(&repo, branch);

        // Then only origin's branch is known.
        assert_eq!(known, expected, "origin/{branch} known");
        Ok(())
    }

    /// A repo on `main` with a branch `slug` one commit ahead of it.
    fn slug_ahead(sandbox: &Sandbox) -> Result<PathBuf, Report<GitError>> {
        let repo = sandbox.repo("repo", "main")?;
        sandbox.run(&repo, ["checkout", "-q", "-b", "slug"])?;
        sandbox.commit(&repo, 2000)?;
        sandbox.run(&repo, ["checkout", "-q", "main"])?;
        Ok(repo)
    }

    #[rstest::rstest]
    fn branch_with_a_commit_head_lacks_is_not_merged() -> Result<(), Report<GitError>> {
        // Given `slug` one commit ahead of HEAD, with no upstream.
        let sandbox = Sandbox::new()?;
        let repo = slug_ahead(&sandbox)?;

        // When asking whether it's merged.
        let merged = sandbox.git().is_merged(&repo, "slug");

        // Then it isn't, as `git branch -d` says.
        assert!(!merged, "a commit only slug has keeps it unmerged");
        Ok(())
    }

    #[rstest::rstest]
    fn branch_in_heads_history_is_merged() -> Result<(), Report<GitError>> {
        // Given `slug` one commit ahead, then fast-forwarded into HEAD.
        let sandbox = Sandbox::new()?;
        let repo = slug_ahead(&sandbox)?;
        sandbox.run(&repo, ["merge", "-q", "--ff-only", "slug"])?;

        // When asking whether it's merged.
        let merged = sandbox.git().is_merged(&repo, "slug");

        // Then it is.
        assert!(merged, "slug's commits are all in HEAD");
        Ok(())
    }

    #[rstest::rstest]
    fn branch_in_its_upstreams_history_is_merged() -> Result<(), Report<GitError>> {
        // Given `slug` one commit ahead of HEAD, pushed to its upstream.
        let sandbox = Sandbox::new()?;
        let repo = slug_ahead(&sandbox)?;
        let origin = sandbox.repo("origin", "main")?;
        sandbox.add_remote(&repo, "origin", &origin)?;
        sandbox.run(&repo, ["push", "-q", "-u", "origin", "slug"])?;

        // When asking whether it's merged.
        let merged = sandbox.git().is_merged(&repo, "slug");

        // Then it is, as `git branch -d` deletes it.
        assert!(merged, "a branch its upstream has is merged");
        Ok(())
    }

    #[rstest::rstest]
    fn branch_ahead_of_its_upstream_is_not_merged_even_in_head() -> Result<(), Report<GitError>> {
        // Given `slug` pushed to its upstream, then a commit on top, merged
        // into HEAD.
        let sandbox = Sandbox::new()?;
        let repo = slug_ahead(&sandbox)?;
        let origin = sandbox.repo("origin", "main")?;
        sandbox.add_remote(&repo, "origin", &origin)?;
        sandbox.run(&repo, ["push", "-q", "-u", "origin", "slug"])?;
        sandbox.run(&repo, ["checkout", "-q", "slug"])?;
        sandbox.commit(&repo, 3000)?;
        sandbox.run(&repo, ["checkout", "-q", "main"])?;
        sandbox.run(&repo, ["merge", "-q", "--ff-only", "slug"])?;

        // When asking whether it's merged.
        let merged = sandbox.git().is_merged(&repo, "slug");

        // Then it isn't: `git branch -d` checks the upstream first.
        assert!(!merged, "the upstream lacks slug's last commit");
        Ok(())
    }

    #[rstest::rstest]
    fn fetch_reports_a_branch_missing_on_origin() -> Result<(), Report<GitError>> {
        // Given an origin without `nope`.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let origin = sandbox.repo("origin", "main")?;
        sandbox.add_remote(&repo, "origin", &origin)?;

        // When fetching `nope`.
        let fetched = sandbox.git().fetch(&repo, "nope")?;

        // Then the fetch reports the branch missing.
        assert!(!fetched, "a branch origin lacks should fetch as false");
        Ok(())
    }

    #[rstest::rstest]
    fn fetch_fails_with_gits_reason_for_a_bad_remote() -> Result<(), Report<GitError>> {
        // Given an origin pointing at a directory that doesn't exist.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let missing = sandbox.path("missing");
        sandbox.run(
            &repo,
            [
                OsStr::new("remote"),
                OsStr::new("add"),
                OsStr::new("origin"),
                missing.as_os_str(),
            ],
        )?;

        // When fetching `main`.
        let reason = reason(sandbox.git().fetch(&repo, "main"));

        // Then the fetch fails with git's first line.
        assert!(
            reason
                .as_deref()
                .is_some_and(|reason| reason.contains("does not appear to be a git repository")),
            "the reason should be git's, got {reason:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn fetch_times_out_against_an_origin_that_never_answers() -> Result<(), Report<GitError>> {
        // Given an origin on a local port that takes connections but never
        // answers, and a git whose fetch limit is 1 s.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let listener = TcpListener::bind("127.0.0.1:0").change_context(GitError)?;
        let port = listener.local_addr().change_context(GitError)?.port();
        let url = format!("http://127.0.0.1:{port}/repo.git");
        sandbox.run(&repo, ["remote", "add", "origin", &url])?;
        let git = GitCli {
            fetch_limit: Duration::from_secs(1),
            ..sandbox.git()
        };

        // When fetching `main`.
        let reason = reason(git.fetch(&repo, "main"));

        // Then the fetch fails as timed out.
        assert_eq!(
            reason.as_deref(),
            Some("git fetch origin main timed out after 1 s"),
            "a fetch that outlives its limit should time out"
        );
        drop(listener);
        Ok(())
    }

    #[rstest::rstest]
    fn checkout_of_a_remote_ref_creates_a_tracking_branch() -> Result<(), Report<GitError>> {
        // Given an origin with a `feature` branch the repo doesn't have.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let origin = sandbox.repo("origin", "main")?;
        sandbox.run(&origin, ["branch", "feature"])?;
        sandbox.add_remote(&repo, "origin", &origin)?;
        let remote = named(&sandbox.git().refs(&repo)?, "origin/feature")
            .cloned()
            .ok_or_else(|| Report::new(GitError).attach("origin/feature isn't listed"))?;

        // When checking out `origin/feature`.
        sandbox.git().checkout(&repo, &remote)?;

        // Then a local `feature` tracks it.
        let upstream = sandbox
            .git()
            .run(&repo, ["rev-parse", "--abbrev-ref", "feature@{upstream}"])?;
        assert_eq!(
            upstream.trim(),
            "origin/feature",
            "feature should track origin/feature"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn rename_onto_an_existing_branch_fails_and_keeps_the_old_one() -> Result<(), Report<GitError>>
    {
        // Given branches `a` and `b`.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        sandbox.run(&repo, ["branch", "a"])?;
        sandbox.run(&repo, ["branch", "b"])?;

        // When renaming `a` to `b`.
        let renamed = sandbox.git().rename_branch(&repo, "a", "b");

        // Then the rename fails and `a` is still there.
        assert!(
            renamed.is_err() && sandbox.git().branch_exists(&repo, "a"),
            "renaming onto b should fail and keep a"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn remove_worktree_without_force_refuses_a_dirty_worktree() -> Result<(), Report<GitError>> {
        // Given a worktree with an untracked file.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let worktree = sandbox.path("worktree");
        sandbox
            .git()
            .add_worktree(&repo, &worktree, "side", "main")?;
        fs::write(worktree.join("notes.txt"), "draft").change_context(GitError)?;

        // When removing it without force.
        let removed = sandbox.git().remove_worktree(&repo, &worktree, false);

        // Then git refuses.
        assert!(
            removed.is_err(),
            "a dirty worktree shouldn't be removed without force"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn add_worktree_on_checks_out_an_existing_branch() -> Result<(), Report<GitError>> {
        // Given a repo with an existing branch `side`.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        sandbox.run(&repo, ["branch", "side"])?;
        let worktree = sandbox.path("worktree");

        // When adding a worktree on `side`.
        sandbox.git().add_worktree_on(&repo, &worktree, "side")?;

        // Then the worktree has `side` checked out.
        let current = sandbox.git().run(&worktree, ["branch", "--show-current"])?;
        assert_eq!(current.trim(), "side", "the worktree should be on side");
        Ok(())
    }

    #[rstest::rstest]
    fn prune_worktrees_drops_a_deleted_worktree() -> Result<(), Report<GitError>> {
        // Given a worktree whose directory was deleted without git knowing.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let worktree = sandbox.path("worktree");
        sandbox
            .git()
            .add_worktree(&repo, &worktree, "side", "main")?;
        fs::remove_dir_all(&worktree).change_context(GitError)?;

        // When pruning worktrees.
        sandbox.git().prune_worktrees(&repo)?;

        // Then git lists only the main checkout.
        let listed = sandbox
            .git()
            .run(&repo, ["worktree", "list", "--porcelain"])?;
        assert_eq!(
            listed
                .lines()
                .filter(|line| line.starts_with("worktree "))
                .count(),
            1,
            "only the main checkout should remain after pruning"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn worktree_facts_names_the_checked_out_branch() -> Result<(), Report<GitError>> {
        // Given a worktree on `side`.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let worktree = sandbox.path("worktree");
        sandbox
            .git()
            .add_worktree(&repo, &worktree, "side", "main")?;

        // When reading its facts.
        let facts = sandbox.git().worktree_facts(&worktree)?;

        // Then the branch is `side`.
        assert_eq!(
            facts.branch.as_deref(),
            Some("side"),
            "the facts should name side"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn worktree_facts_reports_detached_head() -> Result<(), Report<GitError>> {
        // Given a worktree whose HEAD is detached.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let worktree = sandbox.path("worktree");
        sandbox
            .git()
            .add_worktree(&repo, &worktree, "side", "main")?;
        sandbox.run(&worktree, ["checkout", "-q", "--detach"])?;

        // When reading its facts.
        let facts = sandbox.git().worktree_facts(&worktree)?;

        // Then there is no branch.
        assert_eq!(facts.branch, None, "a detached HEAD should have no branch");
        Ok(())
    }

    #[rstest::rstest]
    fn worktree_facts_counts_uncommitted_files() -> Result<(), Report<GitError>> {
        // Given a worktree with two untracked files.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let worktree = sandbox.path("worktree");
        sandbox
            .git()
            .add_worktree(&repo, &worktree, "side", "main")?;
        fs::write(worktree.join("a.txt"), "a").change_context(GitError)?;
        fs::write(worktree.join("b.txt"), "b").change_context(GitError)?;

        // When reading its facts.
        let facts = sandbox.git().worktree_facts(&worktree)?;

        // Then it counts two changes.
        assert_eq!(facts.changes, 2, "both untracked files should count");
        Ok(())
    }

    #[rstest::rstest]
    fn worktree_facts_reads_the_last_commit() -> Result<(), Report<GitError>> {
        // Given a worktree on `side`, branched from `main`'s one commit.
        let sandbox = Sandbox::new()?;
        let repo = sandbox.repo("repo", "main")?;
        let worktree = sandbox.path("worktree");
        sandbox
            .git()
            .add_worktree(&repo, &worktree, "side", "main")?;

        // When reading its facts.
        let facts = sandbox.git().worktree_facts(&worktree)?;

        // Then the last commit is that commit's time and subject.
        assert_eq!(
            facts.last_commit,
            Some((
                SystemTime::UNIX_EPOCH + Duration::from_secs(1000),
                "commit".to_owned()
            )),
            "the facts should carry the last commit"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn worktree_facts_fail_outside_a_repository() -> Result<(), Report<GitError>> {
        // Given a plain directory.
        let sandbox = Sandbox::new()?;
        let dir = sandbox.path("plain");
        fs::create_dir_all(&dir).change_context(GitError)?;

        // When reading its facts.
        let facts = sandbox.git().worktree_facts(&dir);

        // Then git fails.
        assert!(
            facts.is_err(),
            "a directory outside a repository has no facts"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn disk_usage_reports_kilobytes() -> Result<(), Report<GitError>> {
        // Given a directory with one non-empty file.
        let sandbox = Sandbox::new()?;
        let dir = sandbox.path("sized");
        fs::create_dir_all(&dir).change_context(GitError)?;
        fs::write(dir.join("data.bin"), vec![0_u8; 8192]).change_context(GitError)?;

        // When measuring it.
        let size = sandbox.git().disk_usage(&dir);

        // Then it takes some kilobytes.
        assert!(
            size.is_some_and(|kb| kb > 0),
            "a non-empty directory should take space, got {size:?}"
        );
        Ok(())
    }

    /// A fake that hangs until it's killed.
    const HANGS: &str = "exec sleep 10";

    /// A fake that logs each run, then hangs.
    const LOGS_AND_HANGS: &str = "echo run >> \"$HOME/runs\"\nexec sleep 10";

    /// A fake that hangs the first time, and reports one changed file after.
    const HANGS_ONCE: &str = "[ -e \"$HOME/tried\" ] && { echo '?? file'; exit 0; }\ntouch \"$HOME/tried\"\nexec sleep 10";

    #[rstest::rstest]
    fn a_read_that_outlives_its_limit_times_out() -> Result<(), Report<GitError>> {
        // Given a git that hangs, and a read limit of 200 ms.
        let sandbox = Sandbox::new()?;
        let git = sandbox.faking("git", HANGS, Duration::from_millis(200))?;

        // When reading a worktree's facts.
        let reason = reason(git.worktree_facts(sandbox.home.path()));

        // Then the read fails as timed out.
        assert!(
            reason
                .as_deref()
                .is_some_and(|reason| reason.contains("timed out")),
            "a read that outlives its limit should time out, got {reason:?}"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn a_read_that_times_out_once_is_tried_again() -> Result<(), Report<GitError>> {
        // Given a git that hangs the first time and answers after.
        let sandbox = Sandbox::new()?;
        let git = sandbox.faking("git", HANGS_ONCE, Duration::from_millis(200))?;

        // When reading a worktree's facts.
        let facts = git.worktree_facts(sandbox.home.path());

        // Then the second try's answer comes back.
        assert_eq!(
            facts.ok().map(|facts| facts.changes),
            Some(1),
            "a read that timed out once should be tried again"
        );
        Ok(())
    }

    #[rstest::rstest]
    fn a_read_is_tried_at_most_twice() -> Result<(), Report<GitError>> {
        // Given a git that always hangs.
        let sandbox = Sandbox::new()?;
        let git = sandbox.faking("git", LOGS_AND_HANGS, Duration::from_millis(200))?;

        // When asking whether the repo has an origin.
        git.has_origin(sandbox.home.path());

        // Then git ran twice.
        assert_eq!(sandbox.runs()?, 2, "a read should be tried at most twice");
        Ok(())
    }

    #[rstest::rstest]
    fn a_write_that_times_out_is_not_tried_again() -> Result<(), Report<GitError>> {
        // Given a git that always hangs.
        let sandbox = Sandbox::new()?;
        let git = sandbox.faking("git", LOGS_AND_HANGS, Duration::from_millis(200))?;

        // When making a repository.
        let _ = git.init(&sandbox.path("new"));

        // Then git ran once.
        assert_eq!(sandbox.runs()?, 1, "a write should not be tried again");
        Ok(())
    }

    #[rstest::rstest]
    fn disk_usage_of_a_du_that_outlives_its_limit_is_unknown() -> Result<(), Report<GitError>> {
        // Given a `du` that answers only after 10 s, and a limit of 200 ms.
        let sandbox = Sandbox::new()?;
        let git = sandbox.faking("du", "sleep 10\necho \"4\t$1\"", Duration::from_millis(200))?;

        // When measuring a directory.
        let size = git.disk_usage(sandbox.home.path());

        // Then its size is unknown.
        assert_eq!(
            size, None,
            "a du that outlives its limit should give no size"
        );
        Ok(())
    }
}
