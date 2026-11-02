//! Author-approved supplements and the reading modes that reveal them
//! (ADR 0140, ADR 0141).
//!
//! A supplement is a block quote the author marks with a first line
//! `[!supplement kind=definition level=guided] Optional title`. It is part of
//! the post file, so it exists only because the author wrote it into the post
//! they publish: nothing here is generated, imported or inferred, and a draft
//! or a post that has not opted in publishes none of it as a supplement.
//!
//! A reading mode only decides which supplements are shown. It never changes
//! the canonical prose, the citations, or the order of either. Reading is in
//! two steps: [`transform`] finds each supplement, drops its marker line and
//! reports the events that belong to supplements so the renderer can keep them
//! out of the post's own prose; [`wrap`] then puts the labelled group, the
//! quote and an explicit end marker around each one, after the block
//! transforms, so a recipe never reads a list inside a supplement as its own.
//!
//! Markers that cannot be read stay ordinary block quotes, so the author's
//! words still appear, and each is reported as a [`Finding`] that names the
//! marker and nothing else.

use std::collections::HashMap;

use pulldown_cmark::{BlockQuoteKind, CowStr, Event, Parser, Tag, TagEnd};
use serde::Serialize;

use crate::escape;

/// The most supplements one post may carry; the rest stay block quotes.
pub const MAX_SUPPLEMENTS: usize = 200;
/// The deepest supplements may nest; a deeper marker stays a block quote.
pub const MAX_NESTING: usize = 3;
/// The longest kind token and supplement title, in characters.
pub const MAX_KIND_LENGTH: usize = 32;
pub const MAX_TITLE_LENGTH: usize = 120;
/// The most findings reported for one post.
pub const MAX_FINDINGS: usize = 50;
/// The largest Markdown [`scan`] reads.
pub const MAX_SCAN_BYTES: usize = 1024 * 1024;
/// The capability identifier a post with supplements reports.
pub const CAPABILITY_ID: &str = "guided-reading-supplements";
/// The prefix of every supplement id and of the one class and data names.
pub const ID_PREFIX: &str = "ob-supplement-";

/// How much supplementary context a reader chose. Local to the reader and
/// presentational only.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadingMode {
    #[default]
    Standard,
    Guided,
    DeepDive,
}

impl ReadingMode {
    pub const ALL: [ReadingMode; 3] = [Self::Standard, Self::Guided, Self::DeepDive];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Guided => "guided",
            Self::DeepDive => "deep-dive",
        }
    }

    /// Reads exactly the three names; anything else is not a mode.
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| mode.as_str() == value)
    }

    /// Whether this mode shows a supplement of `level`: standard shows none,
    /// guided shows guided ones, deep-dive shows both.
    pub fn shows(self, level: Depth) -> bool {
        match self {
            Self::Standard => false,
            Self::Guided => level == Depth::Guided,
            Self::DeepDive => true,
        }
    }
}

/// The least mode that shows a supplement.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Depth {
    Guided,
    DeepDive,
}

impl Depth {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Guided => "guided",
            Self::DeepDive => "deep-dive",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "guided" => Some(Self::Guided),
            "deep-dive" => Some(Self::DeepDive),
            _ => None,
        }
    }

    fn words(self) -> &'static str {
        match self {
            Self::Guided => "guided supplement",
            Self::DeepDive => "deep-dive supplement",
        }
    }
}

/// What a supplement offers. Any other well-formed kind is kept as written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Definition,
    Context,
    Evidence,
    Relationship,
    Comparison,
    FurtherReading,
    /// A kind this release does not know, or none was written. Still shown,
    /// still labelled, never dropped.
    Other,
}

impl Kind {
    fn known(token: &str) -> Self {
        match token {
            "definition" => Self::Definition,
            "context" => Self::Context,
            "evidence" => Self::Evidence,
            "relationship" => Self::Relationship,
            "comparison" => Self::Comparison,
            "further-reading" => Self::FurtherReading,
            _ => Self::Other,
        }
    }

    /// The depth a supplement takes when its marker names none: short
    /// explanations are guided, anything that goes further is deep-dive, and
    /// an unknown kind shows least often.
    pub fn default_depth(&self) -> Depth {
        match self {
            Self::Definition | Self::Context => Depth::Guided,
            _ => Depth::DeepDive,
        }
    }
}

/// One supplement as authored and as it will be shown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Supplement {
    /// `ob-supplement-N`, N the order in the document. Positional: it names
    /// a place in this revision of the post and must not be stored elsewhere.
    pub id: String,
    pub kind: Kind,
    /// The kind as written (`further-reading`, or an unknown token), the one
    /// the label shows.
    pub kind_token: String,
    /// The depth the marker wrote, or the kind's default.
    pub depth: Depth,
    /// Whether the marker wrote no level.
    pub depth_defaulted: bool,
    /// The depth that decides visibility: a supplement is never shown while
    /// the supplement holding it is hidden, so it is at least its parent's.
    pub effective_depth: Depth,
    /// Whether a warning or caution callout is written inside it (or inside
    /// a supplement nested in it): it is then shown in every mode, never
    /// hidden (ADR 0142).
    pub always: bool,
    pub title: Option<String>,
    /// The id of the supplement it is written inside, if any.
    pub parent: Option<String>,
    pub nesting: usize,
}

/// A marker that was not read, or a supplement the renderer adjusted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// The start of the marker line, bounded; never anything after it.
    pub marker: String,
    pub message: String,
}

/// Every supplement of one post, in document order, and what was reported.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingDepth {
    pub supplements: Vec<Supplement>,
    pub findings: Vec<Finding>,
    /// The mode the author opened the post in; standard unless the front
    /// matter says otherwise (ADR 0142). A reader's own choice overrides it.
    pub default_mode: ReadingMode,
}

impl ReadingDepth {
    /// The supplements `mode` shows, in document order. One that holds a
    /// warning is shown in every mode.
    pub fn visible(&self, mode: ReadingMode) -> Vec<&Supplement> {
        self.supplements
            .iter()
            .filter(|supplement| supplement.always || mode.shows(supplement.effective_depth))
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.supplements.is_empty()
    }
}

/// Reads the supplements of Markdown without rendering it. Markdown over
/// [`MAX_SCAN_BYTES`] reads as having none, with one finding.
pub fn scan(markdown: &str) -> ReadingDepth {
    if markdown.len() > MAX_SCAN_BYTES {
        return ReadingDepth {
            supplements: Vec::new(),
            findings: vec![Finding {
                marker: String::new(),
                message: "The Markdown is too large to read supplements from.".to_string(),
            }],
            default_mode: ReadingMode::default(),
        };
    }
    let events = Parser::new_ext(markdown, crate::markdown::parser_options(false)).collect();
    transform(events, true).depth
}

/// The result of [`transform`].
pub(crate) struct Transformed<'a> {
    pub events: Vec<Event<'a>>,
    /// Parallel to `events`: whether the event is part of a supplement.
    pub inside: Vec<bool>,
    pub depth: ReadingDepth,
}

struct Marker {
    kind_token: String,
    depth: Option<Depth>,
    title: Option<String>,
}

/// Where a supplement's block quote starts, and how its marker line ends.
struct Start {
    supplement: usize,
    resume: usize,
    whole: bool,
}

/// What reading the events of one post found, without changing them.
pub(crate) struct Analysis {
    depth: ReadingDepth,
    /// By the index of the block quote's start event.
    starts: HashMap<usize, Start>,
    /// Per event: whether it is written inside a supplement.
    inside: Vec<bool>,
    /// Headings written inside a supplement, with the supplement's index.
    headings: Vec<(usize, usize)>,
}

impl Analysis {
    /// The supplement whose block quote starts at event `index`, and the
    /// event where the rest of its first paragraph resumes.
    pub(crate) fn start_at(&self, index: usize) -> Option<(&Supplement, usize)> {
        let start = self.starts.get(&index)?;
        Some((&self.depth.supplements[start.supplement], start.resume))
    }
}

/// Reads every supplement. Nothing is wrapped or removed here: [`transform`]
/// and [`name_headings`] act on what this finds.
pub(crate) fn analyze(events: &[Event<'_>]) -> Analysis {
    let mut depth = ReadingDepth::default();
    let mut starts = HashMap::new();
    let mut inside = vec![false; events.len()];
    let mut headings = Vec::new();
    // One entry per open block quote: the supplement it is, if it is one.
    let mut quotes: Vec<Option<usize>> = Vec::new();
    // Parallel to `quotes`: whether that quote is a warning or caution callout.
    let mut safety: Vec<bool> = Vec::new();
    let mut index = 0;
    while index < events.len() {
        let nesting = quotes.iter().flatten().count();
        inside[index] = nesting > 0;
        match &events[index] {
            Event::Start(Tag::BlockQuote(None)) => {
                let read = match candidate(events, index) {
                    None => None,
                    Some(Err(finding)) => {
                        report(&mut depth, finding);
                        None
                    }
                    Some(Ok((marker, resume, whole))) => {
                        if nesting >= MAX_NESTING {
                            report(
                                &mut depth,
                                finding(&marker, "Supplements nest at most three deep."),
                            );
                            None
                        } else if depth.supplements.len() >= MAX_SUPPLEMENTS {
                            report(
                                &mut depth,
                                finding(&marker, "A post holds at most 200 supplements."),
                            );
                            None
                        } else {
                            Some((marker, resume, whole))
                        }
                    }
                };
                let Some((marker, resume, whole)) = read else {
                    quotes.push(None);
                    safety.push(false);
                    index += 1;
                    continue;
                };
                let ordinal = depth.supplements.len() + 1;
                let parent = quotes.iter().rev().flatten().next().copied();
                let kind = Kind::known(&marker.kind_token);
                let written = marker.depth;
                let own = written.unwrap_or_else(|| kind.default_depth());
                let parent_depth = parent.map(|p| depth.supplements[p].effective_depth);
                let effective = parent_depth.map_or(own, |p| p.max(own));
                // A level left to the default is not "written", so only an
                // explicit level that a parent overrides is worth reporting.
                if effective != own && written.is_some() {
                    report(
                        &mut depth,
                        Finding {
                            marker: marker_text(&marker),
                            message:
                                "Written inside a deeper supplement, so it is shown only with it."
                                    .to_string(),
                        },
                    );
                }
                depth.supplements.push(Supplement {
                    id: format!("{ID_PREFIX}{ordinal}"),
                    kind,
                    kind_token: marker.kind_token.clone(),
                    depth: own,
                    depth_defaulted: written.is_none(),
                    effective_depth: effective,
                    // Written inside a warning or caution callout: safety text
                    // is never hidden, so neither is the supplement around it.
                    always: safety.iter().any(|open| *open),
                    title: marker.title.clone(),
                    parent: parent.map(|p| depth.supplements[p].id.clone()),
                    nesting: nesting + 1,
                });
                let supplement = depth.supplements.len() - 1;
                starts.insert(
                    index,
                    Start {
                        supplement,
                        resume,
                        whole,
                    },
                );
                inside[index] = true;
                quotes.push(Some(supplement));
                safety.push(false);
                if whole {
                    // The marker was the whole paragraph: drop it entirely.
                    index = resume + 1;
                } else {
                    // The paragraph goes on after the marker line.
                    inside[index + 1] = true;
                    index = resume;
                }
                continue;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                quotes.pop();
                safety.pop();
            }
            Event::Start(Tag::BlockQuote(Some(kind))) => {
                // Safety text is never hidden: a warning or caution inside a
                // supplement keeps that supplement, and the ones holding it,
                // visible in every mode.
                if matches!(kind, BlockQuoteKind::Warning | BlockQuoteKind::Caution) {
                    for held in quotes.iter().flatten().copied().collect::<Vec<_>>() {
                        if !depth.supplements[held].always {
                            depth.supplements[held].always = true;
                            let token = depth.supplements[held].kind_token.clone();
                            report(
                                &mut depth,
                                Finding {
                                    marker: format!("[!supplement kind={token}]"),
                                    message: "Holds a warning or caution callout, so it is shown in every reading mode (information, nothing to fix)."
                                        .to_string(),
                                },
                            );
                        }
                    }
                }
                quotes.push(None);
                safety.push(matches!(
                    kind,
                    BlockQuoteKind::Warning | BlockQuoteKind::Caution
                ));
            }
            Event::Start(Tag::Heading { .. }) if nesting > 0 => {
                if let Some(held) = quotes.iter().rev().flatten().next() {
                    headings.push((index, *held));
                }
            }
            _ => {}
        }
        index += 1;
    }
    Analysis {
        depth,
        starts,
        inside,
        headings,
    }
}

/// Gives each heading written inside a supplement (and with no `{#id}` of its
/// own) an id the heading slugger cannot make, so it is a real heading with
/// its own anchor, takes no slug from the post's own headings, and is not in
/// the outline. Run before the post's heading ids are assigned.
pub(crate) fn name_headings(events: &mut [Event<'_>]) {
    let analysis = analyze(events);
    let mut counts: HashMap<usize, usize> = HashMap::new();
    for (index, supplement) in analysis.headings {
        let Event::Start(Tag::Heading { id, .. }) = &mut events[index] else {
            continue;
        };
        if id.is_none() {
            let count = counts.entry(supplement).or_default();
            *count += 1;
            *id = Some(CowStr::from(format!(
                "{ID_PREFIX}{}-h{count}",
                supplement + 1
            )));
        }
    }
}

/// The post's own ids that start with [`ID_PREFIX`] (a heading's `{#id}`, a
/// footnote label, an `id` in raw HTML), which belong to the supplements: each
/// is renamed with a `section-` prefix, in its definition and every
/// reference, and reported. Only for a post that opted in; run before
/// [`name_headings`] so the names it gives are the only ones that start so.
pub(crate) fn reserve_ids(events: &mut [Event<'_>]) -> Vec<Finding> {
    let mut findings = Vec::new();
    let renamed = |id: &str| format!("section-{id}");
    let mut note = |what: String, id: &str, how: &str| {
        if findings.len() < MAX_FINDINGS {
            findings.push(Finding {
                marker: what.chars().take(MAX_TITLE_LENGTH).collect(),
                message: format!(
                    "Uses the id `{}`, which is reserved for supplements; {how}.",
                    id.chars().take(MAX_TITLE_LENGTH).collect::<String>()
                ),
            });
        }
    };
    let mut renamed_ids = std::collections::HashSet::new();
    let mut index = 0;
    while index < events.len() {
        match &mut events[index] {
            Event::Start(Tag::Heading { id: Some(id), .. }) if id.starts_with(ID_PREFIX) => {
                let old = id.to_string();
                renamed_ids.insert(old.clone());
                *id = CowStr::from(renamed(&old));
                note(
                    format!("{{#{old}}}"),
                    &old,
                    "renamed with a section- prefix",
                );
            }
            Event::Start(Tag::FootnoteDefinition(label)) | Event::FootnoteReference(label)
                if label.starts_with(ID_PREFIX) =>
            {
                let old = label.to_string();
                renamed_ids.insert(old.clone());
                *label = CowStr::from(renamed(&old));
                // Said once, at the definition.
                if matches!(events[index], Event::Start(Tag::FootnoteDefinition(_))) {
                    note(format!("[^{old}]"), &old, "renamed with a section- prefix");
                }
            }
            Event::Html(_) | Event::InlineHtml(_) => {
                // Consecutive fragments are one piece of markup, as a browser
                // reads them.
                let start = index;
                let mut end = index;
                while matches!(
                    events.get(end + 1),
                    Some(Event::Html(_) | Event::InlineHtml(_))
                ) {
                    end += 1;
                }
                let raw: String = events[start..=end]
                    .iter()
                    .map(|event| match event {
                        Event::Html(html) | Event::InlineHtml(html) => html.as_ref(),
                        _ => "",
                    })
                    .collect();
                let mut found = crate::raw_html::id_value_ranges(&raw);
                found.retain(|(_, id)| id.starts_with(ID_PREFIX));
                if !found.is_empty() {
                    let mut text = raw.clone();
                    // The written value is renamed in place, whatever it is
                    // spelled with, so a `title=` or `data-x=` holding the
                    // same text is never the one changed.
                    for (range, _) in found.iter().rev() {
                        text.insert_str(range.start, "section-");
                    }
                    for (_, id) in &found {
                        renamed_ids.insert(id.clone());
                        note(format!("id=\"{id}\""), id, "renamed with a section- prefix");
                    }
                    if text != raw {
                        if let Event::Html(html) | Event::InlineHtml(html) = &mut events[start] {
                            *html = CowStr::from(text);
                        }
                        for event in &mut events[start + 1..=end] {
                            if let Event::Html(html) | Event::InlineHtml(html) = event {
                                *html = CowStr::from("");
                            }
                        }
                    }
                }
                index = end;
            }
            _ => {}
        }
        index += 1;
    }
    // A Markdown link written to a renamed id follows it. Raw HTML `href`s
    // are left as written (the author's own markup).
    if !renamed_ids.is_empty() {
        for event in events.iter_mut() {
            if let Event::Start(Tag::Link { dest_url, .. }) = event {
                if let Some(old) = dest_url.strip_prefix('#') {
                    if renamed_ids.contains(old) {
                        *dest_url = CowStr::from(format!("#{}", renamed(old)));
                    }
                }
            }
        }
    }
    findings
}

/// The sentinel that marks a supplement's block quote until [`wrap`] reads
/// it. It starts with a NUL, which Markdown cannot produce.
fn sentinel(ordinal: usize) -> String {
    format!("\u{0}{ID_PREFIX}{ordinal}")
}

/// The ordinal a sentinel event carries.
pub(crate) fn sentinel_ordinal(html: &str) -> Option<usize> {
    html.strip_prefix('\u{0}')?
        .strip_prefix(ID_PREFIX)?
        .parse()
        .ok()
}

/// Finds every readable supplement, drops its marker line and, with `wrap`,
/// tags its block quote with a sentinel for [`wrap`]. Every other event is as
/// it was; headings inside a supplement stay headings.
pub(crate) fn transform(events: Vec<Event<'_>>, wrap: bool) -> Transformed<'_> {
    let analysis = analyze(&events);
    let mut out: Vec<Event> = Vec::with_capacity(events.len());
    let mut inside: Vec<bool> = Vec::with_capacity(events.len());
    let mut index = 0;
    while index < events.len() {
        if let Some(start) = analysis.starts.get(&index) {
            out.push(events[index].clone());
            inside.push(true);
            if wrap {
                out.push(Event::Html(CowStr::from(sentinel(start.supplement + 1))));
                inside.push(true);
            }
            if start.whole {
                index = start.resume + 1;
            } else {
                out.push(events[index + 1].clone());
                inside.push(true);
                index = start.resume;
            }
            continue;
        }
        out.push(events[index].clone());
        inside.push(analysis.inside[index]);
        index += 1;
    }
    Transformed {
        events: out,
        inside,
        depth: analysis.depth,
    }
}

/// Puts each tagged supplement's labelled group around its block quote, with
/// an end marker after it. Run after the block transforms and the citation
/// notes, which see the quote as a quote and so never read a list in it as
/// the post's own.
pub(crate) fn wrap<'a>(events: Vec<Event<'a>>, depth: &ReadingDepth) -> Vec<Event<'a>> {
    let mut out = Vec::with_capacity(events.len() + 2 * depth.supplements.len());
    let mut quotes: Vec<Option<usize>> = Vec::new();
    let mut events = events.into_iter().peekable();
    while let Some(event) = events.next() {
        let opens = matches!(event, Event::Start(Tag::BlockQuote(None)));
        let closes = matches!(event, Event::End(TagEnd::BlockQuote(None)));
        if opens {
            let tagged = match events.peek() {
                Some(Event::Html(html)) => sentinel_ordinal(html)
                    .filter(|ordinal| (1..=depth.supplements.len()).contains(ordinal)),
                _ => None,
            };
            if let Some(ordinal) = tagged {
                events.next();
                out.push(Event::Html(CowStr::from(open_tag(
                    &depth.supplements[ordinal - 1],
                ))));
                quotes.push(Some(ordinal - 1));
            } else {
                quotes.push(None);
            }
            out.push(event);
        } else if closes {
            let held = quotes.pop().flatten();
            out.push(event);
            if let Some(held) = held {
                out.push(Event::Html(CowStr::from(close_tag(
                    &depth.supplements[held],
                ))));
            }
        } else {
            out.push(event);
        }
    }
    out
}

/// The words that open a supplement in plain text, and the line that closes
/// it, so a text copy has the same visible boundary as the page.
pub(crate) fn start_words(supplement: &Supplement) -> String {
    let mut words = format!(
        "{} supplement ({})",
        label(&supplement.kind_token),
        supplement.effective_depth.as_str()
    );
    if let Some(title) = &supplement.title {
        words.push_str(": ");
        words.push_str(title);
    }
    words.push('.');
    words
}

pub(crate) fn end_words(supplement: &Supplement) -> String {
    if supplement.kind_token == "supplement" {
        "End of supplement.".to_string()
    } else {
        format!(
            "End of {} supplement.",
            supplement.kind_token.replace('-', " ")
        )
    }
}

fn report(depth: &mut ReadingDepth, finding: Finding) {
    if depth.findings.len() < MAX_FINDINGS {
        depth.findings.push(finding);
    }
}

fn finding(marker: &Marker, message: &str) -> Finding {
    Finding {
        marker: marker_text(marker),
        message: message.to_string(),
    }
}

fn marker_text(marker: &Marker) -> String {
    format!("[!supplement kind={}]", marker.kind_token)
}

/// Looks at the block quote starting at `at`: `None` when it is not a
/// supplement marker at all, an error when it starts like one but cannot be
/// read, else the marker, the index to resume at, and whether the marker was
/// the whole first paragraph.
#[allow(clippy::type_complexity)]
fn candidate<'a>(
    events: &[Event<'a>],
    at: usize,
) -> Option<Result<(Marker, usize, bool), Finding>> {
    if !matches!(events.get(at + 1), Some(Event::Start(Tag::Paragraph))) {
        return None;
    }
    // An unescaped `[` is a text event of its own; an escaped `\[` is joined
    // to the words after it, so only the first is a marker.
    if !matches!(events.get(at + 2), Some(Event::Text(open)) if open.as_ref() == "[") {
        return None;
    }
    let mut line = String::new();
    let mut end = at + 2;
    while let Some(Event::Text(text)) = events.get(end) {
        line.push_str(text);
        end += 1;
        if line.len() > 512 {
            break;
        }
    }
    let lowered = line.to_ascii_lowercase();
    let rest = lowered.strip_prefix("[!supplement")?;
    if !(rest.starts_with(']') || rest.starts_with(char::is_whitespace)) {
        return None;
    }
    let shown = line.chars().take(60).collect::<String>();
    let bad = |message: &str| {
        Some(Err(Finding {
            marker: shown.clone(),
            message: message.to_string(),
        }))
    };
    let Some(close) = line.find(']') else {
        return bad("The marker has no closing bracket; it is shown as a block quote.");
    };
    // The line must end here: only the title text may follow the bracket.
    let line_ends = matches!(
        events.get(end),
        Some(Event::SoftBreak | Event::HardBreak | Event::End(TagEnd::Paragraph))
    );
    if !line_ends {
        return bad("Formatting after the marker is not supported; it is shown as a block quote.");
    }
    let attributes = &line["[!supplement".len()..close];
    let mut kind_token = None;
    let mut depth = None;
    for part in attributes.split_whitespace() {
        let Some((key, value)) = part.split_once('=') else {
            return bad("Marker attributes are written key=value; it is shown as a block quote.");
        };
        match key.to_ascii_lowercase().as_str() {
            "kind" => {
                let value = value.to_ascii_lowercase();
                if value.chars().count() > MAX_KIND_LENGTH {
                    return bad(
                        "The kind is longer than 32 characters; it is shown as a block quote.",
                    );
                }
                let valid = !value.is_empty()
                    && value.starts_with(|c: char| c.is_ascii_lowercase())
                    && value
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                    && !value.ends_with('-');
                if !valid || kind_token.replace(value).is_some() {
                    return bad(
                        "The kind is a lowercase word, written once; it is shown as a block quote.",
                    );
                }
            }
            "level" => match Depth::parse(&value.to_ascii_lowercase()) {
                Some(level) if depth.replace(level).is_none() => {}
                _ => return bad(
                    "The level is guided or deep-dive, written once; it is shown as a block quote.",
                ),
            },
            // Tolerant: a later release may add attributes.
            _ => {}
        }
    }
    let title = line[close + 1..].trim();
    if title.chars().count() > MAX_TITLE_LENGTH {
        return bad("The title is longer than 120 characters; it is shown as a block quote.");
    }
    let title = (!title.is_empty()).then(|| title.to_string());
    let whole = matches!(events.get(end), Some(Event::End(TagEnd::Paragraph)));
    // Resume after the line terminator: the End(Paragraph) of a marker-only
    // paragraph, or the break that separates it from the rest.
    let resume = if whole { end } else { end + 1 };
    Some(Ok((
        Marker {
            kind_token: kind_token.unwrap_or_else(|| "supplement".to_string()),
            depth,
            title,
        },
        resume,
        whole,
    )))
}

fn label(token: &str) -> String {
    let words = token.replace('-', " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

fn open_tag(supplement: &Supplement) -> String {
    let label_id = format!("{}-label", supplement.id);
    let mut html = format!(
        "<div class=\"ob-supplement\" id=\"{id}\" role=\"group\" aria-labelledby=\"{label_id}\" data-ob-supplement data-ob-kind=\"{kind}\" data-ob-level=\"{level}\"{always}>
<p class=\"ob-supplement-label\" id=\"{label_id}\"><strong class=\"ob-supplement-kind\">{name}</strong> <span class=\"ob-supplement-level\">{words}</span>",
        id = supplement.id,
        kind = supplement.kind_token,
        level = supplement.effective_depth.as_str(),
        always = if supplement.always {
            " data-ob-always"
        } else {
            ""
        },
        name = escape::text(&label(&supplement.kind_token)),
        words = supplement.effective_depth.words(),
    );
    if supplement.always {
        html.push_str(" <span class=\"ob-supplement-always\">shown in every mode</span>");
    }
    if let Some(title) = &supplement.title {
        html.push_str(&format!(
            " <span class=\"ob-supplement-title\">{}</span>",
            escape::text(title)
        ));
    }
    html.push_str(
        "</p>
",
    );
    html
}

/// What follows the quote: a visible end marker, as a structural paragraph
/// with its own emphasis so a feed reader or a page with no stylesheet still
/// shows where the supplement stops, and the group's close.
fn close_tag(supplement: &Supplement) -> String {
    format!(
        "<p class=\"ob-supplement-end\"><strong>{}</strong></p>
</div>
",
        escape::text(&end_words(supplement))
    )
}

/// What the front matter key says about reading modes (ADR 0142).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Setting {
    pub enabled: bool,
    pub default_mode: ReadingMode,
    /// Whether the post wrote a readable default mode itself. When it did
    /// not, the site's default applies (ADR 0142).
    pub default_written: bool,
    /// What to tell the author when the value was not understood.
    pub warning: Option<String>,
}

/// Reads `readingModes` tolerantly. `true`, `yes` and `on` opt in;
/// `false`, `no` and `off` opt out; a mode name, or a map such as
/// `{default: guided}`, opts in and sets the author's default mode. A map
/// opts in unless it says `enabled: false`; an unknown key is reported and
/// ignored, and a default that is not a mode is reported and read as
/// standard. Anything else is off, with a warning, so a typo
/// never publishes supplements the author did not mean to.
pub fn setting(raw: Option<&str>) -> Setting {
    let off = |warning: Option<String>| Setting {
        enabled: false,
        default_mode: ReadingMode::Standard,
        default_written: false,
        warning,
    };
    let on = |default_mode, default_written, warning| Setting {
        enabled: true,
        default_mode,
        default_written,
        warning,
    };
    let Some(raw) = raw else {
        return off(None);
    };
    let value = raw.trim().to_ascii_lowercase();
    match value.as_str() {
        "true" | "yes" | "on" => return on(ReadingMode::Standard, false, None),
        "false" | "no" | "off" => return off(None),
        _ => {}
    }
    if let Some(mode) = ReadingMode::parse(&value) {
        return on(mode, true, None);
    }
    if let Some(inner) = value
        .strip_prefix('{')
        .and_then(|rest| rest.strip_suffix('}'))
    {
        let mut default_mode = ReadingMode::Standard;
        let mut enabled = true;
        let mut written = false;
        let mut warnings: Vec<String> = Vec::new();
        for pair in inner.split(',') {
            let Some((key, wanted)) = pair.split_once(':') else {
                continue;
            };
            let key = key.trim().trim_matches(['"', char::from(39u8)]);
            let wanted = wanted.trim().trim_matches(['"', char::from(39u8)]);
            match key {
                "default" => match ReadingMode::parse(wanted) {
                    Some(mode) => {
                        default_mode = mode;
                        written = true;
                    }
                    None => {
                        // The author wrote a default: the post opens in standard,
                        // not in the site's.
                        default_mode = ReadingMode::Standard;
                        written = true;
                        warnings.push(format!(
                        "readingModes default `{}` is not standard, guided or deep-dive; the post opens in standard",
                        wanted.chars().take(40).collect::<String>()
                    ));
                    }
                },
                // `{enabled: false}` is the same as `readingModes: false`.
                "enabled" => match wanted {
                    "false" | "no" | "off" => enabled = false,
                    "true" | "yes" | "on" => enabled = true,
                    _ => warnings.push(format!(
                        "readingModes enabled `{}` is not true or false; reading modes stay on",
                        wanted.chars().take(40).collect::<String>()
                    )),
                },
                other => warnings.push(format!(
                    "readingModes key `{}` is not known (use default or enabled) and is ignored",
                    other.chars().take(40).collect::<String>()
                )),
            }
        }
        let warning = (!warnings.is_empty()).then(|| warnings.join("; "));
        if !enabled {
            return off(warning);
        }
        return on(default_mode, written, warning);
    }
    off(Some(format!(
        "readingModes `{}` is not true, false or {{default: standard|guided|deep-dive}}; reading modes are off",
        raw.trim().chars().take(40).collect::<String>()
    )))
}
