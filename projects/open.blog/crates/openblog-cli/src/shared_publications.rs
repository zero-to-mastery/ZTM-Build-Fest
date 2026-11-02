//! Private, file-backed shared publication records.
//!
//! Each record lives in its own JSON file under `.openblog/private/`, which `openblog init`
//! ignores in Git and `openblog publish` refuses to commit. Nothing here reads or writes the
//! content directory, so creating, failing, or revoking a record leaves canonical content and
//! generated output unchanged.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use openblog_core::approval::{ApprovalSet, MAX_APPROVAL_SET_BYTES};
use openblog_core::assembly::Outcome;
use openblog_core::collaboration::{
    NewSharedPublication, SharedPublication, SharedPublicationError, MAX_SHARED_PUBLICATION_BYTES,
};
use openblog_core::draft::{DraftSet, MAX_DRAFT_SET_BYTES};
use openblog_core::invitation::InvitationState;
use openblog_core::media_moment::{MomentSet, MAX_MOMENT_SET_BYTES};
use openblog_core::reflection::ReflectionStructure;
use openblog_core::synthesis::{SynthesisSet, MAX_SYNTHESIS_SET_BYTES};

use crate::auth;

pub const DIRECTORY: &str = ".openblog/private/collaboration/publications";
/// Private contribution draft sets, one file per publication. Also under `.openblog/private/`,
/// so they stay out of Git, generated output, feeds, and exports.
pub const DRAFTS_DIRECTORY: &str = ".openblog/private/collaboration/drafts";
/// Private approval sets, one file per publication, beside the drafts and kept out of Git,
/// output, feeds and exports for the same reason. Nothing here writes them yet.
pub const APPROVALS_DIRECTORY: &str = ".openblog/private/collaboration/approvals";
/// What happened to each publication after approval (scheduled, or published), one small file
/// per publication. Private like the rest, and written only by the publish gate (ADR 0022).
pub const OUTCOMES_DIRECTORY: &str = ".openblog/private/collaboration/outcomes";
/// Private shared synthesis sets (ADR 0025), one file per publication, beside the drafts. Prose
/// lives here, so the directory stays out of Git, generated output, feeds and exports.
pub const SYNTHESIS_DIRECTORY: &str = ".openblog/private/collaboration/synthesis";
const MAX_ID_ATTEMPTS: usize = 8;

#[derive(Debug, PartialEq, Eq)]
pub enum ReplaceError {
    /// The record changed since it was loaded, or is gone.
    Conflict,
    /// The set would be larger than a later load accepts; nothing was written.
    TooLarge,
    Storage(String),
}

#[derive(Debug, PartialEq, Eq)]
pub enum CreateError {
    Invalid(SharedPublicationError),
    Storage(String),
}

fn directory(root: &Path) -> Result<PathBuf, String> {
    crate::assistant_storage::contained_target(root, Path::new(DIRECTORY))
        .map_err(|_| "shared publication storage resolves outside the project".to_string())
}

/// A new opaque publication ID. It carries no title, so file names reveal nothing.
fn random_publication_id() -> Result<String, String> {
    let bytes: [u8; 6] = auth::random_bytes()?;
    Ok(format!(
        "shared-{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

/// Create a record under a fresh opaque ID without ever replacing an existing file.
pub fn create(root: &Path, new: NewSharedPublication) -> Result<SharedPublication, CreateError> {
    create_with(root, new, random_publication_id, |from, to| {
        fs::hard_link(from, to)
    })
}

/// The record is written completely to a private temporary file and then linked into place.
/// Linking fails when the target exists, so two creators can never overwrite each other, and a
/// crash leaves either no record or a complete one. The temporary file is always removed.
fn create_with(
    root: &Path,
    mut new: NewSharedPublication,
    mut next_id: impl FnMut() -> Result<String, String>,
    link: impl Fn(&Path, &Path) -> io::Result<()>,
) -> Result<SharedPublication, CreateError> {
    let directory = directory(root).map_err(CreateError::Storage)?;
    for _ in 0..MAX_ID_ATTEMPTS {
        new.publication_id = next_id().map_err(CreateError::Storage)?;
        let record = SharedPublication::create(&new).map_err(CreateError::Invalid)?;
        let text = record_text(&record).map_err(CreateError::Storage)?;
        create_private_directory(&directory).map_err(CreateError::Storage)?;
        let target = directory.join(format!("{}.json", record.publication_id));
        let temporary =
            temporary_path(&directory, &record.publication_id).map_err(CreateError::Storage)?;
        write_private_file(&temporary, text.as_bytes()).map_err(CreateError::Storage)?;
        let linked = link(&temporary, &target);
        let _ = fs::remove_file(&temporary);
        match linked {
            Ok(()) => return Ok(record),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(CreateError::Storage(format!(
                    "cannot store the shared publication: {error}"
                )))
            }
        }
    }
    Err(CreateError::Storage(
        "cannot choose an unused shared publication ID".into(),
    ))
}

/// Every readable record, in file-name order. A record that is malformed, oversized, a symlink,
/// or stored under a name other than its own publication ID grants nothing and is skipped.
pub fn load_all(root: &Path) -> Result<Vec<(PathBuf, SharedPublication)>, String> {
    let directory = directory(root)?;
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("cannot read shared publications: {error}")),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("cannot read shared publications: {error}"))?;
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if file_type.is_file() && !name.starts_with('.') && name.ends_with(".json") {
            paths.push(entry.path());
        }
    }
    paths.sort();
    let mut records = Vec::new();
    for path in paths {
        if fs::metadata(&path).map_or(true, |metadata| {
            metadata.len() > MAX_SHARED_PUBLICATION_BYTES as u64
        }) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(record) = SharedPublication::from_json(&text) else {
            continue;
        };
        let stem = path.file_stem().and_then(|stem| stem.to_str());
        if stem == Some(record.publication_id.as_str()) {
            records.push((path, record));
        }
    }
    Ok(records)
}

/// Contributor registry keys that some record binds, so the registry cannot rename or remove a
/// key that a binding would follow if it were reused.
pub fn bound_contributor_ids(root: &Path) -> Result<BTreeSet<String>, String> {
    Ok(load_all(root)?
        .into_iter()
        .flat_map(|(_, record)| {
            let invited = record
                .invitations
                .iter()
                .filter(|invitation| invitation.state == InvitationState::Pending)
                .map(|invitation| invitation.contributor_id.clone())
                .collect::<Vec<_>>();
            record
                .authorization
                .bindings
                .into_iter()
                .map(|binding| binding.contributor_id)
                .chain(invited)
                .collect::<Vec<_>>()
        })
        .collect())
}

/// Atomically replace a record that nobody changed since `previous` was loaded. The caller holds
/// the Admin content transaction lock; the comparison also catches a change made outside it, so
/// a stale decision is refused instead of overwriting newer state.
pub fn replace(
    root: &Path,
    previous: &SharedPublication,
    next: &SharedPublication,
) -> Result<(), ReplaceError> {
    if previous.publication_id != next.publication_id {
        return Err(ReplaceError::Conflict);
    }
    let directory = directory(root).map_err(ReplaceError::Storage)?;
    let target = directory.join(format!("{}.json", previous.publication_id));
    let unchanged = || {
        let current = crate::fsutil::retry_transient(|| fs::symlink_metadata(&target))
            .ok()
            .filter(|metadata| {
                metadata.is_file() && metadata.len() <= MAX_SHARED_PUBLICATION_BYTES as u64
            })
            .and_then(|_| crate::fsutil::read_to_string(&target).ok())
            .and_then(|text| SharedPublication::from_json(&text).ok());
        current.as_ref() == Some(previous)
    };
    if !unchanged() {
        return Err(ReplaceError::Conflict);
    }
    let text = record_text(next).map_err(ReplaceError::Storage)?;
    // A record that would not load again is never written: the old one stays in place.
    if text.len() > MAX_SHARED_PUBLICATION_BYTES {
        return Err(ReplaceError::TooLarge);
    }
    let temporary =
        temporary_path(&directory, &next.publication_id).map_err(ReplaceError::Storage)?;
    write_private_file(&temporary, text.as_bytes()).map_err(ReplaceError::Storage)?;
    commit_if_unchanged(&temporary, &target, unchanged, "the shared publication")
}

/// Rename a complete `temporary` over `target` while `unchanged` still holds, so neither a
/// conflict nor waiting out a transient Windows hold can overwrite a newer file. On any refusal
/// the temporary file is removed and `target` is untouched.
fn commit_if_unchanged(
    temporary: &Path,
    target: &Path,
    unchanged: impl FnMut() -> bool,
    what: &str,
) -> Result<(), ReplaceError> {
    match crate::fsutil::replace_file_if_unchanged(temporary, target, unchanged) {
        Ok(true) => Ok(()),
        Ok(false) => {
            let _ = fs::remove_file(temporary);
            Err(ReplaceError::Conflict)
        }
        Err(error) => {
            let _ = fs::remove_file(temporary);
            Err(ReplaceError::Storage(format!(
                "cannot update {what}: {error}"
            )))
        }
    }
}

/// The record with this ID, if it is readable.
pub fn load(root: &Path, publication_id: &str) -> Result<Option<SharedPublication>, String> {
    Ok(load_all(root)?
        .into_iter()
        .map(|(_, record)| record)
        .find(|record| record.publication_id == publication_id))
}

/// Remove every binding for an Admin username, so an account created later under the same
/// name inherits nothing. Returns how many records changed.
pub fn revoke_admin_user(root: &Path, admin_user: &str) -> Result<usize, String> {
    let mut changed = 0;
    for (path, record) in load_all(root)? {
        let Some(revoked) = record.without_admin_user(admin_user) else {
            continue;
        };
        let text = record_text(&revoked)?;
        let directory = path.parent().ok_or("invalid shared publication path")?;
        let temporary = temporary_path(directory, &revoked.publication_id)?;
        write_private_file(&temporary, text.as_bytes())?;
        crate::fsutil::replace_file(&temporary, &path).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!("cannot update a shared publication: {error}")
        })?;
        changed += 1;
    }
    Ok(changed)
}

/// A draft set as read from disk, with the exact text it came from. Storing compares that text,
/// so a save built on a stale read is refused instead of overwriting a newer file.
pub struct StoredDrafts {
    pub set: Option<DraftSet>,
    text: Option<String>,
}

fn drafts_directory(root: &Path) -> Result<PathBuf, String> {
    crate::assistant_storage::contained_target(root, Path::new(DRAFTS_DIRECTORY))
        .map_err(|_| "draft storage resolves outside the project".to_string())
}

fn read_drafts_file(target: &Path) -> Result<Option<String>, String> {
    let metadata = match crate::fsutil::retry_transient(|| fs::symlink_metadata(target)) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("cannot read the draft file".into()),
    };
    // A symlink, directory, or oversized file is never followed or replaced: refusing keeps
    // whatever drafts it holds intact for recovery.
    if !metadata.is_file() || metadata.len() > MAX_DRAFT_SET_BYTES as u64 {
        return Err("the draft file is not usable".into());
    }
    crate::fsutil::read_to_string(target)
        .map(Some)
        .map_err(|_| "cannot read the draft file".to_string())
}

/// The draft set for a publication, or none when nobody has saved yet. A file that exists but
/// is malformed is an error, never an empty set, so a bad file cannot silently lose drafts.
pub fn load_drafts(root: &Path, publication_id: &str) -> Result<StoredDrafts, String> {
    let target = drafts_directory(root)?.join(format!("{publication_id}.json"));
    let text = read_drafts_file(&target)?;
    let set = match &text {
        Some(text) => Some(
            DraftSet::from_json(text).map_err(|_| "the draft file is not usable".to_string())?,
        ),
        None => None,
    };
    Ok(StoredDrafts { set, text })
}

/// The approval set for a publication; an empty set when nothing was stored. A file that exists
/// but is malformed is an error, never an empty set, so a bad file cannot make a piece look
/// unapproved or approved. Read-only.
pub fn load_approvals(root: &Path, publication_id: &str) -> Result<ApprovalSet, String> {
    let directory =
        crate::assistant_storage::contained_target(root, Path::new(APPROVALS_DIRECTORY))
            .map_err(|_| "approval storage resolves outside the project".to_string())?;
    let target = directory.join(format!("{publication_id}.json"));
    match read_drafts_file(&target) {
        Ok(None) => Ok(ApprovalSet::new()),
        Ok(Some(text)) => {
            ApprovalSet::from_json(&text).map_err(|_| "the approval file is not usable".to_string())
        }
        Err(_) => Err("the approval file is not usable".to_string()),
    }
}

/// Atomically store `next` when the file still holds exactly what `previous` was read from. The
/// caller holds the Admin content transaction lock; the comparison also catches outside changes.
/// A crash leaves either the old complete file or the new one, never a partial draft.
pub fn replace_drafts(
    root: &Path,
    publication_id: &str,
    previous: &StoredDrafts,
    next: &DraftSet,
) -> Result<(), ReplaceError> {
    let directory = drafts_directory(root).map_err(ReplaceError::Storage)?;
    let text = format!(
        "{}
",
        next.to_json()
    );
    replace_text(
        &directory,
        publication_id,
        &previous.text,
        Some(&text),
        MAX_DRAFT_SET_BYTES,
    )
}

/// Compare-and-swap one private file: store `next` (or delete the file for `None`) only when it
/// still holds exactly `previous`. Refuses a symlink, directory or oversized file untouched.
fn replace_text(
    directory: &Path,
    publication_id: &str,
    previous: &Option<String>,
    next: Option<&str>,
    max_bytes: usize,
) -> Result<(), ReplaceError> {
    let target = directory.join(format!("{publication_id}.json"));
    let unchanged = || read_drafts_file(&target).is_ok_and(|current| &current == previous);
    if !unchanged() {
        return Err(ReplaceError::Conflict);
    }
    let Some(text) = next else {
        return match crate::fsutil::retry_transient(|| fs::remove_file(&target)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(ReplaceError::Storage(format!(
                "cannot remove the file: {error}"
            ))),
        };
    };
    if text.len() > max_bytes {
        return Err(ReplaceError::TooLarge);
    }
    create_private_directory(directory).map_err(ReplaceError::Storage)?;
    let temporary = temporary_path(directory, publication_id).map_err(ReplaceError::Storage)?;
    write_private_file(&temporary, text.as_bytes()).map_err(ReplaceError::Storage)?;
    commit_if_unchanged(&temporary, &target, unchanged, "the file")
}

/// An approval set as read from disk, with the exact text it came from, so a write built on a
/// stale read is refused.
pub struct StoredApprovals {
    pub set: ApprovalSet,
    text: Option<String>,
}

fn approvals_directory(root: &Path) -> Result<PathBuf, String> {
    crate::assistant_storage::contained_target(root, Path::new(APPROVALS_DIRECTORY))
        .map_err(|_| "approval storage resolves outside the project".to_string())
}

/// Like [`load_approvals`], keeping the text so [`replace_approvals`] can detect a concurrent change.
pub fn load_approvals_for_update(
    root: &Path,
    publication_id: &str,
) -> Result<StoredApprovals, String> {
    let target = approvals_directory(root)?.join(format!("{publication_id}.json"));
    let text = read_drafts_file(&target).map_err(|_| "the approval file is not usable")?;
    let set = match &text {
        Some(text) => ApprovalSet::from_json(text)
            .map_err(|_| "the approval file is not usable".to_string())?,
        None => ApprovalSet::new(),
    };
    Ok(StoredApprovals { set, text })
}

pub fn replace_approvals(
    root: &Path,
    publication_id: &str,
    previous: &StoredApprovals,
    next: &ApprovalSet,
) -> Result<(), ReplaceError> {
    let directory = approvals_directory(root).map_err(ReplaceError::Storage)?;
    let text = format!(
        "{}
",
        next.to_json()
    );
    replace_text(
        &directory,
        publication_id,
        &previous.text,
        Some(&text),
        MAX_APPROVAL_SET_BYTES,
    )
}

/// A shared reflection's private arrangement (ADR 0031), one small file per publication beside
/// the drafts. Absent means nothing was arranged: the piece publishes in participant order.
pub const STRUCTURES_DIRECTORY: &str = ".openblog/private/collaboration/structures";

/// An arrangement as read from disk, with the exact text it came from, so a write built on a
/// stale read is refused.
pub struct StoredStructure {
    pub structure: Option<ReflectionStructure>,
    text: Option<String>,
}

fn structures_directory(root: &Path) -> Result<PathBuf, String> {
    crate::assistant_storage::contained_target(root, Path::new(STRUCTURES_DIRECTORY))
        .map_err(|_| "arrangement storage resolves outside the project".to_string())
}

/// The arrangement, or none when nobody arranged anything. A file that exists but is malformed
/// is an error, never "no arrangement", so a bad file cannot change what gets published.
pub fn load_structure(root: &Path, publication_id: &str) -> Result<StoredStructure, String> {
    let target = structures_directory(root)?.join(format!("{publication_id}.json"));
    let text = read_drafts_file(&target).map_err(|_| "the arrangement file is not usable")?;
    let structure = match &text {
        Some(text) => Some(
            ReflectionStructure::from_json(text)
                .map_err(|_| "the arrangement file is not usable".to_string())?,
        ),
        None => None,
    };
    Ok(StoredStructure { structure, text })
}

/// Atomically store `next` when the file still holds exactly what `previous` was read from.
pub fn replace_structure(
    root: &Path,
    publication_id: &str,
    previous: &StoredStructure,
    next: &ReflectionStructure,
) -> Result<(), ReplaceError> {
    let directory = structures_directory(root).map_err(ReplaceError::Storage)?;
    let text = format!(
        "{}\n",
        serde_json::to_string(next).expect("a structure serializes")
    );
    replace_text(
        &directory,
        publication_id,
        &previous.text,
        Some(&text),
        openblog_core::reflection::MAX_STRUCTURE_BYTES,
    )
}

/// A synthesis set as read from disk, with the exact text it came from, so a write built on a
/// stale read is refused.
pub struct StoredSynthesis {
    pub set: SynthesisSet,
    text: Option<String>,
}

fn synthesis_directory(root: &Path) -> Result<PathBuf, String> {
    crate::assistant_storage::contained_target(root, Path::new(SYNTHESIS_DIRECTORY))
        .map_err(|_| "synthesis storage resolves outside the project".to_string())
}

/// The synthesis for a publication: empty when nothing was stored. A file that exists but is
/// malformed is an error, never an empty set, so a bad file cannot make a piece look
/// synthesis-free and publishable.
pub fn load_synthesis(root: &Path, publication_id: &str) -> Result<StoredSynthesis, String> {
    let target = synthesis_directory(root)?.join(format!("{publication_id}.json"));
    let text = read_drafts_file(&target).map_err(|_| "the synthesis file is not usable")?;
    let set = match &text {
        Some(text) => SynthesisSet::from_json(text)
            .map_err(|_| "the synthesis file is not usable".to_string())?,
        None => SynthesisSet::new(),
    };
    Ok(StoredSynthesis { set, text })
}

/// Atomically store `next` when the file still holds exactly what `previous` was read from.
pub fn replace_synthesis(
    root: &Path,
    publication_id: &str,
    previous: &StoredSynthesis,
    next: &SynthesisSet,
) -> Result<(), ReplaceError> {
    let directory = synthesis_directory(root).map_err(ReplaceError::Storage)?;
    let text = format!(
        "{}
",
        next.to_json()
    );
    replace_text(
        &directory,
        publication_id,
        &previous.text,
        Some(&text),
        MAX_SYNTHESIS_SET_BYTES,
    )
}

/// Private media moment sets (ADR 0063, 0064), one file per publication, beside the drafts. They
/// hold quotations and observations, so the directory stays out of Git, generated output, feeds
/// and exports like the drafts and the synthesis.
pub const MOMENTS_DIRECTORY: &str = ".openblog/private/collaboration/moments";

/// A moment set as read from disk, with the exact text it came from, so a write built on a stale
/// read is refused.
pub struct StoredMoments {
    pub set: MomentSet,
    text: Option<String>,
}

fn moments_directory(root: &Path) -> Result<PathBuf, String> {
    crate::assistant_storage::contained_target(root, Path::new(MOMENTS_DIRECTORY))
        .map_err(|_| "moment storage resolves outside the project".to_string())
}

/// The moments for a publication: empty when nothing was stored. A file that exists but is
/// malformed is an error, never an empty set, so a bad file cannot drop a proposed moment from
/// the approval binding and make a piece look approved.
pub fn load_moments(root: &Path, publication_id: &str) -> Result<StoredMoments, String> {
    let target = moments_directory(root)?.join(format!("{publication_id}.json"));
    let text = read_drafts_file(&target).map_err(|_| "the moments file is not usable")?;
    let set = match &text {
        Some(text) => {
            MomentSet::from_json(text).map_err(|_| "the moments file is not usable".to_string())?
        }
        None => MomentSet::new(),
    };
    Ok(StoredMoments { set, text })
}

/// Atomically store `next` when the file still holds exactly what `previous` was read from.
pub fn replace_moments(
    root: &Path,
    publication_id: &str,
    previous: &StoredMoments,
    next: &MomentSet,
) -> Result<(), ReplaceError> {
    let directory = moments_directory(root).map_err(ReplaceError::Storage)?;
    let text = format!("{}\n", next.to_json());
    replace_text(
        &directory,
        publication_id,
        &previous.text,
        Some(&text),
        MAX_MOMENT_SET_BYTES,
    )
}

/// A publication's outcome as read from disk, with the text it came from.
pub struct StoredOutcome {
    pub outcome: Option<Outcome>,
    text: Option<String>,
}

fn outcomes_directory(root: &Path) -> Result<PathBuf, String> {
    crate::assistant_storage::contained_target(root, Path::new(OUTCOMES_DIRECTORY))
        .map_err(|_| "publication storage resolves outside the project".to_string())
}

/// The outcome, or none when the publication was never scheduled or published. A file that
/// exists but is not valid is an error, never "unpublished", so a bad file cannot cause a
/// second publication.
pub fn load_outcome(root: &Path, publication_id: &str) -> Result<StoredOutcome, String> {
    let target = outcomes_directory(root)?.join(format!("{publication_id}.json"));
    let text = read_drafts_file(&target).map_err(|_| "the publication state is not usable")?;
    let outcome = match &text {
        Some(text) => Some(
            Outcome::from_json(text)
                .ok_or_else(|| "the publication state is not usable".to_string())?,
        ),
        None => None,
    };
    Ok(StoredOutcome { outcome, text })
}

/// Store `next` (or remove the outcome for `None`) when the file still holds `previous`. Returns
/// what is now stored, so a caller can roll back with it.
pub fn replace_outcome(
    root: &Path,
    publication_id: &str,
    previous: &StoredOutcome,
    next: Option<&Outcome>,
) -> Result<StoredOutcome, ReplaceError> {
    let directory = outcomes_directory(root).map_err(ReplaceError::Storage)?;
    let text = next.map(|outcome| {
        format!(
            "{}
",
            outcome.to_json()
        )
    });
    replace_text(
        &directory,
        publication_id,
        &previous.text,
        text.as_deref(),
        openblog_core::assembly::MAX_OUTCOME_BYTES,
    )?;
    Ok(StoredOutcome {
        outcome: next.cloned(),
        text,
    })
}

/// Publication IDs that have a stored outcome file, for the scheduler to inspect. Names only.
pub fn outcome_ids(root: &Path) -> Vec<String> {
    let Ok(directory) = outcomes_directory(root) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter_map(|name| name.strip_suffix(".json").map(str::to_string))
        .filter(|id| id.starts_with("shared-"))
        .collect()
}

fn record_text(record: &SharedPublication) -> Result<String, String> {
    serde_json::to_string_pretty(record)
        .map(|text| format!("{text}\n"))
        .map_err(|error| format!("cannot serialize the shared publication: {error}"))
}

fn temporary_path(directory: &Path, publication_id: &str) -> Result<PathBuf, String> {
    let token = auth::random_token()?;
    Ok(directory.join(format!(".{publication_id}.{}.tmp", &token[..16])))
}

fn create_private_directory(directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("cannot create shared publication storage: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("cannot protect shared publication storage: {error}"))?;
    }
    Ok(())
}

fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = options.open(path).and_then(|mut file| {
        file.write_all(contents)?;
        file.sync_all()
    });
    result.map_err(|error| {
        let _ = fs::remove_file(path);
        format!("cannot write the shared publication: {error}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use openblog_core::collaboration::{NewParticipant, NewSourceReference, SourceKind};
    use std::sync::{Arc, Barrier};

    struct Root(PathBuf);

    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn root(tag: &str) -> Root {
        let path = std::env::temp_dir().join(format!(
            "ob-shared-publications-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Root(path)
    }

    fn request(admin_user: &str) -> NewSharedPublication {
        NewSharedPublication {
            title: "Listening together".into(),
            sources: vec![NewSourceReference {
                kind: SourceKind::Podcast,
                title: "Episode 4".into(),
                url: "https://example.org/4".into(),
                ..NewSourceReference::default()
            }],
            creator: NewParticipant {
                admin_user: admin_user.into(),
                contributor_id: "ada".into(),
                display_name: "Ada".into(),
            },
            ..NewSharedPublication::default()
        }
    }

    fn stored_files(root: &Path) -> Vec<String> {
        let mut names = fs::read_dir(root.join(DIRECTORY))
            .map(|entries| {
                entries
                    .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn fixed_ids(ids: &[&str]) -> impl FnMut() -> Result<String, String> {
        let mut ids = ids.iter().map(|id| id.to_string()).collect::<Vec<_>>();
        ids.reverse();
        move || ids.pop().ok_or_else(|| "no more IDs".to_string())
    }

    #[test]
    fn creation_stores_one_private_record_under_an_opaque_id() {
        let root = root("create");
        let record = create(&root.0, request("ada-admin")).unwrap();
        assert!(record.publication_id.starts_with("shared-"));
        assert_eq!(record.publication_id.len(), "shared-".len() + 12);
        assert_eq!(
            stored_files(&root.0),
            [format!("{}.json", record.publication_id)]
        );
        let loaded = load_all(&root.0).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].1, record);
        let text = fs::read_to_string(&loaded[0].0).unwrap();
        assert!(!text.contains("Listening together\n") && text.ends_with("}\n"));
        assert!(!root.0.join("content").exists());
    }

    #[test]
    fn a_taken_id_is_never_overwritten_and_the_next_one_is_used() {
        let root = root("collision");
        let first = create_with(
            &root.0,
            request("ada-admin"),
            fixed_ids(&["shared-taken"]),
            |from, to| fs::hard_link(from, to),
        )
        .unwrap();
        let before = fs::read(root.0.join(DIRECTORY).join("shared-taken.json")).unwrap();
        let mut second_request = request("grace-admin");
        second_request.title = "Another".into();
        let second = create_with(
            &root.0,
            second_request,
            fixed_ids(&["shared-taken", "shared-fresh"]),
            |from, to| fs::hard_link(from, to),
        )
        .unwrap();
        assert_eq!(first.publication_id, "shared-taken");
        assert_eq!(second.publication_id, "shared-fresh");
        assert_eq!(
            fs::read(root.0.join(DIRECTORY).join("shared-taken.json")).unwrap(),
            before
        );
        assert_eq!(
            stored_files(&root.0),
            ["shared-fresh.json", "shared-taken.json"]
        );

        let exhausted = create_with(
            &root.0,
            request("linus-admin"),
            || Ok("shared-taken".to_string()),
            |from, to| fs::hard_link(from, to),
        );
        assert!(matches!(exhausted, Err(CreateError::Storage(_))));
        assert_eq!(stored_files(&root.0).len(), 2);
    }

    #[test]
    fn a_failed_write_rolls_back_without_leaving_files() {
        let root = root("rollback");
        let failed = create_with(
            &root.0,
            request("ada-admin"),
            fixed_ids(&["shared-broken"]),
            |_, _| Err(io::Error::new(io::ErrorKind::PermissionDenied, "disk full")),
        );
        assert!(matches!(failed, Err(CreateError::Storage(_))));
        assert!(stored_files(&root.0).is_empty());
        assert!(load_all(&root.0).unwrap().is_empty());

        let mut invalid = request("ada-admin");
        invalid.sources[0].url = "javascript:alert(1)".into();
        assert!(matches!(
            create(&root.0, invalid),
            Err(CreateError::Invalid(_))
        ));
        assert!(stored_files(&root.0).is_empty());
    }

    #[test]
    fn concurrent_creators_each_get_their_own_record() {
        let root = root("concurrent");
        let barrier = Arc::new(Barrier::new(4));
        let threads = (0..4)
            .map(|index| {
                let path = root.0.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let mut ids = vec!["shared-race".to_string(), format!("shared-race-{index}")];
                    ids.reverse();
                    barrier.wait();
                    create_with(
                        &path,
                        request(&format!("writer-{index}")),
                        move || ids.pop().ok_or_else(|| "no more IDs".to_string()),
                        |from, to| fs::hard_link(from, to),
                    )
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let mut ids = threads
            .into_iter()
            .map(|thread| thread.join().unwrap().publication_id)
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 4);
        let loaded = load_all(&root.0).unwrap();
        assert_eq!(loaded.len(), 4);
        let winner = loaded
            .iter()
            .find(|(_, record)| record.publication_id == "shared-race")
            .expect("one creator won the shared ID");
        assert_eq!(winner.1.authorization.bindings.len(), 1);
    }

    #[test]
    fn unreadable_misnamed_and_partial_records_are_skipped() {
        let root = root("skip");
        let record = create(&root.0, request("ada-admin")).unwrap();
        let directory = root.0.join(DIRECTORY);
        fs::write(directory.join("broken.json"), "{ not json").unwrap();
        fs::write(directory.join(".shared-x.0123.tmp"), "{").unwrap();
        fs::copy(
            directory.join(format!("{}.json", record.publication_id)),
            directory.join("shared-copy.json"),
        )
        .unwrap();
        let loaded = load_all(&root.0).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].1.publication_id, record.publication_id);
    }

    #[cfg(unix)]
    #[test]
    fn storage_behind_a_symlink_outside_the_project_is_refused() {
        let root = root("symlink");
        let outside = root.0.with_extension("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(root.0.join(".openblog")).unwrap();
        std::os::unix::fs::symlink(&outside, root.0.join(".openblog/private")).unwrap();
        assert!(matches!(
            create(&root.0, request("ada-admin")),
            Err(CreateError::Storage(_))
        ));
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn a_record_stored_as_a_symlink_grants_nothing() {
        let root = root("symlink-record");
        let elsewhere = root.0.with_extension("elsewhere");
        let _ = fs::remove_dir_all(&elsewhere);
        fs::create_dir_all(&elsewhere).unwrap();
        let other = create(&elsewhere, request("ada-admin")).unwrap();
        fs::create_dir_all(root.0.join(DIRECTORY)).unwrap();
        let name = format!("{}.json", other.publication_id);
        std::os::unix::fs::symlink(
            elsewhere.join(DIRECTORY).join(&name),
            root.0.join(DIRECTORY).join(&name),
        )
        .unwrap();
        assert!(load_all(&root.0).unwrap().is_empty());
        assert!(bound_contributor_ids(&root.0).unwrap().is_empty());
        let _ = fs::remove_dir_all(elsewhere);
    }

    #[test]
    fn revoking_an_admin_user_removes_only_their_bindings() {
        let root = root("revoke");
        let ada = create(&root.0, request("ada-admin")).unwrap();
        let grace = create(&root.0, request("grace-admin")).unwrap();
        assert_eq!(
            bound_contributor_ids(&root.0).unwrap(),
            BTreeSet::from(["ada".to_string()])
        );

        assert_eq!(revoke_admin_user(&root.0, "ada-admin").unwrap(), 1);
        assert_eq!(revoke_admin_user(&root.0, "ada-admin").unwrap(), 0);
        let loaded = load_all(&root.0).unwrap();
        let find = |id: &str| {
            loaded
                .iter()
                .find(|(_, record)| record.publication_id == id)
                .map(|(_, record)| record.clone())
                .unwrap()
        };
        let revoked = find(&ada.publication_id);
        assert!(revoked.authorization.bindings.is_empty());
        assert_eq!(revoked.authorization.revision, 2);
        assert_eq!(find(&grace.publication_id), grace);
        assert_eq!(stored_files(&root.0).len(), 2);
    }
    #[test]
    fn replacing_a_record_refuses_a_stale_or_foreign_copy_and_changes_nothing() {
        let root = root("replace");
        let stored = create(&root.0, request("ada-admin")).unwrap();
        let mut newer = stored.clone();
        newer.authorization.revision += 1;
        replace(&root.0, &stored, &newer).unwrap();
        assert_eq!(
            load(&root.0, &stored.publication_id).unwrap(),
            Some(newer.clone())
        );

        let mut other = newer.clone();
        other.authorization.revision += 1;
        let before = fs::read(
            root.0
                .join(DIRECTORY)
                .join(format!("{}.json", stored.publication_id)),
        )
        .unwrap();
        assert_eq!(
            replace(&root.0, &stored, &other),
            Err(ReplaceError::Conflict)
        );
        other.publication_id = "shared-someoneelse".into();
        assert_eq!(
            replace(&root.0, &newer, &other),
            Err(ReplaceError::Conflict)
        );
        let after = fs::read(
            root.0
                .join(DIRECTORY)
                .join(format!("{}.json", stored.publication_id)),
        )
        .unwrap();
        assert_eq!(before, after);
        assert_eq!(stored_files(&root.0).len(), 1);
        assert_eq!(load(&root.0, "shared-missing").unwrap(), None);
    }
}
