//! The research review before a post is published or scheduled (#62,
//! ADR 0123), and the private file of the author's acknowledgements
//! (ADR 0124).
//!
//! [`gather`] reads what the existing checks say about one post and maps it
//! into the contract's finding shape through `openblog_core::publication_review`.
//! A finding blocks publication only when the build that publishes the post
//! would refuse it: a citation it cannot publish, or a private file it reads
//! that cannot be read. Each private file is read once and on its own, so a
//! file that cannot be read is reported against that file, and anything that
//! depends on it is reported as not reviewed instead of blaming its own file.
//!
//! Acknowledgements live at [`ACKNOWLEDGEMENTS_FILE`], inside the Git-ignored
//! private directory beside the other research files, so no build, feed or
//! export reads them. Every change names the revision it was based on and
//! replaces the file by atomic rename under a lock: a refused, failed or
//! interrupted change leaves the stored file exactly as it was.

use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use openblog_core::atlas_publication::PublicAtlas;
use openblog_core::chronology_index::ChronologyIndex;
use openblog_core::comparison_publication::{ComparisonInputs, PublicComparisons};
use openblog_core::config::SiteConfig;
use openblog_core::context_links::{self, ContextGap, ContextKind};
use openblog_core::knowledge_atlas::{Atlas, Links, Visibility};
use openblog_core::publication_review::{AcknowledgementSet, ObjectKind, ReviewFinding};
use openblog_core::research::EvidenceFinding;
use openblog_core::source_review::SourceReviewFinding;

use crate::transaction::FileLock;
use crate::{alignment_store, atlas_store, claims_store, notebook_store, source_store};

/// The acknowledgements a report applies, and what to tell the reader about
/// the file: its revision for the next change to name, or why it cannot be
/// read. An unreadable file is never repaired and never partly applied.
pub fn acknowledgements(
    root: &Path,
) -> (
    Vec<openblog_core::publication_review::Acknowledgement>,
    crate::readiness::Acknowledgements,
) {
    match load(root) {
        Ok(snapshot) => (
            snapshot.set.acknowledgements,
            crate::readiness::Acknowledgements {
                revision: Some(snapshot.revision),
                error: None,
            },
        ),
        Err(error) => (
            Vec::new(),
            crate::readiness::Acknowledgements {
                revision: None,
                error: Some(error.to_string()),
            },
        ),
    }
}

/// A review as Admin and the command line receive it: the contract's
/// findings, groups and counts, whether the review applies, what could not be
/// reviewed, and the acknowledgements file's revision. There is no score,
/// total, pass, ready or resolved field.
pub fn view(
    review: &openblog_core::publication_review::PublicationReview,
    applies: bool,
    not_reviewed: &[NotReviewed],
    acknowledgements: &crate::readiness::Acknowledgements,
) -> serde_json::Value {
    let mut view = serde_json::to_value(review).unwrap_or_else(|_| serde_json::json!({}));
    view["applies"] = serde_json::json!(applies);
    view["notReviewed"] = serde_json::json!(not_reviewed);
    view["acknowledgements"] = serde_json::json!({
        "file": ACKNOWLEDGEMENTS_FILE,
        "revision": acknowledgements.revision,
        "error": acknowledgements.error,
    });
    view
}

/// Where the acknowledgements live, relative to the project root.
pub const ACKNOWLEDGEMENTS_FILE: &str = ".openblog/private/research/acknowledgements.json";
/// The largest acknowledgements file read or written.
pub const MAX_ACKNOWLEDGEMENTS_BYTES: usize = 2 * 1024 * 1024;
const LOCK_WAIT: Duration = Duration::from_secs(2);

/// The post under review, as the editor holds it.
pub struct DraftPost<'a> {
    /// The post's path relative to the content folder.
    pub path: &'a str,
    /// The slug claims name the post by.
    pub slug: &'a str,
    /// The body as it would be saved, and the line of the post's file it starts on.
    pub markdown: &'a str,
    pub body_line: usize,
    /// The research-profile and citation findings for this post, from the draft's site load.
    pub evidence: Vec<EvidenceFinding>,
    /// The source-review findings for this post (ADR 0148), from the same load.
    pub source_review: Vec<SourceReviewFinding>,
}

/// A part of the review that could not run, and why. It is never a finding
/// and never blocks anything; the author sees that it was not reviewed.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct NotReviewed {
    pub part: &'static str,
    pub message: String,
}

/// Everything gathered for one post.
#[derive(Debug, Default)]
pub struct Gathered {
    pub findings: Vec<ReviewFinding>,
    pub not_reviewed: Vec<NotReviewed>,
}

impl Gathered {
    fn skip(&mut self, part: &'static str, message: String) {
        self.not_reviewed.push(NotReviewed { part, message });
    }
}

/// What the build that publishes the post would read, when it reads it.
pub(crate) struct Published {
    pub(crate) atlas: Option<Atlas>,
    pub(crate) comparisons: Option<PublicComparisons>,
    pub(crate) alignments: Option<alignment_store::Snapshot>,
    /// Whether the library and notebook the other files are checked against
    /// were read, or are not needed (the build reads no research).
    pub(crate) ready: bool,
    pub(crate) claims_stored: bool,
    /// The build reads the claims file and cannot; its finding is already in
    /// the report, scoped to the file.
    pub(crate) claims_unreadable: bool,
}

/// Gather the review of one post. Reads only; nothing is written.
pub fn gather(root: &Path, config: &SiteConfig, post: &DraftPost<'_>) -> Gathered {
    let mut gathered = Gathered::default();
    gathered
        .findings
        .extend(post.evidence.iter().map(ReviewFinding::from_evidence));
    gathered.findings.extend(
        post.source_review
            .iter()
            .map(ReviewFinding::from_source_review),
    );
    let published = read_published(root, config, &mut gathered, false);
    if published.ready && published.claims_stored {
        claims(root, config, post, &published, &mut gathered);
    }
    context(post, config, &published, &mut gathered);
    gathered
}

/// Read each private file the build that publishes reads, once and on its
/// own, through the build's own loaders: what stops the build from reading a
/// file is a finding scoped to that file, and what depends on it is listed as
/// not reviewed. Shared by the review of one post and of the whole site, so
/// both see the same files in the same way.
pub(crate) fn read_published(
    root: &Path,
    config: &SiteConfig,
    gathered: &mut Gathered,
    site_wide: bool,
) -> Published {
    // The wording follows what is reviewed: one post, or the whole site.
    let claims_of = if site_wide {
        "The claims"
    } else {
        "This post's claims"
    };
    let and_claims = if site_wide {
        "the claims"
    } else {
        "this post's claims"
    };
    let contributors = &config.contributors;
    let claims_stored = claims_store::claims_file_stored(root);
    let reads_research = config.knowledge_atlas.publish
        || config.comparisons.publish
        || (config.claim_evidence.publish && claims_stored);

    // The library and the notebook come first: every other file is checked
    // against them, so their failure is reported once, here.
    let mut ready = !(reads_research || claims_stored);
    if reads_research || claims_stored {
        match source_store::load_for_build(root, contributors) {
            Ok(snapshot) => match notebook_store::read(root, snapshot.library) {
                Ok(_) => ready = true,
                Err(error) => {
                    if reads_research {
                        gathered.findings.extend(notebook_findings(error));
                    } else {
                        gathered.skip(
                            "claims",
                            format!("{claims_of} were not reviewed because the research notebook cannot be read. Repair {}.", notebook_store::NOTEBOOK_FILE),
                        );
                    }
                }
            },
            Err(error) => {
                if reads_research {
                    gathered.findings.extend(library_findings(error));
                } else {
                    gathered.skip(
                        "claims",
                        format!("{claims_of} were not reviewed because the source library cannot be read. Repair {}.", source_store::LIBRARY_FILE),
                    );
                }
            }
        }
    }
    if !ready && reads_research {
        // The library's or the notebook's own finding is the reason; nothing
        // that depends on them is blamed for it.
        gathered.skip(
            "published-research",
            format!("The atlas, comparisons and claim evidence the build publishes, and {and_claims}, were not reviewed while the source library or the notebook cannot be read."),
        );
    }

    let mut published = Published {
        atlas: None,
        comparisons: None,
        alignments: None,
        ready,
        claims_stored,
        claims_unreadable: false,
    };
    if ready && config.knowledge_atlas.publish {
        match atlas_store::load_for_build(root, contributors) {
            Ok(snapshot) => match PublicAtlas::project(&snapshot.atlas, &snapshot.library) {
                Ok(_) => published.atlas = Some(snapshot.atlas),
                Err(error) => gathered.findings.push(ReviewFinding::unreadable(
                    ObjectKind::Atlas,
                    format!("The Knowledge Atlas cannot be published: {error}"),
                )),
            },
            Err(atlas_store::StoreError::Invalid(diagnostics)) => gathered
                .findings
                .extend(diagnostics.iter().map(ReviewFinding::from_atlas_diagnostic)),
            Err(error) => gathered.findings.push(ReviewFinding::unreadable(
                ObjectKind::Atlas,
                first_line(&error.to_string()),
            )),
        }
    }
    if ready && config.comparisons.publish {
        match alignment_store::load_for_build(root, contributors) {
            Ok(snapshot) => match PublicComparisons::project(
                &snapshot.alignments,
                ComparisonInputs {
                    library: &snapshot.library,
                    notebook: &snapshot.notebook,
                    contributors,
                },
            ) {
                Ok(projection) => {
                    published.comparisons = Some(projection);
                    published.alignments = Some(snapshot);
                }
                Err(error) => gathered.findings.push(ReviewFinding::unreadable(
                    ObjectKind::AlignmentsFile,
                    format!("The comparisons cannot be published: {error}"),
                )),
            },
            Err(message) => match alignment_store::load(root, contributors) {
                Err(alignment_store::StoreError::Invalid(diagnostics)) => gathered
                    .findings
                    .extend(diagnostics.iter().map(ReviewFinding::from_atlas_diagnostic)),
                _ => gathered.findings.push(ReviewFinding::unreadable(
                    ObjectKind::AlignmentsFile,
                    first_line(&message),
                )),
            },
        }
    }

    if ready && config.claim_evidence.publish && claims_stored {
        use openblog_core::claim_publication::ClaimEvidenceSource;
        if let ClaimEvidenceSource::Unreadable(message) =
            claims_store::evidence_for_build(root, contributors)
        {
            published.claims_unreadable = true;
            match claims_store::load(root, contributors) {
                Err(claims_store::StoreError::Invalid(diagnostics)) => gathered
                    .findings
                    .extend(diagnostics.iter().map(ReviewFinding::from_atlas_diagnostic)),
                _ => gathered
                    .findings
                    .push(ReviewFinding::unreadable(ObjectKind::ClaimsFile, message)),
            }
        }
    }

    // The curated selections, only while the site publishes them. A file the
    // build cannot read refuses it, so that is a finding scoped to the file;
    // what each selection resolves to is the boundary manifest's to say.
    if config.curated_context.publish {
        if let Err(message) = crate::selection_store::check(root) {
            gathered.findings.push(ReviewFinding::unreadable(
                ObjectKind::SelectionsFile,
                message,
            ));
        }
    }

    published.ready = ready;
    published.claims_stored = claims_stored;
    published
}

/// This post's claim findings, against the saved drafts as Evidence Studio
/// and `openblog check` review them, and, while the site publishes claim
/// evidence, the claims file's projection notices about this post's claims
/// and whatever stops the build from reading the file.
fn claims(
    root: &Path,
    config: &SiteConfig,
    post: &DraftPost<'_>,
    published: &Published,
    gathered: &mut Gathered,
) {
    let contributors = &config.contributors;
    if published.claims_unreadable {
        // The report already says why, scoped to the file.
        return;
    }
    let snapshot = match claims_store::load(root, contributors) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            gathered.skip(
                "claims",
                format!(
                    "This post's claims were not reviewed because the claims file cannot be read ({}). Repair {}.",
                    first_line(&error.to_string()),
                    claims_store::CLAIMS_FILE
                ),
            );
            return;
        }
    };
    let (drafts, paths) = claims_store::read_saved_posts(root, &config.paths.content);
    let set = &snapshot.claims;
    let findings = openblog_core::claim_review::review_claims(
        set,
        &openblog_core::claim_review::ReviewContext {
            drafts: &drafts,
            paths: &paths,
            claims_file: claims_store::CLAIMS_FILE,
            library: &snapshot.library,
            notebook: &snapshot.notebook,
        },
    );
    gathered.findings.extend(
        openblog_core::claim_review::findings_for_post(&findings, set, post.slug)
            .map(ReviewFinding::from_evidence),
    );
    if config.claim_evidence.publish {
        let mine = |claim: &str| {
            set.claim(claim)
                .is_some_and(|claim| claim.post == post.slug)
        };
        gathered.findings.extend(
            set.notices()
                .iter()
                .filter(|notice| match (notice.collection, notice.id.as_deref()) {
                    (Some("claims"), Some(id)) => mine(id),
                    (Some("links"), Some(id)) => set
                        .links
                        .iter()
                        .any(|link| link.id == id && mine(&link.claim)),
                    _ => false,
                })
                .map(ReviewFinding::from_atlas_diagnostic),
        );
    }
}

/// Context links in the draft, and for each published page one links to,
/// what that page leaves out or asks the author to check: the atlas entry's
/// projection notices and chronology prompts, and the comparison's withheld
/// wording and place notices.
fn context(
    post: &DraftPost<'_>,
    config: &SiteConfig,
    published: &Published,
    gathered: &mut Gathered,
) {
    let links = context_links::find_context_links(post.markdown, post.body_line);
    if links.is_empty() {
        return;
    }
    gathered
        .findings
        .extend(link_findings(post.path, &links, config, published));
    context_pages(&links, published, gathered);
}

/// The context links of a post that name a page the next build does not
/// publish, each as the check owning them states it.
pub(crate) fn link_findings(
    path: &str,
    links: &[context_links::ContextLink],
    config: &SiteConfig,
    published: &Published,
) -> Vec<ReviewFinding> {
    let comparison_ids: BTreeSet<&str> = published
        .comparisons
        .iter()
        .flat_map(|projection| projection.comparisons.iter().map(|c| c.id.as_str()))
        .collect();
    let findings = context_links::review_context_links(links, |kind, id| match kind {
        ContextKind::AtlasEntry => {
            if !config.knowledge_atlas.publish {
                return Some(ContextGap::NotPublishing);
            }
            // A file the build cannot read is already a blocking finding.
            let atlas = published.atlas.as_ref()?;
            match atlas.entry(id) {
                None => Some(ContextGap::Unknown),
                Some(entry) if entry.visibility != Visibility::Approved => {
                    Some(ContextGap::NotApproved)
                }
                Some(_) => None,
            }
        }
        ContextKind::Comparison => {
            if !config.comparisons.publish {
                return Some(ContextGap::NotPublishing);
            }
            let alignments = published.alignments.as_ref()?;
            match alignments
                .alignments
                .alignments
                .iter()
                .find(|alignment| alignment.id == id)
            {
                None => Some(ContextGap::Unknown),
                Some(alignment) if !alignment.is_approved() => Some(ContextGap::NotApproved),
                Some(_) if !comparison_ids.contains(id) => Some(ContextGap::NotProjected),
                Some(_) => None,
            }
        }
    });
    findings
        .iter()
        .map(|finding| ReviewFinding::from_context_link(path, finding))
        .collect()
}

/// For each published page the post's links name, what that page leaves out
/// or asks the author to check.
fn context_pages(
    links: &[context_links::ContextLink],
    published: &Published,
    gathered: &mut Gathered,
) {
    let comparison_ids: BTreeSet<&str> = published
        .comparisons
        .iter()
        .flat_map(|projection| projection.comparisons.iter().map(|c| c.id.as_str()))
        .collect();
    let linked = |kind: ContextKind| -> BTreeSet<&str> {
        links
            .iter()
            .filter(|link| link.kind == kind)
            .map(|link| link.id.as_str())
            .collect()
    };
    if let Some(atlas) = &published.atlas {
        let entries: BTreeSet<&str> = linked(ContextKind::AtlasEntry)
            .into_iter()
            .filter(|id| {
                atlas
                    .entry(id)
                    .is_some_and(|entry| entry.visibility == Visibility::Approved)
            })
            .collect();
        let touches = |collection: Option<&str>, id: Option<&str>| match (collection, id) {
            (Some("entries"), Some(id)) => entries.contains(id),
            (Some("relationships"), Some(id)) => atlas.relationship(id).is_some_and(|edge| {
                entries.contains(edge.from.as_str()) || entries.contains(edge.to.as_str())
            }),
            _ => false,
        };
        if !entries.is_empty() {
            gathered.findings.extend(
                atlas
                    .notices()
                    .iter()
                    .filter(|notice| touches(notice.collection, notice.id.as_deref()))
                    .map(ReviewFinding::from_atlas_diagnostic),
            );
            gathered.findings.extend(
                ChronologyIndex::of(atlas)
                    .prompts
                    .iter()
                    .filter(|prompt| touches(Some(prompt.collection), Some(&prompt.id)))
                    .map(ReviewFinding::from_chronology_prompt),
            );
        }
    }
    if let (Some(projection), Some(snapshot)) = (&published.comparisons, &published.alignments) {
        let compared = linked(ContextKind::Comparison);
        for comparison in projection
            .comparisons
            .iter()
            .filter(|comparison| compared.contains(comparison.id.as_str()))
        {
            gathered
                .findings
                .extend(ReviewFinding::from_comparison(comparison));
        }
        let links = Links {
            library: &snapshot.library,
            notebook: &snapshot.notebook,
        };
        gathered.findings.extend(
            snapshot
                .alignments
                .notices(links)
                .iter()
                .filter(|notice| {
                    notice.collection == Some("alignments")
                        && notice
                            .id
                            .as_deref()
                            .is_some_and(|id| compared.contains(id) && comparison_ids.contains(id))
                })
                .map(ReviewFinding::from_atlas_diagnostic),
        );
    }
}

pub(crate) fn library_findings(error: source_store::StoreError) -> Vec<ReviewFinding> {
    match error {
        source_store::StoreError::Invalid(diagnostics) => diagnostics
            .iter()
            .map(ReviewFinding::from_source_diagnostic)
            .collect(),
        other => vec![ReviewFinding::unreadable(
            ObjectKind::SourceLibrary,
            first_line(&other.to_string()),
        )],
    }
}

pub(crate) fn notebook_findings(error: notebook_store::StoreError) -> Vec<ReviewFinding> {
    match error {
        notebook_store::StoreError::Invalid(diagnostics) => diagnostics
            .iter()
            .map(ReviewFinding::from_note_diagnostic)
            .collect(),
        other => vec![ReviewFinding::unreadable(
            ObjectKind::Notebook,
            first_line(&other.to_string()),
        )],
    }
}

pub(crate) fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or_default().to_string()
}

// ---------------------------------------------------------------------------
// The acknowledgements file (ADR 0124)
// ---------------------------------------------------------------------------

/// One read of the acknowledgements and the revision a change must name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub set: AcknowledgementSet,
    /// SHA-256 of the stored bytes, or of the empty file while none is stored.
    pub revision: String,
    pub stored: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StoreError {
    /// The file changed after the caller read the revision it named.
    Conflict,
    /// The stored file or the requested change is invalid. Nothing was written.
    Invalid(String),
    /// The file could not be located, read or written safely. Nothing was written.
    Storage(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict => formatter.write_str(
                "the acknowledgements changed since they were read; review again and retry",
            ),
            Self::Invalid(message) => write!(formatter, "{ACKNOWLEDGEMENTS_FILE}: {message}"),
            Self::Storage(message) => formatter.write_str(message),
        }
    }
}

fn file_path(root: &Path) -> Result<PathBuf, StoreError> {
    source_store::contained(root, Path::new(ACKNOWLEDGEMENTS_FILE))
        .map_err(|error| StoreError::Storage(error.to_string()))
}

/// Read and validate the stored acknowledgements. An absent file is empty,
/// and reading never creates a file or directory.
pub fn load(root: &Path) -> Result<Snapshot, StoreError> {
    let path = file_path(root)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let set = AcknowledgementSet::empty();
            return Ok(Snapshot {
                revision: source_store::revision(set.to_json().as_bytes()),
                set,
                stored: false,
            });
        }
        Err(error) => {
            return Err(StoreError::Storage(format!(
                "cannot inspect {ACKNOWLEDGEMENTS_FILE}: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(StoreError::Storage(format!(
            "{ACKNOWLEDGEMENTS_FILE} is not a regular file; replace it with one"
        )));
    }
    let too_large = || {
        StoreError::Invalid(format!(
            "the file is larger than {MAX_ACKNOWLEDGEMENTS_BYTES} bytes"
        ))
    };
    if metadata.len() > MAX_ACKNOWLEDGEMENTS_BYTES as u64 {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .and_then(|file| {
            file.take(MAX_ACKNOWLEDGEMENTS_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| {
            StoreError::Storage(format!("cannot read {ACKNOWLEDGEMENTS_FILE}: {error}"))
        })?;
    if bytes.len() > MAX_ACKNOWLEDGEMENTS_BYTES {
        return Err(too_large());
    }
    let revision = source_store::revision(&bytes);
    let text = String::from_utf8(bytes)
        .map_err(|_| StoreError::Invalid("the file is not valid UTF-8".into()))?;
    let set = AcknowledgementSet::parse(&text).map_err(StoreError::Invalid)?;
    Ok(Snapshot {
        set,
        revision,
        stored: true,
    })
}

/// Apply one change to the acknowledgements named by `expected_revision`.
pub fn change(
    root: &Path,
    expected_revision: &str,
    edit: impl FnOnce(&mut AcknowledgementSet) -> Result<(), String>,
) -> Result<Snapshot, StoreError> {
    change_using(root, expected_revision, edit, |from, to| {
        crate::fsutil::replace_file(from, to)
    })
}

fn change_using(
    root: &Path,
    expected_revision: &str,
    edit: impl FnOnce(&mut AcknowledgementSet) -> Result<(), String>,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<Snapshot, StoreError> {
    let path = file_path(root)?;
    let directory = path
        .parent()
        .ok_or_else(|| StoreError::Storage("the acknowledgements file has no directory".into()))?;
    if !directory.is_dir() {
        // Check the change before creating anything.
        let current = load(root)?;
        if current.revision != expected_revision {
            return Err(StoreError::Conflict);
        }
        let mut set = current.set;
        edit(&mut set).map_err(StoreError::Invalid)?;
        source_store::create_private_directory(directory)
            .map_err(|error| StoreError::Storage(error.to_string()))?;
        return write_checked(root, &path, expected_revision, set, rename);
    }
    let _lock = FileLock::acquire(
        path.with_extension("json.lock"),
        "acknowledgements write",
        LOCK_WAIT,
    )
    .map_err(StoreError::Storage)?;
    let current = load(root)?;
    if current.revision != expected_revision {
        return Err(StoreError::Conflict);
    }
    let mut set = current.set;
    edit(&mut set).map_err(StoreError::Invalid)?;
    commit(&path, &set, rename)
}

fn write_checked(
    root: &Path,
    path: &Path,
    expected_revision: &str,
    set: AcknowledgementSet,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<Snapshot, StoreError> {
    let _lock = FileLock::acquire(
        path.with_extension("json.lock"),
        "acknowledgements write",
        LOCK_WAIT,
    )
    .map_err(StoreError::Storage)?;
    if load(root)?.revision != expected_revision {
        return Err(StoreError::Conflict);
    }
    commit(path, &set, rename)
}

/// Write the set to a new temporary file beside `path`, flush it, and rename
/// it over `path`. On any failure the temporary file is removed and `path`
/// keeps its previous contents.
fn commit(
    path: &Path,
    set: &AcknowledgementSet,
    rename: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<Snapshot, StoreError> {
    let text = set.to_json();
    if text.len() > MAX_ACKNOWLEDGEMENTS_BYTES {
        return Err(StoreError::Invalid(format!(
            "the change would make the file larger than {MAX_ACKNOWLEDGEMENTS_BYTES} bytes"
        )));
    }
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
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        rename(&temporary, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(StoreError::Storage(format!(
            "could not save the acknowledgement ({error}); the stored acknowledgements are unchanged"
        )));
    }
    source_store::remove_interrupted_writes(path);
    Ok(Snapshot {
        set: set.clone(),
        revision: source_store::revision(text.as_bytes()),
        stored: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use openblog_core::publication_review::{Acknowledgement, Validator};

    fn temp_root(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "openblog-acknowledgements-{tag}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn ack(code: &str) -> Acknowledgement {
        Acknowledgement {
            validator: Validator::ResearchProfile,
            code: code.into(),
            object: ObjectKind::Post,
            path: Some("posts/cave.md".into()),
            id: None,
            field: None,
            fingerprint: "0123456789abcdef0123456789abcdef".into(),
        }
    }

    #[test]
    fn an_absent_file_reads_empty_and_creates_nothing() {
        let root = temp_root("absent");
        let snapshot = load(&root).unwrap();
        assert!(!snapshot.stored && snapshot.set.acknowledgements.is_empty());
        assert!(!root.join(".openblog").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changes_name_the_revision_and_a_refused_change_writes_nothing() {
        let root = temp_root("changes");
        let empty = load(&root).unwrap();
        let saved = change(&root, &empty.revision, |set| {
            set.add(ack("abstract-missing"))
        })
        .unwrap();
        assert_eq!(saved.set.acknowledgements.len(), 1);
        let bytes = fs::read(root.join(ACKNOWLEDGEMENTS_FILE)).unwrap();
        assert_eq!(
            change(&root, &empty.revision, |set| set
                .add(ack("references-missing"))),
            Err(StoreError::Conflict)
        );
        // A refusing finding can never be acknowledged.
        let refused = change(&root, &saved.revision, |set| {
            set.add(ack("citation-syntax"))
        });
        assert!(
            matches!(refused, Err(StoreError::Invalid(_))),
            "{refused:?}"
        );
        let failed = change_using(
            &root,
            &saved.revision,
            |set| set.add(ack("references-missing")),
            |_, _| Err(std::io::Error::other("disk full")),
        );
        assert!(matches!(failed, Err(StoreError::Storage(_))));
        assert_eq!(fs::read(root.join(ACKNOWLEDGEMENTS_FILE)).unwrap(), bytes);
        let leftovers = fs::read_dir(root.join(".openblog/private/research"))
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_damaged_or_hostile_file_is_refused_whole() {
        let root = temp_root("damaged");
        let path = root.join(ACKNOWLEDGEMENTS_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        for text in [
            "{ not json",
            r#"{"version":2,"acknowledgements":[]}"#,
            r#"{"version":1,"acknowledgements":[],"resolved":true}"#,
            r#"{"version":1,"acknowledgements":[{"validator":"citation-review","code":"citation-unresolved","object":"post","fingerprint":"0123456789abcdef0123456789abcdef"}]}"#,
            r#"{"version":1,"acknowledgements":[{"validator":"research-profile","code":"abstract-missing","object":"post","fingerprint":"0123456789abcdef0123456789abcdef","note":"x"}]}"#,
        ] {
            fs::write(&path, text).unwrap();
            assert!(matches!(load(&root), Err(StoreError::Invalid(_))), "{text}");
            assert!(change(&root, "x", |_| Ok(())).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), text);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
