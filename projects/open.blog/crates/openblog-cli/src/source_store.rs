//! Private, file-backed storage for the research source library.
//!
//! The library lives at [`LIBRARY_FILE`], inside the Git-ignored private
//! directory and outside content, static files, themes, and build output, so
//! no build copies it. A build reads it only when a post that opts in to
//! citations cites something, and publishes only those references' public
//! description ([`read_for_build`], ADR 0048); a site whose posts cite
//! nothing never reads it. Every change names the revision it was based on,
//! is validated by `openblog_core::source_library`, and replaces the file by
//! atomic rename while holding a lock: a refused, failed, or interrupted
//! change leaves the stored library exactly as it was.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use openblog_core::contributor::Contributor;
use openblog_core::interpretation::Interpretation;
use openblog_core::model::{LibraryReader, LibrarySource};
use openblog_core::source_interchange::{plan_csl_import, ImportPlan};
use openblog_core::source_library::{
    SourceDiagnostic, SourceDiagnosticCode, SourceLibrary, SourceRecord, MAX_LIBRARY_BYTES,
};
use openblog_core::SourceFile;
use sha2::{Digest, Sha256};

use crate::transaction::FileLock;

/// Where the library lives, relative to the project root.
pub const LIBRARY_FILE: &str = ".openblog/private/research/sources.json";
/// How long a change waits for another writer before giving up.
const LOCK_WAIT: Duration = Duration::from_secs(2);

/// One read of the library and the revision a later change must name.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub library: SourceLibrary,
    /// SHA-256 of the stored bytes, or of the empty library while none is stored.
    pub revision: String,
    /// False until the first change creates the file.
    pub stored: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StoreError {
    /// The library changed after the caller read the revision it named.
    Conflict,
    /// The stored library or the requested change is invalid. Nothing was written.
    Invalid(Vec<SourceDiagnostic>),
    /// The library could not be located, read, or written safely. Nothing was written.
    Storage(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict => formatter.write_str(
                "the source library changed since it was read; reload it and apply the change again",
            ),
            Self::Invalid(diagnostics) => {
                for (position, diagnostic) in diagnostics.iter().enumerate() {
                    if position > 0 {
                        formatter.write_str("\n")?;
                    }
                    write!(formatter, "{LIBRARY_FILE}: {diagnostic}")?;
                }
                Ok(())
            }
            Self::Storage(message) => formatter.write_str(message),
        }
    }
}

/// Read and validate the library. An absent library is empty, and reading
/// never creates a file or directory.
pub fn load(
    root: &Path,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    read(&library_path(root)?, contributors)
}

/// The stored library as a build reads it: its interpretations are kept raw
/// and never validated, because no build outputs them (ADR 0087) and a
/// problem in one, such as a removed interpreter, must not stop a build.
/// Every change and Admin read uses [`load`], which validates them.
pub fn load_for_build(
    root: &Path,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    read_parsed(
        &library_path(root)?,
        contributors,
        SourceLibrary::parse_for_build,
    )
}

// Changes below are used by Admin source management (#34) and import (#35).

/// Add a record whose identifier is not yet in the library.
#[cfg_attr(not(test), allow(dead_code))]
pub fn create(
    root: &Path,
    expected_revision: &str,
    record: SourceRecord,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, |library| {
        if let Some(index) = library.index().position(&record.id) {
            // Scoped to the existing record, so a caller can point at it.
            return Err(vec![SourceDiagnostic {
                code: SourceDiagnosticCode::DuplicateId,
                index: Some(index),
                source_id: Some(record.id.clone()),
                field: Some("id".into()),
                message: format!(
                    "`{}` is already used by this source; edit it or choose another id",
                    record.id
                ),
            }]);
        }
        if library.interpretation(&record.id).is_some() {
            // Sources and interpretations share one set of ids (ADR 0087).
            return Err(vec![interpretation_id_taken(&record.id)]);
        }
        library.upsert(record.clone(), contributors)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Replace the record with the same identifier. Its kind cannot change.
#[cfg_attr(not(test), allow(dead_code))]
pub fn update(
    root: &Path,
    expected_revision: &str,
    record: SourceRecord,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, |library| {
        if library.get(&record.id).is_none() {
            return Err(vec![unknown_source(&record.id)]);
        }
        let before = library.clone();
        library.upsert(record.clone(), contributors)?;
        keep_notebook_valid(root, &before, library, vec![record.id.clone()])?;
        keep_atlas_valid(root, &before, library, std::slice::from_ref(&record.id))?;
        keep_claims_valid(root, &before, library, std::slice::from_ref(&record.id))?;
        keep_alignments_valid(root, &before, library, std::slice::from_ref(&record.id))?;
        keep_posts_citable(root, &before, library, std::slice::from_ref(&record.id))
    })
    .map(|(snapshot, ())| snapshot)
}

/// Archive or restore a record without touching any other field, so a
/// caller that never saw its unknown fields cannot drop them.
pub fn set_archived(
    root: &Path,
    expected_revision: &str,
    id: &str,
    archived: bool,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, |library| {
        let mut record = library
            .get(id)
            .cloned()
            .ok_or_else(|| vec![unknown_source(id)])?;
        record.archived = archived;
        library.upsert(record, contributors)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Apply a CSL JSON import. The plan is rebuilt from the library as stored
/// under the lock, so it can never describe a stale library, and any
/// conflict in it refuses the whole import before anything is written.
pub fn import_csl(
    root: &Path,
    expected_revision: &str,
    text: &str,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<(Snapshot, ImportPlan), StoreError> {
    change(root, expected_revision, contributors, |library| {
        let before = library.clone();
        let plan = plan_csl_import(library, text, contributors)?;
        *library = plan.apply(library, contributors)?;
        // Name the records the import re-pointed or re-typed: those are what can turn a locator ambiguous.
        let moved: Vec<String> = library
            .sources
            .iter()
            .filter(|after| {
                before
                    .get(&after.id)
                    .is_some_and(|old| old.of != after.of || old.kind != after.kind)
            })
            .map(|record| record.id.clone())
            .collect();
        keep_notebook_valid(root, &before, library, moved.clone())?;
        keep_atlas_valid(root, &before, library, &moved)?;
        keep_claims_valid(root, &before, library, &moved)?;
        keep_alignments_valid(root, &before, library, &moved)?;
        keep_posts_citable(root, &before, library, &moved)?;
        Ok(plan)
    })
}

/// A library change must not leave a valid private notebook invalid, for
/// example by re-pointing a reference so a stored page or folio locator turns
/// ambiguous. The check runs under the library lock, as removal's does. A
/// notebook that was already unreadable against the stored library does not
/// block unrelated library edits; it is reported when it is next read.
fn keep_notebook_valid(
    root: &Path,
    before: &SourceLibrary,
    after: &SourceLibrary,
    ids: Vec<String>,
) -> Result<(), Vec<SourceDiagnostic>> {
    if crate::notebook_store::check_against_library(root, before).is_err() {
        return Ok(());
    }
    crate::notebook_store::check_against_library(root, after).map_err(|message| {
        vec![SourceDiagnostic {
            code: SourceDiagnosticCode::StillUsed,
            index: None,
            source_id: ids.first().cloned(),
            field: None,
            message: format!(
                "the change would leave the research notebook invalid, so nothing was saved{} ({message}); adjust or remove the affected notes and passages first",
                match ids.as_slice() {
                    [] => String::new(),
                    [one] => format!(" (source `{one}`)"),
                    many => format!(
                        " (sources {})",
                        many.iter().map(|id| format!("`{id}`")).collect::<Vec<_>>().join(", ")
                    ),
                }
            ),
        }]
    })
}

/// A library change must not leave a valid Knowledge Atlas invalid, for
/// example by re-pointing a reference so an evidence locator turns ambiguous.
/// It runs after the notebook check, under the library lock (which every atlas
/// write also holds), and an atlas that was already unreadable does not block
/// unrelated library edits.
fn keep_atlas_valid(
    root: &Path,
    before: &SourceLibrary,
    after: &SourceLibrary,
    ids: &[String],
) -> Result<(), Vec<SourceDiagnostic>> {
    if crate::atlas_store::check_against_library(root, before).is_err() {
        return Ok(());
    }
    crate::atlas_store::check_against_library(root, after).map_err(|message| {
        vec![SourceDiagnostic {
            code: SourceDiagnosticCode::StillUsed,
            index: None,
            source_id: ids.first().cloned(),
            field: None,
            message: format!(
                "the change would leave the Knowledge Atlas invalid, so nothing was saved ({message}); adjust the affected entries and relationships first"
            ),
        }]
    })
}

/// A library change must not leave a valid claims file invalid, for example by
/// re-pointing a reference so an evidence locator turns ambiguous. Like the
/// atlas check it runs under the library lock, which every claims write also
/// holds, and a claims file that was already unreadable does not block
/// unrelated library edits.
fn keep_claims_valid(
    root: &Path,
    before: &SourceLibrary,
    after: &SourceLibrary,
    ids: &[String],
) -> Result<(), Vec<SourceDiagnostic>> {
    if crate::claims_store::check_against_library(root, before).is_err() {
        return Ok(());
    }
    crate::claims_store::check_against_library(root, after).map_err(|message| {
        vec![SourceDiagnostic {
            code: SourceDiagnosticCode::StillUsed,
            index: None,
            source_id: ids.first().cloned(),
            field: None,
            message: format!(
                "the change would leave the claims file invalid, so nothing was saved ({message}); adjust the affected evidence links first"
            ),
        }]
    })
}

/// A library change must not leave a valid alignments file invalid, for
/// example by re-pointing a reference so an evidence locator turns ambiguous.
/// It runs under the library lock, which every alignments write also holds,
/// and an alignments file that was already unreadable does not block
/// unrelated library edits.
fn keep_alignments_valid(
    root: &Path,
    before: &SourceLibrary,
    after: &SourceLibrary,
    ids: &[String],
) -> Result<(), Vec<SourceDiagnostic>> {
    if crate::alignment_store::check_against_library(root, before).is_err() {
        return Ok(());
    }
    crate::alignment_store::check_against_library(root, after).map_err(|message| {
        vec![SourceDiagnostic {
            code: SourceDiagnosticCode::StillUsed,
            index: None,
            source_id: ids.first().cloned(),
            field: None,
            message: format!(
                "the change would leave the alignments file invalid, so nothing was saved ({message}); adjust the affected alignments first"
            ),
        }]
    })
}

/// A library change must not make a published post uncitable, for example
/// by re-pointing a reference so a page locator turns ambiguous, or by
/// removing a cited source: the next build, every scheduled rebuild and every
/// preview would refuse that post. Each post that is not a draft and opts in
/// to citations is resolved against the edited library, under the library
/// lock. The refusal names each post's path and line, never its text. A post
/// that already failed against the stored library does not block unrelated
/// edits, and neither does content that cannot be read at all; the build
/// reports both.
fn keep_posts_citable(
    root: &Path,
    before: &SourceLibrary,
    after: &SourceLibrary,
    ids: &[String],
) -> Result<(), Vec<SourceDiagnostic>> {
    let Ok(config) = crate::site::load_config(root) else {
        return Ok(());
    };
    let Ok(sources) = crate::site::read_sources(root, &config) else {
        return Ok(());
    };
    let uncitable: Vec<String> = sources
        .posts
        .iter()
        .filter_map(|file| {
            let line = openblog_core::model::uncitable_line(&file.contents, after)?;
            openblog_core::model::uncitable_line(&file.contents, before)
                .is_none()
                .then(|| format!("{} line {line}", file.path))
        })
        .collect();
    if uncitable.is_empty() {
        return Ok(());
    }
    Err(vec![SourceDiagnostic {
        code: SourceDiagnosticCode::StillUsed,
        index: None,
        source_id: ids.first().cloned(),
        field: None,
        message: format!(
            "the change would stop {} published post{} from resolving {} citations, so nothing was saved ({}); change the citation{} or keep the source as it is",
            uncitable.len(),
            if uncitable.len() == 1 { "" } else { "s" },
            if uncitable.len() == 1 { "its" } else { "their" },
            uncitable.join(", "),
            if uncitable.len() == 1 { "" } else { "s" },
        ),
    }])
}

/// A new source whose id an interpretation already uses, scoped to the
/// requested source rather than to the interpretation.
fn interpretation_id_taken(id: &str) -> SourceDiagnostic {
    SourceDiagnostic {
        code: SourceDiagnosticCode::DuplicateId,
        index: None,
        source_id: Some(id.into()),
        field: Some("id".into()),
        message: format!(
            "`{id}` is already used by an interpretation; sources and interpretations share one set of ids, so choose another id"
        ),
    }
}

fn unknown_source(id: &str) -> SourceDiagnostic {
    SourceDiagnostic {
        code: SourceDiagnosticCode::UnknownSource,
        index: None,
        source_id: Some(id.into()),
        field: None,
        message: format!("no source has the id `{id}`"),
    }
}

/// Remove a record that no other record depends on.
#[cfg_attr(not(test), allow(dead_code))]
pub fn remove(
    root: &Path,
    expected_revision: &str,
    id: &str,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<(Snapshot, SourceRecord), StoreError> {
    change(root, expected_revision, contributors, |library| {
        // Private research that still points at the record would be left
        // dangling, so it blocks removal. The library lock is held, and every
        // notebook change takes it too, so the check cannot race a save.
        let using = crate::notebook_store::entries_using_source(root, library, id)
            .map_err(|message| vec![still_used(id, message)])?;
        if !using.is_empty() {
            return Err(vec![still_used(
                id,
                format!(
                    "{} in the research notebook still use this source ({}); remove or move them first",
                    using.len(),
                    using.join(", ")
                ),
            )]);
        }
        // The Knowledge Atlas cites sources as evidence, attribution, and the
        // work an entry stands for; its writes hold this lock too.
        let using = crate::atlas_store::uses_of_source(root, library, id)
            .map_err(|message| vec![still_used(id, message)])?;
        if !using.is_empty() {
            return Err(vec![still_used(
                id,
                format!(
                    "{} in the Knowledge Atlas still use this source ({}); remove them or change their evidence first",
                    using.len(),
                    using.join(", ")
                ),
            )]);
        }
        // Evidence links in the claims file rest on sources too; claims
        // writes hold this lock as well.
        let using = crate::claims_store::uses_of_source(root, library, id)
            .map_err(|message| vec![still_used(id, message)])?;
        if !using.is_empty() {
            return Err(vec![still_used(
                id,
                format!(
                    "{} evidence link{} in the claims file still rest{} on this source ({}); remove {} or change {} evidence first",
                    using.len(),
                    if using.len() == 1 { "" } else { "s" },
                    if using.len() == 1 { "s" } else { "" },
                    using.join(", "),
                    if using.len() == 1 { "it" } else { "them" },
                    if using.len() == 1 { "its" } else { "their" },
                ),
            )]);
        }
        // Passage alignments name sources as members, evidence, and
        // attribution; alignments writes hold this lock as well.
        let using = crate::alignment_store::uses_of_source(root, library, id)
            .map_err(|message| vec![still_used(id, message)])?;
        if !using.is_empty() {
            return Err(vec![still_used(
                id,
                format!(
                    "{} alignment{} in the alignments file still use{} this source ({}); remove {} or change {} members first",
                    using.len(),
                    if using.len() == 1 { "" } else { "s" },
                    if using.len() == 1 { "s" } else { "" },
                    using.join(", "),
                    if using.len() == 1 { "it" } else { "them" },
                    if using.len() == 1 { "its" } else { "their" },
                ),
            )]);
        }
        let before = library.clone();
        let removed = library.remove(id, contributors)?;
        keep_posts_citable(root, &before, library, &[id.to_string()])?;
        Ok(removed)
    })
}

// Interpretations (ADR 0087) share the library's file, revision, and lock.
// Admin management arrives with the comparison workspace (#54).

/// The contributor registry as stored now. Interpretation writes call this
/// inside `change`, under the library lock, because removing a contributor
/// checks interpretations under that same lock and holds it until the
/// registry is written: a registry the caller read before the lock could
/// still list a contributor removed in between. A project with no config
/// file has no stored registry that could change, so the caller's is used.
fn registry_under_lock(
    root: &Path,
    given: &BTreeMap<String, Contributor>,
) -> Result<BTreeMap<String, Contributor>, Vec<SourceDiagnostic>> {
    if !root.join(crate::site::CONFIG_FILE).exists() {
        return Ok(given.clone());
    }
    crate::site::load_config(root)
        .map(|config| config.contributors)
        .map_err(|_| {
            vec![SourceDiagnostic {
                code: SourceDiagnosticCode::UnresolvedRelationship,
                index: None,
                source_id: None,
                field: Some("interpretations".into()),
                message: format!(
                    "the contributor registry in {} cannot be read, so interpreters cannot be checked; repair it and try again",
                    crate::site::CONFIG_FILE
                ),
            }]
        })
}

/// Add an interpretation whose identifier is not yet in use.
#[cfg_attr(not(test), allow(dead_code))]
pub fn create_interpretation(
    root: &Path,
    expected_revision: &str,
    interpretation: Interpretation,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, |library| {
        if library.interpretation(&interpretation.id).is_some() {
            return Err(vec![SourceDiagnostic {
                code: SourceDiagnosticCode::DuplicateId,
                index: None,
                source_id: None,
                field: Some("interpretations".into()),
                message: format!(
                    "`{}` is already used by an interpretation; edit it or choose another id",
                    interpretation.id
                ),
            }]);
        }
        let registry = registry_under_lock(root, contributors)?;
        library.upsert_interpretation(interpretation.clone(), &registry)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Replace the interpretation with the same identifier.
#[cfg_attr(not(test), allow(dead_code))]
pub fn update_interpretation(
    root: &Path,
    expected_revision: &str,
    interpretation: Interpretation,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, |library| {
        if library.interpretation(&interpretation.id).is_none() {
            return Err(vec![unknown_interpretation(&interpretation.id)]);
        }
        let registry = registry_under_lock(root, contributors)?;
        library.upsert_interpretation(interpretation.clone(), &registry)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Remove an interpretation no passage alignment uses. An alignments file
/// that cannot be read blocks removal, since it cannot be shown to be unused.
#[cfg_attr(not(test), allow(dead_code))]
pub fn remove_interpretation(
    root: &Path,
    expected_revision: &str,
    id: &str,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<(Snapshot, Interpretation), StoreError> {
    change(root, expected_revision, contributors, |library| {
        if library.interpretation(id).is_some() {
            let blocked = |message: String| {
                vec![SourceDiagnostic {
                    code: SourceDiagnosticCode::StillUsed,
                    index: None,
                    source_id: None,
                    field: Some("interpretations".into()),
                    message,
                }]
            };
            let using = crate::alignment_store::uses_of_interpretation(root, library, id)
                .map_err(blocked)?;
            if !using.is_empty() {
                return Err(blocked(format!(
                    "interpretation `{id}` is aligned in {} alignment{} ({}); remove it from {} first",
                    using.len(),
                    if using.len() == 1 { "" } else { "s" },
                    using.join(", "),
                    if using.len() == 1 { "that alignment" } else { "those alignments" },
                )));
            }
        }
        library.remove_interpretation(id, contributors)
    })
}

/// The library lock, held while a registry write is pending, and the
/// `(contributor, interpretation id)` pairs still naming removed keys.
pub(crate) type InterpretersInUse = (Option<FileLock>, Vec<(String, String)>);

/// Which of the `removed` contributor keys an interpretation still names, as
/// `(contributor, interpretation id)` pairs, read under the library lock. The
/// returned lock is held by a caller that removes contributors from the
/// registry until its write is done, so no interpretation can start naming
/// one of them in between. A library that cannot be read blocks removals,
/// because they cannot be shown to be unused.
pub(crate) fn interpreters_in_use(
    root: &Path,
    contributors: &BTreeMap<String, Contributor>,
    removed: &[String],
) -> Result<InterpretersInUse, String> {
    if removed.is_empty() {
        return Ok((None, Vec::new()));
    }
    let path = library_path(root).map_err(|error| error.to_string())?;
    let lock = match path.parent() {
        Some(directory) if directory.is_dir() => {
            Some(lock_library(root).map_err(|error| error.to_string())?)
        }
        _ => None,
    };
    let snapshot = read(&path, contributors).map_err(|error| {
        format!("contributors cannot be removed while the source library cannot be read: {error}")
    })?;
    let mut using = Vec::new();
    for interpretation in &snapshot.library.interpretations {
        for interpreter in &interpretation.interpreters {
            if let Some(key) = interpreter
                .contributor
                .as_ref()
                .filter(|key| removed.contains(key))
            {
                using.push((key.clone(), interpretation.id.clone()));
            }
        }
    }
    Ok((lock, using))
}

fn unknown_interpretation(id: &str) -> SourceDiagnostic {
    SourceDiagnostic {
        code: SourceDiagnosticCode::UnknownSource,
        index: None,
        source_id: None,
        field: Some("interpretations".into()),
        message: format!("no interpretation has the id `{id}`"),
    }
}

fn still_used(id: &str, message: String) -> SourceDiagnostic {
    SourceDiagnostic {
        code: SourceDiagnosticCode::StillUsed,
        index: None,
        source_id: Some(id.into()),
        field: None,
        message,
    }
}

/// Take the library's write lock, so a private research change that depends
/// on the library cannot interleave with a change to the library itself.
pub(crate) fn lock_library(root: &Path) -> Result<FileLock, StoreError> {
    let path = library_path(root)?;
    FileLock::acquire(lock_path(&path), "source library write", LOCK_WAIT)
        .map_err(StoreError::Storage)
}

/// Apply one edit while holding the library lock. The edit sees the library
/// as stored, and nothing is written unless the stored revision matches, the
/// stored library is valid, and the edited library is valid. While nothing is
/// stored the edit is first tried without the lock, so a refused change never
/// creates private directories either.
#[cfg_attr(not(test), allow(dead_code))]
fn change<T>(
    root: &Path,
    expected_revision: &str,
    contributors: &BTreeMap<String, Contributor>,
    edit: impl Fn(&mut SourceLibrary) -> Result<T, Vec<SourceDiagnostic>>,
) -> Result<(Snapshot, T), StoreError> {
    change_using(root, expected_revision, contributors, edit, |from, to| {
        crate::fsutil::replace_file(from, to)
    })
}

#[cfg_attr(not(test), allow(dead_code))]
fn change_using<T>(
    root: &Path,
    expected_revision: &str,
    contributors: &BTreeMap<String, Contributor>,
    edit: impl Fn(&mut SourceLibrary) -> Result<T, Vec<SourceDiagnostic>>,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(Snapshot, T), StoreError> {
    let path = library_path(root)?;
    let directory = path
        .parent()
        .ok_or_else(|| StoreError::Storage("the source library has no directory".into()))?;
    if !directory.is_dir() {
        let mut library = checked(read(&path, contributors)?, expected_revision)?;
        edit(&mut library).map_err(StoreError::Invalid)?;
        create_private_directory(directory)?;
    }
    // Check again now that every directory exists.
    let path = library_path(root)?;
    let _lock = FileLock::acquire(lock_path(&path), "source library write", LOCK_WAIT)
        .map_err(StoreError::Storage)?;

    let mut library = checked(read(&path, contributors)?, expected_revision)?;
    let outcome = edit(&mut library).map_err(StoreError::Invalid)?;
    let text = library.to_json();
    commit(&path, text.as_bytes(), rename)?;
    remove_interrupted_writes(&path);
    Ok((
        Snapshot {
            library,
            revision: revision(text.as_bytes()),
            stored: true,
        },
        outcome,
    ))
}

/// The library a change may edit: the one read, if it is the revision named.
#[cfg_attr(not(test), allow(dead_code))]
fn checked(current: Snapshot, expected_revision: &str) -> Result<SourceLibrary, StoreError> {
    if current.revision != expected_revision {
        return Err(StoreError::Conflict);
    }
    Ok(current.library)
}

fn read(path: &Path, contributors: &BTreeMap<String, Contributor>) -> Result<Snapshot, StoreError> {
    read_parsed(path, contributors, SourceLibrary::parse)
}

type Parse =
    fn(&str, &BTreeMap<String, Contributor>) -> Result<SourceLibrary, Vec<SourceDiagnostic>>;

fn read_parsed(
    path: &Path,
    contributors: &BTreeMap<String, Contributor>,
    parse: Parse,
) -> Result<Snapshot, StoreError> {
    let Some(bytes) = read_bytes(path)? else {
        let library = SourceLibrary::default();
        return Ok(Snapshot {
            revision: revision(library.to_json().as_bytes()),
            library,
            stored: false,
        });
    };
    let revision = revision(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| not_utf8())?;
    let library = parse(&text, contributors).map_err(StoreError::Invalid)?;
    Ok(Snapshot {
        library,
        revision,
        stored: true,
    })
}

/// The stored bytes, or `None` while no library is stored. A symlink, a
/// non-file or an oversized file is refused before anything is read.
fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, StoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(StoreError::Storage(format!(
                "cannot inspect {LIBRARY_FILE}: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(StoreError::Storage(format!(
            "{LIBRARY_FILE} is a symlink; replace it with a regular file"
        )));
    }
    if !metadata.is_file() {
        return Err(StoreError::Storage(format!(
            "{LIBRARY_FILE} is not a regular file"
        )));
    }
    if metadata.len() > MAX_LIBRARY_BYTES as u64 {
        return Err(StoreError::Invalid(vec![too_large()]));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| {
            file.take(MAX_LIBRARY_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| StoreError::Storage(format!("cannot read {LIBRARY_FILE}: {error}")))?;
    if bytes.len() > MAX_LIBRARY_BYTES {
        return Err(StoreError::Invalid(vec![too_large()]));
    }
    Ok(Some(bytes))
}

fn not_utf8() -> StoreError {
    StoreError::Invalid(vec![library_diagnostic(
        SourceDiagnosticCode::InvalidJson,
        "the library is not valid UTF-8".into(),
    )])
}

/// The stored library for a site load, as a deferred read through the same
/// safe path checks as every other read. Nothing is inspected or read until
/// the load needs it: only when a post that opts in to citations cites
/// something, and then once. The load publishes only the cited references'
/// public description; a library that cannot be read safely is reported only
/// to the posts that need it.
pub fn read_for_build(root: &Path) -> LibrarySource {
    let root = root.to_path_buf();
    LibrarySource::Deferred(LibraryReader::new(move || {
        let bytes = library_path(&root)
            .and_then(|path| read_bytes(&path))
            .map_err(|error| error.to_string())?;
        bytes
            .map(|bytes| {
                String::from_utf8(bytes)
                    .map(|contents| SourceFile {
                        path: LIBRARY_FILE.into(),
                        contents,
                    })
                    .map_err(|_| not_utf8().to_string())
            })
            .transpose()
    }))
}

fn library_diagnostic(code: SourceDiagnosticCode, message: String) -> SourceDiagnostic {
    SourceDiagnostic {
        code,
        index: None,
        source_id: None,
        field: None,
        message,
    }
}

fn too_large() -> SourceDiagnostic {
    library_diagnostic(
        SourceDiagnosticCode::TooLarge,
        format!("the library is larger than {MAX_LIBRARY_BYTES} bytes"),
    )
}

pub(crate) fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn library_path(root: &Path) -> Result<PathBuf, StoreError> {
    contained(root, Path::new(LIBRARY_FILE))
}

/// Resolve a private path below `root` without trusting the filesystem: the
/// path must be relative and plain, and no existing component may be a
/// symlink or junction, so the library can never be read from or written to
/// another place such as `static/` or a directory outside the project.
pub(crate) fn contained(root: &Path, relative: &Path) -> Result<PathBuf, StoreError> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(StoreError::Storage(format!(
            "{} must be a plain path inside the project",
            relative.display()
        )));
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(StoreError::Storage(format!(
                    "{} is a symlink; private research storage only uses real directories inside the project",
                    current.strip_prefix(root).unwrap_or(&current).display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(StoreError::Storage(format!(
                    "cannot inspect {}: {error}",
                    current.display()
                )))
            }
        }
    }
    Ok(root.join(relative))
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn create_private_directory(directory: &Path) -> Result<(), StoreError> {
    fs::create_dir_all(directory).map_err(|error| {
        StoreError::Storage(format!(
            "cannot create the private research directory: {error}"
        ))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|error| {
            StoreError::Storage(format!(
                "cannot protect the private research directory: {error}"
            ))
        })?;
    }
    Ok(())
}

#[cfg_attr(not(test), allow(dead_code))]
fn lock_path(path: &Path) -> PathBuf {
    path.with_extension("json.lock")
}

/// Write `bytes` to a new temporary file beside `path`, flush it, and rename
/// it over `path`. On any failure the temporary file is removed and `path`
/// keeps its previous contents.
#[cfg_attr(not(test), allow(dead_code))]
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
            "could not save the source library ({error}); the stored library is unchanged"
        )));
    }
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        // Best effort: the rename has already replaced the library.
        let _ = fs::File::open(parent).and_then(|directory| directory.sync_all());
    }
    Ok(())
}

/// Remove temporary files left by a write interrupted before its rename. They
/// are never read, and the caller holds the lock, so none belongs to a write
/// still in progress.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn remove_interrupted_writes(path: &Path) {
    let (Some(directory), Some(name)) = (path.parent(), path.file_name()) else {
        return;
    };
    let prefix = format!("{}.", name.to_string_lossy());
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name.starts_with(&prefix)
            && file_name.ends_with(".tmp")
            && entry.file_type().is_ok_and(|kind| kind.is_file())
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openblog_core::source_library::{ResearchSourceKind, SourceRecord};
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;

    fn temp_root(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "openblog-sources-{tag}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn none() -> BTreeMap<String, openblog_core::contributor::Contributor> {
        BTreeMap::new()
    }

    fn record(id: &str, kind: ResearchSourceKind, of: Option<&str>) -> SourceRecord {
        SourceRecord {
            title: (kind != ResearchSourceKind::Reference).then(|| format!("Title of {id}")),
            of: of.map(Into::into),
            ..SourceRecord::new(id, kind)
        }
    }

    fn work(id: &str) -> SourceRecord {
        record(id, ResearchSourceKind::Work, None)
    }

    fn library_file(root: &Path) -> PathBuf {
        root.join(LIBRARY_FILE)
    }

    #[test]
    fn an_absent_library_loads_empty_without_creating_private_directories() {
        let root = temp_root("absent");
        let snapshot = load(&root, &none()).unwrap();
        assert!(snapshot.library.sources.is_empty());
        assert!(!snapshot.stored);
        assert!(!snapshot.revision.is_empty());
        assert!(!root.join(".openblog").exists(), "reading never writes");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_writes_canonical_bytes_and_returns_the_next_revision() {
        let root = temp_root("create");
        let empty = load(&root, &none()).unwrap();
        let created = create(&root, &empty.revision, work("plato-republic"), &none()).unwrap();
        assert!(created.stored);
        assert_ne!(created.revision, empty.revision);

        let bytes = fs::read_to_string(library_file(&root)).unwrap();
        assert_eq!(bytes, created.library.to_json(), "stored form is canonical");
        let reloaded = load(&root, &none()).unwrap();
        assert_eq!(reloaded.library, created.library);
        assert_eq!(reloaded.revision, created.revision);
        assert!(reloaded.library.get("plato-republic").is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archiving_changes_only_the_flag_and_keeps_dependents_resolvable() {
        let root = temp_root("archive");
        store(
            &root,
            r#"{"version":1,"sources":[{"id":"w","kind":"work","title":"Πολιτεία","shelf":{"room":"B"}},{"id":"e","kind":"edition","of":"w","title":"E"}]}"#.as_bytes(),
        );
        let before = load(&root, &none()).unwrap();
        let archived = set_archived(&root, &before.revision, "w", true, &none()).unwrap();
        let work = archived.library.get("w").unwrap();
        assert!(work.archived);
        assert_eq!(work.title.as_deref(), Some("Πολιτεία"));
        assert_eq!(work.extra["shelf"], serde_json::json!({"room": "B"}));
        assert!(archived.library.get("e").is_some(), "dependents stay valid");

        let stale = set_archived(&root, &before.revision, "w", false, &none()).unwrap_err();
        assert_eq!(stale, StoreError::Conflict);
        let missing = set_archived(&root, &archived.revision, "gone", true, &none()).unwrap_err();
        assert_eq!(
            missing,
            StoreError::Invalid(vec![SourceDiagnostic {
                code: SourceDiagnosticCode::UnknownSource,
                index: None,
                source_id: Some("gone".into()),
                field: None,
                message: "no source has the id `gone`".into(),
            }])
        );
        let restored = set_archived(&root, &archived.revision, "w", false, &none()).unwrap();
        assert_eq!(restored.library, before.library);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn identical_changes_produce_identical_files_and_revisions() {
        let first = temp_root("deterministic-a");
        let second = temp_root("deterministic-b");
        for root in [&first, &second] {
            let empty = load(root, &none()).unwrap();
            let next = create(root, &empty.revision, work("w"), &none()).unwrap();
            create(
                root,
                &next.revision,
                record("e", ResearchSourceKind::Edition, Some("w")),
                &none(),
            )
            .unwrap();
        }
        assert_eq!(
            fs::read(library_file(&first)).unwrap(),
            fs::read(library_file(&second)).unwrap()
        );
        assert_eq!(
            load(&first, &none()).unwrap().revision,
            load(&second, &none()).unwrap().revision
        );
        fs::remove_dir_all(first).unwrap();
        fs::remove_dir_all(second).unwrap();
    }

    #[test]
    fn a_write_based_on_a_stale_revision_is_refused_and_changes_nothing() {
        let root = temp_root("stale");
        let empty = load(&root, &none()).unwrap();
        create(&root, &empty.revision, work("first"), &none()).unwrap();
        let before = fs::read(library_file(&root)).unwrap();

        let stale = create(&root, &empty.revision, work("second"), &none()).unwrap_err();
        assert_eq!(stale, StoreError::Conflict);
        let stale = remove(&root, "not-a-revision", "first", &none()).unwrap_err();
        assert_eq!(stale, StoreError::Conflict);
        assert_eq!(fs::read(library_file(&root)).unwrap(), before);

        // An edit made outside open.blog also changes the revision.
        let current = load(&root, &none()).unwrap();
        fs::write(
            library_file(&root),
            current
                .library
                .to_json()
                .replace("Title of first", "Edited by hand"),
        )
        .unwrap();
        let outside = update(&root, &current.revision, work("first"), &none()).unwrap_err();
        assert_eq!(outside, StoreError::Conflict);
        assert!(fs::read_to_string(library_file(&root))
            .unwrap()
            .contains("Edited by hand"));
        fs::remove_dir_all(root).unwrap();
    }

    fn store(root: &Path, contents: &[u8]) {
        let path = library_file(root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn codes(error: &StoreError) -> Vec<SourceDiagnosticCode> {
        match error {
            StoreError::Invalid(diagnostics) => diagnostics.iter().map(|d| d.code).collect(),
            other => panic!("expected diagnostics, got {other:?}"),
        }
    }

    /// Every change is refused and the stored bytes stay exactly as they were.
    fn assert_every_change_refused(root: &Path, revision: &str, expected: &StoreError) {
        let before = fs::read(library_file(root)).unwrap();
        let attempts = [
            create(root, revision, work("new"), &none()).unwrap_err(),
            update(root, revision, work("w"), &none()).unwrap_err(),
            remove(root, revision, "w", &none()).unwrap_err(),
        ];
        for error in attempts {
            assert_eq!(&error, expected);
        }
        assert_eq!(fs::read(library_file(root)).unwrap(), before);
    }

    #[test]
    fn corrupt_stored_libraries_are_reported_and_never_overwritten() {
        let cases: [(&str, &[u8], SourceDiagnosticCode); 5] = [
            (
                "truncated",
                br#"{"version":1,"sources":[{"id":"w","kind":"wo"#,
                SourceDiagnosticCode::InvalidJson,
            ),
            ("not-utf8", b"{\"version\":1,\xff}", SourceDiagnosticCode::InvalidJson),
            ("not-object", b"[]", SourceDiagnosticCode::InvalidField),
            (
                "duplicate",
                br#"{"version":1,"sources":[{"id":"w","kind":"work","title":"A"},{"id":"w","kind":"work","title":"B"}]}"#,
                SourceDiagnosticCode::DuplicateId,
            ),
            (
                "credit-sidecar",
                br#"{"credits":[{"contributor":"ada","roles":["author"]}]}"#,
                SourceDiagnosticCode::ContributorCredit,
            ),
        ];
        for (tag, contents, code) in cases {
            let root = temp_root(tag);
            store(&root, contents);
            let error = load(&root, &none()).unwrap_err();
            assert!(codes(&error).contains(&code), "{tag}: {error:?}");
            assert!(
                error.to_string().starts_with(LIBRARY_FILE),
                "{tag}: {error}"
            );
            // A corrupt library has no revision a caller could name, so even
            // the revision of an empty library cannot replace it.
            let empty = revision(SourceLibrary::default().to_json().as_bytes());
            let current = revision(contents);
            for attempt in [empty, current] {
                assert_every_change_refused(&root, &attempt, &error);
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn a_refused_first_change_creates_no_private_directories() {
        let root = temp_root("refused-first");
        let empty = load(&root, &none()).unwrap();
        let stale = remove(&root, "x", "bogus", &none()).unwrap_err();
        assert_eq!(stale, StoreError::Conflict);
        let invalid = record("e", ResearchSourceKind::Edition, Some("missing"));
        assert!(matches!(
            create(&root, &empty.revision, invalid, &none()),
            Err(StoreError::Invalid(_))
        ));
        assert!(matches!(
            update(&root, &empty.revision, work("absent"), &none()),
            Err(StoreError::Invalid(_))
        ));
        assert!(!root.join(".openblog").exists());
        // An accepted first change still creates them.
        create(&root, &empty.revision, work("w"), &none()).unwrap();
        assert!(library_file(&root).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_byte_order_mark_from_a_windows_editor_is_accepted() {
        let root = temp_root("bom");
        let contents = b"\xEF\xBB\xBF{\"version\":1,\"sources\":[{\"id\":\"w\",\"kind\":\"work\",\"title\":\"A\"}]}";
        store(&root, contents);
        let current = load(&root, &none()).unwrap();
        assert!(current.library.get("w").is_some());
        assert_eq!(
            current.revision,
            revision(contents),
            "revision covers the raw bytes"
        );
        let next = create(&root, &current.revision, work("x"), &none()).unwrap();
        assert_eq!(next.library.sources.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_libraries_are_rejected_before_they_are_read() {
        let root = temp_root("oversized");
        let mut contents = br#"{"version":1,"sources":[],"padding":""#.to_vec();
        contents.resize(MAX_LIBRARY_BYTES + 16, b'x');
        contents.extend_from_slice(b"\"}");
        store(&root, &contents);
        let error = load(&root, &none()).unwrap_err();
        assert_eq!(codes(&error), [SourceDiagnosticCode::TooLarge]);
        assert_every_change_refused(&root, &revision(&contents), &error);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn newer_library_versions_are_refused_rather_than_migrated_or_replaced() {
        let root = temp_root("newer");
        let newer = br#"{"version":2,"sources":[],"shelves":["future data"]}"#;
        store(&root, newer);
        let error = load(&root, &none()).unwrap_err();
        assert_eq!(codes(&error), [SourceDiagnosticCode::UnsupportedVersion]);
        assert_every_change_refused(&root, &revision(newer), &error);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hand_written_libraries_keep_unknown_fields_and_unicode_through_changes() {
        let root = temp_root("lossless");
        let authored = r#"{
  "version": 1,
  "exportedBy": {"tool": "future-open.blog"},
  "sources": [
    {"id": "w", "kind": "work", "title": "Πολιτεία — 理想国 — الجمهورية 🏛️", "language": "grc",
     "subjects": ["justice"], "creators": [{"name": "Πλάτων", "sortName": "Plato"}]},
    {"id": "e", "kind": "edition", "of": "w", "title": "Edition", "publisher": {"name": "OUP"}}
  ]
}"#;
        store(&root, authored.as_bytes());
        let current = load(&root, &none()).unwrap();
        let mut edition = current.library.get("e").unwrap().clone();
        edition.issued = Some("2003".into());
        let next = update(&root, &current.revision, edition, &none()).unwrap();

        let written: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(library_file(&root)).unwrap()).unwrap();
        let mut expected: serde_json::Value = serde_json::from_str(authored).unwrap();
        expected["sources"][1]["issued"] = "2003".into();
        assert_eq!(written, expected, "only the edited field changed");
        assert_eq!(
            next.library.get("w").unwrap().title.as_deref(),
            Some("Πολιτεία — 理想国 — الجمهورية 🏛️")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn crud_rejects_duplicates_missing_records_kind_changes_and_needed_records() {
        let root = temp_root("crud");
        let empty = load(&root, &none()).unwrap();
        let first = create(&root, &empty.revision, work("w"), &none()).unwrap();
        let second = create(
            &root,
            &first.revision,
            record("e", ResearchSourceKind::Edition, Some("w")),
            &none(),
        )
        .unwrap();
        let before = fs::read(library_file(&root)).unwrap();

        let duplicate = create(&root, &second.revision, work("w"), &none()).unwrap_err();
        assert_eq!(codes(&duplicate), [SourceDiagnosticCode::DuplicateId]);
        let StoreError::Invalid(diagnostics) = &duplicate else {
            unreachable!()
        };
        assert_eq!(
            diagnostics[0].index,
            Some(0),
            "points at the existing source"
        );
        assert!(
            duplicate.to_string().contains("sources[0] `w` id:"),
            "{duplicate}"
        );
        let missing = update(&root, &second.revision, work("absent"), &none()).unwrap_err();
        assert_eq!(codes(&missing), [SourceDiagnosticCode::UnknownSource]);
        assert!(
            missing.to_string().contains("source `absent`:"),
            "{missing}"
        );
        let kind = update(
            &root,
            &second.revision,
            record("w", ResearchSourceKind::Witness, Some("e")),
            &none(),
        )
        .unwrap_err();
        assert_eq!(codes(&kind), [SourceDiagnosticCode::KindChanged]);
        let needed = remove(&root, &second.revision, "w", &none()).unwrap_err();
        assert_eq!(
            codes(&needed),
            [SourceDiagnosticCode::UnresolvedRelationship]
        );
        assert_eq!(fs::read(library_file(&root)).unwrap(), before);

        let (after, removed) = remove(&root, &second.revision, "e", &none()).unwrap();
        assert_eq!(removed.id, "e");
        assert_eq!(after.library.sources.len(), 1);
        assert_eq!(load(&root, &none()).unwrap(), after);
        fs::remove_dir_all(root).unwrap();
    }

    fn interpretation(id: &str, source: &str, interpreter: serde_json::Value) -> Interpretation {
        Interpretation::from_json(serde_json::json!({
            "id": id,
            "kind": "rendering",
            "source": source,
            "locators": [{"kind": "canonical", "value": "514a"}],
            "language": "en",
            "text": "A rendering of the place.",
            "interpreters": [interpreter],
        }))
        .unwrap()
    }

    #[test]
    fn interpretations_share_the_library_revision_and_never_half_write() {
        let root = temp_root("interpretations");
        let registry = BTreeMap::from([(
            "ada".to_string(),
            openblog_core::contributor::Contributor {
                name: "Ada".into(),
                ..Default::default()
            },
        )]);
        let empty = load(&root, &registry).unwrap();
        let first = create(&root, &empty.revision, work("w"), &registry).unwrap();
        let edition = create(
            &root,
            &first.revision,
            record("e", ResearchSourceKind::Edition, Some("w")),
            &registry,
        )
        .unwrap();
        let mine = interpretation("e-514a", "e", serde_json::json!({"contributor": "ada"}));
        let saved =
            create_interpretation(&root, &edition.revision, mine.clone(), &registry).unwrap();
        assert_ne!(saved.revision, edition.revision);
        assert_eq!(load(&root, &registry).unwrap(), saved);
        let stored = fs::read_to_string(library_file(&root)).unwrap();
        assert!(stored.contains("\"interpretations\""), "{stored}");
        let before = fs::read(library_file(&root)).unwrap();

        // Stale revisions, duplicates, unknown ids, invalid entries, and a
        // source still interpreted are all refused without writing.
        assert_eq!(
            update_interpretation(&root, &edition.revision, mine.clone(), &registry).unwrap_err(),
            StoreError::Conflict
        );
        let duplicate =
            create_interpretation(&root, &saved.revision, mine.clone(), &registry).unwrap_err();
        assert_eq!(codes(&duplicate), [SourceDiagnosticCode::DuplicateId]);
        let missing = update_interpretation(
            &root,
            &saved.revision,
            interpretation("absent", "e", serde_json::json!({"name": "N"})),
            &registry,
        )
        .unwrap_err();
        assert_eq!(codes(&missing), [SourceDiagnosticCode::UnknownSource]);
        let stranger = interpretation("e-514a", "e", serde_json::json!({"contributor": "grace"}));
        let unresolved =
            update_interpretation(&root, &saved.revision, stranger, &registry).unwrap_err();
        assert_eq!(
            codes(&unresolved),
            [SourceDiagnosticCode::UnresolvedRelationship]
        );
        assert!(
            unresolved
                .to_string()
                .contains("interpretations[0].interpreters[0].contributor"),
            "{unresolved}"
        );
        let used = remove(&root, &saved.revision, "e", &registry).unwrap_err();
        assert_eq!(codes(&used), [SourceDiagnosticCode::StillUsed]);
        assert!(used.to_string().contains("e-514a"), "{used}");
        assert_eq!(fs::read(library_file(&root)).unwrap(), before);

        // Registry removals are guarded while an interpretation names them.
        let (lock, using) = interpreters_in_use(&root, &registry, &["ada".into()]).unwrap();
        assert!(lock.is_some(), "the library lock is held for the caller");
        assert_eq!(using, [("ada".to_string(), "e-514a".to_string())]);
        drop(lock);

        let (after, removed) =
            remove_interpretation(&root, &saved.revision, "e-514a", &registry).unwrap();
        assert_eq!(removed, mine);
        assert!(after.library.interpretations.is_empty());
        assert!(
            !fs::read_to_string(library_file(&root))
                .unwrap()
                .contains("interpretations"),
            "an empty list is written as an absent field"
        );
        remove(&root, &after.revision, "e", &registry).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_new_source_cannot_take_an_interpretations_id() {
        let root = temp_root("interpretation-id");
        let empty = load(&root, &none()).unwrap();
        let first = create(&root, &empty.revision, work("w"), &none()).unwrap();
        let edition = create(
            &root,
            &first.revision,
            record("e", ResearchSourceKind::Edition, Some("w")),
            &none(),
        )
        .unwrap();
        let saved = create_interpretation(
            &root,
            &edition.revision,
            interpretation("e-514a", "e", serde_json::json!({"name": "N"})),
            &none(),
        )
        .unwrap();
        let before = fs::read(library_file(&root)).unwrap();
        let refused = create(&root, &saved.revision, work("e-514a"), &none()).unwrap_err();
        let StoreError::Invalid(diagnostics) = &refused else {
            panic!("{refused:?}");
        };
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].code, SourceDiagnosticCode::DuplicateId);
        assert_eq!(diagnostics[0].source_id.as_deref(), Some("e-514a"));
        assert_eq!(diagnostics[0].field.as_deref(), Some("id"));
        assert!(diagnostics[0].message.contains("interpretation"));
        assert_eq!(fs::read(library_file(&root)).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interpretation_writes_check_the_registry_as_stored_under_the_lock() {
        let root = temp_root("interpretation-registry");
        let stale = BTreeMap::from([(
            "ada".to_string(),
            openblog_core::contributor::Contributor {
                name: "Ada".into(),
                ..Default::default()
            },
        )]);
        let empty = load(&root, &stale).unwrap();
        let first = create(&root, &empty.revision, work("w"), &stale).unwrap();
        let edition = create(
            &root,
            &first.revision,
            record("e", ResearchSourceKind::Edition, Some("w")),
            &stale,
        )
        .unwrap();
        // Ada was removed from the stored registry after the caller read it.
        fs::write(
            root.join(crate::site::CONFIG_FILE),
            r#"{"contributors":{"grace":{"name":"Grace"}}}"#,
        )
        .unwrap();
        let before = fs::read(library_file(&root)).unwrap();
        let ada = interpretation("e-514a", "e", serde_json::json!({"contributor": "ada"}));
        let refused =
            create_interpretation(&root, &edition.revision, ada.clone(), &stale).unwrap_err();
        assert_eq!(
            codes(&refused),
            [SourceDiagnosticCode::UnresolvedRelationship]
        );
        assert_eq!(fs::read(library_file(&root)).unwrap(), before);
        // A contributor added since the caller read the registry is accepted.
        let grace = interpretation("e-514a", "e", serde_json::json!({"contributor": "grace"}));
        let saved = create_interpretation(&root, &edition.revision, grace, &stale).unwrap();
        let refused = update_interpretation(&root, &saved.revision, ada, &stale).unwrap_err();
        assert_eq!(
            codes(&refused),
            [SourceDiagnosticCode::UnresolvedRelationship]
        );
        // An unreadable registry refuses the write rather than guessing.
        fs::write(root.join(crate::site::CONFIG_FILE), "{not json").unwrap();
        let named = interpretation("e-514b", "e", serde_json::json!({"name": "N"}));
        assert!(create_interpretation(&root, &saved.revision, named, &stale).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_changes_are_scoped_to_the_source_and_field() {
        let root = temp_root("scoped");
        let empty = load(&root, &none()).unwrap();
        let current = create(&root, &empty.revision, work("w"), &none()).unwrap();
        let before = fs::read(library_file(&root)).unwrap();

        let unresolved = record("e", ResearchSourceKind::Edition, Some("missing-work"));
        let mut unsafe_url = record("e", ResearchSourceKind::Edition, Some("w"));
        unsafe_url
            .identifiers
            .push(openblog_core::source_library::SourceIdentifier {
                scheme: "url".into(),
                value: "javascript:alert(1)".into(),
                extra: BTreeMap::new(),
            });
        for (bad, field) in [(unresolved, "of"), (unsafe_url, "identifiers[0]")] {
            let StoreError::Invalid(diagnostics) =
                create(&root, &current.revision, bad, &none()).unwrap_err()
            else {
                panic!("expected diagnostics");
            };
            assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
            assert_eq!(diagnostics[0].index, Some(1));
            assert_eq!(diagnostics[0].source_id.as_deref(), Some("e"));
            assert_eq!(diagnostics[0].field.as_deref(), Some(field));
            assert_eq!(fs::read(library_file(&root)).unwrap(), before);
        }
        assert_eq!(load(&root, &none()).unwrap().revision, current.revision);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn traversal_is_rejected_in_paths_and_identifiers() {
        let root = temp_root("traversal");
        for relative in [
            "../outside/sources.json",
            "./sources.json",
            "",
            "/sources.json",
        ] {
            assert!(
                matches!(
                    contained(&root, Path::new(relative)),
                    Err(StoreError::Storage(_))
                ),
                "{relative}"
            );
        }
        #[cfg(windows)]
        assert!(contained(&root, Path::new(r"C:\sources.json")).is_err());

        let empty = load(&root, &none()).unwrap();
        for id in ["../escape", "..", "a/../../b", r"..\..\b"] {
            let error = create(&root, &empty.revision, work(id), &none()).unwrap_err();
            assert_eq!(codes(&error), [SourceDiagnosticCode::InvalidId], "{id}");
            let error = remove(&root, &empty.revision, id, &none()).unwrap_err();
            assert_eq!(codes(&error), [SourceDiagnosticCode::UnknownSource], "{id}");
        }
        assert!(!library_file(&root).exists());
        assert!(!root.join("escape").exists() && !root.parent().unwrap().join("b").exists());
        assert!(
            !root.join(".openblog").exists(),
            "a refused change creates no private directories"
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// Create a symlink, or report that this platform or account cannot.
    fn try_symlink(target: &Path, link: &Path, directory: bool) -> bool {
        #[cfg(unix)]
        {
            let _ = directory;
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            if directory {
                std::os::windows::fs::symlink_dir(target, link).is_ok()
            } else {
                std::os::windows::fs::symlink_file(target, link).is_ok()
            }
        }
    }

    #[test]
    fn symlinks_cannot_redirect_the_library_outside_private_storage() {
        let base = temp_root("symlink");
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let planted = br#"{"version":1,"sources":[{"id":"w","kind":"work","title":"Outside"}]}"#;
        fs::write(outside.join("sources.json"), planted).unwrap();

        // A symlinked directory, such as research -> static/research.
        let root = base.join("linked-directory");
        fs::create_dir_all(root.join(".openblog/private")).unwrap();
        if !try_symlink(&outside, &root.join(".openblog/private/research"), true) {
            eprintln!("skipping: this account cannot create symlinks");
            fs::remove_dir_all(base).unwrap();
            return;
        }
        assert!(matches!(load(&root, &none()), Err(StoreError::Storage(_))));
        let revision = revision(planted);
        assert!(matches!(
            create(&root, &revision, work("x"), &none()),
            Err(StoreError::Storage(_))
        ));

        // A symlinked library file.
        let root = base.join("linked-file");
        fs::create_dir_all(root.join(".openblog/private/research")).unwrap();
        assert!(try_symlink(
            &outside.join("sources.json"),
            &library_file(&root),
            false
        ));
        let error = load(&root, &none()).unwrap_err();
        assert!(error.to_string().contains("symlink"), "{error}");
        assert!(matches!(
            update(&root, &revision, work("w"), &none()),
            Err(StoreError::Storage(_))
        ));

        assert_eq!(fs::read(outside.join("sources.json")).unwrap(), planted);
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
        fs::remove_dir_all(base).unwrap();
    }

    /// Junctions need no special privilege on Windows, so this always runs there.
    #[cfg(windows)]
    #[test]
    fn junctions_cannot_redirect_the_library_outside_private_storage() {
        let base = temp_root("junction");
        let outside = base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let planted = br#"{"version":1,"sources":[{"id":"w","kind":"work","title":"Outside"}]}"#;
        fs::write(outside.join("sources.json"), planted).unwrap();
        let root = base.join("project");
        fs::create_dir_all(root.join(".openblog/private")).unwrap();
        // cmd reads a forward slash as a switch, so the path uses backslashes.
        let link = root.join(".openblog").join("private").join("research");
        let status = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(status.status.success(), "mklink /J failed: {status:?}");

        assert!(matches!(load(&root, &none()), Err(StoreError::Storage(_))));
        assert!(matches!(
            create(&root, &revision(planted), work("x"), &none()),
            Err(StoreError::Storage(_))
        ));
        assert_eq!(fs::read(outside.join("sources.json")).unwrap(), planted);
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
        fs::remove_dir(&link).unwrap();
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn an_interrupted_write_leaves_the_library_unchanged_and_is_cleaned_up() {
        let root = temp_root("interrupted");
        let empty = load(&root, &none()).unwrap();
        let current = create(&root, &empty.revision, work("w"), &none()).unwrap();
        let before = fs::read(library_file(&root)).unwrap();

        let failed = change_using(
            &root,
            &current.revision,
            &none(),
            |library| library.upsert(work("x"), &none()),
            |_, _| Err(std::io::Error::other("power lost")),
        )
        .unwrap_err();
        assert!(
            matches!(&failed, StoreError::Storage(message) if message.contains("unchanged")),
            "{failed:?}"
        );
        assert_eq!(fs::read(library_file(&root)).unwrap(), before);
        let directory = library_file(&root).parent().unwrap().to_path_buf();
        let names = || -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&directory)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        };
        assert_eq!(
            names(),
            ["sources.json"],
            "no temporary file or lock is left"
        );

        // A crash after the temporary file was written but before the rename.
        fs::write(
            directory.join("sources.json.999-1.tmp"),
            b"{\"version\":1,\"sour",
        )
        .unwrap();
        assert_eq!(load(&root, &none()).unwrap().revision, current.revision);
        let next = create(&root, &current.revision, work("x"), &none()).unwrap();
        assert_eq!(next.library.sources.len(), 2);
        assert_eq!(names(), ["sources.json"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_lock_left_by_a_crashed_writer_blocks_changes_with_a_recovery_hint() {
        let root = temp_root("stale-lock");
        let empty = load(&root, &none()).unwrap();
        let current = create(&root, &empty.revision, work("w"), &none()).unwrap();
        let before = fs::read(library_file(&root)).unwrap();
        let lock = lock_path(&library_file(&root));
        fs::write(&lock, "pid=1 action=source-library-write\n").unwrap();

        let error = create(&root, &current.revision, work("x"), &none()).unwrap_err();
        assert!(
            matches!(&error, StoreError::Storage(message) if message.contains("remove") && message.contains("sources.json.lock")),
            "{error:?}"
        );
        assert_eq!(fs::read(library_file(&root)).unwrap(), before);
        assert_eq!(
            load(&root, &none()).unwrap().revision,
            current.revision,
            "reads never wait"
        );
        fs::remove_file(lock).unwrap();
        create(&root, &current.revision, work("x"), &none()).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_writers_never_lose_an_update() {
        let root = temp_root("concurrent");
        let empty = load(&root, &none()).unwrap();

        // Two writers that read the same revision: exactly one wins.
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let racers: Vec<_> = ["left", "right"]
            .into_iter()
            .map(|id| {
                let (root, revision, barrier) =
                    (root.clone(), empty.revision.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    create(&root, &revision, work(id), &none())
                })
            })
            .collect();
        let outcomes: Vec<_> = racers.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert!(outcomes.contains(&Err(StoreError::Conflict)));

        // Writers that reload after a conflict all land.
        let writers: Vec<_> = (0..6)
            .map(|n| {
                let root = root.clone();
                std::thread::spawn(move || loop {
                    let current = load(&root, &none()).unwrap();
                    match create(&root, &current.revision, work(&format!("w{n}")), &none()) {
                        Err(StoreError::Conflict) => continue,
                        other => return other.map(|_| ()),
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap().unwrap();
        }
        let library = load(&root, &none()).unwrap().library;
        assert_eq!(library.sources.len(), 7);
        for n in 0..6 {
            assert!(library.get(&format!("w{n}")).is_some());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repointing_a_reference_cannot_make_stored_locators_ambiguous() {
        let root = temp_root("notebook-guard");
        let library = serde_json::json!({"version": 1, "sources": [
            {"id": "plato", "kind": "work", "title": "Politeia"},
            {"id": "slings", "kind": "edition", "of": "plato", "title": "Slings"},
            {"id": "ref", "kind": "reference", "of": "slings"}]});
        fs::create_dir_all(library_file(&root).parent().unwrap()).unwrap();
        fs::write(library_file(&root), library.to_string()).unwrap();
        let notebook = root.join(crate::notebook_store::NOTEBOOK_FILE);
        let text = serde_json::json!({"version": 1, "notes": [], "passages": [
            {"id": "p1", "source": "ref", "excerpt": {"text": "q"},
             "locators": [{"kind": "page", "value": "514"}]}]})
        .to_string();
        fs::write(&notebook, &text).unwrap();
        let before = load(&root, &none()).unwrap();
        let library_bytes = fs::read(library_file(&root)).unwrap();

        // Pointing the reference at the work makes page 514 ambiguous.
        let mut moved = before.library.get("ref").unwrap().clone();
        moved.of = Some("plato".into());
        let refused = update(&root, &before.revision, moved, &none());
        let Err(StoreError::Invalid(found)) = refused else {
            panic!("the change must be refused")
        };
        assert_eq!(found[0].source_id.as_deref(), Some("ref"));
        assert!(
            found[0].message.contains("research notebook"),
            "{}",
            found[0].message
        );
        assert!(
            found[0].message.contains("ambiguous-locator"),
            "{}",
            found[0].message
        );
        assert_eq!(fs::read(library_file(&root)).unwrap(), library_bytes);
        assert_eq!(fs::read_to_string(&notebook).unwrap(), text);

        // A change that keeps the notebook valid still goes through.
        let mut renamed = before.library.get("slings").unwrap().clone();
        renamed.title = Some("Slings 2003".into());
        assert!(update(&root, &before.revision, renamed, &none()).is_ok());

        // A notebook that was already unreadable does not freeze the library.
        fs::write(&notebook, b"{").unwrap();
        let now = load(&root, &none()).unwrap();
        let mut again = now.library.get("slings").unwrap().clone();
        again.title = Some("Slings 2004".into());
        assert!(update(&root, &now.revision, again, &none()).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_change_that_would_make_a_published_post_uncitable_is_refused() {
        let root = temp_root("posts-guard");
        let library = serde_json::json!({"version": 1, "sources": [
            {"id": "plato", "kind": "work", "title": "Politeia"},
            {"id": "slings", "kind": "edition", "of": "plato", "title": "Slings"},
            {"id": "ref", "kind": "reference", "of": "slings"},
            {"id": "spare", "kind": "work", "title": "Spare"}]});
        store(&root, library.to_string().as_bytes());
        fs::write(root.join("openblog.json"), r#"{"title":"T"}"#).unwrap();
        fs::create_dir_all(root.join("content/posts")).unwrap();
        let secret = "PRIVATE-POST-TEXT";
        fs::write(
            root.join("content/posts/cave.md"),
            format!("---\ntitle: Cave\ndate: 2026-10-01\ncitations: notes\n---\n{secret}\n\nSee [@ref, page 514] and [@spare].\n"),
        )
        .unwrap();
        // A draft and a post that does not opt in never block an edit.
        fs::write(
            root.join("content/posts/draft.md"),
            "---\ntitle: Draft\ndraft: true\ncitations: notes\n---\nSee [@ref, page 514].\n",
        )
        .unwrap();
        fs::write(
            root.join("content/posts/plain.md"),
            "---\ntitle: Plain\ndate: 2026-10-02\n---\nSee [@ref, page 514].\n",
        )
        .unwrap();
        let before = load(&root, &none()).unwrap();
        let bytes = fs::read(library_file(&root)).unwrap();
        let refused_with = |error: StoreError| {
            let StoreError::Invalid(found) = error else {
                panic!("expected a refusal, got {error:?}")
            };
            assert_eq!(found[0].code, SourceDiagnosticCode::StillUsed);
            assert!(
                found[0].message.contains("posts/cave.md line 8")
                    && !found[0].message.contains("draft.md")
                    && !found[0].message.contains("plain.md")
                    && !found[0].message.contains(secret),
                "{}",
                found[0].message
            );
            assert_eq!(fs::read(library_file(&root)).unwrap(), bytes);
        };

        // Re-pointing the reference at the work makes page 514 ambiguous.
        let mut moved = before.library.get("ref").unwrap().clone();
        moved.of = Some("plato".into());
        refused_with(update(&root, &before.revision, moved, &none()).unwrap_err());
        let items = serde_json::json!([{"id": "ref", "type": "book",
            "custom": {"openblog-kind": "reference", "openblog-of": "plato"}}]);
        refused_with(import_csl(&root, &before.revision, &items.to_string(), &none()).unwrap_err());
        // Removing a cited source would leave the key unknown.
        refused_with(remove(&root, &before.revision, "spare", &none()).unwrap_err());

        // A change that keeps every citation resolvable still goes through.
        let mut renamed = before.library.get("slings").unwrap().clone();
        renamed.title = Some("Slings 2003".into());
        let saved = update(&root, &before.revision, renamed, &none()).unwrap();

        // A post that already failed does not freeze the library.
        fs::write(
            root.join("content/posts/cave.md"),
            "---\ntitle: Cave\ndate: 2026-10-01\ncitations: notes\n---\nSee [@gone] and [@spare].\n",
        )
        .unwrap();
        assert!(remove(&root, &saved.revision, "spare", &none()).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_import_that_repoints_a_reference_is_refused_naming_the_record() {
        let root = temp_root("notebook-guard-import");
        let library = serde_json::json!({"version": 1, "sources": [
            {"id": "plato", "kind": "work", "title": "Politeia"},
            {"id": "slings", "kind": "edition", "of": "plato", "title": "Slings"},
            {"id": "ref", "kind": "reference", "of": "slings"}]});
        fs::create_dir_all(library_file(&root).parent().unwrap()).unwrap();
        fs::write(library_file(&root), library.to_string()).unwrap();
        let notebook = root.join(crate::notebook_store::NOTEBOOK_FILE);
        let text = serde_json::json!({"version": 1, "notes": [], "passages": [
            {"id": "p1", "source": "ref", "excerpt": {"text": "q"},
             "locators": [{"kind": "page", "value": "514"}]}]})
        .to_string();
        fs::write(&notebook, &text).unwrap();
        let before = load(&root, &none()).unwrap();
        let bytes = fs::read(library_file(&root)).unwrap();
        let items = serde_json::json!([{"id": "ref", "type": "book",
            "custom": {"openblog-kind": "reference", "openblog-of": "plato"}}]);
        let refused = import_csl(&root, &before.revision, &items.to_string(), &none());
        let Err(StoreError::Invalid(found)) = refused else {
            panic!("the import must be refused")
        };
        assert_eq!(found[0].source_id.as_deref(), Some("ref"));
        assert!(found[0].message.contains("`ref`"), "{}", found[0].message);
        assert_eq!(fs::read(library_file(&root)).unwrap(), bytes);
        assert_eq!(fs::read_to_string(&notebook).unwrap(), text);
        fs::remove_dir_all(root).unwrap();
    }
}
