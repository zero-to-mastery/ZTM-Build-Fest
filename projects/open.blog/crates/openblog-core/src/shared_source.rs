//! The public face of a shared reflection's source: the original source's title, link and
//! type, and the guiding question. This is the only part of a private shared-publication
//! record that may reach a page, a feed, or an export (ADR 0008).
//!
//! The values travel as plain front matter on the resulting Post, so native preview, the build,
//! and the portable projection all read one canonical, already-validated shape. Nothing here
//! reads the private record's participants, contributions, policy, source IDs, provenance,
//! creators, publishers, dates, or ISBNs.

use crate::collaboration::{
    is_bidi_control, normalize_source_url, SharedPublication, SourceKind,
    MAX_GUIDING_QUESTION_BYTES, MAX_SOURCE_TITLE_BYTES,
};
use crate::escape;
use crate::frontmatter::FrontMatter;

/// Front matter keys that publish the attribution.
pub const QUESTION_KEY: &str = "guidingQuestion";
pub const SOURCE_TITLE_KEY: &str = "sharedSourceTitle";
pub const SOURCE_URL_KEY: &str = "sharedSourceUrl";
pub const SOURCE_KIND_KEY: &str = "sharedSourceType";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SharedSource {
    pub kind: SourceKind,
    pub title: String,
    /// Absolute HTTP(S) link without credentials; the source is always shown as this link.
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SharedAttribution {
    pub question: Option<String>,
    pub source: Option<SharedSource>,
}

impl SharedAttribution {
    /// The approved public subset of a private record: the guiding question and the first
    /// (original) source's title, link and type. A link that is no longer a safe public
    /// address is dropped rather than published.
    pub fn from_record(record: &SharedPublication) -> Option<Self> {
        let question = record
            .guiding_question
            .as_deref()
            .and_then(|value| clean_line(value, MAX_GUIDING_QUESTION_BYTES));
        let source = record.sources.first().and_then(|source| {
            Some(SharedSource {
                kind: source.kind,
                title: clean_line(&source.title, MAX_SOURCE_TITLE_BYTES)?,
                url: source.url.as_deref().and_then(normalize_source_url),
            })
        });
        (question.is_some() || source.is_some()).then_some(Self { question, source })
    }

    /// Read published attribution from a Post's front matter. Absent keys mean no attribution;
    /// present but unsafe values are an error, so a bad link or oversized text fails the load
    /// instead of publishing something other than what the author approved.
    pub fn from_front_matter(fm: &FrontMatter) -> Result<Option<Self>, String> {
        let get = |key: &str| fm.get(key).map(str::trim).filter(|value| !value.is_empty());
        let question = match get(QUESTION_KEY) {
            Some(value) => Some(clean_line(value, MAX_GUIDING_QUESTION_BYTES).ok_or_else(
                || {
                    format!(
                        "`{QUESTION_KEY}` must be one line of plain text of at most {MAX_GUIDING_QUESTION_BYTES} bytes"
                    )
                },
            )?),
            None => None,
        };
        let (title, url, kind) = (
            get(SOURCE_TITLE_KEY),
            get(SOURCE_URL_KEY),
            get(SOURCE_KIND_KEY),
        );
        let source = match title {
            Some(title) => Some(SharedSource {
                title: clean_line(title, MAX_SOURCE_TITLE_BYTES).ok_or_else(|| {
                    format!(
                        "`{SOURCE_TITLE_KEY}` must be one line of plain text of at most {MAX_SOURCE_TITLE_BYTES} bytes"
                    )
                })?,
                url: match url {
                    Some(url) => Some(normalize_source_url(url).ok_or_else(|| {
                        format!(
                            "`{SOURCE_URL_KEY}` must be an absolute HTTP(S) link without credentials"
                        )
                    })?),
                    None => None,
                },
                kind: match kind {
                    Some(kind) => SourceKind::from_label(kind).ok_or_else(|| {
                        format!(
                            "`{SOURCE_KIND_KEY}` must be Video, Article, Podcast, Book, or Other"
                        )
                    })?,
                    None => SourceKind::Other,
                },
            }),
            None if url.is_some() || kind.is_some() => {
                return Err(format!(
                    "`{SOURCE_TITLE_KEY}` is required with a shared source link or type"
                ));
            }
            None => None,
        };
        Ok((question.is_some() || source.is_some()).then_some(Self { question, source }))
    }

    /// Front matter lines (no `---` fences) that publish this attribution.
    pub fn front_matter_lines(&self) -> String {
        let mut lines = String::new();
        let mut push = |key: &str, value: &str| {
            lines.push_str(&format!(
                "{key}: \"{}\"\n",
                value.replace('\\', "\\\\").replace('"', "\\\"")
            ));
        };
        if let Some(question) = &self.question {
            push(QUESTION_KEY, question);
        }
        if let Some(source) = &self.source {
            push(SOURCE_TITLE_KEY, &source.title);
            if let Some(url) = &source.url {
                push(SOURCE_URL_KEY, url);
            }
            push(SOURCE_KIND_KEY, source.kind.label());
        }
        lines
    }

    /// The block shown beside the post. The source is always a plain link, never an embed, so
    /// every output (page, feed, export) shows the same thing and an unsupported provider
    /// needs no fallback.
    pub fn html(&self) -> String {
        let mut html = String::from(
            "<aside class=\"ob-shared-source\" aria-label=\"Shared reflection source\">\n",
        );
        if let Some(question) = &self.question {
            html.push_str(&format!(
                "<p class=\"ob-guiding-question\"><strong>Guiding question:</strong> {}</p>\n",
                escape::text(question)
            ));
        }
        if let Some(source) = &self.source {
            let name = match &source.url {
                Some(url) => format!(
                    "<a href=\"{}\" rel=\"noopener\">{}</a>",
                    escape::attr(url),
                    escape::text(&source.title)
                ),
                None => escape::text(&source.title),
            };
            html.push_str(&format!(
                "<p class=\"ob-shared-source-ref\"><strong>Source ({}):</strong> {name}</p>\n",
                source.kind.label()
            ));
        }
        html.push_str("</aside>\n");
        html
    }
}

/// One line of plain text within `max` bytes: control, bidi and line-separator characters are
/// refused rather than silently stripped, so the published text is what was approved.
fn clean_line(value: &str, max: usize) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= max
        && !value
            .chars()
            .any(|c| c.is_control() || is_bidi_control(c) || matches!(c, '\u{2028}' | '\u{2029}')))
    .then(|| value.to_string())
}
