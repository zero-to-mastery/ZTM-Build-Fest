//! Thin wrappers around the `git` command. open.blog never links a git library:
//! the user's own git carries their SSH keys, credential helpers, and config.

use std::path::{Path, PathBuf};
use std::process::Command;

pub struct Git {
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub branch: String,
    pub changed: Vec<String>,
    pub ahead: u32,
    pub behind: u32,
    pub has_remote: bool,
}

impl Git {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
        }
    }

    /// Run git with arguments; stdout on success, the stderr text on failure.
    pub fn run(&self, args: &[&str]) -> Result<String, String> {
        let output = Command::new("git")
            .current_dir(&self.root)
            .args(args)
            .output()
            .map_err(|e| format!("cannot run git ({e}); is git installed and on your PATH?"))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Err(if err.is_empty() { out } else { err })
        }
    }

    pub fn is_repo(&self) -> bool {
        self.run(&["rev-parse", "--is-inside-work-tree"])
            .map(|s| s.trim() == "true")
            .unwrap_or(false)
    }

    pub fn init(&self) -> Result<(), String> {
        self.run(&["init", "-q"]).map(|_| ())
    }

    pub fn current_branch(&self) -> Result<String, String> {
        Ok(self
            .run(&["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string())
    }

    pub fn has_remote(&self, remote: &str) -> bool {
        self.run(&["remote", "get-url", remote]).is_ok()
    }

    pub fn remote_url(&self, remote: &str) -> Option<String> {
        self.run(&["remote", "get-url", remote])
            .ok()
            .map(|s| Self::redact_remote_url(s.trim()))
    }

    fn redact_remote_url(remote: &str) -> String {
        match url::Url::parse(remote) {
            Ok(mut url) if matches!(url.scheme(), "http" | "https") => {
                let _ = url.set_password(None);
                let _ = url.set_username("");
                url.set_query(None);
                url.set_fragment(None);
                url.to_string()
            }
            _ => remote.to_string(),
        }
    }

    /// Changed paths (staged, unstaged, untracked) under the given prefixes.
    pub fn changed_paths(&self, prefixes: &[String]) -> Result<Vec<String>, String> {
        let out = self.run(&["status", "--porcelain", "--untracked-files=all", "--"])?;
        let mut paths = Vec::new();
        for line in out.lines() {
            if line.len() < 4 {
                continue;
            }
            let mut path = line[3..].trim().to_string();
            if let Some((_, renamed)) = path.split_once(" -> ") {
                path = renamed.to_string();
            }
            let path = path.trim_matches('"').replace('\\', "/");
            if prefixes.is_empty()
                || prefixes.iter().any(|p| {
                    path == *p || path.starts_with(&format!("{}/", p.trim_end_matches('/')))
                })
            {
                paths.push(path);
            }
        }
        Ok(paths)
    }

    pub fn status(
        &self,
        remote: &str,
        branch: &str,
        prefixes: &[String],
    ) -> Result<Status, String> {
        let current = self.current_branch().unwrap_or_default();
        let changed = self.changed_paths(prefixes)?;
        let has_remote = self.has_remote(remote);
        let (ahead, behind) = if has_remote {
            let spec = format!("{remote}/{branch}...HEAD");
            match self.run(&["rev-list", "--left-right", "--count", &spec]) {
                Ok(s) => {
                    let mut it = s.split_whitespace();
                    let behind = it.next().and_then(|n| n.parse().ok()).unwrap_or(0);
                    let ahead = it.next().and_then(|n| n.parse().ok()).unwrap_or(0);
                    (ahead, behind)
                }
                Err(_) => (0, 0),
            }
        } else {
            (0, 0)
        };
        Ok(Status {
            branch: current,
            changed,
            ahead,
            behind,
            has_remote,
        })
    }

    pub fn add(&self, paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut args: Vec<&str> = vec!["add", "-A", "--"];
        args.extend(paths.iter().map(String::as_str));
        self.run(&args).map(|_| ())
    }

    pub fn commit(&self, message: &str) -> Result<String, String> {
        self.run(&[
            "-c",
            "user.useConfigOnly=false",
            "commit",
            "-q",
            "-m",
            message,
        ])?;
        Ok(self
            .run(&["rev-parse", "--short", "HEAD"])?
            .trim()
            .to_string())
    }

    pub fn pull_rebase(&self, remote: &str, branch: &str) -> Result<(), String> {
        self.run(&["pull", "--rebase", "--autostash", "-q", remote, branch])
            .map(|_| ())
    }

    pub fn push(&self, remote: &str, branch: &str) -> Result<(), String> {
        self.run(&["push", "-q", "-u", remote, &format!("HEAD:{branch}")])
            .map(|_| ())
    }

    /// Push a specific local branch (not HEAD), for the analytics backup branch.
    pub fn push_branch(&self, remote: &str, branch: &str) -> Result<(), String> {
        self.run(&[
            "push",
            "-q",
            remote,
            &format!("refs/heads/{branch}:refs/heads/{branch}"),
        ])
        .map(|_| ())
    }

    /// Whether the remote already has this branch (false before the first push).
    pub fn remote_branch_exists(&self, remote: &str, branch: &str) -> bool {
        self.run(&["ls-remote", "--exit-code", "--heads", remote, branch])
            .map(|out| !out.trim().is_empty())
            .unwrap_or(false)
    }

    pub fn last_commit_time(&self) -> Option<i64> {
        self.run(&["log", "-1", "--format=%ct"])
            .ok()?
            .trim()
            .parse()
            .ok()
    }

    /// Read one file from a branch without touching the working tree.
    pub fn read_file(&self, branch: &str, path: &str) -> Option<String> {
        self.run(&["show", &format!("{branch}:{path}")]).ok()
    }

    #[cfg(test)]
    pub fn branch_exists(&self, branch: &str) -> bool {
        self.run(&[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .is_ok()
    }

    /// Commit a single file to a branch using plumbing commands, leaving the
    /// working tree and the current branch alone. The branch is created as an
    /// orphan the first time. Returns the new commit id, or `None` when the
    /// file is unchanged.
    pub fn commit_file_to_branch(
        &self,
        branch: &str,
        path: &str,
        contents: &str,
        message: &str,
    ) -> Result<Option<String>, String> {
        if self.read_file(branch, path).as_deref() == Some(contents) {
            return Ok(None);
        }
        let blob = {
            let mut child = Command::new("git")
                .current_dir(&self.root)
                .args(["hash-object", "-w", "--stdin"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("cannot run git: {e}"))?;
            use std::io::Write;
            child
                .stdin
                .take()
                .ok_or("no stdin")?
                .write_all(contents.as_bytes())
                .map_err(|e| e.to_string())?;
            let out = child.wait_with_output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let tree_line = format!("100644 blob {blob}\t{path}\n");
        let tree = {
            let mut child = Command::new("git")
                .current_dir(&self.root)
                .args(["mktree"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("cannot run git: {e}"))?;
            use std::io::Write;
            child
                .stdin
                .take()
                .ok_or("no stdin")?
                .write_all(tree_line.as_bytes())
                .map_err(|e| e.to_string())?;
            let out = child.wait_with_output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let parent = self
            .run(&[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ])
            .ok()
            .map(|s| s.trim().to_string());
        let mut args: Vec<String> = vec![
            "commit-tree".into(),
            tree.clone(),
            "-m".into(),
            message.into(),
        ];
        if let Some(p) = &parent {
            args.push("-p".into());
            args.push(p.clone());
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let commit = self.run(&arg_refs)?.trim().to_string();
        self.run(&["update-ref", &format!("refs/heads/{branch}"), &commit])?;
        Ok(Some(commit))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn remote_status_never_exposes_http_credentials() {
        assert_eq!(
            Git::redact_remote_url(
                "https://user:private-token@github.com/example/blog.git?token=secret"
            ),
            "https://github.com/example/blog.git"
        );
        assert_eq!(
            Git::redact_remote_url("git@github.com:example/blog.git"),
            "git@github.com:example/blog.git"
        );
    }

    fn temp_repo(tag: &str) -> (PathBuf, Git) {
        let dir = std::env::temp_dir().join(format!("ob-git-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let git = Git::new(&dir);
        git.init().unwrap();
        git.run(&["config", "user.email", "test@example.com"])
            .unwrap();
        git.run(&["config", "user.name", "Test"]).unwrap();
        git.run(&["checkout", "-q", "-b", "main"]).unwrap();
        (dir, git)
    }

    #[test]
    fn status_add_commit_and_branch_files() {
        let (dir, git) = temp_repo("basic");
        assert!(git.is_repo());
        fs::create_dir_all(dir.join("content/posts")).unwrap();
        fs::write(dir.join("content/posts/a.md"), "a").unwrap();
        fs::write(dir.join("notes.txt"), "n").unwrap();
        let changed = git.changed_paths(&["content".into()]).unwrap();
        assert_eq!(changed, vec!["content/posts/a.md"]);
        git.add(&changed).unwrap();
        let id = git.commit("Publish: a").unwrap();
        assert_eq!(id.len(), 7);
        let st = git.status("origin", "main", &["content".into()]).unwrap();
        assert_eq!(st.branch, "main");
        assert!(st.changed.is_empty());
        assert!(!st.has_remote);

        // An orphan branch holding one file, without touching the working tree.
        let first = git
            .commit_file_to_branch("analytics", "analytics.json", "{\"v\":1}", "backup")
            .unwrap();
        assert!(first.is_some());
        assert!(git.branch_exists("analytics"));
        assert_eq!(
            git.read_file("analytics", "analytics.json").as_deref(),
            Some("{\"v\":1}")
        );
        assert!(
            git.commit_file_to_branch("analytics", "analytics.json", "{\"v\":1}", "backup")
                .unwrap()
                .is_none(),
            "unchanged content makes no commit"
        );
        let second = git
            .commit_file_to_branch("analytics", "analytics.json", "{\"v\":2}", "backup")
            .unwrap()
            .unwrap();
        assert_ne!(Some(second), first);
        assert_eq!(
            git.current_branch().unwrap(),
            "main",
            "the current branch is untouched"
        );
        assert_eq!(
            git.read_file("analytics", "analytics.json").as_deref(),
            Some("{\"v\":2}")
        );
        let log = git.run(&["log", "--oneline", "analytics"]).unwrap();
        assert_eq!(log.lines().count(), 2, "backups form a history");
        let _ = fs::remove_dir_all(&dir);
    }
}
