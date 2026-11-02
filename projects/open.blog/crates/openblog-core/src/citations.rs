//! Citations: how in-text pointers name a reference, how precisely they
//! locate a position in it, and how both meet CSL JSON.
//!
//! A [`Citation`] is the in-text pointer. Its key is a source-library
//! identifier (never a second identity), its [`Locator`]s are the notebook's
//! locators, and the **Reference** it points at stays a source-library record
//! (ADR 0042). Nothing here reads the private notebook: only the citation key,
//! its locators and the formatted reference are public (ADR 0044).
//!
//! Citations are an opt-in Markdown syntax, `[@key]` or
//! `[@key, page 514; canonical 514a to 520a]`. Plain CommonMark leaves that
//! text alone, so links, footnotes and every post that never calls
//! [`scan_citations`] behave exactly as before.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use pulldown_cmark::{Event, Parser, Tag, TagEnd};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::research_notes::{
    bidi_override, locator_ambiguity, resolved_kind, Locator, LocatorKind,
};
use crate::source_interchange::{
    derive_id, IDENTIFIER_FIELDS, NAME_ROLES, NOTE_FIELDS, PRESERVED_FIELDS,
};
use crate::source_library::{
    valid_source_id, valid_timestamp, SourceLibrary, SourceRecord, MAX_TEXT_CHARS,
};

/// Upper bound on Markdown scanned at once.
pub const MAX_CITED_MARKDOWN_BYTES: usize = 1024 * 1024;
/// Upper bound on citations in one document.
pub const MAX_CITATIONS: usize = 2_000;
/// Upper bound on locators in one citation, matching a notebook passage.
pub const MAX_CITATION_LOCATORS: usize = 8;
const MAX_LOCATOR_CHARS: usize = 200;
const KEY_MESSAGE: &str =
    "a citation key is a source identifier: a lowercase ASCII slug of at most 64 bytes";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CitationDiagnosticCode {
    TooLarge,
    TooManyCitations,
    MalformedCitation,
    InvalidKey,
    UnknownKey,
    UnknownLocatorKind,
    InvalidLocator,
    AmbiguousLocator,
    TooManyLocators,
}

/// A failure scoped to one citation. Messages name the key, a locator kind or
/// a line, and never repeat prose, excerpts or notes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CitationDiagnostic {
    pub code: CitationDiagnosticCode,
    /// One-based line of the citation, when it came from Markdown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub message: String,
}

/// One in-text pointer: a source-library identifier plus ordered locators.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Citation {
    pub key: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locators: Vec<Locator>,
}

/// A citation found in Markdown, with where it sits.
#[derive(Clone, Debug, PartialEq)]
pub struct CitationMention {
    pub citation: Citation,
    /// Byte range of the whole `[@...]` text.
    pub span: std::ops::Range<usize>,
    pub line: usize,
}

#[derive(Debug, Default, PartialEq)]
pub struct CitationScan {
    pub mentions: Vec<CitationMention>,
    pub diagnostics: Vec<CitationDiagnostic>,
}

fn diag(
    code: CitationDiagnosticCode,
    key: Option<&str>,
    message: impl Into<String>,
) -> CitationDiagnostic {
    CitationDiagnostic {
        code,
        line: None,
        key: key.map(str::to_string),
        message: message.into(),
    }
}

fn locator_diag(key: &str, message: impl Into<String>) -> CitationDiagnostic {
    diag(CitationDiagnosticCode::InvalidLocator, Some(key), message)
}

/// Parse the text between `[@` and `]`, or return why it is not a citation.
pub fn parse_citation(inner: &str) -> Result<Citation, CitationDiagnostic> {
    let (key, rest) = match inner.split_once(',') {
        Some((key, rest)) => (key.trim(), Some(rest)),
        None => (inner.trim(), None),
    };
    if !valid_source_id(key) {
        return Err(diag(CitationDiagnosticCode::InvalidKey, None, KEY_MESSAGE));
    }
    let mut locators = Vec::new();
    if let Some(rest) = rest {
        for part in rest.split(';') {
            if locators.len() == MAX_CITATION_LOCATORS {
                return Err(too_many_locators(key));
            }
            locators.push(parse_locator_text(key, part)?);
        }
    }
    Ok(Citation {
        key: key.into(),
        locators,
    })
}

fn too_many_locators(key: &str) -> CitationDiagnostic {
    diag(
        CitationDiagnosticCode::TooManyLocators,
        Some(key),
        format!("a citation may carry at most {MAX_CITATION_LOCATORS} locators"),
    )
}

fn parse_locator_text(key: &str, part: &str) -> Result<Locator, CitationDiagnostic> {
    let (kind_text, rest) = part
        .trim()
        .split_once(char::is_whitespace)
        .ok_or_else(|| locator_diag(key, "write a locator as `kind value`, such as `page 514`"))?;
    let kind = LocatorKind::parse(kind_text).ok_or_else(|| {
        diag(
            CitationDiagnosticCode::UnknownLocatorKind,
            Some(key),
            "use page, folio, line, section, chapter, canonical, timestamp, or an `x-` extension kind",
        )
    })?;
    let rest = rest.trim();
    let (value, to) = match rest.split_once(" to ") {
        Some((value, to)) => (value.trim(), Some(to.trim())),
        None => (rest, None),
    };
    let locator = Locator {
        kind,
        value: value.into(),
        to: to.map(str::to_string),
        extra: BTreeMap::new(),
    };
    check_locator(&locator).map_err(|message| locator_diag(key, message))?;
    Ok(locator)
}

/// Shape rules for a locator in a citation: the notebook's limits plus the
/// characters the Markdown syntax reserves, so every accepted citation
/// formats back to text that scans to the same citation. Media moments use
/// the same rules (ADR 0062), so a moment's locators can be cited unchanged.
pub(crate) fn check_locator(locator: &Locator) -> Result<(), String> {
    let texts = std::iter::once(("value", locator.value.as_str()))
        .chain(locator.to.as_deref().map(|to| ("end", to)));
    for (name, text) in texts {
        if text.is_empty() || text.trim() != text {
            return Err(format!(
                "the locator {name} must be text without surrounding spaces"
            ));
        }
        if text.chars().count() > MAX_LOCATOR_CHARS {
            return Err(format!(
                "the locator {name} may be at most {MAX_LOCATOR_CHARS} characters"
            ));
        }
        if text
            .chars()
            .any(|c| c.is_control() || bidi_override(c) || matches!(c, ';' | '[' | ']'))
            || text.contains(" to ")
        {
            return Err(format!(
                "the locator {name} may not contain control or bidirectional override characters, `;`, brackets or ` to `"
            ));
        }
        if locator.kind == LocatorKind::Timestamp && !valid_timestamp(text) {
            return Err("use seconds or `h:mm:ss` for a timestamp".into());
        }
    }
    Ok(())
}

/// The canonical Markdown for a citation, which [`parse_citation`] reads back
/// to the same citation. Refuses a citation the syntax cannot carry.
pub fn format_citation(citation: &Citation) -> Result<String, CitationDiagnostic> {
    if !valid_source_id(&citation.key) {
        return Err(diag(CitationDiagnosticCode::InvalidKey, None, KEY_MESSAGE));
    }
    if citation.locators.len() > MAX_CITATION_LOCATORS {
        return Err(too_many_locators(&citation.key));
    }
    let mut text = format!("[@{}", citation.key);
    for (position, locator) in citation.locators.iter().enumerate() {
        check_locator(locator).map_err(|message| locator_diag(&citation.key, message))?;
        text.push_str(if position == 0 { ", " } else { "; " });
        text.push_str(locator.kind.as_str());
        text.push(' ');
        text.push_str(&locator.value);
        if let Some(to) = &locator.to {
            text.push_str(" to ");
            text.push_str(to);
        }
    }
    text.push(']');
    Ok(text)
}

/// Find citations in Markdown, reading it with the renderer's own parser so
/// the scanner and the renderer always agree on what is text. Code blocks,
/// code spans, raw HTML and comments, links and images (including a
/// `[@key]` that a reference definition turns into a link), reference
/// definitions and footnotes are not citations, and neither is a bracket
/// written as `\[`. A bracket that starts like a citation but is malformed is
/// reported and left as text.
pub fn scan_citations(markdown: &str) -> CitationScan {
    let mut scanner = Scanner {
        markdown,
        line_starts: std::iter::once(0)
            .chain(markdown.match_indices('\n').map(|(at, _)| at + 1))
            .collect(),
        defined: BTreeSet::new(),
        scan: CitationScan::default(),
        full: false,
    };
    if markdown.len() > MAX_CITED_MARKDOWN_BYTES {
        scanner.scan.diagnostics.push(diag(
            CitationDiagnosticCode::TooLarge,
            None,
            format!("Markdown with citations may be at most {MAX_CITED_MARKDOWN_BYTES} bytes"),
        ));
        return scanner.scan;
    }
    let parser = Parser::new_ext(markdown, crate::markdown::parser_options(false));
    scanner.defined = parser
        .reference_definitions()
        .iter()
        .map(|(label, _)| reference_label(label))
        .collect();
    let mut run: Vec<TextChar> = Vec::new();
    let mut run_end: Option<usize> = None;
    let mut opaque = 0usize;
    for (event, range) in parser.into_offset_iter() {
        if scanner.full {
            break;
        }
        match &event {
            Event::Start(Tag::CodeBlock(_) | Tag::Link { .. } | Tag::Image { .. }) => opaque += 1,
            Event::End(TagEnd::CodeBlock | TagEnd::Link | TagEnd::Image) => {
                opaque = opaque.saturating_sub(1);
            }
            Event::Text(text) if opaque == 0 => {
                let escape_gap =
                    |end: usize| end + 1 == range.start && markdown.as_bytes()[end] == BACKSLASH;
                if !run_end.is_some_and(|end| end == range.start || escape_gap(end)) {
                    scanner.scan_run(&run);
                    run.clear();
                }
                push_text(markdown, text, range.clone(), run_end, &mut run);
                run_end = Some(range.end);
                continue;
            }
            _ => {}
        }
        scanner.scan_run(&run);
        run.clear();
        run_end = None;
    }
    scanner.scan_run(&run);
    scanner.scan
}

const BACKSLASH: u8 = 0x5c;

/// One character of text as the renderer will show it, with the source bytes
/// it came from. A `literal` character came from a backslash escape or an
/// entity, which Markdown never reads as structure.
struct TextChar {
    ch: char,
    start: usize,
    end: usize,
    literal: bool,
}

fn push_text(
    markdown: &str,
    text: &str,
    range: Range<usize>,
    previous_end: Option<usize>,
    run: &mut Vec<TextChar>,
) {
    if markdown.get(range.clone()) != Some(text) {
        // An entity: its characters are literal and share its source bytes.
        run.extend(text.chars().map(|ch| TextChar {
            ch,
            start: range.start,
            end: range.end,
            literal: true,
        }));
        return;
    }
    // The parser leaves an escaping backslash out of every text range, so a
    // backslash just before this text that no earlier text covered escapes
    // its first character.
    let escaped = range.start > 0
        && markdown.as_bytes()[range.start - 1] == BACKSLASH
        && previous_end != Some(range.start);
    run.extend(text.char_indices().map(|(at, ch)| TextChar {
        ch,
        start: range.start + at,
        end: range.start + at + ch.len_utf8(),
        literal: at == 0 && escaped,
    }));
}

/// A reference label as CommonMark matches it: case-folded with inner
/// whitespace collapsed.
fn reference_label(label: &str) -> String {
    label
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

struct Scanner<'a> {
    markdown: &'a str,
    line_starts: Vec<usize>,
    defined: BTreeSet<String>,
    scan: CitationScan,
    full: bool,
}

impl Scanner<'_> {
    fn line(&self, offset: usize) -> usize {
        self.line_starts.partition_point(|start| *start <= offset)
    }

    fn report(&mut self, mut found: CitationDiagnostic, offset: usize) {
        found.line = Some(self.line(offset));
        self.scan.diagnostics.push(found);
    }

    /// Find citations in one run of plain text: text with no formatting, code,
    /// HTML or line break inside it.
    fn scan_run(&mut self, run: &[TextChar]) {
        let mut i = 0;
        while i + 1 < run.len() && !self.full {
            let open = &run[i];
            if open.ch != '[' || open.literal || run[i + 1].ch != '@' || run[i + 1].literal {
                i += 1;
                continue;
            }
            let close = run[i + 2..]
                .iter()
                .position(|c| !c.literal && matches!(c.ch, '[' | ']'))
                .map(|at| at + i + 2);
            let Some(close) = close else {
                let message =
                    "a citation must end with `]` on the same line, with no formatting inside it";
                self.report(
                    diag(CitationDiagnosticCode::MalformedCitation, None, message),
                    open.start,
                );
                return;
            };
            if run[close].ch == '[' {
                let message = "a citation cannot contain `[`";
                self.report(
                    diag(CitationDiagnosticCode::MalformedCitation, None, message),
                    open.start,
                );
                i += 2;
                continue;
            }
            let label = &self.markdown[open.end..run[close].start];
            if self.defined.contains(&reference_label(label)) {
                i = close + 1;
                continue;
            }
            let inner: String = run[i + 2..close].iter().map(|c| c.ch).collect();
            match parse_citation(&inner) {
                Ok(citation) => {
                    let line = self.line(open.start);
                    self.scan.mentions.push(CitationMention {
                        citation,
                        span: open.start..run[close].end,
                        line,
                    });
                    if self.scan.mentions.len() > MAX_CITATIONS {
                        self.scan.mentions.truncate(MAX_CITATIONS);
                        let limit = diag(
                            CitationDiagnosticCode::TooManyCitations,
                            None,
                            format!("a document may hold at most {MAX_CITATIONS} citations"),
                        );
                        self.report(limit, open.start);
                        self.full = true;
                    }
                }
                Err(found) => self.report(found, open.start),
            }
            i = close + 1;
        }
    }
}

/// The public face of a reference: bibliographic description only. It is
/// built from an explicit allowlist, so unknown source fields, the archived
/// flag, relationships and anything notebook-side cannot appear in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicReference {
    pub key: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub creators: Vec<PublicCreator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issued: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// `(scheme, value)` pairs such as `("doi", "10.1000/x")`, for the
    /// publicly resolvable schemes only; see [`public_identifier`].
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub identifiers: Vec<(String, String)>,
    /// Allowlisted CSL variables such as `publisher` or `container-title`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub csl: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicCreator {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

/// Whether an identifier may be published. Only the standard, publicly
/// resolvable schemes CSL interchange knows (DOI, ISBN, ISSN, URL, PMID,
/// PMCID) are; the library validates DOI, ISBN, ISSN and URL values, and PMID
/// and PMCID are checked for shape here. Any other scheme is free-form author
/// data, such as a local path or a private catalogue number, and stays private.
pub fn public_identifier(scheme: &str, value: &str) -> bool {
    let digits = |text: &str| {
        !text.is_empty() && text.len() <= 12 && text.bytes().all(|b| b.is_ascii_digit())
    };
    match scheme {
        "pmid" => digits(value),
        "pmcid" => value.strip_prefix("PMC").is_some_and(digits),
        _ => IDENTIFIER_FIELDS.iter().any(|(known, _)| *known == scheme),
    }
}

/// Why a web address may not be published, or `None` when it may (#63,
/// ADR 0125): only a plain `http` or `https` address a reader can reach,
/// without credentials, naming a public host and carrying no query parameter
/// that is named like a secret. The library already refuses other schemes and
/// credentials; the boundary also withholds addresses on a private network
/// (`localhost`, `localhost.localdomain`, `.local`, `.internal`, `.corp`,
/// `.test`, `.home`, loopback, private, link-local, site-local, benchmarking,
/// multicast, reserved and NAT64 IP ranges, and an IPv4 address written in
/// decimal, octal, hex, as a mapped or compatible IPv6 address or inside a
/// 6to4 one) and signed or
/// tokened addresses, which would expose an intranet or
/// an access key. Only the address is withheld; the rest of the reference is
/// published.
pub fn public_url_problem(value: &str) -> Option<&'static str> {
    let Ok(url) = url::Url::parse(value.trim()) else {
        return Some("it is not a web address");
    };
    if !matches!(url.scheme(), "http" | "https") {
        return Some("only http and https addresses are published");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Some("it carries a user name or password");
    }
    let private_host = match url.host() {
        None => true,
        Some(url::Host::Ipv4(ip)) => private_ipv4(ip),
        Some(url::Host::Ipv6(ip)) => {
            let segments = ip.segments();
            let first = segments[0];
            let embedded = |high: u16, low: u16| {
                let [a, b] = high.to_be_bytes();
                let [c, d] = low.to_be_bytes();
                private_ipv4(std::net::Ipv4Addr::new(a, b, c, d))
            };
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.to_ipv4_mapped().is_some_and(private_ipv4)
                // The deprecated IPv4-compatible form `::a.b.c.d` embeds one too.
                || (segments[..6] == [0; 6] && embedded(segments[6], segments[7]))
                // 6to4, 2002::/16, carries its IPv4 address in the next 32 bits.
                || (first == 0x2002 && embedded(segments[1], segments[2]))
                // Multicast, ff00::/8.
                || (first & 0xff00) == 0xff00
                // The NAT64 prefix 64:ff9b::/96 embeds any IPv4 address.
                || (segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0])
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                // Deprecated site-local addresses, fec0::/10.
                || (first & 0xffc0) == 0xfec0
        }
        Some(url::Host::Domain(domain)) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            !domain.contains('.')
                || domain == "localhost.localdomain"
                || [
                    ".localhost",
                    ".localhost.localdomain",
                    ".local",
                    ".internal",
                    ".lan",
                    ".home.arpa",
                    ".intranet",
                    ".corp",
                    ".test",
                    ".home",
                    ".localdomain",
                ]
                .iter()
                .any(|suffix| domain.ends_with(suffix))
        }
    };
    if private_host {
        return Some("it names a private or local network address readers cannot reach");
    }
    // The query, and a fragment written as `name=value` pairs, as the
    // single-page apps that read a token from the fragment write it. A
    // fragment with no `=` is a heading anchor (`#Authorship`), not a pair.
    if url.query_pairs().any(|(name, _)| secret_parameter(&name)) {
        return Some("it carries a query parameter named like a key, token or signature");
    }
    let fragment = url.fragment().unwrap_or_default();
    if fragment.contains('=')
        && url::form_urlencoded::parse(fragment.as_bytes()).any(|(name, _)| secret_parameter(&name))
    {
        return Some("it carries a fragment parameter named like a key, token or signature");
    }
    None
}

fn private_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        // Benchmarking, 198.18.0.0/15.
        || (a == 198 && (18..=19).contains(&b))
        // Multicast, 224.0.0.0/4, and reserved, 240.0.0.0/4.
        || a >= 224
}

/// Whether a query or fragment parameter is named like a secret. The name is
/// split into words at `_`, `-`, any other punctuation and camelCase
/// (`X-Amz-Signature`, `access_token` and `apiKey` read as their words), and
/// is secret when a word names one: `token`, `secret`, `password`, `sig`,
/// `signature`, `credential`, `auth`, `session`, and `key` alone or after
/// `api`, `access`, `secret` and the like. A few exact compounds written as one
/// word (`apikey`, `accesstoken`) are secret too. Words are matched whole, so
/// `author`, `authors`, `siglum`, `sigla`, `sortKey`, `monkey`, `design`,
/// `passage` and `keyword` are published. `sid`, which OpenURL uses to name the
/// referring database, is not a secret and is published.
fn secret_parameter(name: &str) -> bool {
    const SECRET_WORDS: &[&str] = &[
        "token",
        "secret",
        "password",
        "passwd",
        "pass",
        "pwd",
        "sig",
        "signature",
        "credential",
        "credentials",
        "auth",
        "authorization",
        "session",
        "jwt",
        "bearer",
    ];
    // `key` is secret alone or when one of these says what it opens.
    const KEY_OWNERS: &[&str] = &[
        "api",
        "access",
        "secret",
        "private",
        "auth",
        "license",
        "licence",
        "client",
        "app",
        "subscription",
        "signing",
        "encryption",
        "master",
    ];
    const COMPOUNDS: &[&str] = &[
        "apikey",
        "xapikey",
        "appkey",
        "accesskey",
        "awsaccesskeyid",
        "secretkey",
        "privatekey",
        "authkey",
        "licensekey",
        "clientkey",
        "signingkey",
        "accesstoken",
        "authtoken",
        "idtoken",
        "refreshtoken",
        "sessiontoken",
        "sessionid",
        "bearertoken",
        "xamzsignature",
        "xamzcredential",
        "xamzsecuritytoken",
        "clientsecret",
        "apisecret",
        "apitoken",
    ];
    let words = parameter_words(name);
    let joined: String = words.concat();
    if joined == "key" || COMPOUNDS.contains(&joined.as_str()) {
        return true;
    }
    words.iter().enumerate().any(|(index, word)| {
        SECRET_WORDS.contains(&word.as_str())
            || COMPOUNDS.contains(&word.as_str())
            || (word == "key" && index > 0 && KEY_OWNERS.contains(&words[index - 1].as_str()))
    })
}

/// The lower-cased words of a parameter name, split at anything that is not a
/// letter or digit and at camelCase boundaries (`apiKey`, `APIKey`).
fn parameter_words(name: &str) -> Vec<String> {
    let chars: Vec<char> = name.chars().collect();
    let mut words = Vec::new();
    let mut word = String::new();
    for (index, &c) in chars.iter().enumerate() {
        if !c.is_ascii_alphanumeric() {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            continue;
        }
        let boundary = c.is_ascii_uppercase()
            && !word.is_empty()
            && (chars[index - 1].is_ascii_lowercase()
                || chars[index - 1].is_ascii_digit()
                || chars.get(index + 1).is_some_and(char::is_ascii_lowercase)
                    && chars[index - 1].is_ascii_uppercase());
        if boundary {
            words.push(std::mem::take(&mut word));
        }
        word.push(c.to_ascii_lowercase());
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

/// Whether an identifier of a record is published: a public scheme, and for
/// a web address one [`public_url_problem`] accepts.
pub fn published_identifier(scheme: &str, value: &str) -> bool {
    public_identifier(scheme, value) && (scheme != "url" || public_url_problem(value).is_none())
}

pub fn public_reference(record: &SourceRecord) -> PublicReference {
    let mut csl = BTreeMap::new();
    if let Some(Value::Object(bag)) = record.extra.get("csl") {
        for (name, value) in bag {
            if name != "type" && !PRESERVED_FIELDS.contains(&name.as_str()) {
                continue;
            }
            match value {
                Value::String(text) => {
                    csl.insert(name.clone(), text.clone());
                }
                Value::Number(number) => {
                    csl.insert(name.clone(), number.to_string());
                }
                _ => {}
            }
        }
    }
    PublicReference {
        key: record.id.clone(),
        kind: record.kind.as_str(),
        title: record.title.clone(),
        creators: record
            .creators
            .iter()
            .map(|creator| PublicCreator {
                name: creator.name.clone(),
                role: creator.role.clone(),
            })
            .collect(),
        issued: record.issued.clone(),
        language: record.language.clone(),
        identifiers: record
            .identifiers
            .iter()
            .filter(|identifier| published_identifier(&identifier.scheme, &identifier.value))
            .map(|identifier| (identifier.scheme.clone(), identifier.value.clone()))
            .collect(),
        csl,
    }
}

/// A plain-text reference, deterministic and style-free. It is the fallback
/// when no CSL processor runs; rendering CSL styles is out of scope.
pub fn format_reference(reference: &PublicReference) -> String {
    let mut parts: Vec<String> = Vec::new();
    let names: Vec<&str> = reference
        .creators
        .iter()
        .filter(|c| matches!(c.role.as_deref(), None | Some("author")))
        .map(|c| c.name.as_str())
        .collect();
    if !names.is_empty() {
        parts.push(names.join("; "));
    }
    parts.extend(reference.title.clone());
    parts.extend(reference.csl.get("container-title").cloned());
    parts.extend(reference.csl.get("publisher").cloned());
    parts.extend(reference.issued.clone());
    if let Some((scheme, value)) = reference
        .identifiers
        .iter()
        .find(|(scheme, value)| public_identifier(scheme, value))
    {
        parts.push(format!("{scheme}:{value}"));
    }
    if parts.is_empty() {
        reference.key.clone()
    } else {
        parts.join(". ")
    }
}

/// A locator in its public form: kind, value and optional end, and nothing
/// else. A notebook [`Locator`] keeps unknown fields for lossless editing;
/// this type has no room for them, so they cannot reach a public artifact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicLocator {
    pub kind: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

impl From<&Locator> for PublicLocator {
    fn from(locator: &Locator) -> Self {
        Self {
            kind: locator.kind.as_str().into(),
            value: locator.value.clone(),
            to: locator.to.clone(),
        }
    }
}

fn public_locators(locators: &[Locator]) -> Vec<PublicLocator> {
    locators.iter().map(PublicLocator::from).collect()
}

/// A citation in its public form.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PublicCitation {
    pub key: String,
    /// One-based number of the reference in order of first citation.
    pub number: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locators: Vec<PublicLocator>,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct ResolvedCitations {
    pub citations: Vec<PublicCitation>,
    /// Each cited reference once, in order of first citation.
    pub references: Vec<PublicReference>,
    pub diagnostics: Vec<CitationDiagnostic>,
}

/// Resolve citations against the source library only. A citation with an
/// unknown key or an ambiguous locator is reported and left out; the rest
/// still resolve. The private notebook is not an input.
pub fn resolve_citations(
    mentions: &[CitationMention],
    library: &SourceLibrary,
) -> ResolvedCitations {
    let mut out = ResolvedCitations::default();
    let mut numbers: BTreeMap<&str, usize> = BTreeMap::new();
    for mention in mentions {
        let citation = &mention.citation;
        let Some(record) = library.get(&citation.key) else {
            let mut found = diag(
                CitationDiagnosticCode::UnknownKey,
                Some(&citation.key),
                format!("no source in the library has the id `{}`", citation.key),
            );
            found.line = Some(mention.line);
            out.diagnostics.push(found);
            continue;
        };
        let target = resolved_kind(library, &citation.key);
        let ambiguous = citation
            .locators
            .iter()
            .find_map(|locator| locator_ambiguity(target, &citation.key, locator));
        if let Some(message) = ambiguous {
            let mut found = diag(
                CitationDiagnosticCode::AmbiguousLocator,
                Some(&citation.key),
                message.replace("the passage", "the citation"),
            );
            found.line = Some(mention.line);
            out.diagnostics.push(found);
            continue;
        }
        let next = numbers.len() + 1;
        let number = *numbers.entry(record.id.as_str()).or_insert_with(|| {
            out.references.push(public_reference(record));
            next
        });
        out.citations.push(PublicCitation {
            key: citation.key.clone(),
            number,
            locators: public_locators(&citation.locators),
        });
    }
    out
}

/// Read a citation an editor built from parts: `{"key": "...", "locators":
/// [{"kind": "page", "value": "514", "to": "520"}]}`. Only `kind`, `value`
/// and `to` are read from a locator, so fields a notebook locator carries
/// (or anything else a client sends) are never copied into the citation.
pub fn citation_from_parts(value: &Value) -> Result<Citation, CitationDiagnostic> {
    let key = match value.get("key") {
        Some(Value::String(key)) if valid_source_id(key) => key.clone(),
        _ => return Err(diag(CitationDiagnosticCode::InvalidKey, None, KEY_MESSAGE)),
    };
    let none = Vec::new();
    let list = match value.get("locators") {
        None | Some(Value::Null) => &none,
        Some(Value::Array(list)) => list,
        Some(_) => return Err(locator_diag(&key, "locators must be a list")),
    };
    if list.len() > MAX_CITATION_LOCATORS {
        return Err(too_many_locators(&key));
    }
    let mut locators = Vec::with_capacity(list.len());
    for entry in list {
        let kind = entry
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let kind = LocatorKind::parse(kind).ok_or_else(|| {
            diag(
                CitationDiagnosticCode::UnknownLocatorKind,
                Some(&key),
                "use page, folio, line, section, chapter, canonical, timestamp, or an `x-` extension kind",
            )
        })?;
        let text = |name: &str| match entry.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.clone())),
            Some(_) => Err(locator_diag(
                &key,
                format!("the locator {name} must be text"),
            )),
        };
        let locator = Locator {
            kind,
            value: text("value")?.unwrap_or_default(),
            to: text("to")?.filter(|to| !to.is_empty()),
            extra: BTreeMap::new(),
        };
        check_locator(&locator).map_err(|message| locator_diag(&key, message))?;
        locators.push(locator);
    }
    Ok(Citation { key, locators })
}

/// A citation that resolves against the library, with the Markdown that
/// writes it and the reference it points at.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CheckedCitation {
    /// The canonical `[@key, ...]` text, which scans back to this citation.
    pub markdown: String,
    pub key: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locators: Vec<PublicLocator>,
    pub reference: PublicReference,
    /// The plain-text rendering of the reference.
    pub formatted: String,
}

/// Check a citation the way a build will read it: write it as Markdown, scan
/// that Markdown back, and resolve the result against the source library.
/// Any step that fails is reported for this one citation; nothing is written.
pub fn check_citation(
    citation: &Citation,
    library: &SourceLibrary,
) -> Result<CheckedCitation, Vec<CitationDiagnostic>> {
    let markdown = format_citation(citation).map_err(|found| vec![found])?;
    let scan = scan_citations(&markdown);
    let reads_back = scan.diagnostics.is_empty()
        && scan.mentions.len() == 1
        && scan.mentions[0].span == (0..markdown.len())
        && scan.mentions[0].citation == *citation;
    if !reads_back {
        return Err(vec![diag(
            CitationDiagnosticCode::MalformedCitation,
            Some(&citation.key),
            "this citation cannot be written as Markdown that reads back the same",
        )]);
    }
    let mut resolved = resolve_citations(&scan.mentions, library);
    if !resolved.diagnostics.is_empty() {
        for found in &mut resolved.diagnostics {
            found.line = None;
        }
        return Err(resolved.diagnostics);
    }
    let reference = resolved.references.remove(0);
    Ok(CheckedCitation {
        formatted: format_reference(&reference),
        markdown,
        key: citation.key.clone(),
        locators: public_locators(&citation.locators),
        reference,
    })
}

/// What CSL interchange does with a CSL variable (ADR 0046).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CslFate {
    /// Mapped to a source-library field and rebuilt on export.
    Stored,
    /// Kept as text or a number under the record's `csl` field, verbatim.
    Preserved,
    /// Never stored, so it cannot reach a public artifact.
    PrivateDropped,
    /// Not stored; an import plan reports it as unsupported.
    Unsupported,
}

pub fn csl_field_fate(name: &str) -> CslFate {
    let stored = matches!(name, "id" | "title" | "language" | "issued" | "custom")
        || NAME_ROLES.contains(&name)
        || IDENTIFIER_FIELDS.iter().any(|(_, csl)| *csl == name);
    if stored {
        CslFate::Stored
    } else if name == "type" || PRESERVED_FIELDS.contains(&name) {
        CslFate::Preserved
    } else if NOTE_FIELDS.contains(&name) {
        CslFate::PrivateDropped
    } else {
        CslFate::Unsupported
    }
}

/// CSL locator labels that name the same thing as a locator kind.
const CSL_LABELS: [&str; 6] = ["page", "folio", "line", "section", "chapter", "timestamp"];
const OPENBLOG_LOCATORS: &str = "openblog-locators";
/// Prefix of the extension kind that keeps a CSL label with no kind of its own.
const CSL_EXTENSION_PREFIX: &str = "x-csl-";
/// Legacy CSL label spellings and the current schema's spelling. CSL 1.0.1
/// wrote `sub verbo`; the current schema writes `sub-verbo`. Import accepts
/// the legacy spelling and reports the respelling; export writes the current.
const CSL_LEGACY_LABELS: [(&str, &str); 1] = [("sub verbo", "sub-verbo")];

/// The CSL label a kind exports as: its own name for a kind CSL shares, the
/// kept label for an `x-csl-` kind, and none for any other kind.
fn csl_label(kind: &LocatorKind) -> Option<String> {
    let name = kind.as_str();
    if CSL_LABELS.contains(&name) {
        return Some(name.into());
    }
    name.strip_prefix(CSL_EXTENSION_PREFIX)
        .filter(|kept| !kept.is_empty())
        .map(str::to_string)
}

/// How a CSL label had to change to become a kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LabelRespelling {
    None,
    /// A legacy spelling, replaced by the current schema's.
    Legacy(&'static str),
    /// An unlisted label with spaces, kept with hyphens.
    Hyphenated,
}

/// The kind a CSL label imports as, and how the label was respelled to fit.
fn kind_for_csl_label(label: &str) -> Option<(LocatorKind, LabelRespelling)> {
    if CSL_LABELS.contains(&label) {
        return LocatorKind::parse(label).map(|kind| (kind, LabelRespelling::None));
    }
    if let Some((_, current)) = CSL_LEGACY_LABELS
        .iter()
        .find(|(legacy, _)| *legacy == label)
    {
        return LocatorKind::parse(&format!("{CSL_EXTENSION_PREFIX}{current}"))
            .map(|kind| (kind, LabelRespelling::Legacy(current)));
    }
    let hyphenated = label.split(' ').collect::<Vec<_>>().join("-");
    let respelling = if hyphenated == label {
        LabelRespelling::None
    } else {
        LabelRespelling::Hyphenated
    };
    LocatorKind::parse(&format!("{CSL_EXTENSION_PREFIX}{hyphenated}"))
        .map(|kind| (kind, respelling))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CitationLoss {
    pub field: String,
    pub reason: String,
}

fn flat_range(locator: &Locator) -> String {
    match &locator.to {
        Some(to) => format!("{}\u{2013}{}", locator.value, to),
        None => locator.value.clone(),
    }
}

/// A CSL JSON citation item for a citation. The first locator is expressed in
/// CSL's `label` and `locator`; whatever CSL cannot carry (further locators,
/// kinds with no CSL label, the range structure) is reported as a loss and
/// kept in `openblog-locators`, which CSL processors ignore and
/// [`citation_from_csl_item`] restores.
pub fn citation_to_csl_item(citation: &Citation) -> (Value, Vec<CitationLoss>) {
    let mut item = Map::new();
    item.insert("id".into(), Value::String(citation.key.clone()));
    let mut losses = Vec::new();
    if let Some(first) = citation.locators.first() {
        if let Some(label) = csl_label(&first.kind) {
            item.insert("label".into(), label.into());
            item.insert("locator".into(), Value::String(flat_range(first)));
            if first.to.is_some() {
                losses.push(CitationLoss {
                    field: "locator".into(),
                    reason: "a range is written as one text; its start and end are kept in openblog-locators".into(),
                });
            }
        } else {
            losses.push(CitationLoss {
                field: "label".into(),
                reason: format!("CSL has no locator label for `{}`", first.kind.as_str()),
            });
        }
        if citation.locators.len() > 1 {
            losses.push(CitationLoss {
                field: "locator".into(),
                reason: "CSL carries one locator; the others are kept in openblog-locators".into(),
            });
        }
        item.insert(
            OPENBLOG_LOCATORS.into(),
            serde_json::to_value(public_locators(&citation.locators)).unwrap_or_else(|_| json!([])),
        );
    }
    (Value::Object(item), losses)
}

/// Read a CSL JSON citation item. `openblog-locators` is used when its first
/// locator still agrees with CSL's own `label` and `locator`; otherwise CSL's
/// fields win and the disagreement is reported. Unknown labels are kept as
/// `x-csl-` extension kinds. Fields with no home (prefix, suffix, embedded
/// item data, ...) are reported, never stored.
pub fn citation_from_csl_item(
    item: &Value,
) -> Result<(Citation, Vec<CitationLoss>), CitationDiagnostic> {
    let Value::Object(item) = item else {
        return Err(diag(
            CitationDiagnosticCode::MalformedCitation,
            None,
            "a CSL citation item must be an object",
        ));
    };
    // The same normalisation a reference import applies (ADR 0012), so an
    // item names the source its reference was imported as.
    let raw_id = match item.get("id") {
        Some(Value::String(id)) if !id.trim().is_empty() => id.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    };
    if raw_id.is_empty()
        || raw_id.chars().count() > MAX_TEXT_CHARS
        || raw_id.chars().any(char::is_control)
    {
        return Err(diag(
            CitationDiagnosticCode::InvalidKey,
            None,
            "the CSL item needs a short text id without control characters",
        ));
    }
    let key = derive_id(&raw_id);
    let mut losses: Vec<CitationLoss> = item
        .keys()
        .filter(|name| {
            !matches!(
                name.as_str(),
                "id" | "label" | "locator" | OPENBLOG_LOCATORS
            )
        })
        .map(|name| CitationLoss {
            field: name.clone(),
            reason: "citations store a key and locators only".into(),
        })
        .collect();
    if key != raw_id {
        losses.push(CitationLoss {
            field: "id".into(),
            reason: format!(
                "normalised to the source identifier `{key}`, as reference import does"
            ),
        });
    }
    let checked = |locator: Locator| -> Result<Locator, CitationDiagnostic> {
        check_locator(&locator).map_err(|message| locator_diag(&key, message))?;
        Ok(locator)
    };
    let from_csl = match (item.get("locator"), item.get("label")) {
        (None, _) => None,
        (Some(Value::String(text)), label) => {
            let label = match label {
                None => "page",
                Some(Value::String(label)) => label,
                Some(_) => return Err(locator_diag(&key, "label must be text")),
            };
            let (kind, respelled) = kind_for_csl_label(label).ok_or_else(|| {
                diag(
                    CitationDiagnosticCode::UnknownLocatorKind,
                    Some(&key),
                    "this CSL label cannot be kept as an extension kind",
                )
            })?;
            match respelled {
                LabelRespelling::None => {}
                LabelRespelling::Legacy(current) => losses.push(CitationLoss {
                    field: "label".into(),
                    reason: format!(
                        "the legacy label `{label}` is kept as `{}` and exports as the current `{current}`",
                        kind.as_str()
                    ),
                }),
                LabelRespelling::Hyphenated => losses.push(CitationLoss {
                    field: "label".into(),
                    reason: format!(
                        "kept as `{}`, so it exports with hyphens for spaces",
                        kind.as_str()
                    ),
                }),
            }
            Some(checked(Locator {
                kind,
                value: text.trim().into(),
                to: None,
                extra: BTreeMap::new(),
            })?)
        }
        (Some(_), _) => return Err(locator_diag(&key, "locator must be text")),
    };
    let mut locators = Vec::new();
    if let Some(Value::Array(list)) = item.get(OPENBLOG_LOCATORS) {
        if list.len() > MAX_CITATION_LOCATORS {
            return Err(too_many_locators(&key));
        }
        for entry in list {
            let kind = entry
                .get("kind")
                .and_then(Value::as_str)
                .and_then(LocatorKind::parse);
            let value = entry.get("value").and_then(Value::as_str);
            let (Some(kind), Some(value)) = (kind, value) else {
                return Err(locator_diag(
                    &key,
                    "openblog-locators entries need a known kind and a value",
                ));
            };
            locators.push(checked(Locator {
                kind,
                value: value.into(),
                to: entry.get("to").and_then(Value::as_str).map(str::to_string),
                extra: BTreeMap::new(),
            })?);
        }
    }
    match (from_csl, locators.first()) {
        (Some(csl), Some(first)) => {
            if csl.kind != first.kind || csl.value != flat_range(first) {
                losses.push(CitationLoss {
                    field: OPENBLOG_LOCATORS.into(),
                    reason: "disagrees with the CSL label and locator, which win".into(),
                });
                locators = vec![csl];
            }
        }
        (Some(csl), None) => locators.push(csl),
        _ => {}
    }
    losses.sort_by(|a, b| a.field.cmp(&b.field));
    Ok((Citation { key, locators }, losses))
}
