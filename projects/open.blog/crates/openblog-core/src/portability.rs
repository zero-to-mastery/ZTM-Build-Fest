//! Destination-neutral views over one public, canonical post.

use crate::capability::{CapabilityDescriptor, CapabilityDiagnosticCode, PortabilityLevel};
use crate::config::{SiteConfig, SyndicationProvider};
use crate::contributor::{CreditProvenance, ResolvedCredit};
use crate::escape;
use crate::markdown::{CodeRunnerRenderOptions, PortableContext, RenderOptions};
use crate::model::{CommentsPolicy, Post, SeriesContext, Site};
use crate::recipe::Recipe;
use crate::research::{ResearchMetadata, ResearchReference};
use crate::video::VideoMetadata;
use blake2::{Blake2b512, Digest};
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use url::Url;

/// The largest portable HTML body a projection produces. A post that would be
/// larger fails for its source instead of being truncated.
pub const MAX_PORTABLE_HTML_BYTES: usize = 2 * 1024 * 1024;

/// The deepest element nesting (Markdown containers plus kept raw HTML
/// elements) a portable HTML body may have.
pub const MAX_PORTABLE_NESTING_DEPTH: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DestinationRepresentation {
    PortableMarkdown,
    PortableHtml,
    ManualMarkdown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DestinationPublication {
    RemoteDraftByDefault,
    RemoteDraftOnly,
    ManualImport,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DestinationContentSubset {
    StaticCommonmark,
    AllowlistedStaticHtml,
    ManualCommonmark,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DestinationMediaDelivery {
    HostedUrlsOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationPolicy {
    pub version: u8,
    pub provider: SyndicationProvider,
    pub label: &'static str,
    pub representation: DestinationRepresentation,
    pub publication: DestinationPublication,
    pub canonical_behavior: &'static str,
    pub workflow: &'static str,
    pub content_subset: DestinationContentSubset,
    pub media_delivery: DestinationMediaDelivery,
    pub conversion_review: &'static str,
    pub max_tags: Option<usize>,
    pub max_tag_name_chars: Option<usize>,
    pub max_request_body_bytes: Option<usize>,
}

pub fn destination_policy(provider: SyndicationProvider) -> DestinationPolicy {
    match provider {
        SyndicationProvider::Dev => DestinationPolicy {
            version: 1,
            provider: SyndicationProvider::Dev,
            label: "DEV",
            representation: DestinationRepresentation::PortableMarkdown,
            publication: DestinationPublication::RemoteDraftByDefault,
            canonical_behavior: "The canonical URL is sent to DEV.",
            workflow: "Remote draft by default; public publishing requires explicit CLI approval.",
            content_subset: DestinationContentSubset::StaticCommonmark,
            media_delivery: DestinationMediaDelivery::HostedUrlsOnly,
            conversion_review: "Static CommonMark with visible answers and source examples; authored raw HTML is literal text, not active markup. Review the remote draft for Markdown extension differences.",
            max_tags: Some(4),
            max_tag_name_chars: Some(30),
            max_request_body_bytes: None,
        },
        SyndicationProvider::Hashnode => DestinationPolicy {
            version: 1,
            provider: SyndicationProvider::Hashnode,
            label: "Hashnode",
            representation: DestinationRepresentation::PortableMarkdown,
            publication: DestinationPublication::RemoteDraftOnly,
            canonical_behavior: "The canonical URL is sent to Hashnode.",
            workflow: "Remote drafts only; publish the saved draft in Hashnode. CLI public publishing is unsupported.",
            content_subset: DestinationContentSubset::StaticCommonmark,
            media_delivery: DestinationMediaDelivery::HostedUrlsOnly,
            conversion_review: "Static CommonMark with no open.blog components or Hashnode embed directives; authored raw HTML is literal text. Review the saved draft before publishing.",
            max_tags: Some(15),
            max_tag_name_chars: None,
            max_request_body_bytes: Some(100_000),
        },
        SyndicationProvider::Ghost => DestinationPolicy {
            version: 1,
            provider: SyndicationProvider::Ghost,
            label: "Ghost",
            representation: DestinationRepresentation::PortableHtml,
            publication: DestinationPublication::RemoteDraftByDefault,
            canonical_behavior: "The canonical URL is sent as Ghost's canonical URL.",
            workflow: "Remote draft by default; public publishing requires explicit CLI approval.",
            content_subset: DestinationContentSubset::AllowlistedStaticHtml,
            media_delivery: DestinationMediaDelivery::HostedUrlsOnly,
            conversion_review: "Ghost source=html converts allowlisted static HTML to Lexical and is lossy. Review headings, tables, anchors, attribution and code in the remote draft; identical rendered HTML is not guaranteed.",
            max_tags: None,
            max_tag_name_chars: None,
            max_request_body_bytes: None,
        },
        SyndicationProvider::Wordpress => DestinationPolicy {
            version: 1,
            provider: SyndicationProvider::Wordpress,
            label: "WordPress",
            representation: DestinationRepresentation::PortableHtml,
            publication: DestinationPublication::RemoteDraftByDefault,
            canonical_behavior: "WordPress core cannot set an external canonical URL.",
            workflow: "Remote draft by default; verify an SEO plugin before public publishing.",
            content_subset: DestinationContentSubset::AllowlistedStaticHtml,
            media_delivery: DestinationMediaDelivery::HostedUrlsOnly,
            conversion_review: "Allowlisted static HTML is sent as content. WordPress permissions, filters, plugins and themes may change it; review the remote draft and external canonical configuration.",
            max_tags: None,
            max_tag_name_chars: None,
            max_request_body_bytes: None,
        },
        SyndicationProvider::Medium => DestinationPolicy {
            version: 1,
            provider: SyndicationProvider::Medium,
            label: "Medium",
            representation: DestinationRepresentation::ManualMarkdown,
            publication: DestinationPublication::ManualImport,
            canonical_behavior: "The canonical URL must be checked during Medium import.",
            workflow: "Manual import only; this adapter does not write remotely.",
            content_subset: DestinationContentSubset::ManualCommonmark,
            media_delivery: DestinationMediaDelivery::HostedUrlsOnly,
            conversion_review: "Portable Markdown and a canonical URL are review artifacts, not a Medium API payload. Use the canonical URL in Medium's importer and check attribution, structure, images and canonical settings manually.",
            max_tags: None,
            max_tag_name_chars: None,
            max_request_body_bytes: None,
        },
    }
}

pub fn destination_policies() -> [DestinationPolicy; 5] {
    [
        SyndicationProvider::Dev,
        SyndicationProvider::Hashnode,
        SyndicationProvider::Ghost,
        SyndicationProvider::Wordpress,
        SyndicationProvider::Medium,
    ]
    .map(destination_policy)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepresentationFormat {
    Html,
    Markdown,
    Text,
}

/// A deterministic, offline view of a public post and its portable context.
///
/// The view borrows the canonical post content; selecting a representation never
/// rewrites the source or parses generated HTML.
#[derive(Debug)]
pub struct PortableProjection<'a> {
    canonical_url: String,
    base_url: String,
    title: &'a str,
    subtitle: Option<&'a str>,
    source_path: &'a str,
    source_url: Option<&'a str>,
    /// The native page's "Originally published at" notice, when it has one.
    source_notice: Option<String>,
    credit_provenance: CreditProvenance,
    credits: &'a [ResolvedCredit],
    references: &'a [ResearchReference],
    research: Option<&'a ResearchMetadata>,
    shared: Option<&'a crate::shared_source::SharedAttribution>,
    capabilities: &'a [CapabilityDescriptor],
    html: &'a str,
    markdown: &'a str,
    text: &'a str,
    render_options: RenderOptions<'static>,
    /// Languages the canonical page can run; `None` without a configured runner.
    runner_languages: Option<Vec<String>>,
    video: Option<&'a VideoMetadata>,
    recipe: Option<&'a Recipe>,
    /// Reader discussion the canonical page offers, when it offers any.
    participation: Option<CommentsPolicy>,
    /// The post's place in a collaborative series, when it is a part of one (ADR 0041).
    series: Option<SeriesContext>,
    /// The claim evidence the post publishes (ADR 0075), which every portable
    /// artifact must carry whole.
    claim_evidence: Option<&'a crate::claim_publication::PostEvidence>,
    /// The published suggested sources and corrections with their outcome (ADR 0119): what a
    /// portable copy carries of reader notes, beside the link to the canonical discussion.
    outcomes: Vec<&'a crate::feedback_publication::PublicFeedback>,
    /// The post's slug, which names it in the curated context.
    slug: &'a str,
    /// The public curated context this post is offered (ADR 0202), which every
    /// portable artifact must carry whole. Only `for_site` attaches it, from
    /// the site's public curated value and from nothing else.
    curated: Option<std::sync::Arc<crate::curated_context::CuratedContext>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortableHtmlOutput {
    pub html: String,
    pub capabilities: Vec<CapabilityDescriptor>,
    pub diagnostics: Vec<PortabilityDiagnostic>,
    pub images: Vec<PortableImage>,
    pub has_raw_html: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortableImage {
    pub url: String,
    pub raw_html: bool,
}

pub(crate) struct SemanticFact {
    capability: &'static str,
    field: &'static str,
    value: String,
    markdown_value: Option<String>,
    link_label: Option<String>,
    html_link_label: Option<String>,
    text_link_label: Option<String>,
    link_kind: SemanticLinkKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SemanticLinkKind {
    Anchor,
    Image,
}

impl SemanticFact {
    pub(crate) fn new(
        capability: &'static str,
        field: &'static str,
        value: impl Into<String>,
    ) -> Self {
        Self {
            capability,
            field,
            value: value.into(),
            markdown_value: None,
            link_label: None,
            html_link_label: None,
            text_link_label: None,
            link_kind: SemanticLinkKind::Anchor,
        }
    }

    pub(crate) fn with_markdown_value(mut self, value: String) -> Self {
        self.markdown_value = Some(value);
        self
    }

    pub(crate) fn with_link_label(mut self, label: String) -> Self {
        self.link_label = Some(label);
        self
    }

    pub(crate) fn with_html_link_label(mut self, label: String) -> Self {
        self.html_link_label = Some(label);
        self
    }

    pub(crate) fn with_text_link_label(mut self, label: String) -> Self {
        self.text_link_label = Some(label);
        self
    }

    pub(crate) fn with_link_kind(mut self, kind: SemanticLinkKind) -> Self {
        self.link_kind = kind;
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortabilityDiagnostic {
    pub code: String,
    pub severity: DiagnosticSeverity,
    pub source_path: String,
    pub capability_id: Option<String>,
    pub message: String,
    pub recommended_action: String,
    #[serde(flatten)]
    pub context: DiagnosticContext,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticContext {
    pub representation: Option<String>,
    pub destination: Option<String>,
    pub portability_level: Option<PortabilityLevel>,
    pub affected_semantics: Option<String>,
    pub source_range: Option<SourceRange>,
}

/// One-based Unicode-character positions in the authored Markdown body, not front matter.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

impl PortabilityDiagnostic {
    pub fn scoped(&self, representation: &str, destination: &str) -> Self {
        let mut diagnostic = self.clone();
        diagnostic.context.representation = Some(representation.into());
        diagnostic.context.destination = Some(destination.into());
        diagnostic
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationTagPlan {
    pub policy: DestinationPolicy,
    pub tags: Vec<String>,
    pub omitted_tags: Vec<String>,
    pub diagnostics: Vec<PortabilityDiagnostic>,
}

impl DestinationTagPlan {
    pub fn validate(&self) -> Result<(), String> {
        validate_destination_diagnostics(self.policy, &self.diagnostics)
    }
}

fn validate_destination_diagnostics(
    policy: DestinationPolicy,
    diagnostics: &[PortabilityDiagnostic],
) -> Result<(), String> {
    if let Some(diagnostic) = diagnostics
        .iter()
        .find(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
    {
        return Err(format!(
            "{}: {} [{}] {} Action: {}",
            diagnostic.source_path,
            policy.label,
            diagnostic.code,
            diagnostic.message,
            diagnostic.recommended_action,
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationPayloadPlan {
    pub policy: DestinationPolicy,
    pub body_bytes: usize,
    pub diagnostics: Vec<PortabilityDiagnostic>,
}

impl DestinationPayloadPlan {
    pub fn validate(&self) -> Result<(), String> {
        validate_destination_diagnostics(self.policy, &self.diagnostics)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationContentPlan {
    pub policy: DestinationPolicy,
    /// Resolved retained image URLs; no remote media bytes have been inspected.
    pub images: Vec<String>,
    pub diagnostics: Vec<PortabilityDiagnostic>,
}

impl DestinationContentPlan {
    pub fn validate(&self) -> Result<(), String> {
        validate_destination_diagnostics(self.policy, &self.diagnostics)
    }
}

pub fn destination_content_plan(
    provider: SyndicationProvider,
    source_path: &str,
    output: &PortableHtmlOutput,
) -> DestinationContentPlan {
    let policy = destination_policy(provider);
    let representation = match policy.representation {
        DestinationRepresentation::PortableMarkdown => "portable-markdown",
        DestinationRepresentation::PortableHtml => "portable-html",
        DestinationRepresentation::ManualMarkdown => "manual-markdown",
    };
    let mut diagnostics = Vec::new();
    let images = output
        .images
        .iter()
        .filter(|image| {
            policy.representation == DestinationRepresentation::PortableHtml || !image.raw_html
        })
        .map(|image| image.url.clone())
        .collect::<Vec<_>>();
    let mut report = |code: &str,
                      severity,
                      capability_id: Option<&str>,
                      message: String,
                      action: &str| {
        diagnostics.push(PortabilityDiagnostic {
            code: code.into(),
            severity,
            source_path: source_path.into(),
            capability_id: capability_id.map(str::to_string),
            message,
            recommended_action: action.into(),
            context: DiagnosticContext {
                destination: Some(policy.label.to_lowercase()),
                representation: Some(representation.into()),
                affected_semantics: Some("The canonical article and portable artifact remain unchanged; remote rendering and hosted-media acceptance require review.".into()),
                ..Default::default()
            },
        });
    };
    if !images.is_empty() {
        for image in &images {
            if !Url::parse(image).is_ok_and(|url| matches!(url.scheme(), "http" | "https")) {
                report("destination-image-url-invalid", DiagnosticSeverity::Error, Some("media"),
                    format!("{} cannot use image URL {image:?}; hosted images must use HTTP(S).", policy.label),
                    "Replace this image destination with a public HTTP(S) image URL. No image is dropped or rewritten to make the request pass.");
            }
        }
        report(
            "destination-media-unverified",
            DiagnosticSeverity::Warning,
            Some("media"),
            format!("{} receives hosted image references only. {} retained image reference(s) have not been fetched, uploaded or checked for reachability, type or byte size. URLs cannot certify destination media limits.", policy.label, images.len()),
            if provider == SyndicationProvider::Hashnode {
                "Inspect images in the remote draft. Hashnode's separate 8 MB image-upload limit (image types only, no SVG) is not certification of linked inline images."
            } else {
                "Inspect images in the remote draft or manual import; this adapter does not upload media or certify provider-specific media limits."
            },
        );
    }
    if matches!(
        provider,
        SyndicationProvider::Ghost | SyndicationProvider::Wordpress | SyndicationProvider::Medium
    ) {
        report("destination-conversion-review", DiagnosticSeverity::Warning, None, policy.conversion_review.into(),
            "Review the destination copy before publication; do not assume source HTML, anchors or canonical settings survive unchanged.");
    }
    if provider == SyndicationProvider::Wordpress {
        report("destination-canonical-unsupported", DiagnosticSeverity::Warning, None, policy.canonical_behavior.into(),
            "Configure and verify a supported SEO plugin manually; the adapter cannot set an external canonical URL through WordPress core.");
    }
    if policy.representation != DestinationRepresentation::PortableHtml && output.has_raw_html {
        report("destination-raw-html-literal", DiagnosticSeverity::Warning, Some("raw-html"),
            "Authored raw HTML is shown as literal text in the Markdown artifact, not rendered media or layout. Markdown images remain image references.".into(),
            "Review literal HTML examples in the Markdown copy; author important images and structure in Markdown when they must render on this destination.");
    }
    DestinationContentPlan {
        policy,
        images,
        diagnostics,
    }
}

/// Measure serialized UTF-8 request bytes, including provider envelope overhead.
pub fn destination_payload_plan(
    provider: SyndicationProvider,
    source_path: &str,
    body_bytes: usize,
) -> DestinationPayloadPlan {
    let policy = destination_policy(provider);
    let mut diagnostics = Vec::new();
    if let Some(limit) = policy
        .max_request_body_bytes
        .filter(|limit| body_bytes > *limit)
    {
        diagnostics.push(PortabilityDiagnostic {
            code: "destination-payload-limit".into(),
            severity: DiagnosticSeverity::Error,
            source_path: source_path.into(),
            capability_id: None,
            message: format!("{} request body is {body_bytes} UTF-8 bytes, exceeding the {limit}-byte adapter limit.", policy.label),
            recommended_action: "Reduce the portable content or metadata and review a fresh dry run; content is never truncated to fit.".into(),
            context: DiagnosticContext {
                destination: Some(policy.label.to_lowercase()),
                representation: Some("provider-request".into()),
                affected_semantics: Some("The complete provider request cannot be sent without exceeding its limit; no content is truncated.".into()),
                ..Default::default()
            },
        });
    }
    DestinationPayloadPlan {
        policy,
        body_bytes,
        diagnostics,
    }
}

/// Project only adapter tag metadata; this is not a feed or body conversion.
pub fn destination_tag_plan(
    provider: SyndicationProvider,
    source_path: &str,
    tags: &[String],
) -> DestinationTagPlan {
    let policy = destination_policy(provider);
    let maps_tags = matches!(
        provider,
        SyndicationProvider::Dev | SyndicationProvider::Hashnode
    );
    let limit = if maps_tags {
        policy.max_tags.unwrap_or(tags.len()).min(tags.len())
    } else {
        0
    };
    let mut plan = DestinationTagPlan {
        policy,
        tags: tags[..limit].to_vec(),
        omitted_tags: tags[limit..].to_vec(),
        diagnostics: Vec::new(),
    };
    let mut report = |code: &str, severity, message: String, action: &str| {
        plan.diagnostics.push(PortabilityDiagnostic {
            code: code.into(),
            severity,
            source_path: source_path.into(),
            capability_id: None,
            message,
            recommended_action: action.into(),
            context: DiagnosticContext {
                destination: Some(policy.label.to_lowercase()),
                representation: Some("provider-tags".into()),
                affected_semantics: Some("Destination discovery metadata; the canonical source tags and body remain unchanged.".into()),
                ..Default::default()
            },
        });
    };
    if !maps_tags && !plan.omitted_tags.is_empty() {
        report(
            "destination-tags-not-mapped",
            DiagnosticSeverity::Warning,
            format!("{} does not receive tag metadata from this adapter; all {} source tags are omitted. This is an adapter limitation, not a provider tag-count limit.", policy.label, plan.omitted_tags.len()),
            "Review and assign tags manually in the destination. The canonical source tags remain unchanged.",
        );
    } else if !plan.omitted_tags.is_empty() {
        report(
            "destination-tag-limit",
            DiagnosticSeverity::Warning,
            format!("{} accepts at most {limit} tags; {} trailing tags are omitted from the payload.", policy.label, plan.omitted_tags.len()),
            "Review the selected and omitted tags in the destination plan; reorder or reduce source tags if needed.",
        );
    }
    let mut slugs = std::collections::HashSet::new();
    for tag in &plan.tags {
        match provider {
            SyndicationProvider::Dev => {
                if tag.is_empty()
                    || !tag.chars().all(char::is_alphanumeric)
                    || policy
                        .max_tag_name_chars
                        .is_some_and(|max| tag.chars().count() > max)
                {
                    report(
                        "destination-tag-invalid",
                        DiagnosticSeverity::Error,
                        format!("DEV tag {tag:?} must contain only letters/numbers and at most 30 characters."),
                        "Choose a valid DEV tag in the source; tags are not silently rewritten.",
                    );
                }
            }
            SyndicationProvider::Hashnode => {
                let slug = crate::slug::slugify(tag);
                if slug.is_empty() || !slugs.insert(slug.clone()) {
                    report(
                        "destination-tag-slug",
                        DiagnosticSeverity::Error,
                        format!("Hashnode tag {tag:?} has an empty or duplicate destination slug {slug:?}."),
                        "Choose tags with distinct nonempty slugs; tags are not silently merged.",
                    );
                } else if slug != *tag {
                    report(
                        "destination-tag-slug",
                        DiagnosticSeverity::Info,
                        format!("Hashnode tag {tag:?} is sent with slug {slug:?}; its display name is retained."),
                        "Review the destination slug; the canonical source is unchanged.",
                    );
                }
            }
            _ => {}
        }
    }
    plan
}

impl<'a> PortableProjection<'a> {
    pub fn from_post(post: &'a Post, config: &SiteConfig) -> Result<Self, String> {
        Self::new(post, config, false)
    }

    /// The public projection of one of `site`'s posts, with the post's collaborative series
    /// context when it has one (ADR 0041). Feeds, exports and syndication use this, so every
    /// external copy of a part of a collaborative series names and links its series; any other
    /// post's projection is exactly `from_post`'s.
    pub fn for_site(site: &Site, post: &'a Post) -> Result<Self, String> {
        Ok(Self::from_post(post, &site.config)?
            .with_series(site.series_context(post))
            .with_curated(site.curated_context_for(post)))
    }

    /// The same projection carrying `context`, the public curated context the
    /// post is offered (ADR 0202). `None` removes it, and the copies are then
    /// exactly what they were without it.
    pub fn with_curated(
        mut self,
        context: Option<std::sync::Arc<crate::curated_context::CuratedContext>>,
    ) -> Self {
        self.curated = context;
        self
    }

    /// The same projection stating `series` as the post's series context. `None` removes it.
    pub fn with_series(mut self, series: Option<SeriesContext>) -> Self {
        self.series = series;
        self
    }

    /// The collaborative series context this projection states, if any.
    pub fn series(&self) -> Option<&SeriesContext> {
        self.series.as_ref()
    }

    /// Build an unpublished projection for the authenticated Admin preview only.
    /// Public feeds and exports must use `from_post`, which rejects drafts.
    pub fn for_authenticated_preview(post: &'a Post, config: &SiteConfig) -> Result<Self, String> {
        Self::new(post, config, true)
    }

    fn new(post: &'a Post, config: &SiteConfig, allow_draft: bool) -> Result<Self, String> {
        if post.draft && !allow_draft {
            return Err(format!(
                "{}: drafts cannot be included in a public portable projection",
                post.source
            ));
        }

        let base_url = format!("{}/", config.url.trim_end_matches('/'));
        let base = Url::parse(&base_url)
            .map_err(|_| format!("{}: site base URL is invalid", post.source))?;
        validate_http_url(&base, false)
            .map_err(|_| format!("{}: site base URL must be absolute HTTP(S)", post.source))?;

        let canonical_url = config.absolute(&post.url);
        let canonical = Url::parse(&canonical_url)
            .map_err(|_| format!("{}: canonical URL is invalid", post.source))?;
        validate_http_url(&canonical, false)
            .map_err(|_| format!("{}: canonical URL must be absolute HTTP(S)", post.source))?;

        let references = post
            .research
            .as_ref()
            .map(|research| research.references.as_slice())
            .unwrap_or_default();

        Ok(Self {
            canonical_url,
            base_url: config.url.clone(),
            title: &post.title,
            subtitle: post.subtitle.as_deref(),
            source_path: &post.source,
            source_url: post.source_url.as_deref(),
            source_notice: post.source_notice_html(),
            credit_provenance: post.credit_provenance,
            credits: &post.credits,
            references,
            research: post.research.as_ref(),
            shared: post.shared_attribution.as_ref(),
            capabilities: &post.capabilities,
            html: &post.html,
            markdown: post.portable_markdown(),
            text: &post.text,
            render_options: RenderOptions {
                smart_punctuation: config.markdown.smart_punctuation,
                lazy_images: true,
                heading_anchors: config.markdown.heading_anchors,
                embeds: false,
                recipe: post.recipe.is_some(),
                code_runner: None,
                // Portable copies show sandboxes as static code, so no libraries load.
                web_libraries: None,
                playground_link: config.code.playground_link,
                // Generated notes are ordinary footnotes here, linked to the canonical article.
                citation_notes: None,
                // The section is ordinary content in a portable copy.
                claim_evidence_section: false,
                supplements: post.reading_depth.is_some(),
                // A copy that leaves the site cannot resolve an entry: its
                // Markdown already holds each concept link as its label.
                concept_links: false,
            },
            runner_languages: (!config.code_runner.endpoint.is_empty())
                .then(|| config.code_runner.languages.clone()),
            video: post.video.as_ref(),
            recipe: post.recipe.as_ref(),
            participation: (crate::participation::effective_mode(
                config,
                post,
                crate::participation::ParticipationKind::Comment,
            ) != crate::participation::ParticipationMode::Hidden)
                .then_some(post.comments),
            series: None,
            claim_evidence: post.claim_evidence(),
            outcomes: post
                .reader_feedback()
                .iter()
                .filter(|item| item.outcome.is_some())
                .collect(),
            slug: &post.slug,
            curated: None,
        })
    }

    pub(crate) fn markdown_context(&self) -> PortableContext<'_> {
        PortableContext {
            canonical_url: &self.canonical_url,
            chapters: self.video.is_some(),
            video_id: self.video.and_then(|video| video.youtube_id.as_deref()),
        }
    }

    pub fn canonical_url(&self) -> &str {
        &self.canonical_url
    }

    pub fn source_revision(&self) -> Result<String, String> {
        let markdown = self.portable_markdown()?;
        let mut hasher = Blake2b512::new();
        hasher.update(b"openblog-portability-source-v1\0");
        hasher.update(self.canonical_url.as_bytes());
        hasher.update(b"\0");
        hasher.update(markdown.as_bytes());
        Ok(hasher
            .finalize()
            .iter()
            .take(20)
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn source_path(&self) -> &str {
        self.source_path
    }

    pub fn source_url(&self) -> Option<&str> {
        self.source_url
    }

    pub fn credit_provenance(&self) -> CreditProvenance {
        self.credit_provenance
    }

    pub fn credits(&self) -> &[ResolvedCredit] {
        self.credits
    }

    pub fn authors(&self) -> impl Iterator<Item = &ResolvedCredit> {
        self.credits.iter().filter(|credit| {
            !credit.contributor.name.trim().is_empty()
                && credit.roles.iter().any(|role| role.is_author())
        })
    }

    pub fn references(&self) -> &[ResearchReference] {
        self.references
    }

    pub fn capabilities(&self) -> &[CapabilityDescriptor] {
        self.capabilities
    }

    pub fn representation(&self, format: RepresentationFormat) -> &'a str {
        match format {
            RepresentationFormat::Html => self.html,
            RepresentationFormat::Markdown => self.markdown,
            RepresentationFormat::Text => self.text,
        }
    }

    /// Render HTML from the canonical Markdown body without parsing native HTML.
    pub fn portable_html(&self) -> Result<PortableHtmlOutput, String> {
        // The canonical page's runner languages decide which fences are interactive
        // there; the portable fallback never carries the runner endpoint.
        let options = RenderOptions {
            code_runner: self.runner_languages.as_deref().map(|languages| {
                CodeRunnerRenderOptions {
                    endpoint: "",
                    languages,
                }
            }),
            ..self.render_options
        };
        let rendered = crate::markdown::render_portable(self.markdown, options, self)?;
        if !rendered.errors.is_empty() {
            return Err(format!(
                "{}: {}",
                self.source_path,
                rendered.errors.join("; ")
            ));
        }
        let mut html = String::new();
        let mut capabilities = rendered.capabilities;
        // The native page shows these beside the body, so they stay visible here:
        // explicit credits (a legacy site author is a byline, which consumers
        // take from `authors()`), then the work's DOI and license.
        if self.credit_provenance == CreditProvenance::ExplicitSidecar && !self.credits.is_empty() {
            html.push_str(&crate::contributor::contributions_html(
                self.credits,
                |url| self.resolve_link(url),
                None,
            )?);
        }
        if let Some(series) = &self.series {
            html.push_str(&self.series_context_html(series)?);
        }
        if let Some(research) = self.research {
            html.push_str(&research.work_meta_html());
        }
        if let Some(shared) = self.shared {
            html.push_str(&shared.html());
        }
        if let Some(video) = self.video {
            html.push_str(&video.production_notes_html());
        }
        // The native page adds the post's video beside the body; keep it as a link.
        let video_id = self.video.and_then(|video| video.youtube_id.as_deref());
        if let (Some(mut embed), Some(id)) = (
            self.video
                .and_then(|video| video.url.as_deref())
                .and_then(crate::embed::detect),
            video_id,
        ) {
            let embedded = rendered.portable_video_ids.iter().any(|known| known == id);
            if !embedded {
                embed.link_label = format!("{} on YouTube", self.title);
                html.push_str(&format!(
                    "<p class=\"ob-embed-link ob-embed-{}\"><a href=\"{}\">{}</a></p>\n",
                    embed.provider,
                    escape::attr(&embed.link),
                    escape::text(&embed.link_label)
                ));
            }
        }
        if let Some(recipe) = self.recipe {
            let facts = recipe.facts_html(false);
            if !facts.is_empty() {
                html.push_str(&format!(
                    "<section class=\"ob-recipe-card\" aria-label=\"Recipe summary\">\n<dl class=\"ob-recipe-facts\">{facts}</dl>\n</section>\n"
                ));
            }
        }
        html.push_str(&rendered.html);
        if let Some(section) = self.curated_section(RepresentationFormat::Html) {
            html.push_str(&section.text);
        }
        html.push_str(&self.outcomes_html());
        // A capability the canonical page offers without a portable fallback yet
        // (a planned or unknown structure) fails closed: its authored content
        // stays visible as ordinary Markdown, and a labeled link points to the
        // canonical article. Each is reported once. Private state (a protected
        // draft, a reader annotation) adds nothing and is not reported either,
        // so a destination reading the loss report cannot learn it exists.
        // The note is article-level: nothing locates these blocks until their
        // owning stories ship detection, so it follows the whole body.
        let mut labels = Vec::new();
        for capability in self.capabilities {
            if capability.has_portable_fallback() {
                continue;
            }
            let Some(label) = capability.portable_label() else {
                continue;
            };
            if !capabilities.iter().any(|known| known.id == capability.id) {
                capabilities.push(capability.clone());
            }
            if !labels.contains(&label) {
                labels.push(label);
                let (href, verb) = self.capability_link(capability);
                html.push_str(&format!(
                    "<p class=\"ob-portable-note\"><strong>{}</strong>: {verb} <a href=\"{}\">the original article</a>.</p>\n",
                    escape::text(label),
                    escape::attr(&href)
                ));
            }
        }
        // Provenance is untrusted metadata: only a plain web address is published.
        if let (Some(source_url), Some(notice)) = (self.source_url, &self.source_notice) {
            Url::parse(source_url)
                .ok()
                .filter(|url| validate_http_url(url, true).is_ok())
                .ok_or_else(|| {
                    format!(
                        "{}: sourceUrl must be an absolute HTTP(S) URL without credentials",
                        self.source_path
                    )
                })?;
            html.push_str(notice);
        }
        // Discussion stays on the canonical page: link there rather than to a
        // form that cannot work here, and never name the hosted endpoint.
        if let Some(policy) = self.participation {
            let href = escape::attr(&self.participation_url());
            html.push_str(&if policy == CommentsPolicy::Locked {
                format!("<p class=\"ob-participation\">Comments are closed. <a href=\"{href}\">Read the discussion on the original article</a>.</p>\n")
            } else {
                format!("<p class=\"ob-participation\"><a href=\"{href}\">Join the discussion on the original article</a>.</p>\n")
            });
            capabilities.push(CapabilityDescriptor::describe(
                "comments",
                Some("ob-comments"),
            ));
        }
        // Destinations reject or cut oversized bodies; fail rather than lose the end.
        if html.len() > MAX_PORTABLE_HTML_BYTES {
            return Err(format!(
                "{}: portable HTML is {} bytes, over the {MAX_PORTABLE_HTML_BYTES}-byte bound; split the post or move large inline content into files (nothing was truncated)",
                self.source_path,
                html.len()
            ));
        }
        self.ensure_semantics(RepresentationFormat::Html, &html)?;
        let mut diagnostics =
            portability_diagnostics(self.source_path, self.markdown, &capabilities);
        diagnostics.extend(self.curated_diagnostics());
        // A layout places the same turns differently; no portable form can. Say so, once, rather
        // than let the placement disappear silently (ADR 0033).
        if let Some(arrangement) = self.arrangement() {
            if arrangement.layout != crate::reflection::ReflectionLayout::Sequential {
                diagnostics.push(PortabilityDiagnostic {
                    code: "reflection-layout-sequenced".into(),
                    severity: DiagnosticSeverity::Info,
                    source_path: self.source_path.into(),
                    capability_id: Some("reflection".into()),
                    message: format!(
                        "The {} layout places turns side by side or staggered on the canonical page; portable copies show the same turns as labeled sections in reading order.",
                        arrangement.layout.key()
                    ),
                    recommended_action: "No action needed: every round prompt, author, label and turn is kept in order; only the placement is not.".into(),
                    context: DiagnosticContext {
                        representation: Some("portable-html".into()),
                        destination: Some("portable-export".into()),
                        portability_level: Some(PortabilityLevel::GracefullyTransformed),
                        affected_semantics: Some("Turn placement (columns, stagger) on wide screens; reading order, authorship, labels and prompts are unchanged.".into()),
                        source_range: None,
                    },
                });
            }
        }
        Ok(PortableHtmlOutput {
            html,
            capabilities,
            diagnostics,
            images: rendered.portable_images,
            // A parsed arrangement's or moments block's frame is open.blog's own markup, not
            // authored raw HTML: the Markdown copy states it without HTML, so only literal HTML
            // in the authors' own text counts.
            has_raw_html: if self.arrangement().is_some() || self.moments().is_some() {
                escape_raw_html(&self.portable_source()).1 > 0
            } else {
                rendered.portable_has_raw_html
            },
        })
    }

    /// Derive a CommonMark-oriented article from the authored Markdown and
    /// public work metadata. No generated HTML is parsed to reconstruct content.
    pub fn portable_markdown(&self) -> Result<String, String> {
        let html = self.portable_html()?;
        let source = self.portable_source();
        let (body, raw_html_count) = escape_raw_html(&source);
        let body = portable_markdown_body(&body, self)
            .map_err(|error| format!("{}: {error}", self.source_path))?;
        let mut output = format!(
            "# {}\n\nCanonical: <{}>\n\n",
            markdown_text(self.title),
            self.canonical_url
        );
        if let Some(subtitle) = self.subtitle {
            if !subtitle.trim().is_empty() {
                output.push_str(&format!("{}\n\n", markdown_text(subtitle)));
            }
        }
        output.push_str(body.trim());
        output.push('\n');

        if self.credit_provenance == CreditProvenance::ExplicitSidecar && !self.credits.is_empty() {
            output.push_str("\n## Contributions\n\n");
            for credit in self.credits {
                let name = markdown_text(&credit.contributor.name);
                let name = if credit.contributor.url.trim().is_empty() {
                    name
                } else {
                    format!(
                        "[{name}]({})",
                        markdown_destination(&self.resolve_link(credit.contributor.url.trim())?)
                    )
                };
                let roles = credit
                    .roles
                    .iter()
                    .map(|role| role.label())
                    .collect::<Vec<_>>()
                    .join(", ");
                let orcid = if credit.contributor.orcid.trim().is_empty() {
                    String::new()
                } else {
                    format!("; ORCID {} (unauthenticated)", credit.contributor.orcid)
                };
                output.push_str(&format!("- {name} — {roles}{orcid}\n"));
            }
            output.push('\n');
        }

        if let Some(series) = &self.series {
            if !output.ends_with("\n\n") {
                output.push('\n');
            }
            output.push_str("## Series\n\n");
            output.push_str(&self.series_context_markdown(series)?);
            output.push_str("\n\n");
        }

        if let Some(research) = self.research {
            let mut facts = Vec::new();
            if let (Some(doi), Some(url)) = (&research.doi, &research.doi_url) {
                facts.push(format!(
                    "- DOI: [{}]({})",
                    markdown_text(doi),
                    markdown_destination(&self.resolve_link(url)?)
                ));
            }
            if let Some(url) = &research.license_url {
                facts.push(format!(
                    "- License: [{}]({})",
                    markdown_text(url),
                    markdown_destination(&self.resolve_link(url)?)
                ));
            }
            if !facts.is_empty() {
                output.push_str("## Work details\n\n");
                output.push_str(&facts.join("\n"));
                output.push_str("\n\n");
            }
        }

        if let Some(video) = self.video {
            let mut facts = Vec::new();
            if let Some(label) = video.production_label() {
                facts.push(format!("- Episode: {}", markdown_text(&label)));
            }
            if let Some(status) = &video.production_status {
                facts.push(format!("- Production status: {}", markdown_text(status)));
            }
            if let Some(credits) = &video.production_credits {
                facts.push(format!("- Production credits: {}", markdown_text(credits)));
            }
            if let Some(url) = &video.url {
                facts.push(format!(
                    "- Video: [{}]({})",
                    markdown_text(self.title),
                    markdown_destination(&self.resolve_link(url)?)
                ));
            }
            if !facts.is_empty() {
                output.push_str("## Video details\n\n");
                output.push_str(&facts.join("\n"));
                output.push_str("\n\n");
            }
        }

        if let Some(recipe) = self.recipe {
            let mut facts = Vec::new();
            for (label, minutes, written) in [
                ("Prep", recipe.prep, recipe.prep_text.as_deref()),
                ("Cook", recipe.cook, recipe.cook_text.as_deref()),
                ("Total", recipe.total, recipe.total_text.as_deref()),
            ] {
                if let Some(value) = minutes
                    .map(crate::recipe::format_minutes)
                    .or_else(|| written.map(str::to_string))
                {
                    facts.push(format!("- {label}: {}", markdown_text(&value)));
                }
            }
            for (label, value) in [
                ("Serves", recipe.servings_text.as_deref()),
                ("Makes", recipe.yield_text.as_deref()),
                ("Cuisine", recipe.cuisine.as_deref()),
                ("Course", recipe.category.as_deref()),
                ("Calories", recipe.calories.as_deref()),
            ] {
                if let Some(value) = value {
                    facts.push(format!("- {label}: {}", markdown_text(value)));
                }
            }
            if !facts.is_empty() {
                output.push_str("## Recipe details\n\n");
                output.push_str(&facts.join("\n"));
                output.push_str("\n\n");
            }
        }

        if let Some(shared) = self.shared {
            output.push_str(
                "## Shared reflection source

",
            );
            if let Some(question) = &shared.question {
                output.push_str(&format!(
                    "Guiding question: {}

",
                    markdown_text(question)
                ));
            }
            if let Some(source) = &shared.source {
                let name = match &source.url {
                    Some(url) => format!(
                        "[{}]({})",
                        markdown_text(&source.title),
                        markdown_destination(&self.resolve_link(url)?)
                    ),
                    None => markdown_text(&source.title),
                };
                output.push_str(&format!(
                    "Source ({}): {name}

",
                    source.kind.label()
                ));
            }
        }

        if let Some(section) = self.curated_section(RepresentationFormat::Markdown) {
            if !output.ends_with("\n\n") {
                output.push('\n');
            }
            output.push_str(&section.text);
        }

        output.push_str(&self.outcomes_markdown());

        if let (Some(source_url), Some(_)) = (self.source_url, &self.source_notice) {
            output.push_str(&format!(
                "Originally published at <{}>.\n\n",
                markdown_destination(&self.resolve_link(source_url)?)
            ));
        }

        if raw_html_count > 0 {
            output.push_str(&format!(
                "> **Portable export note:** {raw_html_count} raw HTML fragment(s) are shown as literal source because this Markdown export does not execute or preserve raw HTML. View the [canonical article]({}).\n\n",
                markdown_destination(&self.canonical_url)
            ));
        }
        for diagnostic in html
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == "graceful-transformation")
        {
            let capability = diagnostic.capability_id.as_deref().unwrap_or_default();
            output.push_str(&format!(
                "> **Portable fallback:** {}. Review: {}\n\n",
                markdown_text(transformation_summary(capability)),
                markdown_text(&diagnostic.recommended_action)
            ));
        }
        for capability in &html.capabilities {
            if capability.has_portable_fallback() || capability.portable_label().is_none() {
                continue;
            }
            let Some(label) = capability.portable_label() else {
                continue;
            };
            let (href, verb) = self.capability_link(capability);
            let note = if capability.id
                == crate::perspective_publication::THIRD_PERSPECTIVES_CAPABILITY
            {
                format!(
                    "> **{label}:** {verb} the [canonical article]({}).\n\n",
                    markdown_destination(&href)
                )
            } else {
                format!(
                    "> **{label}:** this interaction is available on the [canonical article]({}).\n\n",
                    markdown_destination(&href)
                )
            };
            if !output.contains(&note) {
                output.push_str(&note);
            }
        }
        if let Some(policy) = self.participation {
            let label = if policy == CommentsPolicy::Locked {
                "Read the discussion on the canonical article"
            } else {
                "Join the discussion on the canonical article"
            };
            output.push_str(&format!(
                "[{label}]({})\n",
                markdown_destination(&self.participation_url())
            ));
        }

        if output.len() > MAX_PORTABLE_HTML_BYTES {
            return Err(format!(
                "{}: portable Markdown is {} bytes, over the {MAX_PORTABLE_HTML_BYTES}-byte bound; split the post or move large inline content into files (nothing was truncated)",
                self.source_path,
                output.len()
            ));
        }
        self.ensure_semantics(RepresentationFormat::Markdown, &output)?;
        Ok(output)
    }

    /// Compare a derived artifact with required public facts from canonical data.
    /// This reads output only to validate it, never to reconstruct authored meaning.
    pub fn analyze_portable_artifact(
        &self,
        format: RepresentationFormat,
        artifact: &str,
    ) -> Result<Vec<PortabilityDiagnostic>, String> {
        let representation = match format {
            RepresentationFormat::Html => "portable-html",
            RepresentationFormat::Markdown => "portable-markdown",
            RepresentationFormat::Text => "portable-text",
        };
        if artifact.len() > MAX_PORTABLE_HTML_BYTES {
            return Err(format!(
                "{}: {representation} exceeds the artifact size bound",
                self.source_path
            ));
        }
        let html = match format {
            RepresentationFormat::Html => Some(artifact.to_string()),
            RepresentationFormat::Markdown => {
                let mut html = String::new();
                pulldown_cmark::html::push_html(
                    &mut html,
                    Parser::new_ext(artifact, crate::markdown::parser_options(false)),
                );
                Some(html)
            }
            RepresentationFormat::Text => None,
        };
        let content = html
            .as_deref()
            .map(crate::raw_html::semantic_content)
            .unwrap_or_else(|| artifact.to_string());
        let all_links = html
            .as_deref()
            .map(crate::raw_html::semantic_links)
            .unwrap_or_default();
        let mut links = all_links.clone();
        let mut metadata_links = all_links;
        let normalize = |value: &str| {
            value
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
        };
        let content = normalize(&content);
        let mut text_link_obligations = std::collections::HashMap::new();
        let mut options = self.render_options;
        options.smart_punctuation &= format == RepresentationFormat::Html;
        let mut facts = crate::markdown::portable_semantic_facts(self.markdown, options, self)
            .map_err(|error| format!("{}: {error}", self.source_path))?;
        if self.credit_provenance == CreditProvenance::ExplicitSidecar {
            for credit in self.credits {
                facts.push(SemanticFact::new(
                    "credits",
                    "contributor name",
                    &credit.contributor.name,
                ));
                if !credit.contributor.url.trim().is_empty() {
                    facts.push(SemanticFact::new(
                        "credits",
                        "source link",
                        self.resolve_link(credit.contributor.url.trim())?,
                    ));
                }
                for role in &credit.roles {
                    facts.push(SemanticFact::new(
                        "credits",
                        "contributor role",
                        role.label(),
                    ));
                }
                if !credit.contributor.orcid.is_empty() {
                    facts.push(SemanticFact::new(
                        "credits",
                        "contributor identifier",
                        &credit.contributor.orcid,
                    ));
                    facts.push(SemanticFact::new(
                        "credits",
                        "identifier provenance",
                        "unauthenticated",
                    ));
                }
            }
        }
        if let Some(series) = &self.series {
            facts.push(
                SemanticFact::new("series", "series link", self.resolve_link(&series.url)?)
                    .with_link_label(series.name.clone()),
            );
            facts.push(SemanticFact::new(
                "series",
                "series position",
                series_position(series),
            ));
            for name in &series.part_authors {
                facts.push(SemanticFact::new("series", "part author", name));
            }
            for name in &series.contributors {
                facts.push(SemanticFact::new("series", "series contributor", name));
            }
        }
        if let Some(research) = self.research {
            if let (Some(doi), Some(_)) = (&research.doi, &research.doi_url) {
                facts.push(SemanticFact::new("research", "work identifier", doi));
            }
            if let Some(license) = &research.license_url {
                facts.push(SemanticFact::new(
                    "research",
                    "license",
                    self.resolve_link(license)?,
                ));
            }
        }
        if let Some(shared) = self.shared {
            if let Some(question) = &shared.question {
                facts.push(SemanticFact::new(
                    "shared-source",
                    "guiding question",
                    question,
                ));
            }
            if let Some(source) = &shared.source {
                facts.push(SemanticFact::new(
                    "shared-source",
                    "source title",
                    &source.title,
                ));
                if let Some(url) = &source.url {
                    facts.push(SemanticFact::new(
                        "shared-source",
                        "source link",
                        self.resolve_link(url)?,
                    ));
                }
            }
        }
        let arrangement = self.arrangement();
        if let Some(arrangement) = &arrangement {
            for round in &arrangement.rounds {
                if let Some(prompt) = &round.prompt {
                    facts.push(SemanticFact::new("reflection", "round prompt", prompt));
                }
                for turn in &round.turns {
                    facts.push(SemanticFact::new("reflection", "turn author", &turn.author));
                    if let Some(label) = &turn.label {
                        facts.push(SemanticFact::new("reflection", "turn label", label));
                    }
                }
            }
        }
        // Every published moment keeps where it is, who noted it, the quoted words with their
        // attribution, and its link with a label that names the source (ADR 0066).
        let moments = self.moments();
        if let Some(block) = &moments {
            for moment in &block.moments {
                facts.push(SemanticFact::new(
                    "media-moment",
                    "moment location",
                    &moment.location,
                ));
                facts.push(SemanticFact::new(
                    "media-moment",
                    "moment author",
                    format!("Noted by {}", moment.noted_by),
                ));
                if let Some(quotation) = &moment.quotation {
                    facts.push(SemanticFact::new(
                        "media-moment",
                        "quotation",
                        &quotation.text,
                    ));
                    facts.push(SemanticFact::new(
                        "media-moment",
                        "quotation attribution",
                        &quotation.attribution,
                    ));
                }
                if let Some(link) = &moment.link {
                    facts.push(
                        SemanticFact::new(
                            "media-moment",
                            "source link",
                            self.resolve_link(&link.href)?,
                        )
                        .with_link_label(link.label.clone()),
                    );
                }
            }
        }
        if let Some(source) = self.source_url {
            facts.push(SemanticFact::new(
                "provenance",
                "source link",
                self.resolve_link(source)?,
            ));
        }
        if let Some(video) = self.video {
            if let Some((url, embed)) = video
                .url
                .as_deref()
                .and_then(|url| crate::embed::detect(url).map(|embed| (url, embed)))
            {
                facts.push(
                    SemanticFact::new("video", "source link", embed.link)
                        .with_markdown_value(self.resolve_link(url)?),
                );
            }
            if let Some(label) = video.production_label() {
                facts.push(SemanticFact::new("video", "episode label", label));
            }
            for (field, value) in [
                ("production status", video.production_status.as_deref()),
                ("production credits", video.production_credits.as_deref()),
            ] {
                if let Some(value) = value {
                    facts.push(SemanticFact::new("video", field, value));
                }
            }
        }
        if let Some(recipe) = self.recipe {
            for (minutes, written) in [
                (recipe.prep, &recipe.prep_text),
                (recipe.cook, &recipe.cook_text),
                (recipe.total, &recipe.total_text),
            ] {
                if let Some(value) = minutes
                    .map(crate::recipe::format_minutes)
                    .or_else(|| written.clone())
                {
                    facts.push(SemanticFact::new("recipe", "duration", value));
                }
            }
            for value in [
                &recipe.servings_text,
                &recipe.yield_text,
                &recipe.cuisine,
                &recipe.category,
                &recipe.calories,
            ]
            .into_iter()
            .flatten()
            {
                facts.push(SemanticFact::new("recipe", "summary fact", value));
            }
        }
        if self.participation.is_some() {
            facts.push(SemanticFact::new(
                "comments",
                "participation link",
                self.participation_url(),
            ));
        }
        // Every outcome keeps what it came to, the change it rests on, the evidence link and the
        // canonical discussion it belongs to (ADR 0119).
        for item in &self.outcomes {
            let Some(outcome) = &item.outcome else {
                continue;
            };
            facts.push(SemanticFact::new(
                "reader-outcome",
                "outcome",
                outcome.heading(),
            ));
            facts.push(SemanticFact::new(
                "reader-outcome",
                "source link",
                self.discussion_url(&item.id),
            ));
            if let Some(change) = &outcome.change {
                facts.push(SemanticFact::new(
                    "reader-outcome",
                    "revision note",
                    crate::feedback_publication::change_words(change),
                ));
            }
            if let Some(evidence) = &outcome.evidence {
                facts.push(SemanticFact::new(
                    "reader-outcome",
                    "source link",
                    format!("{}#{}", self.canonical_url, evidence.fragment),
                ));
            }
            if let Some(rationale) = &outcome.rationale {
                facts.push(SemanticFact::new(
                    "reader-outcome",
                    "author rationale",
                    rationale,
                ));
            }
        }
        let mut fallback_labels = std::collections::HashSet::new();
        for capability in self
            .capabilities
            .iter()
            .filter(|capability| !capability.has_portable_fallback())
        {
            if let Some(label) = capability.portable_label() {
                if !fallback_labels.insert(label) {
                    continue;
                }
                facts.push(SemanticFact::new(
                    "canonical-only-interaction",
                    "capability label",
                    label,
                ));
                facts.push(SemanticFact::new(
                    "canonical-only-interaction",
                    "canonical link",
                    self.capability_link(capability).0,
                ));
            }
        }
        let mut diagnostics = Vec::new();
        for fact in facts {
            // Markdown deliberately shows raw markup literally rather than the
            // HTML allowlist's reconstructed tags, attributes or replacement notes.
            if fact.capability == "raw-html" && format != RepresentationFormat::Html {
                continue;
            }
            let expected = if format == RepresentationFormat::Html {
                &fact.value
            } else {
                fact.markdown_value.as_ref().unwrap_or(&fact.value)
            };
            let value = if matches!(fact.field, "link or media target" | "source link")
                || (expected.starts_with("https://") && !expected.chars().any(char::is_whitespace))
            {
                Url::parse(expected)
                    .map(|url| url.to_string())
                    .unwrap_or_else(|_| expected.clone())
            } else {
                expected.clone()
            };
            let retained = if let Some(label) = &fact.link_label {
                if format == RepresentationFormat::Text {
                    let label = fact.text_link_label.as_ref().unwrap_or(label);
                    let target = if label == expected {
                        normalize(expected)
                    } else {
                        normalize(&format!("{label} ({expected})"))
                    };
                    let required = text_link_obligations
                        .entry(target.clone())
                        .or_insert(0usize);
                    *required += 1;
                    content.match_indices(&target).count() >= *required
                } else if let Some(index) = links.iter().position(|link| {
                    let target = canonical_target(&link.target);
                    let (value, expected) = (canonical_target(&value), canonical_target(expected));
                    let label = if format == RepresentationFormat::Html {
                        fact.html_link_label.as_ref().unwrap_or(label)
                    } else {
                        label
                    };
                    link.kind == fact.link_kind
                        && (target == value || target == expected)
                        && normalize(&link.label) == normalize(label)
                }) {
                    links.remove(index);
                    true
                } else {
                    false
                }
            } else {
                let is_url = matches!(
                    fact.field,
                    "source link"
                        | "canonical link"
                        | "participation link"
                        | "license"
                        | "citation target"
                ) && Url::parse(expected).is_ok();
                if is_url && format != RepresentationFormat::Text {
                    if let Some(index) = metadata_links.iter().position(|link| {
                        link.kind == SemanticLinkKind::Anchor
                            && (link.target == *expected
                                || canonical_target(&link.target) == canonical_target(&value))
                    }) {
                        metadata_links.remove(index);
                        true
                    } else {
                        false
                    }
                } else {
                    content.contains(&normalize(&value)) || content.contains(&normalize(expected))
                }
            };
            if retained {
                continue;
            }
            let diagnostic = PortabilityDiagnostic {
                code: "missing-semantic-fact".into(),
                severity: DiagnosticSeverity::Error,
                source_path: self.source_path.into(),
                capability_id: Some(fact.capability.into()),
                message: format!("The {representation} artifact is missing required {}.", fact.field),
                recommended_action: "Repair the projection before publishing; an acknowledgement cannot override missing substantive content.".into(),
                context: DiagnosticContext {
                    representation: Some(representation.into()),
                    destination: Some("portable-export".into()),
                    affected_semantics: Some(fact.field.into()),
                    ..Default::default()
                },
            };
            if !diagnostics.contains(&diagnostic) {
                diagnostics.push(diagnostic);
            }
        }
        // The moments must also come in their published order, each where-and-who pair together:
        // an equivalent that reorders them says something other than what was approved.
        if let Some(block) = &moments {
            let mut from = 0;
            let in_order = block.moments.iter().all(|moment| {
                let needle =
                    normalize(&format!("{} Noted by {}", moment.location, moment.noted_by));
                match content[from..].find(&needle) {
                    Some(at) => {
                        from += at + needle.len();
                        true
                    }
                    None => false,
                }
            });
            if !in_order {
                diagnostics.push(PortabilityDiagnostic {
                    code: "moment-order".into(),
                    severity: DiagnosticSeverity::Error,
                    source_path: self.source_path.into(),
                    capability_id: Some("media-moment".into()),
                    message: format!(
                        "The {representation} artifact does not keep the published moments, each with who noted it, in their approved order."
                    ),
                    recommended_action: "Repair the projection before publishing; the moments and their order are part of what each author approved.".into(),
                    context: DiagnosticContext {
                        representation: Some(representation.into()),
                        destination: Some("portable-export".into()),
                        affected_semantics: Some("moment order".into()),
                        ..Default::default()
                    },
                });
            }
        }
        // The same prompts, names and labels must also come in the arrangement's reading order:
        // an equivalent that reorders turns says something else (ADR 0033). Only the reflection's
        // own headings, labels and prompts are compared, never the credits or metadata, which
        // repeat the same names.
        if let Some(arrangement) = &arrangement {
            let squash = |value: &str| {
                value
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect::<String>()
            };
            let found = reflection_items(format, artifact);
            let mut candidates = found.iter();
            let mut in_order = true;
            'expected: for round in &arrangement.rounds {
                let mut wanted = Vec::new();
                if let Some(prompt) = &round.prompt {
                    wanted.push((ReflectionItem::Prompt, squash(prompt)));
                }
                for turn in &round.turns {
                    wanted.push((ReflectionItem::Author, squash(&turn.author)));
                    if let Some(label) = &turn.label {
                        wanted.push((ReflectionItem::Label, squash(label)));
                    }
                }
                for (kind, value) in wanted {
                    let matched = candidates.by_ref().any(|(found_kind, found_value)| {
                        (format == RepresentationFormat::Text || *found_kind == kind)
                            && squash(found_value) == value
                    });
                    if !matched {
                        in_order = false;
                        break 'expected;
                    }
                }
            }
            if !in_order {
                diagnostics.push(PortabilityDiagnostic {
                    code: "reflection-order".into(),
                    severity: DiagnosticSeverity::Error,
                    source_path: self.source_path.into(),
                    capability_id: Some("reflection".into()),
                    message: format!(
                        "The {representation} artifact does not keep the reflection's prompts, authors and labels in reading order."
                    ),
                    recommended_action: "Repair the projection before publishing; the reading order is part of what each author approved.".into(),
                    context: DiagnosticContext {
                        representation: Some(representation.into()),
                        destination: Some("portable-export".into()),
                        affected_semantics: Some("reading order".into()),
                        ..Default::default()
                    },
                });
            }
        }
        Ok(diagnostics)
    }

    fn ensure_semantics(&self, format: RepresentationFormat, artifact: &str) -> Result<(), String> {
        // Claim evidence fails closed: a copy that dropped or reordered any of
        // it could show support without its contradiction (ADR 0075).
        if let Some(evidence) = self.claim_evidence {
            if !crate::claim_publication::carried_whole(artifact, evidence) {
                return Err(format!(
                    "{} [claim-evidence-lost] claim-evidence: the {format:?} copy does not carry every published claim with its supporting and contradicting evidence; refusing to publish a partial copy",
                    self.source_path
                ));
            }
        }
        // The research context fails closed the same way (ADR 0202): a copy
        // that dropped an item, its anchor or any of its words would show a
        // view without the doubt that came with it.
        if let Some(section) = self.curated_section(format) {
            if let Some(missing) = section.first_missing(artifact) {
                return Err(format!(
                    "{} [curated-context-lost] curated-research-context: the {format:?} copy does not carry every selected research-context item with its words and its link to the canonical page (it lacks {missing}); refusing to publish a partial copy",
                    self.source_path
                ));
            }
        }
        let diagnostics = self.analyze_portable_artifact(format, artifact)?;
        if diagnostics.is_empty() {
            return Ok(());
        }

        Err(diagnostics
            .iter()
            .map(|diagnostic| {
                format!(
                    "{} [{}] {}: {}",
                    diagnostic.source_path,
                    diagnostic.code,
                    diagnostic.capability_id.as_deref().unwrap_or("content"),
                    diagnostic.message
                )
            })
            .collect::<Vec<_>>()
            .join("; "))
    }

    /// The series context as one paragraph: "Part 2 in the series <a>Letters</a>. This part is by
    /// A and B. Series contributors: A, B, and C." Every value is escaped text and the only link is
    /// the canonical series page (ADR 0041). It never states the number of parts, so a growing
    /// series does not change its earlier parts' copies.
    fn series_context_html(&self, series: &SeriesContext) -> Result<String, String> {
        let names = |names: &[String]| {
            crate::render::human_list(
                &names
                    .iter()
                    .map(|name| escape::text(name))
                    .collect::<Vec<_>>(),
            )
        };
        Ok(format!(
            "<p class=\"ob-series-context\">{} <a href=\"{}\">{}</a>.{}{}</p>\n",
            series_position(series),
            escape::attr(&self.resolve_link(&series.url)?),
            escape::text(&series.name),
            series_clause(" This part is by ", &names(&series.part_authors)),
            series_clause(" Series contributors: ", &names(&series.contributors)),
        ))
    }

    /// The same sentence as `series_context_html`, as escaped Markdown text and one link.
    fn series_context_markdown(&self, series: &SeriesContext) -> Result<String, String> {
        let names = |names: &[String]| {
            crate::render::human_list(
                &names
                    .iter()
                    .map(|name| markdown_text(name))
                    .collect::<Vec<_>>(),
            )
        };
        Ok(format!(
            "{} [{}]({}).{}{}",
            series_position(series),
            markdown_text(&series.name),
            markdown_destination(&self.resolve_link(&series.url)?),
            series_clause(" This part is by ", &names(&series.part_authors)),
            series_clause(" Series contributors: ", &names(&series.contributors)),
        ))
    }

    /// The post's research context as a portable copy writes it (ADR 0202),
    /// when the post is offered one: from the public curated value alone, with
    /// every link absolute and a link back to the canonical page's anchors.
    fn curated_section(
        &self,
        format: RepresentationFormat,
    ) -> Option<crate::curated_context::CopySection> {
        let context = self.curated.as_ref()?;
        let absolute = |href: &str| self.resolve_link(href);
        let links = crate::curated_context::CopyLinks {
            canonical: &self.canonical_url,
            absolute: &absolute,
        };
        match format {
            RepresentationFormat::Html => context.copy_html(self.slug, &links),
            // Plain text is derived from the Markdown, so it is checked as it.
            RepresentationFormat::Markdown | RepresentationFormat::Text => {
                context.copy_markdown(self.slug, &links)
            }
        }
    }

    /// The post's research context as Markdown, for the outputs that print
    /// their own header (`llms-full.txt`), or `None` when it has none.
    pub fn curated_context_markdown(&self) -> Option<String> {
        self.curated_section(RepresentationFormat::Markdown)
            .map(|section| section.text)
    }

    /// What a feed says of the post's research context without carrying it:
    /// the canonical anchor of the section and of each item. No item's words.
    pub fn curated_context_summary(&self) -> Option<serde_json::Value> {
        self.curated
            .as_ref()?
            .feed_summary(self.slug, &self.canonical_url)
    }

    /// The post's research context for a bibliography export (ADR 0205).
    pub fn curated_bibliography(&self) -> Option<crate::curated_context::BibliographyContext> {
        self.curated.as_ref()?.bibliography_for_post(self.slug)
    }

    /// Loss diagnostics for the research context in a portable copy (ADR
    /// 0202): what a format cannot carry as the page does, said once.
    fn curated_diagnostics(&self) -> Vec<PortabilityDiagnostic> {
        let Some(section) = self.curated_section(RepresentationFormat::Html) else {
            return Vec::new();
        };
        let diagnostic = |code: &str,
                          severity: DiagnosticSeverity,
                          message: String,
                          action: &str,
                          affected: &str| PortabilityDiagnostic {
            code: code.into(),
            severity,
            source_path: self.source_path.into(),
            capability_id: Some("curated-research-context".into()),
            message,
            recommended_action: action.into(),
            context: DiagnosticContext {
                representation: Some("portable-html".into()),
                destination: Some("portable-export".into()),
                portability_level: Some(PortabilityLevel::GracefullyTransformed),
                affected_semantics: Some(affected.into()),
                source_range: None,
            },
        };
        let mut found = vec![diagnostic(
            "curated-context-sequenced",
            DiagnosticSeverity::Info,
            format!(
                "The research context ({} item(s)) is carried as labeled sequential sections; anchors, links between its items and the data file are on the canonical page.",
                section.items
            ),
            "No action needed: every item keeps its attribution, uncertainty, evidence and origin as text, and links to its anchor on the canonical article.",
            "In-page anchors, links among items, the data file, and the page's layout; the items' words, attribution, doubt, evidence and origin are unchanged.",
        )];
        if section.unlinked > 0 {
            found.push(diagnostic(
                "curated-context-address-text",
                DiagnosticSeverity::Warning,
                format!(
                    "{} address(es) in the research context are not safe links, so the copy shows them as plain text.",
                    section.unlinked
                ),
                "Give the source an https address if readers should be able to follow it; the address is never dropped.",
                "Links to addresses that are not this site's pages or https addresses.",
            ));
        }
        if section.held_back > 0 {
            found.push(diagnostic(
                "curated-context-held-back",
                DiagnosticSeverity::Warning,
                format!(
                    "The research context has {} more item(s) than a copy shows; they are on the canonical page, which the copy links to.",
                    section.held_back
                ),
                "Select fewer items for this post, or read the rest on the canonical article.",
                "Items beyond the per-copy bound.",
            ));
        }
        found
    }

    /// The canonical page's own place for one published note.
    fn discussion_url(&self, id: &str) -> String {
        format!("{}#ob-reader-note-{id}", self.canonical_url)
    }

    /// The published suggested sources and corrections with the author's decision, or that the
    /// author has not decided, as an HTML section (ADR 0119). The reader's own words stay on
    /// the canonical page, which every outcome links to; a name is shown only as the reader
    /// agreed. Empty when no note has an outcome.
    fn outcomes_html(&self) -> String {
        if self.outcomes.is_empty() {
            return String::new();
        }
        let mut html = format!(
            "<section class=\"ob-reader-outcomes\" aria-label=\"Reader suggestions and the author’s decisions\">\n<h2>Reader suggestions and the author’s decisions</h2>\n<p>{} Read each note, with the reader’s own words, on <a href=\"{}\">the original article</a>.</p>\n",
            escape::text(OUTCOMES_INTRO),
            escape::attr(&format!(
                "{}#{}",
                self.canonical_url,
                crate::feedback_publication::READER_FEEDBACK_ANCHOR
            ))
        );
        for item in &self.outcomes {
            let Some(outcome) = &item.outcome else {
                continue;
            };
            html.push_str(&format!(
                "<article class=\"ob-reader-outcome\">\n<h3>{} about {}</h3>\n<p class=\"ob-reader-note-meta\">{} · received <time datetime=\"{3}\">{3}</time></p>\n",
                escape::text(item.kind.label()),
                escape::text(&crate::feedback_publication::place_words(item)),
                match &item.provenance.name {
                    Some(name) => format!("From {}", escape::text(name)),
                    None => "From a reader".to_string(),
                },
                escape::attr(&item.provenance.received),
            ));
            html.push_str(&crate::feedback_publication::outcome_html(
                item,
                outcome,
                &self.canonical_url,
            ));
            html.push_str(&format!(
                "<p class=\"ob-reader-note-discussion\"><a href=\"{}\">Discussion of this note on the original article</a></p>\n</article>\n",
                escape::attr(&self.discussion_url(&item.id))
            ));
        }
        html.push_str("</section>\n");
        html
    }

    /// The same section as Markdown, every value escaped as inline text.
    fn outcomes_markdown(&self) -> String {
        if self.outcomes.is_empty() {
            return String::new();
        }
        let mut output = format!(
            "\n## Reader suggestions and the author’s decisions\n\n{} Read each note, with the reader’s own words, on the [original article]({}).\n\n",
            markdown_text(OUTCOMES_INTRO),
            markdown_destination(&format!(
                "{}#{}",
                self.canonical_url,
                crate::feedback_publication::READER_FEEDBACK_ANCHOR
            ))
        );
        for item in &self.outcomes {
            let Some(outcome) = &item.outcome else {
                continue;
            };
            let from = match &item.provenance.name {
                Some(name) => format!("From {}", markdown_text(name)),
                None => "From a reader".to_string(),
            };
            output.push_str(&format!(
                "### {} about {}\n\n{from}, received {}. Affected revision: `{}`{}.\n\n**{}**{}\n\n{}\n\n",
                markdown_text(item.kind.label()),
                markdown_text(&crate::feedback_publication::place_words(item)),
                item.provenance.received,
                item.provenance.revision.replace('`', ""),
                if item.provenance.stale {
                    ". The passage has been revised since"
                } else {
                    ""
                },
                markdown_text(&outcome.heading()),
                outcome
                    .decided
                    .as_ref()
                    .map(|day| format!(" ({day})"))
                    .unwrap_or_default(),
                markdown_text(&outcome.summary()),
            ));
            if let Some(change) = &outcome.change {
                let words = markdown_text(&crate::feedback_publication::change_words(change));
                let words = match &change.fragment {
                    Some(fragment) => format!(
                        "[{words}]({})",
                        markdown_destination(&format!("{}#{fragment}", self.canonical_url))
                    ),
                    None => words,
                };
                output.push_str(&format!("What changed: {words}\n\n"));
            }
            if let Some(evidence) = &outcome.evidence {
                output.push_str(&format!(
                    "Evidence the author recorded: [Claim {}]({}): {}.\n\n",
                    evidence.claim,
                    markdown_destination(&format!("{}#{}", self.canonical_url, evidence.fragment)),
                    markdown_text(&evidence.label)
                ));
            } else if outcome.evidence_withdrawn {
                output.push_str(
                    "The evidence the author recorded is not published on this page.\n\n",
                );
            }
            if let Some(rationale) = &outcome.rationale {
                let mut paragraphs = rationale
                    .replace("\r\n", "\n")
                    .split("\n\n")
                    .map(str::trim)
                    .filter(|paragraph| !paragraph.is_empty())
                    .map(markdown_text)
                    .collect::<Vec<_>>()
                    .into_iter();
                if let Some(first) = paragraphs.next() {
                    output.push_str(&format!("The author’s rationale: {first}\n\n"));
                }
                for paragraph in paragraphs {
                    output.push_str(&format!(
                        "{}\n\n",
                        crate::bibliography::block_safe(&paragraph)
                    ));
                }
            }
            output.push_str(&format!(
                "[Discussion of this note on the original article]({})\n\n",
                markdown_destination(&self.discussion_url(&item.id))
            ));
        }
        output
    }

    /// Where a capability's labelled note points on the canonical article, and
    /// how it says so. Third Perspectives link to their own section: the
    /// reflections when there are any ("see it on"), otherwise the form
    /// ("take part on"); everything else links to the article itself.
    fn capability_link(&self, capability: &CapabilityDescriptor) -> (String, &'static str) {
        if capability.id != crate::perspective_publication::THIRD_PERSPECTIVES_CAPABILITY {
            return (self.canonical_url.clone(), "see it on");
        }
        // Only the form has a renderer: nothing is approved yet.
        let offered_only =
            capability.native_renderer == Some(crate::render::THIRD_PERSPECTIVE_ANCHOR);
        let anchor = if offered_only {
            crate::render::THIRD_PERSPECTIVE_ANCHOR
        } else {
            crate::perspective_publication::THIRD_PERSPECTIVES_ANCHOR
        };
        (
            format!("{}#{anchor}", self.canonical_url),
            if offered_only {
                "take part on"
            } else {
                "see it on"
            },
        )
    }

    fn participation_url(&self) -> String {
        format!("{}#{}", self.canonical_url, crate::model::DISCUSSION_ANCHOR)
    }

    /// Produce plain feed text from the portable Markdown, including code and
    /// link destinations instead of inheriting the native search-text omissions.
    pub fn portable_text(&self) -> Result<String, String> {
        let compact = markdown_to_text(&self.portable_markdown()?, self.render_options.supplements);
        self.ensure_semantics(RepresentationFormat::Text, &compact)?;
        Ok(compact)
    }

    /// The arrangement of a shared reflection as plain text in reading order: round prompts, then
    /// each turn under its author's name and label. `None` for any other post. It carries the same
    /// words, names, labels and order as the portable text, without the page's own metadata, for
    /// callers (llms-full.txt) that print their own header.
    /// Published moments (ADR 0066) follow in the same words as the portable text.
    pub fn reflection_text(&self) -> Result<Option<String>, String> {
        if self.arrangement().is_none() && self.moments().is_none() {
            return Ok(None);
        }
        let (body, _) = escape_raw_html(&self.portable_source());
        let markdown = portable_markdown_body(&body, self)
            .map_err(|error| format!("{}: {error}", self.source_path))?;
        Ok(Some(markdown_to_text(&markdown, false)))
    }

    /// The arrangement recorded in a shared reflection's authored Markdown, if it has one. It is
    /// read from the body before any published moments, which follow it after a section break.
    fn arrangement(&self) -> Option<crate::arrangement::Arrangement> {
        self.shared?;
        let body = match self.moments() {
            Some(block) => &self.markdown[..block.before],
            None => self.markdown,
        };
        crate::arrangement::Arrangement::parse(body)
    }

    /// The approved media moments a shared reflection's body ends with, read back exactly as the
    /// gate wrote them (ADR 0066). `None` for any other post or body.
    fn moments(&self) -> Option<crate::published_moment::MomentsBlock> {
        self.shared?;
        crate::published_moment::MomentsBlock::parse(self.markdown)
    }

    /// The Markdown every portable form is derived from: a shared reflection's arrangement stated
    /// as labeled sequential sections (ADR 0033) and its published moments stated without HTML
    /// (ADR 0066); any other body is the authored Markdown itself.
    fn portable_source(&self) -> String {
        let moments = self.moments();
        let body = match &moments {
            Some(block) => &self.markdown[..block.before],
            None => self.markdown,
        };
        let mut source = self.arrangement().map_or_else(
            || body.to_string(),
            |arrangement| arrangement.to_markdown(markdown_text),
        );
        if let Some(block) = moments {
            source.push_str("\n\n---\n\n");
            source.push_str(&block.portable_markdown());
        }
        source
    }

    /// Resolve an authored URL against the post or site base while rejecting
    /// executable schemes and credential-bearing HTTP(S) URLs.
    pub fn resolve_link(&self, value: &str) -> Result<String, String> {
        resolve_link_in(self.source_path, &self.canonical_url, &self.base_url, value)
    }
}

/// Whether an authored link would resolve at all: the same predicate `resolve_link` applies,
/// against a stand-in base, so a publish gate refuses exactly what the site build would refuse.
pub(crate) fn link_is_publishable(value: &str) -> bool {
    resolve_link_in(
        "",
        "https://example.invalid/post/",
        "https://example.invalid",
        value,
    )
    .is_ok()
}

fn resolve_link_in(
    source_path: &str,
    canonical_url: &str,
    base_url: &str,
    value: &str,
) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err(format!(
            "{}: link must be non-empty and contain no control characters",
            source_path
        ));
    }
    let value = value.trim();
    if value.is_empty() {
        return Err(format!(
            "{}: link must be non-empty and contain no control characters",
            source_path
        ));
    }

    let base = Url::parse(canonical_url).map_err(|_| {
        format!(
            "{}: portable projection has an invalid URL base",
            source_path
        )
    })?;

    let (resolved, was_absolute) = match Url::parse(value) {
        Ok(absolute) => Ok((absolute, true)),
        Err(url::ParseError::RelativeUrlWithoutBase) => {
            if value.starts_with('/') && !value.starts_with("//") {
                Url::parse(&format!("{}{}", base_url.trim_end_matches('/'), value))
                    .map(|resolved| (resolved, false))
            } else {
                base.join(value).map(|resolved| (resolved, false))
            }
        }
        Err(_) => return Err(format!("{}: link is not a valid URL", source_path)),
    }
    .map_err(|_| format!("{}: link is not a valid URL", source_path))?;

    validate_http_url(&resolved, true)
        .or_else(|_| match resolved.scheme() {
            "mailto" | "tel" if resolved.host_str().is_none() => Ok(()),
            _ => Err("link must use HTTP(S), mailto, or tel".to_string()),
        })
        .map_err(|_| format!("{}: link must use HTTP(S), mailto, or tel", source_path))?;
    Ok(if was_absolute {
        value.to_string()
    } else {
        resolved.to_string()
    })
}

/// A link target as the checks compare it: parsed and written again, with
/// `[` and `]` read the same whether the HTML writer escaped them (`%5B`, as it
/// does in the authority of an IPv6 address such as `http://[2001:db8::1]/`)
/// or not.
fn canonical_target(target: &str) -> String {
    let plain = target
        .replace("%5B", "[")
        .replace("%5b", "[")
        .replace("%5D", "]")
        .replace("%5d", "]");
    Url::parse(&plain)
        .map(|url| url.to_string())
        .unwrap_or(plain)
}

fn portability_diagnostics(
    source_path: &str,
    markdown: &str,
    capabilities: &[CapabilityDescriptor],
) -> Vec<PortabilityDiagnostic> {
    let mut diagnostics = Vec::new();
    let mut ranges =
        std::collections::HashMap::<String, std::collections::VecDeque<SourceRange>>::new();
    for (id, range) in crate::markdown::capability_source_ranges(markdown) {
        ranges.entry(id).or_default().push_back(range);
    }
    for capability in capabilities {
        let source_range = ranges
            .get_mut(&capability.id)
            .and_then(|ranges| ranges.pop_front());
        let context = DiagnosticContext {
            representation: Some("portable-html".into()),
            destination: Some("portable-export".into()),
            portability_level: Some(capability.portability),
            affected_semantics: Some(match capability.id.as_str() {
                "knowledge-check" => "Question, choices, answer and explanation remain readable. Scoring, retries and saved attempts remain on the canonical article.".into(),
                "runnable-code" | "web-sandbox" => "Source and authored results remain readable. Editing and execution remain on the canonical article; Rust may also link to Playground.".into(),
                "interactive-demo" => "The authored description of the demo remains readable. The live demonstration and anything the reader does in it remain on the canonical article.".into(),
                "comments" => "Discussion participation and live state remain on the canonical article; the portable copy provides its link.".into(),
                _ => capability.authored_semantics.into(),
            }),
            source_range,
        };
        for diagnostic in &capability.diagnostics {
            let code = match diagnostic.code {
                CapabilityDiagnosticCode::UnknownCapability => "unknown-capability",
                CapabilityDiagnosticCode::MalformedIdentifier => "malformed-identifier",
                CapabilityDiagnosticCode::MalformedContent => "malformed-content",
                CapabilityDiagnosticCode::RemovedMarkup => "removed-markup",
            };
            diagnostics.push(PortabilityDiagnostic {
                code: code.into(),
                severity: if diagnostic.code == CapabilityDiagnosticCode::MalformedContent {
                    DiagnosticSeverity::Error
                } else {
                    DiagnosticSeverity::Warning
                },
                source_path: source_path.to_string(),
                capability_id: Some(capability.id.clone()),
                message: diagnostic.message.clone(),
                recommended_action: diagnostic_recommended_action(code, &capability.id),
                context: context.clone(),
            });
        }
        if capability.portability == PortabilityLevel::GracefullyTransformed {
            diagnostics.push(PortabilityDiagnostic {
                code: "graceful-transformation".into(),
                severity: DiagnosticSeverity::Warning,
                source_path: source_path.to_string(),
                capability_id: Some(capability.id.clone()),
                message: format!(
                    "{} is transformed to the `{}` fallback; review the result for this destination.",
                    capability.id,
                    capability.fallback_renderer.unwrap_or("static-content")
                ),
                recommended_action: diagnostic_recommended_action(
                    "graceful-transformation",
                    &capability.id,
                ),
                context: context.clone(),
            });
        }
        if capability.portability == PortabilityLevel::CanonicalOnlyInteraction {
            if let Some(label) = capability.portable_label() {
                diagnostics.push(PortabilityDiagnostic {
                    code: "canonical-only-interaction".into(),
                    severity: DiagnosticSeverity::Warning,
                    source_path: source_path.to_string(),
                    capability_id: Some(capability.id.clone()),
                    message: format!(
                        "{label} has no portable interaction; readers need the canonical article."
                    ),
                    recommended_action: diagnostic_recommended_action(
                        "canonical-only-interaction",
                        &capability.id,
                    ),
                    context: context.clone(),
                });
            }
        }
    }
    diagnostics
}

fn diagnostic_recommended_action(code: &str, capability: &str) -> String {
    match code {
        "graceful-transformation" => match capability {
            "knowledge-check" => {
                "Review the static question and answer; keep the canonical link when scoring or retries matter.".into()
            }
            "runnable-code" | "web-sandbox" => {
                "Review the preserved source and keep the canonical link for editing or execution.".into()
            }
            "interactive-demo" => {
                "Review the authored description of the demo and keep the canonical link for the live version.".into()
            }
            _ => "Review the static fallback in the destination preview.".into(),
        },
        "canonical-only-interaction" => {
            "Keep the canonical article reachable and use its link for this interaction.".into()
        }
        "removed-markup" => {
            "Move substantive content into Markdown or supported markup, then review the portable result.".into()
        }
        "malformed-content" | "malformed-identifier" => {
            "Correct the source block or identifier and rerun the portability check.".into()
        }
        "unknown-capability" => {
            "Register the capability and define its fallback before relying on portable output.".into()
        }
        _ => "Review the source and the destination preview before publishing.".into(),
    }
}

fn transformation_summary(capability: &str) -> &'static str {
    match capability {
        "knowledge-check" => {
            "The question and answer are preserved; scoring, retry, and remembered attempts are unavailable"
        }
        "runnable-code" => {
            "The source code and canonical run/edit link are preserved; eligible Rust examples also link to the external Playground"
        }
        "web-sandbox" => {
            "The HTML, CSS, and JavaScript sources are preserved; the live preview remains on the canonical article"
        }
        "interactive-demo" => {
            "The authored description of the demo is preserved; the live demonstration remains on the canonical article"
        }
        "raw-html" => {
            "Authored raw HTML is constrained by the portable allowlist and may be shown as literal source"
        }
        _ => "Interactive behavior is represented by a static fallback",
    }
}

/// Plain text of Markdown, keeping code and link destinations (shared by the portable text and the
/// reflection text). With `supplements` (a post that opted in to reading modes, ADR 0140) each
/// supplement's marker line becomes a line naming it and a line closes it, so the text shows where
/// it starts and stops without a stylesheet.
fn markdown_to_text(markdown: &str, supplements: bool) -> String {
    let mut output = String::new();
    let mut links: Vec<(usize, String)> = Vec::new();
    let events =
        Parser::new_ext(markdown, crate::markdown::parser_options(false)).collect::<Vec<_>>();
    let analysis = supplements.then(|| crate::reading_depth::analyze(&events));
    // One entry per open block quote: the supplement it is, for its end line.
    let mut quotes: Vec<Option<&crate::reading_depth::Supplement>> = Vec::new();
    let mut index = 0;
    while index < events.len() {
        let event = events[index].clone();
        index += 1;
        if let Event::Start(Tag::BlockQuote(_)) = &event {
            let start = analysis
                .as_ref()
                .and_then(|analysis| analysis.start_at(index - 1));
            if let Some((supplement, resume)) = start {
                output.push_str(&crate::reading_depth::start_words(supplement));
                output.push('\n');
                quotes.push(Some(supplement));
                index = resume;
            } else {
                quotes.push(None);
            }
            continue;
        }
        if let Event::End(TagEnd::BlockQuote(_)) = &event {
            if let Some(Some(supplement)) = quotes.pop() {
                output.push('\n');
                output.push_str(&crate::reading_depth::end_words(supplement));
            }
            output.push('\n');
            continue;
        }
        match event {
            Event::Text(text) | Event::Code(text) | Event::Html(text) | Event::InlineHtml(text) => {
                output.push_str(&text)
            }
            Event::Start(Tag::Link { dest_url, .. })
            | Event::Start(Tag::Image { dest_url, .. }) => {
                links.push((output.len(), dest_url.to_string()));
            }
            Event::End(TagEnd::Link) | Event::End(TagEnd::Image) => {
                if let Some((start, destination)) = links.pop() {
                    let label = output[start..].trim();
                    if !destination.is_empty() && label != destination {
                        output.push_str(" (");
                        output.push_str(&destination);
                        output.push(')');
                    }
                }
            }
            Event::SoftBreak | Event::HardBreak | Event::Rule => output.push('\n'),
            Event::FootnoteReference(label) => output.push_str(&format!("[{label}]")),
            Event::Start(Tag::FootnoteDefinition(label)) => {
                output.push_str(&format!("[{label}]: "))
            }
            Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::Item
                | TagEnd::CodeBlock
                | TagEnd::TableCell
                | TagEnd::TableHead,
            ) => output.push('\n'),
            _ => {}
        }
    }
    let mut compact = String::new();
    let mut previous_blank = false;
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if !compact.is_empty() && !previous_blank {
            compact.push('\n');
        }
        compact.push_str(line);
        previous_blank = false;
    }
    compact
}

/// "Part 2 in the series": a part's place in its series' published reading order, without the
/// number of parts (ADR 0041), so a later part never changes an earlier part's portable copy.
fn series_position(series: &SeriesContext) -> String {
    format!("Part {} in the series", series.part)
}

/// `lead` and an already-escaped list of names as a sentence, or nothing when there are none.
fn series_clause(lead: &str, names: &str) -> String {
    if names.is_empty() {
        String::new()
    } else {
        format!("{lead}{names}.")
    }
}

/// What a portable copy says before it lists the outcomes (ADR 0119).
const OUTCOMES_INTRO: &str = "Suggested sources and corrections readers sent about this post that the author chose to publish, and what the author decided. An outcome is the author’s record of their own decision, not a finding that a claim is true; a suggestion without a decision is unresolved.";

/// Markdown text for a public value (a title, a name, a fact): Markdown punctuation, `<` and `&`
/// are escaped, so the value can never become a link, emphasis, an autolink, raw HTML or an
/// entity when the export is read back.
pub(crate) fn markdown_text(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut escaped = String::new();
    for character in normalized.chars() {
        if matches!(
            character,
            '\\' | '[' | ']' | '*' | '_' | '~' | '`' | '#' | '>' | '|' | '<' | '&'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

pub(crate) fn markdown_destination(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)")
}

fn escape_raw_html(markdown: &str) -> (String, usize) {
    let mut spans = Parser::new_ext(markdown, crate::markdown::parser_options(false))
        .into_offset_iter()
        .filter_map(|(event, range)| {
            matches!(event, Event::Html(_) | Event::InlineHtml(_)).then_some(range)
        })
        .collect::<Vec<_>>();
    spans.sort_by_key(|span| span.start);
    let mut count = 0;
    let mut output = String::with_capacity(markdown.len());
    let mut cursor = 0;
    for span in spans {
        if span.end <= cursor {
            continue;
        }
        let start = span.start.max(cursor);
        output.push_str(&markdown[cursor..start]);
        let (escaped, open_comment) =
            crate::raw_html::escape_markdown_fragment(&markdown[start..span.end]);
        count += usize::from(!escaped.trim().is_empty());
        output.push_str(&escaped);
        cursor = span.end;
        if open_comment {
            // A block comment can span Markdown containers and code fences.
            let rest = &markdown[cursor..];
            cursor += crate::raw_html::comment_end(rest).unwrap_or(rest.len());
        }
    }
    output.push_str(&markdown[cursor..]);
    (output, count)
}

fn portable_markdown_body(
    markdown: &str,
    projection: &PortableProjection<'_>,
) -> Result<String, String> {
    let mut edits = Vec::new();
    let mut fence: Option<(std::ops::Range<usize>, String, String)> = None;
    let mut parser =
        Parser::new_ext(markdown, crate::markdown::parser_options(false)).into_offset_iter();
    let events = parser.by_ref().collect::<Vec<_>>();
    let literal_ranges = events
        .iter()
        .filter_map(|(event, range)| matches!(event, Event::Code(_)).then_some(range.clone()))
        .collect::<Vec<_>>();
    for (_, definition) in parser.reference_definitions().iter() {
        let raw = &markdown[definition.span.clone()];
        if let Some(after_label) = raw
            .match_indices("]:")
            .map(|(index, _)| index)
            .find(|index| !is_markdown_escaped(raw.as_bytes(), *index))
        {
            let mut start = after_label + 2;
            let mut continuation = false;
            while let Some(byte) = raw.as_bytes().get(start) {
                if byte.is_ascii_whitespace() {
                    continuation |= *byte == b'\n';
                } else if !continuation || *byte != b'>' {
                    break;
                }
                start += 1;
            }
            let angled = raw[start..].starts_with('<');
            let start = start + usize::from(angled);
            let end = if angled {
                raw[start..].find('>').map(|end| start + end)
            } else {
                raw[start..]
                    .find(char::is_whitespace)
                    .map(|end| start + end)
                    .or(Some(raw.len()))
            };
            if let Some(end) = end {
                let resolved = projection.resolve_link(&definition.dest)?;
                edits.push((
                    definition.span.start + start..definition.span.start + end,
                    if angled {
                        resolved
                    } else {
                        markdown_destination(&resolved)
                    },
                ));
            }
        }
    }
    for (event, range) in events {
        if let Some((_, _, source)) = fence.as_mut() {
            match event {
                Event::Text(text) => source.push_str(&text),
                Event::End(TagEnd::CodeBlock) => {
                    let (start, info, source): (std::ops::Range<usize>, String, String) =
                        fence.take().unwrap();
                    let opening = &markdown[start.start..start.end];
                    let marker = opening.find(['`', '~']).unwrap_or(0);
                    let edit_start = start.start + marker;
                    let line_start = markdown[..edit_start]
                        .rfind('\n')
                        .map_or(0, |index| index + 1);
                    let prefix = &markdown[line_start..edit_start];
                    let continuation = prefix
                        .chars()
                        .map(|character| {
                            if character == '>' || character.is_whitespace() {
                                character
                            } else {
                                ' '
                            }
                        })
                        .collect::<String>();
                    let converted =
                        portable_fence_markdown(&info, source.trim_end_matches('\n'), projection)?;
                    let replacement = converted
                        .trim_end_matches('\n')
                        .split('\n')
                        .collect::<Vec<_>>()
                        .join(&format!("\n{continuation}"))
                        + "\n";
                    edits.push((edit_start..range.end, replacement));
                }
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(Tag::Paragraph) => {
                let raw = markdown[range.clone()].trim();
                if (raw.starts_with("%[") && raw.ends_with(']')) || raw.starts_with("http") {
                    if let Some(embed) = crate::embed::detect(raw) {
                        let url = projection.resolve_link(&embed.link)?;
                        edits.push((
                            range,
                            format!(
                                "[{}]({})\n",
                                markdown_text(&embed.link_label),
                                markdown_destination(&url)
                            ),
                        ));
                    }
                }
            }
            Event::Start(Tag::Link {
                dest_url,
                link_type: pulldown_cmark::LinkType::Inline,
                ..
            })
            | Event::Start(Tag::Image {
                dest_url,
                link_type: pulldown_cmark::LinkType::Inline,
                ..
            }) => {
                let raw = &markdown[range.clone()];
                let mut brackets = 0usize;
                for (index, character) in raw.char_indices() {
                    if is_markdown_escaped(raw.as_bytes(), index) {
                        continue;
                    }
                    if character == '[' {
                        brackets += 1;
                        continue;
                    }
                    if character != ']' {
                        continue;
                    }
                    brackets = brackets.saturating_sub(1);
                    if brackets != 0 {
                        continue;
                    }
                    if literal_ranges
                        .iter()
                        .any(|literal| literal.contains(&(range.start + index)))
                    {
                        continue;
                    }
                    if let Some((start, end, angled)) = markdown_destination_range(raw, index + 1) {
                        let resolved = projection.resolve_link(&dest_url)?;
                        edits.push((
                            range.start + start..range.start + end,
                            if angled {
                                resolved
                            } else {
                                markdown_destination(&resolved)
                            },
                        ));
                        break;
                    }
                }
            }
            Event::Start(Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Indented)) => {
                edits.push((range.clone(), markdown[range].to_string()));
            }
            Event::Start(Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Fenced(info))) => {
                fence = Some((range, info.to_string(), String::new()));
            }
            Event::Start(Tag::BlockQuote(Some(kind))) => {
                let line = markdown[range.clone()].lines().next().unwrap_or("");
                if let Some(marker) = line.find("[!") {
                    if let Some(close) = line[marker..].find(']') {
                        let label = match kind {
                            pulldown_cmark::BlockQuoteKind::Note => "Note",
                            pulldown_cmark::BlockQuoteKind::Tip => "Tip",
                            pulldown_cmark::BlockQuoteKind::Important => "Important",
                            pulldown_cmark::BlockQuoteKind::Warning => "Warning",
                            pulldown_cmark::BlockQuoteKind::Caution => "Caution",
                        };
                        edits.push((
                            range.start + marker..range.start + marker + close + 1,
                            format!("**{label}:**"),
                        ));
                    }
                }
            }
            _ => {}
        }
    }
    edits.sort_by_key(|(range, _)| range.start);
    let mut output = String::new();
    let mut cursor = 0;
    for (range, replacement) in edits {
        if range.start < cursor {
            continue;
        }
        output.push_str(&markdown[cursor..range.start]);
        output.push_str(&replacement);
        cursor = range.end;
    }
    output.push_str(&markdown[cursor..]);
    Ok(output.replace("\r\n", "\n"))
}

fn portable_fence_markdown(
    info: &str,
    source: &str,
    projection: &PortableProjection<'_>,
) -> Result<String, String> {
    let canonical_url = projection.canonical_url();
    let mut output = String::new();
    let fence = crate::markdown::parse_fence_info(info);
    let language = fence.lang.as_str();
    // Copies cannot run the checks: the starter is the code, and the checks follow as a spoiler.
    let (source, spoiler) = if fence.check {
        crate::markdown::split_rust_checks(source)
    } else {
        (source, None)
    };
    if info.trim() == "quiz" {
        output.push_str(
            &crate::markdown::portable_quiz_markdown(source)
                .map_err(|error| format!("portable knowledge-check fallback failed: {error}"))?,
        );
    } else if info.trim() == crate::compare::FENCE {
        let pair = crate::compare::parse(source).map_err(|problems| {
            format!(
                "portable before-after fallback failed: {}",
                problems.join("; ")
            )
        })?;
        output.push_str(&pair.portable_markdown(&|address| projection.resolve_link(address))?);
    } else if language == "demo" {
        let (kind, body) = crate::markdown::portable_demo_parts(&fence, source)
            .map_err(|error| format!("portable interactive-demo fallback failed: {error}"))?;
        if let Some(title) = fence.title.as_deref() {
            output.push_str(&format!("**{}**\n\n", markdown_text(title)));
        }
        output.push_str(&body);
        output.push_str(&format!(
            "\n\n[Try the interactive {} on the canonical article]({}).\n",
            kind.label,
            markdown_destination(canonical_url)
        ));
    } else if language.eq_ignore_ascii_case("web") && fence.runnable {
        output.push_str(&portable_web_markdown(
            source,
            fence.title.as_deref(),
            canonical_url,
        ));
    } else {
        if let Some(title) = fence.title.as_deref() {
            output.push_str(&format!("**{}**\n\n", markdown_text(title)));
        }
        let normalized_language = if language.eq_ignore_ascii_case("web") {
            "text"
        } else {
            language
        };
        output.push_str(&markdown_code_fence(normalized_language, source));
        if fence.runnable {
            if language.eq_ignore_ascii_case("rust")
                && fence
                    .playground_link
                    .unwrap_or(projection.render_options.playground_link)
            {
                if let Some(url) = crate::markdown::rust_playground_url(&format!("{source}\n")) {
                    output.push_str(&format!("\n[Open in Rust Playground]({url}).\n"));
                }
            }
            if let Some(checks) = spoiler {
                output.push_str(&format!(
                    "\n<details>\n<summary>{}</summary>\n\n{}\n\n{}</details>\n",
                    crate::markdown::RUST_CHECKS_SPOILER,
                    crate::markdown::RUST_CHECKS_SPOILER_NOTE,
                    markdown_code_fence("rust", checks.trim_end())
                ));
            }
            output.push_str(&format!(
                "\n[Run and edit this example on the canonical article]({}).\n",
                markdown_destination(canonical_url)
            ));
        }
    }
    output.push('\n');
    Ok(output)
}

fn markdown_destination_range(line: &str, after_label: usize) -> Option<(usize, usize, bool)> {
    let bytes = line.as_bytes();
    let mut cursor = after_label;
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    if bytes.get(cursor) != Some(&b'(') {
        return None;
    }
    cursor += 1;
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    let angled = bytes.get(cursor) == Some(&b'<');
    if angled {
        cursor += 1;
    }
    let start = cursor;
    let mut parentheses = 0usize;
    while let Some(byte) = bytes.get(cursor) {
        if *byte == b'\\' {
            cursor = (cursor + 2).min(bytes.len());
            continue;
        }
        if angled && *byte == b'>' {
            return Some((start, cursor, true));
        }
        if !angled {
            if *byte == b'(' {
                parentheses += 1;
            } else if *byte == b')' {
                if parentheses == 0 {
                    return (cursor > start).then_some((start, cursor, false));
                }
                parentheses -= 1;
            } else if byte.is_ascii_whitespace() && parentheses == 0 {
                return (cursor > start).then_some((start, cursor, false));
            }
        }
        cursor += 1;
    }
    None
}

fn is_markdown_escaped(bytes: &[u8], index: usize) -> bool {
    let mut preceding = index;
    while preceding > 0 && bytes[preceding - 1] == b'\\' {
        preceding -= 1;
    }
    (index - preceding) % 2 == 1
}

fn markdown_code_fence(language: &str, source: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for character in source.chars() {
        if character == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let fence = "`".repeat(3.max(longest + 1));
    format!("{fence}{language}\n{source}\n{fence}\n")
}

fn portable_web_markdown(source: &str, title: Option<&str>, canonical_url: &str) -> String {
    let labels = [("html", "HTML"), ("css", "CSS"), ("js", "JavaScript")];
    let mut sections = [
        ("html", String::new()),
        ("css", String::new()),
        ("js", String::new()),
    ];
    let mut preamble = Vec::new();
    let mut active: Option<usize> = None;
    for line in source.lines() {
        let marker = line
            .trim()
            .strip_prefix("---")
            .and_then(|name| sections.iter().position(|(language, _)| *language == name));
        if marker.is_some() {
            active = marker;
            continue;
        }
        if let Some(index) = active {
            sections[index].1.push_str(line);
            sections[index].1.push('\n');
        } else {
            preamble.push(line);
        }
    }
    let mut output = String::new();
    if !preamble.iter().all(|line| line.trim().is_empty()) {
        output.push_str(&markdown_code_fence("text", &preamble.join("\n")));
        output.push('\n');
    }
    for ((_, label), (language, source)) in labels.iter().zip(sections) {
        if source.trim().is_empty() {
            continue;
        }
        output.push_str(&format!("**{label}**\n\n"));
        output.push_str(&markdown_code_fence(language, source.trim_end()));
        output.push('\n');
    }
    let label = title.unwrap_or("Open the live preview");
    output.push_str(&format!(
        "[{} on the canonical article]({}).\n",
        markdown_text(label),
        markdown_destination(canonical_url)
    ));
    output
}

fn validate_http_url(url: &Url, allow_query_and_fragment: bool) -> Result<(), String> {
    if matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && (allow_query_and_fragment || (url.query().is_none() && url.fragment().is_none()))
    {
        Ok(())
    } else {
        Err("not an absolute HTTP(S) URL".into())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReflectionItem {
    Prompt,
    Author,
    Label,
}

/// The reflection's own prompts, author headings and labels in the order a derived artifact
/// shows them. HTML is read from the arrangement's marked elements, Markdown from the top-level
/// blocks its arrangement writes (a heading, a lone emphasised label, a lone strong prompt), and
/// text from its lines. Credits, metadata and the title never count.
fn reflection_items(format: RepresentationFormat, artifact: &str) -> Vec<(ReflectionItem, String)> {
    let mut items = Vec::new();
    match format {
        RepresentationFormat::Html => {
            const MARKERS: [(&str, &str, ReflectionItem); 3] = [
                (
                    "<h2 class=\"ob-turn-author\">",
                    "</h2>",
                    ReflectionItem::Author,
                ),
                ("<p class=\"ob-turn-label\">", "</p>", ReflectionItem::Label),
                (
                    "<p class=\"ob-round-prompt\">",
                    "</p>",
                    ReflectionItem::Prompt,
                ),
            ];
            let mut found = Vec::new();
            for (open, close, kind) in MARKERS {
                for (at, _) in artifact.match_indices(open) {
                    let start = at + open.len();
                    if let Some(len) = artifact[start..].find(close) {
                        found.push((
                            at,
                            kind,
                            crate::raw_html::semantic_content(&artifact[start..start + len]),
                        ));
                    }
                }
            }
            found.sort_by_key(|(at, _, _)| *at);
            items.extend(found.into_iter().map(|(_, kind, text)| (kind, text)));
        }
        RepresentationFormat::Markdown => {
            #[derive(PartialEq)]
            enum Block {
                Heading,
                Paragraph,
            }
            let mut depth = 0usize;
            let mut block: Option<Block> = None;
            let mut text = String::new();
            let mut wrapper: Option<ReflectionItem> = None;
            let mut mixed = false;
            for event in Parser::new_ext(artifact, crate::markdown::parser_options(false)) {
                match event {
                    Event::Start(tag) => {
                        if depth == 0 {
                            block = match tag {
                                Tag::Heading {
                                    level: pulldown_cmark::HeadingLevel::H2,
                                    ..
                                } => Some(Block::Heading),
                                Tag::Paragraph => Some(Block::Paragraph),
                                _ => None,
                            };
                            text.clear();
                            wrapper = None;
                            mixed = false;
                        } else if depth == 1 && block == Some(Block::Paragraph) {
                            match tag {
                                Tag::Strong if wrapper.is_none() && text.is_empty() => {
                                    wrapper = Some(ReflectionItem::Prompt);
                                }
                                Tag::Emphasis if wrapper.is_none() && text.is_empty() => {
                                    wrapper = Some(ReflectionItem::Label);
                                }
                                _ => mixed = true,
                            }
                        }
                        depth += 1;
                    }
                    Event::End(_) => {
                        depth = depth.saturating_sub(1);
                        if depth == 0 {
                            match block.take() {
                                Some(Block::Heading) => {
                                    items.push((ReflectionItem::Author, std::mem::take(&mut text)));
                                }
                                Some(Block::Paragraph) if !mixed => {
                                    if let Some(kind) = wrapper {
                                        items.push((kind, std::mem::take(&mut text)));
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Event::Text(value) | Event::Code(value) if block.is_some() => {
                        if depth == 1 && block == Some(Block::Paragraph) {
                            // Text beside (or after) the wrapper is an ordinary paragraph.
                            if wrapper.is_some() && !text.is_empty() {
                                mixed = true;
                            }
                        }
                        text.push_str(&value);
                    }
                    Event::SoftBreak | Event::HardBreak if block.is_some() => text.push(' '),
                    _ => {}
                }
            }
        }
        RepresentationFormat::Text => {
            items.extend(
                artifact
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .map(|line| (ReflectionItem::Author, line.to_string())),
            );
        }
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SiteConfig;
    use crate::model::{LoadOptions, Site, SourceFile, Sources};

    #[test]
    fn review_regression_fence_options_share_the_native_grammar() {
        let (config, site) = public_post("---\ntitle: Options\ndate: 2020-01-01\n---\n```rust,runnable,playgroundLink=false title=\"Try commas\"\nfn main() {}\n```\n\n```WEB,runnable title=\"Web commas\"\n---html\n<p>Hello</p>\n```\n");
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let markdown = projection.portable_markdown().unwrap();
        assert!(markdown.contains("Run and edit this example on the canonical article"));
        assert!(!markdown.contains("Open in Rust Playground"));
        assert!(markdown.contains("**HTML**"));
        assert!(markdown.contains("Web commas on the canonical article"));
    }

    #[test]
    fn review_regression_video_identity_is_not_inferred_from_link_labels() {
        let (config, site) = public_post("---\ntitle: Video\ndate: 2020-01-01\nprofile: video\nvideoUrl: https://youtu.be/dQw4w9WgXcQ\n---\n[dQw4w9WgXcQ is discussed here](https://www.youtube.com/watch?v=abcdefghijk)\n");
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        assert!(projection
            .portable_html()
            .unwrap()
            .html
            .contains("href=\"https://www.youtube.com/watch?v=dQw4w9WgXcQ\""));
        let (config, site) = public_post("---\ntitle: Video\ndate: 2020-01-01\nprofile: video\nvideoUrl: https://youtu.be/dQw4w9WgXcQ\n---\n[Watch this video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)\n");
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let html = projection.portable_html().unwrap().html;
        assert_eq!(
            html.matches("href=\"https://www.youtube.com/watch?v=dQw4w9WgXcQ\"")
                .count(),
            1
        );
        let broken = html.replace(
            "href=\"https://www.youtube.com/watch?v=dQw4w9WgXcQ\"",
            "href=\"https://wrong.example/\"",
        ) + " https://www.youtube.com/watch?v=dQw4w9WgXcQ";
        assert!(!projection
            .analyze_portable_artifact(RepresentationFormat::Html, &broken)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn review_regression_link_relationships_cannot_be_masked_by_url_text_or_other_links() {
        let (config, site) = public_post("---\ntitle: Links\ndate: 2020-01-01\n---\n[First](https://evidence.example/study) and [Second](https://evidence.example/study).\n");
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        for (format, artifact) in [
            (RepresentationFormat::Html, "<p><a href=\"https://evidence.example/study\">First</a> and Second. https://evidence.example/study</p>"),
            (RepresentationFormat::Markdown, "[First](https://evidence.example/study) and Second. https://evidence.example/study"),
            (RepresentationFormat::Html, "<p><a href=\"https://evidence.example/study\">First</a> and <a href=\"https://wrong.example/\">Second</a>. https://evidence.example/study</p>"),
            (RepresentationFormat::Html, "<p><a href=\"https://evidence.example/study\">First</a> and <a href=\"https://evidence.example/study\">First</a>. Second.</p>"),
            (RepresentationFormat::Markdown, "[First](https://evidence.example/study) and [Second](https://wrong.example/). https://evidence.example/study"),
            (RepresentationFormat::Text, "First (https://evidence.example/study) and Second. https://evidence.example/study"),
        ] {
            assert!(projection.analyze_portable_artifact(format, artifact).unwrap().iter().any(|finding| finding.code == "missing-semantic-fact"), "{format:?}: lost link was accepted");
        }
        for (format, artifact) in [
            (
                RepresentationFormat::Html,
                projection.portable_html().unwrap().html,
            ),
            (
                RepresentationFormat::Markdown,
                projection.portable_markdown().unwrap(),
            ),
            (
                RepresentationFormat::Text,
                projection.portable_text().unwrap(),
            ),
        ] {
            assert!(projection
                .analyze_portable_artifact(format, &artifact)
                .unwrap()
                .is_empty());
        }
        let (config, site) = public_post("---\ntitle: Links\ndate: 2020-01-01\n---\n[Same](https://evidence.example/study) and [Same](https://evidence.example/study).\n");
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        assert!(!projection
            .analyze_portable_artifact(
                RepresentationFormat::Html,
                "<p><a href=\"https://evidence.example/study\">Same</a> and Same.</p>"
            )
            .unwrap()
            .is_empty());
    }

    #[test]
    fn review_regression_required_links_are_not_satisfied_by_image_sources() {
        let (config, site) = public_post("---\ntitle: Source\ndate: 2020-01-01\nprofile: research\nsourceUrl: https://evidence.example/shared\nlicense: https://evidence.example/shared\n---\nBody.\n");
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        assert!(projection.portable_html().is_ok());
        assert!(projection.portable_markdown().is_ok());
        for artifact in [
            "<p>Body.</p><img src=\"https://evidence.example/shared\" alt=\"Source\">",
            "<p>Body.</p><a href=\"https://evidence.example/shared\">Source</a>",
            "<p>Body.</p><a href=\"https://evidence.example/shared\">Source</a><img src=\"https://evidence.example/shared\" alt=\"License\">",
        ] {
            assert!(!projection.analyze_portable_artifact(RepresentationFormat::Html, artifact).unwrap().is_empty());
        }
        let (config, site) = public_post("---\ntitle: Image\ndate: 2020-01-01\n---\n![Diagram](https://images.example/diagram.png)\n");
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        assert!(!projection
            .analyze_portable_artifact(
                RepresentationFormat::Html,
                "<a href=\"https://images.example/diagram.png\">Diagram</a>"
            )
            .unwrap()
            .is_empty());
    }

    #[test]
    fn review_regression_bare_embeds_require_the_declared_provider_label() {
        let (config, site) = public_post("---\ntitle: Embed\ndate: 2020-01-01\n---\nhttps://codepen.io/u/pen/abc\n\nhttps://codepen.io/u/pen/abc\n");
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let markdown = projection.portable_markdown().unwrap();
        assert_eq!(
            markdown
                .matches("[See the Pen on CodePen](https://codepen.io/u/pen/abc)")
                .count(),
            2
        );
        assert!(projection.portable_html().is_ok());
        assert!(projection.portable_text().is_ok());
        for (format, artifact) in [
            (RepresentationFormat::Html, "<a href=\"https://codepen.io/u/pen/abc\">Wrong label</a><a href=\"https://codepen.io/u/pen/abc\">Wrong label</a>"),
            (RepresentationFormat::Markdown, "[Wrong label](https://codepen.io/u/pen/abc)\n\n[Wrong label](https://codepen.io/u/pen/abc)"),
            (RepresentationFormat::Html, "<a href=\"https://codepen.io/u/pen/abc\">See the Pen on CodePen</a>"),
        ] {
            assert!(!projection.analyze_portable_artifact(format, artifact).unwrap().is_empty());
        }
    }

    #[test]
    fn review_regression_linked_images_keep_their_nested_text_fallbacks() {
        let (config, site) = public_post("---\ntitle: Linked image\ndate: 2020-01-01\n---\n[![A useful diagram](https://images.example/diagram.png)](https://evidence.example/study)\n");
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        assert!(projection.portable_html().is_ok());
        assert!(projection.portable_markdown().is_ok());
        assert!(projection.portable_text().is_ok());
    }

    #[test]
    fn semantic_validation_respects_each_representations_punctuation_policy() {
        let source =
            "---\ntitle: Punctuation\ndate: 2020-01-01\n---\nHe said \"hello\" -- then waited...\n";
        let (mut config, _) = public_post(source);
        config.markdown.smart_punctuation = true;
        let site = Site::load(
            config.clone(),
            Sources {
                posts: vec![SourceFile {
                    path: "posts/work.md".into(),
                    contents: source.into(),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        assert!(projection.portable_html().unwrap().html.contains("“hello”"));
        assert!(projection
            .portable_markdown()
            .unwrap()
            .contains("\"hello\" -- then waited..."));
        assert!(projection
            .portable_text()
            .unwrap()
            .contains("\"hello\" -- then waited..."));
    }

    #[test]
    fn markdown_web_fallback_matches_case_insensitive_native_language_and_preserves_collisions() {
        let body = "- Exercise\n\n  ````WEB runnable title=\"Try Zürich\"\n  ---html\n  <p>``` inside source</p>\n  ---css\n  p { color: navy; }\n  ---js\n  console.log('Expected: 42');\n  ````\n\nExpected output: **42**.\n";
        let (config, site) = public_post(&format!(
            "---\ntitle: Web lesson\ndate: 2020-01-01\n---\n{body}"
        ));
        let post = &site.posts[0];
        assert!(post.html.contains("<ob-web-sandbox>"));
        let projection = PortableProjection::from_post(post, &config).unwrap();
        let markdown = projection.portable_markdown().unwrap();
        assert!(markdown.contains("**HTML**"), "{markdown}");
        assert!(markdown.contains("**CSS**"), "{markdown}");
        assert!(markdown.contains("**JavaScript**"), "{markdown}");
        assert!(
            markdown.contains("Try Zürich on the canonical article"),
            "{markdown}"
        );
        assert!(!markdown.contains("---html"), "{markdown}");
        assert!(markdown.contains("Expected output: **42**."), "{markdown}");
        let mut rendered = String::new();
        pulldown_cmark::html::push_html(&mut rendered, Parser::new(&markdown));
        assert!(
            rendered.contains("&lt;p&gt;``` inside source&lt;/p&gt;"),
            "{rendered}"
        );
        assert!(
            rendered.contains("<li>\n<p>Exercise</p>\n<p><strong>HTML</strong>"),
            "{rendered}"
        );
        assert!(!rendered.contains("<p>``` inside source</p>"));
    }

    #[test]
    fn malformed_markdown_capabilities_fail_with_source_context_without_mutation() {
        for (body, capability) in [
            ("```quiz\nMissing choices?\n```\n", "quiz"),
            ("```web runnable\nNo source markers\n```\n", "web"),
        ] {
            let (config, mut site) =
                public_post("---\ntitle: Legacy\ndate: 2020-01-01\n---\nOriginal content.\n");
            let post = &mut site.posts[0];
            post.authored_markdown = body.into();
            let native = post.html.clone();
            let projection = PortableProjection::from_post(post, &config).unwrap();
            let error = projection.portable_markdown().unwrap_err();
            assert!(error.contains("posts/work.md"), "{error}");
            assert!(error.to_lowercase().contains(capability), "{error}");
            assert_eq!(post.authored_markdown(), body);
            assert_eq!(post.html, native);
        }
    }

    #[test]
    fn markdown_recipe_times_match_native_facts_for_numeric_and_written_durations() {
        for (fields, expected) in [
            (
                "prep: 10\ncook: 20\n",
                vec!["Prep: 10 min", "Cook: 20 min", "Total: 30 min"],
            ),
            (
                "prep: 1h30m\ncook: overnight\ntotal: 2 hr\n",
                vec!["Prep: 1 hr 30 min", "Cook: overnight", "Total: 2 hr"],
            ),
            (
                "prep: 10-15 min\ncook: 0\n",
                vec!["Prep: 10-15 min", "Cook: 0 min"],
            ),
        ] {
            let source = format!("---\ntitle: Recipe\ndate: 2020-01-01\nprofile: recipe\n{fields}---\n## Steps\n\n1. Mix.\n");
            let (config, site) = public_post(&source);
            let post = &site.posts[0];
            let native = post.html.clone();
            let projection = PortableProjection::from_post(post, &config).unwrap();
            let markdown = projection.portable_markdown().unwrap();
            let text = projection.portable_text().unwrap();
            for fact in expected {
                assert!(markdown.contains(fact), "{fact}: {markdown}");
                assert!(text.contains(fact), "{fact}: {text}");
            }
            assert_eq!(post.html, native);
            assert_eq!(
                post.authored_markdown(),
                crate::frontmatter::parse(&source).unwrap().body
            );
        }
    }

    #[test]
    fn destination_content_plans_inventory_retained_media_and_disclose_unverified_conversion() {
        let body = "![日本語](../media/diagram.svg?size=1#view)\n\n> ![Again](../media/diagram.svg?size=1#view)\n\n<img src='/images/raw.png' alt='Raw'>\n\n<!-- <img src='/PRIVATE_comment.png'> -->\n\n<script><img src='/PRIVATE_script.png'></script>\n\n`![example](../literal.png)`\n\n```html\n<img src='/literal-code.png'>\n```\n";
        let (config, site) =
            public_post(&format!("---\ntitle: Media\ndate: 2020-01-01\n---\n{body}"));
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let output = projection.portable_html().unwrap();
        assert_eq!(output.images.len(), 3);
        assert!(!output.images[0].raw_html);
        assert!(output.images[2].raw_html);
        for policy in destination_policies() {
            let plan = destination_content_plan(policy.provider, "posts/work.md", &output);
            assert_eq!(
                plan,
                destination_content_plan(policy.provider, "posts/work.md", &output)
            );
            assert_eq!(
                plan.policy.content_subset,
                match policy.provider {
                    SyndicationProvider::Ghost | SyndicationProvider::Wordpress =>
                        DestinationContentSubset::AllowlistedStaticHtml,
                    SyndicationProvider::Medium => DestinationContentSubset::ManualCommonmark,
                    _ => DestinationContentSubset::StaticCommonmark,
                }
            );
            assert_eq!(
                plan.policy.media_delivery,
                DestinationMediaDelivery::HostedUrlsOnly
            );
            let html = policy.representation == DestinationRepresentation::PortableHtml;
            assert_eq!(plan.images.len(), if html { 3 } else { 2 });
            assert_eq!(
                plan.images[0],
                "https://example.test/blog/media/diagram.svg?size=1#view"
            );
            assert_eq!(
                plan.images[0], plan.images[1],
                "duplicate media references remain ordered"
            );
            if html {
                assert_eq!(plan.images[2], "https://example.test/blog/images/raw.png");
            }
            assert!(plan
                .diagnostics
                .iter()
                .any(|finding| finding.code == "destination-media-unverified"));
            assert_eq!(
                plan.diagnostics
                    .iter()
                    .any(|finding| finding.code == "destination-raw-html-literal"),
                !html
            );
            plan.validate().unwrap();
            let serialized = serde_json::to_string(&plan).unwrap();
            assert!(!serialized.contains("PRIVATE_"));
            assert!(!serialized.contains("literal-code"));
            assert!(!serialized.contains("literal.png"));
            for finding in &plan.diagnostics {
                assert_eq!(finding.source_path, "posts/work.md");
                assert_eq!(
                    finding.context.destination.as_deref(),
                    Some(policy.label.to_lowercase().as_str())
                );
                assert!(finding.context.representation.is_some());
                assert_eq!(finding.severity, DiagnosticSeverity::Warning);
            }
        }
        assert_eq!(
            projection.representation(RepresentationFormat::Markdown),
            body.trim_end_matches('\n')
        );
        assert!(destination_policy(SyndicationProvider::Ghost)
            .conversion_review
            .contains("lossy"));
    }

    #[test]
    fn destination_media_plans_reject_non_image_schemes_without_inventing_byte_limits() {
        let (config, site) = public_post("---\ntitle: Media\ndate: 2020-01-01\n---\n![Not an image](mailto:author@example.test)\n");
        let output = PortableProjection::from_post(&site.posts[0], &config)
            .unwrap()
            .portable_html()
            .unwrap();
        for policy in destination_policies() {
            let plan = destination_content_plan(policy.provider, "posts/work.md", &output);
            assert!(plan
                .validate()
                .unwrap_err()
                .contains("destination-image-url-invalid"));
            assert_eq!(plan.images, vec!["mailto:author@example.test"]);
            assert!(plan
                .diagnostics
                .iter()
                .any(|finding| finding.severity == DiagnosticSeverity::Error));
        }
        let (config, site) =
            public_post("---\ntitle: Text only\ndate: 2020-01-01\n---\nNo images.\n");
        let output = PortableProjection::from_post(&site.posts[0], &config)
            .unwrap()
            .portable_html()
            .unwrap();
        for policy in destination_policies() {
            let plan = destination_content_plan(policy.provider, "posts/work.md", &output);
            assert!(!plan
                .diagnostics
                .iter()
                .any(|finding| finding.code == "destination-media-unverified"));
            plan.validate().unwrap();
        }
    }

    #[test]
    fn loss_diagnostics_keep_duplicate_nested_source_ranges_and_explicit_semantics() {
        let body = "😀 Intro\n\n> ```quiz\n> Question?\n> - [x] Answer\n> - [ ] Other\n> ```\n\n```quiz\nAgain?\n- [x] Yes\n- [ ] No\n```\n";
        let (config, site) =
            public_post(&format!("---\ntitle: Work\ndate: 2020-01-01\n---\n{body}"));
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let output = projection.portable_html().unwrap();
        let findings = output
            .diagnostics
            .iter()
            .filter(|finding| finding.capability_id.as_deref() == Some("knowledge-check"))
            .collect::<Vec<_>>();
        assert_eq!(findings.len(), 2);
        for (finding, line) in findings.iter().zip([3, 9]) {
            assert_eq!(
                finding.context.source_range.as_ref().unwrap().start_line,
                line
            );
            assert_eq!(
                finding.context.portability_level,
                Some(PortabilityLevel::GracefullyTransformed)
            );
            assert!(finding
                .context
                .affected_semantics
                .as_ref()
                .unwrap()
                .contains("Scoring, retries"));
            let scoped = finding.scoped("portable-text", "portable-export");
            let json = serde_json::to_value(scoped).unwrap();
            assert_eq!(json["representation"], "portable-text");
            assert_eq!(json["destination"], "portable-export");
            assert!(json["sourceRange"]["startLine"].is_number());
            assert!(json["code"].is_string());
            assert!(json["recommendedAction"].is_string());
        }
        assert_eq!(
            output.diagnostics,
            projection.portable_html().unwrap().diagnostics
        );
    }

    #[test]
    fn nested_markdown_fallbacks_remove_engine_syntax_without_losing_container_semantics() {
        let body = "> [!NOTE]\n> Nested lesson\n>\n> ```quiz\n> What is 2 + 2?\n> - [ ] 3\n> - [x] 4\n> ```\n\n- Exercise\n\n  ````rust runnable title=\"main.rs\"\n  fn main() { println!(\"```\"); }\n  ````\n";
        let (config, site) =
            public_post(&format!("---\ntitle: Work\ndate: 2020-01-01\n---\n{body}"));
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let markdown = projection.portable_markdown().unwrap();
        assert!(!markdown.contains("```quiz"), "{markdown}");
        assert!(!markdown.contains("rust runnable"), "{markdown}");
        assert!(!markdown.contains("[!NOTE]"), "{markdown}");
        assert!(markdown.contains("**Answer:** 2. 4"), "{markdown}");
        assert!(markdown.contains("main.rs"), "{markdown}");
        let html = {
            let mut html = String::new();
            pulldown_cmark::html::push_html(
                &mut html,
                Parser::new_ext(&markdown, pulldown_cmark::Options::all()),
            );
            html
        };
        assert!(html.contains("<blockquote>"));
        assert!(html.contains("<li>"));
        assert!(html.contains("fn main()"));
        assert!(html.contains("Run and edit"));
    }

    #[test]
    fn markdown_offsets_preserve_literal_examples_and_resolve_multiline_references_and_embeds() {
        let body = "[guide]:\n../guide/ \"A guide\"\n\nRead [the guide][guide] or [inline](\n../next/\n).\n\n`first\n[literal](../unchanged)\nlast`\n\n    [indented](../unchanged)\n\n> %[https://codepen.io/u/pen/abc]\n\n```text\n%[https://codepen.io/u/pen/literal]\n```\n";
        let (config, site) =
            public_post(&format!("---\ntitle: Work\ndate: 2020-01-01\n---\n{body}"));
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let markdown = projection.portable_markdown().unwrap();
        assert!(
            markdown.contains("[guide]:\nhttps://example.test/blog/guide/"),
            "{markdown}"
        );
        assert!(
            markdown.contains("[inline](\nhttps://example.test/blog/next/\n)"),
            "{markdown}"
        );
        assert!(markdown.contains("[literal](../unchanged)"), "{markdown}");
        assert!(
            markdown.contains("    [indented](../unchanged)"),
            "{markdown}"
        );
        assert!(
            markdown.contains("> [See the Pen on CodePen](https://codepen.io/u/pen/abc)"),
            "{markdown}"
        );
        assert!(
            markdown.contains("%[https://codepen.io/u/pen/literal]"),
            "{markdown}"
        );
        assert!(
            !markdown.contains("%[https://codepen.io/u/pen/abc]"),
            "{markdown}"
        );
        let body = "[`[example](../literal)`](../real/) and [`[example](../literal)`][real]\n\n[real]: ../target/\n";
        let (config, site) =
            public_post(&format!("---\ntitle: Work\ndate: 2020-01-01\n---\n{body}"));
        let markdown = PortableProjection::from_post(&site.posts[0], &config)
            .unwrap()
            .portable_markdown()
            .unwrap();
        assert!(
            markdown.contains("[`[example](../literal)`](https://example.test/blog/real/)"),
            "{markdown}"
        );
        assert!(
            markdown.contains("[`[example](../literal)`][real]"),
            "{markdown}"
        );
        let body = "> Read [nested][guide].\n>\n> [guide]:\n>   ../guide/\n";
        let (config, site) =
            public_post(&format!("---\ntitle: Work\ndate: 2020-01-01\n---\n{body}"));
        let markdown = PortableProjection::from_post(&site.posts[0], &config)
            .unwrap()
            .portable_markdown()
            .unwrap();
        assert!(
            markdown.contains(">   https://example.test/blog/guide/"),
            "{markdown}"
        );
    }

    #[test]
    fn destination_payload_budget_enforces_the_exact_byte_boundary() {
        for (bytes, valid) in [(99_999, true), (100_000, true), (100_001, false)] {
            let plan =
                destination_payload_plan(SyndicationProvider::Hashnode, "posts/large.md", bytes);
            assert_eq!(plan.body_bytes, bytes);
            assert_eq!(plan.validate().is_ok(), valid);
            if !valid {
                assert_eq!(plan.diagnostics[0].source_path, "posts/large.md");
                assert_eq!(plan.diagnostics[0].code, "destination-payload-limit");
            }
        }
        let plan = destination_payload_plan(SyndicationProvider::Dev, "posts/large.md", 100_001);
        assert_eq!(plan.policy.max_request_body_bytes, None);
        assert!(
            plan.diagnostics.is_empty(),
            "do not invent undocumented provider caps"
        );
    }

    #[test]
    fn destination_tags_preserve_order_report_omissions_and_validate_selected_metadata() {
        let tags = (0..16)
            .map(|index| format!("tag{index}"))
            .collect::<Vec<_>>();
        for (provider, limit) in [
            (SyndicationProvider::Dev, 4),
            (SyndicationProvider::Hashnode, 15),
        ] {
            let plan = destination_tag_plan(provider, "posts/tags.md", &tags);
            assert_eq!(plan.tags, tags[..limit]);
            assert_eq!(plan.omitted_tags, tags[limit..]);
            assert_eq!(plan.policy.max_tags, Some(limit));
            assert_eq!(plan.diagnostics[0].code, "destination-tag-limit");
            assert_eq!(plan.diagnostics[0].severity, DiagnosticSeverity::Warning);
            assert_eq!(plan.diagnostics[0].source_path, "posts/tags.md");
            plan.validate().unwrap();
            assert_eq!(plan, destination_tag_plan(provider, "posts/tags.md", &tags));
        }
        for provider in [
            SyndicationProvider::Ghost,
            SyndicationProvider::Wordpress,
            SyndicationProvider::Medium,
        ] {
            let plan = destination_tag_plan(provider, "posts/tags.md", &tags);
            assert!(plan.tags.is_empty());
            assert_eq!(plan.omitted_tags, tags);
            assert_eq!(plan.policy.max_tags, None);
            assert_eq!(plan.diagnostics[0].code, "destination-tags-not-mapped");
            plan.validate().unwrap();
        }
        let unicode = vec!["日本語".into(), "é".repeat(30)];
        destination_tag_plan(SyndicationProvider::Dev, "posts/tags.md", &unicode)
            .validate()
            .unwrap();
        for tag in [
            "bad-tag".into(),
            "<script>".into(),
            "é".repeat(31),
            String::new(),
        ] {
            let plan = destination_tag_plan(SyndicationProvider::Dev, "posts/tags.md", &[tag]);
            assert!(plan.validate().unwrap_err().contains("posts/tags.md: DEV"));
        }
        let plan = destination_tag_plan(
            SyndicationProvider::Hashnode,
            "posts/tags.md",
            &["Rust Tools".into(), "rust-tools".into()],
        );
        assert_eq!(plan.diagnostics[0].severity, DiagnosticSeverity::Info);
        assert!(plan
            .validate()
            .unwrap_err()
            .contains("duplicate destination slug"));
        let plan = destination_tag_plan(
            SyndicationProvider::Hashnode,
            "posts/tags.md",
            &["!!!".into()],
        );
        assert!(plan.validate().is_err());
    }

    #[test]
    fn versioned_destination_policies_disclose_the_actual_publication_contract() {
        for policy in destination_policies() {
            let json = serde_json::to_value(policy).unwrap();
            assert_eq!(json["version"], 1);
            match policy.provider {
                SyndicationProvider::Hashnode => {
                    assert_eq!(json["publication"], "remote-draft-only");
                    assert!(policy
                        .workflow
                        .contains("CLI public publishing is unsupported"));
                }
                SyndicationProvider::Medium => {
                    assert_eq!(json["publication"], "manual-import");
                }
                _ => assert_eq!(json["publication"], "remote-draft-by-default"),
            }
        }
    }

    fn public_post(contents: &str) -> (SiteConfig, Site) {
        let config = SiteConfig::from_json(
            r#"{"title":"T","url":"https://example.test/blog","postPath":"/{slug}/","author":{"name":"Author"}}"#,
        )
        .unwrap();
        let site = Site::load(
            config.clone(),
            Sources {
                posts: vec![SourceFile {
                    path: "posts/work.md".into(),
                    contents: contents.into(),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        (config, site)
    }

    #[test]
    fn projection_selects_existing_views_and_preserves_identity_and_attribution() {
        let (config, site) = public_post(
            "---\ntitle: Work\ndate: 2026-10-01\nprofile: research\nsourceUrl: https://origin.example/work\n---\nBody with [a reference](https://ref.example/paper).\n\n## References\n\n- [Paper](https://ref.example/paper)\n",
        );
        let post = &site.posts[0];
        let projection = PortableProjection::from_post(post, &config).unwrap();
        assert_eq!(
            projection.canonical_url(),
            "https://example.test/blog/work/"
        );
        assert_eq!(projection.base_url(), "https://example.test/blog");
        assert_eq!(projection.source_path(), "posts/work.md");
        assert_eq!(projection.source_url(), Some("https://origin.example/work"));
        assert_eq!(projection.authors().count(), 1);
        assert_eq!(projection.references().len(), 1);
        assert_eq!(
            projection.representation(RepresentationFormat::Html),
            post.html
        );
        assert_eq!(
            projection.representation(RepresentationFormat::Markdown),
            post.authored_markdown
        );
        assert_eq!(
            projection.representation(RepresentationFormat::Text),
            post.text
        );
    }

    #[test]
    fn source_revision_is_stable_and_changes_with_portable_source() {
        let (config, site) = public_post("---\ntitle: Work\ndate: 2026-10-01\n---\nBody\n");
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let revision = projection.source_revision().unwrap();
        assert_eq!(revision.len(), 40);
        assert!(revision.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(revision, projection.source_revision().unwrap());

        let (changed_config, changed_site) =
            public_post("---\ntitle: Work\ndate: 2026-10-01\n---\nChanged body\n");
        let changed =
            PortableProjection::from_post(&changed_site.posts[0], &changed_config).unwrap();
        assert_ne!(revision, changed.source_revision().unwrap());
    }

    #[test]
    fn projection_url_resolution_is_safe_and_base_path_aware() {
        let (config, site) = public_post("---\ntitle: Work\ndate: 2026-10-01\n---\nBody");
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        assert_eq!(
            projection.resolve_link("/images/é.png").unwrap(),
            "https://example.test/blog/images/%C3%A9.png"
        );
        assert_eq!(
            projection.resolve_link("../reference/").unwrap(),
            "https://example.test/blog/reference/"
        );
        assert_eq!(
            projection.resolve_link("#section").unwrap(),
            "https://example.test/blog/work/#section"
        );
        assert_eq!(
            projection.resolve_link("?view=full").unwrap(),
            "https://example.test/blog/work/?view=full"
        );
        assert!(projection.resolve_link("javascript:alert(1)").is_err());
        assert!(projection
            .resolve_link("javascript:alert(1)")
            .unwrap_err()
            .contains("posts/work.md"));
        assert!(projection
            .resolve_link("https://user:secret@example.test/path")
            .is_err());
    }

    #[test]
    fn portable_html_resolves_markdown_urls_without_changing_native_html() {
        let (config, site) = public_post(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n## Repeated heading\n\n[Parent](../reference/), ![image](/images/café.png), [section](#repeated-heading), [external](https://source.example/café?view=full#part).\n\n<details><summary>Raw HTML boundary</summary><p>Preserved.</p></details>\n",
        );
        let post = &site.posts[0];
        let native_html = post.html.clone();
        let projection = PortableProjection::from_post(post, &config).unwrap();
        let output = projection.portable_html().unwrap();

        assert!(output
            .html
            .contains("href=\"https://example.test/blog/reference/\""));
        assert!(output
            .html
            .contains("src=\"https://example.test/blog/images/caf%C3%A9.png\""));
        assert!(output
            .html
            .contains("href=\"https://example.test/blog/work/#repeated-heading\""));
        assert!(output
            .html
            .contains("href=\"https://source.example/caf%C3%A9?view=full#part\""));
        assert!(output.html.contains("<h2 id=\"repeated-heading\">"));
        assert!(output
            .html
            .contains("<details><summary>Raw HTML boundary</summary>"));
        assert!(!output.html.contains("<script type=\"module\""));
        assert_eq!(post.html, native_html);
        assert_eq!(projection.portable_html().unwrap(), output);
    }

    #[test]
    fn an_ipv6_literal_link_projects_to_every_representation() {
        let (config, site) = public_post(
            "---\ntitle: Work\ndate: 2026-10-01\n---\nSee [http://\\[2001:db8::1\\]/x](http://[2001:db8::1]/x) and <http://[2001:db8::2]/y> and [here](http://[2001:db8::3]/z).\n",
        );
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let html = projection.portable_html().unwrap();
        assert!(
            html.html.contains("href=\"http://[2001:db8::1]/x\""),
            "{}",
            html.html
        );
        assert!(
            html.html.contains("href=\"http://[2001:db8::2]/y\""),
            "{}",
            html.html
        );
        assert!(
            html.html.contains("href=\"http://[2001:db8::3]/z\""),
            "{}",
            html.html
        );
        projection.portable_markdown().unwrap();
        projection.portable_text().unwrap();
    }

    #[test]
    fn portable_markdown_transforms_custom_blocks_and_keeps_public_context() {
        let (config, site) = public_post(
            "---\ntitle: Work\ndate: 2026-10-01\nprofile: research\nsourceUrl: https://origin.example/work\ndoi: 10.1234/example\nlicense: https://creativecommons.org/licenses/by/4.0/\n---\n> [!TIP]\n> Keep the source.\n\n[Parent](../reference/), [section](#chapter).\n\n```quiz\nWhat is portable?\n- [ ] A second source\n- [x] A derived representation\n> It comes from the canonical work.\n```\n\n```rust runnable title=\"Try the example\"\nfn main() { let text = \"[literal](../not-a-link)\"; }\n```\n\n<script>alert(1)</script>\n",
        );
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let markdown = projection.portable_markdown().unwrap();
        assert!(markdown.starts_with("# Work\n\nCanonical: <https://example.test/blog/work/>"));
        assert!(
            markdown.contains("> **Tip:**\n> Keep the source."),
            "{markdown}"
        );
        assert!(markdown.contains("[Parent](https://example.test/blog/reference/)"));
        assert!(markdown.contains("[section](https://example.test/blog/work/#chapter)"));
        assert!(markdown.contains("**Question:** What is portable?"));
        assert!(markdown.contains("**Answer:** 2. A derived representation"));
        assert!(markdown.contains("Portable fallback"));
        assert!(markdown.contains("scoring or retries matter"));
        assert!(markdown.contains("**Try the example**"));
        assert!(markdown
            .contains("```rust\nfn main() { let text = \"[literal](../not-a-link)\"; }\n```"));
        assert!(markdown.contains("[Run and edit this example on the canonical article]"));
        assert!(markdown.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(markdown.contains("10.1234/example"), "{markdown}");
        assert!(markdown.contains("Originally published at <https://origin.example/work>."));
        assert!(!markdown.contains("```quiz"));
        assert!(!markdown.contains("<script>"));
    }

    #[test]
    fn portable_html_errors_are_scoped_to_the_source() {
        let (config, site) =
            public_post("---\ntitle: Work\ndate: 2026-10-01\n---\n[unsafe](javascript:alert(1))\n");
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let error = projection.portable_html().unwrap_err();
        assert!(error.contains("posts/work.md"), "{error}");
        assert!(
            error.contains("link must use HTTP(S), mailto, or tel"),
            "{error}"
        );
    }

    fn portable(contents: &str) -> PortableHtmlOutput {
        let (config, site) = public_post(contents);
        PortableProjection::from_post(&site.posts[0], &config)
            .unwrap()
            .portable_html()
            .unwrap()
    }

    #[test]
    fn portable_quiz_keeps_prompt_choices_and_answer_without_controls() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n```quiz\nWhat does `draft: true` do?\n- [ ] Publishes *privately*\n- [x] Excludes the post from public builds\n> Drafts stay in preview.\n```\n",
        );
        assert!(output.html.contains(
            "<section class=\"ob-knowledge-check\" aria-label=\"Knowledge check\">\n<div class=\"ob-quiz\">\n<p class=\"ob-quiz-prompt\"><strong>What does <code>draft: true</code> do?</strong></p>\n<ol class=\"ob-quiz-choices\" type=\"A\">\n<li>Publishes <em>privately</em></li>\n<li>Excludes the post from public builds</li>\n</ol>\n<div class=\"ob-quiz-answer\">\n<p>Answer: B. Excludes the post from public builds</p>\n<p>Drafts stay in preview.</p>\n</div>\n</div>\n</section>\n"
        ), "{}", output.html);
        for runtime in [
            "<ob-quiz",
            "<input",
            "<button",
            "data-correct",
            "data-key",
            " hidden",
        ] {
            assert!(!output.html.contains(runtime), "{runtime}: {}", output.html);
        }
        assert_eq!(output.capabilities[0].id, "knowledge-check");
    }

    #[test]
    fn portable_runnable_code_keeps_source_and_points_to_the_canonical_runner() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n```rust runnable title=\"src/<main>.rs\" {2} showLineNumbers\nfn main() {\n    println!(\"<hi> & bye\");\n}\n```\n\n```python runnable\nprint('static')\n```\n",
        );
        assert!(output.html.contains(
            "<figure class=\"ob-code-block ob-runnable-code\"><figcaption class=\"ob-code-title\">src/&lt;main&gt;.rs</figcaption><pre><code class=\"language-rust\" data-line-numbers=\"true\" data-highlight-lines=\"2\">fn main() {\n    println!(&quot;&lt;hi&gt; &amp; bye&quot;);\n}\n</code></pre>"
        ), "{}", output.html);
        assert!(output.html.contains("<p class=\"ob-portable-note\">Run and edit this example on <a href=\"https://example.test/blog/work/\">the original article</a>.</p></figure>"));
        assert!(
            output
                .html
                .contains("<pre><code class=\"language-python\">print('static')\n</code></pre>"),
            "a fence the canonical page cannot run stays ordinary code: {}",
            output.html
        );
        assert_eq!(output.html.matches("ob-portable-note").count(), 1);
        for runtime in ["<ob-", "data-runnable", "data-endpoint"] {
            assert!(!output.html.contains(runtime), "{runtime}: {}", output.html);
        }
        assert_eq!(
            output
                .capabilities
                .iter()
                .map(|capability| (capability.id.as_str(), capability.native_renderer))
                .collect::<Vec<_>>(),
            [
                ("runnable-code", Some("ob-rust-playground")),
                ("runnable-code", None)
            ]
        );
    }

    #[test]
    fn portable_copies_of_a_rust_check_fence_show_the_starter_and_tuck_the_checks_in_a_spoiler() {
        let contents = "---\ntitle: Work\ndate: 2026-10-01\n---\n```rust runnable check title=\"Add them\"\nfn add(a: u32, b: u32) -> u32 {\n    0\n}\n---checks\n/// Add them <together>.\n#[test]\nfn adds() {\n    assert_eq!(add(2, 3), 5);\n}\n```\n";
        let (config, site) = public_post(contents);
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let html = projection.portable_html().unwrap().html;
        let markdown = projection.portable_markdown().unwrap();
        let label = "Spoiler: the checks for this challenge";
        for (kind, text) in [("html", &html), ("markdown", &markdown)] {
            let starter = text
                .find("fn add(a: u32, b: u32)")
                .unwrap_or_else(|| panic!("{kind}: {text}"));
            let spoiler = text
                .find(label)
                .unwrap_or_else(|| panic!("{kind} has no spoiler label: {text}"));
            let checks = text
                .find("assert_eq!(add(2, 3), 5)")
                .unwrap_or_else(|| panic!("{kind} lost the checks: {text}"));
            assert!(
                starter < spoiler && spoiler < checks,
                "{kind}: starter, then the label, then the checks: {text}"
            );
            assert!(text.contains("<details"), "{kind}: {text}");
            assert!(text.contains("gives away the answer"), "{kind}: {text}");
            assert!(
                !text[..spoiler].contains("assert_eq"),
                "{kind}: nothing of the checks before the spoiler: {text}"
            );
            for internal in ["---checks", "ob_checks", "data-ob-rust-checks"] {
                assert!(!text.contains(internal), "{kind} leaked {internal}: {text}");
            }
            assert!(
                text.contains("original article") || text.contains("canonical article"),
                "{kind}: {text}"
            );
        }
        // The HTML escapes the checks like any other code, and the Markdown fences them.
        assert!(html.contains("Add them &lt;together&gt;."), "{html}");
        assert!(
            markdown.contains("```rust\n/// Add them <together>."),
            "{markdown}"
        );
        assert!(!html.contains("<ob-") && !markdown.contains("<ob-"));
    }

    #[test]
    fn portable_rust_playground_links_preserve_exact_source_and_runner_options() {
        let source = "fn main() {\n    println!(\"café & + # ? \\\" </script>\");\n}\n";
        let contents =
            format!("---\ntitle: Work\ndate: 2026-10-01\n---\n```RuSt runnable\n{source}```\n");
        let (config, site) = public_post(&contents);
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let html = projection.portable_html().unwrap().html;
        let markdown = projection.portable_markdown().unwrap();
        let markdown_url = markdown
            .split("[Open in Rust Playground](")
            .nth(1)
            .unwrap()
            .split(')')
            .next()
            .unwrap();
        let url = Url::parse(markdown_url).unwrap();
        let query = url
            .query_pairs()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            url.origin().ascii_serialization(),
            "https://play.rust-lang.org"
        );
        assert_eq!(query.get("code").unwrap(), source);
        assert_eq!(query.get("version").unwrap(), "stable");
        assert_eq!(query.get("mode").unwrap(), "debug");
        assert_eq!(query.get("edition").unwrap(), "2021");
        assert!(html.contains(&format!("href=\"{}\"", escape::attr(markdown_url))));
        assert!(html.contains(projection.canonical_url()));
        assert!(markdown.contains(projection.canonical_url()));
        assert!(!html.contains("<script>"));
        assert!(site.posts[0].html.contains("<ob-rust-playground"));
    }

    #[test]
    fn portable_copies_follow_the_site_wide_playground_setting() {
        let contents = "---
title: Work
date: 2026-10-01
---
```rust runnable
fn main() {}
```

```rust runnable playgroundLink=true
fn main() {}
```
";
        let (mut config, site) = public_post(contents);
        let linked = |config: &SiteConfig| {
            let projection = PortableProjection::from_post(&site.posts[0], config).unwrap();
            (
                projection
                    .portable_html()
                    .unwrap()
                    .html
                    .matches("play.rust-lang.org")
                    .count(),
                projection
                    .portable_markdown()
                    .unwrap()
                    .matches("play.rust-lang.org")
                    .count(),
            )
        };
        assert_eq!(linked(&config), (2, 2));
        config.code.playground_link = false;
        assert_eq!(
            linked(&config),
            (1, 1),
            "only the fence that asks for the link keeps it"
        );
    }

    #[test]
    fn portable_playground_links_honor_opt_out_and_keep_long_snippets_without_links() {
        for info in [
            "rust runnable playgroundLink=false",
            "python runnable",
            "rust",
        ] {
            let contents = format!(
                "---\ntitle: Work\ndate: 2026-10-01\n---\n```{info}\nfn main() {{}}\n```\n"
            );
            let (config, site) = public_post(&contents);
            let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
            assert!(!projection
                .portable_html()
                .unwrap()
                .html
                .contains("play.rust-lang.org"));
            assert!(!projection
                .portable_markdown()
                .unwrap()
                .contains("play.rust-lang.org"));
        }
        let source = format!("// {}\nfn main() {{}}\n", "x".repeat(8 * 1024));
        let contents =
            format!("---\ntitle: Work\ndate: 2026-10-01\n---\n```rust runnable\n{source}```\n");
        let (config, site) = public_post(&contents);
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let html = projection.portable_html().unwrap().html;
        let markdown = projection.portable_markdown().unwrap();
        for output in [&html, &markdown] {
            assert!(!output.contains("play.rust-lang.org"));
            assert!(output.contains(&source));
            assert!(output.contains(projection.canonical_url()));
        }
        let prefix = crate::markdown::rust_playground_url("").unwrap().len();
        assert_eq!(
            crate::markdown::rust_playground_url(&"x".repeat(8 * 1024 - prefix))
                .unwrap()
                .len(),
            8 * 1024
        );
        assert!(crate::markdown::rust_playground_url(&"x".repeat(8 * 1024 - prefix + 1)).is_none());
    }

    #[test]
    fn portable_markdown_excludes_html_comments_but_keeps_comment_syntax_in_code() {
        let contents = "---\ntitle: Work\ndate: 2026-10-01\n---\nBefore <!-- PRIVATE_INLINE --> after.\n\n<div>\n<!-- PRIVATE_BLOCK\n\nPRIVATE_CONTINUED\n\n```text\nPRIVATE_CODE_IN_COMMENT\n```\n\n<p>PRIVATE_END --></p>\n</div>\n\nVisible tail.\n\n`<!-- EXAMPLE_INLINE -->`\n\n```html\n<!-- EXAMPLE_FENCED -->\n```\n";
        let (config, site) = public_post(contents);
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let markdown = projection.portable_markdown().unwrap();
        let text = projection.portable_text().unwrap();
        for output in [&markdown, &text] {
            assert!(!output.contains("PRIVATE_"), "{output}");
            assert!(output.contains("Visible tail."), "{output}");
            assert!(output.contains("EXAMPLE_INLINE"), "{output}");
            assert!(output.contains("EXAMPLE_FENCED"), "{output}");
        }
        assert!(markdown.contains("&lt;div&gt;"));
        assert!(markdown.contains("`<!-- EXAMPLE_INLINE -->`"));
        assert!(markdown.contains("```html\n<!-- EXAMPLE_FENCED -->\n```"));
    }

    #[test]
    fn portable_runnable_code_follows_the_configured_runner_without_its_endpoint() {
        let config = SiteConfig::from_json(
            r#"{"title":"T","url":"https://example.test","codeRunner":{"endpoint":"https://runner.example/execute","languages":["python"]}}"#,
        )
        .unwrap();
        let site = Site::load(
            config.clone(),
            Sources {
                posts: vec![SourceFile {
                    path: "posts/run.md".into(),
                    contents: "---\ntitle: Run\ndate: 2026-10-01\n---\n```python runnable\nprint('hi')\n```\n".into(),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        let output = PortableProjection::from_post(&site.posts[0], &config)
            .unwrap()
            .portable_html()
            .unwrap();
        assert!(output.html.contains("<figure class=\"ob-code-block ob-runnable-code\"><pre><code class=\"language-python\">print(&#39;hi&#39;)\n</code></pre><p class=\"ob-portable-note\">"), "{}", output.html);
        assert!(!output.html.contains("runner.example"), "{}", output.html);
        assert_eq!(
            output.capabilities[0].native_renderer,
            site.posts[0].capabilities[0].native_renderer
        );
    }

    #[test]
    fn portable_titled_runnable_fence_does_not_wrap_a_later_indented_block() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n```rust runnable title=\"main.rs\"\nfn main(){}\n```\n\nText\n\n    indented code\n",
        );
        assert_eq!(output.html.matches("<figure").count(), 1, "{}", output.html);
        assert_eq!(
            output.html.matches("</figure>").count(),
            1,
            "{}",
            output.html
        );
        assert!(
            output
                .html
                .ends_with("<p>Text</p>\n<pre><code>indented code</code></pre>\n"),
            "{}",
            output.html
        );
    }

    #[test]
    fn empty_quiz_and_web_sandbox_fences_still_build() {
        // Before fences were collected whole, a fence with no text was never
        // validated; existing posts that contain one keep building.
        let (config, site) = public_post(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n```quiz\n```\n\n```web runnable\n```\n\nBody\n",
        );
        let post = &site.posts[0];
        assert!(post.html.contains("<ob-web-sandbox>"), "{}", post.html);
        let output = PortableProjection::from_post(post, &config)
            .unwrap()
            .portable_html()
            .unwrap();
        assert!(output.html.contains("<p>Body</p>"), "{}", output.html);
        assert!(!output.html.contains("<ob-"), "{}", output.html);
        // Whitespace-only text is still written content, and still validated.
        let (config, site) = public_post("---\ntitle: Work\ndate: 2026-10-01\n---\nBody\n");
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let rendered = crate::markdown::render_portable(
            "```web runnable\n\n```\n",
            projection.render_options,
            &projection,
        )
        .unwrap();
        assert_eq!(rendered.errors.len(), 1, "{:?}", rendered.errors);
    }

    #[test]
    fn portable_web_sandbox_labels_each_source_and_omits_the_live_preview() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n```web runnable title=\"Try it\"\nStarter notes\n---html\n<button onclick=\"alert(1)\">Hi</button>\n---css\nbutton { color: red; }\n---js\ndocument.querySelector('button').textContent = '</script>';\n```\n",
        );
        assert!(output.html.contains(
            "<figure class=\"ob-code-block ob-web-sandbox\"><figcaption class=\"ob-code-title\">Try it</figcaption><pre><code>Starter notes\n</code></pre><p class=\"ob-web-sandbox-label\">HTML</p><pre><code class=\"language-html\">&lt;button onclick=&quot;alert(1)&quot;&gt;Hi&lt;/button&gt;\n</code></pre><p class=\"ob-web-sandbox-label\">CSS</p><pre><code class=\"language-css\">button { color: red; }\n</code></pre><p class=\"ob-web-sandbox-label\">JavaScript</p><pre><code class=\"language-js\">document.querySelector(&#39;button&#39;).textContent = &#39;&lt;/script&gt;&#39;;\n</code></pre><p class=\"ob-portable-note\">Open the live preview on <a href=\"https://example.test/blog/work/\">the original article</a>.</p></figure>\n"
        ), "{}", output.html);
        assert!(!output.html.contains("<button"));
        assert!(!output.html.contains("<ob-web-sandbox"));
        assert_eq!(output.capabilities[0].id, "web-sandbox");
    }

    #[test]
    fn portable_demo_keeps_the_authored_description_and_links_to_the_live_version() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n```demo fetch-lab title=\"Break fetch\"\nSend `/api/posts/99` and read `response.ok`: it is `false`, yet `fetch()` resolved.\n```\n",
        );
        assert!(output.html.contains(
            "<figure class=\"ob-demo ob-portable-demo\" data-demo=\"fetch-lab\"><figcaption class=\"ob-code-title\">Break fetch</figcaption><p>Send <code>/api/posts/99</code> and read <code>response.ok</code>: it is <code>false</code>, yet <code>fetch()</code> resolved.</p>\n<p class=\"ob-portable-note\">Try the interactive Fetch and storage inspector on <a href=\"https://example.test/blog/work/\">the original article</a>.</p></figure>\n"
        ), "{}", output.html);
        assert!(!output.html.contains("<ob-fetch-lab"));
        assert!(!output.html.contains("<script"));
        assert_eq!(output.capabilities[0].id, "interactive-demo");
        assert_eq!(
            output.capabilities[0].portability,
            PortabilityLevel::GracefullyTransformed
        );
        assert!(output
            .diagnostics
            .iter()
            .any(|d| d.code == "graceful-transformation"
                && d.capability_id.as_deref() == Some("interactive-demo")));
    }

    #[test]
    fn portable_markdown_demo_has_a_caption_the_description_and_a_canonical_link() {
        let (config, site) = public_post(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n```demo git-sandbox title=\"Merge it\"\nBranch, commit on both sides, then merge: Git makes a commit with two parents.\n```\n\n```demo component-lab\n```\n",
        );
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let markdown = projection.portable_markdown().unwrap();
        assert!(markdown.contains("**Merge it**\n\nBranch, commit on both sides, then merge: Git makes a commit with two parents.\n\n[Try the interactive Git sandbox on the canonical article](https://example.test/blog/work/).\n"), "{markdown}");
        assert!(
            markdown.contains("A live custom element with a real shadow root"),
            "{markdown}"
        );
        assert!(markdown
            .contains("[Try the interactive Web Components explorer on the canonical article]"));
        assert!(!markdown.contains("```demo"));
        assert!(markdown.contains("Portable fallback"));
    }

    #[test]
    fn a_portable_copy_that_loses_a_demos_description_or_live_link_is_flagged() {
        let (config, site) = public_post(
            "---
title: Work
date: 2026-10-01
---
```demo git-sandbox title=\"Merge it\"
Branch, commit on both sides, then merge.
```
",
        );
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let html = projection.portable_html().unwrap().html;
        let markdown = projection.portable_markdown().unwrap();
        for (format, artifact) in [
            (RepresentationFormat::Html, html.as_str()),
            (RepresentationFormat::Markdown, markdown.as_str()),
        ] {
            let findings = projection
                .analyze_portable_artifact(format, artifact)
                .unwrap();
            assert!(findings.is_empty(), "{format:?}: {findings:?}");
        }
        for (format, artifact) in [
            (
                RepresentationFormat::Html,
                html.replace("Branch, commit on both sides, then merge.", ""),
            ),
            (
                RepresentationFormat::Html,
                html.replace("https://example.test/blog/work/", "https://wrong.example/"),
            ),
            (
                RepresentationFormat::Markdown,
                markdown.replace("Branch, commit on both sides, then merge.", ""),
            ),
            (
                RepresentationFormat::Markdown,
                markdown.replace("**Merge it**", ""),
            ),
            (
                RepresentationFormat::Markdown,
                markdown.replace("Git sandbox", "tool"),
            ),
        ] {
            let findings = projection
                .analyze_portable_artifact(format, &artifact)
                .unwrap();
            assert!(
                findings
                    .iter()
                    .any(|finding| finding.code == "missing-semantic-fact"),
                "{format:?}: a lost demo fact was accepted"
            );
        }
    }

    #[test]
    fn a_malformed_demo_fails_the_portable_markdown_for_its_source() {
        let config = SiteConfig::from_json(
            r#"{"title":"Blog","url":"https://example.test/blog/","postPath":"/{slug}/"}"#,
        )
        .unwrap();
        let error = Site::load(
            config,
            Sources {
                posts: vec![SourceFile {
                    path: "posts/work.md".into(),
                    contents: "---\ntitle: Work\ndate: 2026-10-01\n---\n```demo git-sandbox\n[x](http://insecure.test/)\n```\n".into(),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .map(|_| ())
        .unwrap_err();
        assert!(error[0].contains("absolute https URLs"), "{error:?}");
    }

    #[test]
    fn invalid_portable_capabilities_fail_for_the_source_and_capability() {
        let (config, site) = public_post("---\ntitle: Work\ndate: 2026-10-01\n---\nBody");
        let post = &site.posts[0];
        let native_html = post.html.clone();
        let projection = PortableProjection::from_post(post, &config).unwrap();
        let rendered = crate::markdown::render_portable(
            "```web runnable\n<p>no markers</p>\n```\n\n```quiz\nQuestion?\n- [x] Yes\n- [ ] No\n```\n",
            projection.render_options,
            &projection,
        )
        .unwrap();
        assert_eq!(rendered.errors.len(), 1, "{:?}", rendered.errors);
        assert!(rendered.errors[0].contains("`web runnable` fence"));
        assert_eq!(
            rendered
                .capabilities
                .iter()
                .map(|capability| (capability.id.as_str(), capability.diagnostics.len()))
                .collect::<Vec<_>>(),
            [("web-sandbox", 1), ("knowledge-check", 0)],
            "only the malformed capability carries a diagnostic"
        );
        assert!(
            rendered.html.contains("<p class=\"ob-quiz-prompt\">"),
            "{}",
            rendered.html
        );
        assert_eq!(post.html, native_html);
        assert_eq!(projection.portable_html().unwrap().html, "<p>Body</p>\n");
    }

    #[test]
    fn portable_callouts_keep_a_visible_title_without_styles() {
        let output =
            portable("---\ntitle: Work\ndate: 2026-10-01\n---\n> [!WARNING]\n> Hot *pan*.\n");
        assert!(output.html.contains(
            "<aside class=\"ob-callout ob-callout-warning\" role=\"note\"><p class=\"ob-callout-title\"><strong>Warning</strong></p>\n<p>Hot <em>pan</em>.</p>\n</aside>"
        ), "{}", output.html);
    }

    #[test]
    fn portable_pieces_keep_their_content_and_embeds_become_links() {
        let output = portable(
            "---
title: Work
date: 2026-10-01
---
```piece video
provider: vimeo
video: 12345
title: Tour
```

```piece map
provider: openstreetmap
label: The shop
lat: 51.5
lon: -0.12
```

```piece hours
days: Mon
hours: 9 to 5
```
",
        );
        assert!(!output.html.contains("<iframe"), "{}", output.html);
        assert!(
            output.html.contains("href=\"https://vimeo.com/12345\""),
            "{}",
            output.html
        );
        assert!(output.html.contains("Watch Tour on Vimeo"));
        assert!(output
            .html
            .contains("https://www.openstreetmap.org/?mlat=51.500000"));
        assert!(
            output.html.contains("<th scope=\"row\">Mon</th>"),
            "{}",
            output.html
        );
    }

    #[test]
    fn portable_media_embeds_become_titled_provider_links() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n[Gate of Embers — trailer](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s)\n\n<https://codepen.io/u/pen/abc>\n\n%[https://codepen.io/team/acme/pen/xyz]\n\nSee [this pen](https://codepen.io/u/pen/def) inline.\n",
        );
        assert!(output.html.contains(
            "<p class=\"ob-embed-link ob-embed-youtube\"><a href=\"https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=42s\">Gate of Embers — trailer</a> (Watch on YouTube)</p>\n"
        ), "{}", output.html);
        assert!(output.html.contains(
            "<p class=\"ob-embed-link ob-embed-codepen\"><a href=\"https://codepen.io/u/pen/abc\">See the Pen on CodePen</a></p>\n"
        ), "{}", output.html);
        assert!(
            output.html.contains(
                "<p class=\"ob-embed-link ob-embed-codepen\"><a href=\"https://codepen.io/team/acme/pen/xyz\">See the Pen on CodePen</a></p>\n"
            ),
            "Hashnode embed syntax never reaches the output raw: {}",
            output.html
        );
        assert!(!output.html.contains("%["));
        assert!(output
            .html
            .contains("See <a href=\"https://codepen.io/u/pen/def\">this pen</a> inline."));
        assert!(!output.html.contains("<iframe"));
    }

    #[test]
    fn portable_video_posts_keep_the_video_link_and_linked_chapters() {
        let output = portable(
            "---\ntitle: Gate of Embers\ndate: 2026-10-01\nprofile: video\nvideoUrl: https://youtu.be/dQw4w9WgXcQ\n---\n## Chapters\n\n00:00 The gate opens\n00:14 A warning in the *dark*\n1:02:03 Into the ruin — Ünter\n\nNarration at 00:14 stays prose.\n",
        );
        assert!(output.html.starts_with(
            "<p class=\"ob-embed-link ob-embed-youtube\"><a href=\"https://www.youtube.com/watch?v=dQw4w9WgXcQ\">Gate of Embers on YouTube</a></p>\n"
        ), "{}", output.html);
        assert!(output.html.contains(
            "<ol class=\"ob-chapters\" aria-label=\"Video chapters\">\n<li><a href=\"https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=0s\"><time datetime=\"PT0S\">00:00</time></a> The gate opens</li>\n<li><a href=\"https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=14s\"><time datetime=\"PT14S\">00:14</time></a> A warning in the <em>dark</em></li>\n<li><a href=\"https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=3723s\"><time datetime=\"PT3723S\">1:02:03</time></a> Into the ruin — Ünter</li>\n</ol>\n"
        ), "{}", output.html);
        assert!(output
            .html
            .contains("<p>Narration at 00:14 stays prose.</p>"));
    }

    #[test]
    fn portable_chapters_accept_the_admin_release_kit_grammar() {
        let output = portable(
            "---\ntitle: Episode\ndate: 2026-10-01\nprofile: video\n---\n- 00:00 Intro\n- 1:2:03 Part *two*\n\n* 00:00 Only one bullet\n\n- 00:00 Loose\n\n  More text.\n- 00:30 Item\n",
        );
        assert!(output.html.starts_with(
            "<ol class=\"ob-chapters\" aria-label=\"Video chapters\">\n<li><time datetime=\"PT0S\">00:00</time> Intro</li>\n<li><time datetime=\"PT3723S\">1:2:03</time> Part <em>two</em></li>\n</ol>\n"
        ), "{}", output.html);
        assert!(
            output
                .html
                .contains("<ul>\n<li>00:00 Only one bullet</li>\n</ul>"),
            "{}",
            output.html
        );
        assert_eq!(
            output.html.matches("ob-chapters").count(),
            1,
            "{}",
            output.html
        );
    }

    #[test]
    fn portable_video_posts_keep_their_production_notes() {
        let output = portable(
            "---\ntitle: Episode one\ndate: 2026-10-01\nprofile: video\nseasonNumber: 2\nepisodeNumber: 4\nproductionStatus: released\nproductionCredits: Writing by Mira & <Lantern>\nvideoUrl: https://youtu.be/dQw4w9WgXcQ\n---\nBody\n",
        );
        assert!(output.html.starts_with(
            "<aside class=\"ob-video-production\" aria-label=\"Video production summary\"><h2>Production notes</h2><dl><div><dt>Production</dt><dd>Season 2, episode 4</dd></div><div><dt>Status</dt><dd>released</dd></div><div><dt>Credits</dt><dd>Writing by Mira &amp; &lt;Lantern&gt;</dd></div></dl></aside>\n<p class=\"ob-embed-link ob-embed-youtube\">"
        ), "{}", output.html);
    }

    #[test]
    fn portable_recipes_keep_their_summary_facts() {
        let output = portable(
            "---\ntitle: Basil pasta\ndate: 2026-10-01\nprofile: recipe\nprep: 10\ncook: overnight\nservings: 4\ncuisine: Italian & <more>\n---\n## Ingredients\n\n- 1 cup flour\n",
        );
        assert!(output.html.starts_with(
            "<section class=\"ob-recipe-card\" aria-label=\"Recipe summary\">\n<dl class=\"ob-recipe-facts\"><div><dt>Prep</dt><dd><time datetime=\"PT10M\">10 min</time></dd></div><div><dt>Cook</dt><dd>overnight</dd></div><div><dt>Serves</dt><dd>4</dd></div><div><dt>Cuisine</dt><dd>Italian &amp; &lt;more&gt;</dd></div></dl>\n</section>\n"
        ), "{}", output.html);
        assert!(
            !output.html.contains("ob-recipe-servings"),
            "{}",
            output.html
        );
        let output = portable(
            "---\ntitle: Toast\ndate: 2026-10-01\nprofile: recipe\n---\n## Steps\n\n1. Toast.\n",
        );
        assert!(!output.html.contains("Recipe summary"), "{}", output.html);
    }

    #[test]
    fn portable_chapters_without_a_video_stay_visible_and_other_posts_keep_prose() {
        let output = portable(
            "---\ntitle: Episode\ndate: 2026-10-01\nprofile: video\n---\n00:00 Intro\n00:30 <b>Bold</b> claim\n",
        );
        assert!(
            output
                .html
                .contains("<p>00:00 Intro\n00:30 <b>Bold</b> claim</p>"),
            "inline HTML is not a chapter label: {}",
            output.html
        );
        let output = portable(
            "---\ntitle: Episode\ndate: 2026-10-01\nprofile: video\n---\n00:00 Intro\n00:30 Middle\n",
        );
        assert!(output.html.contains(
            "<ol class=\"ob-chapters\" aria-label=\"Video chapters\">\n<li><time datetime=\"PT0S\">00:00</time> Intro</li>\n<li><time datetime=\"PT30S\">00:30</time> Middle</li>\n</ol>\n"
        ), "{}", output.html);
        let output =
            portable("---\ntitle: Log\ndate: 2026-10-01\n---\n10:30 Arrived\n11:45 Summit\n");
        assert!(output.html.contains("<p>10:30 Arrived\n11:45 Summit</p>"));
    }

    #[test]
    fn portable_recipes_keep_their_sections_and_lists() {
        let output = portable(
            "---\ntitle: Basil pasta\ndate: 2026-10-01\nprofile: recipe\n---\nStory.\n\n## Ingredients\n\n- 1 cup flour\n- 2 eggs\n\n## Steps\n\n1. Mix.\n2. Bake 20 minutes.\n",
        );
        assert!(
            output.html.contains(
                "<section class=\"ob-recipe-part ob-recipe-ingredients\">\n<h2 id=\"ingredients\">"
            ),
            "{}",
            output.html
        );
        assert!(output.html.contains("<ul class=\"ob-recipe-list ob-ingredients\">\n<li>1 cup flour</li>\n<li>2 eggs</li>\n</ul>"));
        assert!(output.html.contains("<ol class=\"ob-recipe-list ob-steps\">\n<li>Mix.</li>\n<li>Bake 20 minutes.</li>\n</ol>"));
        assert!(!output.html.contains("<ob-recipe"));
    }

    fn engaged_post(comments: &str, endpoint: &str) -> PortableHtmlOutput {
        let config = SiteConfig::from_json(&format!(
            r#"{{"title":"T","url":"https://example.test","engagement":{{"enabled":true,"endpoint":"{endpoint}"}}}}"#
        ))
        .unwrap();
        let site = Site::load(
            config.clone(),
            Sources {
                posts: vec![SourceFile {
                    path: "posts/talk.md".into(),
                    contents: format!(
                        "---\ntitle: Talk\ndate: 2026-10-01\ncomments: {comments}\n---\nBody\n"
                    ),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        PortableProjection::from_post(&site.posts[0], &config)
            .unwrap()
            .portable_html()
            .unwrap()
    }

    #[test]
    fn portable_participation_links_to_the_canonical_discussion() {
        let open = engaged_post("open", "https://engage.example/api");
        assert!(open.html.ends_with(
            "<p class=\"ob-participation\"><a href=\"https://example.test/posts/talk/#ob-discussion\">Join the discussion on the original article</a>.</p>\n"
        ), "{}", open.html);
        let locked = engaged_post("locked", "https://engage.example/api");
        assert!(locked.html.ends_with(
            "<p class=\"ob-participation\">Comments are closed. <a href=\"https://example.test/posts/talk/#ob-discussion\">Read the discussion on the original article</a>.</p>\n"
        ), "{}", locked.html);
        for output in [&open, &locked] {
            assert!(!output.html.contains("engage.example"), "{}", output.html);
            assert!(!output.html.contains("<form"), "{}", output.html);
            assert!(!output.html.contains("<ob-comments"), "{}", output.html);
            let comments = output.capabilities.last().unwrap();
            assert_eq!(comments.id, "comments");
            assert_eq!(
                comments.portability,
                crate::capability::PortabilityLevel::CanonicalOnlyInteraction
            );
            assert_eq!(comments.fallback_renderer, Some("canonical-link"));
        }
        let hidden = engaged_post("hidden", "https://engage.example/api");
        assert_eq!(hidden.html, "<p>Body</p>\n");
        assert!(hidden.capabilities.is_empty());
        let without_backend = portable("---\ntitle: Work\ndate: 2026-10-01\n---\nBody\n");
        assert_eq!(without_backend.html, "<p>Body</p>\n");
    }

    #[test]
    fn portable_research_posts_keep_their_work_identifier_and_license() {
        let output = portable(
            "---\ntitle: Study\ndate: 2026-10-01\nprofile: research\ndoi: 10.1234/café/results\nlicense: https://creativecommons.org/licenses/by/4.0/\n---\n## Abstract\n\nSummary.\n",
        );
        assert!(output.html.starts_with(
            "<aside class=\"ob-work-meta\" aria-label=\"Research work details\"><dl><div><dt>DOI</dt><dd><a href=\"https://doi.org/10.1234/caf%C3%A9%2Fresults\">10.1234/café/results</a></dd></div><div><dt>Reuse</dt><dd><a href=\"https://creativecommons.org/licenses/by/4.0/\">License</a></dd></div></dl></aside>\n<h2 id=\"abstract\">"
        ), "{}", output.html);
        // A DOI that cannot be resolved is not presented as the work's identity,
        // exactly as on the native page.
        let output = portable(
            "---\ntitle: Study\ndate: 2026-10-01\nprofile: research\ndoi: \"not a <doi>\"\nlicense: javascript:alert(1)\n---\nBody\n",
        );
        assert_eq!(output.html, "<p>Body</p>\n");
    }

    #[test]
    fn portable_footnote_citations_keep_their_identity_and_point_to_the_canonical_note() {
        let output = portable(
            "---\ntitle: Study\ndate: 2026-10-01\n---\nA claim[^zürich] and another[^\"x\"] and the first again[^zürich].\n\n[^\"x\"]: Second note <b>.\n[^zürich]: [Smith 2020, p. 42](https://example.org/book?page=42#p42).\n",
        );
        assert!(output.html.contains(
            "<p>A claim<sup class=\"footnote-reference\"><a href=\"https://example.test/blog/work/#zürich\">1</a></sup> and another<sup class=\"footnote-reference\"><a href=\"https://example.test/blog/work/#%22x%22\">2</a></sup> and the first again<sup class=\"footnote-reference\"><a href=\"https://example.test/blog/work/#zürich\">1</a></sup>.</p>\n"
        ), "{}", output.html);
        // Notes keep their numbers and ids even when defined out of order, and
        // raw HTML left open in a note is closed inside it.
        assert!(output.html.contains(
            "<div class=\"footnote-definition\" id=\"&quot;x&quot;\"><sup class=\"footnote-definition-label\">2</sup>\n<p>Second note <b>.</b></p>\n</div>\n<div class=\"footnote-definition\" id=\"zürich\"><sup class=\"footnote-definition-label\">1</sup>\n<p><a href=\"https://example.org/book?page=42#p42\">Smith 2020, p. 42</a>.</p>\n</div>\n"
        ), "{}", output.html);
        assert!(!output.html.contains("href=\"#"), "{}", output.html);
        // A label that is not a valid fragment is percent-encoded in the link
        // only, so URL-validating destinations keep it and the id still matches.
        let output = portable(
            "---
title: Study
date: 2026-10-01
---
## Odd {#a b}

A[^a b].

[^a b]: note
",
        );
        for expected in [
            "<a href=\"https://example.test/blog/work/#a%20b\">1</a>",
            "<div class=\"footnote-definition\" id=\"a b\">",
        ] {
            assert!(output.html.contains(expected), "{}", output.html);
        }
        assert!(!output.html.contains("#a b"), "{}", output.html);
    }

    fn credited_post(contents: &str, credits: &str) -> (SiteConfig, Site) {
        let config = SiteConfig::from_json(
            r#"{"title":"T","url":"https://example.test/blog","postPath":"/{slug}/","author":{"name":"Site Author"},
            "contributors":{
                "ada":{"name":"Ada <Lovelace> & Co.","url":"/people/ada/","orcid":"0000-0002-1825-0097"},
                "grace":{"name":"Grace Hopper","url":"https://grace.example/"},
                "emile":{"name":"Émile Zola"}
            }}"#,
        )
        .unwrap();
        let site = Site::load(
            config.clone(),
            Sources {
                posts: vec![SourceFile {
                    path: "posts/work.md".into(),
                    contents: contents.into(),
                }],
                credits: vec![SourceFile {
                    path: "posts/work.credits.json".into(),
                    contents: credits.into(),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        (config, site)
    }

    #[test]
    fn portable_credits_stay_ordered_attribution_rather_than_bibliography() {
        let (config, site) = credited_post(
            "---\ntitle: Study\ndate: 2026-10-01\nprofile: research\n---\n## References\n\n1. [Prior work](https://doi.org/10.1000/prior)\n",
            r#"{"version":1,"credits":[
                {"contributor":"grace","roles":[{"vocabulary":"crossref","role":"author"}]},
                {"contributor":"ada","roles":[{"vocabulary":"crossref","role":"author"},{"vocabulary":"credit","role":"writing-review-editing"}]},
                {"contributor":"emile","roles":[{"vocabulary":"crossref","role":"translator"}]}
            ]}"#,
        );
        let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
        let output = projection.portable_html().unwrap();
        assert!(output.html.starts_with(
            "<aside class=\"ob-contributions\" aria-labelledby=\"ob-contributions-title\">\n<h2 id=\"ob-contributions-title\" class=\"ob-contributions-title\">Contributions</h2>\n<ul>\n\
             <li><div><span class=\"ob-contributor-name\"><a href=\"https://grace.example/\">Grace Hopper</a></span><span class=\"ob-contributor-roles\">Author</span></div></li>\n\
             <li><div><span class=\"ob-contributor-name\"><a href=\"https://example.test/blog/people/ada/\">Ada &lt;Lovelace&gt; &amp; Co.</a></span><span class=\"ob-contributor-roles\">Author, Writing – review &amp; editing</span></div><p class=\"ob-orcid\"><a href=\"https://orcid.org/0000-0002-1825-0097\" aria-label=\"View unauthenticated ORCID record – 0000-0002-1825-0097\">https://orcid.org/0000-0002-1825-0097</a> (unauthenticated)</p></li>\n\
             <li><div><span class=\"ob-contributor-name\">Émile Zola</span><span class=\"ob-contributor-roles\">Translator</span></div></li>\n\
             </ul>\n</aside>\n<h2 id=\"references\">"
        ), "{}", output.html);
        // The bundled ORCID icon is a site asset and purely decorative.
        assert!(!output.html.contains("<img"), "{}", output.html);
        // Credits never become references, and references stay the authored list.
        let references = output.html.split("<h2 id=\"references\">").nth(1).unwrap();
        assert!(!references.contains("Grace") && !references.contains("orcid"));
        assert_eq!(
            projection
                .references()
                .iter()
                .map(|reference| reference.url.as_str())
                .collect::<Vec<_>>(),
            ["https://doi.org/10.1000/prior"]
        );
        assert_eq!(
            projection
                .authors()
                .map(|credit| credit.contributor_id.as_str())
                .collect::<Vec<_>>(),
            ["grace", "ada"]
        );
    }

    #[test]
    fn legacy_site_author_posts_add_no_portable_credit_list() {
        let output = portable("---\ntitle: Work\ndate: 2026-10-01\n---\nBody\n");
        assert_eq!(output.html, "<p>Body</p>\n");
    }

    #[test]
    fn portable_html_keeps_the_original_source_and_rejects_unsafe_provenance() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\nsourceUrl: https://origin.example/café/?id=1&x=<2>\n---\nBody\n",
        );
        assert_eq!(
            output.html,
            "<p>Body</p>\n<p class=\"ob-source\">Originally published at <a class=\"u-syndication\" href=\"https://origin.example/café/?id=1&amp;x=&lt;2&gt;\" rel=\"noopener\">origin.example/café/?id=1&amp;x=&lt;2&gt;</a>.</p>\n"
        );
        for unsafe_url in [
            "javascript:alert(1)",
            "https://user:secret@origin.example/",
            "/relative/copy",
        ] {
            let (config, site) = public_post(&format!(
                "---\ntitle: Work\ndate: 2026-10-01\nsourceUrl: \"{unsafe_url}\"\n---\nBody\n"
            ));
            let post = &site.posts[0];
            let native = post.html.clone();
            let error = PortableProjection::from_post(post, &config)
                .unwrap()
                .portable_html()
                .unwrap_err();
            assert!(
                error.contains("posts/work.md") && error.contains("sourceUrl"),
                "{error}"
            );
            assert!(!error.contains("secret"), "{error}");
            assert_eq!(post.html, native);
            assert_eq!(post.source_url.as_deref(), Some(unsafe_url));
        }
    }

    #[test]
    fn planned_and_unknown_structures_fail_closed_to_labeled_canonical_links() {
        let (config, site) = public_post(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n```timeline\n1914 – War begins (date uncertain: <July>)\n```\n",
        );
        let post = &site.posts[0];
        let native = post.html.clone();
        // What an owning story's detection would register before it ships a
        // portable fallback, plus a capability this build does not know.
        let registered = [
            CapabilityDescriptor::describe("historical-timelines", Some("ob-timeline")),
            CapabilityDescriptor::describe("future-structure", None),
            CapabilityDescriptor::describe("protected-reflection-drafts", None),
            CapabilityDescriptor::describe("historical-timelines", Some("ob-timeline")),
            CapabilityDescriptor::describe("Bad<id>", None),
        ];
        let mut projection = PortableProjection::from_post(post, &config).unwrap();
        projection.capabilities = &registered;
        let output = projection.portable_html().unwrap();
        assert_eq!(
            output.html,
            "<pre><code class=\"language-timeline\">1914 – War begins (date uncertain: &lt;July&gt;)\n</code></pre>\n\
             <p class=\"ob-portable-note\"><strong>Timeline</strong>: see it on <a href=\"https://example.test/blog/work/\">the original article</a>.</p>\n\
             <p class=\"ob-portable-note\"><strong>Interactive content</strong>: see it on <a href=\"https://example.test/blog/work/\">the original article</a>.</p>\n",
            "authored content stays visible; private drafts add nothing"
        );
        assert!(output.diagnostics.iter().all(|diagnostic| {
            diagnostic.source_path == "posts/work.md"
                && diagnostic.severity == DiagnosticSeverity::Warning
        }));
        assert!(output
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.capability_id.as_deref()
                != Some("protected-reflection-drafts")));
        assert!(output
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "canonical-only-interaction"));
        assert_eq!(
            output
                .capabilities
                .iter()
                .map(|capability| (capability.id.as_str(), capability.portability))
                .collect::<Vec<_>>(),
            [
                (
                    "historical-timelines",
                    crate::capability::PortabilityLevel::CanonicalOnlyInteraction
                ),
                (
                    "future-structure",
                    crate::capability::PortabilityLevel::CanonicalOnlyInteraction
                ),
                (
                    "invalid",
                    crate::capability::PortabilityLevel::CanonicalOnlyInteraction
                ),
            ],
            "each capability is reported once, so the loss stays visible to consumers; private state is never reported"
        );
        // The note is article-level for now: it follows the body, not the block.
        assert!(output.html.ends_with("the original article</a>.</p>\n"));
        assert!(!output
            .capabilities
            .iter()
            .any(|capability| capability.id.contains("reflection")));
        let markdown = projection.portable_markdown().unwrap();
        let text = projection.portable_text().unwrap();
        for artifact in [&markdown, &text] {
            assert!(artifact.contains("1914 – War begins"));
            assert!(artifact.contains("date uncertain"));
            assert!(artifact.contains("Timeline"));
            assert!(artifact.contains("Interactive content"));
            assert!(artifact.contains("https://example.test/blog/work/"));
            assert!(!artifact.contains("protected-reflection"));
            assert!(!artifact.contains("Bad<id>"));
        }
        assert_eq!(markdown.matches("> **Timeline:**").count(), 1);
        assert_eq!(post.html, native);
        assert_eq!(projection.portable_html().unwrap(), output);
    }

    #[test]
    fn every_planned_contract_preserves_public_prose_or_excludes_private_state() {
        let registry: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/portability/planned-capability-contracts.json"
        ))
        .unwrap();
        let (config, site) = public_post(
            "---\ntitle: Future contract\ndate: 2020-01-01\n---\n## Public context\n\n1. Translator: José; rights: approved quotation only.\n2. Uncertain date: c. 1350; commentary is not evidence.\n\n[Evidence](https://evidence.example/source#passage)\n",
        );
        let post = &site.posts[0];
        let native = post.html.clone();
        for contract in registry["contracts"].as_array().unwrap() {
            let id = contract["id"].as_str().unwrap();
            // An implemented capability (B2, ADR 0141) has its own portable
            // fallback instead of a canonical-only label: it must still keep
            // the public prose, but owes no label or canonical-only notice.
            let implemented = contract["implementation_status"].as_str() == Some("implemented");
            let registered = [CapabilityDescriptor::describe(id, None)];
            let mut projection = PortableProjection::from_post(post, &config).unwrap();
            projection.capabilities = &registered;
            let html = projection.portable_html().unwrap();
            let markdown = projection.portable_markdown().unwrap();
            let text = projection.portable_text().unwrap();
            for artifact in [&html.html, &markdown, &text] {
                for fact in [
                    "José",
                    "approved quotation only",
                    "c. 1350",
                    "commentary is not evidence",
                    "https://evidence.example/source#passage",
                ] {
                    assert!(artifact.contains(fact), "{id}: lost {fact}");
                }
                if implemented {
                    assert!(
                        registered[0].has_portable_fallback(),
                        "{id}: an implemented capability needs its own fallback"
                    );
                } else if let Some(label) = registered[0].portable_label() {
                    assert!(
                        artifact.contains(label),
                        "{id}: missing canonical-only label"
                    );
                    assert!(artifact.contains("https://example.test/blog/work/"));
                } else {
                    assert!(
                        !artifact.contains(id),
                        "{id}: private capability disclosure"
                    );
                }
            }
            if implemented {
                assert!(html
                    .diagnostics
                    .iter()
                    .all(|diagnostic| diagnostic.code != "canonical-only-interaction"));
            } else if registered[0].portable_label().is_none() {
                assert!(html.capabilities.is_empty());
                assert!(html.diagnostics.is_empty());
            } else {
                assert!(html
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == "canonical-only-interaction"));
            }
        }
        assert_eq!(post.html, native);
    }

    #[test]
    fn draft_posts_cannot_enter_public_projections() {
        let config = SiteConfig::default();
        let site = Site::load(
            config.clone(),
            Sources {
                posts: vec![SourceFile {
                    path: "posts/draft.md".into(),
                    contents: "---\ntitle: Draft\ndraft: true\n---\nPrivate".into(),
                }],
                ..Default::default()
            },
            LoadOptions {
                include_drafts: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(PortableProjection::from_post(&site.posts[0], &config)
            .unwrap_err()
            .contains("drafts cannot"));
    }

    /// The projection's error for a post, checking that the canonical source and
    /// the native page are untouched.
    fn portable_error(contents: &str) -> String {
        let (config, site) = public_post(contents);
        let post = &site.posts[0];
        let (native, markdown) = (post.html.clone(), post.authored_markdown.clone());
        let error = PortableProjection::from_post(post, &config)
            .unwrap()
            .portable_html()
            .unwrap_err();
        assert_eq!(post.html, native);
        assert_eq!(post.authored_markdown, markdown);
        error
    }

    fn raw_html_losses(output: &PortableHtmlOutput) -> Vec<&str> {
        output
            .capabilities
            .iter()
            .filter(|capability| capability.id == "raw-html")
            .flat_map(|capability| capability.diagnostics.iter())
            .map(|diagnostic| diagnostic.message.as_str())
            .collect()
    }

    #[test]
    fn portable_raw_html_keeps_allowlisted_markup_and_removes_active_content() {
        let (config, site) = public_post(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n<div class=\"note\" onclick=\"alert(1)\" style=\"position:fixed\" data-track=\"x\">\n<p title=\"Ünter &amp; &quot;co&quot;\">Kept <b>bold</b>, <abbr title=\"HyperText\">HTML</abbr> &amp; <q cite=\"/sources/\">quotes</q>.</p>\n<script>alert(\"</div>\")</script>\n<style>body { display: none }</style>\n</div>\n",
        );
        let post = &site.posts[0];
        let output = PortableProjection::from_post(post, &config)
            .unwrap()
            .portable_html()
            .unwrap();
        assert_eq!(
            output.html,
            "<div class=\"note\">\n<p title=\"Ünter &amp; &quot;co&quot;\">Kept <b>bold</b>, <abbr title=\"HyperText\">HTML</abbr> &amp; <q cite=\"https://example.test/blog/sources/\">quotes</q>.</p>\n\n\n</div>"
        );
        assert_eq!(
            raw_html_losses(&output),
            [
                "Removed with their content: <script>, <style>.",
                "Removed attributes: event handlers, style, data-*."
            ]
        );
        let report = output
            .capabilities
            .iter()
            .find(|capability| capability.id == "raw-html")
            .unwrap();
        assert_eq!(
            report.portability,
            crate::capability::PortabilityLevel::GracefullyTransformed
        );
        assert_eq!(
            report.diagnostics[0].code,
            crate::capability::CapabilityDiagnosticCode::RemovedMarkup
        );
        // The native page keeps the authored markup, as it always has.
        assert!(post.html.contains("<script>alert(\"</div>\")</script>"));
        assert!(post.html.contains("onclick=\"alert(1)\""));
    }

    #[test]
    fn portable_raw_html_urls_resolve_against_the_canonical_article() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n## Notes\n\n<p><a href=\"../reference/\">Parent</a> <a href=\"#notes\">Up</a> <a href=\"https://source.example/café?x=1&amp;y=2#part\">External</a> <img src=\"diagram.png\" alt=\"Diagram of the gate\"> <a href=\"mailto:editor@example.test\">Mail</a> <a href=\"#zürich\">Zürich</a></p>\n",
        );
        assert!(output.html.contains(
            "<p><a href=\"https://example.test/blog/reference/\">Parent</a> <a href=\"https://example.test/blog/work/#notes\">Up</a> <a href=\"https://source.example/café?x=1&amp;y=2#part\">External</a> <img loading=\"lazy\" decoding=\"async\" src=\"https://example.test/blog/work/diagram.png\" alt=\"Diagram of the gate\"> <a href=\"mailto:editor@example.test\">Mail</a> <a href=\"https://example.test/blog/work/#z%C3%BCrich\">Zürich</a></p>"
        ), "{}", output.html);
        assert!(output.capabilities.is_empty(), "{:?}", output.capabilities);
    }

    #[test]
    fn portable_raw_html_with_an_unsafe_url_fails_for_the_source() {
        for (markup, attribute) in [
            ("<a href=\"javascript:alert(1)\">x</a>", "<a href>"),
            ("<a href=\"JaVaScRiPt&#58;alert(1)\">x</a>", "<a href>"),
            ("<a href=\"&#x6A;avascript:alert(1)\">x</a>", "<a href>"),
            ("<a href=\"java&Tab;script:alert(1)\">x</a>", "<a href>"),
            ("<a href=\"  vbscript:msgbox(1)\">x</a>", "<a href>"),
            ("<a href=\"\">empty</a>", "<a href>"),
            (
                "<img src=\"data:image/svg+xml;base64,PHN2Zz4=\" alt=\"x\">",
                "<img src>",
            ),
            (
                "<p><a href=data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;>x</a></p>",
                "<a href>",
            ),
            (
                "<blockquote cite=\"https://user:secret@example.test/\">q</blockquote>",
                "<blockquote cite>",
            ),
        ] {
            let error = portable_error(&format!(
                "---\ntitle: Work\ndate: 2026-10-01\n---\n{markup}\n"
            ));
            assert!(
                error.contains("posts/work.md")
                    && error.contains("raw HTML")
                    && error.contains(attribute),
                "{markup}: {error}"
            );
            assert!(!error.contains("secret"), "{error}");
        }
    }

    #[test]
    fn portable_raw_html_replaces_frames_and_media_and_unwraps_forms() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n<base href=\"https://evil.example/\">\n<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example/\">\n<link rel=\"stylesheet\" href=\"https://evil.example/x.css\">\n<form action=\"https://evil.example/collect\"><label>Password <input type=\"password\" name=\"password\"></label><button>Send</button><select><option>One</option></select><textarea>Notes</textarea></form>\n<iframe src=\"https://www.youtube-nocookie.com/embed/x\" title=\"Gate trailer\"><p>fallback</p></iframe>\n<video controls src=\"/clip.mp4\"><track src=\"/c.vtt\">Your browser cannot play this.</video>\n<svg viewBox=\"0 0 10 10\" aria-label=\"Bridge plan\"><script>alert(1)</script><a href=\"javascript:alert(1)\"><text>x</text></a></svg>\n<math><mi>x</mi></math>\n<object data=\"/x.swf\"></object><embed src=\"/y.swf\">\n",
        );
        let note = |label: &str| {
            format!("<span class=\"ob-portable-note\"><strong>{label}: see it on <a href=\"https://example.test/blog/work/\">the original article</a>.</span>")
        };
        assert_eq!(
            output.html,
            format!(
                "\n\n\nPassword \n{}\n{}\n{}\n{}\n{}{}",
                note("Embedded frame</strong> (Gate trailer)"),
                note("Video</strong>"),
                note("Illustration</strong> (Bridge plan)"),
                note("Math</strong>"),
                note("Embedded object</strong>"),
                note("Embedded object</strong>"),
            )
        );
        for hostile in ["evil.example", "<form", "<input", "<iframe", "javascript:"] {
            assert!(!output.html.contains(hostile), "{hostile}: {}", output.html);
        }
        assert_eq!(
            raw_html_losses(&output),
            [
                "Removed with their content: <button>, <select>, <textarea>.",
                "Removed: <base>, <meta>, <link>, <input>.",
                "Kept the content but removed the tags: <form>, <label>.",
                "Replaced with a link to the original article: <iframe>, <video>, <svg>, <math>, <object>, <embed>."
            ]
        );
    }

    #[test]
    fn portable_raw_html_drops_comments_and_other_non_content_markup() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\nPublic <!-- private: Reviewer 2 dislikes this --> text.\n\n<!--\nTODO(private): call the source before publishing\n-->\n\n<!DOCTYPE html><?php echo 'x'; ?><![CDATA[ hidden ]]>\n\n<p>Kept</p><!-- unterminated private note\n",
        );
        assert_eq!(output.html, "<p>Public  text.</p>\n\n\n<p>Kept</p>");
        for private in ["private", "Reviewer", "TODO", "php", "hidden", "CDATA"] {
            assert!(!output.html.contains(private), "{private}: {}", output.html);
        }
        assert!(
            output.capabilities.is_empty(),
            "comments are never reader content, so nothing about them is reported: {:?}",
            output.capabilities
        );
    }

    #[test]
    fn portable_raw_html_escapes_malformed_markup_and_keeps_elements_balanced() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\nIf a < b and <b>bold never closes\n\nNext <i>paragraph</p> and </div> stray.\n\n<div><a href=\"x>broken\n\n<details><summary>More</summary>\n\nHidden *Markdown*.\n\n</details>\n\n<section><div>unclosed\n",
        );
        assert_eq!(
            output.html,
            "<p>If a &lt; b and <b>bold never closes</b></p>\n<p>Next <i>paragraph and  stray.</i></p>\n<div>&lt;a href=\"x&gt;broken\n<details><summary>More</summary>\n<p>Hidden <em>Markdown</em>.</p>\n</details>\n<section><div>unclosed</div></section></div>"
        );
    }

    #[test]
    fn portable_raw_html_ids_stay_unique_and_anchors_keep_their_targets() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n<span id=\"overview\">Early</span> <span id=\"box\">One</span> <span id=\"box\">Two</span> <a name=\"legacy\"></a><span id=\"ob-contributions-title\">Mine</span> <span id=\"a b\">Spaced</span> <span id=\"note\">Clash</span> <span id=\"zürich\">Ü</span> [jump](#legacy) <a href=\"#box\">box</a>[^note]\n\n## Overview\n\n[^note]: A note.\n",
        );
        assert!(output.html.starts_with(
            "<p><span>Early</span> <span id=\"box\">One</span> <span>Two</span> <a id=\"legacy\"></a><span>Mine</span> <span>Spaced</span> <span>Clash</span> <span id=\"zürich\">Ü</span> <a href=\"https://example.test/blog/work/#legacy\">jump</a> <a href=\"https://example.test/blog/work/#box\">box</a><sup class=\"footnote-reference\">"
        ), "{}", output.html);
        assert!(
            output.html.contains("<h2 id=\"overview\">"),
            "{}",
            output.html
        );
        assert!(output
            .html
            .contains("<div class=\"footnote-definition\" id=\"note\">"));
        assert_eq!(
            raw_html_losses(&output),
            ["Removed 5 duplicate, reserved, or invalid ids."]
        );
    }

    #[test]
    fn portable_heading_attributes_cannot_carry_event_handlers() {
        let (config, site) = public_post(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n## Title {#start .lead onclick=alert(1) data-x=1 style=color:red}\n",
        );
        let post = &site.posts[0];
        assert!(post.html.contains("onclick=\"alert(1)\""), "{}", post.html);
        let output = PortableProjection::from_post(post, &config)
            .unwrap()
            .portable_html()
            .unwrap();
        assert!(
            output
                .html
                .starts_with("<h2 id=\"start\" class=\"lead\">Title"),
            "{}",
            output.html
        );
        assert_eq!(
            raw_html_losses(&output),
            ["Removed attributes: event handlers, data-*, style."]
        );
    }

    #[test]
    fn portable_raw_html_drops_inline_script_content_until_its_paragraph_ends() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\nBefore <script>steal(document.cookie)</script> after <style>p { color: red }</style> end.\n\nUse <script> without closing it\n\nNext paragraph.\n",
        );
        assert_eq!(
            output.html,
            "<p>Before  after  end.</p>\n<p>Use </p>\n<p>Next paragraph.</p>\n"
        );
        assert_eq!(
            raw_html_losses(&output),
            ["Removed with their content: <script>, <style>."]
        );
        // End tags match in any case, and many scripts in one block stay linear.
        let output = portable(&format!(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n<div><SCRIPT>x('</div>')</ScRiPt >kept{}</div>\n",
            "<script>y()</script>".repeat(20_000)
        ));
        assert_eq!(output.html, "<div>kept</div>");
    }

    #[test]
    fn portable_raw_html_inside_nested_components_keeps_its_place() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n- Step one\n\n  > [!NOTE]\n  > <kbd>Ctrl</kbd> + <kbd>C</kbd> <span onclick=\"x()\">copies</span>.\n  >\n  > ```quiz\n  > Pick one?\n  > - [x] Yes\n  > - [ ] No\n  > ```\n",
        );
        assert!(
            output
                .html
                .contains("<p><kbd>Ctrl</kbd> + <kbd>C</kbd> <span>copies</span>.</p>"),
            "{}",
            output.html
        );
        assert!(output.html.contains("<p class=\"ob-quiz-prompt\">"));
        assert!(!output.html.contains("onclick"));
        let callout = output.html.find("<aside class=\"ob-callout").unwrap();
        let item = output.html.find("<li>").unwrap();
        assert!(
            item < callout && output.html.ends_with("</aside>\n</li>\n</ul>\n"),
            "{}",
            output.html
        );
    }

    #[test]
    fn portable_html_nesting_beyond_the_bound_fails_with_a_diagnostic() {
        let within = format!(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n{}deep{}\n",
            "<div>".repeat(MAX_PORTABLE_NESTING_DEPTH),
            "</div>".repeat(MAX_PORTABLE_NESTING_DEPTH)
        );
        assert!(portable(&within).html.contains("deep"));
        for body in [
            "<div>".repeat(MAX_PORTABLE_NESTING_DEPTH + 1),
            format!("{} deep", ">".repeat(MAX_PORTABLE_NESTING_DEPTH + 1)),
        ] {
            let error = portable_error(&format!(
                "---\ntitle: Work\ndate: 2026-10-01\n---\n{body}\n"
            ));
            assert!(
                error.contains("posts/work.md") && error.contains("nest"),
                "{error}"
            );
        }
    }

    #[test]
    fn oversized_portable_html_fails_instead_of_truncating() {
        let paragraph = "A paragraph of substantive text that must never be cut short.\n\n";
        let error = portable_error(&format!(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n{}",
            paragraph.repeat(MAX_PORTABLE_HTML_BYTES / paragraph.len() + 1)
        ));
        assert!(
            error.contains("posts/work.md")
                && error.contains(&MAX_PORTABLE_HTML_BYTES.to_string())
                && error.contains("nothing was truncated"),
            "{error}"
        );
        // Each paragraph renders as its text plus `<p></p>\n`; just under the
        // bound, everything is kept through the last paragraph.
        let output = portable(&format!(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n{}Last words.\n",
            paragraph.repeat(MAX_PORTABLE_HTML_BYTES / (paragraph.len() + 8) - 1)
        ));
        assert!(output.html.len() <= MAX_PORTABLE_HTML_BYTES);
        assert!(output.html.ends_with("<p>Last words.</p>\n"));
    }

    #[test]
    fn portable_raw_html_with_unterminated_tags_stays_linear() {
        let front = "---\ntitle: Work\ndate: 2026-10-01\n---\n";
        let started = std::time::Instant::now();
        for body in [
            format!("<div>\n{}\n", "<a ".repeat(100_000)),
            format!("<div>\n{}\n", "<a href=\"".repeat(40_000)),
            format!("<div>\n<span {}>x</span>\n", {
                (0..40_000).map(|n| format!("x{n} ")).collect::<String>()
            }),
        ] {
            let output = portable(&format!("{front}{body}"));
            assert!(output.html.starts_with("<div>"), "{}", &output.html[..80]);
        }
        // Quadratic scanning took minutes here; linear work takes well under this.
        assert!(
            started.elapsed() < std::time::Duration::from_secs(20),
            "{:?}",
            started.elapsed()
        );
        // An unterminated tag and everything after it in the block is escaped text.
        let output = portable(&format!(
            "{front}<div>\n<a title=\"never closed <b>bold</b>\n"
        ));
        assert_eq!(
            output.html,
            "<div>\n&lt;a title=\"never closed &lt;b&gt;bold&lt;/b&gt;</div>"
        );
    }

    #[test]
    fn portable_raw_html_drops_markdown_written_inside_removed_elements() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\nBefore <script>alert(*secret*)</script> after\n\nHi <style>p{x:1} **leak** </style> end\n\nText <script>if (a) { *private* [x](/y) }</script> end.\n\nOpen <script>*a </script> **b** c* d\n",
        );
        assert_eq!(
            output.html,
            "<p>Before  after</p>\n<p>Hi  end</p>\n<p>Text  end.</p>\n<p>Open  <strong>b</strong> c d</p>\n"
        );
        for leaked in ["secret", "leak", "private", "/y"] {
            assert!(!output.html.contains(leaked), "{leaked}: {}", output.html);
        }
    }

    #[test]
    fn portable_raw_html_removed_elements_keep_skipping_until_their_end_tag() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n<div class=\"embed\">\n<script>\n\n  window.SECRET_KEY = \"sk_live_123\";\n</script>\n</div>\n\n<div>\n<style>\n\n.hidden-note{display:none}\n</style>\n</div>\n\n<div><template>\n\n<p>Hidden *template*</p>\n\n</template></div>\n\nAfter.\n",
        );
        for leaked in ["SECRET", "sk_live", "hidden-note", "Hidden", "template"] {
            assert!(!output.html.contains(leaked), "{leaked}: {}", output.html);
        }
        assert!(output.html.starts_with("<div class=\"embed\">"));
        // The last div's end tag sits in a removed paragraph, so it closes at
        // the end of the body.
        assert!(
            output.html.ends_with("<div>\n<p>After.</p>\n</div>"),
            "{}",
            output.html
        );
        assert_eq!(
            raw_html_losses(&output),
            ["Removed with their content: <script>, <style>, <template>."]
        );
    }

    #[test]
    fn portable_raw_html_never_closed_across_blocks_fails_for_the_source() {
        for (body, element) in [
            (
                "<iframe src=\"https://www.youtube.com/embed/x\" />\n\nPara with <a href=\"/later/\">a later link</a>.\n\n<figure><img src=\"a.png\" alt=\"A\"><figcaption>Cap</figcaption></figure>\n",
                "<iframe>",
            ),
            (
                "<div><button>\n\nLater <kbd>Ctrl</kbd> and <a href=\"/x\">link</a>.\n\n<p>Block para</p>\n",
                "<button>",
            ),
            ("<button>\n\n<div>next block content</div>\n\nPara\n", "<button>"),
            ("- <div><script>\n\n  secret()\n- next\n", "<script>"),
        ] {
            let error = portable_error(&format!(
                "---\ntitle: Work\ndate: 2026-10-01\n---\n{body}"
            ));
            assert!(
                error.contains("posts/work.md")
                    && error.contains(element)
                    && error.contains("never closed"),
                "{body}: {error}"
            );
        }
        // An unclosed element that hides nothing after its block is only reported.
        let output =
            portable("---\ntitle: Work\ndate: 2026-10-01\n---\nKept.\n\n<div><script>\nsteal()\n");
        assert_eq!(output.html, "<p>Kept.</p>\n<div></div>");
    }

    #[test]
    fn portable_paragraphs_left_empty_by_removal_are_dropped() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\nKept.\n\n<noscript><img src=\"https://tracker.example/p.gif\" alt=\"t\"></noscript>\n\n<noscript>a</noscript> <button>b</button>\n\nEnd.\n",
        );
        assert_eq!(output.html, "<p>Kept.</p>\n<p>End.</p>\n");
    }

    #[test]
    fn portable_raw_images_without_alternative_text_are_marked_decorative() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n<p><img src=\"x.png\"> <img src=\"y.png\" alt=\"Y\"> <img src=\"z.png\" alt></p>\n",
        );
        assert_eq!(
            output.html,
            "<p><img loading=\"lazy\" decoding=\"async\" src=\"https://example.test/blog/work/x.png\" alt=\"\"> <img loading=\"lazy\" decoding=\"async\" src=\"https://example.test/blog/work/y.png\" alt=\"Y\"> <img loading=\"lazy\" decoding=\"async\" src=\"https://example.test/blog/work/z.png\" alt=\"\"></p>"
        );
        assert_eq!(
            raw_html_losses(&output),
            ["Marked 1 image without alternative text as decorative (alt=\"\")."]
        );
    }

    #[test]
    fn portable_heading_ids_stay_unique_and_avoid_the_reserved_prefix() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n## A {#x}\n\n## B {#x}\n\n## Foo {#bar}\n\n## Bar\n\n## C {#ob-contributions-title}\n\n## Ob Note\n\n<span id=\"x-2\">raw</span> [first](#x)\n",
        );
        let ids: Vec<&str> = output
            .html
            .match_indices("<h2 id=\"")
            .map(|(at, _)| {
                let rest = &output.html[at + 8..];
                &rest[..rest.find('"').unwrap()]
            })
            .collect();
        assert_eq!(
            ids,
            ["x", "x-2", "bar", "bar-2", "contributions-title", "note"]
        );
        assert!(output.html.contains("<span>raw</span>"), "{}", output.html);
        assert!(output
            .html
            .contains("<a href=\"https://example.test/blog/work/#x\">first</a>"));
        assert_eq!(
            raw_html_losses(&output),
            [
                "Removed 1 duplicate, reserved, or invalid id.",
                "Renamed 4 duplicate or reserved heading ids."
            ]
        );
    }

    #[test]
    fn native_heading_slugs_keep_their_existing_targets() {
        // A slug that a later `{#id}` repeats keeps its id on the native page,
        // so published `#bar` links still reach the first heading.
        let source = "---\ntitle: Work\ndate: 2026-10-01\n---\n## Bar\n\n## Foo {#bar}\n\n## Foo\n";
        let (_, site) = public_post(source);
        let html = &site.posts[0].html;
        assert_eq!(html.matches("<h2 id=\"bar\"").count(), 2, "{html}");
        assert!(html.contains("<h2 id=\"foo-2\""), "{html}");
        assert!(!html.contains("bar-2"), "{html}");
        // The portable copy keeps the first target and renames the repeat.
        let output = portable(source);
        assert!(
            output.html.contains("<h2 id=\"bar\">Bar"),
            "{}",
            output.html
        );
        assert!(
            output.html.contains("<h2 id=\"bar-2\">Foo"),
            "{}",
            output.html
        );
    }

    #[test]
    fn portable_heading_ids_never_repeat_a_footnote_id() {
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n## Note\n\nText[^note] and more[^ob-comments].\n\n[^note]: A note.\n\n[^ob-comments]: Reserved.\n",
        );
        assert!(
            output.html.contains("<h2 id=\"note-2\">"),
            "{}",
            output.html
        );
        assert_eq!(
            output.html.matches("id=\"note\"").count(),
            1,
            "{}",
            output.html
        );
        assert!(
            output
                .html
                .contains("class=\"footnote-definition\" id=\"note\""),
            "{}",
            output.html
        );
        // A reserved footnote name loses its id in the copy; its citation
        // still points at the note on the canonical article.
        assert!(
            !output.html.contains("id=\"ob-comments\""),
            "{}",
            output.html
        );
        assert!(
            output.html.contains("/blog/work/#ob-comments"),
            "{}",
            output.html
        );
        assert_eq!(
            raw_html_losses(&output),
            [
                "Removed 1 duplicate, reserved, or invalid id.",
                "Renamed 1 duplicate or reserved heading id."
            ]
        );
    }

    #[test]
    fn comments_split_by_a_blank_line_never_reach_the_portable_copy() {
        // The blank line ends the `<div>` HTML block, so the rest of the
        // comment arrives as a Markdown paragraph.
        let output = portable(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n<div class=\"box\">\n<!-- TODO(private): Dana said\n\nthe source asked not to be named\n\n- *still* hidden\n\n<p>end of note --></p>\n</div>\n\nAfter <!-- inline --> text.\n",
        );
        assert!(!output.html.contains("Dana"), "{}", output.html);
        assert!(!output.html.contains("source asked"), "{}", output.html);
        assert!(!output.html.contains("hidden"), "{}", output.html);
        assert!(!output.html.contains("end of note"), "{}", output.html);
        assert!(!output.html.contains("&gt;"), "{}", output.html);
        assert!(
            output.html.contains("<div class=\"box\">"),
            "{}",
            output.html
        );
        assert!(output.html.contains("After  text."), "{}", output.html);
        // A comment that would hide later content and is never closed fails.
        let error = portable_error(
            "---\ntitle: Work\ndate: 2026-10-01\n---\n<div>\n<!-- private\n\nstill private -->\n</div>\n\nPublic text.\n",
        );
        assert!(error.contains("comment"), "{error}");
        assert!(!error.contains("private"), "{error}");
    }

    #[test]
    fn a_stray_br_end_tag_still_breaks_the_line() {
        let output = portable("---\ntitle: Work\ndate: 2026-10-01\n---\n<p>a<br/>b</br>c</p>\n");
        assert!(
            output.html.contains("<p>a<br>b<br>c</p>"),
            "{}",
            output.html
        );
    }

    #[test]
    fn recipe_sections_stay_well_nested_around_unclosed_raw_elements() {
        let output = portable(
            "---\ntitle: Tea\ndate: 2026-10-01\nprofile: recipe\n---\n## Steps\n\n<div class=\"tip\">\n\n1. Boil water.\n\n## Notes\n\nEnjoy.\n",
        );
        let html = &output.html;
        let section_end = html.find("</section>").expect(html);
        let div_end = html.find("</div>").expect(html);
        assert!(div_end < section_end, "{html}");
        assert_eq!(
            html.matches("<div").count(),
            html.matches("</div>").count(),
            "{html}"
        );
        assert!(html.trim_end().ends_with("<p>Enjoy.</p>"), "{html}");
    }
}
