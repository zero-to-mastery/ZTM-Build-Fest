//! The portable projection's boundary for authored raw HTML.
//!
//! Raw HTML blocks and inline tags are tokenized and written out again from a
//! fixed allowlist, so no authored markup reaches a destination byte for byte.
//! Active or destination-hostile markup is removed, unwrapped, or replaced with
//! a link to the canonical article, and each kind of loss is reported on a
//! `raw-html` capability. URLs resolve like Markdown links; one that cannot be
//! made safe fails the projection. This is the projection's policy, not a
//! general-purpose HTML sanitizer.

use std::collections::HashSet;

use pulldown_cmark::{CowStr, Event, Tag, TagEnd};

use crate::capability::{CapabilityDescriptor, CapabilityDiagnosticCode};
use crate::escape;
use crate::portability::{PortableProjection, MAX_PORTABLE_NESTING_DEPTH};

/// Attributes any kept element may carry.
const GLOBAL_ATTRIBUTES: &[&str] = &[
    "id",
    "class",
    "title",
    "lang",
    "dir",
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
];

/// Attributes whose value is a URL, resolved like a Markdown link.
const URL_ATTRIBUTES: &[&str] = &["href", "src", "cite"];

/// How many element or attribute names one diagnostic lists before "and N more".
const NAMES_PER_DIAGNOSTIC: usize = 6;

/// What the projection does with one authored element.
enum Policy {
    /// Written out again with the global and these element attributes.
    Keep {
        attributes: &'static [&'static str],
        void: bool,
    },
    /// Removed with everything inside it.
    Drop { raw_text: bool, void: bool },
    /// Removed with its content; a labeled link to the canonical article takes its place.
    Replace {
        label: &'static str,
        raw_text: bool,
        void: bool,
    },
    /// The tags are removed and the content is kept.
    Unwrap,
}

fn policy(name: &str) -> Policy {
    let keep = |attributes| Policy::Keep {
        attributes,
        void: false,
    };
    match name {
        "a" => keep(&["href", "hreflang", "rel"]),
        "img" => Policy::Keep {
            attributes: &["src", "alt", "width", "height"],
            void: true,
        },
        "br" | "hr" | "wbr" => Policy::Keep {
            attributes: &[],
            void: true,
        },
        "blockquote" | "q" => keep(&["cite"]),
        "del" | "ins" => keep(&["cite", "datetime"]),
        "time" => keep(&["datetime"]),
        "data" => keep(&["value"]),
        "ol" => keep(&["start", "reversed", "type"]),
        "li" => keep(&["value"]),
        "td" => keep(&["colspan", "rowspan", "headers"]),
        "th" => keep(&["colspan", "rowspan", "headers", "scope", "abbr"]),
        "colgroup" => keep(&["span"]),
        "col" => Policy::Keep {
            attributes: &["span"],
            void: true,
        },
        "details" => keep(&["open"]),
        "abbr" | "address" | "article" | "aside" | "b" | "bdi" | "bdo" | "caption" | "cite"
        | "code" | "dd" | "dfn" | "div" | "dl" | "dt" | "em" | "figcaption" | "figure" | "h1"
        | "h2" | "h3" | "h4" | "h5" | "h6" | "i" | "kbd" | "mark" | "p" | "pre" | "rp" | "rt"
        | "ruby" | "s" | "samp" | "section" | "small" | "span" | "strong" | "sub" | "summary"
        | "sup" | "table" | "tbody" | "tfoot" | "thead" | "tr" | "u" | "ul" | "var" => keep(&[]),
        "script" | "style" | "title" | "textarea" | "xmp" | "noembed" | "noframes" | "noscript"
        | "plaintext" => Policy::Drop {
            raw_text: true,
            void: false,
        },
        "template" | "head" | "button" | "select" | "datalist" => Policy::Drop {
            raw_text: false,
            void: false,
        },
        "base" | "meta" | "link" | "input" | "source" | "track" | "area" | "param" | "keygen" => {
            Policy::Drop {
                raw_text: false,
                void: true,
            }
        }
        "iframe" => Policy::Replace {
            label: "Embedded frame",
            raw_text: true,
            void: false,
        },
        "frameset" | "portal" => Policy::Replace {
            label: "Embedded frame",
            raw_text: false,
            void: false,
        },
        "frame" => Policy::Replace {
            label: "Embedded frame",
            raw_text: false,
            void: true,
        },
        "object" | "applet" => Policy::Replace {
            label: "Embedded object",
            raw_text: false,
            void: false,
        },
        "embed" => Policy::Replace {
            label: "Embedded object",
            raw_text: false,
            void: true,
        },
        "video" | "audio" | "canvas" | "svg" | "math" => Policy::Replace {
            label: match name {
                "video" => "Video",
                "audio" => "Audio",
                "canvas" => "Interactive graphic",
                "svg" => "Illustration",
                _ => "Math",
            },
            raw_text: false,
            void: false,
        },
        // Forms, page landmarks, presentational, custom, and unknown elements.
        _ => Policy::Unwrap,
    }
}

/// One piece of an authored HTML fragment.
enum Token<'s> {
    Text(&'s str),
    /// Comments, doctypes, processing instructions, and CDATA: never output.
    Ignored,
    /// A comment with no `-->` in this fragment: it hides the rest of the
    /// fragment and stays open, as in a browser, until a later fragment ends it.
    OpenComment,
    Start {
        name: String,
        attributes: Vec<(String, String)>,
        self_closing: bool,
    },
    End {
        name: String,
    },
}

fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r')
}

/// The token at `at` and where the next one starts. Anything that is not
/// complete markup is text, so a stray `<` is escaped rather than guessed at.
fn next_token(source: &str, at: usize) -> (Token<'_>, usize) {
    let rest = &source[at..];
    if !rest.starts_with('<') {
        let end = rest.find('<').map_or(source.len(), |index| at + index);
        return (Token::Text(&source[at..end]), end);
    }
    if let Some(body) = rest.strip_prefix("<!--") {
        let length = if body.starts_with('>') {
            Some(1)
        } else if body.starts_with("->") {
            Some(2)
        } else {
            comment_end(body)
        };
        return match length {
            Some(length) => (Token::Ignored, at + 4 + length),
            None => (Token::OpenComment, source.len()),
        };
    }
    if rest.starts_with("<!") || rest.starts_with("<?") {
        let end = rest.find('>').map_or(source.len(), |index| at + index + 1);
        return (Token::Ignored, end);
    }
    let (closing, name_at) = match rest.strip_prefix("</") {
        Some(_) => (true, 2),
        None => (false, 1),
    };
    if !rest[name_at..].starts_with(|c: char| c.is_ascii_alphabetic()) {
        return (Token::Text(&rest[..1]), at + 1);
    }
    match parse_tag(rest, name_at) {
        Some((name, _, _, length)) if closing => (Token::End { name }, at + length),
        Some((name, attributes, self_closing, length)) => (
            Token::Start {
                name,
                attributes,
                self_closing,
            },
            at + length,
        ),
        // A tag that never ends runs to the end of the fragment, as in a
        // browser; it is all text, so nothing after it is scanned again.
        None => (Token::Text(rest), source.len()),
    }
}

/// Each start tag in `html` that gives its element an id, as a browser reads
/// it: the tag's byte range and its decoded id. The attribute name matches in
/// any case after any whitespace (or `/`), `=` may have whitespace around it,
/// and the value may be double-quoted, single-quoted or unquoted; the first of
/// a repeated `id` wins and an empty one names nothing. Comments, doctypes and
/// text that is not complete markup hold no elements. Raw text such as a
/// script's is read as markup too, which only ever finds more ids.
pub(crate) fn id_attributes(html: &str) -> Vec<(std::ops::Range<usize>, String)> {
    let mut found = Vec::new();
    let mut at = 0;
    while at < html.len() {
        let (token, next) = next_token(html, at);
        if let Token::Start { attributes, .. } = token {
            if let Some((_, id)) = attributes.into_iter().find(|(name, _)| name == "id") {
                if !id.is_empty() {
                    found.push((at..next, id));
                }
            }
        }
        at = next;
    }
    found
}

/// [`id_attributes`], but with the byte range of the written `id` value
/// itself (inside its quotes, character references as written) instead of
/// the tag's. Only a value that is really the `id` attribute is found, never
/// the same text inside `title=` or `data-x=`.
pub(crate) fn id_value_ranges(html: &str) -> Vec<(std::ops::Range<usize>, String)> {
    let mut found = Vec::new();
    let mut at = 0;
    while at < html.len() {
        let (token, next) = next_token(html, at);
        if let Token::Start { attributes, .. } = token {
            if let Some((_, id)) = attributes.into_iter().find(|(name, _)| name == "id") {
                let mut spans = Vec::new();
                if !id.is_empty() && parse_tag_spans(&html[at..next], 1, &mut spans).is_some() {
                    if let Some((_, range)) = spans.into_iter().find(|(name, _)| name == "id") {
                        found.push((at + range.start..at + range.end, id));
                    }
                }
            }
        }
        at = next;
    }
    found
}

#[derive(Clone)]
pub(crate) struct SemanticLink {
    pub kind: crate::portability::SemanticLinkKind,
    pub target: String,
    pub label: String,
}

/// Read facts from a derived artifact for validation, never for reconstruction.
pub(crate) fn semantic_links(html: &str) -> Vec<SemanticLink> {
    use crate::portability::SemanticLinkKind;
    let mut links = Vec::new();
    let mut anchor: Option<(String, String)> = None;
    let mut at = 0;
    while at < html.len() {
        let (token, next) = next_token(html, at);
        at = next;
        match token {
            Token::Start {
                name, attributes, ..
            } if name == "a" => {
                anchor = attributes
                    .into_iter()
                    .find(|(name, _)| name == "href")
                    .map(|(_, href)| (href, String::new()));
            }
            Token::End { name } if name == "a" => {
                if let Some((target, label)) = anchor.take() {
                    links.push(SemanticLink {
                        kind: SemanticLinkKind::Anchor,
                        target,
                        label,
                    });
                }
            }
            Token::Start {
                name, attributes, ..
            } if name == "img" => {
                let get = |key| {
                    attributes
                        .iter()
                        .find(|(name, _)| name == key)
                        .map(|(_, value)| value.clone())
                        .unwrap_or_default()
                };
                let alt = get("alt");
                if let Some((_, label)) = &mut anchor {
                    label.push_str(&alt);
                }
                if attributes.iter().any(|(name, _)| name == "src") {
                    links.push(SemanticLink {
                        kind: SemanticLinkKind::Image,
                        target: get("src"),
                        label: alt,
                    });
                }
            }
            Token::Text(text) => {
                if let Some((_, label)) = &mut anchor {
                    label.push_str(&decode(text));
                }
            }
            _ => {}
        }
    }
    links
}

/// Read facts from a derived artifact for validation, never for reconstruction.
pub(crate) fn semantic_content(html: &str) -> String {
    let mut output = String::new();
    let mut at = 0;
    while at < html.len() {
        let (token, next) = next_token(html, at);
        at = next;
        match token {
            Token::Text(text) => output.push_str(&decode(text)),
            Token::Start { attributes, .. } => {
                for (name, value) in attributes {
                    if matches!(name.as_str(), "href" | "src" | "alt") {
                        output.push('\n');
                        output.push_str(&value);
                        output.push('\n');
                        if name != "alt" {
                            if let Ok(url) = url::Url::parse(&value) {
                                output.push_str(url.as_str());
                                output.push('\n');
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    output
}

/// Attributes whose value is, or holds, an address a browser may follow or
/// load. `srcset` and `imagesrcset` hold several, each a candidate.
const ADDRESS_ATTRIBUTES: &[&str] = &[
    "href",
    "src",
    "srcset",
    "imagesrcset",
    "poster",
    "data",
    "action",
    "formaction",
    "cite",
    "xlink:href",
    "background",
    "ping",
    "longdesc",
    "codebase",
    "manifest",
    "lowsrc",
];

/// Whether an attribute's decoded value holds an address whose scheme is
/// `atlas:` in any letter case, after the trimming a browser does. A set of
/// candidates (`srcset`) is checked piece by piece.
fn atlas_address(name: &str, value: &str) -> bool {
    if !ADDRESS_ATTRIBUTES.contains(&name) {
        return false;
    }
    let atlas = |piece: &str| crate::concept_links::atlas_destination(piece).is_some();
    if name.ends_with("srcset") {
        value
            .split(|c: char| c == ',' || c.is_whitespace())
            .any(atlas)
    } else {
        atlas(value)
    }
}

/// `html` without any attribute that gives an element an `atlas:` address
/// (ADR 0173), and how many were removed; `None` when it holds none. An
/// attribute is found as a browser reads it: its name in any case, quoted
/// either way or not at all, character references decoded, and every
/// candidate of a `srcset` checked. A tag that never ends and holds the
/// scheme is escaped to text, since a later fragment could end it.
pub(crate) fn strip_atlas_addresses(html: &str) -> Option<(String, usize)> {
    if !html.contains('<') {
        return None;
    }
    let mut out = String::with_capacity(html.len());
    let mut removed = 0;
    let mut changed = false;
    let mut at = 0;
    while at < html.len() {
        let (token, next) = next_token(html, at);
        let tag = &html[at..next];
        match token {
            Token::Start { attributes, .. }
                if attributes
                    .iter()
                    .any(|(name, value)| atlas_address(name, value)) =>
            {
                let mut spans = Vec::new();
                if parse_tag_spans(tag, 1, &mut spans).is_none() {
                    out.push_str(&tag.replace('<', "&lt;"));
                    changed = true;
                    at = next;
                    continue;
                }
                let bytes = tag.as_bytes();
                let mut cuts: Vec<std::ops::Range<usize>> = Vec::new();
                for (name, value) in &attributes {
                    if !atlas_address(name, value) {
                        continue;
                    }
                    let Some((_, written)) = spans.iter().find(|(span, _)| span == name) else {
                        continue;
                    };
                    let mut start = written.start;
                    let mut end = written.end;
                    if start > 0 && matches!(bytes[start - 1], b'"' | b'\'') {
                        start -= 1;
                        end += 1;
                    }
                    while start > 0 && is_space(bytes[start - 1]) {
                        start -= 1;
                    }
                    start = start.saturating_sub(1);
                    while start > 0 && is_space(bytes[start - 1]) {
                        start -= 1;
                    }
                    start = start.saturating_sub(name.len());
                    cuts.push(start..end.min(tag.len()));
                    removed += 1;
                }
                cuts.sort_by_key(|range| range.start);
                let mut cursor = 0;
                for cut in cuts {
                    if cut.start >= cursor {
                        out.push_str(&tag[cursor..cut.start]);
                        cursor = cut.end;
                    }
                }
                out.push_str(&tag[cursor..]);
                changed = true;
            }
            Token::Text(text)
                if text.starts_with('<')
                    && next == html.len()
                    && parse_tag(text, 1).is_none()
                    && decode(text).to_ascii_lowercase().contains("atlas:") =>
            {
                removed += 1;
                changed = true;
            }
            _ => out.push_str(tag),
        }
        at = next;
    }
    changed.then_some((out, removed))
}

/// Where a comment that is open at the start of `text` ends: the length
/// through its `-->` (or `--!>`), or `None` when `text` does not end it.
pub(crate) fn comment_end(text: &str) -> Option<usize> {
    [
        text.find("-->").map(|index| index + 3),
        text.find("--!>").map(|index| index + 4),
    ]
    .into_iter()
    .flatten()
    .min()
}

pub(crate) fn escape_markdown_fragment(source: &str) -> (String, bool) {
    let mut output = String::new();
    let mut at = 0;
    while at < source.len() {
        let (token, next) = next_token(source, at);
        match token {
            Token::Ignored => {}
            Token::OpenComment => return (output, true),
            _ => output.push_str(&source[at..next].replace('<', "&lt;").replace('>', "&gt;")),
        }
        at = next;
    }
    (output, false)
}

type ParsedTag = (String, Vec<(String, String)>, bool, usize);

/// A tag's lowercase name, decoded attributes (the first of a repeated name
/// wins), whether it ends in `/>`, and its length; `None` when it never ends.
fn parse_tag(rest: &str, name_at: usize) -> Option<ParsedTag> {
    parse_tag_spans(rest, name_at, &mut Vec::new())
}

/// [`parse_tag`], also recording where in `rest` the written value of each
/// attribute that counts (the first of a repeated name) starts and ends,
/// without its quotes.
fn parse_tag_spans(
    rest: &str,
    name_at: usize,
    spans: &mut Vec<(String, std::ops::Range<usize>)>,
) -> Option<ParsedTag> {
    let bytes = rest.as_bytes();
    let length = bytes.len();
    let mut i = name_at;
    while i < length && !is_space(bytes[i]) && !matches!(bytes[i], b'/' | b'>') {
        i += 1;
    }
    let name = rest[name_at..i].to_ascii_lowercase();
    let mut attributes: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();
    let mut self_closing = false;
    loop {
        while i < length && (is_space(bytes[i]) || bytes[i] == b'/') {
            self_closing = bytes[i] == b'/';
            i += 1;
        }
        if i >= length {
            return None;
        }
        if bytes[i] == b'>' {
            return Some((name, attributes, self_closing, i + 1));
        }
        self_closing = false;
        let start = i;
        i += 1;
        while i < length && !is_space(bytes[i]) && !matches!(bytes[i], b'/' | b'>' | b'=') {
            i += 1;
        }
        let attribute = rest[start..i].to_ascii_lowercase();
        while i < length && is_space(bytes[i]) {
            i += 1;
        }
        let mut value = String::new();
        let mut written = i..i;
        if i < length && bytes[i] == b'=' {
            i += 1;
            while i < length && is_space(bytes[i]) {
                i += 1;
            }
            match bytes.get(i)? {
                quote @ (b'"' | b'\'') => {
                    let end = i + 1 + rest[i + 1..].find(*quote as char)?;
                    value = decode(&rest[i + 1..end]);
                    written = i + 1..end;
                    i = end + 1;
                }
                _ => {
                    let start = i;
                    while i < length && !is_space(bytes[i]) && bytes[i] != b'>' {
                        i += 1;
                    }
                    value = decode(&rest[start..i]);
                    written = start..i;
                }
            }
        }
        if seen.insert(attribute.clone()) {
            spans.push((attribute.clone(), written));
            attributes.push((attribute, value));
        }
    }
}

/// Named character references decoded in attribute values. An unknown name
/// stays literal; values are escaped again on output, so a destination reads
/// exactly the value that was validated.
const NAMED_REFERENCES: &[(&str, char)] = &[
    ("amp", '&'),
    ("lt", '<'),
    ("gt", '>'),
    ("quot", '"'),
    ("apos", '\''),
    ("nbsp", '\u{a0}'),
    ("Tab", '\t'),
    ("NewLine", '\n'),
    ("colon", ':'),
    ("sol", '/'),
    ("bsol", '\\'),
    ("lpar", '('),
    ("rpar", ')'),
    ("period", '.'),
    ("comma", ','),
    ("semi", ';'),
    ("num", '#'),
    ("excl", '!'),
    ("quest", '?'),
    ("equals", '='),
    ("plus", '+'),
    ("percnt", '%'),
    ("commat", '@'),
    ("lowbar", '_'),
    ("grave", '`'),
    ("copy", '©'),
    ("reg", '®'),
    ("trade", '™'),
    ("hellip", '…'),
    ("ndash", '–'),
    ("mdash", '—'),
    ("lsquo", '‘'),
    ("rsquo", '’'),
    ("ldquo", '“'),
    ("rdquo", '”'),
    ("laquo", '«'),
    ("raquo", '»'),
    ("middot", '·'),
    ("deg", '°'),
    ("times", '×'),
];

fn decode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        match reference(rest) {
            Some((character, length)) => {
                out.push(character);
                rest = &rest[length..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The character a reference at the start of `input` (which begins with `&`)
/// stands for, and its length.
fn reference(input: &str) -> Option<(char, usize)> {
    if let Some(numeric) = input.strip_prefix("&#") {
        let (digits, radix, prefix) = match numeric.strip_prefix(['x', 'X']) {
            Some(hex) => (hex, 16, 3),
            None => (numeric, 10, 2),
        };
        let count = digits
            .bytes()
            .take_while(|byte| (*byte as char).is_digit(radix))
            .count();
        if count == 0 {
            return None;
        }
        let code = digits[..count].chars().fold(0u32, |code, digit| {
            code.saturating_mul(radix)
                .saturating_add(digit.to_digit(radix).unwrap_or(0))
        });
        let character = char::from_u32(code)
            .filter(|character| *character != '\0')
            .unwrap_or('\u{fffd}');
        let semicolon = usize::from(digits[count..].starts_with(';'));
        return Some((character, prefix + count + semicolon));
    }
    let name_length = input[1..]
        .bytes()
        .take_while(u8::is_ascii_alphanumeric)
        .count();
    let name = &input[1..1 + name_length];
    if !input[1 + name_length..].starts_with(';') {
        return None;
    }
    NAMED_REFERENCES
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, character)| (*character, name_length + 2))
}

/// Text between tags: character references are kept as written, and a `<` or
/// `>` that is not part of markup is escaped.
fn push_text(out: &mut String, text: &str) {
    for character in text.chars() {
        match character {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(character),
        }
    }
}

/// A name as a diagnostic lists it; anything unusual is not echoed.
fn listed(name: &str) -> &str {
    if !name.is_empty()
        && name.len() <= 32
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    {
        name
    } else {
        "unrecognized"
    }
}

/// Distinct names in the order they were first seen.
#[derive(Default)]
struct Group {
    names: Vec<String>,
    seen: HashSet<String>,
}

impl Group {
    fn is_empty(&self) -> bool {
        self.names.is_empty()
    }
}

/// Content removed or repaired in the portable copy, grouped for the
/// `raw-html` report.
#[derive(Default)]
struct Losses {
    dropped: Group,
    removed: Group,
    unwrapped: Group,
    replaced: Group,
    attributes: Group,
    ids: usize,
    heading_ids: usize,
    images_without_alt: usize,
}

fn note(group: &mut Group, name: String) {
    if group.seen.insert(name.clone()) {
        group.names.push(name);
    }
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn names(group: &Group, tags: bool) -> String {
    let group = &group.names;
    let mut listed: Vec<String> = group
        .iter()
        .take(NAMES_PER_DIAGNOSTIC)
        .map(|name| {
            if tags {
                format!("<{name}>")
            } else {
                name.clone()
            }
        })
        .collect();
    if group.len() > NAMES_PER_DIAGNOSTIC {
        listed.push(format!("and {} more", group.len() - NAMES_PER_DIAGNOSTIC));
    }
    listed.join(", ")
}

impl Losses {
    fn report(&self) -> Option<CapabilityDescriptor> {
        let mut messages = Vec::new();
        for (group, prefix) in [
            (&self.dropped, "Removed with their content"),
            (&self.removed, "Removed"),
            (&self.unwrapped, "Kept the content but removed the tags"),
            (
                &self.replaced,
                "Replaced with a link to the original article",
            ),
        ] {
            if !group.is_empty() {
                messages.push(format!("{prefix}: {}.", names(group, true)));
            }
        }
        if !self.attributes.is_empty() {
            messages.push(format!(
                "Removed attributes: {}.",
                names(&self.attributes, false)
            ));
        }
        if self.ids > 0 {
            messages.push(format!(
                "Removed {} duplicate, reserved, or invalid id{}.",
                self.ids,
                if self.ids == 1 { "" } else { "s" }
            ));
        }
        if self.heading_ids > 0 {
            messages.push(format!(
                "Renamed {}.",
                plural(
                    self.heading_ids,
                    "duplicate or reserved heading id",
                    "duplicate or reserved heading ids"
                )
            ));
        }
        if self.images_without_alt > 0 {
            messages.push(format!(
                "Marked {} as decorative (alt=\"\").",
                plural(
                    self.images_without_alt,
                    "image without alternative text",
                    "images without alternative text"
                )
            ));
        }
        if messages.is_empty() {
            return None;
        }
        let mut descriptor = CapabilityDescriptor::describe("raw-html", None);
        for message in messages {
            descriptor.add_diagnostic(CapabilityDiagnosticCode::RemovedMarkup, &message);
        }
        Some(descriptor)
    }
}

/// A removed element whose content is still being skipped.
struct Skip {
    name: String,
    raw_text: bool,
    /// An unterminated comment rather than an element: it ends at `-->`.
    comment: bool,
    nested: usize,
    /// The Markdown depth it opened at. Everything inside it is skipped,
    /// Markdown included, until its end tag or the end of that container.
    depth: usize,
    /// Opened in a raw HTML block rather than by an inline tag.
    in_block: bool,
    /// Its HTML block ended before its end tag arrived, so the Markdown after
    /// the block is inside it, as in a browser.
    outlived: bool,
    /// Authored content after its HTML block was skipped waiting for the end tag.
    swallowed: bool,
}

struct RawHtml<'p, 'a> {
    projection: &'p PortableProjection<'a>,
    images: Vec<crate::portability::PortableImage>,
    has_raw_html: bool,
    /// Ids the projection writes itself (headings and footnotes).
    reserved: HashSet<String>,
    ids: HashSet<String>,
    /// Kept elements still open, with the Markdown depth that opened them.
    open: Vec<(String, usize)>,
    skip: Option<Skip>,
    /// Open Markdown containers.
    depth: usize,
    /// Whether the fragment being rewritten is a raw HTML block.
    in_block: bool,
    losses: Losses,
}

/// Whether an id can appear in portable output: not empty, no whitespace, and
/// not in the `ob-` namespace the projection writes its own ids in.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && !id.bytes().any(is_space) && !reserved_id(id)
}

/// Whether an id is in the `ob-` namespace the projection writes its own ids in.
pub(crate) fn reserved_id(id: &str) -> bool {
    id.starts_with("ob-")
}

/// Whether skipping `event` loses authored content.
fn has_content(event: &Event<'_>) -> bool {
    match event {
        Event::Start(Tag::HtmlBlock) | Event::End(_) | Event::SoftBreak | Event::HardBreak => false,
        Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => !text.trim().is_empty(),
        _ => true,
    }
}

/// Whether an output event shows a reader nothing.
fn is_blank(event: &Event<'_>) -> bool {
    match event {
        Event::SoftBreak => true,
        Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => text.trim().is_empty(),
        _ => false,
    }
}

/// Rename each heading id that repeats an earlier heading's id or a footnote
/// id, or is not a [`valid_id`], so authored `{#id}` values cannot duplicate
/// an anchor or take one the projection writes. The first heading with an id
/// keeps it. Returns how many were renamed.
fn unique_heading_ids(events: &mut [Event<'_>]) -> usize {
    let taken: HashSet<String> = events
        .iter()
        .filter_map(|event| match event {
            Event::Start(Tag::Heading { id: Some(id), .. }) => Some(id.to_string()),
            Event::Start(Tag::FootnoteDefinition(name)) => Some(name.to_string()),
            _ => None,
        })
        .collect();
    // Footnote ids are written by the projection and keep their names.
    let mut used: HashSet<String> = events
        .iter()
        .filter_map(|event| match event {
            Event::Start(Tag::FootnoteDefinition(name)) if !reserved_id(name) => {
                Some(name.to_string())
            }
            _ => None,
        })
        .collect();
    let mut renamed = 0;
    for event in events {
        let Event::Start(Tag::Heading { id: Some(id), .. }) = event else {
            continue;
        };
        if valid_id(id) && used.insert(id.to_string()) {
            continue;
        }
        let mut base = id.split_whitespace().collect::<Vec<_>>().join("-");
        while let Some(rest) = base.strip_prefix("ob-") {
            base = rest.to_string();
        }
        if base.is_empty() {
            base = "section".to_string();
        }
        let mut candidate = base.clone();
        let mut n = 2;
        while taken.contains(&candidate) || used.contains(&candidate) {
            candidate = format!("{base}-{n}");
            n += 1;
        }
        used.insert(candidate.clone());
        *id = CowStr::from(candidate);
        renamed += 1;
    }
    renamed
}

/// Apply the raw HTML policy to parsed events whose links are already
/// resolved and whose headings already have ids. Returns the events and, when
/// anything authored was removed or repaired, the `raw-html` capability that
/// reports it.
pub(crate) fn sanitize<'e>(
    mut events: Vec<Event<'e>>,
    projection: &PortableProjection<'_>,
) -> Result<Sanitized<'e>, String> {
    let heading_ids = unique_heading_ids(&mut events);
    // A footnote named in the reserved `ob-` namespace is written without an
    // id; its citations still point at the note on the canonical article.
    let footnote_ids = events
        .iter()
        .filter(|event| {
            matches!(event, Event::Start(Tag::FootnoteDefinition(name)) if reserved_id(name))
        })
        .count();
    let reserved = events
        .iter()
        .filter_map(|event| match event {
            Event::Start(Tag::Heading { id: Some(id), .. }) => Some(id.to_string()),
            Event::Start(Tag::FootnoteDefinition(name)) => Some(name.to_string()),
            _ => None,
        })
        .collect();
    let mut state = RawHtml {
        projection,
        images: Vec::new(),
        has_raw_html: false,
        reserved,
        ids: HashSet::new(),
        open: Vec::new(),
        skip: None,
        depth: 0,
        in_block: false,
        losses: Losses {
            heading_ids,
            ids: footnote_ids,
            ..Losses::default()
        },
    };
    let mut out = Vec::with_capacity(events.len());
    // Raw block HTML arrives a line at a time; each block is handled whole.
    let mut block: Option<String> = None;
    // Depths of Markdown containers that started inside a removed element.
    let mut skipped: Vec<usize> = Vec::new();
    // Where each open paragraph starts in `out`.
    let mut paragraphs: Vec<usize> = Vec::new();
    for event in events {
        if let Some(skip) = state.skip.as_mut() {
            if skip.outlived && has_content(&event) {
                skip.swallowed = true;
            }
        }
        match event {
            Event::Start(Tag::HtmlBlock) => {
                block = Some(String::new());
                out.push(Event::Start(Tag::HtmlBlock));
            }
            Event::Html(html) if block.is_some() => {
                if let Some(block) = block.as_mut() {
                    block.push_str(&html);
                }
            }
            Event::End(TagEnd::HtmlBlock) => {
                let source = block.take().unwrap_or_default();
                state.in_block = true;
                let html = state.fragment(&source);
                state.in_block = false;
                let html = html?;
                state.has_raw_html |= !html.trim().is_empty();
                out.push(Event::Html(CowStr::from(html)));
                out.push(Event::End(TagEnd::HtmlBlock));
                if let Some(skip) = state.skip.as_mut() {
                    skip.outlived |= skip.in_block;
                }
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                let html = state.fragment(&html)?;
                state.has_raw_html |= !html.trim().is_empty();
                out.push(Event::InlineHtml(CowStr::from(html)));
            }
            Event::Start(mut tag) => {
                state.depth += 1;
                state.check_depth()?;
                if state.skip.is_some() {
                    skipped.push(state.depth);
                    continue;
                }
                // `{key=value}` heading attributes are authored markup too.
                if let Tag::Heading { attrs, .. } = &mut tag {
                    for (attribute, _) in attrs.drain(..) {
                        state.remove_attribute(&attribute.to_ascii_lowercase());
                    }
                }
                if matches!(tag, Tag::Paragraph) {
                    paragraphs.push(out.len());
                }
                if let Tag::Image { dest_url, .. } = &tag {
                    state.images.push(crate::portability::PortableImage {
                        url: dest_url.to_string(),
                        raw_html: false,
                    });
                }
                out.push(Event::Start(tag));
            }
            Event::End(tag) => {
                let closes = state.close_from(state.depth);
                if !closes.is_empty() {
                    out.push(Event::InlineHtml(CowStr::from(closes)));
                }
                if state
                    .skip
                    .as_ref()
                    .is_some_and(|skip| skip.depth >= state.depth)
                {
                    state.end_skip()?;
                }
                let started_inside_skip = skipped.last() == Some(&state.depth);
                if started_inside_skip {
                    skipped.pop();
                }
                state.depth = state.depth.saturating_sub(1);
                if started_inside_skip {
                    continue;
                }
                // A paragraph whose every part was removed is removed too.
                if matches!(tag, TagEnd::Paragraph) {
                    if let Some(start) = paragraphs.pop() {
                        if out[start + 1..].iter().all(is_blank) {
                            out.truncate(start);
                            continue;
                        }
                    }
                }
                out.push(Event::End(tag));
            }
            _ if state.skip.is_some() => {}
            other => out.push(other),
        }
    }
    state.end_skip()?;
    let closes = state.close_from(0);
    if !closes.is_empty() {
        out.push(Event::Html(CowStr::from(closes)));
    }
    Ok(Sanitized {
        events: out,
        capability: state.losses.report(),
        images: state.images,
        has_raw_html: state.has_raw_html,
    })
}

pub(crate) struct Sanitized<'a> {
    pub events: Vec<Event<'a>>,
    pub capability: Option<CapabilityDescriptor>,
    pub images: Vec<crate::portability::PortableImage>,
    pub has_raw_html: bool,
}

impl RawHtml<'_, '_> {
    fn check_depth(&self) -> Result<(), String> {
        if self.depth + self.open.len() > MAX_PORTABLE_NESTING_DEPTH {
            return Err(format!(
                "{}: portable HTML would nest more than {MAX_PORTABLE_NESTING_DEPTH} elements deep; simplify the nesting (nothing was truncated)",
                self.projection.source_path()
            ));
        }
        Ok(())
    }

    /// Stop skipping a removed element whose container (or the body) ended
    /// before its end tag. One that outlived its HTML block and hid authored
    /// content after it fails the projection rather than losing it silently.
    fn end_skip(&mut self) -> Result<(), String> {
        match self.skip.take() {
            Some(skip) if skip.outlived && skip.swallowed && skip.comment => Err(format!(
                "{}: a raw HTML comment (<!--) is never closed, so everything after it would be hidden; close it with --> (nothing was published)",
                self.projection.source_path()
            )),
            Some(skip) if skip.outlived && skip.swallowed => {
                let name = listed(&skip.name);
                Err(format!(
                    "{}: raw HTML <{name}> is never closed, so everything after it would be hidden; close it with </{name}> (nothing was published)",
                    self.projection.source_path()
                ))
            }
            _ => Ok(()),
        }
    }

    /// Close the kept elements opened at `depth` or deeper.
    fn close_from(&mut self, depth: usize) -> String {
        let mut html = String::new();
        while self.open.last().is_some_and(|(_, open)| *open >= depth) {
            if let Some((name, _)) = self.open.pop() {
                html.push_str(&format!("</{name}>"));
            }
        }
        html
    }

    fn remove_attribute(&mut self, attribute: &str) {
        let name = if attribute.starts_with("on") {
            "event handlers".to_string()
        } else if attribute.starts_with("data-") {
            "data-*".to_string()
        } else {
            listed(attribute).to_string()
        };
        note(&mut self.losses.attributes, name);
    }

    fn fragment(&mut self, source: &str) -> Result<String, String> {
        let mut html = String::new();
        let mut at = 0;
        while at < source.len() {
            if self.skip.is_some() {
                at = self.skip_content(source, at);
                continue;
            }
            let (token, next) = next_token(source, at);
            at = next;
            match token {
                Token::Text(text) => push_text(&mut html, text),
                Token::Ignored => {}
                Token::OpenComment => {
                    self.skip = Some(Skip {
                        name: String::new(),
                        raw_text: true,
                        comment: true,
                        nested: 0,
                        depth: self.depth,
                        in_block: self.in_block,
                        outlived: false,
                        swallowed: false,
                    });
                }
                Token::Start {
                    name,
                    attributes,
                    self_closing,
                } => self.start(&mut html, name, attributes, self_closing)?,
                Token::End { name } => self.end(&mut html, &name),
            }
        }
        Ok(html)
    }

    /// Skip a removed element's content from `at`, returning where output resumes.
    fn skip_content(&mut self, source: &str, mut at: usize) -> usize {
        let Some(skip) = self.skip.as_mut() else {
            return at;
        };
        if skip.comment {
            // Nothing inside a comment is markup; only its end counts.
            return match comment_end(&source[at..]) {
                Some(length) => {
                    self.skip = None;
                    at + length
                }
                None => source.len(),
            };
        }
        if skip.raw_text {
            // Nothing inside is markup until the matching end tag, in any case.
            while let Some(found) = source[at..].find("</") {
                let start = at + found;
                let name_end = start + 2 + skip.name.len();
                if source
                    .get(start + 2..name_end)
                    .is_some_and(|name| name.eq_ignore_ascii_case(&skip.name))
                    && source
                        .as_bytes()
                        .get(name_end)
                        .is_none_or(|byte| is_space(*byte) || matches!(byte, b'/' | b'>'))
                {
                    self.skip = None;
                    let (_, next) = next_token(source, start);
                    return next;
                }
                at = start + 2;
            }
            return source.len();
        }
        while at < source.len() {
            let (token, next) = next_token(source, at);
            at = next;
            match token {
                Token::Start {
                    name, self_closing, ..
                } if name == skip.name && !self_closing => skip.nested += 1,
                Token::End { name } if name == skip.name => {
                    if skip.nested == 0 {
                        self.skip = None;
                        return at;
                    }
                    skip.nested -= 1;
                }
                _ => {}
            }
        }
        at
    }

    fn start(
        &mut self,
        html: &mut String,
        name: String,
        attributes: Vec<(String, String)>,
        self_closing: bool,
    ) -> Result<(), String> {
        let (raw_text, void) = match policy(&name) {
            Policy::Keep {
                attributes: allowed,
                void,
            } => return self.keep(html, name, attributes, allowed, void),
            Policy::Unwrap => {
                note(&mut self.losses.unwrapped, listed(&name).to_string());
                return Ok(());
            }
            Policy::Drop { raw_text, void } => {
                let group = if void {
                    &mut self.losses.removed
                } else {
                    &mut self.losses.dropped
                };
                note(group, listed(&name).to_string());
                (raw_text, void)
            }
            Policy::Replace {
                label,
                raw_text,
                void,
            } => {
                note(&mut self.losses.replaced, listed(&name).to_string());
                let title = attributes
                    .iter()
                    .find(|(attribute, value)| {
                        matches!(attribute.as_str(), "title" | "aria-label")
                            && !value.trim().is_empty()
                    })
                    .map(|(_, value)| format!(" ({})", escape::text(value.trim())))
                    .unwrap_or_default();
                html.push_str(&format!(
                    "<span class=\"ob-portable-note\"><strong>{label}</strong>{title}: see it on <a href=\"{}\">the original article</a>.</span>",
                    escape::attr(self.projection.canonical_url())
                ));
                (raw_text, void)
            }
        };
        // `<svg/>` closes itself; `<script/>` still opens raw text in a browser.
        if !void && (raw_text || !self_closing) {
            self.skip = Some(Skip {
                name,
                raw_text,
                comment: false,
                nested: 0,
                depth: self.depth,
                in_block: self.in_block,
                outlived: false,
                swallowed: false,
            });
        }
        Ok(())
    }

    fn keep(
        &mut self,
        html: &mut String,
        name: String,
        attributes: Vec<(String, String)>,
        allowed: &[&str],
        void: bool,
    ) -> Result<(), String> {
        if !void {
            self.open.push((name.clone(), self.depth));
            if let Err(error) = self.check_depth() {
                self.open.pop();
                return Err(error);
            }
        }
        html.push('<');
        html.push_str(&name);
        let has_id = attributes.iter().any(|(attribute, _)| attribute == "id");
        let has_alt = attributes.iter().any(|(attribute, _)| attribute == "alt");
        for (attribute, value) in attributes {
            // A legacy `<a name>` anchor keeps working as an id.
            let attribute = if name == "a" && attribute == "name" && !has_id {
                "id".to_string()
            } else {
                attribute
            };
            if attribute.starts_with("on")
                || !(GLOBAL_ATTRIBUTES.contains(&attribute.as_str())
                    || allowed.contains(&attribute.as_str()))
            {
                self.remove_attribute(&attribute);
                continue;
            }
            let value = if URL_ATTRIBUTES.contains(&attribute.as_str()) {
                self.projection
                    .resolve_link(&value)
                    .map_err(|error| format!("{error} (raw HTML <{name} {attribute}>)"))?
            } else if attribute == "id" {
                let unique = valid_id(&value)
                    && !self.reserved.contains(&value)
                    && self.ids.insert(value.clone());
                if !unique {
                    self.losses.ids += 1;
                    continue;
                }
                value
            } else {
                value
            };
            if name == "img" && attribute == "src" {
                self.images.push(crate::portability::PortableImage {
                    url: value.clone(),
                    raw_html: true,
                });
            }
            if value.is_empty() && matches!(attribute.as_str(), "open" | "reversed") {
                html.push_str(&format!(" {attribute}"));
            } else {
                html.push_str(&format!(" {attribute}=\"{}\"", escape::attr(&value)));
            }
        }
        // Every portable image has alternative text; one written without any
        // is marked decorative and reported.
        if name == "img" && !has_alt {
            html.push_str(" alt=\"\"");
            self.losses.images_without_alt += 1;
        }
        html.push('>');
        Ok(())
    }

    /// A kept element's end tag closes it (and anything opened inside it) when
    /// it was opened in the same Markdown container; other end tags are dropped.
    fn end(&mut self, html: &mut String, name: &str) {
        // A browser reads a stray `</br>` as a line break.
        if name == "br" {
            html.push_str("<br>");
            return;
        }
        if !matches!(policy(name), Policy::Keep { void: false, .. }) {
            return;
        }
        let Some(position) = self
            .open
            .iter()
            .rposition(|(open, depth)| open == name && *depth == self.depth)
        else {
            return;
        };
        for (open, _) in self.open.drain(position..).rev() {
            html.push_str(&format!("</{open}>"));
        }
    }
}

/// Elements that never have content or an end tag.
const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

/// Elements whose content is text up to their end tag.
const RAW_TEXT_ELEMENTS: &[&str] = &[
    "script",
    "style",
    "textarea",
    "title",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
    "noscript",
    "plaintext",
];

/// Make a rendered portable body well nested, as a browser would read it. An
/// end tag for an element that is still open closes everything opened inside
/// it first (a raw `<div>` left open in a recipe section closes before the
/// section's `</section>`); an end tag for an element that is not open is
/// dropped; anything still open at the end is closed there. Everything else is
/// copied byte for byte, so a body that is already well nested is unchanged
/// and the destination's own container can never be closed early.
pub(crate) fn balance(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut open: Vec<String> = Vec::new();
    let mut at = 0;
    while at < html.len() {
        let (token, mut next) = next_token(html, at);
        match token {
            Token::Start { name, .. } => {
                if RAW_TEXT_ELEMENTS.contains(&name.as_str()) {
                    // Copy the text through its end tag unread.
                    let lower = html[next..].to_ascii_lowercase();
                    match lower.find(&format!("</{name}")) {
                        Some(found) => {
                            next = next_token(html, next + found).1;
                        }
                        None => {
                            next = html.len();
                            open.push(name);
                        }
                    }
                } else if !VOID_ELEMENTS.contains(&name.as_str()) {
                    open.push(name);
                }
                out.push_str(&html[at..next]);
            }
            Token::End { name } => {
                if let Some(position) = open.iter().rposition(|element| *element == name) {
                    for element in open.drain(position + 1..).rev() {
                        out.push_str(&format!("</{element}>"));
                    }
                    open.pop();
                    out.push_str(&html[at..next]);
                }
            }
            _ => out.push_str(&html[at..next]),
        }
        at = next;
    }
    for element in open.into_iter().rev() {
        out.push_str(&format!("</{element}>"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attribute_values_decode_references_before_they_are_checked() {
        assert_eq!(decode("java&#x73;cript&colon;x"), "javascript:x");
        assert_eq!(decode("&#106&#97;"), "ja");
        assert_eq!(decode("a&b=c&amp;d&unknown;"), "a&b=c&d&unknown;");
        assert_eq!(
            decode("&#0;&#x110000;&#99999999999;"),
            "\u{fffd}\u{fffd}\u{fffd}"
        );
        assert_eq!(decode("&Tab;&NewLine;"), "\t\n");
        assert_eq!(decode("&#;&#x;&"), "&#;&#x;&");
    }

    #[test]
    fn atlas_addresses_are_removed_from_every_address_attribute() {
        let (clean, count) = strip_atlas_addresses(
            "<a class=x HREF = ' AtLaS:a ' title=t>l</a><img src=atlas&#58;b srcset=\"/p 1x,atlas:c 2x\"><svg xlink:href=\"atlas:d\"></svg>",
        )
        .unwrap();
        assert_eq!(count, 4);
        assert!(!clean.to_ascii_lowercase().contains("atlas"), "{clean}");
        assert!(
            clean.contains("class=x") && clean.contains("title=t"),
            "{clean}"
        );
        assert!(strip_atlas_addresses("<a href=\"/atlas:x\" data-href=\"atlas:y\">").is_none());
    }

    #[test]
    fn ids_are_read_in_any_case_spacing_and_quoting() {
        let ids = |html: &str| {
            id_attributes(html)
                .into_iter()
                .map(|(tag, id)| (html[tag].to_string(), id))
                .collect::<Vec<_>>()
        };
        for html in [
            "<span id=\"notes\">",
            "<span ID=\"notes\">",
            "<span Id = \"notes\">",
            "<span id='notes'>",
            "<span id=notes>",
            "<span	id
=
'notes'>",
            "<span/id=notes />",
            "<span class=x id=\"notes\" id=\"other\">",
            "<span id=&#110;otes>",
        ] {
            assert_eq!(
                ids(html),
                [(html.to_string(), "notes".to_string())],
                "{html}"
            );
        }
        for html in [
            "<span data-id=\"notes\">",
            "<span title=' id=\"notes\"'>",
            "<!-- <span id=\"notes\"> -->",
            "<span id=\"\">",
            "<span id>",
            "id=\"notes\"",
            "</span id=\"notes\">",
            "<span id=\"notes\"",
        ] {
            assert!(ids(html).is_empty(), "{html}");
        }
        assert_eq!(
            ids("<p id=a>x</p><b ID='b'>").len(),
            2,
            "every element is read"
        );
    }

    #[test]
    fn malformed_tags_are_text_and_never_panic() {
        for source in [
            "<",
            "<a",
            "<a href=\"x",
            "<a href='x>",
            "<a href=",
            "</",
            "</a",
            "<é>",
            "<a é=\"ü\">",
            "<!--",
            "<!",
            "<?",
            "<a\u{0}b>",
        ] {
            let mut at = 0;
            while at < source.len() {
                let (_, next) = next_token(source, at);
                assert!(next > at, "{source:?}");
                at = next;
            }
        }
        // A tag that never ends is text through the end of the fragment.
        let (token, next) = next_token("x <a href=\"x <b>y</b>", 2);
        assert!(matches!(token, Token::Text("<a href=\"x <b>y</b>")));
        assert_eq!(next, 21);
        let (token, next) = next_token("<A HREF=x Title='T' href=y/>", 0);
        let Token::Start {
            name,
            attributes,
            self_closing,
        } = token
        else {
            panic!("start tag");
        };
        assert_eq!(name, "a");
        assert_eq!(
            attributes,
            [
                ("href".to_string(), "x".to_string()),
                ("title".to_string(), "T".to_string())
            ]
        );
        assert!(!self_closing, "an unquoted value keeps its slash");
        assert_eq!(next, 28);
    }

    #[test]
    fn balance_closes_what_an_outer_end_tag_would_close() {
        assert_eq!(
            balance("<section><div class=\"tip\"><p>a</p></section><p>b</p></div>"),
            "<section><div class=\"tip\"><p>a</p></div></section><p>b</p>"
        );
        assert_eq!(
            balance("<p>a<br>b<img alt=\"\"></p>"),
            "<p>a<br>b<img alt=\"\"></p>"
        );
        assert_eq!(balance("<div><em>x"), "<div><em>x</em></div>");
        assert_eq!(
            balance("<pre><code>&lt;/div&gt;</code></pre></p>"),
            "<pre><code>&lt;/div&gt;</code></pre>"
        );
    }
}
