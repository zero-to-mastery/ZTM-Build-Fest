//! Private, file-backed storage for claims and evidence links (Evidence
//! Studio).
//!
//! The claims file lives at [`CLAIMS_FILE`] beside the source library, the
//! research notebook and the Knowledge Atlas, inside the Git-ignored private
//! directory and outside content, static files, themes and build output, so no
//! feed, search index, `llms.txt`, export or generated page reads it. A build
//! reads it only to report evidence gaps to the author ([`build_findings`],
//! ADR 0074), and nothing from it reaches the build's output. It points into
//! the library and the notebook (source ids, locators, passages) and copies
//! neither. Every change names the revision it was based on, is validated by
//! `openblog_core::claims` against the library and notebook as stored, and
//! replaces the file by atomic rename while holding locks: a refused, failed
//! or interrupted change leaves the stored file exactly as it was.
//!
//! Locks are always taken in one order: atlas, claims, alignments, notebook,
//! library (ADR 0072, ADR 0089). A claims write takes claims, notebook and
//! library; it never holds the atlas or alignments lock, and neither of their
//! writers takes the claims lock, so each writer takes its locks in that one
//! order and no two can wait on each other. Notebook and library changes take a suffix of the order and only
//! *read* the claims file, which is safe because a claims write holds their
//! locks for its whole critical section.
//!
//! Anchors are checked against the post's saved draft ([`read_saved_posts`]), and
//! never against unsaved editor text: a stale or ambiguous range is refused
//! before anything is written.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use openblog_core::claims::{self, Claim, ClaimSet, Drafts, EvidenceLink, MAX_CLAIMS_BYTES};
use openblog_core::contributor::Contributor;
use openblog_core::knowledge_atlas::{
    AtlasDiagnostic, AtlasDiagnosticCode, DiagnosticSubject, Links,
};
use openblog_core::research::EvidenceFinding;
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;

use crate::notebook_store;
use crate::source_store::{self, StoreError as LibraryError};
use crate::transaction::FileLock;

/// Where claims and evidence links live, relative to the project root.
pub const CLAIMS_FILE: &str = ".openblog/private/research/claims.json";
const LOCK_WAIT: Duration = Duration::from_secs(2);
/// A post larger than this is not read as a draft (Admin refuses such posts).
const MAX_DRAFT_BYTES: u64 = 4 * 1024 * 1024;

/// One read of the claims file and the revision a later change must name.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub claims: ClaimSet,
    /// SHA-256 of the stored bytes, or of the empty file while none is stored.
    pub revision: String,
    /// False until the first change creates the file.
    pub stored: bool,
    /// The source library and notebook the claims were validated against.
    pub library: SourceLibrary,
    pub notebook: Notebook,
}

#[derive(Debug, PartialEq)]
pub enum StoreError {
    /// The claims file changed after the caller read the revision it named.
    Conflict,
    /// The stored file or the requested change is invalid. Nothing was written.
    Invalid(Vec<AtlasDiagnostic>),
    /// The claims file, notebook or library could not be located, read or
    /// written safely. Nothing was written.
    Storage(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict => formatter.write_str(
                "the claims file changed since it was read; reload it and apply the change again",
            ),
            Self::Invalid(diagnostics) => {
                for (position, diagnostic) in diagnostics.iter().enumerate() {
                    if position > 0 {
                        formatter.write_str("\n")?;
                    }
                    write!(formatter, "{CLAIMS_FILE}: {diagnostic}")?;
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
            "the source library cannot be read, so the claims file cannot be checked against it: {other}"
        )),
    }
}

fn notebook_blocked(error: notebook_store::StoreError) -> StoreError {
    match error {
        notebook_store::StoreError::Storage(message) => StoreError::Storage(message),
        other => StoreError::Storage(format!(
            "the research notebook cannot be read, so the claims file cannot be checked against it: {other}"
        )),
    }
}

/// Read and validate the claims file against the stored library and
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

/// The claims file as a build reads it, against the library read for a build
/// (`source_store::load_for_build`), so a problem in an interpretation never
/// stops a build.
pub(crate) fn load_for_build(
    root: &Path,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    let library = source_store::load_for_build(root, contributors)
        .map_err(library_blocked)?
        .library;
    against_library(root, library)
}

/// The claims against a library and notebook already read for a build.
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

/// Evidence links that rest on a source, for the library's removal guard. A
/// claims file that cannot be read blocks removal with a message instead of
/// guessing.
pub fn uses_of_source(
    root: &Path,
    library: &SourceLibrary,
    source: &str,
) -> Result<Vec<String>, String> {
    against_library(root, library.clone())
        .map(|snapshot| snapshot.claims.uses_of_source(source))
        .map_err(|error| {
            format!(
                "the claims file cannot be checked ({error}); repair it before removing a source"
            )
        })
}

/// Evidence links that point into a notebook passage, for the notebook's
/// removal guard. A claims file that cannot be read blocks removal.
pub fn uses_of_passage(
    root: &Path,
    library: &SourceLibrary,
    notebook: &Notebook,
    passage: &str,
) -> Result<Vec<String>, String> {
    read(root, library.clone(), notebook.clone())
        .map(|snapshot| snapshot.claims.uses_of_passage(passage))
        .map_err(|error| {
            format!(
                "the claims file cannot be checked ({error}); repair it before removing a passage"
            )
        })
}

/// Whether the stored claims file is valid against this library and notebook.
/// An absent file always is.
pub fn check_against(
    root: &Path,
    library: &SourceLibrary,
    notebook: &Notebook,
) -> Result<(), String> {
    read(root, library.clone(), notebook.clone())
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Whether the stored claims file is valid against a library that is about to
/// replace the stored one, with the notebook read against that library.
pub fn check_against_library(root: &Path, library: &SourceLibrary) -> Result<(), String> {
    against_library(root, library.clone())
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// The anchor text of every post the build reads, by slug, from the saved
/// files with [`claims::anchor_text`], and each post's path relative to the
/// content folder, so findings can name the post they are about. Posts are
/// decided as the build decides them ([`crate::site::not_content`] and
/// [`openblog_core::classify_source`]), so a README or a copy under a
/// `_`-prefixed folder such as `posts/_drafts/` never shares a slug with the
/// real post. A post that cannot be read, a symlink, an oversized file, and
/// two posts claiming one slug are left out, so an anchor in them cannot be
/// verified.
pub fn read_saved_posts(root: &Path, content_dir: &str) -> (Drafts, BTreeMap<String, String>) {
    let posts = saved_post_sources(root, content_dir);
    drafts_of(
        posts
            .iter()
            .map(|(path, source)| (path.as_str(), source.as_str())),
    )
}

/// The saved posts, as (path relative to the content folder, source), with
/// the same exclusions as [`read_saved_posts`].
pub fn saved_post_sources(root: &Path, content_dir: &str) -> Vec<(String, String)> {
    let content = root.join(content_dir);
    let mut posts = Vec::new();
    // The build's own walk: a directory symlink that leaves the content
    // folder or loops stops the build, and leaves no draft to verify here.
    for file in crate::site::content_files(&content).unwrap_or_default() {
        let path = crate::fsutil::relative(&content, &file);
        if crate::site::not_content(&path)
            || openblog_core::classify_source(&path) != Some(openblog_core::SourceKind::Post)
        {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&file) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_DRAFT_BYTES {
            continue;
        }
        let Ok(source) = fs::read_to_string(&file) else {
            continue;
        };
        posts.push((path, source));
    }
    posts
}

/// [`read_saved_posts`] for a build that has already read its content
/// ([`crate::site::read_sources`]), so the posts are not walked and read a
/// second time. The build decided which files are posts; an oversized post
/// and two posts claiming one slug are left out as there.
pub fn drafts_from_sources(sources: &openblog_core::Sources) -> (Drafts, BTreeMap<String, String>) {
    drafts_of(
        sources
            .posts
            .iter()
            .filter(|post| post.contents.len() as u64 <= MAX_DRAFT_BYTES)
            .map(|post| (post.path.as_str(), post.contents.as_str())),
    )
}

/// Each post's anchor text and path by slug, leaving out a post with no slug
/// or anchor text and every post of a slug that two posts claim.
fn drafts_of<'a>(
    posts: impl Iterator<Item = (&'a str, &'a str)>,
) -> (Drafts, BTreeMap<String, String>) {
    let mut drafts = Drafts::new();
    let mut paths = BTreeMap::new();
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for (path, source) in posts {
        let (Some(slug), Ok(text)) = (claims::post_slug(path, source), claims::anchor_text(source))
        else {
            continue;
        };
        *seen.entry(slug.clone()).or_default() += 1;
        drafts.insert(slug.clone(), text);
        paths.insert(slug, path.to_string());
    }
    for (slug, count) in seen {
        if count > 1 {
            drafts.remove(&slug);
            paths.remove(&slug);
        }
    }
    (drafts, paths)
}

/// The evidence gaps and provenance prompts of a loaded claims file
/// (`openblog_core::claim_review`, ADR 0074), against the saved posts. Read
/// only: nothing is created, locked or changed.
pub fn review(snapshot: &Snapshot, root: &Path, content_dir: &str) -> Vec<EvidenceFinding> {
    let (drafts, paths) = read_saved_posts(root, content_dir);
    review_against(snapshot, &drafts, &paths)
}

fn review_against(
    snapshot: &Snapshot,
    drafts: &Drafts,
    paths: &BTreeMap<String, String>,
) -> Vec<EvidenceFinding> {
    openblog_core::claim_review::review_claims(
        &snapshot.claims,
        &openblog_core::claim_review::ReviewContext {
            drafts,
            paths,
            claims_file: CLAIMS_FILE,
            library: &snapshot.library,
            notebook: &snapshot.notebook,
        },
    )
}

/// What a build reports about the claims file: its findings when one is
/// stored, against the posts the build read, nothing when none is (a CI or
/// static-host build never has one), and one warning, naming only the file,
/// when it cannot be read. Without a claims file nothing else is read, so a
/// broken library or notebook is not reported here. A claims problem never
/// stops a build, and nothing from the file reaches its output.
pub fn build_findings(
    root: &Path,
    contributors: &BTreeMap<String, Contributor>,
    sources: &openblog_core::Sources,
) -> Result<Vec<EvidenceFinding>, String> {
    if claims_file_absent(root) {
        return Ok(Vec::new());
    }
    match load_for_build(root, contributors) {
        Ok(snapshot) if snapshot.stored => {
            let (drafts, paths) = drafts_from_sources(sources);
            Ok(review_against(&snapshot, &drafts, &paths))
        }
        Ok(_) => Ok(Vec::new()),
        Err(_) => Err(format!(
            "the private claims file {CLAIMS_FILE} cannot be read, so its evidence gaps were not reviewed; run `openblog check` to see why"
        )),
    }
}

/// Whether a claims file is stored, readable or not.
pub fn claims_file_stored(root: &Path) -> bool {
    !claims_file_absent(root)
}

/// Whether no claims file is stored at all. A build checks this before
/// loading, because a load reads the library and notebook first and a site
/// with no claims file must never be stopped by either.
fn claims_file_absent(root: &Path) -> bool {
    claims_path(root).is_ok_and(|path| {
        matches!(fs::symlink_metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    })
}

/// What a build that publishes claim evidence (ADR 0075) reads from the
/// claims file: its projection, a warning when none is stored (a CI or
/// static-host build), or a refusal that names the file and counts its
/// problems without repeating anything from it. Without a claims file
/// nothing else is read, so a broken library or notebook never refuses the
/// build: the notebook is not an input to the projection at all.
pub fn evidence_for_build(
    root: &Path,
    contributors: &BTreeMap<String, Contributor>,
) -> openblog_core::claim_publication::ClaimEvidenceSource {
    use openblog_core::claim_publication::{ClaimEvidence, ClaimEvidenceSource};
    let unpublishable = |reason: String| {
        ClaimEvidenceSource::Unreadable(format!(
            "the claim evidence cannot be published ({reason}); run `openblog check` and repair it, or set `claimEvidence.publish` to false. Nothing was written."
        ))
    };
    if claims_file_absent(root) {
        return ClaimEvidenceSource::Unstored {
            warning: unstored_evidence_warning(),
        };
    }
    match load_for_build(root, contributors) {
        Ok(snapshot) if !snapshot.stored => ClaimEvidenceSource::Unstored {
            warning: unstored_evidence_warning(),
        },
        Ok(snapshot) => match ClaimEvidence::project(&snapshot.claims, &snapshot.library) {
            Ok(projection) => ClaimEvidenceSource::Stored(projection),
            Err(error) => unpublishable(format!("{CLAIMS_FILE}: {error}")),
        },
        Err(StoreError::Invalid(diagnostics)) => unpublishable(format!(
            "{CLAIMS_FILE} has {} problem(s)",
            diagnostics.len()
        )),
        Err(error) => unpublishable(error.to_string()),
    }
}

/// What `build` and `check` say when the site publishes claim evidence but
/// this build cannot read a claims file.
fn unstored_evidence_warning() -> String {
    format!(
        "`claimEvidence.publish` is on, but no claims file is stored at {CLAIMS_FILE}, so no claim or evidence is published; revision notes written in posts still are. The claims file is private and Git-ignored: only a build that can read it publishes claim evidence (`openblog serve` and Admin, or a local `openblog build` you then upload). A CI or static-host build from the repository cannot."
    )
}

type Edit<'a, T> = dyn Fn(&mut ClaimSet, Links<'_>) -> Result<T, Vec<AtlasDiagnostic>> + 'a;

/// Add a claim whose identifier nothing in the file uses yet. An anchor must
/// be verified against the saved draft of its post.
pub fn create_claim(
    root: &Path,
    expected_revision: &str,
    claim: Claim,
    drafts: &Drafts,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, &|set, links| {
        if let Some(diagnostic) = in_use(set, "claims", &claim.id) {
            return Err(vec![diagnostic]);
        }
        claims::check_claim_anchor(None, &claim, drafts).map_err(|d| vec![d])?;
        set.upsert_claim(claim.clone(), links)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Replace the claim with the same identifier. A new or changed anchor must
/// be verified; an unchanged one is not re-checked.
pub fn update_claim(
    root: &Path,
    expected_revision: &str,
    claim: Claim,
    drafts: &Drafts,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, &|set, links| {
        let Some(stored) = set.claim(&claim.id).cloned() else {
            return Err(vec![unknown("claims", &claim.id)]);
        };
        claims::check_claim_anchor(Some(&stored), &claim, drafts).map_err(|d| vec![d])?;
        set.upsert_claim(claim.clone(), links)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Remove a claim no link rests on.
pub fn remove_claim(
    root: &Path,
    expected_revision: &str,
    id: &str,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, &|set, links| {
        set.remove_claim(id, links)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Add an evidence link whose identifier nothing in the file uses yet,
/// refused while its claim's anchor is stale or ambiguous.
pub fn create_link(
    root: &Path,
    expected_revision: &str,
    link: EvidenceLink,
    drafts: &Drafts,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, &|set, links| {
        if let Some(diagnostic) = in_use(set, "links", &link.id) {
            return Err(vec![diagnostic]);
        }
        claims::check_link_anchor(set, None, &link, drafts).map_err(|d| vec![d])?;
        set.upsert_link(link.clone(), links)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Replace the link with the same identifier. Withdrawing its approval is
/// always allowed; any other change is refused while the claim's anchor is
/// stale or ambiguous.
pub fn update_link(
    root: &Path,
    expected_revision: &str,
    link: EvidenceLink,
    drafts: &Drafts,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, &|set, links| {
        let Some(stored) = set.link(&link.id).cloned() else {
            return Err(vec![unknown("links", &link.id)]);
        };
        claims::check_link_anchor(set, Some(&stored), &link, drafts).map_err(|d| vec![d])?;
        set.upsert_link(link.clone(), links)
    })
    .map(|(snapshot, ())| snapshot)
}

/// Remove a link. Always allowed: removing evidence never edits a claim.
pub fn remove_link(
    root: &Path,
    expected_revision: &str,
    id: &str,
    contributors: &BTreeMap<String, Contributor>,
) -> Result<Snapshot, StoreError> {
    change(root, expected_revision, contributors, &|set, links| {
        set.remove_link(id, links)
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
        subject: DiagnosticSubject::Claims,
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
        if collection == "links" {
            AtlasDiagnosticCode::UnknownLink
        } else {
            AtlasDiagnosticCode::UnknownClaim
        },
        collection,
        id,
        None,
        format!("nothing in {collection} has the id `{id}`"),
    )
}

/// Creating refuses an identifier any claim or link already uses, scoped to
/// the collection being created in.
fn in_use(set: &ClaimSet, collection: &'static str, id: &str) -> Option<AtlasDiagnostic> {
    (set.claim(id).is_some() || set.link(id).is_some()).then(|| {
        diagnostic(
            AtlasDiagnosticCode::DuplicateId,
            collection,
            id,
            Some("id"),
            format!("`{id}` is already used in the claims file; edit it or choose another id"),
        )
    })
}

/// Apply one edit while holding the claims, notebook and library locks, in
/// that order. The edit sees all three as stored, and nothing is written
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
    let path = claims_path(root)?;
    let directory = path
        .parent()
        .ok_or_else(|| StoreError::Storage("the claims file has no directory".into()))?;
    if !directory.is_dir() {
        let current = load(root, contributors)?;
        let mut set = checked(&current, expected_revision)?;
        edit(&mut set, links(&current)).map_err(StoreError::Invalid)?;
        source_store::create_private_directory(directory).map_err(storage)?;
    }
    // Check again now that every directory exists.
    let path = claims_path(root)?;
    let _lock = FileLock::acquire(lock_path(&path), "claims file write", LOCK_WAIT)
        .map_err(StoreError::Storage)?;
    // The claims file reads both stores, so it holds both of their locks too,
    // after its own: a passage or source removal that checks it cannot
    // interleave with this write, and nothing waits in the other order.
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
            claims: set,
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

fn checked(current: &Snapshot, expected_revision: &str) -> Result<ClaimSet, StoreError> {
    if current.revision != expected_revision {
        return Err(StoreError::Conflict);
    }
    Ok(current.claims.clone())
}

fn read(root: &Path, library: SourceLibrary, notebook: Notebook) -> Result<Snapshot, StoreError> {
    let path = claims_path(root)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let claims = ClaimSet::default();
            return Ok(Snapshot {
                revision: source_store::revision(claims.to_json().as_bytes()),
                claims,
                stored: false,
                library,
                notebook,
            });
        }
        Err(error) => {
            return Err(StoreError::Storage(format!(
                "cannot inspect {CLAIMS_FILE}: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(StoreError::Storage(format!(
            "{CLAIMS_FILE} is a symlink; replace it with a regular file"
        )));
    }
    if !metadata.is_file() {
        return Err(StoreError::Storage(format!(
            "{CLAIMS_FILE} is not a regular file"
        )));
    }
    if metadata.len() > MAX_CLAIMS_BYTES as u64 {
        return Err(StoreError::Invalid(vec![too_large()]));
    }
    let bytes = crate::fsutil::retry_transient(|| {
        let mut bytes = Vec::new();
        fs::File::open(&path)?
            .take(MAX_CLAIMS_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    })
    .map_err(|error| StoreError::Storage(format!("cannot read {CLAIMS_FILE}: {error}")))?;
    if bytes.len() > MAX_CLAIMS_BYTES {
        return Err(StoreError::Invalid(vec![too_large()]));
    }
    let revision = source_store::revision(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| {
        StoreError::Invalid(vec![AtlasDiagnostic {
            subject: DiagnosticSubject::Claims,
            code: AtlasDiagnosticCode::InvalidJson,
            collection: None,
            index: None,
            id: None,
            field: None,
            message: "the claims file is not valid UTF-8".into(),
            facts: Vec::new(),
        }])
    })?;
    let claims = ClaimSet::parse(
        &text,
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .map_err(StoreError::Invalid)?;
    Ok(Snapshot {
        claims,
        revision,
        stored: true,
        library,
        notebook,
    })
}

fn too_large() -> AtlasDiagnostic {
    AtlasDiagnostic {
        subject: DiagnosticSubject::Claims,
        code: AtlasDiagnosticCode::TooLarge,
        collection: None,
        index: None,
        id: None,
        field: None,
        message: format!("the claims file is larger than {MAX_CLAIMS_BYTES} bytes"),
        facts: Vec::new(),
    }
}

fn claims_path(root: &Path) -> Result<PathBuf, StoreError> {
    source_store::contained(root, Path::new(CLAIMS_FILE))
        .map_err(|error| StoreError::Storage(error.to_string()))
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
        let _ = crate::fsutil::retry_transient(|| fs::remove_file(&temporary));
        return Err(StoreError::Storage(format!(
            "could not save the claims file ({error}); the stored file is unchanged"
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
    use openblog_core::claims::Relation;
    use openblog_core::knowledge_atlas::Visibility;
    use openblog_core::research_notes::{NoteDiagnosticCode, Passage};
    use serde_json::json;

    fn temp_root(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "openblog-claims-{tag}-{}-{unique}",
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
        root.join(CLAIMS_FILE)
    }

    const DRAFT: &str = "The cave is an allegory. Πλάτων wrote it.";

    fn drafts(text: &str) -> Drafts {
        Drafts::from([("on-caves".to_string(), text.to_string())])
    }

    fn claim(id: &str, start: usize, text: &str) -> Claim {
        Claim::from_json(json!({"id": id, "post": "on-caves", "statement": "S",
            "anchor": {"start": start, "end": start + text.len(), "text": text}}))
        .unwrap()
    }

    fn link(id: &str, claim: &str, relation: &str, evidence: serde_json::Value) -> EvidenceLink {
        EvidenceLink::from_json(
            json!({"id": id, "claim": claim, "relation": relation, "evidence": evidence}),
        )
        .unwrap()
    }

    /// One anchored claim with one supporting link citing `ref` page 514.
    fn seeded(root: &Path) -> Snapshot {
        with_library(root);
        let empty = load(root, &none()).unwrap();
        let one = create_claim(
            root,
            &empty.revision,
            claim("c1", 4, "cave"),
            &drafts(DRAFT),
            &none(),
        )
        .unwrap();
        create_link(
            root,
            &one.revision,
            link(
                "l1",
                "c1",
                "supports",
                json!({"source": "ref", "locators": [{"kind": "page", "value": "514"}]}),
            ),
            &drafts(DRAFT),
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
    fn an_absent_file_loads_empty_without_creating_anything() {
        let root = temp_root("absent");
        let snapshot = load(&root, &none()).unwrap();
        assert!(!snapshot.stored && snapshot.claims == ClaimSet::default());
        assert!(!root.join(".openblog").exists());
        // A refused first change (a stale range) creates nothing either.
        let refused = create_claim(
            &root,
            &snapshot.revision,
            claim("c1", 0, "absent"),
            &drafts(DRAFT),
            &none(),
        )
        .unwrap_err();
        assert_eq!(codes(refused), [AtlasDiagnosticCode::StaleAnchor]);
        assert!(!root.join(".openblog").exists());
        create_claim(
            &root,
            &snapshot.revision,
            claim("c1", 4, "cave"),
            &drafts(DRAFT),
            &none(),
        )
        .unwrap();
        assert!(file(&root).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changes_are_revision_checked_deterministic_and_lossless() {
        let root = temp_root("changes");
        let seeded = seeded(&root);
        let bytes = fs::read(file(&root)).unwrap();
        assert_eq!(bytes, seeded.claims.to_json().as_bytes());
        assert_eq!(load(&root, &none()).unwrap(), seeded);
        let stale = create_claim(
            &root,
            "stale",
            claim("c2", 0, "The"),
            &drafts(DRAFT),
            &none(),
        );
        assert_eq!(stale.unwrap_err(), StoreError::Conflict);
        assert_eq!(fs::read(file(&root)).unwrap(), bytes);

        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["future"] = json!({"b": 1});
        value["claims"][0]["x-note"] = json!("kept");
        value["links"][0]["evidence"]["margin"] = json!("kept too");
        fs::write(file(&root), value.to_string()).unwrap();
        let outside = load(&root, &none()).unwrap();
        let after = create_claim(
            &root,
            &outside.revision,
            claim("c2", 0, "The"),
            &drafts(DRAFT),
            &none(),
        )
        .unwrap();
        let text = fs::read_to_string(file(&root)).unwrap();
        for needle in ["\"future\"", "\"x-note\"", "\"margin\": \"kept too\""] {
            assert!(text.contains(needle), "{needle}");
        }
        assert_eq!(text, after.claims.to_json());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_ambiguous_or_moved_ranges_fail_and_change_nothing() {
        let root = temp_root("anchors");
        let seeded = seeded(&root);
        let bytes = fs::read(file(&root)).unwrap();
        // UTF-8 byte offsets: the Greek name is 12 bytes, not 6 characters.
        let start = DRAFT.find("Πλάτων").unwrap();
        let verified = create_claim(
            &root,
            &seeded.revision,
            claim("c2", start, "Πλάτων"),
            &drafts(DRAFT),
            &none(),
        )
        .unwrap();
        let after = fs::read(file(&root)).unwrap();
        for (candidate, code) in [
            (claim("c3", 0, "missing"), AtlasDiagnosticCode::StaleAnchor),
            (claim("c3", 2, "he"), AtlasDiagnosticCode::AnchorMismatch),
            (claim("c3", 0, "e "), AtlasDiagnosticCode::AmbiguousAnchor),
        ] {
            let refused = create_claim(
                &root,
                &verified.revision,
                candidate,
                &drafts(DRAFT),
                &none(),
            );
            assert_eq!(codes(refused.unwrap_err()), [code]);
            assert_eq!(fs::read(file(&root)).unwrap(), after, "nothing written");
        }
        assert_ne!(after, bytes);

        // Once the draft moves on, the claim is stale: evidence cannot be
        // linked or changed, but its approval can be withdrawn and the claim
        // edited or removed.
        let edited = drafts("A rewritten draft.");
        let opposing = link("l2", "c1", "contradicts", json!({"source": "scholar"}));
        let refused = create_link(
            &root,
            &verified.revision,
            opposing.clone(),
            &edited,
            &none(),
        );
        assert_eq!(
            codes(refused.unwrap_err()),
            [AtlasDiagnosticCode::StaleAnchor]
        );
        assert_eq!(fs::read(file(&root)).unwrap(), after);
        let mut statement = verified.claims.claim("c1").unwrap().clone();
        statement.statement = "Reworded while stale.".into();
        let current = update_claim(&root, &verified.revision, statement, &edited, &none())
            .expect("an unchanged anchor is not re-checked");
        // Opposing links coexist once the draft holds the words again.
        let current =
            create_link(&root, &current.revision, opposing, &drafts(DRAFT), &none()).unwrap();
        let both = create_link(
            &root,
            &current.revision,
            link("l3", "c1", "contradicts", json!({"source": "plato"})),
            &drafts(DRAFT),
            &none(),
        )
        .unwrap();
        let relations: Vec<Relation> = both.claims.links_of("c1").map(|l| l.relation).collect();
        assert_eq!(
            relations,
            [
                Relation::Supports,
                Relation::Contradicts,
                Relation::Contradicts
            ]
        );
        let mut approved = both.claims.link("l2").unwrap().clone();
        approved.visibility = Visibility::Approved;
        let approved =
            update_link(&root, &both.revision, approved, &drafts(DRAFT), &none()).unwrap();
        let mut withdrawn = approved.claims.link("l2").unwrap().clone();
        withdrawn.visibility = Visibility::Private;
        let withdrawn = update_link(&root, &approved.revision, withdrawn, &edited, &none())
            .expect("withdrawing approval is never refused");
        let removed = remove_link(&root, &withdrawn.revision, "l2", &none()).unwrap();
        assert_eq!(removed.claims.counts("c1").contradicts, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn identifiers_are_unique_and_removal_never_orphans() {
        let root = temp_root("identity");
        let seeded = seeded(&root);
        let d = drafts(DRAFT);
        for clash in [
            create_claim(&root, &seeded.revision, claim("l1", 0, "The"), &d, &none()),
            create_claim(&root, &seeded.revision, claim("c1", 0, "The"), &d, &none()),
        ] {
            assert_eq!(
                codes(clash.unwrap_err()),
                [AtlasDiagnosticCode::DuplicateId]
            );
        }
        let ghost = update_claim(
            &root,
            &seeded.revision,
            claim("ghost", 0, "The"),
            &d,
            &none(),
        );
        assert_eq!(
            codes(ghost.unwrap_err()),
            [AtlasDiagnosticCode::UnknownClaim]
        );
        let ghost = remove_link(&root, &seeded.revision, "ghost", &none());
        assert_eq!(
            codes(ghost.unwrap_err()),
            [AtlasDiagnosticCode::UnknownLink]
        );
        let linked = remove_claim(&root, &seeded.revision, "c1", &none());
        assert_eq!(
            codes(linked.unwrap_err()),
            [AtlasDiagnosticCode::StillLinked]
        );
        let gone = remove_link(&root, &seeded.revision, "l1", &none()).unwrap();
        remove_claim(&root, &gone.revision, "c1", &none()).unwrap();
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
            &|set, links| set.remove_link("l1", links),
            |_, _| Err(std::io::Error::other("disk full")),
        );
        assert!(matches!(failed.unwrap_err(), StoreError::Storage(m) if m.contains("unchanged")));
        assert_eq!(fs::read(file(&root)).unwrap(), before);
        assert_eq!(tmp_files(&root), 0);
        assert!(!root
            .join(".openblog/private/research/claims.json.lock")
            .exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn damaged_files_are_reported_never_replaced_and_name_the_claims_file() {
        let root = temp_root("damaged");
        with_library(&root);
        let path = file(&root);
        for bytes in [
            b"{\"version\":1,\"claims\":[{\"id\":".to_vec(),
            b"{\"version\":2,\"claims\":[]}".to_vec(),
            vec![b' '; MAX_CLAIMS_BYTES + 1],
            vec![0xff, 0xfe],
        ] {
            fs::write(&path, &bytes).unwrap();
            let error = load(&root, &none()).unwrap_err();
            assert!(matches!(error, StoreError::Invalid(_)));
            let text = error.to_string();
            assert!(
                text.starts_with(CLAIMS_FILE) && !text.contains("atlas"),
                "{text}"
            );
            let revision = source_store::revision(&bytes);
            let attempt = create_claim(
                &root,
                &revision,
                claim("c1", 4, "cave"),
                &drafts(DRAFT),
                &none(),
            );
            assert!(attempt.is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes, "never replaced");
        }
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(matches!(load(&root, &none()), Err(StoreError::Storage(_))));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sources_and_passages_that_links_use_cannot_be_removed() {
        let root = temp_root("guards");
        let seeded = seeded(&root);
        let book = notebook_store::load(&root, &none()).unwrap();
        let passage = Passage::from_json(
            json!({"id": "p1", "source": "slings", "excerpt": {"text": "quoted words"}}),
        )
        .unwrap();
        let book = notebook_store::create_passage(&root, &book.revision, passage, &none()).unwrap();
        let current = create_link(
            &root,
            &seeded.revision,
            link(
                "l2",
                "c1",
                "contradicts",
                json!({"source": "slings", "passage": "p1"}),
            ),
            &drafts(DRAFT),
            &none(),
        )
        .unwrap();
        let library = source_store::load(&root, &none()).unwrap();
        let library_bytes = fs::read(root.join(source_store::LIBRARY_FILE)).unwrap();
        let refused = source_store::remove(&root, &library.revision, "ref", &none());
        let Err(source_store::StoreError::Invalid(found)) = refused else {
            panic!("a source a link rests on must not be removed")
        };
        assert!(
            found[0].message.contains("l1") && found[0].message.contains("claims file"),
            "{found:?}"
        );
        assert_eq!(
            fs::read(root.join(source_store::LIBRARY_FILE)).unwrap(),
            library_bytes
        );
        assert!(source_store::remove(&root, &library.revision, "spare", &none()).is_ok());

        let notebook_bytes = fs::read(root.join(notebook_store::NOTEBOOK_FILE)).unwrap();
        let refused = notebook_store::remove_passage(&root, &book.revision, "p1", &none());
        let Err(notebook_store::StoreError::Invalid(found)) = refused else {
            panic!("the passage removal must be refused")
        };
        assert_eq!(found[0].code, NoteDiagnosticCode::StillLinked);
        assert!(found[0].message.contains("l2") && found[0].message.contains("claims file"));
        assert!(!found[0].message.contains("quoted words"));
        assert_eq!(
            fs::read(root.join(notebook_store::NOTEBOOK_FILE)).unwrap(),
            notebook_bytes
        );

        // An unreadable claims file blocks removals, not other edits.
        let claims_bytes = fs::read(file(&root)).unwrap();
        fs::write(file(&root), b"{").unwrap();
        assert!(notebook_store::remove_passage(&root, &book.revision, "p1", &none()).is_err());
        let library = source_store::load(&root, &none()).unwrap();
        assert!(source_store::remove(&root, &library.revision, "scholar", &none()).is_err());
        fs::write(file(&root), &claims_bytes).unwrap();

        // Re-pointing `ref` would make the evidence's page 514 ambiguous.
        let mut moved = library.library.get("ref").unwrap().clone();
        moved.of = Some("plato".into());
        let refused = source_store::update(&root, &library.revision, moved, &none());
        let Err(source_store::StoreError::Invalid(found)) = refused else {
            panic!("the library change must be refused")
        };
        assert!(
            found[0].message.contains("claims file"),
            "{}",
            found[0].message
        );

        // Once the link moves off the passage, the passage can go.
        let mut off = current.claims.link("l2").unwrap().clone();
        off.evidence.passage = None;
        update_link(&root, &current.revision, off, &drafts(DRAFT), &none()).unwrap();
        assert!(notebook_store::remove_passage(&root, &book.revision, "p1", &none()).is_ok());
        assert!(load(&root, &none()).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn drafts_are_read_by_slug_from_saved_posts_only() {
        let root = temp_root("drafts");
        let posts = root.join("content/posts");
        fs::create_dir_all(posts.join("deep")).unwrap();
        fs::write(
            posts.join("2026-01-07-on-caves.md"),
            "\u{feff}---\r\ntitle: Caves\r\n---\r\nThe cave\r\nis dark.\r\n",
        )
        .unwrap();
        fs::write(
            posts.join("deep/other.md"),
            "---\nslug: Named Here\n---\nBody",
        )
        .unwrap();
        fs::write(posts.join("twin-a.md"), "---\nslug: twin\n---\nA").unwrap();
        fs::write(posts.join("twin-b.md"), "---\nslug: twin\n---\nB").unwrap();
        fs::write(posts.join("broken.md"), "---\ntitle: open").unwrap();
        fs::write(posts.join("notes.txt"), "not a post").unwrap();
        let drafts = read_saved_posts(&root, "content").0;
        assert_eq!(
            drafts.get("on-caves").map(String::as_str),
            Some("The cave\nis dark.")
        );
        assert_eq!(drafts.get("named-here").map(String::as_str), Some("Body"));
        assert!(
            !drafts.contains_key("twin"),
            "a slug two posts claim is never trusted"
        );
        assert_eq!(drafts.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn drafts_skip_what_the_build_skips_so_a_drafts_copy_never_shadows_a_post() {
        let root = temp_root("drafts-excluded");
        let posts = root.join("content/posts");
        fs::create_dir_all(posts.join("_drafts")).unwrap();
        fs::create_dir_all(root.join("content/pages")).unwrap();
        let post = "---\ntitle: Caves\n---\nThe cave is dark.\n";
        fs::write(posts.join("2026-01-07-on-caves.md"), post).unwrap();
        // A working copy under a `_` folder, a `_`-prefixed file and a README
        // are not content: none of them may duplicate the real slug.
        fs::write(posts.join("_drafts/2026-01-07-on-caves.md"), "Older words.").unwrap();
        fs::write(posts.join("_on-caves.md"), "---\nslug: on-caves\n---\nOld").unwrap();
        fs::write(posts.join("README.md"), "---\nslug: on-caves\n---\nHow to").unwrap();
        // Pages are not posts; a loose Markdown file at the content root is,
        // as the build reads it.
        fs::write(
            root.join("content/pages/about.md"),
            "---\nslug: on-caves\n---\nAbout",
        )
        .unwrap();
        fs::write(
            root.join("content/loose.md"),
            "---\ntitle: Loose\n---\nLoose words.",
        )
        .unwrap();
        let drafts = read_saved_posts(&root, "content").0;
        assert_eq!(
            drafts.get("on-caves").map(String::as_str),
            Some("The cave is dark.")
        );
        assert_eq!(
            drafts.get("loose").map(String::as_str),
            Some("Loose words.")
        );
        assert_eq!(drafts.len(), 2, "{drafts:?}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_claims_atlas_notebook_and_library_writers_never_deadlock() {
        let root = temp_root("concurrent");
        seeded(&root);
        let started = std::time::Instant::now();
        let mut workers = Vec::new();
        for worker in 0..2 {
            let root = root.clone();
            workers.push(std::thread::spawn(move || {
                for n in 0..4 {
                    let relation = if n % 2 == 0 {
                        "supports"
                    } else {
                        "contradicts"
                    };
                    let evidence = json!({"source": "slings",
                        "locators": [{"kind": "page", "value": format!("{worker}{n}")}]});
                    loop {
                        let current = load(&root, &none()).unwrap();
                        let candidate =
                            link(&format!("w{worker}-{n}"), "c1", relation, evidence.clone());
                        match create_link(
                            &root,
                            &current.revision,
                            candidate,
                            &drafts(DRAFT),
                            &none(),
                        ) {
                            Ok(_) => break,
                            Err(StoreError::Conflict) => continue,
                            Err(other) => panic!("claims writer: {other}"),
                        }
                    }
                }
            }));
        }
        let atlas_root = root.clone();
        let atlas_writer = std::thread::spawn(move || {
            for n in 0..4 {
                loop {
                    let current = crate::atlas_store::load(&atlas_root, &none()).unwrap();
                    let entry = openblog_core::knowledge_atlas::Entry::from_json(
                        json!({"id": format!("e{n}"), "kind": "concept", "label": "C"}),
                    )
                    .unwrap();
                    match crate::atlas_store::create_entry(
                        &atlas_root,
                        &current.revision,
                        entry,
                        &none(),
                    ) {
                        Ok(_) => break,
                        Err(crate::atlas_store::StoreError::Conflict) => continue,
                        Err(other) => panic!("atlas writer: {other}"),
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
                // Refused while a link rests on it, whatever else is writing.
                assert!(
                    source_store::remove(&library_root, &current.revision, "ref", &none()).is_err()
                );
            }
        });
        for worker in workers {
            worker.join().unwrap();
        }
        atlas_writer.join().unwrap();
        notebook_writer.join().unwrap();
        library_writer.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(60));
        let claims = load(&root, &none()).unwrap();
        assert_eq!(claims.claims.links.len(), 1 + 8);
        assert_eq!(tmp_files(&root), 0);
        let locks = fs::read_dir(file(&root).parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".lock"))
            .count();
        assert_eq!(locks, 0, "every lock was released");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_build_without_a_claims_file_reads_and_reports_nothing_else() {
        let root = temp_root("build-absent");
        // A broken library and no claims file: a build says nothing about claims.
        let library = root.join(source_store::LIBRARY_FILE);
        fs::create_dir_all(library.parent().unwrap()).unwrap();
        fs::write(&library, "{ not json").unwrap();
        let sources = openblog_core::Sources::default();
        assert_eq!(build_findings(&root, &none(), &sources), Ok(Vec::new()));
        // With a claims file the library is read, and its problem is one warning.
        fs::write(file(&root), r#"{"version":1,"claims":[]}"#).unwrap();
        let warning = build_findings(&root, &none(), &sources).unwrap_err();
        assert!(warning.contains(CLAIMS_FILE));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_publishing_build_without_a_claims_file_is_not_refused_by_a_broken_library_or_notebook() {
        use openblog_core::claim_publication::ClaimEvidenceSource;
        let root = temp_root("publish-absent");
        let unstored = |root: &Path| {
            matches!(
                evidence_for_build(root, &none()),
                ClaimEvidenceSource::Unstored { .. }
            )
        };
        let notebook = root.join(notebook_store::NOTEBOOK_FILE);
        fs::create_dir_all(notebook.parent().unwrap()).unwrap();
        fs::write(&notebook, "{ not json").unwrap();
        assert!(unstored(&root), "a broken notebook alone");
        let library = root.join(source_store::LIBRARY_FILE);
        fs::write(&library, "{ not json").unwrap();
        assert!(unstored(&root), "a broken library too");
        // With a claims file the library is read, and its problem refuses.
        fs::write(file(&root), r#"{"version":1,"claims":[]}"#).unwrap();
        assert!(matches!(
            evidence_for_build(&root, &none()),
            ClaimEvidenceSource::Unreadable(_)
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_build_reads_drafts_from_the_posts_it_loaded() {
        let post = |path: &str, contents: &str| openblog_core::SourceFile {
            path: path.into(),
            contents: contents.into(),
        };
        let sources = openblog_core::Sources {
            posts: vec![
                post(
                    "posts/2026-01-07-on-caves.md",
                    "---\ntitle: Caves\n---\n\nThe cave.\n",
                ),
                post(
                    "posts/2026-01-08-twin.md",
                    "---\ntitle: A\nslug: twin\n---\nA\n",
                ),
                post(
                    "posts/2026-01-09-twin.md",
                    "---\ntitle: B\nslug: twin\n---\nB\n",
                ),
            ],
            ..Default::default()
        };
        let (drafts, paths) = drafts_from_sources(&sources);
        assert_eq!(
            drafts,
            Drafts::from([("on-caves".to_string(), "The cave.".to_string())])
        );
        assert_eq!(paths["on-caves"], "posts/2026-01-07-on-caves.md");
        assert!(
            !paths.contains_key("twin"),
            "a slug two posts claim has no draft"
        );
    }
}
