use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_FILE_BYTES: usize = 64 * 1024;
/// Largest accepted `PUT /admin/api/preferences` body.
pub const MAX_REQUEST_BYTES: usize = 16 * 1024;
pub const OPTIONAL_MODULES: [&str; 11] = [
    "social",
    "release",
    "field",
    "optimize",
    "accessibility",
    "evidence",
    // The research workspace's place in the main navigation (ADR 0120).
    "research",
    "assistant",
    "analytics",
    "contributors",
    "public-site",
];

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspacePreset {
    Simple,
    Guided,
    Advanced,
    Custom,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceDensity {
    Comfortable,
    Compact,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EditorMode {
    Visual,
    Markdown,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Preferences {
    pub schema_version: u32,
    pub preset: WorkspacePreset,
    pub density: WorkspaceDensity,
    pub editor_mode: EditorMode,
    pub module_order: Vec<String>,
    pub hidden_modules: Vec<String>,
    /// Whether this admin dismissed the one-time invitation to the Voice view (ADR 0277). Absent until
    /// dismissed, so a file written before the invitation existed is read unchanged and one that never
    /// dismissed it is written without the key.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub voice_invitation_dismissed: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            preset: WorkspacePreset::Simple,
            density: WorkspaceDensity::Comfortable,
            editor_mode: EditorMode::Visual,
            module_order: OPTIONAL_MODULES
                .iter()
                .map(|module| (*module).into())
                .collect(),
            hidden_modules: Vec::new(),
            voice_invitation_dismissed: false,
        }
    }
}

impl Preferences {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != SCHEMA_VERSION {
            return Err("unsupported admin preferences schema version".into());
        }
        if self.module_order.len() != OPTIONAL_MODULES.len() {
            return Err("module order must contain every optional module exactly once".into());
        }
        for module in OPTIONAL_MODULES {
            if self
                .module_order
                .iter()
                .filter(|item| item.as_str() == module)
                .count()
                != 1
            {
                return Err(format!("module order must contain {module} exactly once"));
            }
        }
        for module in &self.hidden_modules {
            if !OPTIONAL_MODULES.contains(&module.as_str()) {
                return Err(format!("unknown optional module: {module}"));
            }
        }
        let mut hidden = self.hidden_modules.clone();
        hidden.sort();
        hidden.dedup();
        if hidden.len() != self.hidden_modules.len() {
            return Err("hidden modules must not contain duplicates".into());
        }
        Ok(())
    }

    /// Stored preferences written by another release may name modules this
    /// release does not know or omit ones it added. Unknown and repeated names
    /// are dropped and missing modules are appended, so every tool stays reachable.
    /// Preferences saved before the research workspace existed showed research
    /// only with Evidence Studio, so a layout that hid Evidence Studio keeps the
    /// research workspace hidden too (ADR 0120).
    fn migrate_modules(mut self) -> Self {
        let knew_research = self.module_order.iter().any(|module| module == "research");
        let mut order: Vec<String> = Vec::with_capacity(OPTIONAL_MODULES.len());
        for module in self.module_order.drain(..) {
            if OPTIONAL_MODULES.contains(&module.as_str()) && !order.contains(&module) {
                order.push(module);
            }
        }
        for module in OPTIONAL_MODULES {
            if !order.iter().any(|item| item == module) {
                order.push(module.into());
            }
        }
        self.module_order = order;
        let mut hidden: Vec<String> = Vec::new();
        for module in self.hidden_modules.drain(..) {
            if OPTIONAL_MODULES.contains(&module.as_str()) && !hidden.contains(&module) {
                hidden.push(module);
            }
        }
        if !knew_research
            && hidden.iter().any(|module| module == "evidence")
            && !hidden.iter().any(|module| module == "research")
        {
            hidden.push("research".into());
        }
        self.hidden_modules = hidden;
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub preferences: Preferences,
    pub etag: String,
    /// False until this admin saves once; the Admin uses it to migrate
    /// browser-local settings from earlier releases exactly once.
    pub stored: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SaveError {
    Conflict,
    Invalid(String),
    Storage(String),
}

impl fmt::Display for SaveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict => write!(formatter, "admin preferences changed in another session"),
            Self::Invalid(message) | Self::Storage(message) => formatter.write_str(message),
        }
    }
}

pub fn preference_path(root: &Path, user: &str) -> Result<PathBuf, String> {
    if user.is_empty() || user.len() > 128 || user.chars().any(char::is_control) {
        return Err("invalid admin identity".into());
    }
    let identity = format!("{:x}", Sha256::digest(user.as_bytes()));
    Ok(root
        .join(".openblog")
        .join("private")
        .join("admin-preferences")
        .join(format!("{identity}.json")))
}

pub fn load(root: &Path, user: &str) -> Result<Snapshot, String> {
    let path = preference_path(root, user)?;
    match read_stored(&path).map_err(StoredError::into_message)? {
        Some(preferences) => snapshot(preferences, true),
        None => snapshot(Preferences::default(), false),
    }
}

/// Why stored preferences could not be used.
enum StoredError {
    /// The file exists but is malformed, invalid, or too large: replaceable.
    Invalid(String),
    /// The file could not be inspected or read (permissions, transient I/O):
    /// it may be valid, so it must not be overwritten blindly.
    Unreadable(String),
}

impl StoredError {
    fn into_message(self) -> String {
        match self {
            Self::Invalid(message) | Self::Unreadable(message) => message,
        }
    }
}

fn read_stored(path: &Path) -> Result<Option<Preferences>, StoredError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(StoredError::Unreadable(format!(
                "could not inspect admin preferences: {error}"
            )))
        }
    };
    if !metadata.is_file() {
        return Err(StoredError::Unreadable(
            "admin preferences path is not a file".into(),
        ));
    }
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err(StoredError::Invalid(
            "admin preferences file is too large".into(),
        ));
    }
    let bytes = fs::read(path).map_err(|error| {
        StoredError::Unreadable(format!("could not read admin preferences: {error}"))
    })?;
    let preferences: Preferences = serde_json::from_slice(&bytes).map_err(|error| {
        StoredError::Invalid(format!("admin preferences are not valid: {error}"))
    })?;
    let preferences = preferences.migrate_modules();
    preferences.validate().map_err(StoredError::Invalid)?;
    Ok(Some(preferences))
}

/// Replaces this admin's preferences when `expected_etag` names the current
/// revision. Malformed, invalid, or oversized stored state has no revision, so
/// a client that could not load it recovers by saving with an empty ETag. A
/// file that could not be read at all is never replaced: it may still be valid.
pub fn save(
    root: &Path,
    user: &str,
    expected_etag: &str,
    preferences: Preferences,
) -> Result<Snapshot, SaveError> {
    preferences.validate().map_err(SaveError::Invalid)?;
    let path = preference_path(root, user).map_err(SaveError::Invalid)?;
    let current_etag = match read_stored(&path) {
        Ok(Some(stored)) => snapshot(stored, true).map_err(SaveError::Storage)?.etag,
        Ok(None) => {
            snapshot(Preferences::default(), false)
                .map_err(SaveError::Storage)?
                .etag
        }
        Err(StoredError::Invalid(_)) => String::new(),
        Err(StoredError::Unreadable(message)) => return Err(SaveError::Storage(message)),
    };
    if current_etag != expected_etag {
        return Err(SaveError::Conflict);
    }
    let parent = path
        .parent()
        .ok_or_else(|| SaveError::Storage("invalid admin preferences path".into()))?;
    fs::create_dir_all(parent).map_err(|error| {
        SaveError::Storage(format!(
            "could not create private preferences directory: {error}"
        ))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(|error| {
            SaveError::Storage(format!(
                "could not protect private preferences directory: {error}"
            ))
        })?;
    }
    let bytes = serde_json::to_vec_pretty(&preferences).map_err(|error| {
        SaveError::Storage(format!("could not encode admin preferences: {error}"))
    })?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(SaveError::Storage(
            "admin preferences file is too large".into(),
        ));
    }

    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let write_result = (|| -> Result<(), std::io::Error> {
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        crate::fsutil::replace_file(&temporary, &path)?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(SaveError::Storage(format!(
            "could not save admin preferences: {error}"
        )));
    }
    snapshot(preferences, true).map_err(SaveError::Storage)
}

fn snapshot(preferences: Preferences, stored: bool) -> Result<Snapshot, String> {
    let canonical = serde_json::to_vec(&preferences)
        .map_err(|error| format!("could not encode admin preferences: {error}"))?;
    Ok(Snapshot {
        preferences,
        etag: format!("{:x}", Sha256::digest(canonical)),
        stored,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("openblog-admin-preferences-{name}-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn defaults_are_simple_but_keep_every_optional_module_reachable() {
        let preferences = Preferences::default();
        assert_eq!(preferences.schema_version, 1);
        assert_eq!(preferences.preset, WorkspacePreset::Simple);
        assert_eq!(preferences.density, WorkspaceDensity::Comfortable);
        assert_eq!(preferences.editor_mode, EditorMode::Visual);
        assert_eq!(preferences.module_order, OPTIONAL_MODULES);
        assert!(preferences.hidden_modules.is_empty());
        preferences.validate().unwrap();
    }

    #[test]
    fn validation_rejects_unknown_duplicate_and_missing_modules() {
        let mut unknown = Preferences::default();
        unknown.module_order[0] = "secrets".into();
        assert!(unknown.validate().is_err());

        let mut duplicate = Preferences::default();
        duplicate.module_order[1] = duplicate.module_order[0].clone();
        assert!(duplicate.validate().is_err());

        let mut missing = Preferences::default();
        missing.module_order.pop();
        assert!(missing.validate().is_err());

        let mut hidden_unknown = Preferences::default();
        hidden_unknown.hidden_modules.push("publish".into());
        assert!(hidden_unknown.validate().is_err());
    }

    #[test]
    fn preferences_are_private_per_user_atomic_and_conflict_safe() {
        let root = fixture("isolation");
        let initial = load(&root, "alice").unwrap();
        assert_eq!(initial.preferences.preset, WorkspacePreset::Simple);

        let mut changed = initial.preferences.clone();
        changed.preset = WorkspacePreset::Custom;
        changed.density = WorkspaceDensity::Compact;
        changed.editor_mode = EditorMode::Markdown;
        changed.hidden_modules = vec!["assistant".into(), "analytics".into()];
        changed.module_order.reverse();

        let saved = save(&root, "alice", &initial.etag, changed.clone()).unwrap();
        assert_eq!(saved.preferences, changed);
        assert_ne!(saved.etag, initial.etag);

        let mut changed_again = saved.preferences.clone();
        changed_again.density = WorkspaceDensity::Comfortable;
        let saved_again = save(&root, "alice", &saved.etag, changed_again.clone()).unwrap();
        assert_eq!(saved_again.preferences, changed_again);
        assert!(matches!(
            save(&root, "alice", &initial.etag, Preferences::default()),
            Err(SaveError::Conflict)
        ));
        assert_eq!(load(&root, "alice").unwrap(), saved_again);
        assert_eq!(
            load(&root, "bob").unwrap().preferences,
            Preferences::default()
        );

        let path = preference_path(&root, "alice").unwrap();
        assert!(!path.to_string_lossy().contains("alice"));
        assert!(path.starts_with(root.join(".openblog/private/admin-preferences")));
        assert!(!root.join("openblog.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshots_say_whether_preferences_were_ever_stored() {
        let root = fixture("stored");
        let initial = load(&root, "alice").unwrap();
        assert!(!initial.stored);
        let saved = save(&root, "alice", &initial.etag, initial.preferences.clone()).unwrap();
        assert!(saved.stored);
        assert!(load(&root, "alice").unwrap().stored);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stored_preferences_keep_newly_added_modules_reachable() {
        let root = fixture("migration");
        let path = preference_path(&root, "alice").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            br#"{"schemaVersion":1,"preset":"custom","density":"compact","editorMode":"markdown",
            "moduleOrder":["assistant","retired-tool","social","assistant"],
            "hiddenModules":["social","retired-tool"]}"#,
        )
        .unwrap();
        let loaded = load(&root, "alice").unwrap();
        assert_eq!(loaded.preferences.module_order[0], "assistant");
        assert_eq!(loaded.preferences.module_order[1], "social");
        assert_eq!(
            loaded.preferences.module_order.len(),
            OPTIONAL_MODULES.len()
        );
        assert_eq!(
            loaded.preferences.hidden_modules,
            vec!["social".to_string()]
        );
        loaded.preferences.validate().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preferences_saved_before_the_research_workspace_gain_it_at_the_end_hidden_with_evidence() {
        let root = fixture("research-module");
        let path = preference_path(&root, "alice").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            br#"{"schemaVersion":1,"preset":"custom","density":"comfortable","editorMode":"visual",
            "moduleOrder":["social","release","field","optimize","accessibility","evidence",
            "assistant","analytics","contributors","public-site"],"hiddenModules":["evidence"]}"#,
        )
        .unwrap();
        let loaded = load(&root, "alice").unwrap();
        assert_eq!(
            loaded.preferences.module_order.last().map(String::as_str),
            Some("research")
        );
        // Research used to show only with Evidence Studio, so hiding one kept hiding the other.
        assert_eq!(
            loaded.preferences.hidden_modules,
            vec!["evidence".to_string(), "research".to_string()]
        );
        loaded.preferences.validate().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preferences_saved_before_the_research_workspace_show_it_when_evidence_was_shown() {
        let root = fixture("research-module-shown");
        let path = preference_path(&root, "alice").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            br#"{"schemaVersion":1,"preset":"custom","density":"comfortable","editorMode":"visual",
            "moduleOrder":["social","release","field","optimize","accessibility","evidence",
            "assistant","analytics","contributors","public-site"],"hiddenModules":["social"]}"#,
        )
        .unwrap();
        let loaded = load(&root, "alice").unwrap();
        assert_eq!(
            loaded.preferences.hidden_modules,
            vec!["social".to_string()]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preferences_that_know_the_research_workspace_keep_it_as_chosen() {
        let root = fixture("research-module-known");
        let path = preference_path(&root, "alice").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            br#"{"schemaVersion":1,"preset":"custom","density":"comfortable","editorMode":"visual",
            "moduleOrder":["social","release","field","optimize","accessibility","evidence",
            "research","assistant","analytics","contributors","public-site"],
            "hiddenModules":["evidence"]}"#,
        )
        .unwrap();
        let loaded = load(&root, "alice").unwrap();
        assert_eq!(
            loaded.preferences.hidden_modules,
            vec!["evidence".to_string()]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_state_can_be_replaced_only_by_a_client_without_a_revision() {
        let root = fixture("recovery");
        let path = preference_path(&root, "alice").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{not json").unwrap();
        let restored = save(&root, "alice", "", Preferences::default()).unwrap();
        assert_eq!(restored.preferences, Preferences::default());
        assert!(matches!(
            save(&root, "alice", "", Preferences::default()),
            Err(SaveError::Conflict)
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn state_that_cannot_be_read_at_all_is_never_replaced() {
        let root = fixture("unreadable");
        let path = preference_path(&root, "alice").unwrap();
        // A directory where the file belongs cannot be read, like a permission or I/O failure.
        fs::create_dir_all(&path).unwrap();
        assert!(load(&root, "alice").is_err());
        assert!(matches!(
            save(&root, "alice", "", Preferences::default()),
            Err(SaveError::Storage(_))
        ));
        assert!(path.is_dir(), "the unreadable entry is left in place");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_input_is_distinguished_from_storage_failure() {
        let root = fixture("invalid");
        let mut invalid = Preferences::default();
        invalid.hidden_modules.push("publish".into());
        let etag = load(&root, "alice").unwrap().etag;
        assert!(matches!(
            save(&root, "alice", &etag, invalid),
            Err(SaveError::Invalid(_))
        ));
        assert!(matches!(
            save(&root, "", &etag, Preferences::default()),
            Err(SaveError::Invalid(_))
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_or_oversized_private_state_fails_without_falling_back() {
        let root = fixture("malformed");
        let path = preference_path(&root, "alice").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{not json").unwrap();
        assert!(load(&root, "alice").unwrap_err().contains("not valid"));
        fs::write(&path, vec![b'x'; MAX_FILE_BYTES + 1]).unwrap();
        assert!(load(&root, "alice").unwrap_err().contains("too large"));
        fs::remove_dir_all(root).unwrap();
    }
}
