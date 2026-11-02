//! Private, file-backed storage for the author's curated selections
//! (ADR 0185, ADR 0191).
//!
//! The selections file lives at [`SELECTIONS_FILE`] beside the source
//! library, the notebook, the Knowledge Atlas, the claims file and the
//! alignments, inside the Git-ignored private directory and outside content,
//! static files, themes and build output. It holds choices and the author's own
//! attributed text, and copies none of the research it selects. Every change
//! names the revision (SHA-256 of the stored bytes) it was based on and is
//! written to a temporary file that is renamed over the file while holding
//! locks: a refused, failed or interrupted change leaves the stored file
//! exactly as it was.
//!
//! Locks are taken in the one order every store uses, extended by this one:
//! atlas, claims, alignments, notebook, library, selections. A selections
//! write reads the atlas, the alignments, the notebook and the library to
//! resolve what it selects, so it holds those locks first, in that order, then
//! its own. It never takes the claims lock, and no other writer takes the
//! selections lock, so no two writers can wait on each other. A change to a
//! store it reads only ever makes a selection stale, which withholds it.

use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use openblog_core::curated_selection::{
    Code, Diagnostic, SelectionSet, MAX_SELECTIONS_BYTES, SELECTIONS_FILE,
};

use crate::source_store;
use crate::transaction::FileLock;

const LOCK_WAIT: Duration = Duration::from_secs(2);

/// One read of the selections file and the revision a later change must name.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub selections: SelectionSet,
    /// SHA-256 of the stored bytes, or of the empty file while none is stored.
    pub revision: String,
    /// False until the first change creates the file.
    pub stored: bool,
}

#[derive(Debug, PartialEq)]
pub enum StoreError {
    /// The file changed after the caller read the revision it named.
    Conflict,
    /// The stored file or the requested change is invalid. Nothing was written.
    Invalid(Vec<Diagnostic>),
    /// The file or a store it is resolved against could not be located, read
    /// or written safely. Nothing was written.
    Storage(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict => formatter.write_str(
                "the curated selections changed since they were read; reload them and apply the change again",
            ),
            Self::Invalid(diagnostics) => {
                for (position, diagnostic) in diagnostics.iter().enumerate() {
                    if position > 0 {
                        formatter.write_str("\n")?;
                    }
                    write!(formatter, "{SELECTIONS_FILE}: {}", diagnostic.message)?;
                }
                Ok(())
            }
            Self::Storage(message) => formatter.write_str(message),
        }
    }
}

fn selections_path(root: &Path) -> Result<PathBuf, StoreError> {
    source_store::contained(root, Path::new(SELECTIONS_FILE))
        .map_err(|error| StoreError::Storage(error.to_string()))
}

fn lock_path(path: &Path) -> PathBuf {
    path.with_extension("json.lock")
}

fn too_large() -> StoreError {
    StoreError::Invalid(vec![Diagnostic {
        code: Code::TooLarge,
        id: None,
        field: None,
        message: format!("the selections file is larger than {MAX_SELECTIONS_BYTES} bytes"),
    }])
}

/// Read and validate the selections file. An absent file is empty, and
/// reading never creates a file or directory.
pub fn load(root: &Path) -> Result<Snapshot, StoreError> {
    let path = selections_path(root)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let selections = SelectionSet::default();
            return Ok(Snapshot {
                revision: source_store::revision(selections.to_json().as_bytes()),
                selections,
                stored: false,
            });
        }
        Err(error) => {
            return Err(StoreError::Storage(format!(
                "cannot inspect {SELECTIONS_FILE}: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(StoreError::Storage(format!(
            "{SELECTIONS_FILE} is a symlink; replace it with a regular file"
        )));
    }
    if !metadata.is_file() {
        return Err(StoreError::Storage(format!(
            "{SELECTIONS_FILE} is not a regular file"
        )));
    }
    if metadata.len() > MAX_SELECTIONS_BYTES as u64 {
        return Err(too_large());
    }
    let bytes = crate::fsutil::retry_transient(|| {
        let mut bytes = Vec::new();
        fs::File::open(&path)?
            .take(MAX_SELECTIONS_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    })
    .map_err(|error| StoreError::Storage(format!("cannot read {SELECTIONS_FILE}: {error}")))?;
    if bytes.len() > MAX_SELECTIONS_BYTES {
        return Err(too_large());
    }
    let revision = source_store::revision(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| {
        StoreError::Invalid(vec![Diagnostic {
            code: Code::InvalidJson,
            id: None,
            field: None,
            message: "the selections file is not valid UTF-8".into(),
        }])
    })?;
    let selections = SelectionSet::parse(&text).map_err(StoreError::Invalid)?;
    Ok(Snapshot {
        selections,
        revision,
        stored: true,
    })
}

/// Whether the stored file can be read, as the build that publishes curated
/// context reads it, for the readiness report. An absent file always can.
/// The message names the file and the first problem, never authored text.
pub fn check(root: &Path) -> Result<(), String> {
    load(root).map(|_| ()).map_err(|error| {
        error
            .to_string()
            .lines()
            .next()
            .unwrap_or_default()
            .to_string()
    })
}

/// The locks a selections write holds, in the one order. Dropping releases
/// them all.
pub struct Locks {
    _selections: FileLock,
    _library: FileLock,
    _notebook: FileLock,
    _alignments: FileLock,
    _atlas: FileLock,
}

/// Take the atlas, alignments, notebook, library and selections locks, in that
/// order. Taking them creates the private research directory, so a caller
/// that may refuse without writing should check its change first.
pub fn lock(root: &Path) -> Result<Locks, StoreError> {
    let path = selections_path(root)?;
    let atlas = crate::atlas_store::lock_atlas(root)
        .map_err(|error| StoreError::Storage(error.to_string()))?;
    let alignments = crate::alignment_store::lock_alignments(root)
        .map_err(|error| StoreError::Storage(error.to_string()))?;
    let notebook = crate::notebook_store::lock_notebook(root)
        .map_err(|error| StoreError::Storage(error.to_string()))?;
    let library =
        source_store::lock_library(root).map_err(|error| StoreError::Storage(error.to_string()))?;
    let selections = FileLock::acquire(lock_path(&path), "curated selections write", LOCK_WAIT)
        .map_err(StoreError::Storage)?;
    Ok(Locks {
        _selections: selections,
        _library: library,
        _notebook: notebook,
        _alignments: alignments,
        _atlas: atlas,
    })
}

/// Whether the private research directory exists, so that locking creates
/// nothing new.
pub fn directory_exists(root: &Path) -> bool {
    selections_path(root)
        .ok()
        .and_then(|path| path.parent().map(Path::is_dir))
        .unwrap_or(false)
}

/// Replace the file with `set`, while the caller holds [`lock`]: nothing is
/// written unless the stored revision still matches `expected_revision`.
pub fn commit(
    root: &Path,
    _locks: &Locks,
    set: &SelectionSet,
    expected_revision: &str,
) -> Result<Snapshot, StoreError> {
    commit_using(root, set, expected_revision, |from, to| {
        crate::fsutil::replace_file(from, to)
    })
}

fn commit_using(
    root: &Path,
    set: &SelectionSet,
    expected_revision: &str,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<Snapshot, StoreError> {
    let path = selections_path(root)?;
    let current = load(root)?;
    if current.revision != expected_revision {
        return Err(StoreError::Conflict);
    }
    let text = set.to_json();
    if text.len() > MAX_SELECTIONS_BYTES {
        return Err(too_large());
    }
    write_atomically(&path, text.as_bytes(), rename)?;
    source_store::remove_interrupted_writes(&path);
    Ok(Snapshot {
        selections: set.clone(),
        revision: source_store::revision(text.as_bytes()),
        stored: true,
    })
}

/// Write `bytes` to a new temporary file beside `path`, flush it, and rename
/// it over `path`. On any failure the temporary file is removed and `path`
/// keeps its previous contents.
fn write_atomically(
    path: &Path,
    bytes: &[u8],
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), StoreError> {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let temporary = path.with_extension(format!("json.{}-{unique}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        if let Some(directory) = path.parent() {
            fs::create_dir_all(directory)?;
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        rename(&temporary, path)
    })();
    if let Err(error) = result {
        let _ = crate::fsutil::retry_transient(|| fs::remove_file(&temporary));
        return Err(StoreError::Storage(format!(
            "could not save the curated selections ({error}); the stored file is unchanged"
        )));
    }
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        // Best effort: the rename has already replaced the file.
        let _ = fs::File::open(parent).and_then(|directory| directory.sync_all());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use openblog_core::curated_selection::{Selection, SelectionKind};
    use std::collections::BTreeMap;

    fn temp_root(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "openblog-selections-{tag}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn one() -> SelectionSet {
        SelectionSet {
            selections: vec![Selection {
                id: "entry-plato".into(),
                kind: SelectionKind::ContextualEntry,
                target: "plato".into(),
                revision: "0123456789abcdef".into(),
                fields: Vec::new(),
                state: Default::default(),
                withdrawn_reason: None,
                text: None,
                by: None,
                locator: None,
                provenance: Default::default(),
                requires: Vec::new(),
                posts: None,
                positions: Default::default(),
                extra: BTreeMap::new(),
            }],
            ..SelectionSet::default()
        }
    }

    #[test]
    fn reading_creates_nothing_and_an_absent_file_is_empty() {
        let root = temp_root("absent");
        let snapshot = load(&root).unwrap();
        assert!(!snapshot.stored && snapshot.selections.selections.is_empty());
        assert!(!root.join(".openblog").exists());
        assert!(!directory_exists(&root));
        assert!(check(&root).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_change_names_its_revision_and_is_atomic() {
        let root = temp_root("change");
        let before = load(&root).unwrap().revision;
        let locks = lock(&root).unwrap();
        let written = commit(&root, &locks, &one(), &before).unwrap();
        assert!(written.stored);
        assert_eq!(load(&root).unwrap(), written);
        // A stale revision is a conflict and changes nothing.
        let bytes = fs::read(root.join(SELECTIONS_FILE)).unwrap();
        assert_eq!(
            commit(&root, &locks, &SelectionSet::default(), &before).unwrap_err(),
            StoreError::Conflict
        );
        assert_eq!(fs::read(root.join(SELECTIONS_FILE)).unwrap(), bytes);
        // A failed rename leaves the stored file and no temporary file.
        let failure = commit_using(
            &root,
            &SelectionSet::default(),
            &written.revision,
            |_, _| Err(std::io::Error::other("injected")),
        )
        .unwrap_err();
        assert!(matches!(failure, StoreError::Storage(_)), "{failure}");
        assert_eq!(fs::read(root.join(SELECTIONS_FILE)).unwrap(), bytes);
        let leftovers: Vec<_> = fs::read_dir(root.join(".openblog/private/research"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        drop(locks);
        // Locks are released, so another writer can take them.
        assert!(lock(&root).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_damaged_file_is_named_and_never_replaced() {
        let root = temp_root("damaged");
        let path = root.join(SELECTIONS_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ nope").unwrap();
        let message = check(&root).unwrap_err();
        assert!(message.contains("selections"), "{message}");
        let revision = source_store::revision(b"{ nope");
        let locks = lock(&root).unwrap();
        assert!(matches!(
            commit(&root, &locks, &one(), &revision).unwrap_err(),
            StoreError::Invalid(_)
        ));
        assert_eq!(fs::read(&path).unwrap(), b"{ nope");
        fs::remove_dir_all(root).unwrap();
    }
}
