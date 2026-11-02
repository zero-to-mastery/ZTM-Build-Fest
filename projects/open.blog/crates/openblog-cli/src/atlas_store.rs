//! Private, file-backed storage for the Knowledge Atlas (contextual entries
//! and attributed relationships).
//!
//! The atlas lives at [`ATLAS_FILE`] beside the source library and the research
//! notebook, inside the Git-ignored private directory and outside content,
//! static files, themes, and build output, so no build, feed, search index,
//! `llms.txt` or export reads it. It points into both of them (source ids,
//! locators, notebook passages) and copies neither. Every change names the
//! revision it was based on, is validated by `openblog_core::knowledge_atlas`
//! against the library and notebook as stored, and replaces the file by atomic
//! rename while holding locks: a refused, failed, or interrupted change leaves
//! the stored atlas exactly as it was.
//!
//! Locks are always taken in one order: atlas, then claims, then notebook,
//! then library (ADR 0056, ADR 0072). An atlas write takes atlas, notebook and
//! library and never the claims lock. Notebook changes (notebook, library) and
//! library changes (library) take a suffix of it and only *read* the atlas,
//! which they may safely do because an atlas write holds their locks for its
//! whole critical section.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use openblog_core::contributor::Contributor;
use openblog_core::knowledge_atlas::{
    Atlas, AtlasDiagnostic, AtlasDiagnosticCode, Entry, EntryRemoval, Links, Relationship,
    MAX_ATLAS_BYTES,
};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;

use crate::notebook_store;
use crate::source_store::{self, StoreError as LibraryError};
use crate::transaction::FileLock;

/// Where the atlas lives, relative to the project root.
pub const ATLAS_FILE: &str = ".openblog/private/research/atlas.json";
const LOCK_WAIT: Duration = Duration::from_secs(2);

/// One read of the atlas and the revision a later change must name.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub atlas: Atlas,
    /// SHA-256 of the stored bytes, or of the empty atlas while none is stored.
    pub revision: String,
    /// False until the first change creates the file.
    pub stored: bool,
    /// The source library and notebook the atlas was validated against.
    pub library: SourceLibrary,
    pub notebook: Notebook,
}

#[derive(Debug, PartialEq)]
pub enum StoreError {
    /// The atlas changed after the caller read the revision it named.
    Conflict,
    /// The stored atlas or the requested change is invalid. Nothing was written.
    Invalid(Vec<AtlasDiagnostic>),
    /// The atlas, notebook or library could not be located, read, or written
    /// safely. Nothing was written.
    Storage(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict => formatter.write_str(
                "the Knowledge Atlas changed since it was read; reload it and apply the change again",
            ),
            Self::Invalid(diagnostics) => {
                for (position, diagnostic) in diagnostics.iter().enumerate() {
                    if position > 0 {
                        formatter.write_str("\n")?;
                    }
                    write!(formatter, "{ATLAS_FILE}: {diagnostic}")?;
                }
                Ok(())
            }
            Self::Storage(message) => formatter.write_str(message),
        }
    }
}

fn library_blocked(error: LibraryError) -> StoreError {
    match error {
        LibraryError::Storage(message) => StoreError::Storage(message),
        other => StoreError::Storage(format!(
            "the source library cannot be read, so the Knowledge Atlas cannot be checked against it: {other}"
        )),
    }
}

fn notebook_blocked(error: notebook_store::StoreError) -> StoreError {
    match error {
        notebook_store::StoreError::Storage(message) => StoreError::Storage(message),
        other => StoreError::Storage(format!(
            "the research notebook cannot be read, so the Knowledge Atlas cannot be checked against it: {other}"
        )),
    }
}

/// Read and validate the atlas against the stored library and notebook. An
/// absent atlas is empty, and reading never creates a file or directory.
pub fn load(
    root: &Path,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    let library = source_store::load(root, contributors)
        .map_err(library_blocked)?
        .library;
    against_library(root, library)
}

/// The atlas as a build reads it, against the library read for a build
/// (`source_store::load_for_build`), so a problem in an interpretation never
/// stops a site that publishes its atlas from building.
pub fn load_for_build(
    root: &Path,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    let library = source_store::load_for_build(root, contributors)
        .map_err(library_blocked)?
        .library;
    against_library(root, library)
}

/// The atlas against a library and notebook already read for a build.
pub fn from_parts(
    root: &Path,
    library: SourceLibrary,
    notebook: Notebook,
) -> Result<Snapshot, StoreError> {
    read(root, library, notebook)
}

fn against_library(root: &Path, library: SourceLibrary) -> Result<Snapshot, StoreError> {
    let notebook = notebook_store::read(root, library.clone())
        .map_err(notebook_blocked)?
        .notebook;
    read(root, library, notebook)
}

/// Atlas entries and relationships that use a source, for the library's
/// removal guard. An atlas that cannot be read blocks removal with a message
/// instead of guessing.
pub fn uses_of_source(
    root: &Path,
    library: &SourceLibrary,
    source: &str,
) -> Result<Vec<String>, String> {
    against_library(root, library.clone())
        .map(|snapshot| snapshot.atlas.uses_of_source(source))
        .map_err(|error| {
            format!("the Knowledge Atlas cannot be checked ({error}); repair it before removing a source")
        })
}

/// Atlas entries and relationships whose evidence, their datings' included,
/// points into a notebook passage, for the notebook's removal guard. An atlas
/// that cannot be read blocks removal.
pub fn uses_of_passage(
    root: &Path,
    library: &SourceLibrary,
    notebook: &Notebook,
    passage: &str,
) -> Result<Vec<String>, String> {
    read(root, library.clone(), notebook.clone())
        .map(|snapshot| snapshot.atlas.uses_of_passage(passage))
        .map_err(|error| {
            format!("the Knowledge Atlas cannot be checked ({error}); repair it before removing a passage")
        })
}

/// Whether the stored atlas is valid against this library and notebook. An
/// absent atlas always is.
pub fn check_against(
    root: &Path,
    library: &SourceLibrary,
    notebook: &Notebook,
) -> Result<(), String> {
    read(root, library.clone(), notebook.clone())
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Whether the stored atlas is valid against a library that is about to
/// replace the stored one, with the notebook read against that library.
pub fn check_against_library(root: &Path, library: &SourceLibrary) -> Result<(), String> {
    against_library(root, library.clone())
        .map(|_| ())
        .map_err(|error| error.to_string())
}

type Edit<'a, T> = dyn Fn(&mut Atlas, Links<'_>) -> Result<T, Vec<AtlasDiagnostic>> + 'a;

/// Add an entry whose identifier nothing in the atlas uses yet.
pub fn create_entry(
    root: &Path,
    expected_revision: &str,
    entry: Entry,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, &|atlas, links| {
        if let Some(diagnostic) = in_use(atlas, "entries", &entry.id) {
            return Err(vec![diagnostic]);
        }
        atlas.upsert_entry(entry.clone(), links)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Replace the entry with the same identifier. Its kind cannot change.
pub fn update_entry(
    root: &Path,
    expected_revision: &str,
    entry: Entry,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, &|atlas, links| {
        if atlas.entry(&entry.id).is_none() {
            return Err(vec![unknown("entries", &entry.id)]);
        }
        atlas.upsert_entry(entry.clone(), links)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Remove an entry no relationship joins. Notebook notes whose concept link
/// becomes unresolved are reported, not a reason to refuse.
pub fn remove_entry(
    root: &Path,
    expected_revision: &str,
    id: &str,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<(Snapshot, EntryRemoval), StoreError> {
    change(root, expected_revision, contributors, &|atlas, links| {
        atlas.remove_entry(id, links)
    })
}

/// Add a relationship whose identifier nothing in the atlas uses yet.
pub fn create_relationship(
    root: &Path,
    expected_revision: &str,
    relationship: Relationship,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, &|atlas, links| {
        if let Some(diagnostic) = in_use(atlas, "relationships", &relationship.id) {
            return Err(vec![diagnostic]);
        }
        atlas.upsert_relationship(relationship.clone(), links)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Replace the relationship with the same identifier.
pub fn update_relationship(
    root: &Path,
    expected_revision: &str,
    relationship: Relationship,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, &|atlas, links| {
        if atlas.relationship(&relationship.id).is_none() {
            return Err(vec![unknown("relationships", &relationship.id)]);
        }
        atlas.upsert_relationship(relationship.clone(), links)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Remove a relationship.
pub fn remove_relationship(
    root: &Path,
    expected_revision: &str,
    id: &str,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, &|atlas, links| {
        atlas.remove_relationship(id, links).map(|_| ())
    })
    .map(|(snapshot, ())| snapshot)
}

fn diagnostic(
    code: AtlasDiagnosticCode,
    collection: &'static str,
    id: &str,
    field: Option<&str>,
    message: String,
) -> AtlasDiagnostic {
    AtlasDiagnostic {
        subject: Default::default(),
        code,
        collection: Some(collection),
        index: None,
        id: Some(id.into()),
        field: field.map(str::to_string),
        message,
        facts: Vec::new(),
    }
}

fn unknown(collection: &'static str, id: &str) -> AtlasDiagnostic {
    diagnostic(
        AtlasDiagnosticCode::UnknownEntry,
        collection,
        id,
        None,
        format!("nothing in {collection} has the id `{id}`"),
    )
}

/// Creating refuses an identifier any entry or relationship already uses,
/// scoped to the collection being created in.
fn in_use(atlas: &Atlas, collection: &'static str, id: &str) -> Option<AtlasDiagnostic> {
    (atlas.entry(id).is_some() || atlas.relationship(id).is_some()).then(|| {
        diagnostic(
            AtlasDiagnosticCode::DuplicateId,
            collection,
            id,
            Some("id"),
            format!("`{id}` is already used in the atlas; edit it or choose another id"),
        )
    })
}

/// Apply one edit while holding the atlas, notebook and library locks, in that
/// order. The edit sees all three as stored, and nothing is written unless the
/// stored revision matches, the stored atlas is valid, and the edited atlas is
/// valid. While nothing is stored the edit is first tried without the locks, so
/// a refused change never creates private directories.
fn change<T>(
    root: &Path,
    expected_revision: &str,
    contributors: &BTreeMap<String, Contributor>,
    edit: &Edit<'_, T>,
) -> Result<(Snapshot, T), StoreError> {
    change_using(root, expected_revision, contributors, edit, |from, to| {
        crate::fsutil::replace_file(from, to)
    })
}

fn change_using<T>(
    root: &Path,
    expected_revision: &str,
    contributors: &BTreeMap<String, Contributor>,
    edit: &Edit<'_, T>,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(Snapshot, T), StoreError> {
    let path = atlas_path(root)?;
    let directory = path
        .parent()
        .ok_or_else(|| StoreError::Storage("the Knowledge Atlas has no directory".into()))?;
    if !directory.is_dir() {
        let current = load(root, contributors)?;
        let mut atlas = checked(&current, expected_revision)?;
        edit(&mut atlas, links(&current)).map_err(StoreError::Invalid)?;
        source_store::create_private_directory(directory).map_err(storage)?;
    }
    // Check again now that every directory exists.
    let path = atlas_path(root)?;
    let _lock = FileLock::acquire(lock_path(&path), "Knowledge Atlas write", LOCK_WAIT)
        .map_err(StoreError::Storage)?;
    // The atlas reads both stores, so it holds both of their locks too, after
    // its own: a passage or source removal that checks the atlas cannot
    // interleave with this write, and nothing waits in the other order.
    let _notebook_lock = notebook_store::lock_notebook(root).map_err(notebook_blocked)?;
    let _library_lock = source_store::lock_library(root).map_err(library_blocked)?;

    let current = load(root, contributors)?;
    let mut atlas = checked(&current, expected_revision)?;
    let outcome = edit(&mut atlas, links(&current)).map_err(StoreError::Invalid)?;
    let text = atlas.to_json();
    commit(&path, text.as_bytes(), rename)?;
    source_store::remove_interrupted_writes(&path);
    Ok((
        Snapshot {
            atlas,
            revision: source_store::revision(text.as_bytes()),
            stored: true,
            library: current.library,
            notebook: current.notebook,
        },
        outcome,
    ))
}

fn links(snapshot: &Snapshot) -> Links<'_> {
    Links {
        library: &snapshot.library,
        notebook: &snapshot.notebook,
    }
}

fn storage(error: LibraryError) -> StoreError {
    StoreError::Storage(error.to_string())
}

fn checked(current: &Snapshot, expected_revision: &str) -> Result<Atlas, StoreError> {
    if current.revision != expected_revision {
        return Err(StoreError::Conflict);
    }
    Ok(current.atlas.clone())
}

fn read(root: &Path, library: SourceLibrary, notebook: Notebook) -> Result<Snapshot, StoreError> {
    let path = atlas_path(root)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let atlas = Atlas::default();
            return Ok(Snapshot {
                revision: source_store::revision(atlas.to_json().as_bytes()),
                atlas,
                stored: false,
                library,
                notebook,
            });
        }
        Err(error) => {
            return Err(StoreError::Storage(format!(
                "cannot inspect {ATLAS_FILE}: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(StoreError::Storage(format!(
            "{ATLAS_FILE} is a symlink; replace it with a regular file"
        )));
    }
    if !metadata.is_file() {
        return Err(StoreError::Storage(format!(
            "{ATLAS_FILE} is not a regular file"
        )));
    }
    if metadata.len() > MAX_ATLAS_BYTES as u64 {
        return Err(StoreError::Invalid(vec![too_large()]));
    }
    let bytes = crate::fsutil::retry_transient(|| {
        let mut bytes = Vec::new();
        fs::File::open(&path)?
            .take(MAX_ATLAS_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    })
    .map_err(|error| StoreError::Storage(format!("cannot read {ATLAS_FILE}: {error}")))?;
    if bytes.len() > MAX_ATLAS_BYTES {
        return Err(StoreError::Invalid(vec![too_large()]));
    }
    let revision = source_store::revision(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| {
        StoreError::Invalid(vec![AtlasDiagnostic {
            subject: Default::default(),
            code: AtlasDiagnosticCode::InvalidJson,
            collection: None,
            index: None,
            id: None,
            field: None,
            message: "the atlas is not valid UTF-8".into(),
            facts: Vec::new(),
        }])
    })?;
    let atlas = Atlas::parse(
        &text,
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .map_err(StoreError::Invalid)?;
    Ok(Snapshot {
        atlas,
        revision,
        stored: true,
        library,
        notebook,
    })
}

fn too_large() -> AtlasDiagnostic {
    AtlasDiagnostic {
        subject: Default::default(),
        code: AtlasDiagnosticCode::TooLarge,
        collection: None,
        index: None,
        id: None,
        field: None,
        message: format!("the atlas is larger than {MAX_ATLAS_BYTES} bytes"),
        facts: Vec::new(),
    }
}

fn atlas_path(root: &Path) -> Result<PathBuf, StoreError> {
    source_store::contained(root, Path::new(ATLAS_FILE))
        .map_err(|error| StoreError::Storage(error.to_string()))
}

fn lock_path(path: &Path) -> PathBuf {
    path.with_extension("json.lock")
}

/// Take the atlas's write lock, the first in the one order every store uses,
/// so a store that reads the atlas can hold its writers out.
pub(crate) fn lock_atlas(root: &Path) -> Result<FileLock, StoreError> {
    let path = atlas_path(root)?;
    FileLock::acquire(lock_path(&path), "Knowledge Atlas write", LOCK_WAIT)
        .map_err(StoreError::Storage)
}

/// Write `bytes` to a new temporary file beside `path`, flush it, and rename
/// it over `path`. On any failure the temporary file is removed and `path`
/// keeps its previous contents.
fn commit(
    path: &Path,
    bytes: &[u8],
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), StoreError> {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let temporary = path.with_extension(format!("json.{}-{unique}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
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
            "could not save the Knowledge Atlas ({error}); the stored atlas is unchanged"
        )));
    }
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        // Best effort: the rename has already replaced the atlas.
        let _ = fs::File::open(parent).and_then(|directory| directory.sync_all());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use openblog_core::knowledge_atlas::Visibility;
    use openblog_core::research_notes::{NoteDiagnosticCode, Passage, ResearchNote};
    use serde_json::json;

    fn temp_root(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "openblog-atlas-{tag}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn none() -> BTreeMap<String, Contributor> {
        BTreeMap::new()
    }

    fn with_library(root: &Path) {
        let path = root.join(source_store::LIBRARY_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let library = json!({"version": 1, "sources": [
            {"id": "plato", "kind": "work", "title": "Politeia"},
            {"id": "slings", "kind": "edition", "of": "plato", "title": "Slings"},
            {"id": "ref", "kind": "reference", "of": "slings"},
            {"id": "scholar", "kind": "work", "title": "A study"},
            {"id": "spare", "kind": "work", "title": "Unused"}]});
        fs::write(path, library.to_string()).unwrap();
    }

    fn file(root: &Path) -> PathBuf {
        root.join(ATLAS_FILE)
    }

    fn entry(id: &str, kind: &str) -> Entry {
        Entry::from_json(json!({"id": id, "kind": kind, "label": "<b>x</b> ὁ"})).unwrap()
    }

    fn relationship(id: &str, from: &str, to: &str, evidence: serde_json::Value) -> Relationship {
        Relationship::from_json(
            json!({"id": id, "kind": "influenced", "from": from, "to": to,
            "assertedBy": {"kind": "source", "source": "scholar"}, "evidence": evidence}),
        )
        .unwrap()
    }

    /// Two entries and one relationship citing `ref` page 514.
    fn seeded(root: &Path) -> Snapshot {
        with_library(root);
        let empty = load(root, &none()).unwrap();
        let a = create_entry(root, &empty.revision, entry("plato-p", "person"), &none()).unwrap();
        let b = create_entry(root, &a.revision, entry("stoa", "movement"), &none()).unwrap();
        create_relationship(
            root,
            &b.revision,
            relationship(
                "r1",
                "plato-p",
                "stoa",
                json!([{"source": "ref", "locators": [{"kind": "page", "value": "514"}]}]),
            ),
            &none(),
        )
        .unwrap()
    }

    fn codes(error: StoreError) -> Vec<AtlasDiagnosticCode> {
        match error {
            StoreError::Invalid(found) => found.iter().map(|d| d.code).collect(),
            other => panic!("expected diagnostics, got {other:?}"),
        }
    }

    fn tmp_files(root: &Path) -> usize {
        fs::read_dir(file(root).parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count()
    }

    #[test]
    fn an_absent_atlas_loads_empty_without_creating_anything() {
        let root = temp_root("absent");
        let snapshot = load(&root, &none()).unwrap();
        assert!(!snapshot.stored && snapshot.atlas.entries.is_empty());
        assert_eq!(snapshot.atlas, Atlas::default());
        assert!(!root.join(".openblog").exists());
        // A refused first change creates no directory, lock, or file either.
        let mut work = entry("w", "work");
        work.source = Some("missing".into());
        let refused = create_entry(&root, &snapshot.revision, work, &none()).unwrap_err();
        assert_eq!(codes(refused), vec![AtlasDiagnosticCode::UnknownSource]);
        assert!(!root.join(".openblog").exists());
        // The first accepted change creates the private file.
        create_entry(&root, &snapshot.revision, entry("p", "person"), &none()).unwrap();
        assert!(file(&root).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_version_1_atlas_is_read_as_is_and_upgraded_only_by_the_next_change() {
        let root = temp_root("upgrade");
        with_library(&root);
        let v1 = "{\"version\": 1, \"entries\": [{\"id\": \"plato-p\", \"kind\": \"person\", \"label\": \"Plato\", \"bounds\": {\"from\": -428, \"until\": -348, \"calendar\": \"julian\"}, \"visibility\": \"approved\"}]}\n";
        fs::create_dir_all(file(&root).parent().unwrap()).unwrap();
        fs::write(file(&root), v1).unwrap();
        let read = load(&root, &none()).unwrap();
        assert_eq!(read.revision, source_store::revision(v1.as_bytes()));
        assert_eq!(
            fs::read_to_string(file(&root)).unwrap(),
            v1,
            "reading never writes"
        );
        let dating = &read.atlas.entry("plato-p").unwrap().dates[0];
        assert_eq!(dating.id, "plato-p-span");
        assert!(dating.unsourced);
        // A stale change is refused and the version 1 file is left as it was.
        let stale = create_entry(&root, "stale", entry("x", "concept"), &none());
        assert_eq!(stale.unwrap_err(), StoreError::Conflict);
        assert_eq!(fs::read_to_string(file(&root)).unwrap(), v1);
        let changed = create_entry(&root, &read.revision, entry("x", "concept"), &none()).unwrap();
        let written = fs::read_to_string(file(&root)).unwrap();
        assert!(written.starts_with("{\n  \"version\": 2,"));
        assert!(written.contains("\"plato-p-span\"") && written.contains("\"julian\""));
        assert!(!written.contains("\"bounds\""));
        assert_eq!(load(&root, &none()).unwrap(), changed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changes_are_revision_checked_deterministic_and_lossless() {
        let root = temp_root("changes");
        let seeded = seeded(&root);
        let bytes = fs::read(file(&root)).unwrap();
        assert_eq!(bytes, seeded.atlas.to_json().as_bytes());
        assert_eq!(seeded.revision, source_store::revision(&bytes));
        assert_eq!(load(&root, &none()).unwrap(), seeded);

        // A stale revision is a conflict and writes nothing.
        let stale = create_entry(&root, "stale", entry("x", "concept"), &none());
        assert_eq!(stale.unwrap_err(), StoreError::Conflict);
        assert_eq!(fs::read(file(&root)).unwrap(), bytes);

        // Unknown fields written by hand survive a later change through the store.
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["future"] = json!({"b": 1, "a": 2});
        value["entries"][0]["orcid"] = json!("0000");
        value["relationships"][0]["evidence"][0]["note"] = json!("kept");
        fs::write(file(&root), value.to_string()).unwrap();
        let outside = load(&root, &none()).unwrap();
        assert_ne!(
            outside.revision, seeded.revision,
            "a hand edit changes the revision"
        );
        assert_eq!(
            create_entry(&root, &seeded.revision, entry("x", "concept"), &none()).unwrap_err(),
            StoreError::Conflict
        );
        let after = create_entry(&root, &outside.revision, entry("x", "concept"), &none()).unwrap();
        let text = fs::read_to_string(file(&root)).unwrap();
        for needle in ["\"future\"", "\"orcid\"", "\"note\": \"kept\""] {
            assert!(text.contains(needle), "{needle}");
        }
        assert_eq!(text, after.atlas.to_json());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_update_and_remove_refuse_the_wrong_identifier_state() {
        let root = temp_root("identity");
        let seeded = seeded(&root);
        let unknown = update_entry(&root, &seeded.revision, entry("ghost", "person"), &none());
        assert_eq!(
            codes(unknown.unwrap_err()),
            vec![AtlasDiagnosticCode::UnknownEntry]
        );
        // Entries and relationships share one identifier space.
        for clash in [
            create_entry(&root, &seeded.revision, entry("r1", "person"), &none()),
            create_entry(&root, &seeded.revision, entry("stoa", "movement"), &none()),
            create_relationship(
                &root,
                &seeded.revision,
                relationship("stoa", "plato-p", "stoa", json!([{"source": "scholar"}])),
                &none(),
            ),
        ] {
            assert_eq!(
                codes(clash.unwrap_err()),
                vec![AtlasDiagnosticCode::DuplicateId]
            );
        }
        let mut retyped = entry("stoa", "concept");
        retyped.label = "Stoa".into();
        assert_eq!(
            codes(update_entry(&root, &seeded.revision, retyped, &none()).unwrap_err()),
            vec![AtlasDiagnosticCode::EndpointKind]
        );
        let linked = remove_entry(&root, &seeded.revision, "stoa", &none());
        assert_eq!(
            codes(linked.unwrap_err()),
            vec![AtlasDiagnosticCode::StillLinked]
        );
        assert_eq!(
            fs::read(file(&root)).unwrap(),
            seeded.atlas.to_json().as_bytes()
        );
        let gone = remove_relationship(&root, &seeded.revision, "r1", &none()).unwrap();
        let (after, removal) = remove_entry(&root, &gone.revision, "stoa", &none()).unwrap();
        assert_eq!(removal.entry.id, "stoa");
        assert_eq!(after.atlas.entries.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn broken_references_and_cycles_get_scoped_diagnostics_and_write_nothing() {
        let root = temp_root("diagnostics");
        let seeded = seeded(&root);
        let before = fs::read(file(&root)).unwrap();
        let dangling = create_relationship(
            &root,
            &seeded.revision,
            relationship("r2", "plato-p", "ghost", json!([{"source": "nope"}])),
            &none(),
        )
        .unwrap_err();
        let StoreError::Invalid(found) = dangling else {
            panic!("expected diagnostics")
        };
        let mut fields: Vec<(AtlasDiagnosticCode, Option<&str>, Option<&str>)> = found
            .iter()
            .map(|d| (d.code, d.id.as_deref(), d.field.as_deref()))
            .collect();
        fields.sort_by_key(|(code, ..)| format!("{code}"));
        assert_eq!(
            fields,
            vec![
                (AtlasDiagnosticCode::UnknownEntry, Some("r2"), Some("to")),
                (
                    AtlasDiagnosticCode::UnknownSource,
                    Some("r2"),
                    Some("evidence[0].source")
                ),
            ]
        );
        assert!(found.iter().all(|d| !d.message.contains("<b>")));

        let c1 = create_entry(&root, &seeded.revision, entry("c1", "concept"), &none()).unwrap();
        let c2 = create_entry(&root, &c1.revision, entry("c2", "concept"), &none()).unwrap();
        let edge = |id: &str, from: &str, to: &str| {
            Relationship::from_json(json!({"id": id, "kind": "specializes", "from": from,
                "to": to, "assertedBy": {"kind": "author"}, "unsourced": true}))
            .unwrap()
        };
        let s1 = create_relationship(&root, &c2.revision, edge("s1", "c1", "c2"), &none()).unwrap();
        let held = fs::read(file(&root)).unwrap();
        let cycle = create_relationship(&root, &s1.revision, edge("s2", "c2", "c1"), &none());
        assert_eq!(
            codes(cycle.unwrap_err()),
            vec![AtlasDiagnosticCode::Cycle; 2]
        );
        assert_eq!(fs::read(file(&root)).unwrap(), held);
        assert_ne!(held, before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_write_leaves_the_file_alone_and_cleans_up() {
        let root = temp_root("failed");
        let seeded = seeded(&root);
        let before = fs::read(file(&root)).unwrap();
        let failed = change_using(
            &root,
            &seeded.revision,
            &none(),
            &|atlas, links| atlas.upsert_entry(entry("x", "concept"), links),
            |_, _| Err(std::io::Error::other("disk full")),
        );
        assert!(matches!(failed.unwrap_err(), StoreError::Storage(m) if m.contains("unchanged")));
        assert_eq!(fs::read(file(&root)).unwrap(), before);
        assert_eq!(tmp_files(&root), 0);
        assert!(!root
            .join(".openblog/private/research/atlas.json.lock")
            .exists());
        // A leftover from an interrupted write is cleared by the next one.
        fs::write(file(&root).with_extension("json.1-2.tmp"), b"partial").unwrap();
        create_entry(&root, &seeded.revision, entry("x", "concept"), &none()).unwrap();
        assert_eq!(tmp_files(&root), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn damaged_oversized_newer_and_linked_atlases_are_reported_never_replaced() {
        let root = temp_root("damaged");
        with_library(&root);
        let path = file(&root);
        for (bytes, expect_invalid) in [
            (b"{\"version\":1,\"entries\":[{\"id\":".to_vec(), true),
            (b"{\"version\":3,\"entries\":[]}".to_vec(), true),
            (vec![b' '; MAX_ATLAS_BYTES + 1], true),
            (vec![0xff, 0xfe], true),
        ] {
            fs::write(&path, &bytes).unwrap();
            let error = load(&root, &none()).unwrap_err();
            assert_eq!(matches!(error, StoreError::Invalid(_)), expect_invalid);
            assert!(error.to_string().starts_with(ATLAS_FILE), "{error}");
            let revision = source_store::revision(&bytes);
            let attempt = create_entry(&root, &revision, entry("x", "concept"), &none());
            assert!(attempt.is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes, "never replaced");
        }
        fs::write(&path, b"{\"version\":3}").unwrap();
        assert_eq!(
            codes(load(&root, &none()).unwrap_err()),
            vec![AtlasDiagnosticCode::UnsupportedVersion]
        );

        // A directory, or a symlink, where the file belongs is refused.
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(matches!(load(&root, &none()), Err(StoreError::Storage(_))));
        fs::remove_dir(&path).unwrap();
        let target = root.join("elsewhere.json");
        fs::write(&target, Atlas::default().to_json()).unwrap();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&target, &path).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&target, &path).is_ok();
        if linked {
            let error = load(&root, &none()).unwrap_err();
            assert!(error.to_string().contains("symlink"), "{error}");
            let revision = source_store::revision(Atlas::default().to_json().as_bytes());
            assert!(create_entry(&root, &revision, entry("x", "concept"), &none()).is_err());
            assert_eq!(
                fs::read_to_string(&target).unwrap(),
                Atlas::default().to_json()
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_damaged_library_or_notebook_blocks_atlas_changes_without_touching_any_file() {
        let root = temp_root("blocked");
        let seeded = seeded(&root);
        let atlas_bytes = fs::read(file(&root)).unwrap();
        let notebook = root.join(notebook_store::NOTEBOOK_FILE);
        fs::write(&notebook, b"{").unwrap();
        let error = load(&root, &none()).unwrap_err();
        assert!(
            matches!(&error, StoreError::Storage(m) if m.contains("research notebook")),
            "{error:?}"
        );
        assert!(create_entry(&root, &seeded.revision, entry("x", "concept"), &none()).is_err());
        assert_eq!(fs::read(&notebook).unwrap(), b"{");
        fs::remove_file(&notebook).unwrap();

        let library = root.join(source_store::LIBRARY_FILE);
        let library_bytes = fs::read(&library).unwrap();
        fs::write(&library, b"not json").unwrap();
        assert!(matches!(load(&root, &none()), Err(StoreError::Storage(_))));
        assert!(create_entry(&root, &seeded.revision, entry("x", "concept"), &none()).is_err());
        assert_eq!(fs::read(&library).unwrap(), b"not json");
        assert_eq!(fs::read(file(&root)).unwrap(), atlas_bytes);
        fs::write(&library, library_bytes).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_source_the_atlas_uses_cannot_be_removed() {
        let root = temp_root("source-guard");
        let seeded = seeded(&root);
        let mut work = entry("politeia", "work");
        work.source = Some("plato".into());
        create_entry(&root, &seeded.revision, work, &none()).unwrap();
        let library = source_store::load(&root, &none()).unwrap();
        let library_bytes = fs::read(root.join(source_store::LIBRARY_FILE)).unwrap();
        // `ref` is evidence, `scholar` asserts, `plato` is what an entry stands for.
        for (id, user) in [("ref", "r1"), ("scholar", "r1"), ("plato", "politeia")] {
            let refused = source_store::remove(&root, &library.revision, id, &none());
            let Err(source_store::StoreError::Invalid(found)) = refused else {
                panic!("{id} must be refused")
            };
            assert_eq!(
                found[0].code,
                openblog_core::source_library::SourceDiagnosticCode::StillUsed
            );
            assert!(
                found[0].message.contains("Knowledge Atlas") && found[0].message.contains(user),
                "{}",
                found[0].message
            );
        }
        assert_eq!(
            fs::read(root.join(source_store::LIBRARY_FILE)).unwrap(),
            library_bytes
        );
        assert!(source_store::remove(&root, &library.revision, "spare", &none()).is_ok());

        // An atlas that cannot be read blocks removal instead of guessing.
        let library = source_store::load(&root, &none()).unwrap();
        fs::write(file(&root), b"{").unwrap();
        let refused = source_store::remove(&root, &library.revision, "ref", &none());
        assert!(matches!(refused, Err(source_store::StoreError::Invalid(_))));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_library_edit_that_would_break_the_atlas_is_refused() {
        let root = temp_root("library-edit");
        let seeded = seeded(&root);
        let library = source_store::load(&root, &none()).unwrap();
        let library_bytes = fs::read(root.join(source_store::LIBRARY_FILE)).unwrap();
        // Re-pointing `ref` at the work makes the evidence's page 514 ambiguous.
        let mut moved = library.library.get("ref").unwrap().clone();
        moved.of = Some("plato".into());
        let refused = source_store::update(&root, &library.revision, moved, &none());
        let Err(source_store::StoreError::Invalid(found)) = refused else {
            panic!("the change must be refused")
        };
        assert!(
            found[0].message.contains("Knowledge Atlas")
                && found[0].message.contains("ambiguous-locator"),
            "{}",
            found[0].message
        );
        assert_eq!(
            fs::read(root.join(source_store::LIBRARY_FILE)).unwrap(),
            library_bytes
        );
        assert_eq!(
            fs::read(file(&root)).unwrap(),
            seeded.atlas.to_json().as_bytes()
        );
        let mut renamed = library.library.get("slings").unwrap().clone();
        renamed.title = Some("Slings 2003".into());
        assert!(source_store::update(&root, &library.revision, renamed, &none()).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_passage_atlas_evidence_points_to_cannot_be_removed() {
        let root = temp_root("passage-guard");
        let seeded = seeded(&root);
        let book = notebook_store::load(&root, &none()).unwrap();
        let passage = Passage::from_json(
            json!({"id": "p1", "source": "slings", "excerpt": {"text": "quoted"}}),
        )
        .unwrap();
        let book = notebook_store::create_passage(&root, &book.revision, passage, &none()).unwrap();
        let with_pointer = update_relationship(
            &root,
            &seeded.revision,
            relationship(
                "r1",
                "plato-p",
                "stoa",
                json!([{"source": "slings", "passage": "p1"}]),
            ),
            &none(),
        )
        .unwrap();
        assert_eq!(with_pointer.atlas.uses_of_passage("p1"), vec!["r1"]);
        let notebook_bytes = fs::read(root.join(notebook_store::NOTEBOOK_FILE)).unwrap();

        let refused = notebook_store::remove_passage(&root, &book.revision, "p1", &none());
        let Err(notebook_store::StoreError::Invalid(found)) = refused else {
            panic!("the removal must be refused")
        };
        assert_eq!(found[0].code, NoteDiagnosticCode::StillLinked);
        assert_eq!(found[0].id.as_deref(), Some("p1"));
        assert!(found[0].message.contains("r1"), "{}", found[0].message);
        assert!(!found[0].message.contains("quoted"));
        assert_eq!(
            fs::read(root.join(notebook_store::NOTEBOOK_FILE)).unwrap(),
            notebook_bytes
        );
        // The atlas still reads: removing the passage never made it unparseable.
        assert!(load(&root, &none()).is_ok());

        // An unreadable atlas blocks passage removal too, and nothing else.
        let atlas_bytes = fs::read(file(&root)).unwrap();
        fs::write(file(&root), b"{").unwrap();
        assert!(notebook_store::remove_passage(&root, &book.revision, "p1", &none()).is_err());
        let note =
            ResearchNote::from_json(json!({"id": "n1", "kind": "question", "text": "?"})).unwrap();
        let book = notebook_store::create_note(&root, &book.revision, note, &none())
            .expect("an unreadable atlas does not freeze unrelated notebook edits");
        fs::write(file(&root), &atlas_bytes).unwrap();

        // Once the evidence moves to the source, the passage can go.
        let current = load(&root, &none()).unwrap();
        update_relationship(
            &root,
            &current.revision,
            relationship("r1", "plato-p", "stoa", json!([{"source": "slings"}])),
            &none(),
        )
        .unwrap();
        assert!(notebook_store::remove_passage(&root, &book.revision, "p1", &none()).is_ok());
        assert!(load(&root, &none()).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removing_a_linked_concept_reports_its_notes_and_approval_is_reversible() {
        let root = temp_root("concept");
        let seeded = seeded(&root);
        let book = notebook_store::load(&root, &none()).unwrap();
        let note = ResearchNote::from_json(json!({"id": "n1", "kind": "question",
            "text": "?", "concepts": ["virtue"]}))
        .unwrap();
        notebook_store::create_note(&root, &book.revision, note, &none()).unwrap();
        let concept =
            create_entry(&root, &seeded.revision, entry("virtue", "concept"), &none()).unwrap();
        let (after, removal) = remove_entry(&root, &concept.revision, "virtue", &none()).unwrap();
        assert_eq!(removal.unresolved_notes, vec!["n1"]);
        assert_eq!(
            after.atlas.missing_concepts(&after.notebook),
            vec!["virtue"]
        );

        // Approve both entries and the relationship, then withdraw one entry.
        let mut current = after;
        for id in ["plato-p", "stoa"] {
            let mut approved = current.atlas.entry(id).unwrap().clone();
            approved.visibility = Visibility::Approved;
            current = update_entry(&root, &current.revision, approved, &none()).unwrap();
        }
        let mut r = current.atlas.relationship("r1").unwrap().clone();
        r.visibility = Visibility::Approved;
        current = update_relationship(&root, &current.revision, r, &none()).unwrap();
        assert_eq!(current.atlas.projected().1.len(), 1);
        let mut withdrawn = current.atlas.entry("stoa").unwrap().clone();
        withdrawn.visibility = Visibility::Private;
        let current = update_entry(&root, &current.revision, withdrawn, &none())
            .expect("withdrawing approval is never refused");
        assert!(current.atlas.projected().1.is_empty());
        assert_eq!(current.atlas.notices().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_atlas_notebook_and_library_writers_never_deadlock_or_corrupt() {
        let root = temp_root("concurrent");
        seeded(&root);
        let book = notebook_store::load(&root, &none()).unwrap();
        let passage =
            Passage::from_json(json!({"id": "p0", "source": "slings", "excerpt": {"text": "q"}}))
                .unwrap();
        notebook_store::create_passage(&root, &book.revision, passage, &none()).unwrap();
        let started = std::time::Instant::now();
        let mut workers = Vec::new();
        for worker in 0..3 {
            let root = root.clone();
            workers.push(std::thread::spawn(move || {
                let mut done = 0;
                for n in 0..4 {
                    // Retry on conflict, as Admin does after reloading.
                    loop {
                        let current = load(&root, &none()).unwrap();
                        match create_entry(
                            &root,
                            &current.revision,
                            entry(&format!("e{worker}-{n}"), "concept"),
                            &none(),
                        ) {
                            Ok(_) => break,
                            Err(StoreError::Conflict) => continue,
                            Err(other) => panic!("atlas writer: {other}"),
                        }
                    }
                    done += 1;
                }
                done
            }));
        }
        let notebook_root = root.clone();
        let notebook_writer = std::thread::spawn(move || {
            for n in 0..4 {
                loop {
                    let current = notebook_store::load(&notebook_root, &none()).unwrap();
                    let note = ResearchNote::from_json(
                        json!({"id": format!("n{n}"), "kind": "question", "text": "?"}),
                    )
                    .unwrap();
                    match notebook_store::create_note(
                        &notebook_root,
                        &current.revision,
                        note,
                        &none(),
                    ) {
                        Ok(_) => break,
                        Err(notebook_store::StoreError::Conflict) => continue,
                        Err(other) => panic!("notebook writer: {other}"),
                    }
                }
            }
        });
        let library_root = root.clone();
        let library_writer = std::thread::spawn(move || {
            for _ in 0..4 {
                let current = source_store::load(&library_root, &none()).unwrap();
                // Refused while the atlas uses it, every time, whatever else is writing.
                assert!(
                    source_store::remove(&library_root, &current.revision, "ref", &none()).is_err()
                );
            }
        });
        let written: usize = workers.into_iter().map(|w| w.join().unwrap()).sum();
        notebook_writer.join().unwrap();
        library_writer.join().unwrap();
        assert_eq!(written, 12);
        assert!(started.elapsed() < Duration::from_secs(60));
        let atlas = load(&root, &none()).unwrap();
        assert_eq!(atlas.atlas.entries.len(), 2 + 12);
        assert_eq!(atlas.notebook.notes.len(), 4);
        assert_eq!(tmp_files(&root), 0);
        let research = file(&root).parent().unwrap().to_path_buf();
        let locks = fs::read_dir(research)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".lock"))
            .count();
        assert_eq!(locks, 0, "every lock was released");
        fs::remove_dir_all(root).unwrap();
    }
}
