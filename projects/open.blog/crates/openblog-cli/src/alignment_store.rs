//! Private, file-backed storage for passage alignments (ADR 0088, ADR 0089).
//!
//! The alignments file lives at [`ALIGNMENTS_FILE`] beside the source
//! library, the research notebook, the Knowledge Atlas and the claims file,
//! inside the Git-ignored private directory and outside content, static
//! files, themes and build output, so no build, feed, search index,
//! `llms.txt`, export or generated page reads it. It points into the library
//! (sources and interpretations) and the notebook (passages) and copies
//! neither. Every change names the revision it was based on, is validated by
//! `openblog_core::alignment` against the library and notebook as stored, and
//! replaces the file by atomic rename while holding locks: a refused, failed
//! or interrupted change leaves the stored file exactly as it was.
//!
//! Locks are always taken in one order: atlas, claims, alignments, notebook,
//! library (ADR 0089). An alignments write takes alignments, notebook and
//! library; it never takes the atlas or claims lock, and their writers never
//! take this one, so no two writers can wait on each other. Notebook and
//! library changes take a suffix of the order and only *read* the alignments
//! file, which is safe because an alignments write holds their locks for its
//! whole critical section.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use openblog_core::alignment::{self, Alignment, AlignmentSet, MAX_ALIGNMENTS_BYTES};
use openblog_core::contributor::Contributor;
use openblog_core::knowledge_atlas::{
    AtlasDiagnostic, AtlasDiagnosticCode, DiagnosticSubject, Links,
};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;

use crate::notebook_store;
use crate::source_store::{self, StoreError as LibraryError};
use crate::transaction::FileLock;

/// Where alignments live, relative to the project root.
pub const ALIGNMENTS_FILE: &str = ".openblog/private/research/alignments.json";
const LOCK_WAIT: Duration = Duration::from_secs(2);

/// One read of the alignments file and the revision a later change must name.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub alignments: AlignmentSet,
    /// SHA-256 of the stored bytes, or of the empty file while none is stored.
    pub revision: String,
    /// False until the first change creates the file.
    pub stored: bool,
    /// The source library and notebook the alignments were validated against.
    pub library: SourceLibrary,
    pub notebook: Notebook,
}

#[derive(Debug, PartialEq)]
pub enum StoreError {
    /// The alignments file changed after the caller read the revision it named.
    Conflict,
    /// The stored file or the requested change is invalid. Nothing was written.
    Invalid(Vec<AtlasDiagnostic>),
    /// The alignments file, notebook or library could not be located, read or
    /// written safely. Nothing was written.
    Storage(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict => formatter.write_str(
                "the alignments file changed since it was read; reload it and apply the change again",
            ),
            Self::Invalid(diagnostics) => {
                for (position, diagnostic) in diagnostics.iter().enumerate() {
                    if position > 0 {
                        formatter.write_str("\n")?;
                    }
                    write!(formatter, "{ALIGNMENTS_FILE}: {diagnostic}")?;
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
            "the source library cannot be read, so the alignments file cannot be checked against it: {other}"
        )),
    }
}

fn notebook_blocked(error: notebook_store::StoreError) -> StoreError {
    match error {
        notebook_store::StoreError::Storage(message) => StoreError::Storage(message),
        other => StoreError::Storage(format!(
            "the research notebook cannot be read, so the alignments file cannot be checked against it: {other}"
        )),
    }
}

/// Read and validate the alignments file against the stored library and
/// notebook. An absent file is empty, and reading never creates a file or
/// directory.
pub fn load(
    root: &Path,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    let library = source_store::load(root, contributors)
        .map_err(library_blocked)?
        .library;
    against_library(root, library)
}

/// The alignments file as a build that publishes comparisons reads it
/// (ADR 0092). The library is read as every build reads it, with its
/// interpretations raw (ADR 0087); the alignments are validated against it
/// and the notebook, an interpretation member needing only an entry with its
/// id. Then exactly the interpretations that approved alignments name are
/// validated in full and added to the snapshot's library, so a problem in
/// one that nothing published uses never stops the build, and a problem in
/// one that is published refuses it, naming that id.
pub fn load_for_build(
    root: &Path,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, String> {
    let library = source_store::load_for_build(root, contributors)
        .map_err(|error| library_blocked(error).to_string())?
        .library;
    let snapshot = against_library(root, library).map_err(|error| error.to_string())?;
    interpretations_for_build(snapshot, contributors)
}

/// [`load_for_build`] against a library and notebook already read for a build.
pub fn load_for_build_with(
    root: &Path,
    contributors: &BTreeMap<String, Contributor>,
    library: SourceLibrary,
    notebook: Notebook,
) -> Result<Snapshot, String> {
    let snapshot = read(root, library, notebook).map_err(|error| error.to_string())?;
    interpretations_for_build(snapshot, contributors)
}

fn interpretations_for_build(
    mut snapshot: Snapshot,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, String> {
    let named: std::collections::BTreeSet<String> = snapshot
        .alignments
        .alignments
        .iter()
        .filter(|alignment| alignment.is_approved())
        .flat_map(|alignment| &alignment.members)
        .filter_map(|member| member.interpretation.clone())
        .collect();
    snapshot
        .library
        .validate_interpretations_for_build(&named, contributors)
        .map_err(|failures| {
            failures
                .iter()
                .map(|(id, diagnostics)| {
                    let problems: Vec<String> = diagnostics
                        .iter()
                        .map(|diagnostic| {
                            format!("{}: {diagnostic}", source_store::LIBRARY_FILE)
                        })
                        .collect();
                    format!(
                        "interpretation `{id}`, which an approved comparison publishes, is invalid: {}",
                        problems.join("; ")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        })?;
    Ok(snapshot)
}

/// A library or notebook record whose change may alter a published comparison.
#[derive(Clone, Copy, Debug)]
pub enum PublishedUse<'a> {
    /// A source an approved comparison identifies, cites or attributes to.
    Source(&'a str),
    /// Any source an approved comparison uses, for a change to many records.
    AnySource,
    /// A notebook passage whose wording an approved comparison may quote.
    Passage(&'a str),
}

/// Whether the published comparisons, as a build would read them now, use
/// this record (ADR 0092). An alignments file, library or notebook that
/// cannot be read or projected counts as a use, so the rebuild that follows
/// reports the problem instead of leaving the public pages silently stale.
pub fn publishes(
    root: &Path,
    contributors: &BTreeMap<String, Contributor>,
    used: PublishedUse<'_>,
) -> bool {
    let Ok(snapshot) = load_for_build(root, contributors) else {
        return true;
    };
    if let PublishedUse::Passage(passage) = used {
        return snapshot
            .alignments
            .alignments
            .iter()
            .filter(|alignment| alignment.is_approved())
            .flat_map(|alignment| &alignment.members)
            .any(|member| member.passage.as_deref() == Some(passage));
    }
    let projected = openblog_core::comparison_publication::PublicComparisons::project(
        &snapshot.alignments,
        openblog_core::comparison_publication::ComparisonInputs {
            library: &snapshot.library,
            notebook: &snapshot.notebook,
            contributors,
        },
    );
    match (projected, used) {
        (Err(_), _) => true,
        (Ok(public), PublishedUse::Source(source)) => public.source(source).is_some(),
        (Ok(public), _) => !public.sources.is_empty(),
    }
}

fn against_library(root: &Path, library: SourceLibrary) -> Result<Snapshot, StoreError> {
    let notebook = notebook_store::read(root, library.clone())
        .map_err(notebook_blocked)?
        .notebook;
    read(root, library, notebook)
}

/// Alignments that use a source, for the library's removal guard. An
/// alignments file that cannot be read blocks removal instead of guessing.
pub fn uses_of_source(
    root: &Path,
    library: &SourceLibrary,
    source: &str,
) -> Result<Vec<String>, String> {
    against_library(root, library.clone())
        .map(|snapshot| snapshot.alignments.uses_of_source(source))
        .map_err(|error| {
            format!(
                "the alignments file cannot be checked ({error}); repair it before removing a source"
            )
        })
}

/// Alignments that align an interpretation, for its removal guard.
pub fn uses_of_interpretation(
    root: &Path,
    library: &SourceLibrary,
    interpretation: &str,
) -> Result<Vec<String>, String> {
    against_library(root, library.clone())
        .map(|snapshot| snapshot.alignments.uses_of_interpretation(interpretation))
        .map_err(|error| {
            format!(
                "the alignments file cannot be checked ({error}); repair it before removing an interpretation"
            )
        })
}

/// Alignments that point into a notebook passage, for the notebook's removal
/// guard. An alignments file that cannot be read blocks removal.
pub fn uses_of_passage(
    root: &Path,
    library: &SourceLibrary,
    notebook: &Notebook,
    passage: &str,
) -> Result<Vec<String>, String> {
    read(root, library.clone(), notebook.clone())
        .map(|snapshot| snapshot.alignments.uses_of_passage(passage))
        .map_err(|error| {
            format!(
                "the alignments file cannot be checked ({error}); repair it before removing a passage"
            )
        })
}

/// Whether the stored alignments file is valid against this library and
/// notebook. An absent file always is.
pub fn check_against(
    root: &Path,
    library: &SourceLibrary,
    notebook: &Notebook,
) -> Result<(), String> {
    read(root, library.clone(), notebook.clone())
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Whether the stored alignments file is valid against a library that is
/// about to replace the stored one, with the notebook read against it.
pub fn check_against_library(root: &Path, library: &SourceLibrary) -> Result<(), String> {
    against_library(root, library.clone())
        .map(|_| ())
        .map_err(|error| error.to_string())
}

type Edit<'a, T> = dyn Fn(&mut AlignmentSet, Links<'_>) -> Result<T, Vec<AtlasDiagnostic>> + 'a;

/// Add an alignment whose identifier nothing in the file uses yet.
pub fn create_alignment(
    root: &Path,
    expected_revision: &str,
    alignment: Alignment,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, &|set, links| {
        if set.alignment(&alignment.id).is_some() {
            return Err(vec![AtlasDiagnostic {
                subject: DiagnosticSubject::Alignments,
                code: AtlasDiagnosticCode::DuplicateId,
                collection: Some("alignments"),
                index: None,
                id: Some(alignment.id.clone()),
                field: Some("id".into()),
                message: format!(
                    "`{}` is already used by an alignment; edit it or choose another id",
                    alignment.id
                ),
                facts: Vec::new(),
            }]);
        }
        set.upsert_alignment(alignment.clone(), links, false)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Replace the alignment with the same identifier. The approval's recorded
/// places are kept unless `reapprove` says the author checked them again
/// (see [`AlignmentSet::upsert_alignment`]).
pub fn update_alignment(
    root: &Path,
    expected_revision: &str,
    alignment: Alignment,
    reapprove: bool,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, &|set, links| {
        if set.alignment(&alignment.id).is_none() {
            return Err(vec![alignment::unknown(&alignment.id)]);
        }
        set.upsert_alignment(alignment.clone(), links, reapprove)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Remove an alignment. Nothing points at one, so only an unknown id, a
/// stale revision, or a damaged file refuses it.
pub fn remove_alignment(
    root: &Path,
    expected_revision: &str,
    id: &str,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<(Snapshot, Alignment), StoreError> {
    change(root, expected_revision, contributors, &|set, links| {
        set.remove_alignment(id, links)
    })
}

/// Apply one edit while holding the alignments, notebook and library locks,
/// in that order. The edit sees all three as stored, and nothing is written
/// unless the stored revision matches, the stored file is valid, and the
/// edited set is valid. While nothing is stored the edit is first tried
/// without the locks, so a refused change never creates private directories.
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
    let path = alignments_path(root)?;
    let directory = path
        .parent()
        .ok_or_else(|| StoreError::Storage("the alignments file has no directory".into()))?;
    if !directory.is_dir() {
        let current = load(root, contributors)?;
        let mut set = checked(&current, expected_revision)?;
        edit(&mut set, links(&current)).map_err(StoreError::Invalid)?;
        source_store::create_private_directory(directory)
            .map_err(|error| StoreError::Storage(error.to_string()))?;
    }
    // Check again now that every directory exists.
    let path = alignments_path(root)?;
    let _lock = FileLock::acquire(lock_path(&path), "alignments file write", LOCK_WAIT)
        .map_err(StoreError::Storage)?;
    // The alignments file reads both stores, so it holds both of their locks
    // too, after its own: a passage, source or interpretation removal that
    // checks it cannot interleave with this write.
    let _notebook_lock = notebook_store::lock_notebook(root).map_err(notebook_blocked)?;
    let _library_lock = source_store::lock_library(root).map_err(library_blocked)?;

    let current = load(root, contributors)?;
    let mut set = checked(&current, expected_revision)?;
    let outcome = edit(&mut set, links(&current)).map_err(StoreError::Invalid)?;
    let text = set.to_json();
    commit(&path, text.as_bytes(), rename)?;
    source_store::remove_interrupted_writes(&path);
    Ok((
        Snapshot {
            alignments: set,
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

fn checked(current: &Snapshot, expected_revision: &str) -> Result<AlignmentSet, StoreError> {
    if current.revision != expected_revision {
        return Err(StoreError::Conflict);
    }
    Ok(current.alignments.clone())
}

fn file_diagnostic(code: AtlasDiagnosticCode, message: String) -> AtlasDiagnostic {
    AtlasDiagnostic {
        subject: DiagnosticSubject::Alignments,
        code,
        collection: None,
        index: None,
        id: None,
        field: None,
        message,
        facts: Vec::new(),
    }
}

fn too_large() -> AtlasDiagnostic {
    file_diagnostic(
        AtlasDiagnosticCode::TooLarge,
        format!("the alignments file is larger than {MAX_ALIGNMENTS_BYTES} bytes"),
    )
}

fn read(root: &Path, library: SourceLibrary, notebook: Notebook) -> Result<Snapshot, StoreError> {
    let path = alignments_path(root)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let alignments = AlignmentSet::default();
            return Ok(Snapshot {
                revision: source_store::revision(alignments.to_json().as_bytes()),
                alignments,
                stored: false,
                library,
                notebook,
            });
        }
        Err(error) => {
            return Err(StoreError::Storage(format!(
                "cannot inspect {ALIGNMENTS_FILE}: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(StoreError::Storage(format!(
            "{ALIGNMENTS_FILE} is a symlink; replace it with a regular file"
        )));
    }
    if !metadata.is_file() {
        return Err(StoreError::Storage(format!(
            "{ALIGNMENTS_FILE} is not a regular file"
        )));
    }
    if metadata.len() > MAX_ALIGNMENTS_BYTES as u64 {
        return Err(StoreError::Invalid(vec![too_large()]));
    }
    let bytes = crate::fsutil::retry_transient(|| {
        let mut bytes = Vec::new();
        fs::File::open(&path)?
            .take(MAX_ALIGNMENTS_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    })
    .map_err(|error| StoreError::Storage(format!("cannot read {ALIGNMENTS_FILE}: {error}")))?;
    if bytes.len() > MAX_ALIGNMENTS_BYTES {
        return Err(StoreError::Invalid(vec![too_large()]));
    }
    let revision = source_store::revision(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| {
        StoreError::Invalid(vec![file_diagnostic(
            AtlasDiagnosticCode::InvalidJson,
            "the alignments file is not valid UTF-8".into(),
        )])
    })?;
    let alignments = AlignmentSet::parse(
        &text,
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .map_err(StoreError::Invalid)?;
    Ok(Snapshot {
        alignments,
        revision,
        stored: true,
        library,
        notebook,
    })
}

fn alignments_path(root: &Path) -> Result<PathBuf, StoreError> {
    source_store::contained(root, Path::new(ALIGNMENTS_FILE))
        .map_err(|error| StoreError::Storage(error.to_string()))
}

fn lock_path(path: &Path) -> PathBuf {
    path.with_extension("json.lock")
}

/// Take the alignments' write lock, after the atlas's and claims' and before
/// the notebook's, so a store that reads the alignments can hold their
/// writers out.
pub(crate) fn lock_alignments(root: &Path) -> Result<FileLock, StoreError> {
    let path = alignments_path(root)?;
    FileLock::acquire(lock_path(&path), "alignments file write", LOCK_WAIT)
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
            "could not save the alignments file ({error}); the stored file is unchanged"
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
    use openblog_core::interpretation::Interpretation;
    use openblog_core::research_notes::{NoteDiagnosticCode, Passage};
    use openblog_core::source_library::SourceDiagnosticCode;
    use serde_json::json;

    fn temp_root(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "openblog-alignments-{tag}-{}-{unique}",
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
            {"id": "grube", "kind": "translation", "of": "plato", "language": "en", "title": "Republic"},
            {"id": "paris", "kind": "witness", "of": "plato", "title": "Paris gr. 1807"},
            {"id": "ref", "kind": "reference", "of": "slings"},
            {"id": "spare", "kind": "edition", "of": "plato", "title": "Unused"}],
            "interpretations": [{"id": "mine", "kind": "reading", "source": "slings",
                "text": "A reading.", "interpreters": [{"name": "Ada"}]}]});
        fs::write(path, library.to_string()).unwrap();
    }

    fn file(root: &Path) -> PathBuf {
        root.join(ALIGNMENTS_FILE)
    }

    fn alignment(id: &str, members: serde_json::Value) -> Alignment {
        Alignment::from_json(json!({"id": id, "members": members})).unwrap()
    }

    fn pair(id: &str) -> Alignment {
        Alignment::from_json(json!({"id": id, "members": [
            {"source": "slings", "locators": [{"kind": "canonical", "value": "514a"}]},
            {"source": "grube", "locators": [{"kind": "page", "value": "186"}]},
            {"source": "paris", "absent": true}
        ], "evidence": [{"source": "ref", "locators": [{"kind": "page", "value": "514"}]}]}))
        .unwrap()
    }

    fn seeded(root: &Path) -> Snapshot {
        with_library(root);
        let empty = load(root, &none()).unwrap();
        create_alignment(root, &empty.revision, pair("a1"), &none()).unwrap()
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
    fn an_absent_file_loads_empty_without_creating_anything() {
        let root = temp_root("absent");
        let snapshot = load(&root, &none()).unwrap();
        assert!(!snapshot.stored && snapshot.alignments == AlignmentSet::default());
        assert!(!root.join(".openblog").exists());
        // A refused first change creates nothing either.
        let refused = create_alignment(&root, &snapshot.revision, pair("a1"), &none());
        assert_eq!(
            codes(refused.unwrap_err()),
            [
                AtlasDiagnosticCode::UnknownSource,
                AtlasDiagnosticCode::UnknownSource,
                AtlasDiagnosticCode::UnknownSource,
                AtlasDiagnosticCode::UnknownSource
            ]
        );
        assert!(!root.join(".openblog").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changes_are_revision_checked_deterministic_and_lossless() {
        let root = temp_root("changes");
        let seeded = seeded(&root);
        let bytes = fs::read(file(&root)).unwrap();
        assert_eq!(bytes, seeded.alignments.to_json().as_bytes());
        assert_eq!(load(&root, &none()).unwrap(), seeded);
        let stale = create_alignment(&root, "stale", pair("a2"), &none());
        assert_eq!(stale.unwrap_err(), StoreError::Conflict);
        assert_eq!(fs::read(file(&root)).unwrap(), bytes);
        let duplicate = create_alignment(&root, &seeded.revision, pair("a1"), &none());
        assert_eq!(
            codes(duplicate.unwrap_err()),
            [AtlasDiagnosticCode::DuplicateId]
        );
        let ghost = update_alignment(&root, &seeded.revision, pair("ghost"), false, &none());
        assert_eq!(
            codes(ghost.unwrap_err()),
            [AtlasDiagnosticCode::UnknownAlignment]
        );
        assert_eq!(fs::read(file(&root)).unwrap(), bytes);

        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["future"] = json!({"b": 1});
        value["alignments"][0]["members"][0]["x-note"] = json!("kept");
        fs::write(file(&root), value.to_string()).unwrap();
        let outside = load(&root, &none()).unwrap();
        let after = create_alignment(&root, &outside.revision, pair("a2"), &none()).unwrap();
        let text = fs::read_to_string(file(&root)).unwrap();
        for needle in ["\"future\"", "\"x-note\": \"kept\""] {
            assert!(text.contains(needle), "{needle}");
        }
        assert_eq!(text, after.alignments.to_json());
        let (after, removed) = remove_alignment(&root, &after.revision, "a2", &none()).unwrap();
        assert_eq!(removed.id, "a2");
        assert_eq!(after.alignments.alignments.len(), 1);
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
            &|set, links| set.remove_alignment("a1", links).map(|_| ()),
            |_, _| Err(std::io::Error::other("disk full")),
        );
        assert!(matches!(failed.unwrap_err(), StoreError::Storage(m) if m.contains("unchanged")));
        assert_eq!(fs::read(file(&root)).unwrap(), before);
        assert_eq!(tmp_files(&root), 0);
        assert!(!root
            .join(".openblog/private/research/alignments.json.lock")
            .exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn damaged_files_are_reported_never_replaced_and_name_the_alignments_file() {
        let root = temp_root("damaged");
        with_library(&root);
        let path = file(&root);
        for bytes in [
            b"{\"version\":1,\"alignments\":[{\"id\":".to_vec(),
            b"{\"version\":2,\"alignments\":[]}".to_vec(),
            vec![b' '; MAX_ALIGNMENTS_BYTES + 1],
            vec![0xff, 0xfe],
        ] {
            fs::write(&path, &bytes).unwrap();
            let error = load(&root, &none()).unwrap_err();
            assert!(matches!(error, StoreError::Invalid(_)));
            let text = error.to_string();
            assert!(
                text.starts_with(ALIGNMENTS_FILE) && !text.contains("atlas"),
                "{text}"
            );
            let revision = source_store::revision(&bytes);
            assert!(create_alignment(&root, &revision, pair("a1"), &none()).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes, "never replaced");
        }
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(matches!(load(&root, &none()), Err(StoreError::Storage(_))));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sources_passages_and_interpretations_that_alignments_use_cannot_be_removed() {
        let root = temp_root("guards");
        let seeded = seeded(&root);
        let book = notebook_store::load(&root, &none()).unwrap();
        let passage = Passage::from_json(json!({"id": "p1", "source": "grube",
            "excerpt": {"text": "quoted words"}, "locators": [{"kind": "page", "value": "186"}]}))
        .unwrap();
        let book = notebook_store::create_passage(&root, &book.revision, passage, &none()).unwrap();
        let current = create_alignment(
            &root,
            &seeded.revision,
            alignment(
                "a2",
                json!([{"source": "grube", "passage": "p1"}, {"interpretation": "mine"}]),
            ),
            &none(),
        )
        .unwrap();

        let library = source_store::load(&root, &none()).unwrap();
        let library_bytes = fs::read(root.join(source_store::LIBRARY_FILE)).unwrap();
        // Recording that a version lacks the passage is a use of it too.
        let refused = source_store::remove(&root, &library.revision, "paris", &none());
        let Err(source_store::StoreError::Invalid(found)) = refused else {
            panic!("a source an alignment uses must not be removed")
        };
        assert_eq!(found[0].code, SourceDiagnosticCode::StillUsed);
        assert!(
            found[0].message.contains("a1") && found[0].message.contains("alignments file"),
            "{found:?}"
        );
        let refused =
            source_store::remove_interpretation(&root, &library.revision, "mine", &none());
        let Err(source_store::StoreError::Invalid(found)) = refused else {
            panic!("an interpretation an alignment uses must not be removed")
        };
        assert_eq!(found[0].code, SourceDiagnosticCode::StillUsed);
        assert!(found[0].message.contains("a2"), "{found:?}");
        assert!(!found[0].message.contains("A reading."));
        assert_eq!(
            fs::read(root.join(source_store::LIBRARY_FILE)).unwrap(),
            library_bytes
        );
        let library = source_store::load(&root, &none()).unwrap();
        assert!(source_store::remove(&root, &library.revision, "spare", &none()).is_ok());

        let notebook_bytes = fs::read(root.join(notebook_store::NOTEBOOK_FILE)).unwrap();
        let refused = notebook_store::remove_passage(&root, &book.revision, "p1", &none());
        let Err(notebook_store::StoreError::Invalid(found)) = refused else {
            panic!("the passage removal must be refused")
        };
        assert_eq!(found[0].code, NoteDiagnosticCode::StillLinked);
        assert!(found[0].message.contains("a2") && found[0].message.contains("alignment"));
        assert!(!found[0].message.contains("quoted words"));
        assert_eq!(
            fs::read(root.join(notebook_store::NOTEBOOK_FILE)).unwrap(),
            notebook_bytes
        );

        // An unreadable alignments file blocks removals, not other edits.
        let alignment_bytes = fs::read(file(&root)).unwrap();
        fs::write(file(&root), b"{").unwrap();
        assert!(notebook_store::remove_passage(&root, &book.revision, "p1", &none()).is_err());
        let library = source_store::load(&root, &none()).unwrap();
        assert!(source_store::remove(&root, &library.revision, "plato", &none()).is_err());
        let reading = Interpretation::from_json(json!({"id": "other", "kind": "reading",
            "source": "slings", "text": "Another.", "interpreters": [{"name": "B"}]}))
        .unwrap();
        let library =
            source_store::create_interpretation(&root, &library.revision, reading, &none())
                .expect("an unreadable alignments file does not block unrelated edits");
        fs::write(file(&root), &alignment_bytes).unwrap();

        // Re-pointing `ref` at the work would make the alignment evidence's
        // page 514 ambiguous, so the library refuses it.
        let mut moved = library.library.get("ref").unwrap().clone();
        moved.of = Some("plato".into());
        let refused = source_store::update(&root, &library.revision, moved, &none());
        let Err(source_store::StoreError::Invalid(found)) = refused else {
            panic!("the library change must be refused")
        };
        assert!(
            found[0].message.contains("alignments file"),
            "{}",
            found[0].message
        );

        // Once the alignment no longer uses them, they can go.
        let (current, _) = remove_alignment(&root, &current.revision, "a2", &none()).unwrap();
        assert!(notebook_store::remove_passage(&root, &book.revision, "p1", &none()).is_ok());
        let library = source_store::load(&root, &none()).unwrap();
        assert!(
            source_store::remove_interpretation(&root, &library.revision, "mine", &none()).is_ok()
        );
        let (_, _) = remove_alignment(&root, &current.revision, "a1", &none()).unwrap();
        let library = source_store::load(&root, &none()).unwrap();
        assert!(source_store::remove(&root, &library.revision, "paris", &none()).is_ok());
        assert!(load(&root, &none()).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_member_whose_passage_quotes_another_source_fails_the_shared_check() {
        let root = temp_root("notebook-edit");
        with_library(&root);
        let book = notebook_store::load(&root, &none()).unwrap();
        let passage = Passage::from_json(json!({"id": "p1", "source": "grube",
            "excerpt": {"text": "quoted"}}))
        .unwrap();
        let book = notebook_store::create_passage(&root, &book.revision, passage, &none()).unwrap();
        let empty = load(&root, &none()).unwrap();
        create_alignment(
            &root,
            &empty.revision,
            alignment(
                "a1",
                json!([{"source": "grube", "passage": "p1"}, {"source": "paris", "absent": true}]),
            ),
            &none(),
        )
        .unwrap();
        // Writing the notebook by hand so the passage now quotes another
        // source would orphan the alignment member; the store refuses an
        // edit to that effect through the shared validation.
        let mut text: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(root.join(notebook_store::NOTEBOOK_FILE)).unwrap(),
        )
        .unwrap();
        text["passages"][0]["source"] = json!("slings");
        let edited = openblog_core::research_notes::Notebook::parse(
            &text.to_string(),
            &source_store::load(&root, &none()).unwrap().library,
        )
        .unwrap();
        let library = source_store::load(&root, &none()).unwrap().library;
        assert!(check_against(&root, &library, &book.notebook).is_ok());
        let error = check_against(&root, &library, &edited).unwrap_err();
        assert!(error.contains("members[0].passage"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_alignment_claims_notebook_and_library_writers_never_deadlock() {
        let root = temp_root("concurrent");
        seeded(&root);
        let started = std::time::Instant::now();
        let mut workers = Vec::new();
        for worker in 0..2 {
            let root = root.clone();
            workers.push(std::thread::spawn(move || {
                for n in 0..4 {
                    loop {
                        let current = load(&root, &none()).unwrap();
                        let candidate = alignment(
                            &format!("w{worker}-{n}"),
                            json!([
                                {"source": "slings", "locators": [{"kind": "page", "value": format!("{worker}{n}")}]},
                                {"source": "grube", "absent": true}
                            ]),
                        );
                        match create_alignment(&root, &current.revision, candidate, &none()) {
                            Ok(_) => break,
                            Err(StoreError::Conflict) => continue,
                            Err(other) => panic!("alignments writer: {other}"),
                        }
                    }
                }
            }));
        }
        let claims_root = root.clone();
        let claims_writer = std::thread::spawn(move || {
            for n in 0..4 {
                loop {
                    let current = crate::claims_store::load(&claims_root, &none()).unwrap();
                    let claim = openblog_core::claims::Claim::from_json(
                        json!({"id": format!("c{n}"), "post": "p", "statement": "S"}),
                    )
                    .unwrap();
                    match crate::claims_store::create_claim(
                        &claims_root,
                        &current.revision,
                        claim,
                        &Default::default(),
                        &none(),
                    ) {
                        Ok(_) => break,
                        Err(crate::claims_store::StoreError::Conflict) => continue,
                        Err(other) => panic!("claims writer: {other}"),
                    }
                }
            }
        });
        let notebook_root = root.clone();
        let notebook_writer = std::thread::spawn(move || {
            for n in 0..4 {
                loop {
                    let current = notebook_store::load(&notebook_root, &none()).unwrap();
                    let note = openblog_core::research_notes::ResearchNote::from_json(
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
                // Refused while an alignment uses it, whatever else is writing.
                assert!(
                    source_store::remove(&library_root, &current.revision, "paris", &none())
                        .is_err()
                );
            }
        });
        for worker in workers {
            worker.join().unwrap();
        }
        claims_writer.join().unwrap();
        notebook_writer.join().unwrap();
        library_writer.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(60));
        assert_eq!(
            load(&root, &none()).unwrap().alignments.alignments.len(),
            1 + 8
        );
        assert_eq!(tmp_files(&root), 0);
        let locks = fs::read_dir(file(&root).parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".lock"))
            .count();
        assert_eq!(locks, 0, "every lock was released");
        fs::remove_dir_all(root).unwrap();
    }
}
