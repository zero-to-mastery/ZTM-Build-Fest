//! Concept links in an article (ADR 0172): an author's explicit
//! `[the Republic](atlas:republic)` ties a word in the prose to one published
//! Knowledge Atlas entry, with no automatic recognition of anything.
//!
//! The syntax is an ordinary Markdown link whose destination is `atlas:` and
//! an entry id. In any editor, preview or copy that does not know it, it reads
//! as the author's own words (the label), and the destination is a short
//! readable id. Nothing else is a concept link: a label that is not linked
//! stays text however often it repeats, and prose is never scanned.
//!
//! A link is resolved at build time, against the public atlas
//! ([`PublicAtlas`]) and nothing else. A published entry becomes an ordinary
//! `<a>` to its page, so it works without JavaScript. An id that is not
//! well-formed, that names no entry (unknown, not approved or withdrawn: the
//! public atlas cannot tell which, and neither does the page), or any link
//! while the site does not publish its atlas, becomes the label as plain text
//! and a diagnostic for the author naming the file and the id. The page never
//! carries a link that leads nowhere, and never anything that says an
//! unpublished entry exists.
//!
//! The Markdown renderer marks each concept link with an inert
//! `<ob-concept data-id="...">` element, and [`link_html`] later replaces
//! every mark, once the atlas is known. A page that is never resolved shows
//! plain text, since the mark is an element no browser styles.

use std::collections::BTreeMap;

use pulldown_cmark::{CowStr, Event, Parser, Tag, TagEnd};

use crate::atlas_publication::PublicAtlas;
use crate::escape;
use crate::knowledge_atlas::valid_id;

/// The start of a concept link's destination.
pub const SCHEME: &str = "atlas:";
/// What the rendered HTML of a post holds before its concept links are
/// resolved: the start of the mark.
pub const MARK_PREFIX: &str = "<ob-concept data-id=\"";
const MARK_CLOSE: &str = "</ob-concept>";
/// The class of a resolved concept link, for themes and for the context
/// previews that enhance it.
pub const LINK_CLASS: &str = "ob-concept";
/// Every diagnostic this module writes contains this text, so a later
/// resolution replaces the earlier ones instead of repeating them.
pub const WARNING_MARK: &str = ": concept link `";
/// The start of the diagnostic for an `atlas:` link outside a post. It is
/// written once when the site loads and is not one of the post resolution's
/// diagnostics, so [`WARNING_MARK`] does not replace it.
pub const OUTSIDE_WARNING_MARK: &str = ": atlas link `";
/// The words a screen reader adds after a concept link's label, as visually
/// hidden text, so the link says what it leads to without script.
pub const LINK_HINT: &str = " (atlas entry)";
/// The class of the hint's element (the theme's visually hidden class).
const HINT_CLASS: &str = "ob-visually-hidden";
/// The id of the one hint a post's concept links inside headings point to
/// with `aria-describedby`, so the hint is part of the link's description and
/// never of the heading's accessible name (or its entry in an outline).
pub const HEADING_HINT_ID: &str = "ob-concept-hint";
/// The words that hint says.
const HEADING_HINT: &str = "Atlas entry";

/// The id a concept link's destination names, when the destination is a
/// well-formed one: `atlas:` and a lowercase slug of at most 64 bytes.
pub fn entry_id(destination: &str) -> Option<&str> {
    let id = destination.strip_prefix(SCHEME)?;
    valid_id(id).then_some(id)
}

/// The mark the renderer writes where a concept link starts.
pub(crate) fn mark_open(id: &str) -> String {
    format!("{MARK_PREFIX}{}\">", escape::attr(id))
}

/// A link or image whose destination is `atlas:` that the renderer refused to
/// turn into a mark, with the reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    /// The id as written (the destination after `atlas:`), not escaped.
    pub id: String,
    pub why: Unlinked,
}

/// What [`mark_events`] found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Marked {
    /// Whether any concept link became a mark.
    pub any: bool,
    /// Every `atlas:` link or image that was not marked, in source order. Its
    /// events were emptied or flattened to their label, so neither the
    /// destination, nor a title, nor the id reaches the page.
    pub refused: Vec<Refusal>,
}

/// The destination of a link or image as a browser would read its scheme
/// (tabs and line breaks removed, surrounding control characters and spaces
/// trimmed), when that scheme is `atlas:` in any letter case. The flag is
/// whether it is written exactly as `atlas:`, the only form that is a
/// concept link.
pub(crate) fn atlas_destination(dest: &str) -> Option<(String, bool)> {
    let cleaned: String = dest
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c.is_control() || c.is_whitespace());
    let head = trimmed.get(..SCHEME.len())?;
    head.eq_ignore_ascii_case(SCHEME)
        .then(|| (trimmed[SCHEME.len()..].to_string(), head == SCHEME))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LinkFrame {
    /// Not an `atlas:` link: its events are untouched.
    Plain,
    /// Becomes a mark.
    Mark,
    /// Its start and end are emptied; the label stays.
    Label,
    /// An autolink: it has no label, so everything in it is emptied.
    Swallow,
}

/// Make every `atlas:` link and image of a parsed document safe, whatever its
/// `LinkType` (inline, reference, collapsed, shortcut, autolink or email):
///
/// - a link written exactly `[label](atlas:id)` becomes a mark when `marks`
///   is on (posts), to be resolved when published;
/// - any other `atlas:` link (not a post, in an image's description, a
///   non-canonical letter case) keeps only its label;
/// - an autolink has no label and renders as nothing;
/// - an image with an `atlas:` destination is always refused: its description
///   is shown as plain text.
///
/// Nothing emits an `atlas:` href or src, a title, or the id as text, and
/// every refusal is reported for the author. Links cannot nest, so a stack
/// pairs each end with its start.
pub(crate) fn mark_events(events: &mut [Event<'_>], marks: bool) -> Marked {
    let mut found = Marked::default();
    let mut links: Vec<LinkFrame> = Vec::new();
    // One entry per open image: whether its events are replaced, and whether
    // it is itself an atlas image.
    let mut images: Vec<(bool, bool)> = Vec::new();
    let mut refused_images = 0usize;
    for event in events.iter_mut() {
        let flat = refused_images > 0;
        let in_image = !images.is_empty();
        let replacement: Option<Event<'static>> = match &*event {
            Event::Start(Tag::Image { dest_url, .. }) => {
                let atlas = atlas_destination(dest_url);
                if let Some((id, _)) = &atlas {
                    found.refused.push(Refusal {
                        id: id.clone(),
                        why: Unlinked::Image,
                    });
                    refused_images += 1;
                }
                images.push((atlas.is_some() || flat, atlas.is_some()));
                (atlas.is_some() || flat).then(|| Event::Text(CowStr::from("")))
            }
            Event::End(TagEnd::Image) => match images.pop() {
                Some((replaced, atlas)) => {
                    if atlas {
                        refused_images = refused_images.saturating_sub(1);
                    }
                    replaced.then(|| Event::Text(CowStr::from("")))
                }
                None => None,
            },
            Event::Start(Tag::Link {
                dest_url,
                link_type,
                ..
            }) => match atlas_destination(dest_url) {
                None => {
                    links.push(LinkFrame::Plain);
                    flat.then(|| Event::Text(CowStr::from("")))
                }
                Some((id, canonical)) => {
                    let autolink = matches!(
                        link_type,
                        pulldown_cmark::LinkType::Autolink | pulldown_cmark::LinkType::Email
                    );
                    let (frame, why) = if flat || in_image {
                        (LinkFrame::Label, Some(Unlinked::InImage))
                    } else if autolink {
                        (LinkFrame::Swallow, Some(Unlinked::Autolink))
                    } else if !canonical {
                        (LinkFrame::Label, Some(Unlinked::NotAnId))
                    } else if !marks {
                        (LinkFrame::Label, Some(Unlinked::OutsidePost))
                    } else {
                        (LinkFrame::Mark, None)
                    };
                    links.push(frame);
                    match why {
                        Some(why) => {
                            found.refused.push(Refusal { id, why });
                            Some(Event::Text(CowStr::from("")))
                        }
                        None => {
                            found.any = true;
                            Some(Event::InlineHtml(CowStr::from(mark_open(&id))))
                        }
                    }
                }
            },
            Event::End(TagEnd::Link) => match links.pop() {
                Some(LinkFrame::Mark) => Some(Event::InlineHtml(CowStr::from(MARK_CLOSE))),
                Some(LinkFrame::Label | LinkFrame::Swallow) => Some(Event::Text(CowStr::from(""))),
                Some(LinkFrame::Plain) => flat.then(|| Event::Text(CowStr::from(""))),
                None => None,
            },
            // Inside an autolink: its text is the destination.
            Event::Text(_) | Event::Code(_) | Event::InlineHtml(_) | Event::Html(_)
                if links.last() == Some(&LinkFrame::Swallow) =>
            {
                Some(Event::Text(CowStr::from("")))
            }
            // Inside a refused image only the description's text remains.
            Event::Text(_) => None,
            Event::Code(text) if flat => Some(Event::Text(CowStr::from(text.to_string()))),
            Event::SoftBreak | Event::HardBreak if flat => Some(Event::Text(CowStr::from(" "))),
            Event::Start(_)
            | Event::End(_)
            | Event::Html(_)
            | Event::InlineHtml(_)
            | Event::FootnoteReference(_)
            | Event::InlineMath(_)
            | Event::DisplayMath(_)
            | Event::Rule
            | Event::TaskListMarker(_)
                if flat =>
            {
                Some(Event::Text(CowStr::from("")))
            }
            _ => None,
        };
        if let Some(replacement) = replacement {
            *event = replacement;
        }
    }
    scrub_raw_addresses(events, &mut found);
    found
}

/// Remove every `atlas:` address that raw HTML gives an element (ADR 0173):
/// `href`, `src`, every `srcset` candidate, `poster`, `data`, `action`,
/// `formaction`, `cite`, `xlink:href` and `background`, quoted or not, in any
/// letter case and with character references decoded. The consecutive lines
/// of an HTML block are read as one, since a tag can span them. Each removal
/// is one refusal with no id: the author is told the document, never the
/// address.
fn scrub_raw_addresses(events: &mut [Event<'_>], found: &mut Marked) {
    let mut index = 0;
    while index < events.len() {
        match &events[index] {
            Event::InlineHtml(html) => {
                if let Some((clean, count)) = crate::raw_html::strip_atlas_addresses(html) {
                    events[index] = Event::InlineHtml(CowStr::from(clean));
                    note_raw_addresses(found, count);
                }
                index += 1;
            }
            Event::Html(_) => {
                let start = index;
                let mut joined = String::new();
                while let Some(Event::Html(html)) = events.get(index) {
                    joined.push_str(html);
                    index += 1;
                }
                if let Some((clean, count)) = crate::raw_html::strip_atlas_addresses(&joined) {
                    events[start] = Event::Html(CowStr::from(clean));
                    for event in &mut events[start + 1..index] {
                        *event = Event::Html(CowStr::from(""));
                    }
                    note_raw_addresses(found, count);
                }
            }
            _ => index += 1,
        }
    }
}

fn note_raw_addresses(found: &mut Marked, count: usize) {
    for _ in 0..count {
        found.refused.push(Refusal {
            id: String::new(),
            why: Unlinked::RawAddress,
        });
    }
}

/// Why a concept link is shown as plain text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Unlinked {
    /// The destination is not `atlas:` and a lowercase slug.
    NotAnId,
    /// The site does not publish a Knowledge Atlas, or its atlas could not be read.
    SiteOff,
    /// The public atlas has no entry with this id.
    NotPublished,
    /// The link is inside an image's description, which is plain text.
    InImage,
    /// An image whose address is `atlas:`: an image is never an atlas link.
    Image,
    /// An autolink (`<atlas:id>`), which has no label to show.
    Autolink,
    /// A raw `<ob-concept>` mark that is not closed in its paragraph, or whose
    /// tag is not complete: removed, with the text after it kept.
    Dropped,
    /// The link is in a page, a series description or the home introduction,
    /// which do not resolve concept links.
    OutsidePost,
    /// Raw HTML gave an element an `atlas:` address (`href`, `src`, `srcset`
    /// and the like): the attribute was removed. It has no id to report.
    RawAddress,
}

/// What became of the concept links that name one id in one post.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConceptUse {
    /// The id as written, not escaped for HTML.
    pub id: String,
    /// How many links name it.
    pub count: usize,
    /// `None` when they became links.
    pub unlinked: Option<Unlinked>,
}

impl ConceptUse {
    /// The author's diagnostic for a link shown as plain text, scoped to the
    /// file and the id. It never repeats an entry's label or any private
    /// text, and names the id only because the author wrote it.
    pub fn warning(&self, source: &str) -> Option<String> {
        self.worded(source, WARNING_MARK)
    }

    /// The diagnostic for a document that is not a post (a page, a series
    /// description or the home introduction): written once when the site
    /// loads, so a post's later resolution keeps it.
    pub fn outside_warning(&self, source: &str) -> Option<String> {
        self.worded(source, OUTSIDE_WARNING_MARK)
    }

    fn worded(&self, source: &str, lead: &str) -> Option<String> {
        let reason = match self.unlinked? {
            Unlinked::NotAnId => "the destination is not `atlas:` and an entry id (lowercase letters, digits and hyphens)".to_string(),
            Unlinked::SiteOff => "the site does not publish its Knowledge Atlas (`knowledgeAtlas.publish` is off or the atlas could not be read)".to_string(),
            Unlinked::NotPublished => "the published atlas has no entry with that id (it may be unknown, not approved or withdrawn)".to_string(),
            Unlinked::InImage => "a link cannot be inside an image's description (its alt text), which is plain text".to_string(),
            Unlinked::Image => "an image cannot have an `atlas:` address, so it is not shown; its description is shown as plain text".to_string(),
            Unlinked::Autolink => "an autolink has no label, so it shows nothing: write `[label](atlas:id)`".to_string(),
            Unlinked::Dropped => "a raw `<ob-concept>` mark that is not closed in its own paragraph was removed (write `[label](atlas:id)` instead)".to_string(),
            Unlinked::RawAddress => "raw HTML cannot carry an `atlas:` address (in `href`, `src`, `srcset`, `poster` and the like), so the attribute was removed: write `[label](atlas:id)` in Markdown, in a post".to_string(),
            Unlinked::OutsidePost => "concept links are resolved in posts only, not in pages, series descriptions or the home introduction".to_string(),
        };
        // The id as the author wrote it, cut by characters (never through an
        // escape) with anything a log or a terminal could misread replaced.
        let shown: String = self
            .id
            .chars()
            .take(40)
            .map(|c| if misleading(c) { '\u{FFFD}' } else { c })
            .collect();
        let times = if self.count > 1 {
            format!(" ({} times)", self.count)
        } else {
            String::new()
        };
        let (verb, advice) = match self.unlinked? {
            Unlinked::Autolink | Unlinked::Dropped => ("is not shown", ""),
            Unlinked::Image | Unlinked::RawAddress => ("is not shown", ""),
            _ => (
                "is shown as plain text",
                " Fix the id, approve the entry, or remove the link.",
            ),
        };
        Some(format!(
            "{source}{lead}{SCHEME}{shown}`{times} {verb}: {reason}.{advice}"
        ))
    }
}

/// Whether a log or a terminal could misread `c`: controls, and the
/// characters that reorder or hide text (bidirectional controls and
/// isolates, zero-width and invisible format characters, line and paragraph
/// separators).
fn misleading(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{061C}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

/// A post's HTML with its concept links resolved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Linked {
    pub html: String,
    /// One per id, in id order.
    pub uses: Vec<ConceptUse>,
}

/// Whether a heading is open at the end of `segment`, given whether one was
/// open before it: the last heading tag in the segment decides.
fn track_heading(in_heading: &mut bool, segment: &str) {
    for (at, _) in segment.match_indices('<') {
        let tag = &segment[at + 1..];
        let (closing, name) = match tag.strip_prefix('/') {
            Some(name) => (true, name),
            None => (false, tag),
        };
        let mut chars = name.chars();
        let heading = matches!(chars.next(), Some('h' | 'H'))
            && matches!(chars.next(), Some('1'..='6'))
            && matches!(
                chars.next(),
                Some('>' | '/') | Some(' ' | '\t' | '\n' | '\r')
            );
        if heading {
            *in_heading = !closing;
        }
    }
}

/// Record a raw mark that was removed, so the author hears of it.
fn note_drop(uses: &mut BTreeMap<(String, bool), (usize, Option<Unlinked>)>, id: &str) {
    uses.entry((id.to_string(), true))
        .or_insert((0, Some(Unlinked::Dropped)))
        .0 += 1;
}

/// Replace every concept mark in `html` with a link to the entry's page, when
/// `atlas` publishes the entry, and with the marked text otherwise. `None` is
/// a site that does not publish its atlas. Anything left of a mark (a partial
/// or forged one) is removed, so no mark ever reaches a reader.
pub fn link_html(html: &str, atlas: Option<&PublicAtlas>) -> Linked {
    let mut out = String::with_capacity(html.len());
    let mut uses: BTreeMap<(String, bool), (usize, Option<Unlinked>)> = BTreeMap::new();
    let mut rest = html;
    let mut in_heading = false;
    let mut heading_links = false;
    while let Some(at) = rest.find(MARK_PREFIX) {
        track_heading(&mut in_heading, &rest[..at]);
        out.push_str(&rest[..at]);
        let after = &rest[at + MARK_PREFIX.len()..];
        let Some(end) = after.find("\">") else {
            // A mark with no end of its tag: drop the fragment, keep the text.
            note_drop(&mut uses, "");
            rest = after;
            continue;
        };
        let id = &after[..end];
        let body = &after[end + 2..];
        // A mark is inline: it closes inside its own block. One that is not
        // closed there (an unclosed raw `<ob-concept ...>`) is dropped, so it
        // can never turn the rest of the post into a link.
        let closed = body
            .find(MARK_CLOSE)
            .filter(|close| !crosses_a_block(&body[..*close]));
        let Some(close) = closed else {
            note_drop(&mut uses, id);
            rest = body;
            continue;
        };
        let (inner, tail) = (&body[..close], &body[close + MARK_CLOSE.len()..]);
        let entry = atlas
            .and_then(|atlas| atlas.entry(id))
            .filter(|_| valid_id(id));
        let unlinked = match (&entry, atlas) {
            (Some(_), _) => None,
            _ if !valid_id(id) => Some(Unlinked::NotAnId),
            (None, None) => Some(Unlinked::SiteOff),
            (None, Some(_)) => Some(Unlinked::NotPublished),
        };
        let slot = uses.entry((id.to_string(), false)).or_insert((0, unlinked));
        slot.0 += 1;
        match entry {
            Some(entry) => {
                out.push_str(&format!(
                    "<a class=\"{LINK_CLASS}\" href=\"{}\" data-atlas-entry=\"{}\" data-atlas-kind=\"{}\"",
                    escape::attr(&entry.url),
                    escape::attr(&entry.id),
                    entry.kind.as_str()
                ));
                if in_heading {
                    // Inside a heading the hint describes the link; inline
                    // hidden text would become part of the heading's name.
                    heading_links = true;
                    out.push_str(&format!(" aria-describedby=\"{HEADING_HINT_ID}\">"));
                    out.push_str(&strip_marks(inner));
                    out.push_str("</a>");
                } else {
                    out.push('>');
                    out.push_str(&strip_marks(inner));
                    out.push_str(&format!(
                        "<span class=\"{HINT_CLASS}\">{LINK_HINT}</span></a>"
                    ));
                }
            }
            None => out.push_str(&strip_marks(inner)),
        }
        rest = tail;
    }
    out.push_str(rest);
    let mut html = strip_marks(&out);
    if heading_links {
        html.push_str(&format!(
            "\n<span id=\"{HEADING_HINT_ID}\" hidden>{HEADING_HINT}</span>"
        ));
    }
    Linked {
        html,
        uses: uses
            .into_iter()
            .map(|((id, _), (count, unlinked))| ConceptUse {
                id: unescape(&id),
                count,
                unlinked,
            })
            .collect(),
    }
}

/// The uses that [`mark_events`] refused, one per id and reason, in id order,
/// as the warnings name them.
pub(crate) fn refusal_uses(refusals: &[Refusal]) -> Vec<ConceptUse> {
    let mut counts: BTreeMap<(&str, Unlinked), usize> = BTreeMap::new();
    for refusal in refusals {
        *counts.entry((&refusal.id, refusal.why)).or_default() += 1;
    }
    counts
        .into_iter()
        .map(|((id, why), count)| ConceptUse {
            id: id.to_string(),
            count,
            unlinked: Some(why),
        })
        .collect()
}

/// A page's, series' or home introduction's HTML with its concept marks
/// replaced by their labels, and one warning per id and reason for the
/// author: these documents do not resolve concept links, and a raw `atlas:`
/// address must never reach a page. `refusals` are what the renderer already
/// refused in the document (images, autolinks and the like). `source` names
/// the document.
pub fn plain_outside_post(html: &str, refusals: &[Refusal], source: &str) -> (String, Vec<String>) {
    let linked = link_html(html, None);
    let mut uses: Vec<ConceptUse> = linked
        .uses
        .into_iter()
        .map(|mut used| {
            if used.unlinked != Some(Unlinked::Dropped) {
                used.unlinked = Some(Unlinked::OutsidePost);
            }
            used
        })
        .collect();
    uses.extend(refusal_uses(refusals));
    let warnings = uses
        .iter()
        .filter_map(|used| used.outside_warning(source))
        .collect();
    (linked.html, warnings)
}

/// Whether `html` holds a block boundary, which no inline mark can span.
fn crosses_a_block(html: &str) -> bool {
    const BLOCKS: [&str; 16] = [
        "</p>",
        "</li>",
        "</h",
        "</td>",
        "</th>",
        "</tr>",
        "</blockquote>",
        "</div>",
        "</pre>",
        "</ul>",
        "</ol>",
        "</table>",
        "<p>",
        "<p ",
        "<ul",
        "<ol",
    ];
    BLOCKS.iter().any(|tag| html.contains(tag))
}

/// The text an attribute value was escaped from ([`escape::attr`]).
fn unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// `text` without any mark tag: the renderer's own marks and any raw
/// `<ob-concept ...>` or `</ob-concept>` an author wrote, in any letter case
/// and with any attributes.
fn strip_marks(text: &str) -> String {
    scrub_raw_marks(text)
}

/// Whether `text` holds anything [`scrub_raw_marks`] would remove.
pub fn has_raw_mark(text: &str) -> bool {
    text.to_ascii_lowercase().contains("ob-concept")
}

/// `text` without the tags of the `ob-concept` element, whatever their form.
/// A tag ends at its first `>` outside a quoted value; one that never ends is
/// removed to the end of the text.
fn scrub_raw_marks(text: &str) -> String {
    if !has_raw_mark(text) {
        return text.to_string();
    }
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        let rest = &lower[cursor..];
        let start = [rest.find("<ob-concept"), rest.find("</ob-concept")]
            .into_iter()
            .flatten()
            .min();
        let Some(start) = start else { break };
        let at = cursor + start;
        out.push_str(&text[cursor..at]);
        let mut quote: Option<char> = None;
        let mut end = text.len();
        for (offset, c) in text[at..].char_indices() {
            match (quote, c) {
                (Some(q), c) if c == q => quote = None,
                (None, '"' | '\'') => quote = Some(c),
                (None, '>') => {
                    end = at + offset + 1;
                    break;
                }
                _ => {}
            }
        }
        cursor = end;
    }
    out.push_str(&text[cursor.min(text.len())..]);
    out
}

/// The Markdown of a post with each atlas link written as its label, for
/// copies that leave the site (feeds, portable exports): a copy cannot
/// resolve an entry, so it keeps the author's words and no link. Every form
/// is covered, whatever its `LinkType`:
///
/// - `[label](atlas:id "t")`, `[label][ref]`, `[label][]` and `[label]` become
///   the label (a trailing `[]` or `[ref]` is part of what is replaced);
/// - an autolink `<atlas:id>` and a reference definition are removed;
/// - an image with an `atlas:` address becomes its description's words;
/// - raw `<ob-concept ...>` marks are removed.
///
/// `None` when nothing changes, so every other post is copied as it was.
pub fn plain_markdown(markdown: &str) -> Option<String> {
    let mut current = plain_markdown_once(markdown)?;
    // An image's description can hold a link, which the first pass left in
    // the words it kept.
    for _ in 0..8 {
        match plain_markdown_once(&current) {
            Some(next) => current = next,
            None => break,
        }
    }
    Some(current)
}

fn plain_markdown_once(markdown: &str) -> Option<String> {
    let parser = Parser::new_ext(markdown, crate::markdown::parser_options(false));
    let mut edits: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    for (_, definition) in parser.reference_definitions().iter() {
        if atlas_destination(&definition.dest).is_some() {
            edits.push((definition.span.clone(), String::new()));
        }
    }
    let events: Vec<_> = Parser::new_ext(markdown, crate::markdown::parser_options(false))
        .into_offset_iter()
        .collect();
    let mut index = 0;
    while index < events.len() {
        let (event, range) = &events[index];
        let (atlas, autolink, collapsed) = match event {
            Event::Start(Tag::Link {
                dest_url,
                link_type,
                ..
            }) => (
                atlas_destination(dest_url).is_some(),
                matches!(
                    link_type,
                    pulldown_cmark::LinkType::Autolink | pulldown_cmark::LinkType::Email
                ),
                matches!(
                    link_type,
                    pulldown_cmark::LinkType::Collapsed
                        | pulldown_cmark::LinkType::CollapsedUnknown
                ),
            ),
            Event::Start(Tag::Image {
                dest_url,
                link_type,
                ..
            }) => (
                atlas_destination(dest_url).is_some(),
                false,
                matches!(
                    link_type,
                    pulldown_cmark::LinkType::Collapsed
                        | pulldown_cmark::LinkType::CollapsedUnknown
                ),
            ),
            Event::Html(_) | Event::InlineHtml(_) => {
                // The lines of one HTML block are read together, as a tag
                // can span them.
                let mut span = range.clone();
                let mut last = index;
                if matches!(event, Event::Html(_)) {
                    while let Some((Event::Html(_), next)) = events.get(last + 1) {
                        span.end = next.end;
                        last += 1;
                    }
                }
                let raw = &markdown[span.clone()];
                let marks_gone = scrub_raw_marks(raw);
                let clean = crate::raw_html::strip_atlas_addresses(&marks_gone)
                    .map_or(marks_gone, |(clean, _)| clean);
                if clean != raw {
                    edits.push((span, clean));
                }
                index = last + 1;
                continue;
            }
            _ => {
                index += 1;
                continue;
            }
        };
        if !atlas {
            index += 1;
            continue;
        }
        // The label is the source of the events between the start and the
        // matching end.
        let mut label: Option<std::ops::Range<usize>> = None;
        let mut depth = 0usize;
        let mut next = index + 1;
        while next < events.len() {
            match events[next].0 {
                Event::Start(Tag::Link { .. } | Tag::Image { .. }) => depth += 1,
                Event::End(TagEnd::Link | TagEnd::Image) if depth == 0 => break,
                Event::End(TagEnd::Link | TagEnd::Image) => depth -= 1,
                _ => {}
            }
            let inner = &events[next].1;
            label = Some(match label {
                Some(so_far) => so_far.start.min(inner.start)..so_far.end.max(inner.end),
                None => inner.clone(),
            });
            next += 1;
        }
        let text = if autolink {
            ""
        } else {
            label.map_or("", |span| &markdown[span])
        };
        let mut replaced = range.clone();
        // A collapsed construct's `[]` is part of it, though a parser may
        // end its range before it.
        if collapsed && markdown[replaced.end..].starts_with("[]") {
            replaced.end += 2;
        }
        edits.push((replaced, text.to_string()));
        index = next + 1;
    }
    if edits.is_empty() {
        return None;
    }
    edits.sort_by_key(|(range, _)| range.start);
    let mut out = String::with_capacity(markdown.len());
    let mut cursor = 0;
    for (range, replacement) in edits {
        if range.start < cursor {
            continue;
        }
        out.push_str(&markdown[cursor..range.start]);
        out.push_str(&replacement);
        cursor = range.end;
    }
    out.push_str(&markdown[cursor..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_atlas_and_a_slug_is_an_entry_id() {
        assert_eq!(entry_id("atlas:plato"), Some("plato"));
        assert_eq!(entry_id("atlas:the-republic-2"), Some("the-republic-2"));
        for bad in [
            "atlas:",
            "atlas:Plato",
            "atlas:a/b",
            "atlas:a b",
            "atlas:-a",
            "atlas:a?x",
            "ATLAS:plato",
            "/atlas/plato/",
            "https://x.test/",
        ] {
            assert_eq!(entry_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_mark_without_an_atlas_is_its_text_and_nothing_else_survives() {
        let html = format!(
            "<p>See {}Plato{} and {}x{}.</p>",
            mark_open("plato"),
            MARK_CLOSE,
            mark_open("BAD id"),
            MARK_CLOSE
        );
        let linked = link_html(&html, None);
        assert_eq!(linked.html, "<p>See Plato and x.</p>");
        assert_eq!(linked.uses.len(), 2);
        assert_eq!(linked.uses[0].id, "BAD id");
        assert_eq!(linked.uses[0].unlinked, Some(Unlinked::NotAnId));
        assert_eq!(linked.uses[1].unlinked, Some(Unlinked::SiteOff));
        // Broken or nested marks leave no mark behind.
        let broken = format!("a {}b {}c", MARK_PREFIX, mark_open("x"));
        assert!(!link_html(&broken, None).html.contains("ob-concept"));
        let stray = format!("a{MARK_CLOSE}b");
        assert_eq!(link_html(&stray, None).html, "ab");
    }

    #[test]
    fn labels_come_back_as_the_authors_words() {
        let markdown = "A [**bold** idea](atlas:idea) and [plain][r] and <atlas:auto> but `[x](atlas:code)`.\n\n[r]: atlas:ref\n";
        let plain = plain_markdown(markdown).unwrap();
        assert_eq!(
            plain,
            "A **bold** idea and plain and  but `[x](atlas:code)`.\n\n\n"
        );
        assert_eq!(
            plain_markdown("A [site](https://example.com/atlas:x)."),
            None
        );
        assert_eq!(plain_markdown("No links at all."), None);
    }
}
