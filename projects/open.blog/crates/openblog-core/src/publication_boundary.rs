//! The private-to-public research boundary (#63, ADR 0125).
//!
//! Research is private until a projection publishes it: citations publish
//! the public description of the sources a published post cites (ADR 0048),
//! the Knowledge Atlas its approved entries and relationships (ADR 0058) and
//! their approved datings (ADR 0099), claim evidence the approved claims and
//! links of published posts (ADR 0075), and comparisons the approved
//! alignments (ADR 0092). Each has its own opt-in switch and its own rules.
//!
//! [`BoundaryManifest`] says, for the whole site or for one post, exactly
//! which research items each projection publishes, with the fields it
//! copies, and why every other item is withheld. It is built from the very
//! projection values a build renders (the [`PublicAtlas`] and
//! [`PublicComparisons`] the build writes, and the citations and claim
//! evidence each published post carries), never from a second reading of
//! the rules, so the Admin preview and the build cannot disagree. The
//! private files are read only to name what is withheld and why.
//!
//! [`PrivateText`] is the build's last, systematic guard: it holds the text
//! of every private research file and finds any of it in generated output
//! that no approved projection and no public input accounts for, whatever
//! path the text took. It never reports the text itself, only where it came
//! from.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Serialize;
use serde_json::Value;

use crate::alignment::AlignmentSet;
use crate::atlas_publication::{aspect_noun, PublicAtlas};
use crate::atlas_query::{AtlasQuery, RefusalKind, ATLAS_QUERY_JSON_FILE};
use crate::citations::{public_identifier, public_url_problem, PublicReference};
use crate::claims::{ClaimSet, Relation};
use crate::comparison_publication::{PublicComparisons, Withheld};
use crate::context_links::{find_context_links, ContextKind};
use crate::curated_context::{CuratedContext, PostRef, CURATED_CONTEXT_JSON_FILE};
use crate::curated_selection::{
    ContextKind as CurationContext, ItemNotice, NoticeCode, Resolution, SelectionSet, Why,
};
use crate::knowledge_atlas::{Atlas, Visibility};
use crate::model::Post;
use crate::research_notes::Notebook;
use crate::shingles::{each_output_shingle, each_shingle, Cuts, Form};
use crate::source_library::SourceLibrary;

/// The version of the serialized [`BoundaryManifest`].
pub const BOUNDARY_FORMAT_VERSION: u32 = 1;

/// One way research reaches the public site.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Projection {
    /// The public description of each source a published post cites.
    Citations,
    /// Approved claims and evidence links, in the post they are about.
    ClaimEvidence,
    /// Approved Knowledge Atlas entries and relationships.
    Atlas,
    /// Approved datings of published atlas items.
    Datings,
    /// The bounded query projection derived from the published atlas.
    AtlasQuery,
    /// Approved passage comparisons.
    Comparisons,
    /// Links a post makes to atlas and comparison pages.
    ContextLinks,
    /// The author's curated selection of research context (ADR 0185).
    Curated,
    /// The data file derived from the curated selections, for readers' tools
    /// (ADR 0197).
    CuratedContext,
    /// The author's reading paths: their pages, `paths.json`, search entries
    /// and the links to them from posts and atlas pages (ADR 0216).
    ReadingPaths,
    /// The author's interpretation comparisons: their pages and the
    /// interpretations and audience explanations on them (ADR 0232).
    Interpretations,
}

impl Projection {
    /// The switch that turns the projection on: a front matter key for
    /// citations, an `openblog.json` key for the others.
    pub fn switch(self) -> &'static str {
        match self {
            Self::Citations => "citations",
            Self::ClaimEvidence => "claimEvidence.publish",
            Self::Atlas | Self::Datings | Self::AtlasQuery => "knowledgeAtlas.publish",
            Self::Comparisons => "comparisons.publish",
            Self::ContextLinks => "knowledgeAtlas.publish, comparisons.publish",
            Self::Curated | Self::CuratedContext => "curatedContext.publish",
            Self::ReadingPaths => "readingPaths.publish",
            Self::Interpretations => "interpretations.publish",
        }
    }
}

/// What kind of research item an entry of the manifest names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ItemKind {
    Source,
    Claim,
    EvidenceLink,
    Entry,
    Relationship,
    Dating,
    Comparison,
    /// The atlas query file as a whole, when it is withheld.
    AtlasQuery,
    /// A link in a post to an atlas entry's page.
    AtlasPage,
    /// A link in a post to a comparison's page.
    ComparisonPage,
    /// One curated selection.
    Selection,
    /// The curated context file as a whole: listed when it is written, and
    /// withheld whole when it is not.
    CuratedContext,
    /// One published reading path.
    Path,
    /// One published interpretation comparison.
    Interpretation,
}

/// Why an item, or one field of a published item, is withheld. Each is a
/// rule of the projection that withholds it; none is a judgement of the
/// research.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    /// The site does not publish this projection.
    ProjectionOff,
    /// The author has not approved it: it is private research.
    NotApproved,
    /// An unsourced draft, which is never published.
    Unsourced,
    /// It rests on a notebook passage, which is never published.
    NotebookPassage,
    /// Something it depends on is not published.
    PrivateDependency,
    /// Support stays private while contradicting evidence on the claim is private.
    ContradictionWithheld,
    /// The post it belongs to is not published by this build.
    PostNotPublished,
    /// Approved before what it rests on changed, so the approval no longer holds.
    StaleApproval,
    /// A web address the boundary withholds.
    UnsafeUrl,
    /// An identifier in a scheme or form that is never published.
    PrivateIdentifier,
    /// Wording the version's rights statement does not let the site show.
    Rights,
    /// Wording longer than a brief excerpt.
    Length,
    /// The words a claim was anchored to are no longer exactly there.
    StaleAnchor,
    /// The page a link names is not published.
    PageNotPublished,
    /// The author withdrew the selection.
    Withdrawn,
    /// Selected before what it selects, or something it depends on, changed.
    StaleSelection,
    /// What the selection selects no longer exists.
    MissingTarget,
    /// The selections it requires lead back to it.
    SelectionCycle,
    /// Over a published size or count bound, so the file is left out whole.
    OverLimit,
    /// The published projection does not agree with itself, so a file derived
    /// from it is left out whole rather than written with a gap.
    Inconsistent,
}

/// One field of a published item that is left out, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WithheldField {
    pub field: String,
    pub reason: Reason,
    pub message: String,
}

/// One research item a projection publishes, with the fields it copies.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedItem {
    pub kind: ItemKind,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The posts it is published with or cited by, by slug.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub posts: Vec<String>,
    /// Its public address, root-relative, when it has a page of its own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The fields the projection copies, in the projection's own names.
    pub fields: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub withheld_fields: Vec<WithheldField>,
    /// Caveats on a curated item that are not a withheld field: a competing
    /// dating that is not selected, a detail the source lacks, metadata
    /// whose origin is not recorded. Only the curated projection has any.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notices: Vec<ItemNotice>,
}

/// One research item a projection could publish but withholds, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WithheldItem {
    pub kind: ItemKind,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub posts: Vec<String>,
    pub reason: Reason,
    /// One sentence naming ids and fields only.
    pub message: String,
    /// For a dating, the atlas item it dates (`entry` or `relationship`) and
    /// its id, so the preview can link to where the dating is changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<ItemOwner>,
}

/// The atlas item a dating belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ItemOwner {
    pub kind: &'static str,
    pub id: String,
}

/// What one projection publishes and withholds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionReport {
    pub projection: Projection,
    pub switch: &'static str,
    pub enabled: bool,
    /// Why nothing can be said about it: a private file it reads cannot be
    /// read, so the build refuses until it is repaired.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
    pub published: Vec<PublishedItem>,
    pub withheld: Vec<WithheldItem>,
}

/// A private research file, by what it holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Store {
    SourceLibrary,
    Notebook,
    Atlas,
    Claims,
    Alignments,
    Acknowledgements,
    Selections,
}

impl Store {
    /// The file, relative to the project root.
    pub fn file(self) -> &'static str {
        match self {
            Self::SourceLibrary => ".openblog/private/research/sources.json",
            Self::Notebook => ".openblog/private/research/notebook.json",
            Self::Atlas => ".openblog/private/research/atlas.json",
            Self::Claims => ".openblog/private/research/claims.json",
            Self::Alignments => ".openblog/private/research/alignments.json",
            Self::Acknowledgements => ".openblog/private/research/acknowledgements.json",
            Self::Selections => crate::curated_selection::SELECTIONS_FILE,
        }
    }

    /// How the file is named in a sentence.
    pub fn name(self) -> &'static str {
        match self {
            Self::SourceLibrary => "the source library",
            Self::Notebook => "the research notebook",
            Self::Atlas => "the Knowledge Atlas",
            Self::Claims => "the claims file",
            Self::Alignments => "the alignments file",
            Self::Acknowledgements => "the review acknowledgements",
            Self::Selections => "the curated selections",
        }
    }

    pub const ALL: [Store; 7] = [
        Self::SourceLibrary,
        Self::Notebook,
        Self::Atlas,
        Self::Claims,
        Self::Alignments,
        Self::Acknowledgements,
        Self::Selections,
    ];
}

/// Research no projection ever publishes, by file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NeverPublished {
    pub store: Store,
    pub file: &'static str,
    /// How many records of the file it covers.
    pub count: usize,
    pub what: String,
}

/// A private file the manifest could not read; what depends on it says so.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Unavailable {
    pub store: Store,
    pub file: &'static str,
    pub message: String,
}

/// Whether the manifest covers the whole site or one post.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Scope {
    Site,
    Post { path: String, slug: String },
}

/// Exactly what the research projections publish, and why the rest is withheld.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryManifest {
    pub version: u32,
    pub scope: Scope,
    pub projections: Vec<ProjectionReport>,
    pub never: Vec<NeverPublished>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unavailable: Vec<Unavailable>,
    /// Public files that hold text a private research file also holds, as the
    /// `boundary:` warnings a build prints (ADR 0125). Filled by the caller
    /// that scanned the output; empty for a site without private research.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub text_matches: Vec<String>,
}

/// The switches of the projections, as the site configuration sets them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Switches {
    pub atlas: bool,
    pub comparisons: bool,
    pub claim_evidence: bool,
    pub curated: bool,
    pub reading_paths: bool,
    pub interpretations: bool,
}

impl Switches {
    pub fn of(config: &crate::config::SiteConfig) -> Self {
        Self {
            atlas: config.knowledge_atlas.publish,
            comparisons: config.comparisons.publish,
            claim_evidence: config.claim_evidence.publish,
            curated: config.curated_context.publish,
            reading_paths: config.reading_paths.publish,
            interpretations: config.interpretations.publish,
        }
    }
}

/// What the manifest is built from: the projections exactly as the build
/// holds them, and the private files, read only to explain what is withheld.
#[derive(Clone, Copy)]
pub struct BoundaryInputs<'a> {
    pub switches: Switches,
    /// The posts this build publishes, each with the citations and claim
    /// evidence the load gave it.
    pub posts: &'a [Post],
    /// The atlas projection the build renders, while it publishes the atlas.
    pub public_atlas: Option<&'a PublicAtlas>,
    /// Why the atlas projection could not be built, when it could not.
    pub atlas_blocked: Option<&'a str>,
    /// The comparison projection the build renders.
    pub public_comparisons: Option<&'a PublicComparisons>,
    pub comparisons_blocked: Option<&'a str>,
    /// The reading paths the build renders, while it publishes them.
    pub public_paths: Option<&'a crate::reading_path::PublicPaths>,
    /// The interpretation comparisons the build renders, while it publishes
    /// them.
    pub public_interpretations:
        Option<&'a crate::interpretation_publication::PublicInterpretations>,
    /// Why claim evidence could not be read for the build, when it could not.
    pub claims_blocked: Option<&'a str>,
    pub library: Option<&'a SourceLibrary>,
    pub notebook: Option<&'a Notebook>,
    pub atlas: Option<&'a Atlas>,
    pub claims: Option<&'a ClaimSet>,
    pub alignments: Option<&'a AlignmentSet>,
    /// Stale approvals of approved alignments, by id (`stale_approvals`).
    pub stale_comparisons: Option<&'a BTreeMap<String, String>>,
    pub acknowledgements: Option<usize>,
    /// The curated selections resolved against what the build publishes.
    pub curation: Option<&'a CurationInput<'a>>,
    pub unavailable: &'a [Unavailable],
    /// The site author's public name, which words an author-asserted
    /// position in the atlas query file as the atlas pages do.
    pub author: &'a str,
    /// The site's base path (`""` or `"/blog"`), put in front of every
    /// root-relative address in a published data file.
    pub base_path: &'a str,
}

/// The curated selections as the manifest reads them.
pub struct CurationInput<'a> {
    pub set: &'a SelectionSet,
    pub resolution: &'a Resolution,
}

fn present(fields: &mut Vec<String>, name: &str, present: bool) {
    if present {
        fields.push(name.to_string());
    }
}

/// The fields a public reference copies, and the identifiers of its record
/// the boundary withholds.
fn source_item(
    reference: &PublicReference,
    library: Option<&SourceLibrary>,
    posts: Vec<String>,
) -> PublishedItem {
    let mut fields = vec!["kind".to_string()];
    present(&mut fields, "title", reference.title.is_some());
    present(&mut fields, "creators", !reference.creators.is_empty());
    present(&mut fields, "issued", reference.issued.is_some());
    present(&mut fields, "language", reference.language.is_some());
    for (scheme, _) in &reference.identifiers {
        fields.push(format!("identifiers.{scheme}"));
    }
    for name in reference.csl.keys() {
        fields.push(format!("csl.{name}"));
    }
    let mut withheld_fields = Vec::new();
    if let Some(record) = library.and_then(|library| library.get(&reference.key)) {
        for identifier in &record.identifiers {
            let field = format!("identifiers.{}", identifier.scheme);
            if !public_identifier(&identifier.scheme, &identifier.value) {
                withheld_fields.push(WithheldField {
                    field,
                    reason: Reason::PrivateIdentifier,
                    message: format!(
                        "Source `{}`: its `{}` identifier is not in a public scheme or standard form, so it stays private.",
                        reference.key, identifier.scheme
                    ),
                });
            } else if identifier.scheme == "url" {
                if let Some(problem) = public_url_problem(&identifier.value) {
                    withheld_fields.push(WithheldField {
                        field,
                        reason: Reason::UnsafeUrl,
                        message: format!(
                            "Source `{}`: its web address is withheld because {problem}.",
                            reference.key
                        ),
                    });
                }
            }
        }
    }
    PublishedItem {
        kind: ItemKind::Source,
        id: reference.key.clone(),
        label: reference.title.clone(),
        posts,
        url: None,
        fields,
        withheld_fields,
        notices: Vec::new(),
    }
}

fn sources_of<'r>(
    references: impl Iterator<Item = (&'r PublicReference, Option<&'r str>)>,
    library: Option<&SourceLibrary>,
) -> Vec<PublishedItem> {
    let mut by_id: BTreeMap<&str, (&PublicReference, BTreeSet<String>)> = BTreeMap::new();
    for (reference, post) in references {
        let entry = by_id
            .entry(reference.key.as_str())
            .or_insert_with(|| (reference, BTreeSet::new()));
        if let Some(post) = post {
            entry.1.insert(post.to_string());
        }
    }
    by_id
        .into_values()
        .map(|(reference, posts)| source_item(reference, library, posts.into_iter().collect()))
        .collect()
}

fn report(projection: Projection, enabled: bool) -> ProjectionReport {
    ProjectionReport {
        projection,
        switch: projection.switch(),
        enabled,
        blocked: None,
        published: Vec::new(),
        withheld: Vec::new(),
    }
}

fn withheld(kind: ItemKind, id: &str, reason: Reason, message: String) -> WithheldItem {
    WithheldItem {
        kind,
        id: id.to_string(),
        label: None,
        posts: Vec::new(),
        reason,
        message,
        owner: None,
    }
}

fn off_message(projection: Projection) -> String {
    format!(
        "The site does not publish this; `{}` is off, so nothing here reaches the public site.",
        projection.switch()
    )
}

impl BoundaryManifest {
    /// The manifest of the whole site.
    pub fn site(inputs: &BoundaryInputs<'_>) -> Self {
        let slugs: BTreeSet<&str> = inputs.posts.iter().map(|p| p.slug.as_str()).collect();
        let projections = vec![
            citations(inputs, inputs.posts.iter().collect()),
            claim_evidence(inputs, inputs.posts.iter().collect(), &slugs, None),
            atlas(inputs),
            datings(inputs),
            atlas_query(inputs),
            comparisons(inputs),
        ];
        let mut projections = projections;
        // Absent while the switch is off, whatever the selections file
        // holds, so a site that does not curate is described exactly as before.
        if inputs.switches.curated {
            projections.push(curated(inputs, None));
            projections.push(curated_context(inputs));
        }
        // Absent while the switch is off, so every other site is described
        // exactly as before.
        if inputs.switches.reading_paths {
            projections.push(reading_paths(inputs));
        }
        // Likewise absent while the interpretation switch is off.
        if inputs.switches.interpretations {
            projections.push(interpretations(inputs));
        }
        Self {
            version: BOUNDARY_FORMAT_VERSION,
            scope: Scope::Site,
            projections,
            never: never(inputs),
            unavailable: inputs.unavailable.to_vec(),
            text_matches: Vec::new(),
        }
    }

    /// The manifest of one post: its citations, its claim evidence and the
    /// atlas and comparison pages it links to. `post` must be one of
    /// `inputs.posts`, or the post previewed beside them.
    pub fn post(inputs: &BoundaryInputs<'_>, post: &Post) -> Self {
        let mut slugs: BTreeSet<&str> = inputs.posts.iter().map(|p| p.slug.as_str()).collect();
        slugs.insert(post.slug.as_str());
        let mut projections = vec![
            citations(inputs, vec![post]),
            claim_evidence(inputs, vec![post], &slugs, Some(post.slug.as_str())),
            context_links(inputs, post),
        ];
        // The selections this post is offered, only while the site curates.
        if inputs.switches.curated {
            projections.push(curated(inputs, Some(post.slug.as_str())));
        }
        Self {
            version: BOUNDARY_FORMAT_VERSION,
            scope: Scope::Post {
                path: post.source.clone(),
                slug: post.slug.clone(),
            },
            projections,
            never: never(inputs),
            unavailable: inputs.unavailable.to_vec(),
            text_matches: Vec::new(),
        }
    }

    /// The precise diagnostics the build prints for what the boundary newly
    /// withholds: a stale approval or an unsafe web address. Each names its
    /// projection, its object and its field; none repeats private text.
    pub fn build_warnings(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        for report in &self.projections {
            for item in &report.withheld {
                if matches!(
                    item.reason,
                    Reason::StaleApproval
                        | Reason::StaleSelection
                        | Reason::OverLimit
                        | Reason::Inconsistent
                ) {
                    warnings.push(format!("boundary: {}", item.message));
                }
            }
            // A selected dating whose competitors are published but not
            // selected shows readers one side of a disagreement.
            for item in &report.published {
                for notice in &item.notices {
                    if notice.code == NoticeCode::CompetingUnselected {
                        warnings.push(format!("boundary: {}", notice.message));
                    }
                }
            }
            for item in &report.published {
                for field in &item.withheld_fields {
                    if field.reason == Reason::UnsafeUrl {
                        warnings.push(format!("boundary: {}", field.message));
                    }
                }
            }
        }
        warnings.sort();
        warnings.dedup();
        warnings
    }

    /// One line for `openblog build`: how many research items each
    /// projection published and how many were withheld, or `None` when no
    /// projection published or withheld anything (a site without research
    /// prints exactly what it printed before).
    pub fn summary(&self) -> Option<String> {
        let mut parts = Vec::new();
        let mut withheld = 0;
        for report in &self.projections {
            withheld += report.withheld.len();
            let count = report
                .published
                .iter()
                .filter(|item| {
                    item.kind != ItemKind::Source || report.projection == Projection::Citations
                })
                .filter(|item| {
                    report.projection != Projection::Curated || item.kind == ItemKind::Selection
                })
                .count();
            if count > 0 {
                let name = match report.projection {
                    Projection::Citations => "cited sources",
                    Projection::ClaimEvidence => "claims and evidence links",
                    Projection::Atlas => "atlas entries and relationships",
                    Projection::Datings => "datings",
                    // The query file repeats what the atlas already counts.
                    Projection::AtlasQuery => continue,
                    Projection::Comparisons => "comparisons",
                    Projection::ContextLinks => "linked research pages",
                    Projection::Curated => "curated selections",
                    // The data file repeats what the selections already count.
                    Projection::CuratedContext => continue,
                    Projection::ReadingPaths => "reading paths",
                    Projection::Interpretations => "interpretation comparisons",
                };
                parts.push(format!("{count} {name}"));
            }
        }
        if parts.is_empty() && withheld == 0 {
            return None;
        }
        Some(format!(
            "Research published: {}; {withheld} item{} withheld. Admin's What will be public says which and why.",
            if parts.is_empty() {
                "nothing".to_string()
            } else {
                parts.join(", ")
            },
            if withheld == 1 { "" } else { "s" }
        ))
    }

    /// The ids one projection publishes, of one kind.
    pub fn published_ids(&self, projection: Projection, kind: ItemKind) -> BTreeSet<&str> {
        self.projections
            .iter()
            .filter(|report| report.projection == projection)
            .flat_map(|report| &report.published)
            .filter(|item| item.kind == kind)
            .map(|item| item.id.as_str())
            .collect()
    }
}

fn citations(inputs: &BoundaryInputs<'_>, posts: Vec<&Post>) -> ProjectionReport {
    let mut report = report(Projection::Citations, true);
    report.published = sources_of(
        posts.iter().flat_map(|post| {
            post.citations()
                .into_iter()
                .flat_map(|summary| summary.references.iter())
                .map(|reference| (reference, Some(post.slug.as_str())))
        }),
        inputs.library,
    );
    report
}

fn claim_evidence(
    inputs: &BoundaryInputs<'_>,
    posts: Vec<&Post>,
    published_posts: &BTreeSet<&str>,
    only: Option<&str>,
) -> ProjectionReport {
    let mut report = report(Projection::ClaimEvidence, inputs.switches.claim_evidence);
    if let Some(blocked) = inputs.claims_blocked.filter(|_| report.enabled) {
        report.blocked = Some(blocked.to_string());
        return report;
    }
    let mut claim_ids = BTreeSet::new();
    let mut link_ids = BTreeSet::new();
    let mut sources: Vec<(&PublicReference, Option<&str>)> = Vec::new();
    for post in &posts {
        let Some(evidence) = post.claim_evidence() else {
            continue;
        };
        for claim in &evidence.claims {
            claim_ids.insert(claim.id.clone());
            let mut fields = vec!["statement".to_string(), "standing".to_string()];
            present(&mut fields, "quote", claim.quote.is_some());
            present(&mut fields, "uncertainty", claim.uncertainty.is_some());
            let mut withheld_fields = Vec::new();
            let anchored = inputs
                .claims
                .and_then(|set| set.claim(&claim.id))
                .is_some_and(|stored| stored.anchor.is_some());
            if anchored && claim.quote.is_none() {
                withheld_fields.push(WithheldField {
                    field: "quote".into(),
                    reason: Reason::StaleAnchor,
                    message: format!(
                        "Claim `{}`: the words it was anchored to are no longer exactly where they were, so the claim is published without them.",
                        claim.id
                    ),
                });
            }
            report.published.push(PublishedItem {
                kind: ItemKind::Claim,
                id: claim.id.clone(),
                label: Some(format!("Claim {}", claim.number)),
                posts: vec![post.slug.clone()],
                url: Some(claim.url.clone()),
                fields,
                withheld_fields,
                notices: Vec::new(),
            });
            for (relation, links) in [
                ("supports", &claim.supports),
                ("contradicts", &claim.contradicts),
                ("contextualizes", &claim.contextualizes),
            ] {
                for link in links {
                    link_ids.insert(link.id.clone());
                    let mut fields = vec![
                        format!("relation ({relation})"),
                        "source".to_string(),
                        "confidence".to_string(),
                    ];
                    present(&mut fields, "locators", !link.locators.is_empty());
                    present(&mut fields, "rationale", link.rationale.is_some());
                    present(&mut fields, "uncertainty", link.uncertainty.is_some());
                    report.published.push(PublishedItem {
                        kind: ItemKind::EvidenceLink,
                        id: link.id.clone(),
                        label: Some(format!("On claim `{}`", claim.id)),
                        posts: vec![post.slug.clone()],
                        url: None,
                        fields,
                        withheld_fields: Vec::new(),
                        notices: Vec::new(),
                    });
                }
            }
        }
        sources.extend(
            evidence
                .sources
                .iter()
                .map(|source| (&source.reference, Some(post.slug.as_str()))),
        );
    }
    report
        .published
        .extend(sources_of(sources.into_iter(), inputs.library));

    let Some(set) = inputs.claims else {
        return report;
    };
    let mine = |post: &str| only.is_none_or(|only| only == post);
    for claim in set.claims.iter().filter(|claim| mine(&claim.post)) {
        if claim_ids.contains(&claim.id) {
            continue;
        }
        let (reason, message) = if !report.enabled {
            (
                Reason::ProjectionOff,
                off_message(Projection::ClaimEvidence),
            )
        } else if claim.visibility != Visibility::Approved {
            (
                Reason::NotApproved,
                format!("Claim `{}` is not approved, so it stays private.", claim.id),
            )
        } else if !published_posts.contains(claim.post.as_str()) {
            (
                Reason::PostNotPublished,
                format!(
                    "Claim `{}` is about `{}`, which this build does not publish; it is published with that post.",
                    claim.id, claim.post
                ),
            )
        } else {
            (
                Reason::PrivateDependency,
                format!(
                    "Claim `{}` is not part of its post's published evidence.",
                    claim.id
                ),
            )
        };
        let mut item = withheld(ItemKind::Claim, &claim.id, reason, message);
        item.posts = vec![claim.post.clone()];
        report.withheld.push(item);
    }
    for link in &set.links {
        let Some(claim) = set.claim(&link.claim) else {
            continue;
        };
        if !mine(&claim.post) || link_ids.contains(&link.id) {
            continue;
        }
        let contradiction_private = set.links_of(&claim.id).any(|other| {
            other.relation == Relation::Contradicts && other.visibility != Visibility::Approved
        });
        let (reason, message) = if !report.enabled {
            (
                Reason::ProjectionOff,
                off_message(Projection::ClaimEvidence),
            )
        } else if link.visibility != Visibility::Approved {
            (
                Reason::NotApproved,
                format!(
                    "Evidence link `{}` is not approved, so it stays private.",
                    link.id
                ),
            )
        } else if link.evidence.passage.is_some() {
            (
                Reason::NotebookPassage,
                format!(
                    "Evidence link `{}` rests on a notebook passage, which is never published.",
                    link.id
                ),
            )
        } else if !claim_ids.contains(&claim.id) {
            (
                Reason::PrivateDependency,
                format!(
                    "Evidence link `{}` is on claim `{}`, which is not published.",
                    link.id, claim.id
                ),
            )
        } else if link.relation == Relation::Supports && contradiction_private {
            (
                Reason::ContradictionWithheld,
                format!(
                    "Evidence link `{}` supports claim `{}`, whose contradicting evidence is still private, so the support stays private too.",
                    link.id, claim.id
                ),
            )
        } else {
            (
                Reason::PrivateDependency,
                format!(
                    "Evidence link `{}` is not part of its post's published evidence.",
                    link.id
                ),
            )
        };
        let mut item = withheld(ItemKind::EvidenceLink, &link.id, reason, message);
        item.posts = vec![claim.post.clone()];
        report.withheld.push(item);
    }
    report
}

fn atlas(inputs: &BoundaryInputs<'_>) -> ProjectionReport {
    let mut report = report(Projection::Atlas, inputs.switches.atlas);
    if let Some(blocked) = inputs.atlas_blocked.filter(|_| report.enabled) {
        report.blocked = Some(blocked.to_string());
        return report;
    }
    let mut entries = BTreeSet::new();
    let mut relationships = BTreeSet::new();
    if let Some(public) = inputs.public_atlas.filter(|_| report.enabled) {
        for entry in &public.entries {
            entries.insert(entry.id.as_str());
            let mut fields = vec!["kind".to_string(), "label".to_string()];
            present(&mut fields, "aliases", !entry.aliases.is_empty());
            present(&mut fields, "summary", entry.summary.is_some());
            present(&mut fields, "source", entry.source.is_some());
            report.published.push(PublishedItem {
                kind: ItemKind::Entry,
                id: entry.id.clone(),
                label: Some(entry.label.clone()),
                posts: Vec::new(),
                url: Some(entry.url.clone()),
                fields,
                withheld_fields: Vec::new(),
                notices: Vec::new(),
            });
        }
        for relationship in &public.relationships {
            relationships.insert(relationship.id.as_str());
            let mut fields: Vec<String> =
                ["kind", "from", "to", "assertedBy", "confidence", "evidence"]
                    .iter()
                    .map(|field| field.to_string())
                    .collect();
            present(
                &mut fields,
                "uncertainty",
                relationship.uncertainty.is_some(),
            );
            present(
                &mut fields,
                "contestedBy",
                !relationship.contested_by.is_empty(),
            );
            report.published.push(PublishedItem {
                kind: ItemKind::Relationship,
                id: relationship.id.clone(),
                label: Some(format!(
                    "{} {} {}",
                    relationship.from, relationship.label, relationship.to
                )),
                posts: Vec::new(),
                url: None,
                fields,
                withheld_fields: Vec::new(),
                notices: Vec::new(),
            });
        }
        report.published.extend(sources_of(
            public
                .sources
                .iter()
                .map(|source| (&source.reference, None)),
            inputs.library,
        ));
    }
    let Some(atlas) = inputs.atlas else {
        return report;
    };
    let approved = |id: &str| {
        atlas
            .entry(id)
            .is_some_and(|entry| entry.visibility == Visibility::Approved)
    };
    for entry in &atlas.entries {
        if entries.contains(entry.id.as_str()) {
            continue;
        }
        let (reason, message) = if !report.enabled {
            (Reason::ProjectionOff, off_message(Projection::Atlas))
        } else if entry.visibility != Visibility::Approved {
            (
                Reason::NotApproved,
                format!("Entry `{}` is not approved, so it stays private.", entry.id),
            )
        } else {
            (
                Reason::PrivateDependency,
                format!(
                    "Entry `{}` is not in the atlas the build publishes.",
                    entry.id
                ),
            )
        };
        let mut item = withheld(ItemKind::Entry, &entry.id, reason, message);
        item.label = Some(entry.label.clone());
        report.withheld.push(item);
    }
    for relationship in &atlas.relationships {
        if relationships.contains(relationship.id.as_str()) {
            continue;
        }
        let passage = relationship
            .evidence
            .iter()
            .chain(
                relationship
                    .contested_by
                    .iter()
                    .flat_map(|d| d.evidence.iter()),
            )
            .any(|evidence| evidence.passage.is_some());
        let private_end = [&relationship.from, &relationship.to]
            .into_iter()
            .find(|id| !approved(id));
        let id = &relationship.id;
        let (reason, message) = if !report.enabled {
            (Reason::ProjectionOff, off_message(Projection::Atlas))
        } else if relationship.visibility != Visibility::Approved {
            (
                Reason::NotApproved,
                format!("Relationship `{id}` is not approved, so it stays private."),
            )
        } else if relationship.unsourced {
            (
                Reason::Unsourced,
                format!("Relationship `{id}` is an unsourced draft, which is never published."),
            )
        } else if passage {
            (
                Reason::NotebookPassage,
                format!(
                    "Relationship `{id}` rests on a notebook passage, which is never published."
                ),
            )
        } else if let Some(end) = private_end {
            (
                Reason::PrivateDependency,
                format!("Relationship `{id}` joins entry `{end}`, which is not published, so it stays private until that entry is approved."),
            )
        } else {
            (
                Reason::PrivateDependency,
                format!("Relationship `{id}` is not in the atlas the build publishes."),
            )
        };
        report
            .withheld
            .push(withheld(ItemKind::Relationship, id, reason, message));
    }
    report
}

fn datings(inputs: &BoundaryInputs<'_>) -> ProjectionReport {
    let mut report = report(Projection::Datings, inputs.switches.atlas);
    if let Some(blocked) = inputs.atlas_blocked.filter(|_| report.enabled) {
        report.blocked = Some(blocked.to_string());
        return report;
    }
    let mut published = BTreeSet::new();
    if let Some(public) = inputs.public_atlas.filter(|_| report.enabled) {
        for dating in &public.datings {
            published.insert(dating.id.as_str());
            let mut fields: Vec<String> =
                ["aspect", "date", "assertedBy", "confidence", "evidence"]
                    .iter()
                    .map(|field| field.to_string())
                    .collect();
            present(&mut fields, "note", dating.note.is_some());
            report.published.push(PublishedItem {
                kind: ItemKind::Dating,
                id: dating.id.clone(),
                label: Some(format!(
                    "{} of {}: {}",
                    aspect_noun(dating.aspect),
                    dating.owner,
                    dating.text
                )),
                posts: Vec::new(),
                url: Some(public.owner_url(&dating.owner, dating.owner_type)),
                fields,
                withheld_fields: Vec::new(),
                notices: Vec::new(),
            });
        }
    }
    let Some(atlas) = inputs.atlas else {
        return report;
    };
    let approved = |id: &str| {
        atlas
            .entry(id)
            .is_some_and(|entry| entry.visibility == Visibility::Approved)
    };
    for (owner, dating) in atlas.all_datings() {
        if published.contains(dating.id.as_str()) {
            continue;
        }
        let id = &dating.id;
        let owner_published = approved(owner)
            || atlas
                .relationship(owner)
                .is_some_and(|relationship| atlas.is_projected(relationship));
        let (reason, message) = if !report.enabled {
            (Reason::ProjectionOff, off_message(Projection::Datings))
        } else if dating.visibility != Visibility::Approved {
            (
                Reason::NotApproved,
                format!("Dating `{id}` of `{owner}` is not approved, so it stays private."),
            )
        } else if dating.unsourced {
            (
                Reason::Unsourced,
                format!(
                    "Dating `{id}` of `{owner}` is an unsourced draft, which is never published."
                ),
            )
        } else if dating
            .evidence
            .iter()
            .any(|evidence| evidence.passage.is_some())
        {
            (
                Reason::NotebookPassage,
                format!("Dating `{id}` of `{owner}` rests on a notebook passage, which is never published."),
            )
        } else if !owner_published {
            (
                Reason::PrivateDependency,
                format!("Dating `{id}` dates `{owner}`, which is not published."),
            )
        } else if let Some(target) = dating.relative_target().filter(|t| !approved(&t.entry)) {
            (
                Reason::PrivateDependency,
                format!(
                    "Dating `{id}` is relative to entry `{}`, which is not published.",
                    target.entry
                ),
            )
        } else {
            (
                Reason::PrivateDependency,
                format!("Dating `{id}` is not in the atlas the build publishes."),
            )
        };
        let mut item = withheld(ItemKind::Dating, id, reason, message);
        item.owner = Some(ItemOwner {
            kind: if atlas.entry(owner).is_some() {
                "entry"
            } else {
                "relationship"
            },
            id: owner.to_string(),
        });
        report.withheld.push(item);
    }
    report
}

/// The query projection of the published atlas (ADR 0168): one item for each
/// entry and relationship it holds, each copying only the query allowlist.
/// It is derived from the published atlas, so it can name nothing the Atlas
/// projection does not publish.
fn atlas_query(inputs: &BoundaryInputs<'_>) -> ProjectionReport {
    let mut report = report(Projection::AtlasQuery, inputs.switches.atlas);
    if let Some(blocked) = inputs.atlas_blocked.filter(|_| report.enabled) {
        report.blocked = Some(blocked.to_string());
        return report;
    }
    let Some(public) = inputs.public_atlas.filter(|_| report.enabled) else {
        return report;
    };
    let query = match AtlasQuery::project(public, inputs.author, inputs.base_path) {
        Ok(query) => query,
        Err(refusal) => {
            report.withheld.push(withheld(
                ItemKind::AtlasQuery,
                "atlas-query",
                match refusal.kind {
                    RefusalKind::OverLimit => Reason::OverLimit,
                    RefusalKind::Inconsistent => Reason::Inconsistent,
                },
                format!(
                    "The atlas query file {ATLAS_QUERY_JSON_FILE} is not written: {refusal}. The atlas pages and atlas.json are unaffected."
                ),
            ));
            return report;
        }
    };
    for entry in &query.entries {
        let mut fields: Vec<String> = ["kind", "kindLabel", "label"]
            .iter()
            .map(|f| f.to_string())
            .collect();
        present(&mut fields, "aliases", !entry.aliases.is_empty());
        present(&mut fields, "source", entry.source.is_some());
        present(&mut fields, "preview", entry.preview.is_some());
        fields.push("url".to_string());
        present(&mut fields, "out", !entry.out.is_empty());
        present(&mut fields, "in", !entry.incoming.is_empty());
        report.published.push(PublishedItem {
            kind: ItemKind::Entry,
            id: entry.id.clone(),
            label: Some(entry.label.clone()),
            posts: Vec::new(),
            url: Some(entry.url.clone()),
            fields,
            withheld_fields: Vec::new(),
            notices: Vec::new(),
        });
    }
    for edge in &query.edges {
        let mut fields: Vec<String> = [
            "kind",
            "from",
            "to",
            "label",
            "inverseLabel",
            "assertedBy",
            "assertedByText",
            "confidence",
            "confidenceText",
            "standing",
            "standingText",
            "evidence",
            "url",
        ]
        .iter()
        .map(|f| f.to_string())
        .collect();
        present(&mut fields, "dissents", edge.dissents > 0);
        present(&mut fields, "uncertainty", edge.uncertainty.is_some());
        report.published.push(PublishedItem {
            kind: ItemKind::Relationship,
            id: edge.id.clone(),
            label: Some(format!("{} {} {}", edge.from, edge.label, edge.to)),
            posts: Vec::new(),
            url: Some(edge.url.clone()),
            fields,
            withheld_fields: Vec::new(),
            notices: Vec::new(),
        });
    }
    // The public text of each source the file cites, as the atlas pages show it.
    for source in &query.sources {
        report.published.push(PublishedItem {
            kind: ItemKind::Source,
            id: source.id.clone(),
            label: Some(source.text.clone()),
            posts: Vec::new(),
            url: None,
            fields: vec!["text".to_string()],
            withheld_fields: Vec::new(),
            notices: Vec::new(),
        });
    }
    report
}

/// The reading paths the build publishes: each with the fields it copies, the
/// posts it names and whether discovery lists it. Only the public value is
/// read, so a draft, a step that is not published and a path file's other text
/// are never here. Nothing is withheld by name: what a path leaves out is
/// reported to the author at build time (ADR 0211).
fn reading_paths(inputs: &BoundaryInputs<'_>) -> ProjectionReport {
    let mut report = report(Projection::ReadingPaths, inputs.switches.reading_paths);
    let Some(public) = inputs.public_paths.filter(|_| report.enabled) else {
        return report;
    };
    for path in &public.paths {
        let mut fields: Vec<String> = [
            "title",
            "steps (target, title, address)",
            "transitions (relationship, reason)",
        ]
        .iter()
        .map(|field| field.to_string())
        .collect();
        present(&mut fields, "summary", path.summary.is_some());
        present(
            &mut fields,
            "rationale",
            path.steps.iter().any(|s| s.rationale.is_some()),
        );
        present(
            &mut fields,
            "prerequisites",
            path.steps.iter().any(|s| s.prerequisites.is_some()),
        );
        present(
            &mut fields,
            "difficulty",
            path.steps.iter().any(|s| s.difficulty.is_some()),
        );
        fields.push(if path.listed {
            "listed: in /paths/, the sitemap, search, paths.json and links from its posts".into()
        } else {
            "unlisted: its page only".into()
        });
        let mut posts: Vec<String> = path
            .steps
            .iter()
            .filter(|step| step.kind == "post")
            .map(|step| step.target.clone())
            .collect();
        posts.sort();
        posts.dedup();
        report.published.push(PublishedItem {
            kind: ItemKind::Path,
            id: path.slug.clone(),
            label: Some(path.title.clone()),
            posts,
            url: Some(path.url.clone()),
            fields,
            withheld_fields: Vec::new(),
            notices: Vec::new(),
        });
    }
    report
}

/// The interpretation comparisons the build publishes: each with the parts it
/// copies. Only the public projection is read, so a draft comparison, an AI
/// draft nobody approved and a private note are never here (ADR 0230). What a
/// comparison leaves out is reported to the author at build time, by item id.
fn interpretations(inputs: &BoundaryInputs<'_>) -> ProjectionReport {
    let mut report = report(Projection::Interpretations, inputs.switches.interpretations);
    let Some(public) = inputs.public_interpretations.filter(|_| report.enabled) else {
        return report;
    };
    for published in &public.comparisons {
        let comparison = &published.comparison;
        let mut fields: Vec<String> = [
            "title",
            "subject",
            "interpretations (attribution, statement, provenance)",
        ]
        .iter()
        .map(|field| field.to_string())
        .collect();
        present(
            &mut fields,
            "evidence (approved links and sources)",
            comparison
                .interpretations
                .iter()
                .any(|i| !i.evidence.is_empty()),
        );
        present(
            &mut fields,
            "uncertainty",
            comparison
                .interpretations
                .iter()
                .any(|i| i.uncertainty.is_some()),
        );
        present(&mut fields, "relations", !comparison.relations.is_empty());
        present(
            &mut fields,
            "audience explanations (supplemental)",
            !comparison.explanations.is_empty(),
        );
        report.published.push(PublishedItem {
            kind: ItemKind::Interpretation,
            id: comparison.slug.clone(),
            label: Some(comparison.title.clone()),
            posts: Vec::new(),
            url: Some(published.url.clone()),
            fields,
            withheld_fields: Vec::new(),
            notices: Vec::new(),
        });
    }
    report
}

fn comparisons(inputs: &BoundaryInputs<'_>) -> ProjectionReport {
    let mut report = report(Projection::Comparisons, inputs.switches.comparisons);
    if let Some(blocked) = inputs.comparisons_blocked.filter(|_| report.enabled) {
        report.blocked = Some(blocked.to_string());
        return report;
    }
    let mut published = BTreeSet::new();
    if let Some(public) = inputs.public_comparisons.filter(|_| report.enabled) {
        for comparison in &public.comparisons {
            published.insert(comparison.id.as_str());
            let mut fields: Vec<String> = [
                "correspondence",
                "recordedBy",
                "confidence",
                "versions",
                "places (locators)",
            ]
            .iter()
            .map(|field| field.to_string())
            .collect();
            present(&mut fields, "label", comparison.label.is_some());
            present(&mut fields, "evidence", !comparison.evidence.is_empty());
            present(&mut fields, "rationale", comparison.rationale.is_some());
            present(&mut fields, "uncertainty", comparison.uncertainty.is_some());
            let mut withheld_fields = Vec::new();
            let mut shown = 0;
            for place in comparison.places_in_member_order() {
                if place.text.is_some() {
                    shown += 1;
                }
                if let Some(why) = place.withheld {
                    let (reason, because) = match why {
                        Withheld::Rights => (
                            Reason::Rights,
                            "the version's rights statement does not let the site show it",
                        ),
                        Withheld::Length => (Reason::Length, "it is longer than a brief excerpt"),
                    };
                    withheld_fields.push(WithheldField {
                        field: format!("members[{}].text", place.member),
                        reason,
                        message: format!(
                            "Comparison `{}`: the wording of members[{}] is identified and located but not shown, because {because}.",
                            comparison.id, place.member
                        ),
                    });
                }
            }
            if shown > 0 {
                fields.push(format!(
                    "wording of {shown} place{}",
                    if shown == 1 { "" } else { "s" }
                ));
            }
            report.published.push(PublishedItem {
                kind: ItemKind::Comparison,
                id: comparison.id.clone(),
                label: comparison.label.clone(),
                posts: Vec::new(),
                url: Some(comparison.url.clone()),
                fields,
                withheld_fields,
                notices: Vec::new(),
            });
        }
        report.published.extend(sources_of(
            public
                .sources
                .iter()
                .map(|source| (&source.reference, None)),
            inputs.library,
        ));
    }
    let Some(set) = inputs.alignments else {
        return report;
    };
    for alignment in &set.alignments {
        if published.contains(alignment.id.as_str()) {
            continue;
        }
        let id = &alignment.id;
        let stale = inputs.stale_comparisons.and_then(|stale| stale.get(id));
        let (reason, message) = if !report.enabled {
            (Reason::ProjectionOff, off_message(Projection::Comparisons))
        } else if !alignment.is_approved() {
            (
                Reason::NotApproved,
                format!("Comparison `{id}` is not approved, so it stays private."),
            )
        } else if let Some(stale) = stale {
            (
                Reason::StaleApproval,
                format!("Comparison `{id}` is approved but withheld from /comparisons/ because its approval is stale ({stale}). Check the place, then save the alignment again to approve it as it now stands and publish it again."),
            )
        } else {
            (
                Reason::PrivateDependency,
                format!("Comparison `{id}` is not in the comparisons the build publishes."),
            )
        };
        let mut item = withheld(ItemKind::Comparison, id, reason, message);
        item.label = alignment.label.clone();
        report.withheld.push(item);
    }
    report
}

/// The curated selections: for the whole site, or for one post, which is
/// offered the whole-site selections and its own, in the order readers get them.
fn curated(inputs: &BoundaryInputs<'_>, post: Option<&str>) -> ProjectionReport {
    let mut report = report(Projection::Curated, inputs.switches.curated);
    let Some(curation) = inputs.curation else {
        return report;
    };
    let resolution = curation.resolution;
    let view = resolution.curation.view_for(post);
    for item in view.items.iter().copied() {
        let mut withheld_fields = Vec::new();
        for notice in resolution.notices.iter().filter(|n| n.id == item.id) {
            let reason = match notice.code {
                NoticeCode::UnsafeUrl => Reason::UnsafeUrl,
                NoticeCode::PrivateIdentifier => Reason::PrivateIdentifier,
                NoticeCode::RightsRestricted => Reason::Rights,
                _ => continue,
            };
            withheld_fields.push(WithheldField {
                field: notice.field.clone().unwrap_or_default(),
                reason,
                message: notice.message.clone(),
            });
        }
        let label = ["title", "label", "by"]
            .iter()
            .find_map(|name| item.content.get(*name).and_then(Value::as_str))
            .map(str::to_string);
        report.published.push(PublishedItem {
            kind: ItemKind::Selection,
            id: item.id.clone(),
            label,
            posts: item.posts.clone(),
            url: item
                .content
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string),
            fields: item.content.keys().cloned().collect(),
            withheld_fields,
            notices: item.notices.clone(),
        });
    }
    for context in view.context.iter().copied() {
        let kind = match context.kind {
            CurationContext::Entry => ItemKind::Entry,
            CurationContext::Relationship => ItemKind::Relationship,
            CurationContext::Source => ItemKind::Source,
        };
        report.published.push(PublishedItem {
            kind,
            id: context.id.clone(),
            label: context.label.clone(),
            posts: Vec::new(),
            url: context.url.clone(),
            fields: vec!["context for ".to_string() + &context.via.join(", ")],
            withheld_fields: Vec::new(),
            notices: Vec::new(),
        });
    }
    let applies = |id: &str| {
        post.is_none_or(|post| {
            curation
                .set
                .get(id)
                .and_then(|selection| selection.posts.as_ref())
                .is_none_or(|posts| posts.iter().any(|p| p == post))
        })
    };
    for held in resolution.withheld.iter().filter(|held| applies(&held.id)) {
        let reason = match held.why {
            Why::Withdrawn => Reason::Withdrawn,
            Why::TargetMissing => Reason::MissingTarget,
            Why::NotApproved => Reason::NotApproved,
            Why::SourcePrivate => Reason::NotApproved,
            Why::PostNotPublished => Reason::PostNotPublished,
            Why::NotPublished | Why::DependencyMissing | Why::DependencyWithheld => {
                Reason::PrivateDependency
            }
            Why::Stale => Reason::StaleSelection,
            Why::Cycle => Reason::SelectionCycle,
        };
        let mut item = withheld(ItemKind::Selection, &held.id, reason, held.message.clone());
        item.label = Some(held.target.clone());
        report.withheld.push(item);
    }
    report
}

/// The curated context file (ADR 0197): one item for the file as a whole,
/// derived from the curated selections the manifest already lists and from
/// nothing else, so it can name nothing the curated projection does not
/// publish. A projection that is over a bound or does not agree with itself
/// is withheld whole, and the pages' sections and the selections are
/// unaffected.
fn curated_context(inputs: &BoundaryInputs<'_>) -> ProjectionReport {
    let mut report = report(Projection::CuratedContext, inputs.switches.curated);
    let Some(curation) = inputs.curation.filter(|_| report.enabled) else {
        return report;
    };
    let posts: Vec<PostRef<'_>> = inputs
        .posts
        .iter()
        .map(|post| PostRef {
            slug: post.slug.as_str(),
            url: post.url.as_str(),
        })
        .collect();
    match CuratedContext::project(&curation.resolution.curation, &posts, inputs.base_path) {
        // Nothing published, nothing written: no file, so nothing to list.
        Ok(context) if context.items.is_empty() => {}
        Ok(context) => report.published.push(PublishedItem {
            kind: ItemKind::CuratedContext,
            id: "curated-context".to_string(),
            label: Some(CURATED_CONTEXT_JSON_FILE.to_string()),
            posts: context.posts.iter().map(|post| post.post.clone()).collect(),
            url: Some(format!("/{CURATED_CONTEXT_JSON_FILE}")),
            fields: ["items", "context", "posts"]
                .iter()
                .map(|field| field.to_string())
                .collect(),
            withheld_fields: Vec::new(),
            notices: Vec::new(),
        }),
        Err(refusal) => report.withheld.push(withheld(
            ItemKind::CuratedContext,
            "curated-context",
            match refusal.kind {
                RefusalKind::OverLimit => Reason::OverLimit,
                RefusalKind::Inconsistent => Reason::Inconsistent,
            },
            format!(
                "The curated context file {CURATED_CONTEXT_JSON_FILE} is not written: {refusal}. The research-context section of each post's page and your selections are unaffected."
            ),
        )),
    }
    report
}

fn context_links(inputs: &BoundaryInputs<'_>, post: &Post) -> ProjectionReport {
    let mut report = report(
        Projection::ContextLinks,
        inputs.switches.atlas || inputs.switches.comparisons,
    );
    let links = find_context_links(post.authored_markdown(), 1);
    let mut seen = BTreeSet::new();
    for link in links {
        // A form the build never shows as a link leads nowhere: not listed.
        if !link.linked || !seen.insert((link.kind, link.id.clone())) {
            continue;
        }
        let (kind, page) = match link.kind {
            ContextKind::AtlasEntry => (
                ItemKind::AtlasPage,
                inputs
                    .public_atlas
                    .filter(|_| inputs.switches.atlas)
                    .and_then(|atlas| atlas.entry(&link.id))
                    .map(|entry| (entry.label.clone(), entry.url.clone())),
            ),
            ContextKind::Comparison => (
                ItemKind::ComparisonPage,
                inputs
                    .public_comparisons
                    .filter(|_| inputs.switches.comparisons)
                    .and_then(|set| set.comparisons.iter().find(|c| c.id == link.id))
                    .map(|c| {
                        (
                            c.label.clone().unwrap_or_else(|| c.id.clone()),
                            c.url.clone(),
                        )
                    }),
            ),
        };
        match page {
            Some((label, url)) => report.published.push(PublishedItem {
                kind,
                id: link.id.clone(),
                label: Some(label),
                posts: vec![post.slug.clone()],
                url: Some(url),
                fields: vec!["link".into()],
                withheld_fields: Vec::new(),
                notices: Vec::new(),
            }),
            None => {
                let what = match link.kind {
                    ContextKind::AtlasEntry => "atlas entry",
                    ContextKind::Comparison => "comparison",
                };
                let message = if link.href.starts_with(crate::concept_links::SCHEME) {
                    format!(
                        "The concept link {} names the {what} `{}`, whose page the next build does not publish; it is published as the plain text of its label, with no link.",
                        link.href, link.id
                    )
                } else {
                    format!(
                        "The link to {} leads to the {what} `{}`, whose page the next build does not publish; the link is published as written and leads nowhere.",
                        link.href, link.id
                    )
                };
                let mut item = withheld(kind, &link.id, Reason::PageNotPublished, message);
                item.posts = vec![post.slug.clone()];
                report.withheld.push(item);
            }
        }
    }
    report
}

fn never(inputs: &BoundaryInputs<'_>) -> Vec<NeverPublished> {
    let mut never = Vec::new();
    let mut push = |store: Store, count: usize, what: String| {
        never.push(NeverPublished {
            store,
            file: store.file(),
            count,
            what,
        });
    };
    if let Some(library) = inputs.library {
        push(
            Store::SourceLibrary,
            library.sources.len() + library.interpretations.len(),
            "Notes, rights notes, archived flags, version relationships, identifiers in private schemes, unknown fields and every interpretation's own notes. A source's public description is published only where a published post cites it or a published projection uses it, and an interpretation's wording only where an approved comparison shows it.".into(),
        );
    }
    if let Some(notebook) = inputs.notebook {
        push(
            Store::Notebook,
            notebook.notes.len(),
            "Every note and question.".into(),
        );
        push(
            Store::Notebook,
            notebook.passages.len(),
            "Every passage, its notes and its locators, except the wording of a place an approved comparison shows under its version's rights.".into(),
        );
    }
    if let Some(atlas) = inputs.atlas {
        push(
            Store::Atlas,
            atlas.entries.len() + atlas.relationships.len(),
            "Visibility, unsourced flags, notebook passages and unknown fields of every entry, relationship and dating.".into(),
        );
    }
    if let Some(claims) = inputs.claims {
        push(
            Store::Claims,
            claims.claims.len() + claims.links.len(),
            "Visibility, review state, origin, who recorded it, anchor offsets, notebook passages and unknown fields of every claim and evidence link.".into(),
        );
    }
    if let Some(alignments) = inputs.alignments {
        push(
            Store::Alignments,
            alignments.alignments.len(),
            "Visibility, place notes, notebook passage ids, normalizations not chosen for publication and unknown fields of every alignment.".into(),
        );
    }
    if let Some(curation) = inputs.curation.filter(|_| inputs.switches.curated) {
        push(
            Store::Selections,
            curation.set.selections.len(),
            "Selection records: revisions, withdrawal reasons, requirements and unknown fields. Only the fields a live, current selection lists are published, and only from what the atlas, comparison and citation projections publish.".into(),
        );
    }
    if let Some(count) = inputs.acknowledgements {
        push(
            Store::Acknowledgements,
            count,
            "Every acknowledgement of a review finding.".into(),
        );
    }
    never
}

// ---------------------------------------------------------------- the private text guard

/// Where a piece of private text came from: the file, the record's id when
/// it has one, and the field, as a JSON path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PrivateOrigin {
    pub store: Store,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub field: String,
}

/// Private text found in an output, by output path and origin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Leak {
    pub output: String,
    pub origin: PrivateOrigin,
}

impl std::fmt::Display for Leak {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "`{}` carries text from {} (`{}`",
            self.output,
            self.origin.store.name(),
            self.origin.store.file()
        )?;
        if let Some(id) = &self.origin.id {
            write!(formatter, ", `{id}`")?;
        }
        write!(formatter, ", field `{}`)", self.origin.field)
    }
}

/// The text of every private research file, as word shingles the build can
/// look for in its output (see [`crate::shingles`]). A shingle that a public
/// input or an approved projection also holds is allowed and dropped, so only
/// text that could have come from nowhere but private research is guarded.
/// Text of fewer than [`SHINGLE_WORDS`] words is not guarded by text.
#[derive(Debug, Default)]
pub struct PrivateText {
    origins: Vec<PrivateOrigin>,
    /// Shingle hash to the origin it first occurs in.
    shingles: HashMap<u64, u32>,
    /// Known public short strings that generated text is cut at.
    cuts: Cuts,
}

impl PrivateText {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add every string value of a private file. A file that is not JSON is
    /// added whole, so a damaged file is still guarded.
    pub fn add_file(&mut self, store: Store, bytes: &[u8]) {
        match serde_json::from_slice::<Value>(bytes) {
            Ok(value) => self.add_value(store, &value, None, String::new()),
            Err(_) => self.add_text(
                PrivateOrigin {
                    store,
                    id: None,
                    field: "(the whole file)".into(),
                },
                &String::from_utf8_lossy(bytes),
            ),
        }
    }

    fn add_value(&mut self, store: Store, value: &Value, id: Option<&str>, path: String) {
        match value {
            Value::String(text) => self.add_text(
                PrivateOrigin {
                    store,
                    id: id.map(str::to_string),
                    field: if path.is_empty() {
                        "(root)".into()
                    } else {
                        path
                    },
                },
                text,
            ),
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    self.add_value(store, item, id, format!("{path}[{index}]"));
                }
            }
            Value::Object(map) => {
                let own = map.get("id").and_then(Value::as_str);
                let (id, base) = match own {
                    Some(own) => (Some(own), String::new()),
                    None => (id, path),
                };
                for (key, item) in map {
                    let field = if base.is_empty() {
                        key.clone()
                    } else {
                        format!("{base}.{key}")
                    };
                    self.add_value(store, item, id, field);
                }
            }
            _ => {}
        }
    }

    fn add_text(&mut self, origin: PrivateOrigin, text: &str) {
        let index = self.origins.len() as u32;
        let before = self.shingles.len();
        each_shingle(text, Form::Plain, |hash| {
            self.shingles.entry(hash).or_insert(index);
        });
        if self.shingles.len() > before {
            self.origins.push(origin);
        }
    }

    /// Allow every shingle of `text` as written: a public input field such
    /// as a post's text or title.
    pub fn allow_text(&mut self, text: &str) {
        self.allow(text, Form::Plain);
    }

    /// Allow every shingle of a public file or an approved projection's
    /// output (HTML, JSON, Markdown, plain text). JSON is read field by field.
    pub fn allow_output(&mut self, text: &str) {
        if self.shingles.is_empty() {
            return;
        }
        each_output_shingle(text, None, |hash| {
            self.shingles.remove(&hash);
        });
    }

    fn allow(&mut self, text: &str, form: Form) {
        if self.shingles.is_empty() {
            return;
        }
        each_shingle(text, form, |hash| {
            self.shingles.remove(&hash);
        });
    }

    /// Cut generated text at the edges of a known public short string (a
    /// title, a heading, a tag or series name, a navigation label), so the
    /// theme placing two of them side by side never makes a shingle across
    /// them.
    pub fn cut_at(&mut self, text: &str) {
        if !self.shingles.is_empty() {
            self.cuts.add(text);
        }
    }

    /// Whether nothing is guarded.
    pub fn is_empty(&self) -> bool {
        self.shingles.is_empty()
    }

    /// How many shingles are still guarded.
    pub fn guarded(&self) -> usize {
        self.shingles.len()
    }

    /// The first private text `output` carries, if any.
    pub fn find(&self, path: &str, output: &[u8]) -> Option<Leak> {
        self.find_all(path, output, 1).into_iter().next()
    }

    /// The private texts `output` carries, one per origin, at most `limit`.
    /// A file that parses as JSON is read field by field.
    pub fn find_all(&self, path: &str, output: &[u8], limit: usize) -> Vec<Leak> {
        if self.shingles.is_empty() || limit == 0 {
            return Vec::new();
        }
        let mut origins: Vec<u32> = Vec::new();
        each_output_shingle(&String::from_utf8_lossy(output), Some(&self.cuts), |hash| {
            if origins.len() < limit {
                if let Some(&origin) = self.shingles.get(&hash) {
                    if !origins.contains(&origin) {
                        origins.push(origin);
                    }
                }
            }
        });
        origins
            .into_iter()
            .map(|origin| Leak {
                output: path.to_string(),
                origin: self.origins[origin as usize].clone(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHORT_NOTES: [&str; 2] = [
        "Check again: Smith (2003) disagrees, see p. 41; the 1987 letter is key.",
        "I'm not sure Plato's cave is meant literally - ask Dana before publishing.",
    ];

    fn guarded(texts: &[&str]) -> PrivateText {
        let mut guard = PrivateText::new();
        for (index, text) in texts.iter().enumerate() {
            guard.add_file(
                Store::Notebook,
                serde_json::json!({"notes": [{"id": format!("n{index}"), "text": text}]})
                    .to_string()
                    .as_bytes(),
            );
        }
        guard
    }

    #[test]
    fn the_guard_finds_private_text_through_wrapping_markup_escaping_and_case() {
        let mut guard = PrivateText::new();
        guard.add_file(
            Store::Notebook,
            br#"{"version":1,"notes":[{"id":"n1","kind":"observation","text":"Private musing about the shadows on the wall of the cave"}],"passages":[{"id":"p1","source":"s","excerpt":{"text":"The wording an approved comparison shows to every reader"}}]}"#,
        );
        guard.allow_output(
            "{\"text\":\"The wording an approved comparison shows to every reader\"}",
        );
        assert!(guard
            .find(
                "comparisons.json",
                b"<p>The wording an approved comparison shows to every reader</p>"
            )
            .is_none());
        for output in [
            "<p>&quot;PRIVATE MUSING about the shadows on the wall&quot;</p>",
            "<p>Private musing about
the <em>shadows</em> on the
wall of the cave</p>",
            "<p>Private musing about the <a href=\"/x\">shadows</a> on the wall</p>",
        ] {
            let leak = guard.find("index.html", output.as_bytes()).expect(output);
            assert_eq!(leak.output, "index.html");
            assert_eq!(leak.origin.store, Store::Notebook);
            assert_eq!(leak.origin.id.as_deref(), Some("n1"));
            assert_eq!(leak.origin.field, "text");
            let said = leak.to_string();
            assert!(!said.contains("musing"), "{said}");
        }
        assert!(guard
            .find("other.html", b"<p>A wall, a cave, and shadows.</p>")
            .is_none());
    }

    #[test]
    fn short_and_punctuated_private_notes_are_guarded() {
        let guard = guarded(&SHORT_NOTES);
        for (output, id) in [
            (
                "<p>Check again: <strong>Smith</strong> (2003) disagrees, see p. 41; the 1987 letter is key.</p>",
                "n0",
            ),
            (
                "<meta name=\"description\" content=\"I&#39;m not sure Plato&#39;s cave is meant literally - ask Dana before publishing.\">",
                "n1",
            ),
            (
                r#"{"body":"i\u0027m not sure plato\u2019s cave is meant\nliterally ask dana"}"#,
                "n1",
            ),
        ] {
            let leak = guard.find("page.html", output.as_bytes()).expect(output);
            assert_eq!(leak.origin.id.as_deref(), Some(id), "{output}");
        }
    }

    #[test]
    fn allowed_text_is_dropped_shingle_by_shingle() {
        let mut guard = guarded(&SHORT_NOTES);
        guard.allow_text("A post quotes it: Check again: Smith (2003) disagrees, see p. 41; the 1987 letter is key.");
        assert!(guard
            .find("p.html", b"Check again: Smith (2003) disagrees, see p. 41")
            .is_none());
        assert!(guard
            .find("p.html", b"not sure Plato's cave is meant literally")
            .is_some());
    }

    /// ADR 0199: a comment the author makes public excuses the words it shares
    /// with a private note everywhere, and nothing more of that note.
    #[test]
    fn an_annotation_that_copies_a_note_sentence_excuses_only_that_sentence() {
        let copied = "Smith (2003) disagrees about the cave, see p. 41 of the letter.";
        let other = "Ask Dana whether the 1987 letter was really written by Plato's pupil.";
        let mut guard = PrivateText::new();
        guard.add_file(
            Store::Notebook,
            serde_json::json!({"notes": [{"id": "n0", "text": format!("{copied} {other}")}]})
                .to_string()
                .as_bytes(),
        );
        // The author's public annotation quotes the first sentence.
        guard.allow_output(
            &serde_json::json!({"items": [{"id": "annotation-x", "content": {"text": copied}}]})
                .to_string(),
        );
        // The copied sentence is public wherever it appears, including beside a private note's id.
        assert!(guard.find("any.html", copied.as_bytes()).is_none());
        // The note's other sentence is still refused, in any file, and names the note.
        let leak = guard
            .find("any.html", format!("<p>{other}</p>").as_bytes())
            .expect("the rest of the note is still private");
        assert_eq!(leak.origin.id.as_deref(), Some("n0"));
        let leak = guard
            .find(
                "curated-context.json",
                serde_json::json!({"items": [{"content": {"text": other}}]})
                    .to_string()
                    .as_bytes(),
            )
            .expect("and so in the curated file");
        assert_eq!(leak.origin.id.as_deref(), Some("n0"));
    }

    #[test]
    fn text_shorter_than_a_shingle_and_ids_are_not_guarded_by_text() {
        let mut guard = PrivateText::new();
        guard.add_file(
            Store::Atlas,
            br#"{"version":2,"entries":[{"id":"plato","label":"Plato","note":"ask Dana before publishing"}]}"#,
        );
        assert!(guard.is_empty());
        let mut damaged = PrivateText::new();
        damaged.add_file(
            Store::Claims,
            b"{ not json, but a long private sentence about evidence",
        );
        let leak = damaged
            .find("x.html", b"a long private sentence about evidence")
            .unwrap();
        assert_eq!(leak.origin.field, "(the whole file)");
    }

    #[test]
    fn unsafe_web_addresses_are_named() {
        for (url, safe) in [
            ("https://example.org/a?page=2", true),
            ("http://archive.org/details/x", true),
            ("http://localhost:8080/notes", false),
            ("http://intranet/notes", false),
            ("https://files.corp.internal/x.pdf", false),
            ("http://192.168.1.4/x", false),
            ("http://10.0.0.1/x", false),
            ("http://[::1]/x", false),
            ("https://bucket.example.com/x?X-Amz-Signature=abc", false),
            ("https://example.com/x?token=abc", false),
            ("ftp://example.com/x", false),
            ("https://user:pw@example.com/", false),
            // An IPv4 address written in decimal, octal or hex is the same address.
            ("http://2130706433/x", false),
            ("http://0177.0.0.1/x", false),
            ("http://0x7f000001/x", false),
            ("http://0xc0.0xa8.1.4/x", false),
            ("http://3232235780/x", false),
            ("http://0300.0250.0.1/x", false),
            ("http://8.8.8.8/x", true),
            ("http://134744072/x", true),
            // IPv6 forms of private IPv4 and private IPv6 ranges.
            ("http://[::ffff:127.0.0.1]/x", false),
            ("http://[::ffff:c0a8:0104]/x", false),
            ("http://[::ffff:10.0.0.1]/x", false),
            ("http://[::ffff:8.8.8.8]/x", true),
            ("http://[64:ff9b::7f00:1]/x", false),
            ("http://[64:ff9b::808:808]/x", false),
            ("http://[fec0::1]/x", false),
            ("http://[fe80::1]/x", false),
            ("http://[fd00::1]/x", false),
            ("http://[2001:db8::1]/x", true),
            ("http://localhost.localdomain/x", false),
            ("http://localhost.localdomain./x", false),
            ("http://app.localhost.localdomain/x", false),
            // Secret-like parameter names, normalised and matched by word.
            ("https://example.com/x?access_token=abc", false),
            ("https://example.com/x?apiKey=abc", false),
            ("https://example.com/x?X-Amz-Signature=abc", false),
            ("https://example.com/x?authorization=abc", false),
            ("https://example.com/x?client_secret=abc", false),
            ("https://example.com/x?user_pass=abc", false),
            ("https://example.com/x?sig=abc", false),
            ("https://example.com/x#access_token=abc&state=1", false),
            ("https://example.com/x?a=1#/route?token=abc", false),
            ("https://example.com/x#token=abc", false),
            ("https://example.com/x#section-2", true),
            ("https://example.com/x?passage=3&keyword=ethics", true),
            ("https://example.org/openurl?sid=google&genre=book", true),
            // A fragment is a pair only when it has an `=`; a heading anchor is not.
            ("https://en.wikipedia.org/wiki/Plato#Authorship", true),
            (
                "https://plato.stanford.edu/entries/plato/#KeyConcepts",
                true,
            ),
            ("https://example.org/x#Passwords-and-secrets", true),
            ("https://example.org/x#/route?token=abc", false),
            ("https://example.org/x#a=1&secret=2", false),
            // Names are matched by word, not by substring.
            ("https://example.org/search?author=Plato", true),
            ("https://example.org/search?authors=Plato", true),
            ("https://example.org/list?sortKey=title", true),
            ("https://example.org/list?sort_key=title", true),
            ("https://example.org/mss?siglum=A", true),
            ("https://example.org/mss?sigla=A", true),
            ("https://example.org/map?region=turkey&monkey=1", true),
            ("https://example.org/page?design=wide", true),
            (
                "https://example.org/page?bypass=1&passage=2&keyword=x",
                true,
            ),
            ("https://books.google.com/books?id=abc&sig=ACfU3U", false),
            ("https://example.org/x?key=abc", false),
            ("https://example.org/x?API_KEY=abc", false),
            ("https://example.org/x?apikey=abc", false),
            ("https://example.org/x?accesstoken=abc", false),
            ("https://example.org/x?xamzsignature=abc", false),
            ("https://example.org/x?userPass=abc", false),
            ("https://example.org/x?oauth_token=abc", false),
            ("https://example.org/x?auth=abc", false),
            // More private names and ranges.
            ("http://wiki.corp/page", false),
            ("http://build.test/page", false),
            ("http://router.home/page", false),
            ("http://nas.localdomain/page", false),
            ("http://198.18.0.1/x", false),
            ("http://198.19.255.254/x", false),
            ("http://198.20.0.1/x", true),
            ("http://224.0.0.1/x", false),
            ("http://239.255.255.250/x", false),
            ("http://240.0.0.1/x", false),
            ("http://[::127.0.0.1]/x", false),
            ("http://[::10.0.0.1]/x", false),
            ("http://[::8.8.8.8]/x", true),
            ("http://[2002:7f00:1::]/x", false),
            ("http://[2002:c0a8:104::1]/x", false),
            ("http://[2002:808:808::1]/x", true),
            ("http://[ff02::1]/x", false),
        ] {
            assert_eq!(public_url_problem(url).is_none(), safe, "{url}");
        }
    }
}
