//! The arrangement of a published reflection, read back from the Post's authored Markdown so the
//! portable projections can state it without a layout, a class or a stylesheet (ADR 0033).
//!
//! [`Arrangement::parse`] is the exact inverse of [`crate::reflection::compose`] for a Markdown
//! body and nothing more: a closed grammar over the lines `compose` writes. Anything else (a
//! stray tag, text between sections, an unknown layout, an entity `compose` never writes) is not
//! recognised and the body keeps the ordinary portable handling, which fails closed. Turn bodies
//! are never interpreted here: they are the participants' own Markdown, returned unchanged.

use pulldown_cmark::{Event, Parser};

use crate::reflection::ReflectionLayout;

/// One turn: the author's heading, the optional label and the author's own Markdown.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArrangedTurn {
    pub author: String,
    pub label: Option<String>,
    pub body: String,
    /// The contributor registry key the section was composed under, when the
    /// body states it (ADR 0136). Older bodies do not.
    pub contributor: Option<String>,
}

/// One round: an optional prompt and the turns that answer it, in reading order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArrangedRound {
    pub prompt: Option<String>,
    pub turns: Vec<ArrangedTurn>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Arrangement {
    pub layout: ReflectionLayout,
    pub rounds: Vec<ArrangedRound>,
    /// What follows the arrangement in the Post, after the section break the gate writes: the
    /// approved continuing conversation (ADR 0026). Ordinary Markdown, returned unchanged.
    pub trailing: Option<String>,
}

const ROOT_OPEN: &str = "<div class=\"ob-reflection ob-reflection-";
const ROUND_OPEN: &str = "<div class=\"ob-round\">";
const PROMPT_OPEN: &str = "<p class=\"ob-round-prompt\">";
const SECTION_OPEN: &str = "<section class=\"ob-turn ob-lane-";
const AUTHOR_OPEN: &str = "<h2 class=\"ob-turn-author\">";
const LABEL_OPEN: &str = "<p class=\"ob-turn-label\">";

/// Undo exactly the escaping `compose` applies to a name, label or prompt (named references for
/// `< > "` and numeric ones for the rest). Any other `&` or a raw angle bracket is refused.
pub(crate) fn decode_text(input: &str) -> Option<String> {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(at) = rest.find(['&', '<', '>']) {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        if !rest.starts_with('&') {
            return None;
        }
        let end = rest.find(';')?;
        match &rest[1..end] {
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "amp" => out.push('&'),
            entity => {
                let digits = entity.strip_prefix('#')?;
                if digits.is_empty()
                    || digits.len() > 7
                    || !digits.bytes().all(|b| b.is_ascii_digit())
                {
                    return None;
                }
                out.push(char::from_u32(digits.parse().ok()?)?);
            }
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

fn element<'a>(line: &'a str, open: &str, close: &str) -> Option<&'a str> {
    line.strip_prefix(open)?.strip_suffix(close)
}

fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

enum Stage {
    Outside,
    Root,
    Round,
    Section,
    Named,
    Done,
}

impl Arrangement {
    /// The arrangement `markdown` was composed from, or `None` when it is anything else.
    pub fn parse(markdown: &str) -> Option<Self> {
        let blank = |text: &str| text.trim().is_empty();
        // Every raw HTML line with where it sits. Text inside a code block is not an HTML event,
        // so a turn that shows `</section>` as code cannot be mistaken for the frame.
        let mut lines: Vec<(usize, usize, &str)> = Vec::new();
        for (event, range) in
            Parser::new_ext(markdown, crate::markdown::parser_options(false)).into_offset_iter()
        {
            match event {
                Event::InlineHtml(_) => return None,
                Event::Html(_) => {
                    let block = markdown.get(range.clone())?;
                    let mut start = range.start;
                    for raw in block.split_inclusive('\n') {
                        let end = start + raw.len();
                        if !raw.trim().is_empty() {
                            lines.push((start, end, raw.trim_end()));
                        }
                        start = end;
                    }
                }
                _ => {}
            }
        }

        let mut layout = None;
        let mut rounds: Vec<ArrangedRound> = Vec::new();
        let mut stage = Stage::Outside;
        let mut last_end = 0;
        let mut author = String::new();
        let mut label: Option<String> = None;
        let mut contributor: Option<String> = None;
        for (start, end, line) in lines {
            let gap_blank = blank(&markdown[last_end..start]);
            match stage {
                Stage::Outside => {
                    let rest = line.strip_prefix(ROOT_OPEN)?.strip_suffix("\">")?;
                    let (key, lanes) = rest.split_once(" ob-lanes-")?;
                    if !gap_blank || !digits(lanes) {
                        return None;
                    }
                    layout = Some(*ReflectionLayout::ALL.iter().find(|l| l.key() == key)?);
                    stage = Stage::Root;
                }
                Stage::Root if gap_blank && line == ROUND_OPEN => {
                    rounds.push(ArrangedRound {
                        prompt: None,
                        turns: Vec::new(),
                    });
                    stage = Stage::Round;
                }
                Stage::Root if gap_blank && line == "</div>" => stage = Stage::Done,
                Stage::Round if gap_blank && line == "</div>" => stage = Stage::Root,
                Stage::Round if gap_blank && line.starts_with(PROMPT_OPEN) => {
                    let round = rounds.last_mut()?;
                    if round.prompt.is_some() || !round.turns.is_empty() {
                        return None;
                    }
                    round.prompt = Some(decode_text(element(line, PROMPT_OPEN, "</p>")?)?);
                }
                Stage::Round if gap_blank && line.starts_with(SECTION_OPEN) => {
                    let rest = line.strip_prefix(SECTION_OPEN)?.strip_suffix("\">")?;
                    let prefix = format!(" {}", crate::reflection::CONTRIBUTOR_CLASS_PREFIX);
                    let (lane, bound) = match rest.split_once(prefix.as_str()) {
                        Some((lane, key)) => {
                            if !crate::reflection::is_contributor_key(key) {
                                return None;
                            }
                            (lane, Some(key.to_string()))
                        }
                        None => (rest, None),
                    };
                    if !digits(lane) {
                        return None;
                    }
                    contributor = bound;
                    stage = Stage::Section;
                }
                Stage::Section if gap_blank => {
                    author = decode_text(element(line, AUTHOR_OPEN, "</h2>")?)?;
                    stage = Stage::Named;
                }
                Stage::Named if gap_blank && label.is_none() && line.starts_with(LABEL_OPEN) => {
                    label = Some(decode_text(element(line, LABEL_OPEN, "</p>")?)?);
                }
                Stage::Named if line == "</section>" => {
                    // The header lines end where `last_end` stands; the author's text follows.
                    let body = markdown[last_end..start].trim();
                    if body.is_empty() {
                        return None;
                    }
                    rounds.last_mut()?.turns.push(ArrangedTurn {
                        author: std::mem::take(&mut author),
                        label: label.take(),
                        contributor: contributor.take(),
                        body: body.to_string(),
                    });
                    stage = Stage::Round;
                }
                _ => return None,
            }
            last_end = end;
        }
        match stage {
            Stage::Done if !rounds.is_empty() => {
                // Only the arrangement, or the arrangement and then, after exactly the section
                // break `assemble` writes, more Markdown (no raw HTML: any further HTML line was
                // refused above, and inline HTML anywhere refuses the whole body).
                let rest = &markdown[last_end..];
                let trailing = if blank(rest) {
                    None
                } else {
                    let after = rest.strip_prefix("\n\n---\n\n")?.trim();
                    (!after.is_empty()).then(|| after.to_string())
                };
                Some(Self {
                    layout: layout?,
                    rounds,
                    trailing,
                })
            }
            _ => None,
        }
    }

    /// The turns in reading order, across rounds.
    pub fn turns(&self) -> impl Iterator<Item = &ArrangedTurn> {
        self.rounds.iter().flat_map(|round| round.turns.iter())
    }

    /// The arrangement as plain labeled sections in reading order: each round prompt, then each
    /// turn under a heading with its author's name, its label and the author's own Markdown.
    /// `text` makes an untrusted one-line value safe as Markdown text. The layout is not stated
    /// here (it is reported as a diagnostic): the words, names, labels and order are all of it.
    pub fn to_markdown(&self, text: impl Fn(&str) -> String) -> String {
        let mut out = String::new();
        for round in &self.rounds {
            if let Some(prompt) = &round.prompt {
                out.push_str(&format!("**{}**\n\n", text(prompt)));
            }
            for turn in &round.turns {
                out.push_str(&format!("## {}\n\n", text(&turn.author)));
                if let Some(label) = &turn.label {
                    out.push_str(&format!("*{}*\n\n", text(label)));
                }
                out.push_str(turn.body.trim());
                out.push_str("\n\n");
            }
        }
        if let Some(trailing) = &self.trailing {
            out.push_str("---\n\n");
            out.push_str(trailing);
        }
        out.trim_end().to_string()
    }
}
