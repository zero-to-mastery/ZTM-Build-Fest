//! The published reference data a reader-facing citation preview uses
//! (ADR 0059).
//!
//! A post that publishes citations (ADR 0048) already shows each citation as
//! a note marker linked to a visible note. This module projects the same
//! publication into one small, versioned, deterministic data document: each
//! cited reference once under a stable id, and each citation with the anchors
//! of its marker and its note. A preview Web Component can enhance the
//! markers with it; the page reads fully without it, because the notes are
//! the references.
//!
//! The data is built from the types the citation layer already publishes
//! ([`PublicReference`], [`PublicLocator`]) and from nothing else, so nothing
//! outside the ADR 0044 allowlist can appear in it, and it carries no
//! summary, claim or judgement about a source.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::bibliography::{doi_link, safe_http_url, CitationSummary};
use crate::citations::{format_reference, PublicLocator, PublicReference};

/// The version of the data document; a consumer ignores a higher one.
pub const READER_REFERENCES_VERSION: u32 = 1;

/// The `id` of the `<script type="application/json">` element that carries
/// the data inline on a page.
pub const READER_REFERENCES_ELEMENT_ID: &str = "ob-references";

/// One cited reference, once, under its stable id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ReaderReference {
    /// The citation key, which is the source identifier (ADR 0042). It is
    /// stable across rebuilds and distinct per work, edition, translation
    /// and witness, so versions of a work never share an id.
    pub id: String,
    /// One-based, in order of first citation.
    pub number: usize,
    /// The public description (ADR 0044): kind, title, creators, issued,
    /// language, public identifiers and preserved CSL variables. `kind`
    /// tells a work from an edition, translation or witness.
    pub preview: PublicReference,
    /// The deterministic plain-text rendering, the same fallback text the
    /// exports use.
    pub formatted: String,
    /// A safe external link: a DOI resolver address, or a plain HTTP(S)
    /// address without credentials. Absent when the reference has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

/// One citation in the text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ReaderCitation {
    /// The element id of this citation's marker in the page. Positional:
    /// valid for this revision of the page only, so never stored; a durable
    /// target uses the reference id.
    pub marker: String,
    /// The element id of the note the marker links to. Positional, like
    /// `marker`.
    pub note: String,
    /// The id of the cited [`ReaderReference`].
    pub reference: String,
    /// Where in the reference, kept apart from which version: precise
    /// locators belong to the citation, never to the reference.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locators: Vec<PublicLocator>,
    /// The locators as readers see them in the notes' locale (`p. 514–520,
    /// l. 3`), pre-rendered plain text for a preview to show as text (ADR
    /// 0061). Absent when the citation has no locators.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formatted: Option<String>,
}

/// The reference data of one published post.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ReaderReferences {
    pub version: u32,
    /// `notes` or `bibliography`.
    pub style: &'static str,
    /// The locale of the generated notes.
    pub locale: &'static str,
    pub references: Vec<ReaderReference>,
    pub citations: Vec<ReaderCitation>,
}

impl ReaderReferences {
    /// Project what a post's citations published. Fails, naming the problem,
    /// only if the summary is internally inconsistent, which would be a bug:
    /// the result is checked with [`validate`](Self::validate).
    pub fn from_summary(summary: &CitationSummary) -> Result<Self, String> {
        let references: Vec<ReaderReference> = summary
            .references
            .iter()
            .enumerate()
            .map(|(index, reference)| ReaderReference {
                id: reference.key.clone(),
                number: index + 1,
                formatted: format_reference(reference),
                link: reference_link(reference),
                preview: reference.clone(),
            })
            .collect();
        let mut seen_per_note: Vec<usize> = vec![0; summary.notes + 1];
        let mut citations = Vec::with_capacity(summary.placements.len());
        for placement in &summary.placements {
            let reference = references
                .get(placement.reference.wrapping_sub(1))
                .ok_or("a citation points at a reference that was not published")?;
            let occurrence = seen_per_note
                .get_mut(placement.note)
                .ok_or("a citation points at a note that was not published")?;
            *occurrence += 1;
            let note = format!("{}{}", summary.prefix, placement.note);
            citations.push(ReaderCitation {
                marker: format!("{note}-ref-{occurrence}"),
                note,
                reference: reference.id.clone(),
                locators: placement.locators.clone(),
                formatted: (!placement.locators.is_empty())
                    .then(|| summary.locale.locators_text(&placement.locators)),
            });
        }
        let data = Self {
            version: READER_REFERENCES_VERSION,
            style: summary.style.key(),
            locale: summary.locale.key(),
            references,
            citations,
        };
        data.validate()?;
        Ok(data)
    }

    /// Every citation resolves to a reference in this document, every id is
    /// unique, and every reference is cited at least once.
    pub fn validate(&self) -> Result<(), String> {
        let mut ids = BTreeSet::new();
        for reference in &self.references {
            if !ids.insert(reference.id.as_str()) {
                return Err(format!("reference `{}` appears twice", reference.id));
            }
        }
        let mut markers = BTreeSet::new();
        let mut cited = BTreeSet::new();
        for citation in &self.citations {
            if !ids.contains(citation.reference.as_str()) {
                return Err(format!(
                    "citation `{}` cites `{}`, which is not a published reference",
                    citation.marker, citation.reference
                ));
            }
            if !markers.insert(citation.marker.as_str()) {
                return Err(format!("marker `{}` appears twice", citation.marker));
            }
            cited.insert(citation.reference.as_str());
        }
        if let Some(unused) = self
            .references
            .iter()
            .find(|reference| !cited.contains(reference.id.as_str()))
        {
            return Err(format!("reference `{}` is never cited", unused.id));
        }
        Ok(())
    }

    /// Whether the page's HTML lets each citation be followed without
    /// JavaScript: exactly one element carries each marker id and each note
    /// id, the marker is a link to its note, the page links back to the
    /// marker, and exactly one element carries the id that names the notes'
    /// `doc-endnotes` region. Returns the first problem, naming the id and,
    /// when another element reuses it, how to fix the post.
    pub fn check_page(&self, html: &str) -> Result<(), String> {
        let elements = element_ids(html);
        let tags = |id: &str| elements.get(id).map_or(&[][..], Vec::as_slice);
        let fragments: BTreeSet<&str> = attribute_after(html, " href=\"#").into_iter().collect();
        for citation in &self.citations {
            for (id, what) in [
                (&citation.marker, "a citation marker"),
                (&citation.note, "a citation note"),
            ] {
                match tags(id).len() {
                    1 => {}
                    0 => return Err(format!("the page has no element with id `{id}`")),
                    _ => return Err(reused(id, what)),
                }
            }
            let marker = &html[tags(&citation.marker)[0].clone()];
            if !marker.contains(&format!(" href=\"#{}\"", citation.note)) {
                return Err(format!(
                    "the marker `{}` does not link to its note `{}`",
                    citation.marker, citation.note
                ));
            }
            if !fragments.contains(citation.marker.as_str()) {
                return Err(format!(
                    "nothing links back to the marker `{}`",
                    citation.marker
                ));
            }
        }
        for label in attribute_after(html, ENDNOTES_LABEL) {
            match tags(label).len() {
                1 => {}
                0 => {
                    return Err(format!(
                        "the citation notes are labelled by `{label}`, but the page has no element with that id"
                    ))
                }
                _ => return Err(reused(label, "the citation notes' heading")),
            }
        }
        Ok(())
    }

    /// Canonical JSON: fixed field order, no whitespace, nothing that
    /// depends on time, locale or hash order.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("reader references always serialize")
    }

    /// The same JSON made safe to place inside a `<script>` element:
    /// `<`, `>`, `&` and the JavaScript line separators are written as
    /// `\u` escapes, so no text can close the element or start a comment.
    /// The parsed value is identical.
    pub fn to_embedded_json(&self) -> String {
        let mut out = String::new();
        for character in self.to_json().chars() {
            match character {
                '<' | '>' | '&' | '\u{2028}' | '\u{2029}' => {
                    out.push_str(&format!("\\u{:04x}", character as u32));
                }
                _ => out.push(character),
            }
        }
        out
    }

    /// The `<script>` element that carries the data inline on a page. It is
    /// data only: it is never executed and the page is complete without it.
    pub fn to_script_element(&self) -> String {
        format!(
            "<script type=\"application/json\" id=\"{READER_REFERENCES_ELEMENT_ID}\">{}</script>",
            self.to_embedded_json()
        )
    }
}

/// The opening tag of every element on the page, by its id, read once as a
/// browser reads ids ([`crate::raw_html::id_attributes`]): `ID="x"`,
/// `id = 'x'` and `id=x` all name `x`. Text inside an attribute value or a
/// comment names nothing; raw text that looks like markup counts, which errs
/// towards refusing the page.
fn element_ids(html: &str) -> std::collections::HashMap<String, Vec<std::ops::Range<usize>>> {
    let mut elements: std::collections::HashMap<String, Vec<_>> = std::collections::HashMap::new();
    for (tag, id) in crate::raw_html::id_attributes(html) {
        elements.entry(id).or_default().push(tag);
    }
    elements
}

/// What opens the attribute that names the notes' region with its heading.
const ENDNOTES_LABEL: &str = " role=\"doc-endnotes\" aria-labelledby=\"";

/// Each value of an attribute that follows `opening` (which ends with the
/// value's opening quote).
fn attribute_after<'h>(html: &'h str, opening: &str) -> Vec<&'h str> {
    html.match_indices(opening)
        .filter_map(|(at, _)| {
            let rest = &html[at + opening.len()..];
            rest.find('"').map(|end| &rest[..end])
        })
        .collect()
}

/// The diagnostic for an id that more than one element carries: which id,
/// what the page needs it for, and what to rename.
fn reused(id: &str, what: &str) -> String {
    format!(
        "the page has more than one element with id `{id}`, which {what} uses; rename the other `id=\"{id}\"` in the post (raw HTML cannot reuse a citation's ids)"
    )
}

/// A reference's one safe external link: its DOI, else its web address.
fn reference_link(reference: &PublicReference) -> Option<String> {
    let find = |wanted: &str| {
        reference
            .identifiers
            .iter()
            .find(|(scheme, _)| scheme == wanted)
            .map(|(_, value)| value.as_str())
    };
    find("doi")
        .and_then(doi_link)
        .or_else(|| find("url").and_then(safe_http_url))
}
