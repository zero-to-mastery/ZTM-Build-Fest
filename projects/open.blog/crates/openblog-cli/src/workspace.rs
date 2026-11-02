//! Opt-in, synchronous editorial durability. Git owns published content; this
//! store owns only the allow-listed overlay on the checkout used at startup.
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_FILES: usize = 2048;
const MAX_FILE: usize = 16 * 1024 * 1024;
const MAX_TEXT: usize = 2 * 1024 * 1024;
/// The research source library may reach the core 4 MiB library limit.
const MAX_LIBRARY_TEXT: usize = 4 * 1024 * 1024;
const LIBRARY_PATH: &str = ".openblog/private/research/sources.json";
/// The private research notebook shares the library limit.
const NOTEBOOK_PATH: &str = ".openblog/private/research/notebook.json";
/// The private Knowledge Atlas shares the library limit too.
const ATLAS_PATH: &str = ".openblog/private/research/atlas.json";
/// Private claims and evidence links share the library limit as well.
const CLAIMS_PATH: &str = ".openblog/private/research/claims.json";
/// Private passage alignments share the library limit as well.
const ALIGNMENTS_PATH: &str = ".openblog/private/research/alignments.json";
/// The private curated selections (ADR 0185) share the library limit too.
const SELECTIONS_PATH: &str = openblog_core::curated_selection::SELECTIONS_FILE;
/// The private review acknowledgements (ADR 0124), up to their own limit.
const ACKNOWLEDGEMENTS_PATH: &str = crate::research_review::ACKNOWLEDGEMENTS_FILE;
const MAX_ACKNOWLEDGEMENTS_TEXT: usize = crate::research_review::MAX_ACKNOWLEDGEMENTS_BYTES;
const MAX_TOTAL: usize = 64 * 1024 * 1024;
const MAX_MANIFEST: usize = 8 * 1024 * 1024;
const BUCKET: &str = "openblog-workspace";

pub fn configured() -> bool {
    [
        "OPENBLOG_WORKSPACE_SUPABASE_URL",
        "OPENBLOG_WORKSPACE_SECRET_KEY",
        "OPENBLOG_WORKSPACE_NAMESPACE",
    ]
    .iter()
    .any(|name| std::env::var_os(name).is_some())
}

type Files = BTreeMap<String, Vec<u8>>;
type Manifest = BTreeMap<String, Entry>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Entry {
    base: Option<String>,
    value: Option<Record>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Record {
    Text { text: String },
    Blob { sha256: String, size: usize },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Remote {
    revision: u64,
    manifest: Manifest,
}

struct Backend {
    url: String,
    key: String,
    namespace: String,
    agent: ureq::Agent,
}

impl Backend {
    fn from_env() -> Result<Option<Self>, String> {
        if !configured() {
            return Ok(None);
        }
        let values = [
            "OPENBLOG_WORKSPACE_SUPABASE_URL",
            "OPENBLOG_WORKSPACE_SECRET_KEY",
            "OPENBLOG_WORKSPACE_NAMESPACE",
        ]
        .map(|name| std::env::var(name).ok().filter(|v| !v.trim().is_empty()));
        let [Some(url), Some(key), Some(namespace)] = values else {
            return Err(
                "workspace persistence requires URL, server secret key and namespace together"
                    .into(),
            );
        };
        let parsed = url::Url::parse(&url).map_err(|_| "invalid workspace Supabase URL")?;
        if parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.path() != "/"
        {
            return Err(
                "workspace Supabase URL must be an HTTPS origin without credentials".into(),
            );
        }
        if !(1..=80).contains(&namespace.len())
            || !namespace
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(
                "workspace namespace must contain 1–80 ASCII letters, digits, - or _".into(),
            );
        }
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(15)))
            .max_redirects(0)
            .build()
            .into();
        Ok(Some(Self {
            url: url.trim_end_matches('/').into(),
            key,
            namespace,
            agent,
        }))
    }

    fn rpc(&self, function: &str, value: &serde_json::Value) -> Result<Vec<u8>, String> {
        let mut request = self
            .agent
            .post(format!("{}/rest/v1/rpc/{function}", self.url))
            .header("apikey", &self.key)
            .header("Content-Type", "application/json");
        if !self.key.starts_with("sb_secret_") {
            request = request.header("Authorization", &format!("Bearer {}", self.key));
        }
        let mut response = request
            .send(value.to_string().as_bytes())
            .map_err(|_| "workspace database request failed (timeout, service error or revision conflict); save NOT acknowledged".to_string())?;
        read_bounded(response.body_mut().as_reader(), MAX_MANIFEST)
    }

    fn load(&self) -> Result<Remote, String> {
        let bytes = self.rpc(
            "openblog_workspace_read",
            &serde_json::json!({"p_namespace": self.namespace}),
        )?;
        serde_json::from_slice(&bytes).map_err(|_| "invalid workspace database response".into())
    }

    fn commit(&self, revision: u64, manifest: &Manifest) -> Result<u64, String> {
        let bytes = self.rpc(
            "openblog_workspace_commit",
            &serde_json::json!({
                "p_namespace": self.namespace, "p_revision": revision, "p_manifest": manifest,
            }),
        )?;
        let next: u64 = serde_json::from_slice(&bytes)
            .map_err(|_| "invalid workspace commit acknowledgement")?;
        if next != revision + 1 {
            return Err("invalid workspace revision acknowledgement".into());
        }
        Ok(next)
    }

    fn blob(&self, hash: &str) -> String {
        format!(
            "{}/storage/v1/object/{BUCKET}/{}/{}",
            self.url, self.namespace, hash
        )
    }

    fn upload(&self, hash: &str, bytes: &[u8]) -> Result<(), String> {
        let mut request = self
            .agent
            .post(self.blob(hash))
            .header("apikey", &self.key)
            .header("Content-Type", "application/octet-stream")
            .header("x-upsert", "true");
        if !self.key.starts_with("sb_secret_") {
            request = request.header("Authorization", &format!("Bearer {}", self.key));
        }
        request
            .send(bytes)
            .map_err(|_| "workspace upload failed; save NOT acknowledged".to_string())?;
        Ok(())
    }

    fn download(&self, hash: &str) -> Result<Vec<u8>, String> {
        let mut request = self.agent.get(self.blob(hash)).header("apikey", &self.key);
        if !self.key.starts_with("sb_secret_") {
            request = request.header("Authorization", &format!("Bearer {}", self.key));
        }
        let mut response = request
            .call()
            .map_err(|_| "cannot restore private workspace upload".to_string())?;
        read_bounded(response.body_mut().as_reader(), MAX_FILE)
    }
}

fn read_bounded(reader: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read workspace response".to_string())?;
    if bytes.len() > limit {
        return Err("workspace response exceeds its size limit".into());
    }
    Ok(bytes)
}

#[derive(Clone)]
struct Policy {
    content: String,
    static_dir: String,
    users: String,
}

fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && path.split('/').count() <= 12
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

impl Policy {
    fn new(root: &Path) -> Result<Self, String> {
        let config = crate::site::load_config(root)?;
        let policy = Self {
            content: config.paths.content.trim_end_matches('/').to_string(),
            static_dir: config.paths.static_dir.trim_end_matches('/').to_string(),
            users: config.admin.users_file.replace('\\', "/"),
        };
        for path in [&policy.content, &policy.static_dir] {
            if !safe_relative(path) || path.split('/').any(|s| s.starts_with('.')) {
                return Err(
                    "workspace persistence needs non-hidden, project-relative content/static paths"
                        .into(),
                );
            }
        }
        let mut unrestricted = policy.clone();
        unrestricted.users.clear();
        if unrestricted.allowed(&policy.users) {
            return Err("admin users file overlaps the durable workspace allow-list".into());
        }
        Ok(policy)
    }

    fn roots(&self) -> Vec<String> {
        vec![
            "openblog.json".into(),
            ".gitignore".into(),
            format!("{}/posts", self.content),
            format!("{}/pages", self.content),
            format!("{}/series", self.content),
            format!("{}/services", self.content),
            format!("{}/images/uploads", self.static_dir),
            format!("{}/tracks/uploads", self.static_dir),
            "assistant/skills".into(),
            "assistant/context".into(),
            ".openblog/private/context".into(),
            ".openblog/private/admin-preferences".into(),
            LIBRARY_PATH.into(),
            NOTEBOOK_PATH.into(),
            ATLAS_PATH.into(),
            CLAIMS_PATH.into(),
            ALIGNMENTS_PATH.into(),
            SELECTIONS_PATH.into(),
            ACKNOWLEDGEMENTS_PATH.into(),
            ".openblog/pending-tracks".into(),
            ".openblog/trash".into(),
        ]
    }

    fn allowed(&self, path: &str) -> bool {
        if !safe_relative(path) || path == self.users {
            return false;
        }
        let extension = path.rsplit('.').next().unwrap_or("");
        if matches!(
            path,
            "openblog.json"
                | ".gitignore"
                | LIBRARY_PATH
                | NOTEBOOK_PATH
                | ATLAS_PATH
                | CLAIMS_PATH
                | ALIGNMENTS_PATH
                | SELECTIONS_PATH
                | ACKNOWLEDGEMENTS_PATH
        ) {
            return true;
        }
        if let Some(relative) = path.strip_prefix(&format!("{}/", self.content)) {
            return ["posts/", "pages/", "series/", "services/"]
                .iter()
                .any(|prefix| {
                    relative.starts_with(prefix)
                        && (extension == "md"
                            || (*prefix == "posts/" && path.ends_with(".credits.json")))
                });
        }
        if path.starts_with(&format!("{}/images/uploads/", self.static_dir)) {
            return matches!(extension, "png" | "jpg" | "gif" | "webp" | "avif");
        }
        if path.starts_with(&format!("{}/tracks/uploads/", self.static_dir)) {
            return extension == "gpx";
        }
        if path.starts_with("assistant/skills/") {
            return extension == "md";
        }
        for prefix in ["assistant/context/", ".openblog/private/context/"] {
            if let Some(relative) = path.strip_prefix(prefix) {
                return matches!(relative, "author.md" | "site.md")
                    || (relative.starts_with("posts/") && extension == "md")
                    || (relative.starts_with("references/") && matches!(extension, "md" | "txt"));
            }
        }
        fn token_file(path: &str, suffix: &str) -> bool {
            path.strip_suffix(suffix).is_some_and(|token| {
                token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())
            })
        }
        if let Some(relative) = path.strip_prefix(".openblog/private/admin-preferences/") {
            return token_file(relative, ".json");
        }
        if let Some(relative) = path.strip_prefix(".openblog/pending-tracks/") {
            return token_file(relative, ".gpx");
        }
        if let Some(relative) = path.strip_prefix(".openblog/trash/") {
            return (!relative.contains('/')
                && (extension == "md" || path.ends_with(".credits.json")))
                || (relative.starts_with("context/") && extension == "md")
                || (relative.starts_with("tracks/") && extension == "gpx");
        }
        false
    }

    fn text_limit(&self, path: &str) -> usize {
        if path == ACKNOWLEDGEMENTS_PATH {
            return MAX_ACKNOWLEDGEMENTS_TEXT;
        }
        if [
            LIBRARY_PATH,
            NOTEBOOK_PATH,
            ATLAS_PATH,
            CLAIMS_PATH,
            ALIGNMENTS_PATH,
            SELECTIONS_PATH,
        ]
        .contains(&path)
        {
            MAX_LIBRARY_TEXT
        } else {
            MAX_TEXT
        }
    }

    fn binary(&self, path: &str) -> bool {
        path.starts_with(&format!("{}/images/uploads/", self.static_dir))
            || path.starts_with(&format!("{}/tracks/uploads/", self.static_dir))
            || path.starts_with(".openblog/pending-tracks/")
            || path.starts_with(".openblog/trash/tracks/")
    }

    fn target(&self, root: &Path, path: &str) -> Result<PathBuf, String> {
        if !self.allowed(path) {
            return Err(format!("workspace path is not allowed: {path}"));
        }
        let mut target = root.to_path_buf();
        for part in path.split('/') {
            target.push(part);
            match fs::symlink_metadata(&target) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(format!("workspace symlink is not allowed: {path}"));
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(format!("cannot inspect workspace path: {path}")),
            }
        }
        Ok(target)
    }

    fn validate_config(&self, bytes: &[u8]) -> Result<(), String> {
        let raw: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|_| "invalid workspace configuration")?;
        let config: openblog_core::SiteConfig =
            serde_json::from_value(raw.clone()).map_err(|_| "invalid workspace configuration")?;
        let schema =
            serde_json::to_value(&config).map_err(|_| "cannot validate workspace configuration")?;
        fn known_keys(raw: &serde_json::Value, schema: &serde_json::Value) -> bool {
            match (raw, schema) {
                (serde_json::Value::Object(raw), serde_json::Value::Object(schema)) => raw
                    .iter()
                    .all(|(key, value)| schema.get(key).is_some_and(|s| known_keys(value, s))),
                // Contributor IDs and other user dictionaries are represented
                // in the deserialized config, not a hard-coded key list.
                _ => true,
            }
        }
        if !known_keys(&raw, &schema) {
            return Err("unknown configuration fields cannot enter workspace storage (never store inline secrets)".into());
        }
        if config.paths.content.trim_end_matches('/') != self.content
            || config.paths.static_dir.trim_end_matches('/') != self.static_dir
            || config.admin.users_file.replace('\\', "/") != self.users
        {
            return Err(
                "workspace content/static/users paths cannot change while persistence is enabled"
                    .into(),
            );
        }
        Ok(())
    }

    fn scan(&self, root: &Path) -> Result<Files, String> {
        fn visit(
            policy: &Policy,
            root: &Path,
            rel: &str,
            files: &mut Files,
            total: &mut usize,
            visited: &mut usize,
        ) -> Result<(), String> {
            *visited += 1;
            if *visited > MAX_FILES * 4 || !safe_relative(rel) {
                return Err("workspace directory depth or path limit exceeded".into());
            }
            // Check every ancestor, including .openblog/private, without
            // enumerating or reading credentials in its other subdirectories.
            let mut target = root.to_path_buf();
            for part in rel.split('/') {
                target.push(part);
                if fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
                    return Err(format!("workspace symlink is not allowed: {rel}"));
                }
            }
            let meta = match fs::symlink_metadata(&target) {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(_) => return Err(format!("cannot inspect workspace: {rel}")),
            };
            if meta.is_dir() {
                let mut count = 0;
                for entry in fs::read_dir(target).map_err(|_| "cannot read workspace directory")? {
                    count += 1;
                    if count > MAX_FILES {
                        return Err("workspace directory entry limit exceeded".into());
                    }
                    let name = entry
                        .map_err(|_| "cannot read workspace entry")?
                        .file_name();
                    let name = name.to_str().ok_or("workspace filenames must be UTF-8")?;
                    visit(
                        policy,
                        root,
                        &format!("{rel}/{name}"),
                        files,
                        total,
                        visited,
                    )?;
                }
            } else if policy.allowed(rel) {
                if !meta.is_file() || meta.len() > MAX_FILE as u64 || files.len() >= MAX_FILES {
                    return Err("workspace file count, type or size limit exceeded".into());
                }
                let bytes = read_bounded(
                    fs::File::open(&target).map_err(|_| "cannot read workspace file")?,
                    MAX_FILE,
                )?;
                *total += bytes.len();
                if *total > MAX_TOTAL {
                    return Err("workspace exceeds 64 MiB".into());
                }
                if rel == "openblog.json" {
                    policy.validate_config(&bytes)?;
                }
                if !policy.binary(rel)
                    && (bytes.len() > policy.text_limit(rel)
                        || std::str::from_utf8(&bytes).is_err())
                {
                    return Err(format!(
                        "workspace text must be UTF-8 and within its size limit: {rel}"
                    ));
                }
                files.insert(rel.into(), bytes);
            }
            Ok(())
        }
        let mut files = Files::new();
        let mut total = 0;
        let mut visited = 0;
        for rel in self.roots() {
            visit(self, root, &rel, &mut files, &mut total, &mut visited)?;
        }
        Ok(files)
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn git_hash(root: &Path, bytes: &[u8]) -> Result<String, String> {
    let mut child = Command::new("git")
        .current_dir(root)
        .args(["hash-object", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "cannot start git workspace hash")?;
    child
        .stdin
        .take()
        .ok_or("cannot open git hash input")?
        .write_all(bytes)
        .map_err(|_| "cannot hash workspace bytes")?;
    let output = child
        .wait_with_output()
        .map_err(|_| "cannot finish git workspace hash")?;
    if !output.status.success() {
        return Err("git workspace hash failed".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn startup_git(root: &Path, args: &[&str], action: &str) -> Result<bool, String> {
    let mut child = Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // Git may include credential-bearing remote URLs in diagnostics.
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| format!("cannot start Git to {action} for workspace startup"))?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if result.is_err() {
                    format!("cannot wait for Git to {action} for workspace startup")
                } else {
                    format!("Git {action} timed out during workspace startup; inspect checkout before retrying")
                });
            }
        }
    }
}

fn prepare_checkout(root: &Path) -> Result<(), String> {
    let config = crate::site::load_config(root)?;
    let remote = config.publish.remote.as_str();
    let branch = config.publish.branch.as_str();
    if remote.is_empty()
        || remote.starts_with('-')
        || !remote
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        || !startup_git(
            root,
            &["check-ref-format", &format!("refs/heads/{branch}")],
            "validate branch",
        )?
    {
        return Err(
            "workspace startup requires a safe configured Git remote name and branch".into(),
        );
    }
    if !crate::git::Git::new(root).has_remote(remote) {
        return Ok(());
    }
    let tracking = format!("refs/remotes/{remote}/{branch}");
    let refspec = format!("+refs/heads/{branch}:{tracking}");
    if !startup_git(
        root,
        &[
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--",
            remote,
            &refspec,
        ],
        "fetch published branch",
    )? {
        return Err("workspace startup could not fetch the configured published branch; check credentials, remote and branch".into());
    }
    if !startup_git(
        root,
        &["merge-base", "--is-ancestor", "HEAD", &tracking],
        "verify fast-forward ancestry",
    )? {
        return Err("workspace startup cannot fast-forward HEAD to the published branch (local-only commits, divergence or insufficient shallow history); preserve local work and reconcile Git before retrying".into());
    }
    if !startup_git(
        root,
        &[
            "-c",
            "merge.autoStash=false",
            "-c",
            "core.hooksPath=",
            "merge",
            "--ff-only",
            "--no-autostash",
            "--no-edit",
            &tracking,
        ],
        "fast-forward published checkout",
    )? {
        return Err("workspace startup fast-forward failed (dirty tracked/untracked conflicts or incomplete Git history); no reset/discard was attempted; preserve local files and reconcile before retrying".into());
    }
    Ok(())
}

fn baseline(root: &Path, policy: &Policy) -> Result<BTreeMap<String, String>, String> {
    let config = crate::site::load_config(root)?;
    let tracking = format!(
        "refs/remotes/{}/{}",
        config.publish.remote, config.publish.branch
    );
    let tracking_exists = Command::new("git")
        .current_dir(root)
        .args(["rev-parse", "--verify", &tracking])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "cannot inspect published workspace baseline")?
        .success();
    if !tracking_exists && crate::git::Git::new(root).has_remote(&config.publish.remote) {
        return Err(format!(
            "workspace persistence requires fetched {tracking}; fetch the configured published branch before startup"
        ));
    }
    let reference = if tracking_exists {
        tracking.as_str()
    } else {
        "HEAD"
    };
    let output = Command::new("git")
        .current_dir(root)
        .args(["ls-tree", "-rz", reference, "--"])
        .args(policy.roots())
        .output()
        .map_err(|_| "workspace persistence requires Git and a committed HEAD")?;
    if !output.status.success() {
        return Err("workspace persistence requires a Git checkout with a committed HEAD".into());
    }
    let mut files = BTreeMap::new();
    for record in output.stdout.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let record = std::str::from_utf8(record).map_err(|_| "Git paths must be UTF-8")?;
        let (info, path) = record
            .split_once('\t')
            .ok_or("invalid Git workspace tree")?;
        if !policy.allowed(path) {
            continue;
        }
        let parts: Vec<_> = info.split(' ').collect();
        if parts.len() != 3 || parts[1] != "blob" || parts[0] == "120000" {
            return Err(format!("unsupported Git workspace entry: {path}"));
        }
        if files.len() >= MAX_FILES {
            return Err("Git workspace exceeds file count limit".into());
        }
        files.insert(path.into(), parts[2].into());
    }
    Ok(files)
}

pub struct Workspace {
    backend: Backend,
    policy: Policy,
    base: BTreeMap<String, String>,
    revision: u64,
    manifest: Manifest,
    blocked: Option<String>,
}

impl Workspace {
    /// Must run before creating AppState, building, watchers, or binding HTTP.
    pub fn restore_from_env(root: &Path) -> Result<Option<Self>, String> {
        let Some(backend) = Backend::from_env()? else {
            return Ok(None);
        };
        Self::restore_with_backend(root, backend).map(Some)
    }

    fn restore_with_backend(root: &Path, backend: Backend) -> Result<Self, String> {
        let root = fs::canonicalize(root).map_err(|_| "cannot resolve workspace project")?;
        let _transaction = crate::transaction::ContentTransactionLock::acquire(&root)?;
        prepare_checkout(&root)?;
        let policy = Policy::new(&root)?;
        let base = baseline(&root, &policy)?;
        let remote = backend.load()?;
        let mut workspace = Self {
            backend,
            policy,
            base,
            revision: remote.revision,
            manifest: remote.manifest,
            blocked: None,
        };
        workspace.restore(&root)?;
        workspace.save(&root)?;
        Ok(workspace)
    }

    fn restore(&mut self, root: &Path) -> Result<(), String> {
        let started = Instant::now();
        let local = self.policy.scan(root)?;
        let config = crate::site::load_config(root)?;
        if crate::git::Git::new(root).has_remote(&config.publish.remote) {
            let tracking = format!(
                "refs/remotes/{}/{}",
                config.publish.remote, config.publish.branch
            );
            let difference = Command::new("git")
                .current_dir(root)
                .args(["diff", "--name-only", "-z", "HEAD", &tracking, "--"])
                .args(self.policy.roots())
                .output()
                .map_err(|_| "cannot inspect workspace checkout against published branch")?;
            if !difference.status.success() {
                return Err("cannot inspect workspace checkout against published branch".into());
            }
            for path in difference
                .stdout
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
            {
                let path =
                    std::str::from_utf8(path).map_err(|_| "workspace Git paths must be UTF-8")?;
                if self.policy.allowed(path) && !self.manifest.contains_key(path) {
                    let local_hash = local
                        .get(path)
                        .map(|bytes| git_hash(root, bytes))
                        .transpose()?;
                    if local_hash.as_ref() != self.base.get(path) {
                        return Err(format!(
                            "workspace checkout conflict at {path}; check out the fetched published branch before startup"
                        ));
                    }
                }
            }
        }
        let mut desired = Files::new();
        if self.manifest.len() > MAX_FILES {
            return Err("workspace manifest exceeds file count limit".into());
        }
        let mut total = 0;
        for (path, entry) in &self.manifest {
            if started.elapsed() > Duration::from_secs(90) {
                return Err("workspace restore exceeded its operation deadline".into());
            }
            self.policy.target(root, path)?;
            if entry.base.as_ref().is_some_and(|b| {
                !matches!(b.len(), 40 | 64) || !b.bytes().all(|b| b.is_ascii_hexdigit())
            }) {
                return Err("invalid workspace base identity".into());
            }
            let value = match &entry.value {
                None => None,
                Some(Record::Text { text }) => {
                    if self.policy.binary(path) || text.len() > self.policy.text_limit(path) {
                        return Err("invalid workspace text record".into());
                    }
                    Some(text.as_bytes().to_vec())
                }
                Some(Record::Blob { sha256, size }) => {
                    if !self.policy.binary(path)
                        || *size > MAX_FILE
                        || sha256.len() != 64
                        || !sha256.bytes().all(|b| b.is_ascii_hexdigit())
                    {
                        return Err("invalid workspace blob record".into());
                    }
                    let bytes = self.backend.download(sha256)?;
                    if bytes.len() != *size || digest(&bytes) != *sha256 {
                        return Err("workspace upload integrity check failed".into());
                    }
                    Some(bytes)
                }
            };
            total += value.as_ref().map_or(0, Vec::len);
            if total > MAX_TOTAL {
                return Err("workspace restore exceeds 64 MiB".into());
            }
            if let Some(bytes) = &value {
                if path == "openblog.json" {
                    self.policy.validate_config(bytes)?;
                }
            }
            let wanted = value.as_ref().map(|b| git_hash(root, b)).transpose()?;
            let current_git = self.base.get(path);
            let current_local = local.get(path).map(|b| git_hash(root, b)).transpose()?;
            check_restore(
                path,
                entry.base.as_ref(),
                wanted.as_ref(),
                current_git,
                current_local.as_ref(),
            )?;
            if let Some(bytes) = value {
                desired.insert(path.clone(), bytes);
            }
        }
        if started.elapsed() > Duration::from_secs(90) {
            return Err("workspace restore exceeded its operation deadline".into());
        }
        // Preflight the entire bundle (including sidecars/settings/deletions)
        // before touching any file. An interrupted application is idempotent.
        for path in self.manifest.keys() {
            let target = self.policy.target(root, path)?;
            match desired.get(path) {
                Some(bytes) => atomic_write(&target, bytes)?,
                None if target.exists() => fs::remove_file(&target)
                    .map_err(|_| format!("cannot restore workspace deletion: {path}"))?,
                None => {}
            }
        }
        self.policy.scan(root)?;
        Ok(())
    }

    pub fn begin(&mut self) -> Result<(), String> {
        if let Some(reason) = &self.blocked {
            return Err(format!(
                "workspace writes blocked until restart/reconciliation: {reason}"
            ));
        }
        let remote = self.backend.load()?;
        if remote.revision != self.revision {
            self.blocked = Some("stale workspace revision; another instance saved changes".into());
            return Err(self.blocked.clone().unwrap());
        }
        Ok(())
    }

    /// Retire only changes acknowledged by the Git remote, never a local-only
    /// commit (which would be lost with an ephemeral checkout).
    pub fn published(&mut self, root: &Path) -> Result<(), String> {
        match baseline(root, &self.policy) {
            Ok(base) => {
                self.base = base;
                Ok(())
            }
            Err(error) => {
                self.blocked = Some(error.clone());
                Err(error)
            }
        }
    }

    pub fn save(&mut self, root: &Path) -> Result<(), String> {
        let result = self.save_inner(root);
        if let Err(error) = &result {
            self.blocked = Some(error.clone());
        }
        result
    }

    fn save_inner(&mut self, root: &Path) -> Result<(), String> {
        let started = Instant::now();
        let files = self.policy.scan(root)?;
        let mut manifest = Manifest::new();
        let mut uploads = BTreeMap::new();
        for (path, bytes) in &files {
            if started.elapsed() > Duration::from_secs(90) {
                return Err(
                    "workspace save exceeded its operation deadline; NOT acknowledged".into(),
                );
            }
            let base = self.base.get(path).cloned();
            if Some(git_hash(root, bytes)?) == base {
                continue;
            }
            let value = if self.policy.binary(path) {
                let hash = digest(bytes);
                uploads.insert(hash.clone(), bytes);
                Record::Blob {
                    sha256: hash,
                    size: bytes.len(),
                }
            } else {
                Record::Text {
                    text: String::from_utf8(bytes.clone()).map_err(|_| "invalid workspace text")?,
                }
            };
            manifest.insert(
                path.clone(),
                Entry {
                    base,
                    value: Some(value),
                },
            );
        }
        for (path, base) in &self.base {
            if !files.contains_key(path) {
                manifest.insert(
                    path.clone(),
                    Entry {
                        base: Some(base.clone()),
                        value: None,
                    },
                );
            }
        }
        for (path, previous) in &self.manifest {
            if !files.contains_key(path) && !manifest.contains_key(path) {
                manifest.insert(
                    path.clone(),
                    Entry {
                        base: previous.base.clone(),
                        value: None,
                    },
                );
            }
        }
        if manifest == self.manifest {
            return Ok(());
        }
        if manifest.len() > MAX_FILES
            || serde_json::to_vec(&manifest)
                .map_err(|_| "cannot encode workspace")?
                .len()
                > MAX_MANIFEST - 1024
        {
            return Err("workspace manifest exceeds its count or 8 MiB limit".into());
        }
        for (hash, bytes) in uploads {
            if started.elapsed() > Duration::from_secs(90) {
                return Err(
                    "workspace save exceeded its operation deadline; NOT acknowledged".into(),
                );
            }
            // Existing manifest blobs are immutable and need not be uploaded again.
            if !self
                .manifest
                .values()
                .any(|e| matches!(&e.value, Some(Record::Blob { sha256, .. }) if sha256 == &hash))
            {
                self.backend.upload(&hash, bytes)?;
            }
        }
        if started.elapsed() > Duration::from_secs(90) {
            return Err("workspace save exceeded its operation deadline; NOT acknowledged".into());
        }
        self.revision = self.backend.commit(self.revision, &manifest)?;
        self.manifest = manifest;
        Ok(())
    }
}

fn check_restore(
    path: &str,
    base: Option<&String>,
    desired: Option<&String>,
    git: Option<&String>,
    local: Option<&String>,
) -> Result<(), String> {
    if (git != base && git != desired) || (local != git && local != desired) {
        return Err(format!("workspace restore conflict at {path}; preserve both versions and reconcile before restarting"));
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("workspace path has no parent")?;
    fs::create_dir_all(parent).map_err(|_| "cannot create workspace directory")?;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "cannot create workspace staging name")?;
    let staging = parent.join(format!(".workspace-{:x}", Sha256::digest(random)));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&staging)
            .map_err(|_| "cannot stage workspace restore")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "cannot write workspace restore")?;
        crate::fsutil::replace_file(&staging, path)
            .map_err(|_| "cannot install workspace restore".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    #[derive(Default)]
    struct MockDatabase {
        revision: u64,
        manifest: Manifest,
        blobs: Files,
        requests: Vec<(String, BTreeMap<String, String>)>,
        fail_commit: bool,
        fail_upload: bool,
    }

    struct MockSupabase {
        url: String,
        data: std::sync::Arc<std::sync::Mutex<MockDatabase>>,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl MockSupabase {
        fn new() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            listener.set_nonblocking(true).unwrap();
            let data = std::sync::Arc::new(std::sync::Mutex::new(MockDatabase::default()));
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let state = std::sync::Arc::clone(&data);
            let stopping = std::sync::Arc::clone(&stop);
            let thread = std::thread::spawn(move || {
                while !stopping.load(Ordering::Relaxed) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(connection) => connection,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                        Err(error) => panic!("mock accept failed: {error}"),
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut reader = BufReader::new(&stream);
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    let request_line = line.trim().to_string();
                    let parts: Vec<_> = request_line.split(' ').collect();
                    let (method, path) = (parts[0], parts[1]);
                    let mut headers = BTreeMap::new();
                    loop {
                        line.clear();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" {
                            break;
                        }
                        let (key, value) = line.trim().split_once(':').unwrap();
                        headers.insert(key.to_ascii_lowercase(), value.trim().to_string());
                    }
                    let length = headers
                        .get("content-length")
                        .map_or(0, |value| value.parse().unwrap());
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    let mut database = state.lock().unwrap();
                    database.requests.push((request_line.clone(), headers));
                    let (status, response) = if path == "/rest/v1/rpc/openblog_workspace_read" {
                        let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
                        assert_eq!(request["p_namespace"], "tests");
                        (
                            200,
                            serde_json::to_vec(&serde_json::json!({
                                "revision": database.revision, "manifest": database.manifest,
                            }))
                            .unwrap(),
                        )
                    } else if path == "/rest/v1/rpc/openblog_workspace_commit" {
                        let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
                        assert_eq!(request["p_namespace"], "tests");
                        if database.fail_commit {
                            (500, b"database unavailable".to_vec())
                        } else if request["p_revision"].as_u64() != Some(database.revision) {
                            (409, b"stale revision".to_vec())
                        } else {
                            database.manifest =
                                serde_json::from_value(request["p_manifest"].clone()).unwrap();
                            database.revision += 1;
                            (200, database.revision.to_string().into_bytes())
                        }
                    } else if let Some(hash) =
                        path.strip_prefix("/storage/v1/object/openblog-workspace/tests/")
                    {
                        match method {
                            "POST" if database.fail_upload => {
                                (500, b"storage unavailable".to_vec())
                            }
                            "POST" => {
                                database.blobs.insert(hash.into(), body);
                                (200, b"{}".to_vec())
                            }
                            "GET" => match database.blobs.get(hash) {
                                Some(bytes) => (200, bytes.clone()),
                                None => (404, b"missing object".to_vec()),
                            },
                            _ => (405, Vec::new()),
                        }
                    } else {
                        (404, Vec::new())
                    };
                    drop(database);
                    write!(
                        stream,
                        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        response.len()
                    )
                    .unwrap();
                    stream.write_all(&response).unwrap();
                }
            });
            Self {
                url,
                data,
                stop,
                thread: Some(thread),
            }
        }

        fn backend(&self, key: &str) -> Backend {
            let mut backend = backend(self.url.clone());
            backend.key = key.into();
            backend
        }

        fn assert_auth(&self, key: &str, bearer: bool) {
            let data = self.data.lock().unwrap();
            assert!(!data.requests.is_empty());
            for (path, headers) in &data.requests {
                assert_eq!(
                    headers.get("apikey").map(String::as_str),
                    Some(key),
                    "{path}"
                );
                if bearer {
                    assert_eq!(
                        headers.get("authorization"),
                        Some(&format!("Bearer {key}")),
                        "{path}"
                    );
                } else {
                    assert!(!headers.contains_key("authorization"), "{path}");
                }
            }
        }
    }

    impl Drop for MockSupabase {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            let result = self.thread.take().unwrap().join();
            if !std::thread::panicking() {
                result.unwrap();
            }
        }
    }

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::current_dir()
                .unwrap()
                .join(".scratch")
                .join(format!(
                    "workspace-tests-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
            fs::create_dir_all(root.join("content/posts")).unwrap();
            fs::write(root.join("openblog.json"), r#"{"title":"Workspace"}"#).unwrap();
            fs::write(root.join("content/posts/old.md"), "published").unwrap();
            fs::write(root.join("content/posts/delete.md"), "delete me").unwrap();
            let git = crate::git::Git::new(&root);
            git.init().unwrap();
            git.run(&["add", "."]).unwrap();
            git.run(&[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-qm",
                "published",
            ])
            .unwrap();
            Self(root)
        }

        fn workspace(&self, backend: Backend, manifest: Manifest) -> Workspace {
            let policy = Policy::new(&self.0).unwrap();
            let base = baseline(&self.0, &policy).unwrap();
            Workspace {
                backend,
                policy,
                base,
                revision: 1,
                manifest,
                blocked: None,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn backend(url: String) -> Backend {
        Backend {
            url,
            key: "test-only".into(),
            namespace: "tests".into(),
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(2)))
                .max_redirects(0)
                .build()
                .into(),
        }
    }

    fn response_once(status: u16, body: Vec<u8>) -> (Backend, std::thread::JoinHandle<Vec<u8>>) {
        let (backend, server) = response_sequence(vec![(status, body)]);
        (
            backend,
            std::thread::spawn(move || server.join().unwrap().remove(0)),
        )
    }

    fn response_sequence(
        responses: Vec<(u16, Vec<u8>)>,
    ) -> (Backend, std::thread::JoinHandle<Vec<Vec<u8>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&stream);
                let mut line = String::new();
                let mut length = 0;
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                }
                let mut request = vec![0; length];
                reader.read_exact(&mut request).unwrap();
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                stream.write_all(&body).unwrap();
                requests.push(request);
            }
            requests
        });
        (backend(url), handle)
    }

    fn policy() -> Policy {
        Policy {
            content: "content".into(),
            static_dir: "static".into(),
            users: ".openblog/users.json".into(),
        }
    }

    #[test]
    fn allow_list_excludes_credentials_and_arbitrary_private_state() {
        let policy = policy();
        for path in [
            ".git/config",
            ".openblog/users.json",
            ".openblog/analytics.json",
            ".openblog/private/engagement/api-key",
            ".openblog/private/assistant/api-key",
            ".openblog/private/arbitrary.json",
            ".openblog/private/research/other.json",
            ".openblog/private/research/sources.json/extra",
            ".openblog/private/research/notebook.json/extra",
            ".openblog/private/research/atlas.json/extra",
            ".openblog/private/research/atlas.json.lock",
            ".openblog/private/research/atlas.json.1-2.tmp",
            ".openblog/private/research/claims.json/extra",
            ".openblog/private/research/claims.json.lock",
            ".openblog/private/research/claims.json.1-2.tmp",
            ".openblog/private/research/alignments.json/extra",
            ".openblog/private/research/alignments.json.lock",
            ".openblog/private/research/alignments.json.1-2.tmp",
            ".openblog/private/research/selections.json/extra",
            ".openblog/private/research/selections.json.lock",
            ".openblog/private/research/selections.json.1-2.tmp",
            ".openblog/private/research/acknowledgements.json/extra",
            ".openblog/private/research/acknowledgements.json.lock",
            ".openblog/private/research/acknowledgements.json.1-2.tmp",
            "content/../.git/config",
            "content/posts/../../secret.md",
            "content\\posts\\escape.md",
            "/content/posts/absolute.md",
            "C:/content/posts/absolute.md",
        ] {
            assert!(!policy.allowed(path), "{path}");
        }
        for path in [
            "openblog.json",
            "content/posts/draft.md",
            "content/posts/draft.credits.json",
            "static/images/uploads/2026/cover.png",
            "static/tracks/uploads/2026/trip.gpx",
            ".openblog/private/context/site.md",
            ".openblog/private/research/sources.json",
            ".openblog/private/research/notebook.json",
            ".openblog/private/research/atlas.json",
            ".openblog/private/research/claims.json",
            ".openblog/private/research/alignments.json",
            ".openblog/private/research/selections.json",
            ".openblog/private/research/acknowledgements.json",
            ".openblog/private/admin-preferences/0000000000000000000000000000000000000000000000000000000000000000.json",
            ".openblog/pending-tracks/0000000000000000000000000000000000000000000000000000000000000000.gpx",
            ".openblog/trash/deleted.md",
        ] {
            assert!(policy.allowed(path), "{path}");
        }
    }

    #[test]
    fn source_library_is_durable_and_allowed_up_to_the_library_limit() {
        let fixture = Fixture::new();
        let library = fixture.0.join(LIBRARY_PATH);
        fs::create_dir_all(library.parent().unwrap()).unwrap();
        let body = format!("{{\"pad\":\"{}\"}}", "x".repeat(3 * 1024 * 1024));
        fs::write(&library, &body).unwrap();
        let policy = policy();
        assert_eq!(policy.text_limit("content/posts/a.md"), MAX_TEXT);
        assert_eq!(
            policy.text_limit(ACKNOWLEDGEMENTS_PATH),
            2 * 1024 * 1024,
            "acknowledgements keep their own 2 MiB limit"
        );
        let files = policy.scan(&fixture.0).unwrap();
        assert_eq!(files[LIBRARY_PATH], body.as_bytes());
        fs::write(&library, "x".repeat(MAX_LIBRARY_TEXT + 1)).unwrap();
        assert!(policy.scan(&fixture.0).is_err());
        let mut workspace =
            fixture.workspace(backend("http://127.0.0.1:1".into()), Manifest::new());
        workspace.manifest.insert(
            LIBRARY_PATH.into(),
            Entry {
                base: None,
                value: Some(Record::Text {
                    text: "{\"sources\":[]}".into(),
                }),
            },
        );
        fs::remove_file(&library).unwrap();
        workspace.restore(&fixture.0).unwrap();
        assert_eq!(fs::read_to_string(&library).unwrap(), "{\"sources\":[]}");
    }

    #[test]
    fn research_notebook_is_durable_and_allowed_up_to_the_notebook_limit() {
        let fixture = Fixture::new();
        let notebook = fixture.0.join(NOTEBOOK_PATH);
        fs::create_dir_all(notebook.parent().unwrap()).unwrap();
        let body = format!("{{\"pad\":\"{}\"}}", "x".repeat(3 * 1024 * 1024));
        fs::write(&notebook, &body).unwrap();
        let policy = policy();
        assert_eq!(policy.text_limit(NOTEBOOK_PATH), MAX_LIBRARY_TEXT);
        let files = policy.scan(&fixture.0).unwrap();
        assert_eq!(files[NOTEBOOK_PATH], body.as_bytes());
        fs::write(&notebook, "x".repeat(MAX_LIBRARY_TEXT + 1)).unwrap();
        assert!(policy.scan(&fixture.0).is_err());
    }

    #[test]
    fn knowledge_atlas_is_durable_and_allowed_up_to_the_library_limit() {
        let fixture = Fixture::new();
        let atlas = fixture.0.join(ATLAS_PATH);
        fs::create_dir_all(atlas.parent().unwrap()).unwrap();
        let body = format!("{{\"pad\":\"{}\"}}", "x".repeat(3 * 1024 * 1024));
        fs::write(&atlas, &body).unwrap();
        let policy = policy();
        assert_eq!(policy.text_limit(ATLAS_PATH), MAX_LIBRARY_TEXT);
        let files = policy.scan(&fixture.0).unwrap();
        assert_eq!(files[ATLAS_PATH], body.as_bytes());
        fs::write(&atlas, "x".repeat(MAX_LIBRARY_TEXT + 1)).unwrap();
        assert!(policy.scan(&fixture.0).is_err());
    }

    #[test]
    fn alignments_file_is_durable_and_allowed_up_to_the_library_limit() {
        let fixture = Fixture::new();
        let alignments = fixture.0.join(ALIGNMENTS_PATH);
        fs::create_dir_all(alignments.parent().unwrap()).unwrap();
        let body = format!("{{\"pad\":\"{}\"}}", "x".repeat(3 * 1024 * 1024));
        fs::write(&alignments, &body).unwrap();
        let policy = policy();
        assert!(policy.allowed(ALIGNMENTS_PATH));
        assert_eq!(policy.text_limit(ALIGNMENTS_PATH), MAX_LIBRARY_TEXT);
        let files = policy.scan(&fixture.0).unwrap();
        assert_eq!(files[ALIGNMENTS_PATH], body.as_bytes());
        fs::write(&alignments, "x".repeat(MAX_LIBRARY_TEXT + 1)).unwrap();
        assert!(policy.scan(&fixture.0).is_err());
    }

    #[test]
    fn selections_file_is_durable_and_allowed_up_to_the_library_limit() {
        let fixture = Fixture::new();
        let selections = fixture.0.join(SELECTIONS_PATH);
        fs::create_dir_all(selections.parent().unwrap()).unwrap();
        let body = format!("{{\"pad\":\"{}\"}}", "x".repeat(3 * 1024 * 1024));
        fs::write(&selections, &body).unwrap();
        let policy = policy();
        assert!(policy.allowed(SELECTIONS_PATH));
        assert!(policy.roots().iter().any(|root| root == SELECTIONS_PATH));
        assert_eq!(policy.text_limit(SELECTIONS_PATH), MAX_LIBRARY_TEXT);
        let files = policy.scan(&fixture.0).unwrap();
        assert_eq!(files[SELECTIONS_PATH], body.as_bytes());
        fs::write(&selections, "x".repeat(MAX_LIBRARY_TEXT + 1)).unwrap();
        assert!(policy.scan(&fixture.0).is_err());
        // A lock or an interrupted write beside it is never persisted.
        for beside in [".lock", ".1-2.tmp", "/extra"] {
            assert!(
                !policy.allowed(&format!("{SELECTIONS_PATH}{beside}")),
                "{beside}"
            );
        }
    }

    #[test]
    fn claims_file_is_durable_and_allowed_up_to_the_library_limit() {
        let fixture = Fixture::new();
        let claims = fixture.0.join(CLAIMS_PATH);
        fs::create_dir_all(claims.parent().unwrap()).unwrap();
        let body = format!("{{\"pad\":\"{}\"}}", "x".repeat(3 * 1024 * 1024));
        fs::write(&claims, &body).unwrap();
        let policy = policy();
        assert_eq!(policy.text_limit(CLAIMS_PATH), MAX_LIBRARY_TEXT);
        let files = policy.scan(&fixture.0).unwrap();
        assert_eq!(files[CLAIMS_PATH], body.as_bytes());
        fs::write(&claims, "x".repeat(MAX_LIBRARY_TEXT + 1)).unwrap();
        assert!(policy.scan(&fixture.0).is_err());
    }

    #[test]
    fn restore_preserves_upstream_and_unacknowledged_local_edits() {
        let base = "old".to_string();
        let desired = "draft".to_string();
        let upstream = "new".to_string();
        assert!(check_restore(
            "post",
            Some(&base),
            Some(&desired),
            Some(&base),
            Some(&base)
        )
        .is_ok());
        assert!(check_restore(
            "post",
            Some(&base),
            Some(&desired),
            Some(&desired),
            Some(&desired)
        )
        .is_ok());
        assert!(check_restore(
            "post",
            Some(&base),
            Some(&desired),
            Some(&upstream),
            Some(&upstream)
        )
        .is_err());
        assert!(check_restore(
            "post",
            Some(&base),
            Some(&desired),
            Some(&base),
            Some(&upstream)
        )
        .is_err());
        assert!(check_restore("post", Some(&base), None, Some(&base), Some(&base)).is_ok());
        assert!(check_restore("post", None, Some(&desired), None, None).is_ok());
        assert!(check_restore("post", None, Some(&desired), None, Some(&upstream)).is_err());
    }

    #[test]
    fn configuration_rejects_inline_secrets_and_layout_changes() {
        let p = policy();
        assert!(p.validate_config(br#"{"title":"My blog"}"#).is_ok());
        assert!(p.validate_config(br#"{"apiKey":"secret"}"#).is_err());
        assert!(p
            .validate_config(br#"{"knowledgeChecks":{"apiKey":"secret"}}"#)
            .is_err());
        assert!(p
            .validate_config(br#"{"paths":{"content":"other"}}"#)
            .is_err());
        assert!(p
            .validate_config(br#"{"admin":{"usersFile":"content/posts/users.json"}}"#)
            .is_err());
    }

    #[test]
    fn bounded_responses_reject_oversized_data() {
        assert_eq!(read_bounded(&b"1234"[..], 4).unwrap(), b"1234");
        assert!(read_bounded(&b"12345"[..], 4).is_err());
    }

    #[test]
    fn restores_drafts_settings_sidecars_private_context_and_deletions_as_one_bundle() {
        let fixture = Fixture::new();
        let mut workspace =
            fixture.workspace(backend("http://127.0.0.1:1".into()), Manifest::new());
        let mut add = |path: &str, text: Option<&str>| {
            workspace.manifest.insert(
                path.into(),
                Entry {
                    base: workspace.base.get(path).cloned(),
                    value: text.map(|text| Record::Text { text: text.into() }),
                },
            );
        };
        add("content/posts/old.md", Some("unpublished edit"));
        add("content/posts/draft.md", Some("new draft"));
        add(
            "content/posts/draft.credits.json",
            Some(r#"{"credits":[]}"#),
        );
        add(
            ".openblog/private/context/site.md",
            Some("private author notes"),
        );
        add("openblog.json", Some(r#"{"title":"Unpublished settings"}"#));
        add("content/posts/delete.md", None);
        workspace.restore(&fixture.0).unwrap();
        assert_eq!(
            fs::read_to_string(fixture.0.join("content/posts/old.md")).unwrap(),
            "unpublished edit"
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("content/posts/draft.credits.json")).unwrap(),
            r#"{"credits":[]}"#
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join(".openblog/private/context/site.md")).unwrap(),
            "private author notes"
        );
        assert!(!fixture.0.join("content/posts/delete.md").exists());
        assert!(crate::site::load_config(&fixture.0)
            .unwrap()
            .title
            .contains("Unpublished"));
        // An interrupted restore can safely be applied again.
        workspace.restore(&fixture.0).unwrap();
    }

    #[test]
    fn restore_conflict_preflight_never_partially_applies_a_bundle() {
        let fixture = Fixture::new();
        let mut workspace =
            fixture.workspace(backend("http://127.0.0.1:1".into()), Manifest::new());
        workspace.manifest.insert(
            "content/posts/a-new.md".into(),
            Entry {
                base: None,
                value: Some(Record::Text {
                    text: "draft".into(),
                }),
            },
        );
        workspace.manifest.insert(
            "content/posts/old.md".into(),
            Entry {
                base: Some("0".repeat(40)),
                value: Some(Record::Text {
                    text: "conflicting edit".into(),
                }),
            },
        );
        assert!(workspace
            .restore(&fixture.0)
            .unwrap_err()
            .contains("conflict"));
        assert!(!fixture.0.join("content/posts/a-new.md").exists());
        assert_eq!(
            fs::read_to_string(fixture.0.join("content/posts/old.md")).unwrap(),
            "published"
        );
    }

    #[test]
    fn restores_private_upload_and_checks_its_integrity() {
        let fixture = Fixture::new();
        let bytes = b"private image bytes".to_vec();
        let (backend, server) = response_once(200, bytes.clone());
        let manifest = BTreeMap::from([(
            "static/images/uploads/2026/photo.png".into(),
            Entry {
                base: None,
                value: Some(Record::Blob {
                    sha256: digest(&bytes),
                    size: bytes.len(),
                }),
            },
        )]);
        let mut workspace = fixture.workspace(backend, manifest);
        workspace.restore(&fixture.0).unwrap();
        server.join().unwrap();
        assert_eq!(
            fs::read(fixture.0.join("static/images/uploads/2026/photo.png")).unwrap(),
            bytes
        );
    }

    #[test]
    fn stale_revision_blocks_mutation_before_any_local_write() {
        let fixture = Fixture::new();
        let (backend, server) = response_once(200, br#"{"revision":2,"manifest":{}}"#.to_vec());
        let mut workspace = fixture.workspace(backend, Manifest::new());
        assert!(workspace.begin().unwrap_err().contains("stale"));
        server.join().unwrap();
        assert!(workspace.begin().unwrap_err().contains("blocked"));
        assert_eq!(
            fs::read_to_string(fixture.0.join("content/posts/old.md")).unwrap(),
            "published"
        );
    }

    #[test]
    fn failed_commit_is_not_acknowledged_and_blocks_later_writes() {
        let fixture = Fixture::new();
        let (backend, server) = response_once(500, b"unavailable".to_vec());
        let mut workspace = fixture.workspace(backend, Manifest::new());
        fs::write(fixture.0.join("content/posts/old.md"), "unacknowledged").unwrap();
        assert!(workspace
            .save(&fixture.0)
            .unwrap_err()
            .contains("NOT acknowledged"));
        let request: serde_json::Value = serde_json::from_slice(&server.join().unwrap()).unwrap();
        assert_eq!(request["p_revision"], 1);
        assert_eq!(workspace.revision, 1);
        assert!(workspace.manifest.is_empty());
        assert!(workspace.begin().unwrap_err().contains("blocked"));
    }

    #[test]
    fn successful_save_atomically_acknowledges_revision_and_keeps_untracked_tombstones() {
        let fixture = Fixture::new();
        let (backend, server) = response_once(200, b"2".to_vec());
        let manifest = BTreeMap::from([(
            ".openblog/private/context/site.md".into(),
            Entry {
                base: None,
                value: Some(Record::Text {
                    text: "deleted private notes".into(),
                }),
            },
        )]);
        let mut workspace = fixture.workspace(backend, manifest);
        fs::write(fixture.0.join("content/posts/old.md"), "durable draft").unwrap();
        workspace.save(&fixture.0).unwrap();
        let request: serde_json::Value = serde_json::from_slice(&server.join().unwrap()).unwrap();
        assert_eq!(
            request["p_manifest"]["content/posts/old.md"]["value"]["text"],
            "durable draft"
        );
        assert!(request["p_manifest"][".openblog/private/context/site.md"]["value"].is_null());
        assert_eq!(workspace.revision, 2);
        assert!(workspace.manifest[".openblog/private/context/site.md"]
            .value
            .is_none());
    }

    #[test]
    fn admin_save_failure_returns_503_and_does_not_silently_fall_back_to_disk() {
        let fixture = Fixture::new();
        let (backend, server) = response_sequence(vec![
            (200, br#"{"revision":1,"manifest":{}}"#.to_vec()),
            (500, b"database unavailable".to_vec()),
        ]);
        let workspace = fixture.workspace(backend, Manifest::new());
        let mut users = crate::auth::Users::default();
        users.set("author", "correct horse battery").unwrap();
        users.save(&fixture.0.join(".openblog/users.json")).unwrap();
        let mut state = crate::admin::AppState::new(fixture.0.clone(), None, false, true);
        state.workspace_enabled = true;
        state.workspace = std::sync::Mutex::new(Some(workspace));
        let (token, session) = state
            .sessions
            .lock()
            .unwrap()
            .create(
                "author",
                &users.find("author").unwrap().hash,
                Duration::from_secs(60),
            )
            .unwrap();
        let snapshot = crate::admin_preferences::load(&fixture.0, "author").unwrap();
        let mut request = crate::http::Request {
            method: "PUT".into(),
            path: "/admin/api/preferences".into(),
            body: serde_json::to_vec(&serde_json::json!({
                "etag": snapshot.etag, "preferences": snapshot.preferences,
            }))
            .unwrap(),
            ..Default::default()
        };
        request
            .headers
            .insert("cookie".into(), format!("ob_session={token}"));
        request.headers.insert("x-csrf-token".into(), session.csrf);
        request
            .headers
            .insert("content-type".into(), "application/json".into());
        let response = crate::admin::handle(&state, &request);
        assert_eq!(
            response.status,
            503,
            "{}",
            String::from_utf8_lossy(&response.body)
        );
        assert!(String::from_utf8_lossy(&response.body).contains("NOT acknowledged"));
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        let stored = String::from_utf8_lossy(&requests[1]);
        assert!(stored.contains("admin-preferences"));
        assert!(!stored.contains("users.json"));
        assert!(!stored.contains(&users.find("author").unwrap().hash));
        assert!(
            crate::admin_preferences::load(&fixture.0, "author")
                .unwrap()
                .stored
        );
        assert_eq!(crate::admin::handle(&state, &request).status, 503);
        assert!(!fixture
            .0
            .join(".openblog/content-transaction.lock")
            .exists());
    }

    #[test]
    fn local_commit_does_not_clear_overlay_but_successful_push_does() {
        let fixture = Fixture::new();
        let git = crate::git::Git::new(&fixture.0);
        git.run(&["branch", "-M", "main"]).unwrap();
        let remote = fixture.0.join(".git/test-remote");
        git.run(&["init", "--bare", "-q", remote.to_str().unwrap()])
            .unwrap();
        git.run(&["remote", "add", "origin", remote.to_str().unwrap()])
            .unwrap();
        git.run(&["push", "-qu", "origin", "main"]).unwrap();
        let (backend, server) = response_sequence(vec![(200, b"2".to_vec()), (200, b"3".to_vec())]);
        let mut workspace = fixture.workspace(backend, Manifest::new());
        fs::write(fixture.0.join("content/posts/old.md"), "pending publish").unwrap();
        workspace.save(&fixture.0).unwrap();
        git.run(&["add", "content/posts/old.md"]).unwrap();
        git.run(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "local only",
        ])
        .unwrap();
        workspace.save(&fixture.0).unwrap();
        assert!(workspace.manifest.contains_key("content/posts/old.md"));
        // Even a new process must compare against the published remote ref,
        // not mistake a failed push's local commit for published content.
        assert_ne!(
            baseline(&fixture.0, &workspace.policy).unwrap()["content/posts/old.md"],
            git_hash(&fixture.0, b"pending publish").unwrap()
        );
        git.run(&["push", "-q", "origin", "main"]).unwrap();
        workspace.published(&fixture.0).unwrap();
        workspace.save(&fixture.0).unwrap();
        assert!(!workspace.manifest.contains_key("content/posts/old.md"));
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(workspace.revision, 3);
    }

    #[test]
    fn mock_supabase_restart_round_trip_restores_private_draft_upload_deletion_and_unrelated_git_commit(
    ) {
        let fixture = Fixture::new();
        let supabase = MockSupabase::new();
        let key = "sb_secret_mock_workspace_not_a_real_key";
        let mut workspace =
            Workspace::restore_with_backend(&fixture.0, supabase.backend(key)).unwrap();
        fs::write(
            fixture.0.join("content/posts/draft.md"),
            "private unpublished draft",
        )
        .unwrap();
        fs::write(
            fixture.0.join("content/posts/draft.credits.json"),
            r#"{"credits":[]}"#,
        )
        .unwrap();
        fs::create_dir_all(fixture.0.join(".openblog/private/context")).unwrap();
        fs::write(
            fixture.0.join(".openblog/private/context/site.md"),
            "private draft context",
        )
        .unwrap();
        fs::create_dir_all(fixture.0.join("static/images/uploads/2026")).unwrap();
        let image = b"\x89PNG\r\n\x1a\nprivate upload";
        fs::write(
            fixture.0.join("static/images/uploads/2026/private.png"),
            image,
        )
        .unwrap();
        fs::remove_file(fixture.0.join("content/posts/delete.md")).unwrap();
        workspace.begin().unwrap();
        workspace.save(&fixture.0).unwrap();
        assert_eq!(supabase.data.lock().unwrap().revision, 1);
        drop(workspace);

        // Simulate an ephemeral checkout, then a new deployment with an
        // unrelated upstream commit. No runtime memory survives this point.
        for path in [
            "content/posts/draft.md",
            "content/posts/draft.credits.json",
            ".openblog/private/context/site.md",
            "static/images/uploads/2026/private.png",
        ] {
            fs::remove_file(fixture.0.join(path)).unwrap();
        }
        let git = crate::git::Git::new(&fixture.0);
        git.run(&["checkout", "--", "content/posts/delete.md"])
            .unwrap();
        fs::write(
            fixture.0.join("README.md"),
            "unrelated new published content",
        )
        .unwrap();
        git.run(&["add", "README.md"]).unwrap();
        git.run(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "unrelated upstream",
        ])
        .unwrap();
        let restored = Workspace::restore_with_backend(&fixture.0, supabase.backend(key)).unwrap();
        assert_eq!(restored.revision, 1);
        assert_eq!(
            fs::read_to_string(fixture.0.join("content/posts/draft.md")).unwrap(),
            "private unpublished draft"
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join(".openblog/private/context/site.md")).unwrap(),
            "private draft context"
        );
        assert!(fixture.0.join("content/posts/draft.credits.json").exists());
        assert!(!fixture.0.join("content/posts/delete.md").exists());
        assert_eq!(
            fs::read(fixture.0.join("static/images/uploads/2026/private.png")).unwrap(),
            image
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("README.md")).unwrap(),
            "unrelated new published content"
        );
        supabase.assert_auth(key, false);
        let requests = &supabase.data.lock().unwrap().requests;
        assert!(requests
            .iter()
            .any(|(path, _)| path.starts_with("POST /storage/")));
        assert!(requests
            .iter()
            .any(|(path, _)| path.starts_with("GET /storage/")));
    }

    #[test]
    fn mock_supabase_commit_cas_rejects_writer_that_passed_a_stale_precheck() {
        let fixture = Fixture::new();
        let supabase = MockSupabase::new();
        let key = "legacy.mock.jwt";
        let mut first = Workspace::restore_with_backend(&fixture.0, supabase.backend(key)).unwrap();
        let mut second =
            Workspace::restore_with_backend(&fixture.0, supabase.backend(key)).unwrap();
        first.begin().unwrap();
        second.begin().unwrap();
        fs::write(fixture.0.join("content/posts/old.md"), "first durable save").unwrap();
        first.save(&fixture.0).unwrap();
        fs::write(fixture.0.join("content/posts/old.md"), "second stale save").unwrap();
        assert!(second
            .save(&fixture.0)
            .unwrap_err()
            .contains("NOT acknowledged"));
        assert!(second.begin().unwrap_err().contains("blocked"));
        let database = supabase.data.lock().unwrap();
        assert_eq!(database.revision, 1);
        assert_eq!(
            database.manifest["content/posts/old.md"].value,
            Some(Record::Text {
                text: "first durable save".into()
            })
        );
        drop(database);
        supabase.assert_auth(key, true);
    }

    #[test]
    fn mock_supabase_failed_commit_and_upload_never_advance_durable_manifest() {
        for fail_upload in [false, true] {
            let fixture = Fixture::new();
            let supabase = MockSupabase::new();
            let mut workspace = Workspace::restore_with_backend(
                &fixture.0,
                supabase.backend("sb_secret_failure_test_not_real"),
            )
            .unwrap();
            fs::write(
                fixture.0.join("content/posts/old.md"),
                "unacknowledged draft",
            )
            .unwrap();
            fs::create_dir_all(fixture.0.join("static/images/uploads/2026")).unwrap();
            fs::write(
                fixture.0.join("static/images/uploads/2026/image.png"),
                b"upload",
            )
            .unwrap();
            {
                let mut data = supabase.data.lock().unwrap();
                data.fail_upload = fail_upload;
                data.fail_commit = !fail_upload;
            }
            assert!(workspace
                .save(&fixture.0)
                .unwrap_err()
                .contains("NOT acknowledged"));
            assert_eq!(workspace.revision, 0);
            assert!(workspace.begin().unwrap_err().contains("blocked"));
            assert_eq!(
                fs::read_to_string(fixture.0.join("content/posts/old.md")).unwrap(),
                "unacknowledged draft"
            );
            let database = supabase.data.lock().unwrap();
            assert_eq!(database.revision, 0);
            assert!(database.manifest.is_empty());
            assert_eq!(database.blobs.len(), usize::from(!fail_upload));
        }
    }

    #[test]
    fn mock_supabase_restart_conflict_preserves_new_upstream_same_file() {
        let fixture = Fixture::new();
        let supabase = MockSupabase::new();
        let key = "sb_secret_upstream_conflict_not_real";
        let mut workspace =
            Workspace::restore_with_backend(&fixture.0, supabase.backend(key)).unwrap();
        fs::write(
            fixture.0.join("content/posts/old.md"),
            "durable unpublished version",
        )
        .unwrap();
        workspace.save(&fixture.0).unwrap();
        drop(workspace);
        fs::write(
            fixture.0.join("content/posts/old.md"),
            "different upstream published version",
        )
        .unwrap();
        let git = crate::git::Git::new(&fixture.0);
        git.run(&["add", "content/posts/old.md"]).unwrap();
        git.run(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "upstream conflict",
        ])
        .unwrap();
        let error = Workspace::restore_with_backend(&fixture.0, supabase.backend(key))
            .err()
            .unwrap();
        assert!(error.contains("restore conflict"));
        assert_eq!(
            fs::read_to_string(fixture.0.join("content/posts/old.md")).unwrap(),
            "different upstream published version"
        );
        assert_eq!(supabase.data.lock().unwrap().revision, 1);
    }

    #[test]
    fn mock_supabase_failed_git_push_keeps_local_commit_durable_across_restart() {
        let fixture = Fixture::new();
        let git = crate::git::Git::new(&fixture.0);
        git.run(&["branch", "-M", "main"]).unwrap();
        git.run(&["config", "user.name", "Test"]).unwrap();
        git.run(&["config", "user.email", "test@example.invalid"])
            .unwrap();
        let remote = fixture.0.join(".git/test-remote");
        git.run(&["init", "--bare", "-q", remote.to_str().unwrap()])
            .unwrap();
        git.run(&["remote", "add", "origin", remote.to_str().unwrap()])
            .unwrap();
        git.run(&["push", "-qu", "origin", "main"]).unwrap();
        let hook = remote.join("hooks/pre-receive");
        fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let supabase = MockSupabase::new();
        let key = "sb_secret_git_push_failure_not_real";
        let mut workspace =
            Workspace::restore_with_backend(&fixture.0, supabase.backend(key)).unwrap();
        fs::write(
            fixture.0.join("content/posts/old.md"),
            "unpublished edit before rejected push",
        )
        .unwrap();
        workspace.save(&fixture.0).unwrap();
        let before = git.run(&["rev-parse", "HEAD"]).unwrap();
        let config = crate::site::load_config(&fixture.0).unwrap();
        assert!(
            crate::publish::publish(&fixture.0, &config, Some("reject this push"))
                .unwrap_err()
                .contains("push failed")
        );
        assert_ne!(git.run(&["rev-parse", "HEAD"]).unwrap(), before);
        workspace.save(&fixture.0).unwrap();
        assert!(workspace.manifest.contains_key("content/posts/old.md"));
        drop(workspace);
        // A fresh checkout has only the remote's version; the local-only
        // commit is deliberately not considered the published baseline.
        git.run(&["checkout", "-q", "--detach", "origin/main"])
            .unwrap();
        let restored = Workspace::restore_with_backend(&fixture.0, supabase.backend(key)).unwrap();
        assert_eq!(
            fs::read_to_string(fixture.0.join("content/posts/old.md")).unwrap(),
            "unpublished edit before rejected push"
        );
        assert!(restored.manifest.contains_key("content/posts/old.md"));
        assert_eq!(supabase.data.lock().unwrap().revision, 1);
        supabase.assert_auth(key, false);
    }

    #[test]
    fn unauthenticated_and_csrf_rejected_mutations_never_contact_supabase() {
        let fixture = Fixture::new();
        let supabase = MockSupabase::new();
        let workspace = fixture.workspace(
            supabase.backend("sb_secret_auth_test_not_real"),
            Manifest::new(),
        );
        let mut users = crate::auth::Users::default();
        users.set("author", "correct horse battery").unwrap();
        users.save(&fixture.0.join(".openblog/users.json")).unwrap();
        let mut state = crate::admin::AppState::new(fixture.0.clone(), None, false, true);
        state.workspace_enabled = true;
        state.workspace = std::sync::Mutex::new(Some(workspace));
        let mut request = crate::http::Request {
            method: "POST".into(),
            path: "/admin/api/upload".into(),
            body: b"\x89PNG\r\n\x1a\nimage".to_vec(),
            ..Default::default()
        };
        assert_eq!(
            crate::admin::preflight(&state, &request)
                .unwrap_err()
                .status,
            401
        );
        assert_eq!(crate::admin::handle(&state, &request).status, 401);
        let (token, _) = state
            .sessions
            .lock()
            .unwrap()
            .create(
                "author",
                &users.find("author").unwrap().hash,
                Duration::from_secs(60),
            )
            .unwrap();
        request
            .headers
            .insert("cookie".into(), format!("ob_session={token}"));
        assert_eq!(crate::admin::handle(&state, &request).status, 403);
        assert!(supabase.data.lock().unwrap().requests.is_empty());
        assert!(!fixture.0.join("static/images/uploads").exists());
        assert!(!fixture
            .0
            .join(".openblog/content-transaction.lock")
            .exists());
    }

    #[test]
    fn authenticated_upload_returns_success_only_after_private_blob_and_manifest_commit() {
        let fixture = Fixture::new();
        let supabase = MockSupabase::new();
        let key = "sb_secret_admin_upload_not_real";
        let workspace = Workspace::restore_with_backend(&fixture.0, supabase.backend(key)).unwrap();
        let mut users = crate::auth::Users::default();
        users.set("author", "correct horse battery").unwrap();
        users.save(&fixture.0.join(".openblog/users.json")).unwrap();
        let mut state = crate::admin::AppState::new(fixture.0.clone(), None, false, true);
        state.workspace_enabled = true;
        state.workspace = std::sync::Mutex::new(Some(workspace));
        let (token, session) = state
            .sessions
            .lock()
            .unwrap()
            .create(
                "author",
                &users.find("author").unwrap().hash,
                Duration::from_secs(60),
            )
            .unwrap();
        let mut request = crate::http::Request {
            method: "POST".into(),
            path: "/admin/api/upload".into(),
            body: b"\x89PNG\r\n\x1a\nimage".to_vec(),
            ..Default::default()
        };
        request
            .headers
            .insert("cookie".into(), format!("ob_session={token}"));
        request.headers.insert("x-csrf-token".into(), session.csrf);
        let response = crate::admin::handle(&state, &request);
        assert_eq!(
            response.status,
            201,
            "{}",
            String::from_utf8_lossy(&response.body)
        );
        let data = supabase.data.lock().unwrap();
        assert_eq!(data.revision, 1);
        assert_eq!(data.blobs.len(), 1);
        assert_eq!(data.manifest.len(), 1);
        assert!(data.requests[data.requests.len() - 2]
            .0
            .starts_with("POST /storage/"));
        assert!(data
            .requests
            .last()
            .unwrap()
            .0
            .starts_with("POST /rest/v1/rpc/openblog_workspace_commit"));
        drop(data);
        supabase.assert_auth(key, false);
    }

    #[test]
    fn auto_publish_push_retires_overlay_through_workspace_gate() {
        let fixture = Fixture::new();
        fs::write(
            fixture.0.join("openblog.json"),
            r#"{"title":"Workspace","publish":{"auto":true}}"#,
        )
        .unwrap();
        let git = crate::git::Git::new(&fixture.0);
        git.run(&["branch", "-M", "main"]).unwrap();
        git.run(&["config", "user.name", "Test"]).unwrap();
        git.run(&["config", "user.email", "test@example.invalid"])
            .unwrap();
        git.run(&["add", "openblog.json"]).unwrap();
        git.run(&["commit", "-qm", "enable auto publishing"])
            .unwrap();
        let remote = fixture.0.join(".git/test-remote");
        git.run(&["init", "--bare", "-q", remote.to_str().unwrap()])
            .unwrap();
        git.run(&["remote", "add", "origin", remote.to_str().unwrap()])
            .unwrap();
        git.run(&["push", "-qu", "origin", "main"]).unwrap();
        let supabase = MockSupabase::new();
        let key = "sb_secret_auto_publish_not_real";
        let mut workspace =
            Workspace::restore_with_backend(&fixture.0, supabase.backend(key)).unwrap();
        fs::write(
            fixture.0.join("content/posts/old.md"),
            "automatically published",
        )
        .unwrap();
        workspace.save(&fixture.0).unwrap();
        let mut state = crate::admin::AppState::new(fixture.0.clone(), None, false, true);
        state.workspace_enabled = true;
        state.workspace = std::sync::Mutex::new(Some(workspace));
        let state = std::sync::Arc::new(state);
        state.auto_publish("auto durability test".into());
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if supabase.data.lock().unwrap().revision == 2 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "auto publish did not acknowledge durable revision"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        // Acquiring the gate also waits for the background operation to finish.
        let workspace = state.workspace.lock().unwrap();
        assert!(workspace.as_ref().unwrap().manifest.is_empty());
        assert!(supabase.data.lock().unwrap().manifest.is_empty());
        assert_eq!(
            git.run(&["rev-parse", "HEAD"]).unwrap(),
            git.run(&["rev-parse", "origin/main"]).unwrap()
        );
        supabase.assert_auth(key, false);
    }

    #[test]
    fn startup_fetches_and_fast_forwards_old_checkout_before_restoring() {
        let fixture = Fixture::new();
        let git = crate::git::Git::new(&fixture.0);
        git.run(&["branch", "-M", "main"]).unwrap();
        let initial = git.run(&["rev-parse", "HEAD"]).unwrap();
        let remote = fixture.0.join(".git/test-remote");
        git.run(&["init", "--bare", "-q", remote.to_str().unwrap()])
            .unwrap();
        git.run(&["remote", "add", "origin", remote.to_str().unwrap()])
            .unwrap();
        let supabase = MockSupabase::new();
        let key = "sb_secret_startup_branch_not_real";
        assert!(
            Workspace::restore_with_backend(&fixture.0, supabase.backend(key))
                .err()
                .unwrap()
                .contains("could not fetch")
        );
        assert!(supabase.data.lock().unwrap().requests.is_empty());
        git.run(&["push", "-qu", "origin", "main"]).unwrap();
        fs::write(
            fixture.0.join("content/posts/old.md"),
            "new published content",
        )
        .unwrap();
        git.run(&["add", "content/posts/old.md"]).unwrap();
        git.run(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "new published content",
        ])
        .unwrap();
        git.run(&["push", "-q", "origin", "main"]).unwrap();
        git.run(&["checkout", "-q", initial.trim()]).unwrap();
        git.run(&["update-ref", "-d", "refs/remotes/origin/main"])
            .unwrap();
        fs::write(fixture.0.join("untracked-notes.txt"), "do not discard").unwrap();
        Workspace::restore_with_backend(&fixture.0, supabase.backend(key)).unwrap();
        assert_eq!(
            fs::read_to_string(fixture.0.join("content/posts/old.md")).unwrap(),
            "new published content"
        );
        assert_eq!(
            git.run(&["rev-parse", "HEAD"]).unwrap(),
            git.run(&["rev-parse", "origin/main"]).unwrap()
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("untracked-notes.txt")).unwrap(),
            "do not discard"
        );
    }

    #[test]
    fn startup_configured_remote_branch_preserves_dirty_conflicts_and_rejects_divergence() {
        let fixture = Fixture::new();
        let git = crate::git::Git::new(&fixture.0);
        fs::write(
            fixture.0.join("openblog.json"),
            r#"{"title":"Workspace","publish":{"remote":"editorial","branch":"published"}}"#,
        )
        .unwrap();
        git.run(&["add", "openblog.json"]).unwrap();
        git.run(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "configure custom publishing",
        ])
        .unwrap();
        git.run(&["branch", "-M", "published"]).unwrap();
        let initial = git.run(&["rev-parse", "HEAD"]).unwrap();
        let remote = fixture.0.join(".git/test-remote");
        git.run(&["init", "--bare", "-q", remote.to_str().unwrap()])
            .unwrap();
        git.run(&["remote", "add", "editorial", remote.to_str().unwrap()])
            .unwrap();
        git.run(&["push", "-qu", "editorial", "published"]).unwrap();
        fs::write(fixture.0.join("content/posts/old.md"), "upstream version").unwrap();
        git.run(&["add", "content/posts/old.md"]).unwrap();
        git.run(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "upstream update",
        ])
        .unwrap();
        git.run(&["push", "-q", "editorial", "published"]).unwrap();
        git.run(&["checkout", "-q", "--detach", initial.trim()])
            .unwrap();
        fs::write(
            fixture.0.join("content/posts/old.md"),
            "dirty local version",
        )
        .unwrap();
        let supabase = MockSupabase::new();
        let key = "sb_secret_dirty_checkout_not_real";
        assert!(
            Workspace::restore_with_backend(&fixture.0, supabase.backend(key))
                .err()
                .unwrap()
                .contains("fast-forward failed")
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("content/posts/old.md")).unwrap(),
            "dirty local version"
        );
        assert_eq!(git.run(&["rev-parse", "HEAD"]).unwrap(), initial);
        assert!(supabase.data.lock().unwrap().requests.is_empty());
        git.run(&["add", "content/posts/old.md"]).unwrap();
        git.run(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "preserve local work",
        ])
        .unwrap();
        let divergent = git.run(&["rev-parse", "HEAD"]).unwrap();
        assert!(
            Workspace::restore_with_backend(&fixture.0, supabase.backend(key))
                .err()
                .unwrap()
                .contains("cannot fast-forward HEAD")
        );
        assert_eq!(git.run(&["rev-parse", "HEAD"]).unwrap(), divergent);
        assert_eq!(
            fs::read_to_string(fixture.0.join("content/posts/old.md")).unwrap(),
            "dirty local version"
        );
        assert!(supabase.data.lock().unwrap().requests.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_even_when_they_point_inside_the_project() {
        let fixture = Fixture::new();
        std::os::unix::fs::symlink(
            fixture.0.join("content/posts/old.md"),
            fixture.0.join("content/posts/linked.md"),
        )
        .unwrap();
        assert!(policy().scan(&fixture.0).unwrap_err().contains("symlink"));
        assert!(policy()
            .target(&fixture.0, "content/posts/linked.md")
            .unwrap_err()
            .contains("symlink"));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_directory_junctions() {
        let fixture = Fixture::new();
        let target = fixture.0.join("content/pages");
        let junction = fixture.0.join("content/posts/junction");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("page.md"), "private").unwrap();
        let script = format!(
            "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path '{}' -Target '{}' | Out-Null",
            junction.display().to_string().replace('\'', "''"),
            target.display().to_string().replace('\'', "''"),
        );
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let scan = policy().scan(&fixture.0);
        let resolved = policy().target(&fixture.0, "content/posts/junction/page.md");
        fs::remove_dir(junction).unwrap();
        assert!(scan.unwrap_err().contains("symlink"));
        assert!(resolved.unwrap_err().contains("symlink"));
    }
}
