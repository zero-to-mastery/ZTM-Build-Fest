//! Published media moments: the public projection of the moments a shared reflection's authors
//! approved for the piece, and the one renderer every view of them uses (ADR 0066, 0067).
//!
//! [`PublicMoment`] is built field by field from a [`Moment`] proposed for the piece and the
//! record: where it is in its source, who noted it (a display name), the quotation's words, language
//! and attribution line ([`Moment::attribution`], which names the speaker), the participant's
//! observation and the link derived from the source ([`Moment::link`]). It has no field for a
//! quotation's rights, rights note or provenance, a participant id, a moment id, an intent or a
//! seal, so none of them can reach public output whatever renders it. Nothing here serializes a
//! [`Moment`] or a [`crate::media_moment::Quotation`].
//!
//! [`block_markdown`] writes the moments into the Post body (the gate appends it after everything
//! else, so the authors' prose and its reading order are untouched): a closed grammar of HTML frame
//! lines (`section`, `figure`, `blockquote` with the quotation's `lang`, `figcaption`) around each
//! observation's own Markdown. The native page, portable HTML and both feeds render it like any
//! other body; the combined preview renders [`moment_markdown`], the same frame, through the same
//! production renderer. [`MomentsBlock::parse`] is its exact inverse, so portable Markdown, text and
//! `llms-full.txt` state the same facts without HTML ([`PublicMoment::portable_markdown`]) and the
//! portable semantic check can require each of them. Anything that is not exactly that grammar is
//! not recognised and keeps the ordinary handling, which fails closed.

use crate::collaboration::SharedPublication;
use crate::escape;
use crate::media_moment::{human_timestamp, Moment, MomentAttribution, MomentSet};

/// The heading above every published moment, and its stable permalink.
pub const MOMENTS_HEADING: &str = "Moments in the sources";
pub const MOMENTS_ANCHOR: &str = "moments-in-the-sources";
/// Between the parts of a Post, exactly as the gate writes it.
const SECTION_BREAK: &str = "\n\n---\n\n";

const SECTION_OPEN: &str =
    "<section class=\"ob-moments\" aria-labelledby=\"moments-in-the-sources\">";
const SECTION_HEADING: &str = "<h2 id=\"moments-in-the-sources\">Moments in the sources</h2>";
const MOMENT_OPEN: &str = "<div class=\"ob-moment\" id=\"moments-in-the-sources-";
const LOCATION_OPEN: &str = "<h3>";
const NOTED_OPEN: &str = "<p class=\"ob-moment-by\">Noted by ";
const FIGURE_OPEN: &str = "<figure class=\"ob-moment-quotation\">";
const QUOTE_OPEN: &str = "<blockquote";
const CAPTION_OPEN: &str = "<figcaption>";
const LINK_OPEN: &str = "<p class=\"ob-moment-link\"><a href=\"";

/// A quotation as it is published: the words exactly as quoted, their language, and the one
/// attribution line (speaker, source, location) every view credits them with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicQuotation {
    pub text: String,
    pub language: Option<String>,
    pub attribution: String,
}

/// The moment's link as it is published: a safe absolute address derived from the source, and
/// a label that names the source and, when the link starts there, the time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicMomentLink {
    pub href: String,
    pub label: String,
}

/// Everything a reader learns about one approved moment, and nothing else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicMoment {
    /// Where the moment is: the source's title and kind, then the location in plain words, such
    /// as "The Art of Noticing (Video), from 1:02 to 1:10".
    pub location: String,
    /// The display name of the author who noted the moment and wrote its observation.
    pub noted_by: String,
    pub quotation: Option<PublicQuotation>,
    /// The author's own Markdown, already held to the observation rules (ADR 0062).
    pub observation: Option<String>,
    /// `None` when the source has no safe address: the location stays text.
    pub link: Option<PublicMomentLink>,
}

impl PublicMoment {
    /// The public face of one moment, or `None` when its source is no longer listed or its owner
    /// has no display name in the record: such a moment cannot be credited, so it is never shown.
    pub fn from_moment(moment: &Moment, record: &SharedPublication) -> Option<Self> {
        let sources = &record.sources;
        let source = sources.iter().find(|source| source.id == moment.source())?;
        let noted_by = record
            .collaboration
            .participants
            .iter()
            .find(|participant| participant.id == moment.participant())?
            .display_name
            .clone();
        let attribution = moment.attribution(sources);
        let location = MomentAttribution {
            speaker: None,
            ..attribution.clone()
        }
        .text();
        let quotation = moment.quotation().map(|quotation| PublicQuotation {
            text: quotation.text.clone(),
            language: quotation.language.clone(),
            attribution: attribution.text(),
        });
        let link = moment
            .link(sources)
            .filter(|link| crate::portability::link_is_publishable(&link.href))
            .map(|link| {
                let start = moment
                    .timestamp()
                    .filter(|_| link.at_time)
                    .map(|locator| human_timestamp(&locator.value));
                PublicMomentLink {
                    label: match start {
                        Some(start) => format!("Open {} at {start}", source.title),
                        None => format!("Open {}", source.title),
                    },
                    href: link.href,
                }
            });
        Some(Self {
            location,
            noted_by,
            quotation,
            observation: moment.observation().map(|text| text.trim().to_string()),
            link,
        })
    }

    /// The moment's frame and observation as body Markdown, numbered `ordinal` (from one) among
    /// the published moments. Every value is escaped text in the frame; the observation is the
    /// author's Markdown between frame lines, so the production renderer handles it as it does a
    /// section.
    pub fn frame_markdown(&self, ordinal: usize) -> String {
        let mut out = format!("{MOMENT_OPEN}{ordinal}\">\n");
        out.push_str(&format!(
            "{LOCATION_OPEN}{}</h3>\n",
            frame_text(&self.location)
        ));
        out.push_str(&format!("{NOTED_OPEN}{}</p>\n", frame_text(&self.noted_by)));
        if let Some(quotation) = &self.quotation {
            let lang = quotation
                .language
                .as_deref()
                .map(|language| format!(" lang=\"{}\"", escape::attr(language)))
                .unwrap_or_default();
            let words = quotation
                .text
                .split('\n')
                .map(frame_text)
                .collect::<Vec<_>>()
                .join("<br>");
            out.push_str(&format!(
                "{FIGURE_OPEN}\n{QUOTE_OPEN}{lang}><p>{words}</p></blockquote>\n{CAPTION_OPEN}{}</figcaption>\n</figure>\n",
                frame_text(&quotation.attribution)
            ));
        }
        if let Some(link) = &self.link {
            out.push_str(&format!(
                "{LINK_OPEN}{}\">{}</a></p>\n",
                escape::attr(&link.href),
                frame_text(&link.label)
            ));
        }
        if let Some(observation) = &self.observation {
            out.push('\n');
            out.push_str(observation.trim());
            out.push_str("\n\n");
        }
        out.push_str("</div>\n");
        out
    }

    /// The same facts as portable Markdown, without HTML: a heading with the moment's anchor, who
    /// noted it, the quotation as a block quote followed by its attribution line, the link (or
    /// nothing, when the source has none: the location is already in the heading), and the
    /// observation. The quotation's language has no Markdown form; portable HTML keeps it.
    pub fn portable_markdown(&self, ordinal: usize) -> String {
        let mut out = format!(
            "### {} {{#{MOMENTS_ANCHOR}-{ordinal}}}\n\nNoted by {}\n\n",
            markdown_line(&self.location),
            markdown_line(&self.noted_by)
        );
        if let Some(quotation) = &self.quotation {
            let mut quoted = String::new();
            let mut previous_blank = true;
            for line in quotation.text.split('\n').map(str::trim) {
                if line.is_empty() {
                    if !previous_blank {
                        quoted.push_str("\n>\n");
                    }
                    previous_blank = true;
                    continue;
                }
                if !previous_blank {
                    quoted.push_str("\\\n");
                }
                quoted.push_str("> ");
                quoted.push_str(&markdown_line(line));
                previous_blank = false;
            }
            let quoted = quoted.trim_end_matches(['\n', '>']).to_string();
            out.push_str(&format!(
                "{quoted}\n\n\u{2014} {}\n\n",
                markdown_line(&quotation.attribution)
            ));
        }
        if let Some(link) = &self.link {
            out.push_str(&format!(
                "[{}]({})\n\n",
                markdown_line(&link.label),
                link.href
                    .replace('\\', "\\\\")
                    .replace('(', "\\(")
                    .replace(')', "\\)")
            ));
        }
        if let Some(observation) = &self.observation {
            out.push_str(observation.trim());
            out.push_str("\n\n");
        }
        out.trim_end().to_string()
    }
}

/// The moments proposed for the piece, in the set's order (the order the approval binding
/// covers), as they will be published. For callers that have already authorized their audience:
/// the gate, after every approval passed. `None` when one cannot be credited (its source or its
/// owner is gone), which the gate refuses rather than drop a moment someone approved.
pub fn published(record: &SharedPublication, moments: &MomentSet) -> Option<Vec<PublicMoment>> {
    moments
        .publication_moments()
        .into_iter()
        .map(|moment| PublicMoment::from_moment(moment, record))
        .collect()
}

/// The single producer of a Post's moments: one labelled section holding each moment's frame in
/// order. Empty when there are none, so a piece without moments publishes byte for byte as before.
pub fn block_markdown(moments: &[PublicMoment]) -> String {
    if moments.is_empty() {
        return String::new();
    }
    let mut out = format!("{SECTION_OPEN}\n{SECTION_HEADING}\n\n");
    for (index, moment) in moments.iter().enumerate() {
        out.push_str(&moment.frame_markdown(index + 1));
        out.push('\n');
    }
    out.push_str("</section>\n");
    out
}

/// One moment's frame for the combined preview, rendered there through the production renderer
/// exactly as the page renders the block (ADR 0067).
pub fn moment_markdown(moment: &PublicMoment, ordinal: usize) -> String {
    moment.frame_markdown(ordinal)
}

/// The moments read back from a Post body, and where the rest of the body ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MomentsBlock {
    /// The body before the section break that precedes the moments: the sections and any
    /// conversation, unchanged.
    pub before: usize,
    pub moments: Vec<PublicMoment>,
}

impl MomentsBlock {
    /// The moments `markdown` ends with, exactly as [`block_markdown`] writes them after a section
    /// break, or `None` for anything else.
    pub fn parse(markdown: &str) -> Option<Self> {
        use pulldown_cmark::{Event, Parser};
        let start = markdown.find(&format!("{SECTION_BREAK}{SECTION_OPEN}\n"))?;
        let block_start = start + SECTION_BREAK.len();
        // Every raw HTML line of the block with where it sits. Text in a code block is not an
        // HTML event, so an observation that shows a frame line as code cannot be taken for one.
        let mut lines: Vec<(usize, usize, &str)> = Vec::new();
        let mut seen_open = false;
        for (event, range) in
            Parser::new_ext(markdown, crate::markdown::parser_options(false)).into_offset_iter()
        {
            if range.end <= block_start {
                continue;
            }
            match event {
                Event::Html(_) if range.start >= block_start => {
                    let block = markdown.get(range.clone())?;
                    let mut at = range.start;
                    for raw in block.split_inclusive('\n') {
                        let end = at + raw.len();
                        if !raw.trim().is_empty() {
                            lines.push((at, end, raw.trim_end()));
                        }
                        at = end;
                    }
                    seen_open = true;
                }
                // Inline HTML in the block, or anything that starts before it and runs into it
                // (an open fence or list), means this is not the block the gate wrote.
                Event::Html(_) | Event::InlineHtml(_) => return None,
                _ if range.start < block_start => return None,
                _ => {}
            }
        }
        if !seen_open {
            return None;
        }
        let blank = |from: usize, to: usize| markdown[from..to].trim().is_empty();
        let mut lines = lines.into_iter().peekable();
        let mut next = |last_end: &mut usize, consecutive: bool| -> Option<(usize, &str)> {
            let (at, end, line) = lines.next()?;
            if consecutive && !blank(*last_end, at) {
                return None;
            }
            *last_end = end;
            Some((at, line))
        };
        let mut last_end = block_start;
        let (_, line) = next(&mut last_end, true)?;
        if line != SECTION_OPEN {
            return None;
        }
        if next(&mut last_end, true)?.1 != SECTION_HEADING {
            return None;
        }
        let mut moments = Vec::new();
        loop {
            let (_, line) = next(&mut last_end, true)?;
            if line == "</section>" {
                break;
            }
            let ordinal = line.strip_prefix(MOMENT_OPEN)?.strip_suffix("\">")?;
            if ordinal != (moments.len() + 1).to_string() {
                return None;
            }
            let location = decode(element(
                next(&mut last_end, true)?.1,
                LOCATION_OPEN,
                "</h3>",
            )?)?;
            let noted_by = decode(element(next(&mut last_end, true)?.1, NOTED_OPEN, "</p>")?)?;
            let mut quotation = None;
            let mut link = None;
            let mut observation = None;
            let mut header_end = last_end;
            loop {
                let (at, line) = next(&mut last_end, false)?;
                let gap_blank = blank(header_end, at);
                if gap_blank && line == FIGURE_OPEN && quotation.is_none() && link.is_none() {
                    let (_, quote) = next(&mut last_end, true)?;
                    let rest = quote.strip_prefix(QUOTE_OPEN)?;
                    let (language, rest) = match rest.strip_prefix(" lang=\"") {
                        Some(rest) => {
                            let (language, rest) = rest.split_once('"')?;
                            (Some(decode(language)?), rest)
                        }
                        None => (None, rest),
                    };
                    let words = rest
                        .strip_prefix("><p>")?
                        .strip_suffix("</p></blockquote>")?;
                    let text = words
                        .split("<br>")
                        .map(decode)
                        .collect::<Option<Vec<_>>>()?
                        .join("\n");
                    let attribution = decode(element(
                        next(&mut last_end, true)?.1,
                        CAPTION_OPEN,
                        "</figcaption>",
                    )?)?;
                    if next(&mut last_end, true)?.1 != "</figure>" {
                        return None;
                    }
                    quotation = Some(PublicQuotation {
                        text,
                        language,
                        attribution,
                    });
                } else if gap_blank && line.starts_with(LINK_OPEN) && link.is_none() {
                    let rest = element(line, LINK_OPEN, "</a></p>")?;
                    let (href, label) = rest.split_once("\">")?;
                    link = Some(PublicMomentLink {
                        href: decode(href)?,
                        label: decode(label)?,
                    });
                } else if line == "</div>" {
                    let text = markdown[header_end..at].trim();
                    if !text.is_empty() {
                        // The observation is separated from the frame by blank lines on both
                        // sides, exactly as the frame writes it.
                        if !markdown[header_end..at].starts_with('\n')
                            || !markdown[header_end..at].ends_with("\n\n")
                        {
                            return None;
                        }
                        observation = Some(text.to_string());
                    }
                    break;
                } else {
                    return None;
                }
                header_end = last_end;
            }
            moments.push(PublicMoment {
                location,
                noted_by,
                quotation,
                observation,
                link,
            });
        }
        if moments.is_empty() || !markdown[last_end..].trim().is_empty() || lines.next().is_some() {
            return None;
        }
        Some(Self {
            before: start,
            moments,
        })
    }

    /// The moments as portable Markdown: the section heading with its anchor, then each moment.
    pub fn portable_markdown(&self) -> String {
        let mut out = format!("## {MOMENTS_HEADING} {{#{MOMENTS_ANCHOR}}}");
        for (index, moment) in self.moments.iter().enumerate() {
            out.push_str("\n\n");
            out.push_str(&moment.portable_markdown(index + 1));
        }
        out
    }
}

/// Whether a heading anchor belongs to the published moments: `moments-in-the-sources` or
/// `moments-in-the-sources-<n>`. A section or conversation heading may not claim one.
pub fn is_reserved_anchor(id: &str) -> bool {
    let id = id.trim().to_ascii_lowercase();
    match id.strip_prefix(MOMENTS_ANCHOR) {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('-')
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())),
        None => false,
    }
}

fn element<'a>(line: &'a str, open: &str, close: &str) -> Option<&'a str> {
    line.strip_prefix(open)?.strip_suffix(close)
}

/// Untrusted one-line text in the frame. Besides HTML escaping, the characters that open Markdown
/// links, emphasis, code and escapes are character references (as in the reflection frame, ADR
/// 0033), so even a literal view of the frame can never form a link or markup, while the words a
/// reader sees, such as "(Video), at 1:02", stay as they are in the page source.
fn frame_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '[' | ']' | '*' | '_' | '`' | '!' | '\\' | '~' => {
                out.push_str(&format!("&#{};", character as u32));
            }
            _ => escape::push_text(&mut out, character.encode_utf8(&mut [0; 4])),
        }
    }
    out
}

fn decode(value: &str) -> Option<String> {
    crate::arrangement::decode_text(value)
}

/// One line of public text as portable Markdown: whitespace is collapsed, and every character
/// that could start or change Markdown markup is escaped, including a line-start list or heading
/// marker, so a title, a name, an attribution or a quoted line stays text.
fn markdown_line(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::with_capacity(normalized.len());
    for (index, character) in normalized.chars().enumerate() {
        let at_start = index == 0;
        if matches!(
            character,
            '\\' | '['
                | ']'
                | '*'
                | '_'
                | '~'
                | '`'
                | '#'
                | '>'
                | '|'
                | '<'
                | '&'
                | '{'
                | '}'
                | '!'
        ) || (at_start && matches!(character, '-' | '+' | '='))
        {
            out.push('\\');
        }
        out.push(character);
    }
    // "1. text" or "1) text" at the start of a line would be a list item.
    let digits = out.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && matches!(out.as_bytes().get(digits), Some(b'.') | Some(b')')) {
        out.insert(digits, '\\');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moment(observation: Option<&str>, quotation: Option<&str>) -> PublicMoment {
        PublicMoment {
            location: "The Art of Noticing (Video), from 1:02 to 1:10".into(),
            noted_by: "Ann <Ames> & [Co](javascript:x)".into(),
            quotation: quotation.map(|text| PublicQuotation {
                text: text.into(),
                language: Some("fr".into()),
                attribution: "The host, in The Art of Noticing (Video), from 1:02 to 1:10".into(),
            }),
            observation: observation.map(str::to_string),
            link: Some(PublicMomentLink {
                href: "https://www.youtube.com/watch?v=abcdefghijk&t=62s".into(),
                label: "Open The Art of Noticing at 1:02".into(),
            }),
        }
    }

    fn body(moments: &[PublicMoment]) -> String {
        format!("Ann words.{SECTION_BREAK}{}", block_markdown(moments))
    }

    #[test]
    fn the_block_reads_back_exactly() {
        let moments = vec![
            moment(
                Some("I *noticed* [this](https://example.org/a)."),
                Some("Line one\n\n  Line <two> & *three*\n- four"),
            ),
            moment(None, Some("Only words")),
            moment(Some("Only my words."), None),
            PublicMoment {
                link: None,
                quotation: None,
                ..moment(Some("No link at all."), None)
            },
        ];
        let markdown = body(&moments);
        let block = MomentsBlock::parse(&markdown).expect("parses");
        assert_eq!(block.moments, moments);
        assert_eq!(&markdown[..block.before], "Ann words.");
    }

    #[test]
    fn anything_else_is_not_recognised() {
        let good = body(&[moment(Some("Mine."), Some("Words"))]);
        assert!(MomentsBlock::parse(&good).is_some());
        for broken in [
            good.replace("<figcaption>", "<figcaption class=\"x\">"),
            good.replace(
                "id=\"moments-in-the-sources-1\"",
                "id=\"moments-in-the-sources-2\"",
            ),
            good.replace("</section>\n", "</section>\n\nMore."),
            good.replace("Mine.", "Mine <b>bold</b>."),
            good.replace("Mine.", "```\nMine."),
            good.replace(SECTION_BREAK, "\n\n"),
            format!("```\n{good}"),
            good.replace("</div>", ""),
        ] {
            assert!(MomentsBlock::parse(&broken).is_none(), "{broken}");
        }
        assert!(MomentsBlock::parse("Just prose.").is_none());
    }

    #[test]
    fn hostile_values_stay_text_in_every_form() {
        let mut hostile = moment(Some("Mine."), Some("[x](javascript:alert(1)) <script>"));
        hostile.location = "1. <img src=x onerror=alert(1)> {#evil}".into();
        let markdown = body(std::slice::from_ref(&hostile));
        assert!(!markdown.contains("<script>") && !markdown.contains("<img"));
        assert!(!markdown.contains("](javascript"));
        let block = MomentsBlock::parse(&markdown).unwrap();
        assert_eq!(block.moments[0], hostile);
        let portable = block.portable_markdown();
        let html = {
            let mut html = String::new();
            pulldown_cmark::html::push_html(
                &mut html,
                pulldown_cmark::Parser::new_ext(&portable, crate::markdown::parser_options(false)),
            );
            html
        };
        assert!(!html.contains("<script") && !html.contains("<img") && !html.contains("<ol"));
        assert!(!html.contains("href=\"javascript"), "{html}");
        assert!(html.contains("id=\"moments-in-the-sources-1\""), "{html}");
    }

    #[test]
    fn reserved_anchors_are_exactly_the_generated_ones() {
        assert!(is_reserved_anchor("moments-in-the-sources"));
        assert!(is_reserved_anchor("Moments-In-The-Sources-12"));
        assert!(!is_reserved_anchor("moments-in-the-sources-"));
        assert!(!is_reserved_anchor("moments-in-the-sources-a"));
        assert!(!is_reserved_anchor("moments"));
    }
}
