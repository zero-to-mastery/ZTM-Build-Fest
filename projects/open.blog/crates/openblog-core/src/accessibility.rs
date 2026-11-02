//! Structured accessibility guidance derived from canonical blog source.

use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use serde::{ser::SerializeStruct, Serialize, Serializer};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuditOutcome {
    Detected,
    Potential,
    NeedsReview,
}

impl fmt::Display for AuditOutcome {
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
pub enum AuditScope {
    Content,
    Site,
    Theme,
    Embed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum FindingCode {
    LinkNameEmpty,
    DocumentLanguageMissing,
    ImageAltReview,
    ImageAltPlaceholder,
    HeadingLevelSkip,
    LinkPurposeReview,
    TableStructureReview,
    MediaAlternativesReview,
    EmbedAccessibilityReview,
    RawHtmlReview,
}

impl fmt::Display for FindingCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::LinkNameEmpty => "link-name-empty",
            Self::DocumentLanguageMissing => "document-language-missing",
            Self::ImageAltReview => "image-alt-review",
            Self::ImageAltPlaceholder => "image-alt-placeholder",
            Self::HeadingLevelSkip => "heading-level-skip",
            Self::LinkPurposeReview => "link-purpose-review",
            Self::TableStructureReview => "table-structure-review",
            Self::MediaAlternativesReview => "media-alternatives-review",
            Self::EmbedAccessibilityReview => "embed-accessibility-review",
            Self::RawHtmlReview => "raw-html-review",
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FindingLocation {
    Markdown { line: usize, column: usize },
    Field { field: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FindingSource {
    pub path: String,
    pub location: FindingLocation,
}

impl FindingSource {
    pub fn line(&self) -> Option<usize> {
        match self.location {
            FindingLocation::Markdown { line, .. } => Some(line),
            FindingLocation::Field { .. } => None,
        }
    }

    pub fn column(&self) -> Option<usize> {
        match self.location {
            FindingLocation::Markdown { column, .. } => Some(column),
            FindingLocation::Field { .. } => None,
        }
    }

    pub fn field(&self) -> Option<&str> {
        match &self.location {
            FindingLocation::Field { field } => Some(field),
            FindingLocation::Markdown { .. } => None,
        }
    }
}

impl Serialize for FindingSource {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut source = serializer.serialize_struct("FindingSource", 4)?;
        source.serialize_field("path", &self.path)?;
        source.serialize_field("line", &self.line())?;
        source.serialize_field("column", &self.column())?;
        source.serialize_field("field", &self.field())?;
        source.end()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityFinding {
    pub code: FindingCode,
    pub outcome: AuditOutcome,
    pub scope: AuditScope,
    pub source: FindingSource,
    pub message: String,
    pub repair: String,
    pub references: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct DocumentAuditInput<'a> {
    pub path: &'a str,
    pub markdown: &'a str,
    /// One-based line where `markdown` begins in the canonical source file.
    pub body_line: usize,
    /// Whether the production Markdown renderer turns supported standalone links into embeds.
    pub embeds_enabled: bool,
    /// `Some(alt)` means the document has a cover image; `None` means it does not.
    pub cover_alt: Option<&'a str>,
}

/// Audit the site-wide language needed on every generated page.
pub fn audit_site_language(path: &str, language: &str) -> Vec<AccessibilityFinding> {
    if !language.trim().is_empty() {
        return Vec::new();
    }
    vec![field_finding(
        path,
        "language",
        FindingDetails::new(
            FindingCode::DocumentLanguageMissing,
            AuditOutcome::Detected,
            AuditScope::Site,
            "Generated pages have no configured default language.",
            "Set `language` in openblog.json to the site's BCP 47 language tag.",
            &["WCAG-2.2-3.1.1"],
        ),
    )]
}

struct LinkState {
    offset: usize,
    name: String,
    destination: Option<String>,
    indeterminate_name: bool,
}

/// Audit author-controlled Markdown and front-matter context for one document.
pub fn audit_document(input: DocumentAuditInput<'_>) -> Vec<AccessibilityFinding> {
    let mut findings = Vec::new();
    if let Some(alt) = input.cover_alt {
        if alt.trim().is_empty() {
            findings.push(field_finding(
                input.path,
                "coverAlt",
                FindingDetails::new(
                    FindingCode::ImageAltReview,
                    AuditOutcome::NeedsReview,
                    AuditScope::Content,
                    "Decide whether the cover image is decorative or needs alternative text.",
                    "Describe the cover's purpose in context, or keep the alternative empty when it is decorative.",
                    &["WCAG-2.2-1.1.1"],
                ),
            ));
        } else if placeholder_alt(alt) {
            findings.push(field_finding(
                input.path,
                "coverAlt",
                FindingDetails::new(
                    FindingCode::ImageAltPlaceholder,
                    AuditOutcome::Potential,
                    AuditScope::Content,
                    "The cover image alternative looks like a filename or placeholder.",
                    "Review the cover in context and describe its purpose rather than its file name.",
                    &["WCAG-2.2-1.1.1"],
                ),
            ));
        }
    }
    let mut link = None;
    let mut image = None;
    let mut compare: Option<(usize, String)> = None;
    // Document templates render the front-matter title as H1 before the body.
    let mut previous_heading = 1;
    let mut saw_table = false;
    // The approved moments a shared reflection ends with are framed by the same kind of closed
    // grammar (ADR 0066), and observations cannot contain HTML (ADR 0062), so every HTML line from
    // the block's start on is openblog's frame. What comes before it is judged on its own.
    let moments = crate::published_moment::MomentsBlock::parse(input.markdown);
    let (before_moments, moments_start) = match &moments {
        Some(block) => (&input.markdown[..block.before], block.before),
        None => (input.markdown, input.markdown.len()),
    };
    // A shared reflection's arrangement frame is markup openblog writes from a closed grammar
    // (sections headed by their author's name, ADR 0033), and the publish gate refuses raw HTML in
    // the turns themselves. It is not custom markup an author could inspect or repair (#188).
    let mut saw_raw_html = crate::arrangement::Arrangement::parse(before_moments).is_some();
    let mut saw_media = false;
    let options = crate::markdown::parser_options(false);
    let events: Vec<_> = Parser::new_ext(input.markdown, options)
        .into_offset_iter()
        .collect();

    for (event, range) in events.iter().cloned() {
        match event {
            Event::Start(Tag::Link { dest_url, .. }) => {
                link = Some(LinkState {
                    offset: range.start,
                    name: String::new(),
                    destination: Some(dest_url.into_string()),
                    indeterminate_name: false,
                });
            }
            Event::Start(Tag::Image { .. }) => {
                image = Some(LinkState {
                    offset: range.start,
                    name: String::new(),
                    destination: None,
                    indeterminate_name: false,
                });
            }
            Event::Start(Tag::Heading { level, .. }) => {
                let level = heading_level(level);
                if level > previous_heading + 1 {
                    findings.push(finding(
                        input,
                        range.start,
                        FindingDetails::new(
                            FindingCode::HeadingLevelSkip,
                            AuditOutcome::Potential,
                            AuditScope::Content,
                            format!(
                                "The heading outline jumps from H{previous_heading} to H{level}."
                            ),
                            "Review the outline and use the next heading level when it represents a nested section.",
                            &["WCAG-2.2-1.3.1", "WCAG-2.2-2.4.6"],
                        ),
                    ));
                }
                previous_heading = level;
            }
            Event::Start(Tag::Table(_)) if !saw_table => {
                saw_table = true;
                findings.push(finding(
                    input,
                    range.start,
                    FindingDetails::new(
                        FindingCode::TableStructureReview,
                        AuditOutcome::NeedsReview,
                        AuditScope::Content,
                        "Review whether this table's structure communicates its relationships.",
                        "Confirm that headers describe the correct rows or columns and that complex relationships remain understandable.",
                        &["WCAG-2.2-1.3.1"],
                    ),
                ));
            }
            Event::Html(_) | Event::InlineHtml(_) if range.start >= moments_start => {}
            Event::Html(_) | Event::InlineHtml(_) => {
                if let Some(link) = link.as_mut() {
                    link.indeterminate_name = true;
                }
                if !saw_raw_html {
                    saw_raw_html = true;
                    findings.push(finding(
                        input,
                        range.start,
                        FindingDetails::new(
                            FindingCode::RawHtmlReview,
                            AuditOutcome::NeedsReview,
                            AuditScope::Content,
                            "Raw HTML can introduce semantics and interactions that source checks cannot verify.",
                            "Inspect the rendered HTML, keyboard behavior, accessible names, and relationships for this custom markup.",
                            &[],
                        ),
                    ));
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, source)) = compare.as_mut() {
                    source.push_str(&text);
                }
                if let Some(link) = link.as_mut() {
                    link.name.push_str(&text);
                }
                if let Some(image) = image.as_mut() {
                    image.name.push_str(&text);
                }
            }
            Event::Start(Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Fenced(info)))
                if info.trim() == crate::compare::FENCE =>
            {
                compare = Some((range.start, String::new()));
            }
            Event::End(TagEnd::CodeBlock) => {
                // Alt text is required by the fence itself; a filename or stock word still needs a look.
                if let Some((offset, source)) = compare.take() {
                    if let Ok(pair) = crate::compare::parse(&source) {
                        for side in [&pair.before, &pair.after] {
                            if placeholder_alt(&side.alt) {
                                findings.push(finding(
                                    input,
                                    offset,
                                    FindingDetails::new(
                                        FindingCode::ImageAltPlaceholder,
                                        AuditOutcome::Potential,
                                        AuditScope::Content,
                                        "A before and after picture's description looks like a filename or placeholder.",
                                        "Review the picture in context and describe what it shows rather than its file name.",
                                        &["WCAG-2.2-1.1.1"],
                                    ),
                                ));
                            }
                        }
                    }
                }
            }
            Event::End(TagEnd::Image) => {
                if let Some(image) = image.take() {
                    if image.name.trim().is_empty() {
                        findings.push(finding(
                            input,
                            image.offset,
                            FindingDetails::new(
                                FindingCode::ImageAltReview,
                                AuditOutcome::NeedsReview,
                                AuditScope::Content,
                                "Decide whether this image is decorative or needs alternative text.",
                                "Describe the image's purpose in context, or keep the alternative empty when it is decorative.",
                                &["WCAG-2.2-1.1.1"],
                            ),
                        ));
                    } else if placeholder_alt(&image.name) {
                        findings.push(finding(
                            input,
                            image.offset,
                            FindingDetails::new(
                                FindingCode::ImageAltPlaceholder,
                                AuditOutcome::Potential,
                                AuditScope::Content,
                                "This image alternative looks like a filename or placeholder.",
                                "Review the image in context and describe its purpose rather than its file name.",
                                &["WCAG-2.2-1.1.1"],
                            ),
                        ));
                    }
                }
            }
            Event::End(TagEnd::Link) => {
                if let Some(link) = link.take() {
                    if link.name.trim().is_empty() && !link.indeterminate_name {
                        findings.push(finding(
                            input,
                            link.offset,
                            FindingDetails::new(
                                FindingCode::LinkNameEmpty,
                                AuditOutcome::Detected,
                                AuditScope::Content,
                                "This link has no accessible name.",
                                "Add link text that identifies its destination or action.",
                                &["WCAG-2.2-2.4.4"],
                            ),
                        ));
                    } else if generic_link_text(&link.name) {
                        findings.push(finding(
                            input,
                            link.offset,
                            FindingDetails::new(
                                FindingCode::LinkPurposeReview,
                                AuditOutcome::Potential,
                                AuditScope::Content,
                                format!(
                                    "The link text “{}” may not identify its purpose in context.",
                                    link.name.trim()
                                ),
                                "Use link text that describes the destination or action, then review it with the surrounding sentence.",
                                &["WCAG-2.2-2.4.4"],
                            ),
                        ));
                    }
                    if !saw_media
                        && link
                            .destination
                            .as_deref()
                            .is_some_and(is_media_destination)
                    {
                        saw_media = true;
                        findings.push(finding(
                            input,
                            link.offset,
                            FindingDetails::new(
                                FindingCode::MediaAlternativesReview,
                                AuditOutcome::NeedsReview,
                                AuditScope::Content,
                                "Linked audio or video needs an alternatives review.",
                                "Confirm that the media provides the captions, transcript, and audio description its content requires.",
                                &["WCAG-2.2-1.2.1", "WCAG-2.2-1.2.2", "WCAG-2.2-1.2.5"],
                            ),
                        ));
                    }
                }
            }
            _ => {}
        }
    }

    if input.embeds_enabled {
        for (index, (event, range)) in events.iter().enumerate() {
            if !matches!(event, Event::Start(Tag::Paragraph)) {
                continue;
            }
            let Some(length) = events[index + 1..]
                .iter()
                .position(|(event, _)| matches!(event, Event::End(TagEnd::Paragraph)))
            else {
                continue;
            };
            let inner: Vec<_> = events[index + 1..index + 1 + length]
                .iter()
                .map(|(event, _)| event.clone())
                .collect();
            if crate::markdown::standalone_embed(&inner).is_none() {
                continue;
            }
            findings.push(finding(
                input,
                range.start,
                FindingDetails::new(
                    FindingCode::EmbedAccessibilityReview,
                    AuditOutcome::NeedsReview,
                    AuditScope::Embed,
                    "This link becomes an embedded third-party experience when published.",
                    "Inspect the rendered embed with keyboard and assistive technology, and keep its fallback link meaningful.",
                    &[],
                ),
            ));
            break;
        }
    }

    findings
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn placeholder_alt(alt: &str) -> bool {
    let normalized = alt.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "image" | "photo" | "picture" | "placeholder" | "alt text" | "todo"
    ) || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]
        .iter()
        .any(|extension| normalized.ends_with(extension))
}

fn generic_link_text(text: &str) -> bool {
    matches!(
        text.trim().to_ascii_lowercase().as_str(),
        "click here" | "here" | "read more" | "link" | "more"
    )
}

fn is_media_destination(destination: &str) -> bool {
    let path = destination
        .split(['?', '#'])
        .next()
        .unwrap_or(destination)
        .to_ascii_lowercase();
    [
        ".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".mp4", ".webm", ".mov", ".m4v",
    ]
    .iter()
    .any(|extension| path.ends_with(extension))
}

struct FindingDetails {
    code: FindingCode,
    outcome: AuditOutcome,
    scope: AuditScope,
    message: String,
    repair: String,
    references: Vec<String>,
}

impl FindingDetails {
    fn new(
        code: FindingCode,
        outcome: AuditOutcome,
        scope: AuditScope,
        message: impl Into<String>,
        repair: &str,
        references: &[&str],
    ) -> Self {
        Self {
            code,
            outcome,
            scope,
            message: message.into(),
            repair: repair.to_string(),
            references: references
                .iter()
                .map(|reference| reference.to_string())
                .collect(),
        }
    }
}

fn field_finding(path: &str, field: &str, details: FindingDetails) -> AccessibilityFinding {
    AccessibilityFinding {
        code: details.code,
        outcome: details.outcome,
        scope: details.scope,
        source: FindingSource {
            path: path.to_string(),
            location: FindingLocation::Field {
                field: field.to_string(),
            },
        },
        message: details.message,
        repair: details.repair,
        references: details.references,
    }
}

fn finding(
    input: DocumentAuditInput<'_>,
    offset: usize,
    details: FindingDetails,
) -> AccessibilityFinding {
    let line_start = input.markdown[..offset]
        .rfind('\n')
        .map_or(0, |newline| newline + 1);
    AccessibilityFinding {
        code: details.code,
        outcome: details.outcome,
        scope: details.scope,
        source: FindingSource {
            path: input.path.to_string(),
            location: FindingLocation::Markdown {
                line: input.body_line.max(1) - 1
                    + input.markdown[..offset]
                        .bytes()
                        .filter(|byte| *byte == b'\n')
                        .count()
                    + 1,
                column: input.markdown[line_start..offset].chars().count() + 1,
            },
        },
        message: details.message,
        repair: details.repair,
        references: details.references,
    }
}
