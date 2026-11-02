//! Research-profile work metadata and portable evidence primitives.
//!
//! Parsing is deliberately offline: identifier structure can be checked during
//! a build, but resolution, ownership, and scholarly status cannot.

use crate::frontmatter::FrontMatter;
use http::Uri;
use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use serde::Serialize;
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceOutcome {
    Detected,
    Potential,
    NeedsReview,
}

impl fmt::Display for EvidenceOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Detected => "detected",
            Self::Potential => "potential",
            Self::NeedsReview => "needs-review",
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceCode {
    DoiInvalid,
    LicenseUrlInvalid,
    AbstractMissing,
    ReferencesMissing,
    FootnoteUnresolved,
    ReferenceLinkReview,
    DoiLinkNonPreferred,
    /// A citation the scanner cannot read (ADR 0050).
    CitationSyntax,
    /// A citation key with no source, or a locator that does not fit it.
    CitationUnresolved,
    /// A public identifier in a form readers cannot follow, left out.
    CitationIdentifierUnpublished,
    /// A cited reference without a detail its kind usually has.
    CitationReferenceIncomplete,
    /// Located citations a person must check against the source.
    CitationLocationReview,
    /// A claim names a post slug no saved post has (ADR 0074).
    ClaimPostMissing,
    /// A claim's words occur once, away from the recorded offsets.
    ClaimAnchorMoved,
    /// A claim's words no longer occur in the saved draft.
    ClaimAnchorStale,
    /// A claim's words occur several times and the offsets no longer match.
    ClaimAnchorAmbiguous,
    /// A suggested claim or link nobody has made their own yet.
    ClaimSuggestionUnreviewed,
    /// A claim with no evidence link at all.
    ClaimEvidenceMissing,
    /// A claim marked uncertain whose links all support it.
    ClaimSupportOnly,
    /// Contradicting links on a claim with no note on how the draft meets them.
    ClaimContradictionUndiscussed,
    /// A link resting on a source archived in the library.
    ClaimSourceArchived,
    /// A link pointing at a notebook passage that is archived.
    ClaimPassageArchived,
    /// A link that gives no location in its source.
    ClaimLocatorMissing,
    /// A located link nobody has recorded checking against the source.
    ClaimLocationUnreviewed,
    /// A link that does not say why the author reads the source this way.
    ClaimRationaleMissing,
}

impl fmt::Display for EvidenceCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::DoiInvalid => "doi-invalid",
            Self::LicenseUrlInvalid => "license-url-invalid",
            Self::AbstractMissing => "abstract-missing",
            Self::ReferencesMissing => "references-missing",
            Self::FootnoteUnresolved => "footnote-unresolved",
            Self::ReferenceLinkReview => "reference-link-review",
            Self::DoiLinkNonPreferred => "doi-link-non-preferred",
            Self::CitationSyntax => "citation-syntax",
            Self::CitationUnresolved => "citation-unresolved",
            Self::CitationIdentifierUnpublished => "citation-identifier-unpublished",
            Self::CitationReferenceIncomplete => "citation-reference-incomplete",
            Self::CitationLocationReview => "citation-location-review",
            Self::ClaimPostMissing => "claim-post-missing",
            Self::ClaimAnchorMoved => "claim-anchor-moved",
            Self::ClaimAnchorStale => "claim-anchor-stale",
            Self::ClaimAnchorAmbiguous => "claim-anchor-ambiguous",
            Self::ClaimSuggestionUnreviewed => "claim-suggestion-unreviewed",
            Self::ClaimEvidenceMissing => "claim-evidence-missing",
            Self::ClaimSupportOnly => "claim-support-only",
            Self::ClaimContradictionUndiscussed => "claim-contradiction-undiscussed",
            Self::ClaimSourceArchived => "claim-source-archived",
            Self::ClaimPassageArchived => "claim-passage-archived",
            Self::ClaimLocatorMissing => "claim-locator-missing",
            Self::ClaimLocationUnreviewed => "claim-location-unreviewed",
            Self::ClaimRationaleMissing => "claim-rationale-missing",
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceSource {
    pub path: String,
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub field: Option<String>,
}

impl EvidenceSource {
    pub fn line(&self) -> Option<usize> {
        self.line
    }

    pub fn field(&self) -> Option<&str> {
        self.field.as_deref()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceFinding {
    pub code: EvidenceCode,
    pub outcome: EvidenceOutcome,
    pub source: EvidenceSource,
    pub message: String,
    pub repair: String,
    /// The claims-file record a finding is about, so Evidence Studio can show
    /// it beside that claim. Absent for findings about a post's own text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<EvidenceObject>,
    /// The position-free facts the finding states: the keys, locators,
    /// identifiers and stated values it is about, never a line, byte offset
    /// or sentence. They identify what the finding says for an author's
    /// acknowledgement (ADR 0147) and are never serialized, so the finding's
    /// JSON is unchanged.
    #[serde(skip)]
    pub facts: Vec<String>,
}

impl EvidenceFinding {
    /// The finding with its position-free facts, in the validator's order.
    pub fn with_facts<I, S>(mut self, facts: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.facts = facts.into_iter().map(Into::into).collect();
        self
    }
}

/// The claim, and optionally the evidence link on it, a finding is about.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EvidenceObject {
    pub claim: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResearchReference {
    pub label: String,
    pub url: String,
    /// One-based line in the canonical source document.
    pub line: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResearchMetadata {
    /// Authored DOI name without a resolver prefix. Invalid authored values are
    /// retained here so an editor can round-trip and repair them.
    pub doi: Option<String>,
    /// Preferred resolver URL when the authored DOI has valid broad structure.
    pub doi_url: Option<String>,
    /// Authored absolute license URL. Validation findings are kept separate.
    pub license: Option<String>,
    /// Authored license URL when it is safe to emit as an absolute link.
    pub license_url: Option<String>,
    /// Resolvable links authored inside the bounded References/Bibliography section.
    pub references: Vec<ResearchReference>,
}

impl ResearchMetadata {
    pub fn from_source(front_matter: &FrontMatter, markdown: &str, body_line: usize) -> Self {
        let authored_doi = non_empty(front_matter.get("doi"));
        let doi = authored_doi.as_deref().map(doi_name);
        let doi_url = doi.as_deref().and_then(normalize_doi_url);
        let license = non_empty(front_matter.get("license"));
        let license_url = license
            .as_deref()
            .filter(|value| absolute_http_url(value))
            .map(str::to_string);
        Self {
            doi,
            doi_url,
            license,
            license_url,
            references: extract_references(markdown, body_line),
        }
    }

    /// The work's DOI and license as the escaped "Research work details" list
    /// both the native page and the portable projection show; empty when the
    /// work has neither a resolvable DOI nor a safe license URL.
    pub(crate) fn work_meta_html(&self) -> String {
        use crate::escape::{attr, text};
        if self.doi_url.is_none() && self.license_url.is_none() {
            return String::new();
        }
        let mut html =
            String::from("<aside class=\"ob-work-meta\" aria-label=\"Research work details\"><dl>");
        if let (Some(name), Some(url)) = (&self.doi, &self.doi_url) {
            html.push_str(&format!(
                "<div><dt>DOI</dt><dd><a href=\"{}\">{}</a></dd></div>",
                attr(url),
                text(name)
            ));
        }
        if let Some(url) = &self.license_url {
            html.push_str(&format!(
                "<div><dt>Reuse</dt><dd><a href=\"{}\">License</a></dd></div>",
                attr(url)
            ));
        }
        html.push_str("</dl></aside>\n");
        html
    }
}

fn extract_references(markdown: &str, body_line: usize) -> Vec<ResearchReference> {
    struct Link {
        label: String,
        url: String,
        line: usize,
    }

    let mut references = Vec::new();
    let mut reference_level = None;
    let mut in_references = false;
    let mut heading: Option<(u8, String)> = None;
    let mut link: Option<Link> = None;
    let mut container_depth = 0usize;
    let parser = Parser::new_ext(markdown, crate::markdown::parser_options(false));
    for (event, range) in parser.into_offset_iter() {
        let closes_container = closes_container(&event);
        if opens_container(&event) {
            container_depth += 1;
        }
        match event {
            Event::Start(Tag::Heading { level, .. }) if container_depth == 0 => {
                let level = heading_number(level);
                if reference_level.is_some_and(|reference_level| level <= reference_level) {
                    in_references = false;
                    reference_level = None;
                }
                heading = Some((level, String::new()));
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((level, text)) = heading.take() {
                    let name = text.trim();
                    if name.eq_ignore_ascii_case("references")
                        || name.eq_ignore_ascii_case("bibliography")
                    {
                        in_references = true;
                        reference_level = Some(level);
                    }
                }
            }
            Event::Start(Tag::Link { dest_url, .. }) if in_references => {
                let url = dest_url.into_string();
                if absolute_http_url(&url) {
                    link = Some(Link {
                        label: String::new(),
                        url,
                        line: source_line(markdown, range.start, body_line),
                    });
                }
            }
            Event::End(TagEnd::Link) => {
                if let Some(link) = link.take() {
                    references.push(ResearchReference {
                        label: link.label.trim().to_string(),
                        url: link.url,
                        line: link.line,
                    });
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, heading_text)) = &mut heading {
                    heading_text.push_str(&text);
                }
                if let Some(link) = &mut link {
                    link.label.push_str(&text);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some(link) = &mut link {
                    link.label.push(' ');
                }
            }
            _ => {}
        }
        if closes_container {
            container_depth = container_depth.saturating_sub(1);
        }
    }
    references
}

fn heading_number(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

pub(crate) fn absolute_http_url(value: &str) -> bool {
    let value = value.trim();
    if value
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return false;
    }
    let Ok(uri) = value.parse::<Uri>() else {
        return false;
    };
    if !matches!(uri.scheme_str(), Some("http" | "https")) {
        return false;
    }
    let Some(authority) = uri.authority() else {
        return false;
    };
    let authority_text = authority.as_str();
    if authority_text.contains('@') {
        return false;
    }
    let host = authority.host();
    let suffix = authority_text.strip_prefix(host).unwrap_or_default();
    if !suffix.is_empty()
        && (!suffix.starts_with(':')
            || suffix.len() == 1
            || !suffix[1..].bytes().all(|byte| byte.is_ascii_digit())
            || authority.port_u16().is_none())
    {
        return false;
    }
    !host.is_empty()
        && host != "."
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.split('.').any(str::is_empty)
}

fn non_preferred_doi_link(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "http://doi.org/",
        "http://dx.doi.org/",
        "https://dx.doi.org/",
        "doi:",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

fn source_line(markdown: &str, offset: usize, body_line: usize) -> usize {
    body_line
        + markdown[..offset.min(markdown.len())]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// A DOI written as its bare name (`10.x/y`), whichever accepted form it
/// is stored in; anything else is returned trimmed.
pub(crate) fn doi_name(value: &str) -> String {
    let trimmed = value.trim();
    if let Some(name) = canonical_doi_name(trimmed) {
        return name;
    }
    if let Some(name) = strip_ascii_prefix(trimmed, "doi:") {
        return name.trim().to_string();
    }
    trimmed.to_string()
}

/// Return the preferred resolver URL for a DOI with broad structural validity.
/// The suffix is intentionally not constrained to ASCII.
pub fn normalize_doi_url(value: &str) -> Option<String> {
    let name = canonical_doi_name(value.trim())?;
    if name.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return None;
    }
    let (prefix, suffix) = name.split_once('/')?;
    let digits = prefix.strip_prefix("10.")?;
    if digits.len() < 4 || !digits.bytes().all(|byte| byte.is_ascii_digit()) || suffix.is_empty() {
        return None;
    }
    Some(format!(
        "https://doi.org/{prefix}/{}",
        encode_doi_suffix(suffix)
    ))
}

fn canonical_doi_name(value: &str) -> Option<String> {
    if value
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
        || value
            .get(..8)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
    {
        if value.contains('#') {
            return None;
        }
        let uri = value.parse::<Uri>().ok()?;
        let scheme = uri.scheme_str()?;
        if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
            return None;
        }
        let authority = uri.authority()?;
        if authority.as_str().contains('@')
            || (!authority.host().eq_ignore_ascii_case("doi.org")
                && !authority.host().eq_ignore_ascii_case("dx.doi.org"))
            || uri.query().is_some()
        {
            return None;
        }
        return percent_decode(uri.path().strip_prefix('/')?.trim());
    }
    Some(
        strip_ascii_prefix(value, "doi:")
            .unwrap_or(value)
            .trim()
            .to_string(),
    )
}

fn strip_ascii_prefix<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())
        .filter(|candidate| candidate.eq_ignore_ascii_case(prefix))
        .and_then(|_| value.get(prefix.len()..))
}

pub fn audit_document(
    path: &str,
    front_matter: &FrontMatter,
    markdown: &str,
    body_line: usize,
) -> Vec<EvidenceFinding> {
    let mut findings = Vec::new();
    if let Some(doi) = front_matter.get("doi") {
        if normalize_doi_url(doi).is_none() {
            findings.push(
                field_finding(
                    path,
                    "doi",
                    EvidenceCode::DoiInvalid,
                    EvidenceOutcome::Detected,
                    "The DOI does not have a valid prefix, separator, and suffix.",
                    "Use a DOI name such as `10.1234/example` or its `https://doi.org/` URL.",
                )
                .with_facts([doi]),
            );
        }
    }
    if let Some(license) = front_matter.get("license") {
        if !absolute_http_url(license) {
            findings.push(
                field_finding(
                    path,
                    "license",
                    EvidenceCode::LicenseUrlInvalid,
                    EvidenceOutcome::Detected,
                    "The work license is not an absolute HTTP or HTTPS URL.",
                    "Link to the license document with its complete `https://` URL.",
                )
                .with_facts([license]),
            );
        }
    }

    let mut heading = None;
    let mut reference_level = None;
    let mut in_references = false;
    let mut reference_items: Vec<(usize, bool)> = Vec::new();
    let mut reference_paragraph: Option<(usize, bool)> = None;
    let mut section_findings = Vec::new();
    let mut has_abstract = false;
    let mut has_references = false;
    let mut container_depth = 0usize;
    let parser = Parser::new_ext(markdown, crate::markdown::parser_options(false));
    for (event, range) in parser.into_offset_iter() {
        let closes_container = closes_container(&event);
        if opens_container(&event) {
            container_depth += 1;
        }
        match event {
            Event::Start(Tag::Heading { level, .. }) if container_depth == 0 => {
                let level = heading_number(level);
                if reference_level.is_some_and(|reference_level| level <= reference_level) {
                    in_references = false;
                    reference_level = None;
                }
                heading = Some((level, String::new()));
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((level, text)) = heading.take() {
                    let text = text.trim();
                    has_abstract |= text.eq_ignore_ascii_case("abstract");
                    if text.eq_ignore_ascii_case("references")
                        || text.eq_ignore_ascii_case("bibliography")
                    {
                        has_references = true;
                        in_references = true;
                        reference_level = Some(level);
                    }
                }
            }
            Event::Start(Tag::Item) if in_references => {
                reference_items.push((range.start, false));
            }
            Event::End(TagEnd::Item) if in_references => {
                if let Some((offset, has_link)) = reference_items.pop() {
                    if !has_link {
                        section_findings.push(offset_finding(
                            SourceOffset {
                                path,
                                markdown,
                                body_line,
                                offset,
                            },
                            EvidenceCode::ReferenceLinkReview,
                            EvidenceOutcome::NeedsReview,
                            "This reference has no resolvable HTTP or HTTPS link.".into(),
                            "Add a DOI resolver URL or another stable URL when one exists, or review the print-only reference manually.".into(),
                        )
                        .with_facts([markdown[range.clone()].trim()]));
                    }
                }
            }
            Event::Start(Tag::Paragraph)
                if in_references && reference_items.is_empty() && container_depth == 0 =>
            {
                reference_paragraph = Some((range.start, false));
            }
            Event::End(TagEnd::Paragraph) if in_references => {
                if let Some((offset, has_link)) = reference_paragraph.take() {
                    if !has_link {
                        section_findings.push(offset_finding(
                            SourceOffset {
                                path,
                                markdown,
                                body_line,
                                offset,
                            },
                            EvidenceCode::ReferenceLinkReview,
                            EvidenceOutcome::NeedsReview,
                            "This reference has no resolvable HTTP or HTTPS link.".into(),
                            "Add a DOI resolver URL or another stable URL when one exists, or review the print-only reference manually.".into(),
                        )
                        .with_facts([markdown[range.clone()].trim()]));
                    }
                }
            }
            Event::Start(Tag::Link { dest_url, .. }) if in_references => {
                let url = dest_url.as_ref();
                if absolute_http_url(url) {
                    if let Some((_, has_link)) = reference_items.last_mut() {
                        *has_link = true;
                    } else if let Some((_, has_link)) = &mut reference_paragraph {
                        *has_link = true;
                    }
                }
                if non_preferred_doi_link(url) {
                    section_findings.push(
                        offset_finding(
                            SourceOffset {
                                path,
                                markdown,
                                body_line,
                                offset: range.start,
                            },
                            EvidenceCode::DoiLinkNonPreferred,
                            EvidenceOutcome::Potential,
                            "This DOI link does not use the preferred HTTPS resolver form.".into(),
                            "Use `https://doi.org/<doi-name>` while keeping the same DOI name."
                                .into(),
                        )
                        .with_facts([url]),
                    );
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, heading_text)) = &mut heading {
                    heading_text.push_str(&text);
                }
            }
            _ => {}
        }
        if closes_container {
            container_depth = container_depth.saturating_sub(1);
        }
    }
    if !has_abstract {
        findings.push(field_finding(
            path,
            "body",
            EvidenceCode::AbstractMissing,
            EvidenceOutcome::Detected,
            "The research post has no visible Abstract section.",
            "Add an `## Abstract` section with the complete author-written summary.",
        ));
    }
    if !has_references {
        findings.push(field_finding(
            path,
            "body",
            EvidenceCode::ReferencesMissing,
            EvidenceOutcome::Detected,
            "The research post has no visible References or Bibliography section.",
            "Add an `## References` or `## Bibliography` section with the works used.",
        ));
    }
    findings.extend(section_findings);
    for (name, offset) in unresolved_footnotes(markdown) {
        findings.push(
            offset_finding(
                SourceOffset {
                    path,
                    markdown,
                    body_line,
                    offset,
                },
                EvidenceCode::FootnoteUnresolved,
                EvidenceOutcome::Detected,
                format!("Footnote `[^{}]` has no definition.", name),
                format!(
                    "Add a `[^{}]: ...` definition or remove the footnote reference.",
                    name
                ),
            )
            .with_facts([name.as_str()]),
        );
    }
    findings
}

fn unresolved_footnotes(markdown: &str) -> Vec<(String, usize)> {
    let mut definitions = Vec::new();
    let mut references = Vec::new();
    let mut text_ranges = Vec::new();
    let mut code_block_depth = 0usize;
    let parser = Parser::new_ext(markdown, crate::markdown::parser_options(false));
    for (event, range) in parser.into_offset_iter() {
        match &event {
            Event::Start(Tag::FootnoteDefinition(name)) => definitions.push(name.to_string()),
            Event::FootnoteReference(name) => references.push((name.to_string(), range.start)),
            Event::Start(Tag::CodeBlock(_)) => code_block_depth += 1,
            Event::End(TagEnd::CodeBlock) => code_block_depth = code_block_depth.saturating_sub(1),
            Event::Text(_) if code_block_depth == 0 => text_ranges.push(range),
            _ => {}
        }
    }
    let mut merged_ranges: Vec<std::ops::Range<usize>> = Vec::new();
    for range in text_ranges {
        if let Some(previous) = merged_ranges.last_mut() {
            if previous.end == range.start {
                previous.end = range.end;
                continue;
            }
        }
        merged_ranges.push(range);
    }
    for range in merged_ranges {
        let source = &markdown[range.clone()];
        references.extend(footnote_candidates(source).filter_map(|(name, offset)| {
            let source_offset = range.start + offset;
            (!source_is_escaped(markdown, source_offset))
                .then_some((name.to_string(), source_offset))
        }));
    }
    references
        .into_iter()
        .filter(|(name, _)| !definitions.iter().any(|defined| defined == name))
        .collect()
}

fn source_is_escaped(source: &str, offset: usize) -> bool {
    source[..offset]
        .bytes()
        .rev()
        .take_while(|byte| *byte == b'\\')
        .count()
        % 2
        == 1
}

fn footnote_candidates(source: &str) -> impl Iterator<Item = (&str, usize)> {
    source.match_indices("[^").filter_map(|(start, _)| {
        let escaped = source[..start]
            .bytes()
            .rev()
            .take_while(|byte| *byte == b'\\')
            .count()
            % 2
            == 1;
        if escaped
            || start
                .checked_sub(1)
                .is_some_and(|before| source.as_bytes()[before] == b'!')
        {
            return None;
        }
        let rest = &source[start + 2..];
        let end = rest.find(']')?;
        (!rest[..end].is_empty()).then_some((&rest[..end], start))
    })
}

fn opens_container(event: &Event<'_>) -> bool {
    matches!(
        event,
        Event::Start(Tag::BlockQuote(_) | Tag::Item | Tag::FootnoteDefinition(_) | Tag::Table(_))
    )
}

fn closes_container(event: &Event<'_>) -> bool {
    matches!(
        event,
        Event::End(
            TagEnd::BlockQuote(_) | TagEnd::Item | TagEnd::FootnoteDefinition | TagEnd::Table
        )
    )
}

fn field_finding(
    path: &str,
    field: &str,
    code: EvidenceCode,
    outcome: EvidenceOutcome,
    message: &str,
    repair: &str,
) -> EvidenceFinding {
    EvidenceFinding {
        code,
        outcome,
        source: EvidenceSource {
            path: path.to_string(),
            line: None,
            column: None,
            field: Some(field.to_string()),
        },
        message: message.to_string(),
        repair: repair.to_string(),
        object: None,
        facts: Vec::new(),
    }
}

struct SourceOffset<'a> {
    path: &'a str,
    markdown: &'a str,
    body_line: usize,
    offset: usize,
}

fn offset_finding(
    source: SourceOffset<'_>,
    code: EvidenceCode,
    outcome: EvidenceOutcome,
    message: String,
    repair: String,
) -> EvidenceFinding {
    let line_start = source.markdown[..source.offset]
        .rfind('\n')
        .map_or(0, |newline| newline + 1);
    EvidenceFinding {
        code,
        outcome,
        source: EvidenceSource {
            path: source.path.to_string(),
            line: Some(source_line(
                source.markdown,
                source.offset,
                source.body_line,
            )),
            column: Some(source.markdown[line_start..source.offset].chars().count() + 1),
            field: None,
        },
        message,
        repair,
        object: None,
        facts: Vec::new(),
    }
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex_value(bytes[index + 1])?;
            let low = hex_value(bytes[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn encode_doi_suffix(suffix: &str) -> String {
    let bytes = suffix.as_bytes();
    let mut output = String::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            output.push(char::from(byte));
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            output.push('%');
            output.push(char::from(HEX[usize::from(byte >> 4)]));
            output.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
        index += 1;
    }
    output
}
