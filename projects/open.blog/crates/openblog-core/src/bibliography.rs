//! Opt-in publication of citations as numbered notes or a bibliography.
//!
//! A post that sets `citations: notes` or `citations: bibliography` in its
//! front matter has each `[@key, locator]` citation resolved against the
//! source library and rewritten as an ordinary Markdown footnote reference,
//! with the generated notes appended under one heading (ADR 0048). Every
//! public representation (the native page, portable HTML, Markdown and text,
//! feeds and `llms.txt`) then reads that one published Markdown body, so
//! citations have one semantic projection rather than an exporter of their
//! own. Only the citation key, its locators and the reference's public
//! description ([`PublicReference`]) are written; nothing else in the library
//! and nothing in the notebook can reach the output (ADR 0044).
//!
//! Output is deterministic: notes are numbered in order of first citation,
//! text is escaped, and nothing depends on time, locale settings of the
//! machine or hash order. A post that does not opt in, or opts in without a
//! single citation, is published exactly as before.

use std::collections::BTreeSet;

use pulldown_cmark::{Event, Parser, Tag};

use crate::citations::{
    public_identifier, resolve_citations, scan_citations, CitationDiagnostic,
    CitationDiagnosticCode, PublicLocator, PublicReference,
};
use crate::source_library::SourceLibrary;

/// How a post's citations are published (ADR 0049).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CitationStyle {
    /// One numbered note per distinct citation (reference and locators); a
    /// repeated identical citation reuses its note.
    Notes,
    /// One numbered entry per cited reference, in order of first citation;
    /// locators stay visible in the text after the note marker.
    Bibliography,
}

impl CitationStyle {
    /// Read a post's `citations` front matter. `None` (absent, `false`,
    /// `no`, `off` or `none`) means the post has not opted in and is published
    /// exactly as before; `true`, `yes` and `on` mean `notes`, as every other
    /// boolean front matter field reads them (`FrontMatter::get_bool`).
    pub fn from_front_matter(value: Option<&str>) -> Result<Option<Self>, String> {
        let Some(value) = value else {
            return Ok(None);
        };
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "false" | "no" | "off" | "none" => Ok(None),
            "true" | "yes" | "on" | "notes" | "footnotes" => Ok(Some(Self::Notes)),
            "bibliography" | "references" => Ok(Some(Self::Bibliography)),
            _ => Err("`citations` must be `notes` or `bibliography` (or `false`)".into()),
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::Notes => "notes",
            Self::Bibliography => "bibliography",
        }
    }
}

/// The built-in locales for generated citation text. There is no download
/// and no machine locale: the post or the site names one, and anything else
/// falls back to English.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CitationLocale {
    En,
    De,
    Fr,
    Es,
}

impl CitationLocale {
    /// The locale for a language tag such as `en-GB` or `fr`, by its primary
    /// subtag, or `None` when no built-in locale matches.
    pub fn parse(tag: &str) -> Option<Self> {
        let primary = tag
            .trim()
            .split(['-', '_'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        match primary.as_str() {
            "en" => Some(Self::En),
            "de" => Some(Self::De),
            "fr" => Some(Self::Fr),
            "es" => Some(Self::Es),
            _ => None,
        }
    }

    /// A post's locale: its `citationLocale`, which must name a built-in
    /// locale, or else the site language when it has one, or else English.
    pub fn for_post(explicit: Option<&str>, site_language: &str) -> Result<Self, String> {
        match explicit.map(str::trim).filter(|value| !value.is_empty()) {
            Some(tag) => Self::parse(tag).ok_or_else(|| {
                format!("`citationLocale` `{tag}` is not a built-in citation locale; use en, de, fr or es")
            }),
            None => Ok(Self::parse(site_language).unwrap_or(Self::En)),
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::De => "de",
            Self::Fr => "fr",
            Self::Es => "es",
        }
    }

    fn strings(self) -> &'static LocaleStrings {
        match self {
            Self::En => &EN,
            Self::De => &DE,
            Self::Fr => &FR,
            Self::Es => &ES,
        }
    }

    /// Visually hidden words that name a citation marker for assistive
    /// technology: "Citation" before its number.
    pub fn citation_word(self) -> &'static str {
        self.strings().citation
    }

    /// Visually hidden words that name a note's way back to its citation.
    pub fn back_words(self) -> &'static str {
        self.strings().back
    }

    /// The words of a citation preview's link to the note (`notes`) or the
    /// reference list entry (`bibliography`) a marker leads to (ADR 0061).
    pub fn go_to_words(self, style: CitationStyle) -> &'static str {
        match style {
            CitationStyle::Notes => self.strings().go_to.0,
            CitationStyle::Bibliography => self.strings().go_to.1,
        }
    }

    /// Public locators as readers see them in this locale: `p. 514–520, 514a`.
    pub fn locators_text(self, locators: &[PublicLocator]) -> String {
        locators_text(locators, self.strings())
    }

    /// A reference as escaped inline Markdown in this locale, as a note shows
    /// it, without a final period.
    pub(crate) fn reference_markdown(self, reference: &PublicReference) -> String {
        reference_markdown(reference, self.strings())
    }
}

/// A locator label in its singular and range (plural) forms.
type Label = (&'static str, &'static str);

struct LocaleStrings {
    notes: &'static str,
    references: &'static str,
    citation: &'static str,
    back: &'static str,
    /// A preview's link to the note, then to the reference list entry.
    go_to: (&'static str, &'static str),
    page: Label,
    folio: Label,
    line: Label,
    section: Label,
    chapter: Label,
    at: &'static str,
    editor: Label,
    translator: Label,
}

const EN: LocaleStrings = LocaleStrings {
    notes: "Notes",
    references: "References",
    citation: "Citation",
    back: "Back to citation",
    go_to: ("Go to note", "Go to reference"),
    page: ("p.", "pp."),
    folio: ("fol.", "fols."),
    line: ("l.", "ll."),
    section: ("§", "§§"),
    chapter: ("ch.", "chs."),
    at: "at",
    editor: ("ed.", "eds."),
    translator: ("trans.", "trans."),
};

const DE: LocaleStrings = LocaleStrings {
    notes: "Anmerkungen",
    references: "Literatur",
    citation: "Beleg",
    back: "Zurück zum Beleg",
    go_to: ("Zur Anmerkung", "Zum Literatureintrag"),
    page: ("S.", "S."),
    folio: ("Bl.", "Bl."),
    line: ("Z.", "Z."),
    section: ("§", "§§"),
    chapter: ("Kap.", "Kap."),
    at: "bei",
    editor: ("Hrsg.", "Hrsg."),
    translator: ("Übers.", "Übers."),
};

const FR: LocaleStrings = LocaleStrings {
    notes: "Notes",
    references: "Références",
    citation: "Citation",
    back: "Retour à la citation",
    go_to: ("Aller à la note", "Aller à la référence"),
    page: ("p.", "p."),
    folio: ("fol.", "fol."),
    line: ("l.", "l."),
    section: ("§", "§§"),
    chapter: ("chap.", "chap."),
    at: "à",
    editor: ("éd.", "éd."),
    translator: ("trad.", "trad."),
};

const ES: LocaleStrings = LocaleStrings {
    notes: "Notas",
    references: "Referencias",
    citation: "Cita",
    back: "Volver a la cita",
    go_to: ("Ir a la nota", "Ir a la referencia"),
    page: ("p.", "pp."),
    folio: ("fol.", "fols."),
    line: ("lín.", "líns."),
    section: ("§", "§§"),
    chapter: ("cap.", "caps."),
    at: "en",
    editor: ("ed.", "eds."),
    translator: ("trad.", "trad."),
};

/// What the native renderer needs to give generated notes accessible
/// citation anchors: the label prefix that marks them and the locale of the
/// words it adds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CitationNoteLabels<'a> {
    pub prefix: &'a str,
    pub locale: CitationLocale,
}

impl CitationNoteLabels<'_> {
    /// The note number of a generated footnote label, or `None` for any
    /// other footnote (an author's own notes are never touched). Labels
    /// compare case-insensitively, as the Markdown parser matches them.
    pub fn number(&self, label: &str) -> Option<usize> {
        let label = label.to_lowercase();
        let rest = label.strip_prefix(&self.prefix.to_lowercase())?;
        (!rest.is_empty()
            && rest.bytes().all(|byte| byte.is_ascii_digit())
            && !rest.starts_with('0'))
        .then(|| rest.parse().ok())
        .flatten()
    }
}

/// What a published post's citations made public: its style and locale,
/// how many citations and notes it has, and each cited reference's public
/// description in order of first citation. Portable bibliography exports
/// (CSL JSON, BibTeX) are built from these references, so they hold exactly
/// what the page shows (ADR 0050).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CitationSummary {
    pub style: CitationStyle,
    pub locale: CitationLocale,
    pub citations: usize,
    pub notes: usize,
    pub references: Vec<PublicReference>,
    /// The prefix of every generated footnote label (`cite-`, or `cite2-`
    /// and so on when the author's own footnotes use `cite-`).
    pub prefix: String,
    /// Each citation in the text, in order, with its note and reference.
    pub placements: Vec<CitationPlacement>,
}

/// One citation as published: which note its marker points at, which
/// reference it cites and where in it (ADR 0059). Numbers are one-based and
/// follow order of first citation, as the notes do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CitationPlacement {
    /// Index into [`PublishedCitations::references`] plus one.
    pub reference: usize,
    /// The generated note (footnote number) the marker links to.
    pub note: usize,
    pub locators: Vec<PublicLocator>,
}

/// A post body with its citations published.
#[derive(Clone, Debug, PartialEq)]
pub struct PublishedCitations {
    /// The authored Markdown with each citation replaced by a footnote
    /// reference and the generated notes appended under one heading.
    pub markdown: String,
    /// The prefix of every generated footnote label, chosen so it never
    /// matches one of the author's own footnotes.
    pub prefix: String,
    /// Generated notes (or bibliography entries), numbered from 1.
    pub notes: usize,
    /// Citations in the body, each now a note marker.
    pub citations: usize,
    /// Each cited reference once, in order of first citation.
    pub references: Vec<PublicReference>,
    /// Each citation in the text, in order.
    pub placements: Vec<CitationPlacement>,
}

/// Publish the citations in a post's Markdown. `body_line` is the line of
/// the source file the body starts on, so guidance names file lines. Returns
/// `Ok(None)` when the body has no citation, so it is published unchanged.
/// `library` is called
/// only when there is something to resolve, so a post without citations never
/// reads the private library. Any problem (a malformed citation, an unknown
/// key, an ambiguous locator, a library that is missing or cannot be read)
/// refuses the whole post with guidance naming the line and key; nothing is
/// published half-resolved.
pub fn publish_citations<'l>(
    markdown: &str,
    body_line: usize,
    style: CitationStyle,
    locale: CitationLocale,
    supplements: bool,
    library: impl FnOnce() -> Result<Option<&'l SourceLibrary>, String>,
) -> Result<Option<PublishedCitations>, String> {
    let file_line = |line: usize| line + body_line.max(1) - 1;
    let scan = scan_citations(markdown);
    if !scan.diagnostics.is_empty() {
        return Err(guidance(&scan.diagnostics, file_line));
    }
    if scan.mentions.is_empty() {
        return Ok(None);
    }
    let library = library()?.ok_or_else(|| {
        format!(
            "line {}: this post cites sources but there is no source library; add the sources in Admin's Sources view, or remove `citations` from the front matter",
            file_line(scan.mentions[0].line)
        )
    })?;
    let resolved = resolve_citations(&scan.mentions, library);
    if !resolved.diagnostics.is_empty() {
        return Err(guidance(&resolved.diagnostics, file_line));
    }
    debug_assert_eq!(resolved.citations.len(), scan.mentions.len());

    let strings = locale.strings();
    let prefix = label_prefix(markdown, supplements);
    // Notes in order of first use: (reference number, locators).
    let mut notes: Vec<(usize, &[PublicLocator])> = Vec::new();
    let mut placements: Vec<CitationPlacement> = Vec::with_capacity(scan.mentions.len());
    let mut out = String::with_capacity(markdown.len() + 256);
    let mut cursor = 0;
    for (index, (mention, cited)) in scan.mentions.iter().zip(&resolved.citations).enumerate() {
        let note = match style {
            CitationStyle::Notes => {
                let key = (cited.number, cited.locators.as_slice());
                match notes.iter().position(|known| *known == key) {
                    Some(position) => position + 1,
                    None => {
                        notes.push(key);
                        notes.len()
                    }
                }
            }
            CitationStyle::Bibliography => cited.number,
        };
        placements.push(CitationPlacement {
            reference: cited.number,
            note,
            locators: cited.locators.clone(),
        });
        out.push_str(&markdown[cursor..mention.span.start]);
        out.push_str(&format!("[^{prefix}{note}]"));
        let mut ends_in_bracket = true;
        if style == CitationStyle::Bibliography && !cited.locators.is_empty() {
            out.push_str(&format!(
                " ({})",
                markdown_text(&locators_text(&cited.locators, strings))
            ));
            ends_in_bracket = false;
        }
        cursor = mention.span.end;
        // A `(`, `[` or `:` straight after the marker could join it into a
        // link or a definition; escaping it keeps the same rendered text.
        // The next citation starting here is itself a marker and is left be.
        let next_mention = scan.mentions.get(index + 1).map(|next| next.span.start);
        if ends_in_bracket
            && next_mention != Some(cursor)
            && matches!(markdown.as_bytes().get(cursor), Some(b'(' | b'[' | b':'))
        {
            out.push('\\');
        }
    }
    out.push_str(&markdown[cursor..]);
    let count = match style {
        CitationStyle::Notes => notes.len(),
        CitationStyle::Bibliography => resolved.references.len(),
    };

    if !out.ends_with('\n') {
        out.push('\n');
    }
    let heading = match style {
        CitationStyle::Notes => strings.notes,
        CitationStyle::Bibliography => strings.references,
    };
    out.push_str(&format!("\n## {heading}\n"));
    for number in 1..=count {
        let body = match style {
            CitationStyle::Notes => {
                let (reference, locators) = notes[number - 1];
                let mut body = reference_markdown(&resolved.references[reference - 1], strings);
                if !locators.is_empty() {
                    body.push_str(", ");
                    body.push_str(&markdown_text(&locators_text(locators, strings)));
                }
                body
            }
            CitationStyle::Bibliography => {
                reference_markdown(&resolved.references[number - 1], strings)
            }
        };
        let end = if body.ends_with('.') { "" } else { "." };
        out.push_str(&format!(
            "\n[^{prefix}{number}]: {}{end}\n",
            block_safe(&body)
        ));
    }

    check_published(&out, &prefix, scan.mentions.len(), count)?;
    Ok(Some(PublishedCitations {
        markdown: out,
        prefix,
        notes: count,
        citations: scan.mentions.len(),
        references: resolved.references,
        placements,
    }))
}

/// Source-scoped guidance for citation problems: line, key, what is wrong
/// and how to fix it. Messages name keys, kinds and lines only, never the
/// library's other records or any notebook text.
fn guidance(diagnostics: &[CitationDiagnostic], file_line: impl Fn(usize) -> usize) -> String {
    diagnostics
        .iter()
        .map(|found| {
            let mut text = String::new();
            if let Some(line) = found.line {
                text.push_str(&format!("line {}: ", file_line(line)));
            }
            if let Some(key) = &found.key {
                text.push_str(&format!("citation `{key}`: "));
            }
            let code = serde_json::to_value(found.code)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default();
            let repair = match found.code {
                CitationDiagnosticCode::UnknownKey => {
                    "add the source to the library or correct the key; write `\\[@` for literal text"
                }
                CitationDiagnosticCode::AmbiguousLocator => {
                    "cite the edition, translation or witness the pages belong to, or use a canonical locator"
                }
                CitationDiagnosticCode::TooLarge | CitationDiagnosticCode::TooManyCitations => {
                    "split the post"
                }
                _ => "correct the citation, or write `\\[@` for literal text",
            };
            text.push_str(&format!("{} ({code}); {repair}", found.message));
            text
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// A footnote label prefix whose generated ids nothing of the author's uses,
/// so generated notes and markers never collide with hand-written ones: no
/// footnote label and no heading id (a written `{#id}` or a generated slug,
/// such as `cite-1` for `## Cite 1`) is `<prefix><n>` or `<prefix><n>-ref-<k>`.
/// The author's footnote labels and heading ids are read with the renderer's
/// parser, and the raw text is searched too: an undefined `[^cite-1]` is plain
/// text to the parser, but a generated definition of that label would turn it
/// into a marker. Every comparison ignores case, as the parser matches labels.
/// Raw HTML `id`s are not avoided: reusing a generated id there is refused
/// when the page is checked, naming the id.
fn label_prefix(markdown: &str, supplements: bool) -> String {
    let mut taken: BTreeSet<String> =
        Parser::new_ext(markdown, crate::markdown::parser_options(false))
            .filter_map(|event| match event {
                Event::FootnoteReference(label) | Event::Start(Tag::FootnoteDefinition(label)) => {
                    Some(label.to_lowercase())
                }
                _ => None,
            })
            .collect();
    taken.extend(
        crate::markdown::heading_ids(markdown, supplements)
            .iter()
            .map(|id| id.to_lowercase()),
    );
    let text = markdown.to_lowercase();
    let digits = |rest: &str| !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit());
    // A generated note label (`<n>`) or marker id (`<n>-ref-<k>`) after the prefix.
    let generated = |rest: &str| {
        digits(rest)
            || rest
                .split_once("-ref-")
                .is_some_and(|(note, occurrence)| digits(note) && digits(occurrence))
    };
    let in_text = |prefix: &str| {
        let opening = format!("[^{prefix}");
        text.match_indices(&opening).any(|(at, _)| {
            let rest = &text[at + opening.len()..];
            rest.find(']').is_some_and(|close| digits(&rest[..close]))
        })
    };
    let mut prefix = String::from("cite-");
    let mut attempt = 2;
    while in_text(&prefix)
        || taken
            .iter()
            .any(|id| id.strip_prefix(&prefix).is_some_and(generated))
    {
        prefix = format!("cite{attempt}-");
        attempt += 1;
    }
    prefix
}

/// Confirm the published Markdown reads as intended: one generated marker per
/// citation and one generated note per number. An unclosed code block, HTML
/// block or comment at the end of a post would swallow the notes; that post
/// is refused rather than published with citations missing.
fn check_published(
    markdown: &str,
    prefix: &str,
    citations: usize,
    notes: usize,
) -> Result<(), String> {
    let labels = CitationNoteLabels {
        prefix,
        locale: CitationLocale::En,
    };
    let mut markers = 0;
    let mut defined = BTreeSet::new();
    for event in Parser::new_ext(markdown, crate::markdown::parser_options(false)) {
        match event {
            Event::FootnoteReference(label) if labels.number(&label).is_some() => markers += 1,
            Event::Start(Tag::FootnoteDefinition(label)) => {
                if let Some(number) = labels.number(&label) {
                    defined.insert(number);
                }
            }
            _ => {}
        }
    }
    if markers == citations
        && defined.len() == notes
        && defined.iter().all(|n| (1..=notes).contains(n))
    {
        Ok(())
    } else {
        Err("the citations could not be published as notes; close any code block, HTML block or comment left open at the end of the post".into())
    }
}

/// The locators of one citation as readers see them: `p. 514–520, 514a`.
fn locators_text(locators: &[PublicLocator], strings: &LocaleStrings) -> String {
    locators
        .iter()
        .map(|locator| {
            let range = match &locator.to {
                Some(to) => format!("{}\u{2013}{}", locator.value, to),
                None => locator.value.clone(),
            };
            let pick = |label: Label| {
                if locator.to.is_some() {
                    label.1
                } else {
                    label.0
                }
            };
            let label = match locator.kind.as_str() {
                "page" => Some(pick(strings.page).to_string()),
                "folio" => Some(pick(strings.folio).to_string()),
                "line" => Some(pick(strings.line).to_string()),
                "section" => Some(pick(strings.section).to_string()),
                "chapter" => Some(pick(strings.chapter).to_string()),
                "timestamp" => Some(strings.at.to_string()),
                "canonical" => None,
                other => {
                    let name = other
                        .strip_prefix("x-csl-")
                        .or_else(|| other.strip_prefix("x-"))
                        .unwrap_or(other);
                    Some(name.replace('-', " "))
                }
            };
            match label {
                Some(label) => format!("{label} {range}"),
                None => range,
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// A reference as escaped Markdown, without a final period: authors; title;
/// editors and translators; container; place and publisher; date; and each
/// publicly resolvable identifier, a DOI or web address as a link. Built only
/// from the [`PublicReference`] allowlist.
fn reference_markdown(reference: &PublicReference, strings: &LocaleStrings) -> String {
    let mut parts: Vec<String> = Vec::new();
    let names = |role: Option<&str>| -> Vec<&str> {
        reference
            .creators
            .iter()
            .filter(|creator| match role {
                None => matches!(creator.role.as_deref(), None | Some("author")),
                Some(role) => creator.role.as_deref() == Some(role),
            })
            .map(|creator| creator.name.as_str())
            .collect()
    };
    let authors = names(None);
    if !authors.is_empty() {
        parts.push(markdown_text(&authors.join("; ")));
    }
    if let Some(title) = &reference.title {
        parts.push(markdown_text(title));
    }
    for (role, label) in [
        ("editor", strings.editor),
        ("translator", strings.translator),
    ] {
        let named = names(Some(role));
        if !named.is_empty() {
            let label = if named.len() == 1 { label.0 } else { label.1 };
            parts.push(format!("{} ({label})", markdown_text(&named.join("; "))));
        }
    }
    if let Some(container) = reference.csl.get("container-title") {
        parts.push(markdown_text(container));
    }
    match (
        reference.csl.get("publisher-place"),
        reference.csl.get("publisher"),
    ) {
        (Some(place), Some(publisher)) => parts.push(format!(
            "{}: {}",
            markdown_text(place),
            markdown_text(publisher)
        )),
        (None, Some(publisher)) => parts.push(markdown_text(publisher)),
        (Some(place), None) => parts.push(markdown_text(place)),
        (None, None) => {}
    }
    if let Some(issued) = &reference.issued {
        parts.push(markdown_text(issued));
    }
    for (scheme, value) in &reference.identifiers {
        if !public_identifier(scheme, value) {
            continue;
        }
        if let Some(identifier) = identifier_markdown(scheme, value) {
            parts.push(identifier);
        }
    }
    if parts.is_empty() {
        markdown_text(&reference.key)
    } else {
        parts.join(". ")
    }
}

/// One public identifier as Markdown. A DOI links to its resolver, a web
/// address links to itself when it is a plain HTTP(S) address (never with
/// credentials), and other schemes are text.
fn identifier_markdown(scheme: &str, value: &str) -> Option<String> {
    match scheme {
        "doi" => {
            let name = markdown_text(&crate::research::doi_name(value));
            Some(match doi_link(value) {
                Some(destination) => format!("[doi:{name}]({destination})"),
                None => format!("doi:{name}"),
            })
        }
        "url" => {
            let address = safe_http_url(value)?;
            let destination = address
                .replace('\\', "%5C")
                .replace('(', "%28")
                .replace(')', "%29")
                .replace('<', "%3C")
                .replace('>', "%3E");
            Some(format!("[{}]({destination})", markdown_text(&address)))
        }
        "isbn" => Some(format!("ISBN {}", markdown_text(value))),
        "issn" => Some(format!("ISSN {}", markdown_text(value))),
        "pmid" => Some(format!("PMID {}", markdown_text(value))),
        "pmcid" => Some(format!("PMCID {}", markdown_text(value))),
        _ => None,
    }
}

/// A DOI's resolver address, whichever accepted form it is stored in (a bare
/// name, `doi:10.x/y`, or a `doi.org` or `dx.doi.org` address), or `None`
/// when the value is not a DOI.
pub(crate) fn doi_link(value: &str) -> Option<String> {
    crate::research::normalize_doi_url(value)
}

/// A web address, normalized, only when it is a plain HTTP(S) address with a
/// host and no credentials.
pub(crate) fn safe_http_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return None;
    }
    Some(url.as_str().to_string())
}

/// Untrusted text as inline Markdown that renders exactly as written: inner
/// whitespace collapsed, and every character Markdown could read as markup,
/// HTML or an entity escaped.
pub(crate) fn markdown_text(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut escaped = String::with_capacity(normalized.len());
    for character in normalized.chars() {
        if matches!(
            character,
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '&' | '|' | '~' | '!'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

/// A note body that cannot start a block of its own (a heading, list, quote
/// or rule) when it sits after `[^label]: `.
pub(crate) fn block_safe(body: &str) -> String {
    let digits = body.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && matches!(body.as_bytes().get(digits), Some(b'.' | b')')) {
        return format!("{}\\{}", &body[..digits], &body[digits..]);
    }
    match body.chars().next() {
        Some('#' | '-' | '+' | '=' | '>' | ':') => format!("\\{body}"),
        _ => body.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn styles_and_locales_read_from_front_matter() {
        assert_eq!(CitationStyle::from_front_matter(None), Ok(None));
        assert_eq!(CitationStyle::from_front_matter(Some("false")), Ok(None));
        assert_eq!(
            CitationStyle::from_front_matter(Some("Notes")),
            Ok(Some(CitationStyle::Notes))
        );
        assert_eq!(
            CitationStyle::from_front_matter(Some("bibliography")),
            Ok(Some(CitationStyle::Bibliography))
        );
        assert!(CitationStyle::from_front_matter(Some("apa")).is_err());
        for (value, style) in [
            ("yes", Some(CitationStyle::Notes)),
            ("On", Some(CitationStyle::Notes)),
            ("TRUE", Some(CitationStyle::Notes)),
            ("no", None),
            ("off", None),
            ("none", None),
        ] {
            assert_eq!(
                CitationStyle::from_front_matter(Some(value)),
                Ok(style),
                "{value}"
            );
        }
        assert_eq!(
            CitationLocale::for_post(None, "de-AT"),
            Ok(CitationLocale::De)
        );
        assert_eq!(CitationLocale::for_post(None, "ja"), Ok(CitationLocale::En));
        assert_eq!(
            CitationLocale::for_post(Some("fr-CA"), "en"),
            Ok(CitationLocale::Fr)
        );
        assert!(CitationLocale::for_post(Some("ja"), "en").is_err());
    }

    #[test]
    fn note_bodies_cannot_start_a_block_and_text_cannot_become_markup() {
        assert_eq!(block_safe("1984. Title"), "1984\\. Title");
        assert_eq!(block_safe("# Not a heading"), "\\# Not a heading");
        assert_eq!(block_safe("Plato"), "Plato");
        assert_eq!(
            markdown_text("<b>*bold*</b> &amp; [x](y)"),
            "\\<b\\>\\*bold\\*\\</b\\> \\&amp; \\[x\\](y)"
        );
    }

    #[test]
    fn generated_labels_avoid_the_authors_footnotes() {
        assert_eq!(label_prefix("Text[^1].\n\n[^1]: n\n", false), "cite-");
        assert_eq!(
            label_prefix("Text[^cite-1].\n\n[^cite-1]: n\n", false),
            "cite2-"
        );
        // An undefined label is plain text to the parser, but still taken.
        assert_eq!(label_prefix("Literal [^cite-1] text.\n", false), "cite2-");
        assert_eq!(label_prefix("Literal [^CITE-1] text.\n", false), "cite2-");
        assert_eq!(
            label_prefix("[^cite-1] and [^Cite2-3] text.\n", false),
            "cite3-"
        );
        assert_eq!(
            label_prefix("Not numbered [^cite-x] or [^cite-].\n", false),
            "cite-"
        );
        // A label that would be a generated marker id is taken too.
        assert_eq!(
            label_prefix("A[^cite-1-ref-1].\n\n[^cite-1-ref-1]: n\n", false),
            "cite2-"
        );
        let labels = CitationNoteLabels {
            prefix: "cite-",
            locale: CitationLocale::En,
        };
        assert_eq!(labels.number("cite-12"), Some(12));
        assert_eq!(labels.number("CITE-12"), Some(12));
        assert_eq!(labels.number("cite-01"), None);
        assert_eq!(labels.number("cite-x"), None);
        assert_eq!(labels.number("note"), None);
    }

    #[test]
    fn generated_labels_avoid_the_authors_heading_ids() {
        // A heading slug that is a generated note id or marker id.
        assert_eq!(label_prefix("## Cite 1\n\nText.\n", false), "cite2-");
        assert_eq!(label_prefix("## Cite 1 ref 2\n\nText.\n", false), "cite2-");
        // A slug made unique with a number is one too.
        assert_eq!(label_prefix("## Cite\n\n## Cite\n", false), "cite2-");
        // A written `{#id}`, in any case, and then the next prefix as well.
        assert_eq!(
            label_prefix("## Intro {#Cite-3}\n\n## Cite2 4\n", false),
            "cite3-"
        );
        // Slugs that only start like a generated id are not.
        for free in [
            "## Cite\n",
            "## Cite 1a\n",
            "## Cite 1 ref\n",
            "## Cite 1 ref 2 more\n",
        ] {
            assert_eq!(label_prefix(free, false), "cite-", "{free}");
        }
    }
}
