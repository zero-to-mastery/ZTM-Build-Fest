//! The content model: posts, series, tags, and pages loaded from Markdown
//! sources. This module does no file I/O so it can run in WebAssembly; the
//! CLI reads the files and hands their contents over as `SourceFile`s.

use std::collections::BTreeMap;

use crate::accessibility::{self, AccessibilityFinding, DocumentAuditInput};
use crate::bibliography::{
    self, CitationLocale, CitationNoteLabels, CitationStyle, CitationSummary,
};
use crate::capability::CapabilityDescriptor;
use crate::claim_publication::{ClaimEvidence, ClaimEvidenceSource, PostEvidence};
use crate::config::SiteConfig;
use crate::contributor::{self, CreditProvenance, ResolvedCredit};
use crate::date::DateTime;
use crate::field_journal::FieldJournalMetadata;
use crate::frontmatter::{self, FrontMatter};
use crate::markdown::{self, Heading, RenderOptions};
use crate::profile::{self, ProfileBehavior};
use crate::recipe::Recipe;
use crate::research::{self, EvidenceFinding, ResearchMetadata};
use crate::shared_source::SharedAttribution;
use crate::slug::{from_file_stem, slugify};
use crate::source_library::SourceLibrary;
use crate::video::VideoMetadata;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceFile {
    /// Path relative to the content directory, e.g. `posts/hello.md`.
    pub path: String,
    pub contents: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Sources {
    pub posts: Vec<SourceFile>,
    /// Adjacent, versioned work-credit sidecars for posts.
    pub credits: Vec<SourceFile>,
    pub series: Vec<SourceFile>,
    pub pages: Vec<SourceFile>,
    /// The `services/` collection (ADR 0311).
    pub services: Vec<SourceFile>,
    /// Where the private source library comes from, if anywhere. A load
    /// reads it only when a post that opts in to citations cites something,
    /// and publishes only the cited references' public description (ADR 0048).
    pub source_library: Option<LibrarySource>,
    /// The projection of the private claims file, read only while the site
    /// publishes claim evidence (ADR 0075); `None` otherwise.
    pub claim_evidence: Option<ClaimEvidenceSource>,
    /// The site's published reader feedback (`reader-feedback.json` in the
    /// content folder, ADR 0083), when the file exists.
    pub reader_feedback: Option<SourceFile>,
    /// The site's published Third Perspectives (`third-perspectives.json` in
    /// the content folder, ADR 0115), when the file exists.
    pub third_perspectives: Option<SourceFile>,
    /// The site's featured reflections (`community-perspectives.json` in the
    /// content folder, ADR 0181), when the file exists. Read strictly; nothing
    /// in a page, feed or export changes (the section is #230).
    pub community_features: Option<SourceFile>,
    /// The site's continuation links (`continuations.json` in the content
    /// folder, ADR 0219), when the file exists.
    pub continuations: Option<SourceFile>,
    /// The site's landing page (`landing.json` in the content folder, ADR
    /// 0245), when the file exists. Without it, or with no visible section,
    /// the home page is built from `home.*` exactly as before.
    pub landing: Option<SourceFile>,
}

/// The private source library as a site load receives it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LibrarySource {
    /// The library file's project-relative path and text, already in memory.
    Text(SourceFile),
    /// A read the load makes at most once, on first need, so a site whose
    /// posts cite nothing never reads the library at all.
    Deferred(LibraryReader),
}

/// Reads the private source library on demand: its project-relative path and
/// text, `None` while no library is stored, or why it cannot be read safely
/// (reported only to the posts that need it, never with its contents).
#[derive(Clone)]
pub struct LibraryReader(
    std::sync::Arc<dyn Fn() -> Result<Option<SourceFile>, String> + Send + Sync>,
);

impl LibraryReader {
    pub fn new(
        read: impl Fn() -> Result<Option<SourceFile>, String> + Send + Sync + 'static,
    ) -> Self {
        Self(std::sync::Arc::new(read))
    }

    fn read(&self) -> Result<Option<SourceFile>, String> {
        (self.0)()
    }
}

impl std::fmt::Debug for LibraryReader {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("LibraryReader(..)")
    }
}

/// Two readers are equal only when they are the same reader.
impl PartialEq for LibraryReader {
    fn eq(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for LibraryReader {}

/// Validated association between Markdown posts and their adjacent credit
/// sidecars. Consumers such as Admin Studio use this same index as `Site::load`
/// so attribution never depends on directory iteration order.
pub struct CreditSidecarIndex<'a> {
    pub by_post: BTreeMap<String, &'a SourceFile>,
    pub post_errors: BTreeMap<String, String>,
    pub errors: Vec<String>,
}

pub fn associate_credit_sidecars(sources: &Sources) -> CreditSidecarIndex<'_> {
    let mut owners: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for post in &sources.posts {
        if let Some(path) = contributor::sidecar_path(&post.path) {
            owners
                .entry(path)
                .or_default()
                .push(post.path.replace('\\', "/"));
        }
    }

    let mut sidecars: BTreeMap<String, Vec<&SourceFile>> = BTreeMap::new();
    for sidecar in &sources.credits {
        sidecars
            .entry(sidecar.path.replace('\\', "/"))
            .or_default()
            .push(sidecar);
    }

    let mut by_post = BTreeMap::new();
    let mut post_errors = BTreeMap::new();
    let mut errors = Vec::new();
    for (path, matching_sidecars) in sidecars {
        let matching_owners = owners.get(&path).map(Vec::as_slice).unwrap_or_default();
        let error = if matching_sidecars.len() > 1 {
            Some(format!("{path}: duplicate credit sidecar path"))
        } else if matching_owners.is_empty() {
            Some(format!(
                "{path}: credit sidecar has no matching Markdown post"
            ))
        } else if matching_owners.len() > 1 {
            Some(format!(
                "{path}: ambiguous credit sidecar target; both {} resolve to this path",
                matching_owners
                    .iter()
                    .map(|owner| format!("`{owner}`"))
                    .collect::<Vec<_>>()
                    .join(" and ")
            ))
        } else {
            by_post.insert(matching_owners[0].clone(), matching_sidecars[0]);
            None
        };
        if let Some(error) = error {
            for owner in matching_owners {
                post_errors.insert(owner.clone(), error.clone());
            }
            errors.push(error);
        }
    }
    CreditSidecarIndex {
        by_post,
        post_errors,
        errors,
    }
}

#[derive(Clone, Debug, Default)]
pub struct LoadOptions {
    /// Include drafts and scheduled posts (for previews and the admin editor).
    pub include_drafts: bool,
    /// Include only this source when it is a draft or scheduled post.
    /// All other posts continue to follow production visibility rules.
    pub preview_source: Option<String>,
    /// The current time. Posts dated after it are held back as scheduled.
    /// `None` disables scheduling, which keeps pure builds deterministic.
    pub now: Option<DateTime>,
}

/// A post that exists but is not public yet because its date is in the future.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scheduled {
    pub title: String,
    pub slug: String,
    pub date: DateTime,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TagRef {
    pub name: String,
    pub slug: String,
}

pub(crate) const DISCUSSION_ANCHOR: &str = "ob-discussion";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CommentsPolicy {
    #[default]
    Open,
    Locked,
    Hidden,
}

impl CommentsPolicy {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("open").trim().to_ascii_lowercase().as_str() {
            "" | "open" | "true" => Ok(Self::Open),
            "locked" => Ok(Self::Locked),
            "hidden" | "false" => Ok(Self::Hidden),
            _ => Err("comments must be `open`, `locked`, or `hidden`".into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Post {
    pub title: String,
    /// Optional one-line subheading shown under the title; separate from `description`.
    pub subtitle: Option<String>,
    pub slug: String,
    /// Site-relative URL path, e.g. `/posts/hello/`.
    pub url: String,
    pub date: DateTime,
    pub updated: Option<DateTime>,
    pub tags: Vec<TagRef>,
    /// Slug of the series this post belongs to.
    pub series: Option<String>,
    /// Explicit position within the series; otherwise posts are ordered by date.
    pub series_order: Option<u32>,
    pub cover: Option<String>,
    pub cover_alt: String,
    pub description: String,
    pub draft: bool,
    pub comments: CommentsPolicy,
    /// This post's own modes for participation kinds beyond comments, from
    /// its `participation:` front matter (ADR 0101). A kind the site has
    /// switched off stays off whatever this says.
    pub participation: crate::participation::PostParticipation,
    /// `<link rel="canonical">` override, for cross-posted articles.
    pub canonical: Option<String>,
    /// Where the article was first published (shown in the footer).
    pub source_url: Option<String>,
    /// Theme override for this post.
    pub theme: Option<String>,
    /// Old addresses that redirect here (`/old-slug/`), for moved or renamed posts.
    pub aliases: Vec<String>,
    /// Canonical Markdown body retained for portable representations.
    pub(crate) authored_markdown: String,
    /// The body with its citations published as notes, for a post that opts
    /// in and cites; every public representation reads it instead of the
    /// authored body (ADR 0048).
    pub(crate) published_markdown: Option<String>,
    /// Why an opted-in post's citations could not be published, for the site
    /// load to decide: it refuses a post this load publishes and warns about a
    /// draft or a held-back post, whose citations stay text (ADR 0049).
    pub(crate) citation_error: Option<String>,
    /// What the published citations made public, for a post that publishes
    /// them; portable bibliography exports read it (ADR 0050).
    pub(crate) citations: Option<CitationSummary>,
    /// The supplements of a post that opts in to reading modes with
    /// `readingModes: true` (ADR 0140); `None` for every other post.
    pub(crate) reading_depth: Option<crate::reading_depth::ReadingDepth>,
    /// What the post publishes of its approved claims and its revision notes,
    /// for a site that publishes claim evidence (ADR 0075).
    pub(crate) claim_evidence: Option<PostEvidence>,
    /// Why its claim evidence could not be published, for the site load to
    /// decide as for citations: refuse a post it publishes, warn otherwise.
    pub(crate) evidence_error: Option<String>,
    /// The approved reader notes this post's canonical page shows, read
    /// through the public projection (ADR 0083); empty for most posts.
    pub(crate) reader_feedback: Vec<crate::feedback_publication::PublicFeedback>,
    /// The approved Third Perspectives this post's canonical page shows, read
    /// through the one public projection (ADRs 0111 and 0115).
    pub(crate) third_perspectives: Vec<crate::perspective_publication::PublicPerspective>,
    /// The reflections the editors chose to feature on this post's canonical
    /// page, by the day they were featured (ADRs 0180 and 0184); empty for
    /// most posts. Each is the one public projection of a reflection that is
    /// also in `third_perspectives`.
    pub(crate) community_features: Vec<crate::community_feature::FeaturedPerspective>,
    /// Where earlier questions on this post went, and what it continues, as
    /// ordinary links on its canonical page (ADRs 0218 and 0219).
    pub(crate) continuations: PostContinuations,
    /// The body HTML. A concept link (ADR 0172) is the plain text of its
    /// label here until [`Site::link_concepts`] resolves it against the
    /// public atlas, so a post nobody resolved never carries a link that
    /// leads nowhere.
    pub html: String,
    /// The body HTML with each concept link still marked, for
    /// [`Site::link_concepts`]; `None` for a post with no concept link.
    pub(crate) concept_html: Option<String>,
    /// The ids (as written) of concept links inside an image's description,
    /// which are plain text there; each is a warning for the author.
    pub(crate) concept_refusals: Vec<crate::concept_links::Refusal>,
    /// The publication Markdown with each concept link written as its label,
    /// for copies that leave the site; `None` for a post with no concept link.
    pub(crate) portable_markdown: Option<String>,
    pub text: String,
    pub headings: Vec<Heading>,
    pub word_count: usize,
    pub reading_minutes: u32,
    pub code_languages: Vec<String>,
    /// Ordered, resolved work attribution. Legacy posts synthesize one author
    /// from the site configuration until an explicit sidecar exists.
    pub credits: Vec<ResolvedCredit>,
    pub credit_provenance: CreditProvenance,
    /// Resolved content profile. Unknown authored ids are preserved here and
    /// use article behavior until a matching profile is available.
    pub profile: String,
    pub(crate) profile_warnings: Vec<String>,
    pub(crate) accessibility: Vec<AccessibilityFinding>,
    pub(crate) evidence: Vec<EvidenceFinding>,
    /// Identifier, version, quotation-location and citation-consistency
    /// findings about the sources this post cites (ADR 0148), for the author.
    pub(crate) source_review: Vec<crate::source_review::SourceReviewFinding>,
    /// Semantic capabilities detected in the authored Markdown.
    pub capabilities: Vec<CapabilityDescriptor>,
    /// Set for posts using the recipe profile: times, servings, ingredients, steps.
    pub recipe: Option<Recipe>,
    /// Set for posts using the research profile: identifiers and evidence metadata.
    pub research: Option<ResearchMetadata>,
    /// Set for posts using the video-production profile.
    pub video: Option<VideoMetadata>,
    /// Set for outdoor logs using the field-journal profile.
    pub field_journal: Option<FieldJournalMetadata>,
    /// Set for posts using the job profile once every field validates.
    pub job: Option<crate::job::JobMetadata>,
    /// Approved public source attribution of a shared reflection (title, link, type, guiding
    /// question); never any private collaboration state.
    pub shared_attribution: Option<SharedAttribution>,
    /// Per-post code-block overrides from front matter (`highlight`, `lineNumbers`).
    pub code_highlight: Option<bool>,
    pub code_line_numbers: Option<bool>,
    /// The source file this post came from.
    pub source: String,
}

impl Post {
    /// Canonical authored Markdown used to derive portable representations.
    pub fn authored_markdown(&self) -> &str {
        &self.authored_markdown
    }

    /// The Markdown every public representation is built from: the authored
    /// body, or for a post that publishes citations, that body with them
    /// written as generated notes. One body, so the native page, portable
    /// copies and feeds can never disagree about a citation.
    pub fn publication_markdown(&self) -> &str {
        self.published_markdown
            .as_deref()
            .unwrap_or(&self.authored_markdown)
    }

    /// Whether the post links an atlas entry with `atlas:` (ADR 0172), so it
    /// needs the public atlas attached before it is shown.
    pub fn has_concept_links(&self) -> bool {
        self.concept_html.is_some()
    }

    /// The Markdown portable copies, feeds and exports are built from: the
    /// publication Markdown, with each atlas link written as its label and
    /// each raw concept mark removed, since a copy cannot resolve an atlas
    /// entry (ADR 0173).
    pub fn portable_markdown(&self) -> &str {
        self.portable_markdown
            .as_deref()
            .unwrap_or_else(|| self.publication_markdown())
    }

    /// The supplements this post publishes for its reading modes, or `None`
    /// when it has not opted in (ADR 0140).
    pub fn reading_depth(&self) -> Option<&crate::reading_depth::ReadingDepth> {
        self.reading_depth.as_ref()
    }

    /// What this post's published citations made public, or `None` when it
    /// publishes none. Its references are the only input of the portable
    /// bibliography exports, so they hold exactly what the page shows.
    pub fn citations(&self) -> Option<&CitationSummary> {
        self.citations.as_ref()
    }

    /// What this post publishes of its approved claims, evidence and revision
    /// notes, or `None` when it publishes none (ADR 0075).
    pub fn claim_evidence(&self) -> Option<&PostEvidence> {
        self.claim_evidence.as_ref()
    }

    /// The approved reader notes this post's canonical page shows (ADR 0083).
    pub fn reader_feedback(&self) -> &[crate::feedback_publication::PublicFeedback] {
        &self.reader_feedback
    }

    /// The approved Third Perspectives this post's canonical page shows (ADR 0115).
    pub fn third_perspectives(&self) -> &[crate::perspective_publication::PublicPerspective] {
        &self.third_perspectives
    }

    /// The featured reflections this post's canonical page shows now (ADR 0184).
    /// The continuation links this post's canonical page shows now.
    pub fn continuations(&self) -> &PostContinuations {
        &self.continuations
    }

    pub fn community_features(&self) -> &[crate::community_feature::FeaturedPerspective] {
        &self.community_features
    }

    /// The reader-facing reference data of this post's published citations
    /// (ADR 0059), or `None` when it publishes none.
    pub fn reader_references(&self) -> Option<crate::reader_references::ReaderReferences> {
        self.citations.as_ref().and_then(|summary| {
            crate::reader_references::ReaderReferences::from_summary(summary).ok()
        })
    }

    /// Actual authors only, in authored credit order. Secondary contributors
    /// remain available through `credits` but never leak into author metadata.
    pub fn authors(&self) -> impl Iterator<Item = &ResolvedCredit> {
        self.credits
            .iter()
            .filter(|credit| credit.roles.iter().any(|role| role.is_author()))
    }

    /// Whether this is a collaborative work: its approved work credits (an explicit credit
    /// sidecar, which is what the shared-publication gate writes) name two or more authors
    /// (ADR 0040). A legacy post's default site-author credit never makes it one, and neither
    /// does a single credited author.
    pub fn is_collaborative(&self) -> bool {
        self.credit_provenance == CreditProvenance::ExplicitSidecar
            && self.authors().nth(1).is_some()
    }

    /// The escaped "Originally published at" notice for a post first published
    /// elsewhere, shared by the native page and the portable projection.
    pub(crate) fn source_notice_html(&self) -> Option<String> {
        use crate::escape::{attr, text};
        self.source_url.as_deref().map(|source_url| {
            format!(
                "<p class=\"ob-source\">Originally published at <a class=\"u-syndication\" href=\"{}\" rel=\"noopener\">{}</a>.</p>\n",
                attr(source_url),
                text(source_url.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/'))
            )
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Series {
    pub name: String,
    pub slug: String,
    pub url: String,
    pub description_html: String,
    /// What the renderer refused in the description (ADR 0173), for the
    /// author's warnings written when the site loads.
    pub(crate) concept_refusals: Vec<crate::concept_links::Refusal>,
    pub description_text: String,
    pub theme: Option<String>,
    pub cover: Option<String>,
    /// Listing order on the series index; lower first, then by name.
    pub order: u32,
    /// Indices into `Site::posts`, in reading order (first part first).
    pub posts: Vec<usize>,
    pub source: Option<String>,
    pub(crate) accessibility: Vec<AccessibilityFinding>,
    /// Semantic capabilities detected in the authored description.
    pub capabilities: Vec<CapabilityDescriptor>,
    /// Old series addresses (`aliases:` in the series page) that redirect here.
    pub aliases: Vec<String>,
}

/// One published part's place in a collaborative series, as feeds and portable copies state it
/// (ADR 0041). Built by `Site::series_context`; every value is already public on the series page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeriesContext {
    /// The series name, from its series definition or its slug.
    pub name: String,
    /// The series page, relative to the site root (`/series/<slug>/`).
    pub url: String,
    /// One-based position in the series' published reading order.
    pub part: usize,
    /// How many published parts the series has. Only the regenerated feeds state it (JSON Feed,
    /// llms-full.txt); portable copies leave it out so a growing series does not change them.
    pub parts: usize,
    /// This part's named authors, in credit order.
    pub part_authors: Vec<String>,
    /// The series' named authors, once each, in order of first appearance.
    pub contributors: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tag {
    pub name: String,
    pub slug: String,
    pub url: String,
    /// Indices into `Site::posts`, newest first.
    pub posts: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    pub title: String,
    pub slug: String,
    pub url: String,
    pub description: String,
    pub html: String,
    /// What the renderer refused in the page (ADR 0173), for the author's
    /// warnings written when the site loads.
    pub(crate) concept_refusals: Vec<crate::concept_links::Refusal>,
    pub text: String,
    pub headings: Vec<Heading>,
    pub theme: Option<String>,
    /// Add this page to the header navigation.
    pub nav: bool,
    pub aliases: Vec<String>,
    pub source: String,
    pub(crate) accessibility: Vec<AccessibilityFinding>,
    /// Semantic capabilities detected in the authored Markdown.
    pub capabilities: Vec<CapabilityDescriptor>,
}

/// One offering of the business, from `services/` (ADR 0311). Its address is
/// `/services/<id>/`.
#[derive(Clone, Debug)]
pub struct Service {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub includes: Vec<String>,
    pub price_band: Option<crate::job::CostBand>,
    pub typical_timeline: Option<String>,
    pub faq: Vec<crate::service::FaqEntry>,
    /// Not published: only a load that includes drafts holds it.
    pub draft: bool,
    pub url: String,
    /// The rendered body.
    pub html: String,
    pub text: String,
    pub source: String,
    pub(crate) concept_refusals: Vec<crate::concept_links::Refusal>,
    pub(crate) accessibility: Vec<AccessibilityFinding>,
    pub capabilities: Vec<CapabilityDescriptor>,
}

#[derive(Clone, Debug)]
pub struct Site {
    pub config: SiteConfig,
    /// Published posts, newest first.
    pub posts: Vec<Post>,
    pub series: Vec<Series>,
    pub tags: Vec<Tag>,
    pub pages: Vec<Page>,
    /// The `services/` collection (ADR 0311), by name then id. Empty for a
    /// site without one, which then builds exactly as it always did.
    pub services: Vec<Service>,
    /// Posts waiting for their publish date, soonest first.
    pub scheduled: Vec<Scheduled>,
    pub warnings: Vec<String>,
    /// Structured source findings for Accessibility Studio and CLI reporting.
    pub accessibility: Vec<AccessibilityFinding>,
    /// Structured research/evidence guidance for the CLI and Admin Studio.
    pub evidence: Vec<EvidenceFinding>,
    /// Source-review findings about the sources posts cite (ADR 0148), for
    /// `openblog check` and builds. Never written to the output.
    pub source_review: Vec<crate::source_review::SourceReviewFinding>,
    /// Known view totals per page path, supplied by the caller (for example from
    /// the analytics backup) so static builds can show counts.
    pub view_counts: BTreeMap<String, u64>,
    /// The public Knowledge Atlas projection, supplied by the caller only when
    /// the site opts in to publishing it (ADR 0058). `None` writes no atlas
    /// output at all.
    pub atlas: Option<crate::atlas_publication::PublicAtlas>,
    /// The public comparison projection, supplied by the caller only when the
    /// site opts in to publishing comparisons (ADR 0092). `None` writes no
    /// comparison output at all.
    pub comparisons: Option<crate::comparison_publication::PublicComparisons>,
    /// The public reading paths, supplied by the caller only when the site
    /// publishes them (`readingPaths.publish`, ADR 0212). `None` writes no
    /// path output at all.
    pub reading_paths: Option<crate::reading_path::PublicPaths>,
    /// The public interpretation comparisons, supplied by the caller only when
    /// the site publishes them (`interpretations.publish`, ADR 0232). `None`
    /// writes no comparison page at all.
    pub interpretations: Option<crate::interpretation_publication::PublicInterpretations>,
    /// The public curated research context, supplied by the caller only when
    /// the site publishes it (`curatedContext.publish`, ADR 0185) and its
    /// selections can be read. `None` writes no curated output at all: no
    /// file and no section on any page.
    pub curation: Option<crate::curated_selection::PublicCuration>,
    /// The curated context projected once over every post (ADR 0202), shared
    /// by the portable copies so a long feed does not project it per post.
    /// Built on first use from `curation`; assign `curation` through
    /// [`Site::set_curation`], which drops it.
    curated_cache:
        std::sync::OnceLock<Option<std::sync::Arc<crate::curated_context::CuratedContext>>>,
    /// The landing page, when the site has a valid `landing.json`
    /// (ADR 0245). The home page renders its visible sections instead of the
    /// `home.*` layout; `None` leaves the home page as it always was.
    pub landing: Option<crate::landing::LandingPage>,
    /// Why this site's claim evidence cannot be published (ADR 0075): the
    /// claims file, or the library or notebook it is checked against, cannot
    /// be read or validated. A full build or `check` refuses while it is set,
    /// where a damaged published atlas refuses it; `generate` itself does not,
    /// so a load or render that only validates content (an Admin save, a
    /// preview) is not stopped by it.
    pub claim_evidence_error: Option<String>,
    /// Why the site's published reader feedback cannot be read (ADR 0083).
    /// Like `claim_evidence_error`, a full build or `check` refuses while it
    /// is set, and a load that only validates content is not stopped.
    pub reader_feedback_error: Option<String>,
    /// Why the site's published Third Perspectives cannot be read (ADR 0115),
    /// refused like `reader_feedback_error`.
    pub third_perspectives_error: Option<String>,
    /// Why the site's featured reflections cannot be read (ADR 0181), refused
    /// like `third_perspectives_error`.
    pub community_features_error: Option<String>,
    /// Why the site's continuation links cannot be read (ADR 0219), refused
    /// like `community_features_error`.
    pub continuations_error: Option<String>,
    /// The time the site was loaded for (`LoadOptions::now`). A post dated after it is scheduled,
    /// even when a preview or the admin editor loaded it, so it is never a series part.
    now: Option<DateTime>,
}

impl Site {
    /// Attach (or remove) the public curated context. Anything projected from
    /// the earlier value is dropped.
    pub fn set_curation(&mut self, curation: Option<crate::curated_selection::PublicCuration>) {
        self.curation = curation;
        self.curated_cache = std::sync::OnceLock::new();
    }

    /// The curated context a portable copy of `post` carries (ADR 0202): the
    /// public curated value's projection, when the site publishes one and
    /// offers this post something. It is the same projection the post's page
    /// is rendered from; where the whole file is not written (a bound, an
    /// inconsistency) it is the projection of this post alone, as its page's.
    /// `None` leaves every copy exactly as it was.
    pub fn curated_context_for(
        &self,
        post: &Post,
    ) -> Option<std::sync::Arc<crate::curated_context::CuratedContext>> {
        use crate::curated_context::{CuratedContext, PostRef};
        let curation = self.curation.as_ref()?;
        let whole = self.curated_cache.get_or_init(|| {
            let posts: Vec<PostRef<'_>> = self
                .posts
                .iter()
                .map(|post| PostRef {
                    slug: post.slug.as_str(),
                    url: post.url.as_str(),
                })
                .collect();
            CuratedContext::project(curation, &posts, &self.config.base_path())
                .ok()
                .filter(|context| !context.items.is_empty())
                .map(std::sync::Arc::new)
        });
        let context = match whole {
            Some(context) => context.clone(),
            None => std::sync::Arc::new(CuratedContext::for_one_post(
                curation,
                PostRef {
                    slug: &post.slug,
                    url: &post.url,
                },
            )?),
        };
        context.for_post(&post.slug).is_some().then_some(context)
    }

    /// Resolve every post's concept links (ADR 0172) against the public atlas
    /// the caller attached, as it is now: a published entry becomes a link to
    /// its page, and anything else the label as plain text with a warning for
    /// the author, scoped to the post and the id. Safe to call again after the
    /// atlas changes; each call replaces the earlier concept warnings.
    pub fn link_concepts(&mut self) {
        self.warnings
            .retain(|warning| !warning.contains(crate::concept_links::WARNING_MARK));
        let mut found = Vec::new();
        for post in &mut self.posts {
            if let Some(marked) = &post.concept_html {
                let linked = crate::concept_links::link_html(marked, self.atlas.as_ref());
                post.html = linked.html;
                found.extend(
                    linked
                        .uses
                        .iter()
                        .filter_map(|used| used.warning(&post.source)),
                );
            }
            found.extend(
                crate::concept_links::refusal_uses(&post.concept_refusals)
                    .iter()
                    .filter_map(|used| used.warning(&post.source)),
            );
        }
        self.warnings.extend(found);
    }

    /// Build the site model. Hard errors (unparseable front matter, missing
    /// titles, duplicate slugs) fail the build; softer problems become warnings.
    pub fn load(
        config: SiteConfig,
        sources: Sources,
        options: LoadOptions,
    ) -> Result<Site, Vec<String>> {
        let mut errors = Vec::new();
        let mut warnings = Vec::new();
        let mut accessibility =
            accessibility::audit_site_language("openblog.json", &config.language);
        let mut evidence = Vec::new();
        let mut source_review = Vec::new();
        let render_options = config.render_options();
        let credit_sidecars = associate_credit_sidecars(&sources);
        // Read and parsed on first need only, so a site whose posts cite
        // nothing never reads it and a broken library refuses only the posts
        // that cite.
        let parsed_library = std::cell::OnceCell::new();
        let library = || -> Result<Option<&SourceLibrary>, String> {
            parsed_library
                .get_or_init(|| read_library(sources.source_library.as_ref(), &config))
                .as_ref()
                .map(Option::as_ref)
                .map_err(Clone::clone)
        };
        errors.extend(credit_sidecars.errors.iter().cloned());
        // Claim evidence, only while the site publishes it (ADR 0075). Without
        // the switch the private claims file is never consulted and every post
        // is published as before.
        let mut claim_evidence_error = None;
        // A site that takes passage feedback publishes the author's revision
        // notes too, without reading any claims file (ADR 0083): a note
        // recorded after a reader's suggestion led to a change.
        let feedback_notes = crate::participation::transport_available(&config)
            && config.participation.passage_feedback_enabled();
        let claim_mode = if config.claim_evidence.publish {
            match &sources.claim_evidence {
                Some(ClaimEvidenceSource::Stored(projection)) => {
                    ClaimEvidenceMode::Publish(Some(projection))
                }
                Some(ClaimEvidenceSource::Unstored { warning }) => {
                    warnings.push(warning.clone());
                    ClaimEvidenceMode::Publish(None)
                }
                Some(ClaimEvidenceSource::Unreadable(error)) => {
                    claim_evidence_error = Some(error.clone());
                    ClaimEvidenceMode::Publish(None)
                }
                None => ClaimEvidenceMode::Publish(None),
            }
        } else if feedback_notes {
            ClaimEvidenceMode::Publish(None)
        } else {
            ClaimEvidenceMode::Off
        };

        // Series definitions first, so posts can reference them.
        let mut series: Vec<Series> = Vec::new();
        for file in &sources.series {
            match load_series(file, concept_options(render_options)) {
                Ok(mut s) => {
                    let (html, notes) = crate::concept_links::plain_outside_post(
                        &s.description_html,
                        &s.concept_refusals,
                        &file.path,
                    );
                    s.description_html = html;
                    warnings.extend(notes);
                    if series.iter().any(|existing| existing.slug == s.slug) {
                        errors.push(format!("{}: duplicate series slug `{}`", file.path, s.slug));
                    } else {
                        accessibility.extend(s.accessibility.iter().cloned());
                        series.push(s);
                    }
                }
                Err(e) => errors.push(format!("{}: {e}", file.path)),
            }
        }

        let mut posts: Vec<Post> = Vec::new();
        let mut scheduled: Vec<Scheduled> = Vec::new();
        // Every slug seen so far, including held-back posts, so a draft or
        // scheduled post cannot silently collide with a published one later.
        let mut slug_sources: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for file in &sources.posts {
            let Some(sidecar_path) = contributor::sidecar_path(&file.path) else {
                errors.push(format!(
                    "{}: post source path must end in `.md` or `.markdown`",
                    file.path
                ));
                continue;
            };
            let normalized_path = file.path.replace('\\', "/");
            if credit_sidecars.post_errors.contains_key(&normalized_path) {
                continue;
            }
            let sidecar = credit_sidecars.by_post.get(&normalized_path).copied();
            match load_post_in(
                file,
                &config,
                render_options,
                Citations::Publish(&library),
                claim_mode,
            ) {
                Ok(mut post) => {
                    if let Err(error) = apply_credits(&mut post, &config, sidecar) {
                        errors.push(format!(
                            "{}: {error}",
                            sidecar.map_or(sidecar_path.as_str(), |source| source.path.as_str())
                        ));
                        continue;
                    }
                    if let Some(existing) = slug_sources.get(&post.slug) {
                        errors.push(format!(
                            "{}: duplicate post slug `{}` (also in {})",
                            file.path, post.slug, existing
                        ));
                        continue;
                    }
                    slug_sources.insert(post.slug.clone(), file.path.clone());
                    warnings.extend(
                        post.profile_warnings
                            .iter()
                            .map(|warning| format!("{}: {warning}", file.path)),
                    );
                    if let Some(r) = &post.recipe {
                        // The usual mistake: **Ingredients** in bold instead of a
                        // heading, or steps written as paragraphs instead of a list.
                        for (found, what, heading) in [
                            (r.ingredients.is_empty(), "ingredients", "## Ingredients"),
                            (r.steps.is_empty(), "steps", "## Steps"),
                        ] {
                            if found {
                                warnings.push(format!(
                                    "{}: recipe has no {what}; put them in a list under a `{heading}` heading",
                                    file.path
                                ));
                            }
                        }
                    }
                    let is_preview_target =
                        options.preview_source.as_deref() == Some(post.source.as_str());
                    let held_back = !options.include_drafts && !is_preview_target;
                    let scheduled_out = held_back && options.now.is_some_and(|now| post.date > now);
                    // Only a post this load publishes is refused (ADR 0049).
                    // A draft, a post waiting for its date and, in a preview,
                    // every other document keep their citations as text and
                    // publish no claim evidence.
                    let reason = if post.draft {
                        Some("while the post is a draft")
                    } else if scheduled_out {
                        Some("until the post is due, and must resolve before then")
                    } else if options.preview_source.is_some() && !is_preview_target {
                        Some("in this preview")
                    } else {
                        None
                    };
                    let mut refused = false;
                    for (what, error) in [
                        ("citations are", post.citation_error.take()),
                        ("claim evidence is", post.evidence_error.take()),
                    ] {
                        let Some(error) = error else { continue };
                        match reason {
                            Some(reason) => warnings.push(format!(
                                "{}: {what} not published {reason}: {error}",
                                file.path
                            )),
                            None => {
                                errors.push(format!("{}: {error}", file.path));
                                refused = true;
                            }
                        }
                    }
                    if refused {
                        continue;
                    }
                    if post.draft && held_back {
                        continue;
                    }
                    if scheduled_out {
                        scheduled.push(Scheduled {
                            title: post.title.clone(),
                            slug: post.slug.clone(),
                            date: post.date,
                            source: post.source.clone(),
                        });
                        continue;
                    }
                    if !post.draft {
                        warnings.extend(seo_warnings(&post));
                    }
                    accessibility.extend(post.accessibility.iter().cloned());
                    evidence.extend(post.evidence.iter().cloned());
                    source_review.extend(post.source_review.iter().cloned());
                    posts.push(post);
                }
                Err(error) => errors.push(format!("{}: {error}", file.path)),
            }
        }
        posts.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| a.slug.cmp(&b.slug)));
        let reader_feedback_error =
            attach_reader_feedback(&mut posts, &sources, &config, &mut warnings);
        let third_perspectives_error =
            attach_third_perspectives(&mut posts, &sources, &config, &mut warnings);
        let community_features_error =
            attach_community_features(&mut posts, &sources, &config, &mut warnings);
        let continuations_error =
            attach_continuations(&mut posts, &sources, options.now, &mut warnings);

        let mut pages: Vec<Page> = Vec::new();
        for file in &sources.pages {
            match load_page(file, concept_options(render_options)) {
                Ok(mut page) => {
                    let (html, notes) = crate::concept_links::plain_outside_post(
                        &page.html,
                        &page.concept_refusals,
                        &file.path,
                    );
                    page.html = html;
                    warnings.extend(notes);
                    if pages.iter().any(|p| p.slug == page.slug) {
                        errors.push(format!(
                            "{}: duplicate page slug `{}`",
                            file.path, page.slug
                        ));
                    } else {
                        accessibility.extend(page.accessibility.iter().cloned());
                        pages.push(page);
                    }
                }
                Err(e) => errors.push(format!("{}: {e}", file.path)),
            }
        }
        pages.sort_by(|a, b| a.title.cmp(&b.title));
        let mut services: Vec<Service> = Vec::new();
        for file in &sources.services {
            if !crate::service::declares_service(&file.contents) {
                continue;
            }
            // A draft service is not published, and its problems are warnings,
            // so a freshly scaffolded one never stops a build.
            let draft = frontmatter::parse(&file.contents)
                .is_ok_and(|document| is_draft(&document.front_matter));
            let shown = !draft
                || options.include_drafts
                || options.preview_source.as_deref() == Some(file.path.as_str());
            match load_service(file, concept_options(render_options)) {
                Ok(_) if !shown => {}
                Ok(mut service) => {
                    let (html, notes) = crate::concept_links::plain_outside_post(
                        &service.html,
                        &service.concept_refusals,
                        &file.path,
                    );
                    service.html = html;
                    warnings.extend(notes);
                    if let Some(existing) = services.iter().find(|s| s.id == service.id) {
                        errors.push(format!(
                            "{}: duplicate service id `{}` (also in {})",
                            file.path, service.id, existing.source
                        ));
                    } else {
                        accessibility.extend(service.accessibility.iter().cloned());
                        services.push(service);
                    }
                }
                Err(e) if draft => {
                    warnings.push(format!("{}: service not ready to publish: {e}", file.path))
                }
                Err(e) => errors.push(format!("{}: {e}", file.path)),
            }
        }
        services.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
        // A job names its service by id. Only a site that has a services
        // collection checks it, so every other site loads as it always did.
        let mut known_services: Vec<&str> = services.iter().map(|s| s.id.as_str()).collect();
        known_services.sort_unstable();
        for post in &posts {
            let Some(job) = &post.job else { continue };
            let Some(problem) =
                crate::service::unknown_service_problem(&known_services, &job.service)
            else {
                continue;
            };
            if post.draft {
                warnings.push(format!(
                    "{}: job not ready to publish: {problem}",
                    post.source
                ));
            } else {
                errors.push(format!("{}: {problem}", post.source));
            }
        }
        if config.home.intro.contains(crate::concept_links::SCHEME) {
            // The home introduction shows an `atlas:` link as its label (the
            // renderer does the same); the author hears about it here.
            let intro = markdown::render(
                &config.home.intro,
                RenderOptions {
                    concept_links: true,
                    ..Default::default()
                },
            );
            warnings.extend(
                crate::concept_links::plain_outside_post(
                    &intro.html,
                    &intro.concept_refusals,
                    "openblog.json (home.intro)",
                )
                .1,
            );
        }

        if !errors.is_empty() {
            return Err(errors);
        }

        // Attach posts to series, creating implicit series for unknown slugs.
        for (index, post) in posts.iter().enumerate() {
            let Some(series_slug) = &post.series else {
                continue;
            };
            let position = match series.iter().position(|s| &s.slug == series_slug) {
                Some(p) => p,
                None => {
                    warnings.push(format!(
                        "{}: series `{}` has no content/series/{}.md; using the slug as its name",
                        post.source, series_slug, series_slug
                    ));
                    series.push(Series {
                        name: humanize(series_slug),
                        slug: series_slug.clone(),
                        url: format!("/series/{series_slug}/"),
                        description_html: String::new(),
                        concept_refusals: Vec::new(),
                        description_text: String::new(),
                        theme: None,
                        cover: None,
                        order: u32::MAX,
                        posts: Vec::new(),
                        source: None,
                        accessibility: Vec::new(),
                        capabilities: Vec::new(),
                        aliases: Vec::new(),
                    });
                    series.len() - 1
                }
            };
            series[position].posts.push(index);
        }
        for s in &mut series {
            s.posts.sort_by(|&a, &b| {
                let (pa, pb) = (&posts[a], &posts[b]);
                match (pa.series_order, pb.series_order) {
                    (Some(x), Some(y)) => x.cmp(&y).then_with(|| pa.date.cmp(&pb.date)),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => pa.date.cmp(&pb.date),
                }
            });
            if s.cover.is_none() {
                s.cover = s.posts.iter().find_map(|&i| posts[i].cover.clone());
            }
        }
        series.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.name.cmp(&b.name)));

        // Tags.
        let mut tag_map: BTreeMap<String, Tag> = BTreeMap::new();
        for (index, post) in posts.iter().enumerate() {
            for tag in &post.tags {
                let entry = tag_map.entry(tag.slug.clone()).or_insert_with(|| Tag {
                    name: tag.name.clone(),
                    slug: tag.slug.clone(),
                    url: format!("/tags/{}/", tag.slug),
                    posts: Vec::new(),
                });
                entry.posts.push(index);
            }
        }
        let mut tags: Vec<Tag> = tag_map.into_values().collect();
        tags.sort_by(|a, b| {
            b.posts
                .len()
                .cmp(&a.posts.len())
                .then_with(|| a.name.cmp(&b.name))
        });

        if !posts.is_empty() {
            if config.author.name.trim().is_empty() {
                warnings.push(
                    "openblog.json: author.name is empty; add the public author name used in bylines and structured data"
                        .into(),
                );
            }
            if config.author.url.trim().is_empty() {
                warnings.push(
                    "openblog.json: author.url is empty; link the byline to an author or About page to establish authorship"
                        .into(),
                );
            }
        }

        scheduled.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.slug.cmp(&b.slug)));
        let landing = load_landing(&sources, &posts, &mut warnings);
        Ok(Site {
            config,
            posts,
            series,
            tags,
            pages,
            services,
            scheduled,
            warnings,
            accessibility,
            evidence,
            source_review,
            view_counts: BTreeMap::new(),
            atlas: None,
            comparisons: None,
            reading_paths: None,
            interpretations: None,
            curation: None,
            curated_cache: std::sync::OnceLock::new(),
            landing,
            claim_evidence_error,
            reader_feedback_error,
            third_perspectives_error,
            community_features_error,
            continuations_error,
            now: options.now,
        })
    }

    pub fn series_by_slug(&self, slug: &str) -> Option<&Series> {
        self.series.iter().find(|s| s.slug == slug)
    }

    pub fn tag_by_slug(&self, slug: &str) -> Option<&Tag> {
        self.tags.iter().find(|t| t.slug == slug)
    }

    /// The theme a post renders with: its own override, then its series', then the site's.
    pub fn theme_for_post<'a>(&'a self, post: &'a Post) -> &'a str {
        if let Some(theme) = &post.theme {
            return theme;
        }
        if let Some(series) = post.series.as_deref().and_then(|s| self.series_by_slug(s)) {
            if let Some(theme) = &series.theme {
                return theme;
            }
        }
        &self.config.theme
    }

    pub fn theme_for_series<'a>(&'a self, series: &'a Series) -> &'a str {
        series.theme.as_deref().unwrap_or(&self.config.theme)
    }

    pub fn theme_for_page<'a>(&'a self, page: &'a Page) -> &'a str {
        page.theme.as_deref().unwrap_or(&self.config.theme)
    }

    /// Every theme name any page of the site uses.
    pub fn used_themes(&self) -> Vec<String> {
        let mut names = vec![self.config.theme.clone()];
        for post in &self.posts {
            let t = self.theme_for_post(post).to_string();
            if !names.contains(&t) {
                names.push(t);
            }
        }
        for series in &self.series {
            let t = self.theme_for_series(series).to_string();
            if !names.contains(&t) {
                names.push(t);
            }
        }
        for page in &self.pages {
            let t = self.theme_for_page(page).to_string();
            if !names.contains(&t) {
                names.push(t);
            }
        }
        names
    }

    /// Previous (older) and next (newer) post within the same series.
    pub fn series_neighbors(&self, post_index: usize) -> (Option<&Post>, Option<&Post>) {
        let post = &self.posts[post_index];
        let Some(series) = post.series.as_deref().and_then(|s| self.series_by_slug(s)) else {
            return (None, None);
        };
        let Some(pos) = series.posts.iter().position(|&i| i == post_index) else {
            return (None, None);
        };
        let prev = pos.checked_sub(1).map(|p| &self.posts[series.posts[p]]);
        let next = series.posts.get(pos + 1).map(|&i| &self.posts[i]);
        (prev, next)
    }

    /// Everyone credited as an author on any published part of the series, once each, in the
    /// order they first appear reading the series from its first part (ADR 0038). Derived from
    /// the posts' resolved work credits at read time and never stored, so a changed credit
    /// changes the answer and a removed one cannot linger. Secondary contributors are not
    /// included. One person is listed once even when credited under two ids: a legacy post's
    /// default site-author credit and the owner's registry credit on a shared reflection are the
    /// same person when their names match (and their profile URLs, when both have one). Two
    /// distinct registry ids are always two people, whatever their names (ADR 0040).
    pub fn series_contributors(&self, series: &Series) -> Vec<&crate::contributor::ResolvedCredit> {
        self.contributors_among(series.posts.iter().copied())
    }

    fn contributors_among(
        &self,
        parts: impl Iterator<Item = usize>,
    ) -> Vec<&crate::contributor::ResolvedCredit> {
        let mut out: Vec<&crate::contributor::ResolvedCredit> = Vec::new();
        for index in parts {
            for credit in self.posts[index].authors() {
                if !out.iter().any(|known| same_person(known, credit)) {
                    out.push(credit);
                }
            }
        }
        out
    }

    /// The public series context feeds and portable copies carry for `post` (ADR 0041): only
    /// when the post is a published part of a collaborative series, and `None` otherwise, so
    /// every other post's feed items and portable copies stay exactly as they were. Drafts and
    /// scheduled posts (dated after the time the site was loaded for) are not parts here, even
    /// on a site that holds them because it was loaded with drafts or to preview one, so they
    /// neither get a context nor count towards another part's position, total or contributors.
    /// Any site loaded at the same time therefore gives a post the same context. Everything in it
    /// is already public on the series page: the series name and URL, the part's place in the
    /// reading order, and author names from approved work credits. It reads no collaboration
    /// state.
    pub fn series_context(&self, post: &Post) -> Option<SeriesContext> {
        if !self.is_public_part(post) {
            return None;
        }
        let series = self.series_by_slug(post.series.as_deref()?)?;
        let parts: Vec<usize> = series
            .posts
            .iter()
            .copied()
            .filter(|&index| self.is_public_part(&self.posts[index]))
            .collect();
        let position = parts
            .iter()
            .position(|&index| self.posts[index].source == post.source)?;
        if !parts
            .iter()
            .any(|&index| self.posts[index].is_collaborative())
        {
            return None;
        }
        let names = |credits: Vec<&crate::contributor::ResolvedCredit>| {
            credits
                .into_iter()
                .map(|credit| credit.contributor.name.trim().to_string())
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
        };
        Some(SeriesContext {
            name: series.name.clone(),
            url: series.url.clone(),
            part: position + 1,
            parts: parts.len(),
            part_authors: names(self.posts[parts[position]].authors().collect()),
            contributors: names(self.contributors_among(parts.iter().copied())),
        })
    }

    /// Whether `post` is public on this site's production pages: neither a draft nor dated after
    /// the time the site was loaded for. Unlike membership of `posts`, this holds even when a
    /// preview or Admin load included drafts.
    pub fn is_published(&self, post: &Post) -> bool {
        self.is_public_part(post)
    }

    fn is_public_part(&self, post: &Post) -> bool {
        !post.draft && self.now.is_none_or(|now| post.date <= now)
    }

    /// Whether the series names its parts' authors on its page and in its navigation: only when
    /// one of its published parts is a collaborative work (ADR 0040). Drafts and scheduled posts
    /// are not parts, so they never switch it on, and a series without a collaborative part
    /// renders exactly as before.
    pub fn series_is_collaborative(&self, series: &Series) -> bool {
        series
            .posts
            .iter()
            .any(|&index| self.posts[index].is_collaborative())
    }

    /// When the next scheduled post becomes public, if any.
    pub fn next_scheduled(&self) -> Option<DateTime> {
        self.scheduled.first().map(|s| s.date)
    }

    /// Posts most related to `index`: shared tags count double, the same series
    /// counts most, and ties go to newer posts. Only posts with some overlap
    /// are returned, so unrelated posts never pad the list.
    pub fn related(&self, index: usize, limit: usize) -> Vec<usize> {
        if limit == 0 {
            return Vec::new();
        }
        let post = &self.posts[index];
        let mut scored: Vec<(u32, usize)> = self
            .posts
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != index)
            .map(|(i, other)| {
                let shared_tags = other
                    .tags
                    .iter()
                    .filter(|t| post.tags.iter().any(|p| p.slug == t.slug))
                    .count() as u32;
                let same_series = u32::from(post.series.is_some() && post.series == other.series);
                (shared_tags * 2 + same_series * 3, i)
            })
            .filter(|(score, _)| *score > 0)
            .collect();
        // `posts` is newest first, so a smaller index is newer.
        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        scored.into_iter().take(limit).map(|(_, i)| i).collect()
    }

    pub fn latest_update(&self) -> Option<DateTime> {
        self.posts.iter().map(|p| p.updated.unwrap_or(p.date)).max()
    }
}

/// Whether two author credits name the same person for a series' contributor list. The same id
/// always does. A legacy site-author credit matches a registry credit with the same name when
/// their profile URLs agree or either has none. Two distinct registry ids never match: the
/// registry is where people are told apart, so two entries are two people even when they share a
/// name, or a name and a URL.
fn same_person(
    a: &crate::contributor::ResolvedCredit,
    b: &crate::contributor::ResolvedCredit,
) -> bool {
    use crate::contributor::SITE_AUTHOR_ID;
    if a.contributor_id == b.contributor_id {
        return true;
    }
    if a.contributor_id != SITE_AUTHOR_ID && b.contributor_id != SITE_AUTHOR_ID {
        return false;
    }
    let (a_url, b_url) = (a.contributor.url.trim(), b.contributor.url.trim());
    a.contributor.name.trim() == b.contributor.name.trim()
        && (a_url == b_url || a_url.is_empty() || b_url.is_empty())
}

fn seo_warnings(post: &Post) -> Vec<String> {
    let mut warnings = Vec::new();
    let title_len = post.title.chars().count();
    let description_len = post.description.chars().count();
    if title_len > 70 {
        warnings.push(format!(
            "{}: title is {title_len} characters; consider a more concise, descriptive search title",
            post.source
        ));
    }
    if let Some(subtitle_len) = post.subtitle.as_ref().map(|s| s.chars().count()) {
        if subtitle_len > 160 {
            warnings.push(format!(
                "{}: subtitle is {subtitle_len} characters; keep it to a short line under the title",
                post.source
            ));
        }
    }
    if description_len < 50 {
        warnings.push(format!(
            "{}: description is only {description_len} characters; summarize the answer and why it is useful",
            post.source
        ));
    } else if description_len > 180 {
        warnings.push(format!(
            "{}: description is {description_len} characters; search and social previews may truncate it",
            post.source
        ));
    }
    if post.cover.is_some() && post.cover_alt.trim().is_empty() {
        warnings.push(format!(
            "{}: cover image has no `coverAlt`; describe the meaningful image content",
            post.source
        ));
    }
    if post.tags.is_empty() {
        warnings.push(format!(
            "{}: post has no tags; add at least one specific topic",
            post.source
        ));
    }
    if !post.text.trim().is_empty()
        && !post
            .headings
            .iter()
            .any(|heading| matches!(heading.level, 2 | 3))
    {
        warnings.push(format!(
            "{}: post has no H2 or H3 sections; use descriptive headings when the article covers multiple ideas",
            post.source
        ));
    }
    warnings
}

fn is_draft(fm: &FrontMatter) -> bool {
    fm.get_bool("draft").unwrap_or(false)
        || first(fm, &["status"]).is_some_and(|s| s.eq_ignore_ascii_case("draft"))
}

/// The file line of the first citation that would stop `source` publishing
/// against `library`, for a post that is not a draft and opts in to
/// citations; `None` for any other post or when every citation resolves.
/// The source library uses it to refuse an edit that would make a published
/// post's citations fail (ADR 0049). It reads nothing but its inputs.
pub fn uncitable_line(source: &str, library: &SourceLibrary) -> Option<usize> {
    let doc = frontmatter::parse(source).ok()?;
    let fm = &doc.front_matter;
    if is_draft(fm) {
        return None;
    }
    CitationStyle::from_front_matter(first(fm, &["citations"])).ok()??;
    let file_line = |line: Option<usize>| line.unwrap_or(1) + doc.body_line.max(1) - 1;
    let scan = crate::citations::scan_citations(&doc.body);
    if let Some(found) = scan.diagnostics.first() {
        return Some(file_line(found.line));
    }
    crate::citations::resolve_citations(&scan.mentions, library)
        .diagnostics
        .first()
        .map(|found| file_line(found.line))
}

/// Give each post the approved reader notes its canonical page shows (ADR
/// 0083), or say why the file cannot be read. A note is shown only where its
/// kind's site and post mode shows approved items (ADR 0101), so a post that
/// hides a kind shows none of it, while a site without its hosted service
/// keeps showing what it published; a note about a post that no longer exists
/// is a warning, and one about a draft or scheduled post waits for it.
fn attach_reader_feedback(
    posts: &mut [Post],
    sources: &Sources,
    config: &SiteConfig,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let file = sources.reader_feedback.as_ref()?;
    let published = match crate::feedback_publication::ReaderFeedbackFile::from_json(&file.contents)
    {
        Ok(published) => published,
        Err(error) => return Some(format!("{}: {error}", file.path)),
    };
    let known: std::collections::HashSet<String> = sources
        .posts
        .iter()
        .map(|post| post.path.replace('\\', "/"))
        .collect();
    for (index, item) in published.items.iter().enumerate() {
        if !known.contains(&item.post) {
            warnings.push(format!(
                "{}: item {} is about {}, which is not a post; it is not published",
                file.path,
                index + 1,
                item.post
            ));
        }
    }
    for post in posts.iter_mut() {
        let mut items = published.for_post(&post.source.replace('\\', "/"));
        items.retain(|item| {
            crate::participation::published_mode(config, post, item.kind.participation_kind())
                .shows_approved()
        });
        if items.is_empty() {
            continue;
        }
        let document = crate::passage_target::PassageDocument::of_post(post, config);
        // A suggestion the author has not decided reads as unresolved only where the
        // site takes evidence submissions (ADR 0119): any other site's page is as before.
        post.reader_feedback = crate::feedback_publication::project(
            &items,
            post,
            &document,
            config.engagement.evidence,
        );
        // Portable copies and feeds carry a labelled link to the canonical
        // page instead of the notes (P6.2).
        post.capabilities.push(CapabilityDescriptor::describe(
            "passage-questions-and-corrections",
            Some(crate::feedback_publication::READER_FEEDBACK_ANCHOR),
        ));
    }
    None
}

/// Give each post the approved Third Perspectives its canonical page shows
/// (ADR 0115), or say why the file cannot be read. Each is re-read through
/// the one public projection against the post as published now, and only
/// where RD12's published mode for the kind shows approved items, so a site
/// without its hosted service keeps showing what was approved while a post
/// that hides the kind shows none. A record about a post that no longer
/// exists, or about an address the post no longer has, is a warning and is
/// not shown; one about a draft or scheduled post waits for it. A post that
/// shows Third Perspectives, or offers the form for them, carries a labelled
/// link to its canonical page in portable copies and feeds instead (P6.2).
fn attach_third_perspectives(
    posts: &mut [Post],
    sources: &Sources,
    config: &SiteConfig,
    warnings: &mut Vec<String>,
) -> Option<String> {
    use crate::participation::{ParticipationKind, ParticipationMode};
    use crate::perspective_publication as publication;
    let published = match &sources.third_perspectives {
        None => None,
        Some(file) => match publication::ThirdPerspectivesFile::from_json(&file.contents) {
            Ok(published) => Some((file.path.as_str(), published)),
            Err(error) => return Some(format!("{}: {error}", file.path)),
        },
    };
    if let Some((path, published)) = &published {
        let known: std::collections::HashSet<String> = sources
            .posts
            .iter()
            .map(|post| post.path.replace('\\', "/"))
            .collect();
        for (index, item) in published.items.iter().enumerate() {
            if !known.contains(&item.post) {
                warnings.push(format!(
                    "{path}: item {} is about {}, which is not a post; it is not published",
                    index + 1,
                    item.post
                ));
            }
        }
    }
    for post in posts.iter_mut() {
        let kind = ParticipationKind::ThirdPerspective;
        if let Some((path, published)) = &published {
            let items = published.for_post(&post.source.replace('\\', "/"));
            let mode = crate::participation::published_mode(config, post, kind);
            if !items.is_empty() && mode.shows_approved() {
                for item in items.iter().filter(|item| item.work != post.url) {
                    warnings.push(format!(
                        "{path}: Third Perspective {} is about {}, but {} is now published at {}; it is not shown",
                        item.id, item.work, item.post, post.url
                    ));
                }
                let answer_mode = crate::participation::published_mode(
                    config,
                    post,
                    ParticipationKind::AuthorResponse,
                );
                post.third_perspectives =
                    publication::project_post(&items, post, config, mode, answer_mode);
            }
        }
        let offered =
            crate::participation::effective_mode(config, post, kind) == ParticipationMode::Open;
        if !post.third_perspectives.is_empty() || offered {
            post.capabilities.push(CapabilityDescriptor::describe(
                publication::THIRD_PERSPECTIVES_CAPABILITY,
                // The region's component renders only the form: with reflections to
                // show, the canonical section is plain HTML and has no renderer.
                post.third_perspectives
                    .is_empty()
                    .then_some(crate::render::THIRD_PERSPECTIVE_ANCHOR),
            ));
        }
    }
    None
}

/// Read the site's featured reflections strictly (ADR 0181), or say why the
/// file cannot be read. Nothing is repaired or dropped. A feature is attached
/// to its post only while everything that allowed it still holds, checked
/// against the committed `third-perspectives.json` the page is built from
/// (ADR 0178): a feature that does not stand is absent from the page with no
/// mark of a gap, and is only warned about, naming the id and a fixed reason
/// and never any content. A post whose Third Perspectives are hidden shows no
/// feature. A post without a feature, and a site without the file, are
/// untouched.
/// Reads the site's landing page. A file that does not parse is a warning that
/// names the problem and the site falls back to the `home.*` layout, so a
/// hand edit can never take the site down; a featured post that is not
/// published is a warning too, and that section renders nothing.
fn load_landing(
    sources: &Sources,
    posts: &[Post],
    warnings: &mut Vec<String>,
) -> Option<crate::landing::LandingPage> {
    let file = sources.landing.as_ref()?;
    match crate::landing::LandingPage::parse(&file.contents) {
        Ok(page) => {
            for section in &page.sections {
                if let crate::landing::SectionKind::FeaturedPost(featured) = &section.kind {
                    if !posts.iter().any(|post| post.slug == featured.post) {
                        warnings.push(format!(
                            "{}: section `{}` features `{}`, which is not a published post; it is left out",
                            file.path, section.id, featured.post
                        ));
                    }
                }
            }
            Some(page)
        }
        Err(problems) => {
            let shown: Vec<String> = problems.iter().take(5).map(ToString::to_string).collect();
            warnings.push(format!(
                "{}: not used, the home page is built from the home settings instead ({})",
                file.path,
                shown.join("; ")
            ));
            None
        }
    }
}

fn attach_community_features(
    posts: &mut [Post],
    sources: &Sources,
    config: &SiteConfig,
    warnings: &mut Vec<String>,
) -> Option<String> {
    use crate::community_feature as community;
    use crate::participation::ParticipationKind;
    let file = sources.community_features.as_ref()?;
    let features = match community::FeaturesFile::from_json(&file.contents) {
        Ok(features) => features,
        Err(error) => return Some(format!("{}: {error}", file.path)),
    };
    let known: std::collections::HashSet<String> = sources
        .posts
        .iter()
        .map(|post| post.path.replace('\\', "/"))
        .collect();
    for (index, item) in features.items.iter().enumerate() {
        if !known.contains(&item.post) {
            warnings.push(format!(
                "{}: item {} is about {}, which is not a post; it is not shown",
                file.path,
                index + 1,
                item.post
            ));
        }
    }
    // The reflections the page is built from. A file that cannot be read is
    // already the build's error; no feature is shown without its reflection.
    let published = match &sources.third_perspectives {
        None => crate::perspective_publication::ThirdPerspectivesFile::default(),
        Some(third) => {
            match crate::perspective_publication::ThirdPerspectivesFile::from_json(&third.contents)
            {
                Ok(published) => published,
                Err(_) => return None,
            }
        }
    };
    for post in posts.iter_mut() {
        let records = features.for_post(&post.source.replace('\\', "/"));
        if records.is_empty() {
            continue;
        }
        let mode =
            crate::participation::published_mode(config, post, ParticipationKind::ThirdPerspective);
        if !mode.shows_approved() {
            continue;
        }
        let answer_mode =
            crate::participation::published_mode(config, post, ParticipationKind::AuthorResponse);
        let mut shown = Vec::new();
        for (id, result) in
            community::resolve_post(&records, &published, Some(post), config, mode, answer_mode)
        {
            match result {
                Ok(feature) => shown.push(feature),
                Err(community::NotShown::Off(reason)) => warnings.push(format!(
                    "{}: feature {id} is not shown: {}",
                    file.path,
                    reason.explanation()
                )),
                Err(community::NotShown::Hidden(_)) => {}
            }
        }
        post.community_features = shown;
    }
    None
}

/// The continuation links one post's canonical page shows (ADR 0218): where
/// questions on it went, what it continues, and the titles of the pages they
/// name. Public paths and the editor's own words only.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PostContinuations {
    pub later: Vec<crate::continuation::PublicContinuation>,
    pub earlier: Vec<crate::continuation::PublicContinuation>,
    pub titles: std::collections::BTreeMap<String, String>,
}

/// Read the site's continuation links strictly (ADR 0219), or say why the
/// file cannot be read. An edge is attached only while both pages are
/// published now (a draft or a post waiting for its date is not), through the
/// same `resolve` the rules live in; an edge that does not stand is absent from
/// the page with no placeholder, and is only warned about, naming the id and a
/// fixed reason. The file lists only edges whose origin an Admin approved, and
/// Admin drops an edge when its origin is removed (ADR 0221).
fn attach_continuations(
    posts: &mut [Post],
    sources: &Sources,
    now: Option<DateTime>,
    warnings: &mut Vec<String>,
) -> Option<String> {
    use crate::continuation as cont;
    use std::collections::{BTreeMap, BTreeSet};
    let file = sources.continuations.as_ref()?;
    let edges = match cont::ContinuationsFile::from_json(&file.contents) {
        Ok(edges) => edges,
        Err(error) => return Some(format!("{}: {error}", file.path)),
    };
    let mut published = BTreeSet::new();
    let mut series = BTreeSet::new();
    let mut titles = BTreeMap::new();
    for post in posts.iter() {
        if post.draft || now.is_some_and(|now| post.date > now) {
            continue;
        }
        published.insert(post.url.clone());
        titles.insert(post.url.clone(), post.title.clone());
        if let Some(slug) = &post.series {
            series.insert(slug.clone());
        }
    }
    let aliases = BTreeMap::new();
    let site = cont::Site {
        published: &published,
        series: &series,
        series_aliases: &aliases,
    };
    let mut shown = Vec::new();
    for edge in &edges.items {
        match cont::resolve(edge, cont::OriginStanding::Approved, &site) {
            Ok(item) => shown.push(item),
            Err(hidden) => warnings.push(format!(
                "{}: continuation {} is not shown: {}",
                file.path,
                edge.id,
                hidden.id()
            )),
        }
    }
    if shown.is_empty() {
        return None;
    }
    for post in posts.iter_mut() {
        let later: Vec<_> = shown
            .iter()
            .filter(|e| e.from == post.url)
            .cloned()
            .collect();
        let earlier: Vec<_> = shown.iter().filter(|e| e.to == post.url).cloned().collect();
        if later.is_empty() && earlier.is_empty() {
            continue;
        }
        let mut names = BTreeMap::new();
        for path in later
            .iter()
            .map(|e| &e.to)
            .chain(earlier.iter().map(|e| &e.from))
        {
            if let Some(title) = titles.get(path) {
                names.insert(path.clone(), title.clone());
            }
        }
        post.continuations = PostContinuations {
            later,
            earlier,
            titles: names,
        };
    }
    None
}

/// A post's revision notes as written: each item of the list, or one note
/// written as a single value (which is never split at its commas).
fn revision_items(fm: &FrontMatter) -> Vec<String> {
    match fm.fields.get(crate::claim_publication::REVISIONS_FIELD) {
        Some(frontmatter::Value::List(items)) => items.clone(),
        Some(frontmatter::Value::Scalar(item)) if !item.trim().is_empty() => vec![item.clone()],
        _ => Vec::new(),
    }
}

fn first<'a>(fm: &'a FrontMatter, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| fm.get(k))
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn file_stem(path: &str) -> &str {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name)
}

fn optional_string(value: Option<&str>) -> Option<String> {
    value.map(str::to_string).filter(|v| !v.is_empty())
}

/// Parse the private library for a load, with a message that names the file
/// and how to see the problems, never the library's contents.
fn read_library(
    source: Option<&LibrarySource>,
    config: &SiteConfig,
) -> Result<Option<SourceLibrary>, String> {
    let read;
    let file = match source {
        None => return Ok(None),
        Some(LibrarySource::Text(file)) => file,
        Some(LibrarySource::Deferred(reader)) => {
            read = reader.read().map_err(|reason| {
                format!("the private source library cannot be read ({reason})")
            })?;
            match &read {
                Some(file) => file,
                None => return Ok(None),
            }
        }
    };
    // Builds never output interpretations, so their problems cannot fail one.
    SourceLibrary::parse_for_build(&file.contents, &config.contributors)
        .map(Some)
        .map_err(|problems| {
            format!(
                "the private source library {} has {} problem(s); run `openblog check` to see them",
                file.path,
                problems.len()
            )
        })
}

/// How a post load treats a post that opts in to citations.
enum Citations<'l> {
    /// Keep them as authored text, for callers that read a post's metadata
    /// (listings, publication status) without the private library.
    Unpublished,
    /// Publish them as notes, reading the library on first need.
    Publish(&'l dyn Fn() -> Result<Option<&'l SourceLibrary>, String>),
}

/// Parse one post file. A post that opts in to citations keeps them as
/// authored text here, since this reads no private library; a site load
/// ([`Site::load`]) and [`load_post_cited`] publish them.
pub fn load_post(
    file: &SourceFile,
    config: &SiteConfig,
    options: RenderOptions<'_>,
) -> Result<Post, String> {
    load_post_in(
        file,
        config,
        options,
        Citations::Unpublished,
        ClaimEvidenceMode::Off,
    )
}

/// Parse one post file and publish its citations against `library` exactly
/// as a site load publishes a post it includes: any citation problem refuses
/// the post.
pub fn load_post_cited(
    file: &SourceFile,
    config: &SiteConfig,
    options: RenderOptions<'_>,
    library: Option<&SourceLibrary>,
) -> Result<Post, String> {
    let library = || Ok(library);
    let mut post = load_post_in(
        file,
        config,
        options,
        Citations::Publish(&library),
        ClaimEvidenceMode::Off,
    )?;
    match post.citation_error.take() {
        Some(error) => Err(error),
        None => Ok(post),
    }
}

/// How a post load treats claim evidence (ADR 0075).
#[derive(Clone, Copy)]
enum ClaimEvidenceMode<'e> {
    /// The site does not publish it: the post is read exactly as before.
    Off,
    /// Publish the post's approved claims from this projection (none while
    /// no claims file is stored) and its revision notes.
    Publish(Option<&'e ClaimEvidence>),
}

fn load_post_in(
    file: &SourceFile,
    config: &SiteConfig,
    options: RenderOptions<'_>,
    citations: Citations<'_>,
    claim_evidence: ClaimEvidenceMode<'_>,
) -> Result<Post, String> {
    let doc = frontmatter::parse(&file.contents)?;
    let fm = &doc.front_matter;
    let mut profile = profile::resolve(fm);
    let is_recipe = profile.behavior == ProfileBehavior::Recipe;
    // `readingModes: true`, or `{default: guided}` (ADR 0142).
    let reading_setting =
        crate::reading_depth::setting(fm.get("readingModes").or_else(|| fm.get("reading_modes")));
    // Citations are opt-in (ADR 0043): a post without `citations` is read
    // exactly as before, and so is one that opts in but cites nothing.
    let citation_style = CitationStyle::from_front_matter(first(fm, &["citations"]))?;
    // Claim evidence (ADR 0075): the post's approved claims and the author's
    // revision notes become one section of the publication Markdown, ahead of
    // any citation notes. A post with neither is read exactly as before.
    let mut evidence_error = None;
    let mut claim_section = match claim_evidence {
        ClaimEvidenceMode::Off => None,
        ClaimEvidenceMode::Publish(projection) => {
            match crate::claim_publication::revision_notes(&revision_items(fm)) {
                Err(error) => {
                    evidence_error = Some(error);
                    None
                }
                Ok(notes) => {
                    let slug = first(fm, &["slug"])
                        .map(slugify)
                        .unwrap_or_else(|| from_file_stem(file_stem(&file.path)));
                    let draft = crate::claims::anchor_text(&file.contents).ok();
                    crate::claim_publication::compose(
                        projection,
                        &slug,
                        &config.post_url(&slug),
                        draft.as_deref(),
                        notes,
                    )
                }
            }
        }
    };
    // The section must read back exactly as composed before anything else is
    // added; a post whose body would swallow it publishes no evidence.
    let with_evidence = claim_section.as_mut().and_then(|(section, post_evidence)| {
        let mut markdown = doc.body.clone();
        if !markdown.ends_with('\n') {
            markdown.push('\n');
        }
        markdown.push_str(section);
        match crate::claim_publication::check_section(
            &markdown,
            post_evidence,
            reading_setting.enabled,
        ) {
            Ok(()) => Some(markdown),
            Err(error) => {
                evidence_error = Some(error);
                None
            }
        }
    });
    if with_evidence.is_none() {
        claim_section = None;
    }
    let base = with_evidence.as_deref().unwrap_or(&doc.body);
    let mut citation_error = None;
    let mut citation_findings = Vec::new();
    let mut source_review = Vec::new();
    let published = match (citation_style, citations) {
        (Some(style), Citations::Publish(library)) => {
            citation_findings = crate::citation_review::review_citations(
                &file.path,
                &doc.body,
                doc.body_line,
                library,
            );
            source_review =
                crate::source_review::review_post(&file.path, &doc.body, doc.body_line, library);
            let locale = CitationLocale::for_post(
                first(fm, &["citationLocale", "citation_locale"]),
                &config.language,
            )?;
            // A failure keeps the citations as text and is left to the site
            // load, which knows whether this post is published now.
            match bibliography::publish_citations(
                base,
                doc.body_line,
                style,
                locale,
                reading_setting.enabled,
                library,
            ) {
                Ok(published) => published.map(|published| (published, locale)),
                Err(error) => {
                    citation_error = Some(error);
                    None
                }
            }
        }
        _ => None,
    };
    let mut rendered = markdown::render(
        published
            .as_ref()
            .map_or(base, |(published, _)| &published.markdown),
        RenderOptions {
            recipe: is_recipe,
            citation_notes: published
                .as_ref()
                .map(|(published, locale)| CitationNoteLabels {
                    prefix: &published.prefix,
                    locale: *locale,
                }),
            claim_evidence_section: with_evidence.is_some(),
            concept_links: true,
            // Reading modes are opt-in (ADR 0140): without the key every
            // block quote renders exactly as before.
            supplements: reading_setting.enabled,
            ..options
        },
    );
    if !rendered.errors.is_empty() {
        return Err(rendered.errors.join("; "));
    }
    if let Some(depth) = rendered.reading_depth.as_mut() {
        // The post's own default, else the site's, else standard (ADR 0142).
        depth.default_mode = if reading_setting.default_written {
            reading_setting.default_mode
        } else {
            config.reading_modes.default
        };
        // Each unread marker, and each adjustment, is the author's to see in
        // the build, `check` and Admin warnings (ADR 0142).
        for finding in &depth.findings {
            let marker = finding.marker.trim();
            profile.warnings.push(if marker.is_empty() {
                format!("reading modes: {}", finding.message)
            } else {
                format!("reading modes: `{marker}`: {}", finding.message)
            });
        }
    }
    profile.warnings.extend(reading_setting.warning.clone());
    let recipe = if is_recipe {
        let mut r = Recipe::from_front_matter(
            fm,
            rendered.recipe_ingredients.clone(),
            rendered.recipe_steps.clone(),
        );
        r.anchor = rendered.recipe_anchor.clone();
        Some(r)
    } else {
        None
    };
    let research = (profile.behavior == ProfileBehavior::Research)
        .then(|| ResearchMetadata::from_source(fm, &doc.body, doc.body_line));
    let shared_attribution = SharedAttribution::from_front_matter(fm)?;
    let video =
        (profile.behavior == ProfileBehavior::Video).then(|| VideoMetadata::from_front_matter(fm));
    let field_journal = (profile.behavior == ProfileBehavior::FieldJournal)
        .then(|| FieldJournalMetadata::from_front_matter(fm));
    let job = if profile.behavior == ProfileBehavior::Job {
        match crate::job::from_front_matter(fm, &config.extra_trades) {
            Ok(job) => Some(job),
            // A draft may be unfinished; a published job must be complete.
            Err(problems) if is_draft(fm) => {
                profile.warnings.extend(
                    problems
                        .into_iter()
                        .map(|problem| format!("job not ready to publish: {problem}")),
                );
                None
            }
            Err(problems) => return Err(problems.join("; ")),
        }
    } else {
        None
    };

    let title = match first(fm, &["title"]) {
        Some(t) => t.to_string(),
        None => rendered
            .headings
            .iter()
            .find(|h| h.level == 1)
            .map(|h| h.text.clone())
            .ok_or("post needs a `title` in its front matter (or a leading # heading)")?,
    };
    let slug = first(fm, &["slug"])
        .map(slugify)
        .unwrap_or_else(|| from_file_stem(file_stem(&file.path)));
    if slug.is_empty() {
        return Err("could not derive a slug; add `slug:` to the front matter".into());
    }
    let draft = is_draft(fm);
    let comments = CommentsPolicy::parse(first(fm, &["comments"]))?;
    let participation =
        crate::participation::PostParticipation::parse(&fm.get_list("participation"))?;
    let date = match first(fm, &["date", "published", "publishedAt", "pubDate"]) {
        Some(raw) => DateTime::parse(raw)
            .ok_or_else(|| format!("unrecognised date `{raw}` (use YYYY-MM-DD or RFC 3339)"))?,
        None if draft => DateTime::from_unix(0),
        None => return Err("post needs a `date` (YYYY-MM-DD or RFC 3339)".into()),
    };
    let updated = match first(fm, &["updated", "lastmod", "modified", "updatedAt"]) {
        Some(raw) => {
            Some(DateTime::parse(raw).ok_or_else(|| format!("unrecognised updated date `{raw}`"))?)
        }
        None => None,
    };
    let tags: Vec<TagRef> = {
        let mut seen = Vec::new();
        let mut out = Vec::new();
        for name in fm
            .get_list("tags")
            .into_iter()
            .chain(fm.get_list("categories"))
        {
            let name = name.trim().to_string();
            let tag_slug = crate::slug::limit(&slugify(&name), 64);
            if name.is_empty() || tag_slug.is_empty() || seen.contains(&tag_slug) {
                continue;
            }
            seen.push(tag_slug.clone());
            out.push(TagRef {
                name,
                slug: tag_slug,
            });
        }
        out
    };
    let series = first(fm, &["series"])
        .map(slugify)
        .filter(|s| !s.is_empty());
    let series_order = fm
        .get_u32("seriesOrder")
        .or_else(|| fm.get_u32("series_order"))
        .or_else(|| fm.get_u32("part"));
    let subtitle = first(fm, &["subtitle", "subheading", "dek"])
        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|s| !s.is_empty());
    let description = first(fm, &["description", "summary", "brief", "excerpt"])
        .map(str::to_string)
        .unwrap_or_else(|| markdown::excerpt(&rendered.prose, 180));
    let authored_cover = optional_string(first(fm, &["cover", "image", "coverImage", "hero"]));
    let cover = authored_cover.clone().or(rendered.first_image.clone());
    if let Some(video) = &video {
        if video.url.is_none() {
            profile
                .warnings
                .push("video profile needs a `videoUrl`".to_string());
        } else if video.youtube_id.is_none() {
            profile.warnings.push(
                "video profile `videoUrl` must be a supported YouTube watch, short, or Shorts URL"
                    .to_string(),
            );
        }
        if video.thumbnail.is_none() && cover.is_none() {
            profile.warnings.push(
                "video profile needs a `thumbnail` or `cover` for discovery metadata".to_string(),
            );
        }
        if !video.has_known_production_status() {
            profile.warnings.push(format!(
                "video profile `productionStatus` must be one of: {}",
                crate::video::PRODUCTION_STATUSES.join(", ")
            ));
        }
    }
    let cover_alt = first(fm, &["coverAlt", "imageAlt", "cover_alt"])
        .unwrap_or("")
        .to_string();
    let accessibility = accessibility::audit_document(DocumentAuditInput {
        path: &file.path,
        markdown: &doc.body,
        body_line: doc.body_line,
        embeds_enabled: options.embeds,
        cover_alt: authored_cover.as_ref().map(|_| cover_alt.as_str()),
    });
    let mut evidence = if profile.behavior == ProfileBehavior::Research {
        research::audit_document(&file.path, fm, &doc.body, doc.body_line)
    } else {
        Vec::new()
    };
    // `citations: bibliography` appends the References heading (in the post's
    // locale) to the published text only, so the authored-body audit above
    // must not report it missing.
    if published.is_some() && citation_style == Some(CitationStyle::Bibliography) {
        evidence.retain(|finding| finding.code != research::EvidenceCode::ReferencesMissing);
    }
    evidence.extend(citation_findings);
    let citation_summary = published
        .as_ref()
        .map(|(published, locale)| CitationSummary {
            style: citation_style.unwrap_or(CitationStyle::Notes),
            locale: *locale,
            citations: published.citations,
            notes: published.notes,
            references: published.references.clone(),
            prefix: published.prefix.clone(),
            placements: published.placements.clone(),
        });
    let (credits, credit_provenance) =
        contributor::resolve(&config.author, &config.contributors, None)
            .expect("legacy author resolution cannot fail");
    let mut capabilities = rendered.capabilities;
    if published.is_some() {
        capabilities.push(CapabilityDescriptor::describe(
            "citations",
            Some("ob-citation-notes"),
        ));
    }
    if claim_section.is_some() {
        capabilities.push(CapabilityDescriptor::describe("claim-evidence", None));
    }

    // Concept links (ADR 0172): the page holds each as its label until the
    // build resolves it against the public atlas.
    let (html, concept_html) = if crate::concept_links::has_raw_mark(&rendered.html) {
        (
            crate::concept_links::link_html(&rendered.html, None).html,
            rendered
                .html
                .contains(crate::concept_links::MARK_PREFIX)
                .then(|| rendered.html.clone()),
        )
    } else {
        (rendered.html.clone(), None)
    };
    let portable_markdown = (concept_html.is_some()
        || !rendered.concept_refusals.is_empty()
        || crate::concept_links::has_raw_mark(&rendered.html))
    .then_some(())
    .and_then(|()| {
        crate::concept_links::plain_markdown(
            published
                .as_ref()
                .map_or(base, |(published, _)| &published.markdown),
        )
    });

    Ok(Post {
        url: config.post_url(&slug),
        title,
        subtitle,
        slug,
        date,
        updated,
        tags,
        series,
        series_order,
        cover,
        cover_alt,
        description,
        draft,
        comments,
        participation,
        canonical: optional_string(first(fm, &["canonical", "canonicalUrl", "canonical_url"])),
        source_url: optional_string(first(
            fm,
            &["sourceUrl", "source_url", "hashnodeUrl", "originalUrl"],
        )),
        theme: optional_string(first(fm, &["theme"])),
        aliases: aliases(fm)?,
        authored_markdown: doc.body,
        published_markdown: published
            .map(|(published, _)| published.markdown)
            .or(with_evidence),
        citation_error,
        citations: citation_summary,
        claim_evidence: claim_section.map(|(_, post_evidence)| post_evidence),
        evidence_error,
        reader_feedback: Vec::new(),
        third_perspectives: Vec::new(),
        community_features: Vec::new(),
        continuations: PostContinuations::default(),
        reading_depth: rendered.reading_depth.clone(),
        html,
        concept_html,
        concept_refusals: rendered.concept_refusals.clone(),
        portable_markdown,
        text: rendered.text,
        headings: rendered.headings,
        word_count: rendered.word_count,
        reading_minutes: markdown::reading_minutes(rendered.word_count),
        code_languages: rendered.code_languages,
        credits,
        credit_provenance,
        profile: profile.id,
        profile_warnings: profile.warnings,
        accessibility,
        evidence,
        source_review,
        capabilities,
        recipe,
        research,
        video,
        field_journal,
        job,
        shared_attribution,
        code_highlight: fm
            .get_bool("highlight")
            .or_else(|| fm.get_bool("codeHighlighting")),
        code_line_numbers: fm
            .get_bool("lineNumbers")
            .or_else(|| fm.get_bool("showLineNumbers")),
        source: file.path.clone(),
    })
}

/// Parse one post and resolve its optional adjacent credit sidecar through the
/// same contributor model used by a full site load.
pub fn load_post_with_credits(
    file: &SourceFile,
    config: &SiteConfig,
    options: RenderOptions<'_>,
    sidecar: Option<&SourceFile>,
) -> Result<Post, String> {
    if let Some(sidecar) = sidecar {
        let expected = contributor::sidecar_path(&file.path).ok_or_else(|| {
            format!(
                "post source path `{}` must end in `.md` or `.markdown`",
                file.path
            )
        })?;
        let actual = sidecar.path.replace('\\', "/");
        if actual != expected {
            return Err(format!(
                "credit sidecar `{actual}` does not belong to `{}`; expected `{expected}`",
                file.path
            ));
        }
    }
    let mut post = load_post(file, config, options)?;
    apply_credits(&mut post, config, sidecar)?;
    Ok(post)
}

fn apply_credits(
    post: &mut Post,
    config: &SiteConfig,
    sidecar: Option<&SourceFile>,
) -> Result<(), String> {
    let (credits, provenance) = contributor::resolve(
        &config.author,
        &config.contributors,
        sidecar.map(|source| source.contents.as_str()),
    )?;
    post.credits = credits;
    post.credit_provenance = provenance;
    Ok(())
}

/// The options a page or a series is rendered with: its concept links are
/// marked so they can be replaced by their labels with a warning, never left
/// as an `atlas:` address (ADR 0172).
fn concept_options(options: RenderOptions<'_>) -> RenderOptions<'_> {
    RenderOptions {
        concept_links: true,
        ..options
    }
}

fn load_series(file: &SourceFile, options: RenderOptions<'_>) -> Result<Series, String> {
    let doc = frontmatter::parse(&file.contents)?;
    let fm = &doc.front_matter;
    let rendered = markdown::render(&doc.body, options);
    if !rendered.errors.is_empty() {
        return Err(rendered.errors.join("; "));
    }
    let stem = file_stem(&file.path);
    let slug = first(fm, &["slug"])
        .map(slugify)
        .unwrap_or_else(|| slugify(stem));
    let name = first(fm, &["name", "title"])
        .map(str::to_string)
        .unwrap_or_else(|| humanize(&slug));
    let accessibility = accessibility::audit_document(DocumentAuditInput {
        path: &file.path,
        markdown: &doc.body,
        body_line: doc.body_line,
        embeds_enabled: options.embeds,
        cover_alt: None,
    });
    Ok(Series {
        url: format!("/series/{slug}/"),
        name,
        slug,
        description_html: rendered.html,
        concept_refusals: rendered.concept_refusals,
        description_text: first(fm, &["description"])
            .map(str::to_string)
            .unwrap_or_else(|| markdown::excerpt(&rendered.text, 200)),
        theme: optional_string(first(fm, &["theme"])),
        cover: optional_string(first(fm, &["cover", "image"])),
        order: fm.get_u32("order").unwrap_or(1000),
        posts: Vec::new(),
        source: Some(file.path.clone()),
        accessibility,
        capabilities: rendered.capabilities,
        aliases: aliases(fm)?,
    })
}

fn load_service(file: &SourceFile, options: RenderOptions<'_>) -> Result<Service, String> {
    let doc = frontmatter::parse(&file.contents)?;
    let metadata = crate::service::from_front_matter(&doc.front_matter)
        .map_err(|problems| problems.join("; "))?;
    let rendered = markdown::render(&doc.body, options);
    if !rendered.errors.is_empty() {
        return Err(rendered.errors.join("; "));
    }
    let accessibility = accessibility::audit_document(DocumentAuditInput {
        path: &file.path,
        markdown: &doc.body,
        body_line: doc.body_line,
        embeds_enabled: options.embeds,
        cover_alt: None,
    });
    Ok(Service {
        url: format!("{}{}/", crate::service::SERVICES_URL, metadata.id),
        id: metadata.id,
        name: metadata.name,
        summary: metadata.summary,
        includes: metadata.includes,
        price_band: metadata.price_band,
        typical_timeline: metadata.typical_timeline,
        faq: metadata.faq,
        draft: is_draft(&doc.front_matter),
        html: rendered.html,
        text: rendered.text,
        source: file.path.clone(),
        concept_refusals: rendered.concept_refusals,
        accessibility,
        capabilities: rendered.capabilities,
    })
}

fn load_page(file: &SourceFile, options: RenderOptions<'_>) -> Result<Page, String> {
    let doc = frontmatter::parse(&file.contents)?;
    let fm = &doc.front_matter;
    let rendered = markdown::render(&doc.body, options);
    if !rendered.errors.is_empty() {
        return Err(rendered.errors.join("; "));
    }
    let stem = file_stem(&file.path);
    let slug = first(fm, &["slug"])
        .map(slugify)
        .unwrap_or_else(|| slugify(stem));
    let title = match first(fm, &["title"]) {
        Some(t) => t.to_string(),
        None => rendered
            .headings
            .iter()
            .find(|h| h.level == 1)
            .map(|h| h.text.clone())
            .unwrap_or_else(|| humanize(&slug)),
    };
    let accessibility = accessibility::audit_document(DocumentAuditInput {
        path: &file.path,
        markdown: &doc.body,
        body_line: doc.body_line,
        embeds_enabled: options.embeds,
        cover_alt: None,
    });
    Ok(Page {
        url: format!("/{slug}/"),
        title,
        slug,
        description: first(fm, &["description"])
            .map(str::to_string)
            .unwrap_or_else(|| markdown::excerpt(&rendered.text, 180)),
        html: rendered.html,
        concept_refusals: rendered.concept_refusals,
        text: rendered.text,
        headings: rendered.headings,
        theme: optional_string(first(fm, &["theme"])),
        nav: fm.get_bool("nav").unwrap_or(false),
        aliases: aliases(fm)?,
        source: file.path.clone(),
        accessibility,
        capabilities: rendered.capabilities,
    })
}

/// Normalise `aliases:` (or `redirectFrom:`) to `/path/` form and reject
/// anything that is not a site path.
fn aliases(fm: &FrontMatter) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for raw in fm
        .get_list("aliases")
        .into_iter()
        .chain(fm.get_list("redirectFrom"))
        .chain(fm.get_list("redirect_from"))
    {
        let value = raw.trim();
        if value.is_empty() {
            continue;
        }
        if value.contains("://")
            || value.contains("..")
            || value.contains(['?', '#', '\\'])
            || value.len() > 200
        {
            return Err(format!(
                "alias `{value}` must be a site path like /old-slug/"
            ));
        }
        let trimmed = value.trim_matches('/');
        if trimmed.is_empty() {
            return Err("an alias cannot be the site root".into());
        }
        let normalised = format!("/{trimmed}/");
        if !out.contains(&normalised) {
            out.push(normalised);
        }
    }
    Ok(out)
}

/// `rust-game-dev` -> `Rust Game Dev`
pub fn humanize(slug: &str) -> String {
    slug.split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(path: &str, body: &str) -> SourceFile {
        SourceFile {
            path: path.into(),
            contents: body.into(),
        }
    }

    fn site(sources: Sources) -> Site {
        let config = SiteConfig::from_json(
            r#"{"title":"T","url":"https://t.dev","theme":"base","postPath":"/{slug}/"}"#,
        )
        .unwrap();
        Site::load(config, sources, LoadOptions::default()).unwrap()
    }

    #[test]
    fn loads_posts_series_and_tags() {
        let s = site(Sources {
            posts: vec![
                post("posts/2026-10-21-second.md", "---\ntitle: Second\ndate: 2026-10-21\ntags: [Rust, WASM]\nseries: guide\n---\nBody two"),
                post("posts/first.md", "---\ntitle: First\ndate: 2026-10-01T10:00:00Z\ntags: [rust]\nseries: guide\ncover: /c.png\n---\nBody one"),
                post("posts/draft.md", "---\ntitle: Draft\ndraft: true\n---\nnot yet"),
            ],
            credits: Vec::new(),
            series: vec![post("series/guide.md", "---\nname: The Guide\ntheme: paper\n---\nAbout the guide")],
            pages: vec![post("pages/about.md", "---\ntitle: About\nnav: true\n---\nHi")],
            services: Vec::new(),
            source_library: None,
            claim_evidence: None,
            reader_feedback: None,
            third_perspectives: None,
            community_features: None,
            continuations: None,
            landing: None,
        });
        assert_eq!(s.posts.len(), 2);
        assert_eq!(s.posts[0].slug, "second");
        assert_eq!(s.posts[0].url, "/second/");
        assert_eq!(s.tags[0].name, "Rust");
        assert_eq!(s.tags[0].posts.len(), 2);
        let guide = s.series_by_slug("guide").unwrap();
        assert_eq!(guide.name, "The Guide");
        assert_eq!(guide.posts, vec![1, 0]);
        assert_eq!(guide.cover.as_deref(), Some("/c.png"));
        assert_eq!(s.theme_for_post(&s.posts[0]), "paper");
        assert_eq!(s.used_themes(), vec!["base", "paper"]);
        let (prev, next) = s.series_neighbors(0);
        assert_eq!(prev.unwrap().slug, "first");
        assert!(next.is_none());
        assert!(s.pages[0].nav);
    }

    #[test]
    fn subtitles_are_optional_single_line_and_separate_from_descriptions() {
        let long = "word ".repeat(40);
        let s = site(Sources {
            posts: vec![
                post("posts/a.md", "---\ntitle: A\ndate: 2026-01-01\nsubtitle: \"  A short\\n  line  \"\n---\nBody text"),
                post("posts/b.md", "---\ntitle: B\ndate: 2026-01-02\ndek: From the alias\n---\nx"),
                post("posts/c.md", "---\ntitle: C\ndate: 2026-01-03\nsubheading: Another alias\n---\nx"),
                post("posts/d.md", "---\ntitle: D\ndate: 2026-01-04\nsubtitle: \"  \"\n---\nx"),
                post("posts/e.md", &format!("---\ntitle: E\ndate: 2026-01-05\nsubtitle: {long}\n---\nx")),
            ],
            ..Default::default()
        });
        let by = |slug: &str| s.posts.iter().find(|p| p.slug == slug).unwrap();
        assert_eq!(by("a").subtitle.as_deref(), Some("A short line"));
        assert_eq!(by("a").description, "Body text");
        assert_eq!(by("b").subtitle.as_deref(), Some("From the alias"));
        assert_eq!(by("c").subtitle.as_deref(), Some("Another alias"));
        assert_eq!(by("d").subtitle, None);
        assert!(s
            .warnings
            .iter()
            .any(|w| w.starts_with("posts/e.md: subtitle is 199 characters")));
        assert!(!s
            .warnings
            .iter()
            .any(|w| w.contains("posts/a.md: subtitle")));
    }

    #[test]
    fn posts_pages_and_series_retain_markdown_capabilities() {
        let s = site(Sources {
            posts: vec![post(
                "posts/runnable.md",
                "---\ntitle: Runnable\ndate: 2026-10-01\n---\n```rust runnable\nfn main() {}\n```\n",
            )],
            series: vec![post(
                "series/guide.md",
                "---\nname: Guide\n---\n```web runnable\n---html\n<p>Example</p>\n```\n",
            )],
            pages: vec![post(
                "pages/about.md",
                "---\ntitle: About\n---\n```quiz\nQuestion?\n- [x] Yes\n- [ ] No\n```\n",
            )],
            ..Default::default()
        });
        assert_eq!(s.posts[0].capabilities[0].id, "runnable-code");
        assert_eq!(s.series[0].capabilities[0].id, "web-sandbox");
        assert_eq!(s.pages[0].capabilities[0].id, "knowledge-check");
    }

    #[test]
    fn aliases_are_normalised_and_validated() {
        let s = site(Sources {
            posts: vec![post("posts/a.md", "---\ntitle: A\ndate: 2026-01-01\naliases: [old-a, /2024/03/old-a/, /old-a/]\n---\nx")],
            pages: vec![post("pages/p.md", "---\ntitle: P\nredirectFrom:\n  - /about-me/\n---\nx")],
            ..Default::default()
        });
        assert_eq!(s.posts[0].aliases, vec!["/old-a/", "/2024/03/old-a/"]);
        assert_eq!(s.pages[0].aliases, vec!["/about-me/"]);
        let bad = Site::load(
            SiteConfig::default(),
            Sources { posts: vec![post("posts/b.md", "---\ntitle: B\ndate: 2026-01-01\naliases: [https://elsewhere.example/x]\n---\nx")], ..Default::default() },
            LoadOptions::default(),
        )
        .unwrap_err();
        assert!(bad[0].contains("alias"));
    }

    #[test]
    fn invalid_quizzes_fail_site_validation() {
        let errors = Site::load(
            SiteConfig::default(),
            Sources {
                posts: vec![post(
                    "posts/lesson.md",
                    "---\ntitle: Lesson\ndate: 2026-01-01\n---\n```quiz\nQuestion\n- [ ] A\n- [ ] B\n```\n",
                )],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap_err();
        assert!(
            errors[0].contains("exactly one correct choice"),
            "{errors:?}"
        );
    }

    #[test]
    fn validates_comment_policy_and_video_production_status() {
        let config = SiteConfig::default();
        let invalid_comments = load_post(
            &post(
                "posts/comments.md",
                "---\ntitle: Comments\ndate: 2026-01-01\ncomments: sometimes\n---\nText",
            ),
            &config,
            RenderOptions::default(),
        )
        .unwrap_err();
        assert!(invalid_comments.contains("comments must be"));

        let video = load_post(
            &post(
                "posts/video.md",
                "---\ntitle: Video\ndate: 2026-01-01\nprofile: video\nproductionStatus: waiting-on-magic\n---\nText",
            ),
            &config,
            RenderOptions::default(),
        )
        .unwrap();
        assert!(video
            .profile_warnings
            .iter()
            .any(|warning| warning.contains("productionStatus")));
    }

    #[test]
    fn related_posts_rank_by_series_and_shared_tags() {
        let s = site(Sources {
            posts: vec![
                post(
                    "posts/a.md",
                    "---\ntitle: A\ndate: 2026-04-01\ntags: [rust, wasm]\nseries: s\n---\nx",
                ),
                post(
                    "posts/b.md",
                    "---\ntitle: B\ndate: 2026-03-01\ntags: [rust]\nseries: s\n---\nx",
                ),
                post(
                    "posts/c.md",
                    "---\ntitle: C\ndate: 2026-02-01\ntags: [rust, wasm]\n---\nx",
                ),
                post(
                    "posts/d.md",
                    "---\ntitle: D\ndate: 2026-01-01\ntags: [cooking]\n---\nx",
                ),
                post(
                    "posts/e.md",
                    "---\ntitle: E\ndate: 2025-12-01\ntags: [rust]\n---\nx",
                ),
            ],
            ..Default::default()
        });
        let names = |ids: Vec<usize>| {
            ids.iter()
                .map(|&i| s.posts[i].title.as_str())
                .collect::<Vec<_>>()
        };
        // A: B shares series + rust (5), C shares rust + wasm (4), E shares rust (2); D nothing.
        assert_eq!(names(s.related(0, 10)), vec!["B", "C", "E"]);
        assert_eq!(names(s.related(0, 1)), vec!["B"]);
        assert!(
            s.related(3, 10).is_empty(),
            "no overlap means no related posts"
        );
        assert!(s.related(0, 0).is_empty());
    }

    #[test]
    fn future_dated_posts_are_held_back_until_their_time() {
        let config =
            SiteConfig::from_json(r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#)
                .unwrap();
        let sources = || Sources {
            posts: vec![
                post("posts/now.md", "---\ntitle: Now\ndate: 2026-10-01\n---\nx"),
                post(
                    "posts/later.md",
                    "---\ntitle: Later\ndate: 2026-12-25T09:00:00Z\nseries: s\n---\ny",
                ),
                post(
                    "posts/later2.md",
                    "---\ntitle: Later 2\ndate: 2026-11-30\n---\nz",
                ),
            ],
            series: vec![post("series/s.md", "---\nname: S\n---\nabout")],
            ..Default::default()
        };
        let now = DateTime::parse("2026-10-22T00:00:00Z").unwrap();
        let s = Site::load(
            config.clone(),
            sources(),
            LoadOptions {
                include_drafts: false,
                now: Some(now),
                preview_source: None,
            },
        )
        .unwrap();
        assert_eq!(s.posts.len(), 1);
        assert_eq!(
            s.scheduled
                .iter()
                .map(|x| x.slug.as_str())
                .collect::<Vec<_>>(),
            vec!["later2", "later"]
        );
        assert_eq!(s.next_scheduled().unwrap().ymd(), "2026-11-30");
        assert!(s.series_by_slug("s").unwrap().posts.is_empty());
        // Once the date passes, the same sources publish.
        let later = DateTime::parse("2026-12-26T00:00:00Z").unwrap();
        let s = Site::load(
            config.clone(),
            sources(),
            LoadOptions {
                include_drafts: false,
                now: Some(later),
                preview_source: None,
            },
        )
        .unwrap();
        assert_eq!(s.posts.len(), 3);
        assert!(s.scheduled.is_empty());
        // Previews include everything; no clock means no scheduling.
        let s = Site::load(
            config.clone(),
            sources(),
            LoadOptions {
                include_drafts: true,
                now: Some(now),
                preview_source: None,
            },
        )
        .unwrap();
        assert_eq!(s.posts.len(), 3);
        let s = Site::load(config, sources(), LoadOptions::default()).unwrap();
        assert_eq!(s.posts.len(), 3);
    }

    #[test]
    fn scheduled_posts_still_reserve_their_slug() {
        let config = SiteConfig::default();
        let now = DateTime::parse("2026-10-22").unwrap();
        let err = Site::load(
            config,
            Sources {
                posts: vec![
                    post(
                        "posts/a.md",
                        "---\ntitle: A\nslug: same\ndate: 2030-01-01\n---\nx",
                    ),
                    post(
                        "posts/b.md",
                        "---\ntitle: B\nslug: same\ndate: 2026-01-01\n---\ny",
                    ),
                ],
                ..Default::default()
            },
            LoadOptions {
                include_drafts: false,
                now: Some(now),
                preview_source: None,
            },
        )
        .unwrap_err();
        assert!(err[0].contains("duplicate post slug"));
    }

    #[test]
    fn missing_series_file_is_a_warning_and_errors_are_collected() {
        let s = site(Sources {
            posts: vec![post(
                "posts/a.md",
                "---\ntitle: A\ndate: 2026-01-01\nseries: Mystery Series\n---\nx",
            )],
            ..Default::default()
        });
        assert_eq!(s.series[0].slug, "mystery-series");
        assert_eq!(s.series[0].name, "Mystery Series");
        assert!(s
            .warnings
            .iter()
            .any(|warning| warning.contains("has no content/series")));

        let config = SiteConfig::default();
        let err = Site::load(
            config,
            Sources {
                posts: vec![
                    post("posts/bad.md", "---\ntitle: No date\n---\nx"),
                    post("posts/worse.md", "---\ndate: 2026-01-01\n---\nno title"),
                ],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap_err();
        assert_eq!(err.len(), 2);
    }

    #[test]
    fn published_posts_get_actionable_seo_warnings() {
        let config =
            SiteConfig::from_json(r#"{"author":{"name":"Alex","url":"/about/"}}"#).unwrap();
        let s = Site::load(
            config,
            Sources {
                posts: vec![post(
                    "posts/short.md",
                    "---\ntitle: Short\ndate: 2026-01-01\ncover: /cover.jpg\n---\nTiny.",
                )],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        assert!(s
            .warnings
            .iter()
            .any(|warning| warning.contains("description is only")));
        assert!(s
            .warnings
            .iter()
            .any(|warning| warning.contains("coverAlt")));
    }
}
