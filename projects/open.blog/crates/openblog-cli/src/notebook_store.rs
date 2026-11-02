//! Private, file-backed storage for the research notebook (passages and notes).
//!
//! The notebook lives at [`NOTEBOOK_FILE`] beside the source library, inside the
//! Git-ignored private directory and outside content, static files, themes, and
//! build output, so no build, feed, search index, or export reads it. Every
//! change names the revision it was based on, is validated by
//! `openblog_core::research_notes` against the source library as stored, and
//! replaces the file by atomic rename while holding locks: a refused, failed,
//! or interrupted change leaves the stored notebook exactly as it was.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use openblog_core::contributor::Contributor;
use openblog_core::research_bundle::{self, ImportPlan};
use openblog_core::research_notes::{
    NoteDiagnostic, NoteDiagnosticCode, Notebook, Passage, ResearchNote, MAX_NOTEBOOK_BYTES,
};
use openblog_core::source_library::SourceLibrary;

use crate::source_store::{self, StoreError as LibraryError};
use crate::transaction::FileLock;

/// Where the notebook lives, relative to the project root.
pub const NOTEBOOK_FILE: &str = ".openblog/private/research/notebook.json";
const LOCK_WAIT: Duration = Duration::from_secs(2);

/// One read of the notebook and the revision a later change must name.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub notebook: Notebook,
    /// SHA-256 of the stored bytes, or of the empty notebook while none is stored.
    pub revision: String,
    /// False until the first change creates the file.
    pub stored: bool,
    /// The source library the notebook was validated against.
    pub library: SourceLibrary,
}

#[derive(Debug, PartialEq)]
pub enum StoreError {
    /// The notebook changed after the caller read the revision it named.
    Conflict,
    /// The stored notebook or the requested change is invalid. Nothing was written.
    Invalid(Vec<NoteDiagnostic>),
    /// The notebook or the source library could not be located, read, or
    /// written safely. Nothing was written.
    Storage(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict => formatter.write_str(
                "the research notebook changed since it was read; reload it and apply the change again",
            ),
            Self::Invalid(diagnostics) => {
                for (position, diagnostic) in diagnostics.iter().enumerate() {
                    if position > 0 {
                        formatter.write_str("\n")?;
                    }
                    write!(formatter, "{NOTEBOOK_FILE}: {diagnostic}")?;
                }
                Ok(())
            }
            Self::Storage(message) => formatter.write_str(message),
        }
    }
}

/// A damaged or unreadable source library blocks research changes: the
/// notebook cannot be checked against it.
fn library_blocked(error: LibraryError) -> StoreError {
    match error {
        LibraryError::Storage(message) => StoreError::Storage(message),
        other => StoreError::Storage(format!(
            "the source library cannot be read, so the notebook cannot be checked against it: {other}"
        )),
    }
}

/// Read and validate the notebook against the stored source library. An
/// absent notebook is empty, and reading never creates a file or directory.
pub fn load(
    root: &Path,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    let library = source_store::load(root, contributors)
        .map_err(library_blocked)?
        .library;
    read(root, library)
}

/// The notebook entries that use a source, for the library's removal guard.
/// An unreadable notebook blocks removal with a message instead of guessing.
pub fn entries_using_source(
    root: &Path,
    library: &SourceLibrary,
    source: &str,
) -> Result<Vec<String>, String> {
    read(root, library.clone())
        .map(|snapshot| snapshot.notebook.entries_using_source(source))
        .map_err(|error| {
            format!("the research notebook cannot be checked ({error}); repair it before removing a source")
        })
}

/// Whether the stored notebook is still valid against a library that is about
/// to replace the stored one. An absent notebook always is.
pub fn check_against_library(root: &Path, library: &SourceLibrary) -> Result<(), String> {
    read(root, library.clone())
        .map(|_| ())
        .map_err(|error| error.to_string())
}

type Edit<'a, T> = dyn Fn(&mut Notebook, &SourceLibrary) -> Result<T, Vec<NoteDiagnostic>> + 'a;

/// Add a passage whose identifier is not yet in the notebook.
pub fn create_passage(
    root: &Path,
    expected_revision: &str,
    passage: Passage,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(
        root,
        expected_revision,
        contributors,
        &|notebook, library| {
            if let Some(diagnostic) = in_use(notebook, "passages", &passage.id) {
                return Err(vec![diagnostic]);
            }
            notebook.upsert_passage(passage.clone(), library)
        },
    )
}

/// Replace the passage with the same identifier. Its source cannot change.
pub fn update_passage(
    root: &Path,
    expected_revision: &str,
    passage: Passage,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(
        root,
        expected_revision,
        contributors,
        &|notebook, library| {
            if notebook.passage(&passage.id).is_none() {
                return Err(vec![unknown_entry("passages", &passage.id)]);
            }
            notebook.upsert_passage(passage.clone(), library)
        },
    )
}

/// Add a note whose identifier is not yet in the notebook.
pub fn create_note(
    root: &Path,
    expected_revision: &str,
    note: ResearchNote,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(
        root,
        expected_revision,
        contributors,
        &|notebook, library| {
            if let Some(diagnostic) = in_use(notebook, "notes", &note.id) {
                return Err(vec![diagnostic]);
            }
            notebook.upsert_note(note.clone(), library)
        },
    )
}

/// Replace the note with the same identifier.
pub fn update_note(
    root: &Path,
    expected_revision: &str,
    note: ResearchNote,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(
        root,
        expected_revision,
        contributors,
        &|notebook, library| {
            if notebook.note(&note.id).is_none() {
                return Err(vec![unknown_entry("notes", &note.id)]);
            }
            notebook.upsert_note(note.clone(), library)
        },
    )
}

/// Remove a passage no note links to and no Knowledge Atlas evidence points
/// to. An atlas that cannot be read blocks removal, since it cannot be shown
/// to be free of pointers into the passage.
pub fn remove_passage(
    root: &Path,
    expected_revision: &str,
    id: &str,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(
        root,
        expected_revision,
        contributors,
        &|notebook, library| {
            let blocked = |message: String| {
                vec![diagnostic(
                    NoteDiagnosticCode::StillLinked,
                    "passages",
                    id,
                    None,
                    message,
                )]
            };
            let using = crate::atlas_store::uses_of_passage(root, library, notebook, id)
                .map_err(blocked)?;
            if !using.is_empty() {
                return Err(blocked(format!(
                    "{} Knowledge Atlas item{} cite{} this passage as evidence ({}); change or remove that evidence first",
                    using.len(),
                    if using.len() == 1 { "" } else { "s" },
                    if using.len() == 1 { "s" } else { "" },
                    using.join(", ")
                )));
            }
            let using = crate::claims_store::uses_of_passage(root, library, notebook, id)
                .map_err(blocked)?;
            if !using.is_empty() {
                return Err(blocked(format!(
                    "{} evidence link{} in the claims file rest{} on this passage ({}); change or remove {} first",
                    using.len(),
                    if using.len() == 1 { "" } else { "s" },
                    if using.len() == 1 { "s" } else { "" },
                    using.join(", "),
                    if using.len() == 1 { "it" } else { "them" },
                )));
            }
            let using = crate::alignment_store::uses_of_passage(root, library, notebook, id)
                .map_err(blocked)?;
            if !using.is_empty() {
                return Err(blocked(format!(
                    "{} passage alignment{} use{} this passage ({}); change or remove {} first",
                    using.len(),
                    if using.len() == 1 { "" } else { "s" },
                    if using.len() == 1 { "s" } else { "" },
                    using.join(", "),
                    if using.len() == 1 { "it" } else { "them" },
                )));
            }
            notebook.remove_passage(id, library).map(|_| ())
        },
    )
}

/// Remove a note.
pub fn remove_note(
    root: &Path,
    expected_revision: &str,
    id: &str,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(
        root,
        expected_revision,
        contributors,
        &|notebook, library| notebook.remove_note(id, library).map(|_| ()),
    )
}

/// Archive or restore one entry without touching any other field. Archiving
/// only sets the entry aside: it stays in the file, in exports and in search on
/// request, and a linked passage is still protected from removal.
pub fn set_archived(
    root: &Path,
    expected_revision: &str,
    collection: Collection,
    id: &str,
    archived: bool,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(
        root,
        expected_revision,
        contributors,
        &|notebook, library| match collection {
            Collection::Passages => {
                let mut passage = notebook
                    .passage(id)
                    .cloned()
                    .ok_or_else(|| vec![unknown_entry("passages", id)])?;
                passage.archived = archived;
                notebook.upsert_passage(passage, library)
            }
            Collection::Notes => {
                let mut note = notebook
                    .note(id)
                    .cloned()
                    .ok_or_else(|| vec![unknown_entry("notes", id)])?;
                note.archived = archived;
                notebook.upsert_note(note, library)
            }
        },
    )
}

/// Which list an entry lives in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Collection {
    Passages,
    Notes,
}

/// Apply a research bundle: add the entries it carries that the notebook does
/// not have. The plan is rebuilt from the notebook as stored under the lock, so
/// it can never describe a stale notebook, and any conflict refuses the whole
/// import before anything is written.
pub fn import_bundle(
    root: &Path,
    expected_revision: &str,
    text: &str,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<(Snapshot, ImportPlan), StoreError> {
    let plan = std::cell::RefCell::new(None);
    let snapshot = change(
        root,
        expected_revision,
        contributors,
        &|notebook, library| {
            let found = research_bundle::plan_import(notebook, library, text)?;
            *notebook = found.apply(notebook, library)?;
            *plan.borrow_mut() = Some(found);
            Ok(())
        },
    )?;
    let plan = plan
        .into_inner()
        .ok_or_else(|| StoreError::Storage("the import produced no plan".into()))?;
    Ok((snapshot, plan))
}

fn diagnostic(
    code: NoteDiagnosticCode,
    collection: &'static str,
    id: &str,
    field: Option<&str>,
    message: String,
) -> NoteDiagnostic {
    NoteDiagnostic {
        code,
        collection: Some(collection),
        index: None,
        id: Some(id.into()),
        field: field.map(str::to_string),
        message,
    }
}

fn unknown_entry(collection: &'static str, id: &str) -> NoteDiagnostic {
    diagnostic(
        NoteDiagnosticCode::UnknownEntry,
        collection,
        id,
        None,
        format!("no {collection} entry has the id `{id}`"),
    )
}

/// Creating refuses an identifier any entry already uses, scoped to the
/// collection being created in.
fn in_use(notebook: &Notebook, collection: &'static str, id: &str) -> Option<NoteDiagnostic> {
    (notebook.passage(id).is_some() || notebook.note(id).is_some()).then(|| {
        diagnostic(
            NoteDiagnosticCode::DuplicateId,
            collection,
            id,
            Some("id"),
            format!("`{id}` is already used by an entry; edit it or choose another id"),
        )
    })
}

/// Apply one edit while holding the notebook and library locks. The edit sees
/// the notebook and library as stored, and nothing is written unless the
/// stored revision matches, the stored notebook is valid, and the edited
/// notebook is valid. While nothing is stored the edit is first tried without
/// the lock, so a refused change never creates private directories.
fn change(
    root: &Path,
    expected_revision: &str,
    contributors: &BTreeMap<String, Contributor>,
    edit: &Edit<'_, ()>,
) -> Result<Snapshot, StoreError> {
    change_using(root, expected_revision, contributors, edit, |from, to| {
        crate::fsutil::replace_file(from, to)
    })
}

fn change_using(
    root: &Path,
    expected_revision: &str,
    contributors: &BTreeMap<String, Contributor>,
    edit: &Edit<'_, ()>,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<Snapshot, StoreError> {
    let path = notebook_path(root)?;
    let directory = path
        .parent()
        .ok_or_else(|| StoreError::Storage("the research notebook has no directory".into()))?;
    if !directory.is_dir() {
        let current = load(root, contributors)?;
        let mut notebook = checked(&current, expected_revision)?;
        edit(&mut notebook, &current.library).map_err(StoreError::Invalid)?;
        source_store::create_private_directory(directory).map_err(storage)?;
    }
    // Check again now that every directory exists.
    let _lock = lock_notebook(root)?;
    // The library lock is taken second, everywhere, so a source removal that
    // checks the notebook cannot interleave with this write. Knowledge Atlas
    // and claims writes take their own lock before both, so the atlas and
    // claims reads below are stable.
    let _library_lock = source_store::lock_library(root).map_err(library_blocked)?;

    let current = load(root, contributors)?;
    let mut notebook = checked(&current, expected_revision)?;
    edit(&mut notebook, &current.library).map_err(StoreError::Invalid)?;
    keep_atlas_valid(root, &current, &notebook)?;
    keep_claims_valid(root, &current, &notebook)?;
    keep_alignments_valid(root, &current, &notebook)?;
    let text = notebook.to_json();
    commit(&path, text.as_bytes(), rename)?;
    source_store::remove_interrupted_writes(&path);
    Ok(Snapshot {
        notebook,
        revision: source_store::revision(text.as_bytes()),
        stored: true,
        library: current.library,
    })
}

/// Take the notebook's write lock. The Knowledge Atlas and the claims file
/// take it after their own and before the library's, the one order every
/// store uses.
pub(crate) fn lock_notebook(root: &Path) -> Result<FileLock, StoreError> {
    let path = notebook_path(root)?;
    FileLock::acquire(lock_path(&path), "research notebook write", LOCK_WAIT)
        .map_err(StoreError::Storage)
}

/// A notebook change must not leave a valid claims file invalid, for example
/// by moving a passage an evidence link points to. As for the atlas, a claims
/// file that was already unreadable does not block unrelated edits.
fn keep_claims_valid(root: &Path, current: &Snapshot, edited: &Notebook) -> Result<(), StoreError> {
    if crate::claims_store::check_against(root, &current.library, &current.notebook).is_err() {
        return Ok(());
    }
    crate::claims_store::check_against(root, &current.library, edited).map_err(|message| {
        StoreError::Invalid(vec![NoteDiagnostic {
            code: NoteDiagnosticCode::StillLinked,
            collection: None,
            index: None,
            id: None,
            field: None,
            message: format!(
                "the change would leave the claims file invalid, so nothing was saved ({message}); change the evidence links first"
            ),
        }])
    })
}

/// A notebook change must not leave a valid alignments file invalid. As for
/// the claims file, one that was already unreadable does not block unrelated
/// edits.
fn keep_alignments_valid(
    root: &Path,
    current: &Snapshot,
    edited: &Notebook,
) -> Result<(), StoreError> {
    if crate::alignment_store::check_against(root, &current.library, &current.notebook).is_err() {
        return Ok(());
    }
    crate::alignment_store::check_against(root, &current.library, edited).map_err(|message| {
        StoreError::Invalid(vec![NoteDiagnostic {
            code: NoteDiagnosticCode::StillLinked,
            collection: None,
            index: None,
            id: None,
            field: None,
            message: format!(
                "the change would leave the alignments file invalid, so nothing was saved ({message}); change the alignments first"
            ),
        }])
    })
}

/// A notebook change must not leave a valid Knowledge Atlas invalid, for
/// example by removing a passage its evidence points to. An atlas that was
/// already unreadable does not block unrelated notebook edits; it is reported
/// when it is next read (and still blocks removing a passage).
fn keep_atlas_valid(root: &Path, current: &Snapshot, edited: &Notebook) -> Result<(), StoreError> {
    if crate::atlas_store::check_against(root, &current.library, &current.notebook).is_err() {
        return Ok(());
    }
    crate::atlas_store::check_against(root, &current.library, edited).map_err(|message| {
        StoreError::Invalid(vec![NoteDiagnostic {
            code: NoteDiagnosticCode::StillLinked,
            collection: None,
            index: None,
            id: None,
            field: None,
            message: format!(
                "the change would leave the Knowledge Atlas invalid, so nothing was saved ({message}); change the atlas first"
            ),
        }])
    })
}

fn storage(error: LibraryError) -> StoreError {
    StoreError::Storage(error.to_string())
}

fn checked(current: &Snapshot, expected_revision: &str) -> Result<Notebook, StoreError> {
    if current.revision != expected_revision {
        return Err(StoreError::Conflict);
    }
    Ok(current.notebook.clone())
}

/// Read and validate the stored notebook against `library`, never creating anything.
pub(crate) fn read(root: &Path, library: SourceLibrary) -> Result<Snapshot, StoreError> {
    let path = notebook_path(root)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let notebook = Notebook::default();
            return Ok(Snapshot {
                revision: source_store::revision(notebook.to_json().as_bytes()),
                notebook,
                stored: false,
                library,
            });
        }
        Err(error) => {
            return Err(StoreError::Storage(format!(
                "cannot inspect {NOTEBOOK_FILE}: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(StoreError::Storage(format!(
            "{NOTEBOOK_FILE} is a symlink; replace it with a regular file"
        )));
    }
    if !metadata.is_file() {
        return Err(StoreError::Storage(format!(
            "{NOTEBOOK_FILE} is not a regular file"
        )));
    }
    if metadata.len() > MAX_NOTEBOOK_BYTES as u64 {
        return Err(StoreError::Invalid(vec![too_large()]));
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .and_then(|file| {
            file.take(MAX_NOTEBOOK_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| StoreError::Storage(format!("cannot read {NOTEBOOK_FILE}: {error}")))?;
    if bytes.len() > MAX_NOTEBOOK_BYTES {
        return Err(StoreError::Invalid(vec![too_large()]));
    }
    let revision = source_store::revision(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| {
        StoreError::Invalid(vec![NoteDiagnostic {
            code: NoteDiagnosticCode::InvalidJson,
            collection: None,
            index: None,
            id: None,
            field: None,
            message: "the notebook is not valid UTF-8".into(),
        }])
    })?;
    let notebook = Notebook::parse(&text, &library).map_err(StoreError::Invalid)?;
    Ok(Snapshot {
        notebook,
        revision,
        stored: true,
        library,
    })
}

fn too_large() -> NoteDiagnostic {
    NoteDiagnostic {
        code: NoteDiagnosticCode::TooLarge,
        collection: None,
        index: None,
        id: None,
        field: None,
        message: format!("the notebook is larger than {MAX_NOTEBOOK_BYTES} bytes"),
    }
}

fn notebook_path(root: &Path) -> Result<PathBuf, StoreError> {
    source_store::contained(root, Path::new(NOTEBOOK_FILE)).map_err(storage)
}

fn lock_path(path: &Path) -> PathBuf {
    path.with_extension("json.lock")
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
        let _ = fs::remove_file(&temporary);
        return Err(StoreError::Storage(format!(
            "could not save the research notebook ({error}); the stored notebook is unchanged"
        )));
    }
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        // Best effort: the rename has already replaced the notebook.
        let _ = fs::File::open(parent).and_then(|directory| directory.sync_all());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_root(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "openblog-notebook-{tag}-{}-{unique}",
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
            {"id": "slings", "kind": "edition", "of": "plato", "title": "Slings"}]});
        fs::write(path, library.to_string()).unwrap();
    }

    fn passage(id: &str, source: &str) -> Passage {
        Passage::from_json(json!({"id": id, "source": source,
            "excerpt": {"text": "<img src=x onerror=alert(1)> ὁ δὲ"},
            "locators": [{"kind": "page", "value": "514"}]}))
        .unwrap()
    }

    fn note(id: &str, passages: &[&str], sources: &[&str]) -> ResearchNote {
        ResearchNote::from_json(json!({"id": id, "kind": "question", "text": "Why?",
            "passages": passages, "sources": sources}))
        .unwrap()
    }

    fn file(root: &Path) -> PathBuf {
        root.join(NOTEBOOK_FILE)
    }

    #[test]
    fn an_absent_notebook_loads_empty_without_creating_directories() {
        let root = temp_root("absent");
        let snapshot = load(&root, &none()).unwrap();
        assert!(!snapshot.stored && snapshot.notebook.passages.is_empty());
        assert!(!root.join(".openblog").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changes_are_revision_checked_and_deterministic() {
        let root = temp_root("changes");
        with_library(&root);
        let empty = load(&root, &none()).unwrap();
        let first =
            create_passage(&root, &empty.revision, passage("p1", "slings"), &none()).unwrap();
        assert!(first.stored);
        let bytes = fs::read(file(&root)).unwrap();
        assert_eq!(bytes, first.notebook.to_json().as_bytes());
        assert_eq!(first.revision, source_store::revision(&bytes));

        // A stale revision is a conflict and writes nothing.
        let stale = create_note(&root, &empty.revision, note("n1", &["p1"], &[]), &none());
        assert_eq!(stale.unwrap_err(), StoreError::Conflict);
        assert_eq!(fs::read(file(&root)).unwrap(), bytes);

        let second = create_note(
            &root,
            &first.revision,
            note("n1", &["p1"], &["plato"]),
            &none(),
        )
        .unwrap();
        assert_ne!(second.revision, first.revision);
        // An edit outside open.blog also changes the revision.
        let edited = fs::read_to_string(file(&root))
            .unwrap()
            .replace("Why?", "Hand");
        fs::write(file(&root), edited).unwrap();
        let outside = update_note(&root, &second.revision, note("n1", &["p1"], &[]), &none());
        assert_eq!(outside.unwrap_err(), StoreError::Conflict);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_and_update_refuse_the_wrong_identifier_state() {
        let root = temp_root("identity");
        with_library(&root);
        let empty = load(&root, &none()).unwrap();
        let unknown = update_passage(&root, &empty.revision, passage("p1", "slings"), &none());
        let StoreError::Invalid(found) = unknown.unwrap_err() else {
            panic!("expected diagnostics")
        };
        assert_eq!(found[0].code, NoteDiagnosticCode::UnknownEntry);
        let created =
            create_passage(&root, &empty.revision, passage("p1", "slings"), &none()).unwrap();
        let again = create_passage(&root, &created.revision, passage("p1", "slings"), &none());
        let StoreError::Invalid(found) = again.unwrap_err() else {
            panic!("expected diagnostics")
        };
        assert_eq!(found[0].code, NoteDiagnosticCode::DuplicateId);
        // Passages and notes share one identifier space.
        let clash = create_note(&root, &created.revision, note("p1", &[], &[]), &none());
        assert!(matches!(clash.unwrap_err(), StoreError::Invalid(_)));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_source_or_failed_write_leaves_the_file_and_directories_alone() {
        let root = temp_root("refused");
        let empty = load(&root, &none()).unwrap();
        let refused = create_passage(&root, &empty.revision, passage("p1", "absent"), &none());
        let StoreError::Invalid(found) = refused.unwrap_err() else {
            panic!("expected diagnostics")
        };
        assert_eq!(found[0].code, NoteDiagnosticCode::UnknownSource);
        assert_eq!(found[0].id.as_deref(), Some("p1"));
        assert!(!root
            .join(".openblog/private/research/notebook.json")
            .exists());

        with_library(&root);
        let created =
            create_passage(&root, &empty.revision, passage("p1", "slings"), &none()).unwrap();
        let before = fs::read(file(&root)).unwrap();
        let failed = change_using(
            &root,
            &created.revision,
            &none(),
            &|notebook, library| notebook.upsert_note(note("n1", &[], &[]), library),
            |_, _| Err(std::io::Error::other("disk full")),
        );
        assert!(matches!(failed.unwrap_err(), StoreError::Storage(_)));
        assert_eq!(fs::read(file(&root)).unwrap(), before);
        let leftovers = fs::read_dir(file(&root).parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn damaged_notebooks_and_symlinks_are_reported_never_replaced() {
        let root = temp_root("damaged");
        with_library(&root);
        let path = file(&root);
        fs::write(&path, b"{\"version\":1,\"notes\":[{\"id\":").unwrap();
        let error = load(&root, &none()).unwrap_err();
        assert!(error.to_string().starts_with(NOTEBOOK_FILE), "{error}");
        let before = fs::read(&path).unwrap();
        let revision = source_store::revision(&before);
        let attempt = create_note(&root, &revision, note("n1", &[], &[]), &none());
        assert!(matches!(attempt.unwrap_err(), StoreError::Invalid(_)));
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::write(&path, vec![b' '; MAX_NOTEBOOK_BYTES + 1]).unwrap();
        assert!(matches!(
            load(&root, &none()).unwrap_err(),
            StoreError::Invalid(found) if found[0].code == NoteDiagnosticCode::TooLarge
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_damaged_library_blocks_notebook_changes_without_touching_either_file() {
        let root = temp_root("library-damaged");
        let path = root.join(source_store::LIBRARY_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not json").unwrap();
        let error = load(&root, &none()).unwrap_err();
        assert!(matches!(error, StoreError::Storage(_)), "{error:?}");
        let attempt = create_note(&root, "x", note("n1", &[], &[]), &none());
        assert!(matches!(attempt.unwrap_err(), StoreError::Storage(_)));
        assert_eq!(fs::read(&path).unwrap(), b"not json");
        assert!(!file(&root).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_source_in_use_cannot_be_removed_until_the_research_is_gone() {
        let root = temp_root("source-guard");
        with_library(&root);
        let empty = load(&root, &none()).unwrap();
        let with_passage =
            create_passage(&root, &empty.revision, passage("p1", "slings"), &none()).unwrap();
        let with_note = create_note(
            &root,
            &with_passage.revision,
            note("n1", &[], &["plato"]),
            &none(),
        )
        .unwrap();
        let library = source_store::load(&root, &none()).unwrap();
        let library_bytes = fs::read(root.join(source_store::LIBRARY_FILE)).unwrap();

        // `slings` is quoted by p1 and `plato` is noted by n1.
        for id in ["slings", "plato"] {
            let refused = source_store::remove(&root, &library.revision, id, &none());
            let Err(source_store::StoreError::Invalid(found)) = refused else {
                panic!("{id} must be refused")
            };
            assert_eq!(
                found[0].code,
                openblog_core::source_library::SourceDiagnosticCode::StillUsed
            );
            assert_eq!(found[0].source_id.as_deref(), Some(id));
        }
        assert_eq!(
            fs::read(root.join(source_store::LIBRARY_FILE)).unwrap(),
            library_bytes
        );

        let after_note = remove_note(&root, &with_note.revision, "n1", &none()).unwrap();
        // `plato` is still the parent of `slings`, so the library refuses it.
        assert!(source_store::remove(&root, &library.revision, "plato", &none()).is_err());
        remove_passage(&root, &after_note.revision, "p1", &none()).unwrap();
        let removed = source_store::remove(&root, &library.revision, "slings", &none());
        assert!(removed.is_ok(), "{removed:?}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_unreadable_notebook_blocks_source_removal() {
        let root = temp_root("source-guard-damaged");
        with_library(&root);
        fs::write(file(&root), b"{").unwrap();
        let library = source_store::load(&root, &none()).unwrap();
        let refused = source_store::remove(&root, &library.revision, "slings", &none());
        assert!(matches!(refused, Err(source_store::StoreError::Invalid(_))));
        assert!(root.join(source_store::LIBRARY_FILE).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removing_a_passage_a_note_links_to_is_refused() {
        let root = temp_root("linked");
        with_library(&root);
        let empty = load(&root, &none()).unwrap();
        let a = create_passage(&root, &empty.revision, passage("p1", "slings"), &none()).unwrap();
        let b = create_note(&root, &a.revision, note("n1", &["p1"], &[]), &none()).unwrap();
        let refused = remove_passage(&root, &b.revision, "p1", &none());
        let StoreError::Invalid(found) = refused.unwrap_err() else {
            panic!("expected diagnostics")
        };
        assert_eq!(found[0].code, NoteDiagnosticCode::StillLinked);
        assert_eq!(
            fs::read(file(&root)).unwrap(),
            b.notebook.to_json().as_bytes()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archiving_sets_an_entry_aside_without_losing_or_unlinking_anything() {
        let root = temp_root("archive");
        with_library(&root);
        let empty = load(&root, &none()).unwrap();
        let one = create_passage(&root, &empty.revision, passage("p1", "slings"), &none()).unwrap();
        let two = create_note(&root, &one.revision, note("n1", &["p1"], &[]), &none()).unwrap();

        let stale = set_archived(
            &root,
            &empty.revision,
            Collection::Notes,
            "n1",
            true,
            &none(),
        );
        assert_eq!(stale, Err(StoreError::Conflict));
        let missing = set_archived(
            &root,
            &two.revision,
            Collection::Notes,
            "ghost",
            true,
            &none(),
        );
        assert!(matches!(missing, Err(StoreError::Invalid(_))));
        let before = fs::read(file(&root)).unwrap();

        let archived = set_archived(
            &root,
            &two.revision,
            Collection::Passages,
            "p1",
            true,
            &none(),
        )
        .unwrap();
        assert!(archived.notebook.passage("p1").unwrap().archived);
        assert_eq!(
            archived.notebook.passages[0].excerpt.text,
            two.notebook.passages[0].excerpt.text
        );
        assert!(fs::read_to_string(file(&root))
            .unwrap()
            .contains("\"archived\": true"));
        // Archived is not removed: the note's link still protects the passage.
        assert!(matches!(
            remove_passage(&root, &archived.revision, "p1", &none()),
            Err(StoreError::Invalid(_))
        ));
        let restored = set_archived(
            &root,
            &archived.revision,
            Collection::Passages,
            "p1",
            false,
            &none(),
        )
        .unwrap();
        assert_eq!(
            fs::read(file(&root)).unwrap(),
            before,
            "restoring is byte-identical"
        );
        assert!(!restored.notebook.passage("p1").unwrap().archived);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn importing_a_bundle_is_atomic_idempotent_and_conflicts_leave_the_file_alone() {
        let root = temp_root("bundle");
        with_library(&root);
        let empty = load(&root, &none()).unwrap();
        let one = create_passage(&root, &empty.revision, passage("p1", "slings"), &none()).unwrap();
        let two = create_note(&root, &one.revision, note("n1", &["p1"], &[]), &none()).unwrap();
        let bundle = research_bundle::export(&two.notebook, &two.library).content;

        // Into a fresh project: everything is created, byte-identically.
        let other = temp_root("bundle-target");
        with_library(&other);
        let target = load(&other, &none()).unwrap();
        assert!(!file(&other).exists());
        let (saved, plan) = import_bundle(&other, &target.revision, &bundle, &none()).unwrap();
        assert_eq!(plan.counts.create, 2);
        assert_eq!(
            fs::read(file(&other)).unwrap(),
            fs::read(file(&root)).unwrap()
        );
        assert_eq!(saved.notebook, two.notebook);

        // The same bundle again plans nothing, and a stale revision is refused.
        let again = plan_only(&other, &bundle);
        assert_eq!(again.counts.unchanged, 2);
        assert!(!again.has_changes());
        assert_eq!(
            import_bundle(&other, &target.revision, &bundle, &none()).err(),
            Some(StoreError::Conflict)
        );

        // A conflicting id refuses everything and writes nothing.
        let held = fs::read(file(&other)).unwrap();
        let edited = update_note(
            &other,
            &saved.revision,
            ResearchNote::from_json(json!({"id": "n1", "kind": "question", "text": "Changed"}))
                .unwrap(),
            &none(),
        )
        .unwrap();
        let blocked = import_bundle(&other, &edited.revision, &bundle, &none());
        let Err(StoreError::Invalid(found)) = blocked else {
            panic!("a conflict must refuse the import")
        };
        assert_eq!(found[0].id.as_deref(), Some("n1"));
        assert_ne!(fs::read(file(&other)).unwrap(), held);
        assert_eq!(
            fs::read(file(&other)).unwrap(),
            edited.notebook.to_json().as_bytes()
        );

        // Garbage never reaches the file, and a refused import creates no directories.
        let clean = temp_root("bundle-clean");
        with_library(&clean);
        let start = load(&clean, &none()).unwrap();
        assert!(import_bundle(&clean, &start.revision, "{}", &none()).is_err());
        assert!(
            !file(&clean).exists()
                && !file(&clean)
                    .parent()
                    .unwrap()
                    .join("notebook.json.lock")
                    .exists()
        );
        for dir in [root, other, clean] {
            fs::remove_dir_all(dir).unwrap();
        }
    }

    fn plan_only(root: &Path, bundle: &str) -> ImportPlan {
        let snapshot = load(root, &none()).unwrap();
        research_bundle::plan_import(&snapshot.notebook, &snapshot.library, bundle).unwrap()
    }
}
