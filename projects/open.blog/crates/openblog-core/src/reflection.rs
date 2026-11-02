//! Layout-independent structure of a shared reflection (ADR 0029, 0030).
//!
//! A [`ReflectionStructure`] says which parts of which drafts appear, in which rounds and under
//! which round prompts. A turn is `{ draft, part }`: the draft id is the participant id (ADR 0017),
//! and a draft splits into ordered parts at [`PART_MARKER`]. The structure holds no prose and no
//! CSS, side or position. The five requested modes are one [`ReflectionLayout`] value chosen
//! separately: changing it never touches a round, a round prompt or a word of prose.
//!
//! The reading order is the one deterministic linear order every layout and a reader without CSS
//! share. [`ReflectionStructure::reading_order_for`] is the requester-scoped, public form that goes
//! through [`DraftSet::view`]; the unscoped form is crate-private for the publish gate and
//! assembly. [`Placement`] is derived from that order for a layout and is never stored. All of it
//! is pure: parsing and validation mutate nothing, and every failure is one opaque error that
//! carries no prose, name, id or URL.

use std::collections::HashSet;
use std::fmt;

use serde::{Deserialize, Serialize};

use blake2::{Blake2s256, Digest};

use crate::collaboration::{valid_id, valid_text, CollaborationContract};
use crate::draft::DraftSet;

pub const REFLECTION_STRUCTURE_VERSION: u8 = 1;
pub const MAX_STRUCTURE_BYTES: usize = 128 * 1024;
pub const MAX_ROUNDS: usize = 200;
pub const MAX_TURNS_PER_ROUND: usize = 100;
pub const MAX_TOTAL_TURNS: usize = 1_000;
pub const MAX_ROUND_PROMPT_BYTES: usize = 1_000;
pub const MAX_PART: usize = 999;
/// The longest optional label an author may put on a turn.
pub const MAX_TURN_LABEL_BYTES: usize = 80;

/// The part marker: a line that is exactly this text (a trailing carriage return is allowed, and
/// nothing else, no indentation and no trailing spaces). It splits a draft into ordered parts. It
/// is an HTML comment so a draft that is previewed unsplit still shows nothing, but splitting
/// never parses Markdown: the marker counts even inside a code fence. A draft without it is one
/// part.
pub const PART_MARKER: &str = "<!-- openblog:part -->";

/// Split a draft into its ordered parts at every [`PART_MARKER`] line. The draft is only read.
/// Each part is an exact slice of it, the marker lines belong to no part, and joining the parts
/// with the marker lines gives the draft back byte for byte, so the digest an approval binds
/// (ADR 0020) never depends on this split. Always returns at least one part.
pub fn split_parts(markdown: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut offset = 0;
    for line in markdown.split_inclusive('\n') {
        let text = line.strip_suffix('\n').unwrap_or(line);
        if text.strip_suffix('\r').unwrap_or(text) == PART_MARKER {
            parts.push(&markdown[start..offset]);
            start = offset + line.len();
        }
        offset += line.len();
    }
    parts.push(&markdown[start..]);
    parts
}

/// The five requested presentation modes. They share one participant and contribution model.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReflectionLayout {
    #[default]
    Sequential,
    SideBySide,
    PointCounterpoint,
    AlternatingDialogue,
    Roundtable,
}

impl ReflectionLayout {
    pub const ALL: [Self; 5] = [
        Self::Sequential,
        Self::SideBySide,
        Self::PointCounterpoint,
        Self::AlternatingDialogue,
        Self::Roundtable,
    ];

    /// A stable key usable as a CSS class suffix.
    pub fn key(self) -> &'static str {
        match self {
            Self::Sequential => "sequential",
            Self::SideBySide => "side-by-side",
            Self::PointCounterpoint => "point-counterpoint",
            Self::AlternatingDialogue => "alternating-dialogue",
            Self::Roundtable => "roundtable",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReflectionStructure {
    pub version: u8,
    pub revision: u64,
    pub layout: ReflectionLayout,
    pub rounds: Vec<Round>,
}

/// One step of the reflection: an optional round prompt and the ordered turns that answer it.
/// A round prompt is a short public question or cue for the round. It is not an editor prompt
/// (ADR 0019).
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Round {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round_prompt: Option<String>,
    pub turns: Vec<Turn>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Turn {
    /// The draft id, which is the participant id that owns it (ADR 0017).
    pub draft: String,
    /// Zero-based index of the part within that draft ([`split_parts`]).
    pub part: usize,
    /// An optional, author-written label shown with the turn, such as "Point" or "Counterpoint".
    /// Nothing is assumed when it is absent: no layout invents a label, and a label is public
    /// text the authors approve with the rest of the arrangement (ADR 0032).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReflectionError {
    Invalid,
}

impl fmt::Display for ReflectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid reflection structure")
    }
}

impl std::error::Error for ReflectionError {}

/// One turn in reading order. `markdown` is `None` whenever the requester has nothing to read
/// there, whether the draft is unshared, withdrawn, unwritten or the part is blank, so the
/// placeholder is identical for all of them (ADR 0021). The entry keeps its place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadingEntry<'a> {
    /// Zero-based position in the linear order.
    pub ordinal: usize,
    pub round: usize,
    pub round_id: &'a str,
    /// Set on the first entry of a round that has a round prompt, so it is read once, before the
    /// answers.
    pub round_prompt: Option<&'a str>,
    /// The turn's own optional label.
    pub label: Option<&'a str>,
    pub participant_id: &'a str,
    pub display_name: &'a str,
    pub draft_id: &'a str,
    pub part: usize,
    pub markdown: Option<String>,
}

/// Where a layout may put an entry: a lane out of a count of lanes. It is derived, never stored,
/// and a layout with one lane reads top to bottom.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placement {
    pub lane: usize,
    pub lanes: usize,
}

impl ReflectionStructure {
    /// One round holding every part of every participant's draft, in participant order, for a
    /// publication that has not arranged anything. A participant with no draft or a withdrawn
    /// draft has no turns. It reads prose to count parts, so it is crate-private.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn from_drafts(contract: &CollaborationContract, drafts: &DraftSet) -> Self {
        let turns: Vec<Turn> = contract
            .participants
            .iter()
            .flat_map(|participant| {
                let count = drafts
                    .latest_view(&participant.id)
                    .map_or(0, |view| split_parts(&view.markdown).len());
                (0..count.min(MAX_PART + 1)).map(|part| Turn {
                    draft: participant.id.clone(),
                    part,
                    label: None,
                })
            })
            .take(MAX_TURNS_PER_ROUND)
            .collect();
        Self {
            version: REFLECTION_STRUCTURE_VERSION,
            revision: 1,
            layout: ReflectionLayout::default(),
            rounds: if turns.is_empty() {
                Vec::new()
            } else {
                vec![Round {
                    id: "round-1".into(),
                    round_prompt: None,
                    turns,
                }]
            },
        }
    }

    pub fn from_json(source: &str) -> Result<Self, ReflectionError> {
        if source.len() > MAX_STRUCTURE_BYTES {
            return Err(ReflectionError::Invalid);
        }
        let structure: Self = serde_json::from_str(source).map_err(|_| ReflectionError::Invalid)?;
        if structure.is_valid() {
            Ok(structure)
        } else {
            Err(ReflectionError::Invalid)
        }
    }

    /// Parse a whole replacement only when the caller saw the current revision. `self` is never
    /// changed, so a stale or malformed write applies nothing.
    pub fn replace_from_json(
        &self,
        source: &str,
        expected_revision: u64,
    ) -> Result<Self, ReflectionError> {
        if self.revision != expected_revision {
            return Err(ReflectionError::Invalid);
        }
        let replacement = Self::from_json(source)?;
        if expected_revision.checked_add(1) != Some(replacement.revision) {
            return Err(ReflectionError::Invalid);
        }
        Ok(replacement)
    }

    /// The same rounds, round prompts and turns presented another way. Prose is not involved.
    pub fn with_layout(&self, layout: ReflectionLayout) -> Self {
        Self {
            layout,
            ..self.clone()
        }
    }

    fn is_valid(&self) -> bool {
        if self.version != REFLECTION_STRUCTURE_VERSION
            || self.rounds.len() > MAX_ROUNDS
            || self.rounds.iter().map(|r| r.turns.len()).sum::<usize>() > MAX_TOTAL_TURNS
        {
            return false;
        }
        let mut rounds = HashSet::new();
        let mut turns = HashSet::new();
        self.rounds.iter().all(|round| {
            valid_id(&round.id)
                && rounds.insert(round.id.to_ascii_lowercase())
                && !round.turns.is_empty()
                && round.turns.len() <= MAX_TURNS_PER_ROUND
                && round
                    .round_prompt
                    .as_deref()
                    .is_none_or(|p| valid_text(p, MAX_ROUND_PROMPT_BYTES))
                && round.turns.iter().all(|turn| {
                    valid_id(&turn.draft)
                        && turn.part <= MAX_PART
                        && turn
                            .label
                            .as_deref()
                            .is_none_or(|l| valid_text(l, MAX_TURN_LABEL_BYTES))
                        && turns.insert((turn.draft.to_ascii_lowercase(), turn.part))
                })
        })
    }

    /// The unscoped reading order with every readable word, for the publish gate and assembly
    /// only, like [`DraftSet::latest_view`]: it ignores who may read what, so it is crate-private.
    pub(crate) fn reading_order<'a>(
        &'a self,
        contract: &'a CollaborationContract,
        drafts: &DraftSet,
    ) -> Result<Vec<ReadingEntry<'a>>, ReflectionError> {
        self.order(contract, |draft_id, part| {
            let Some(view) = drafts.latest_view(draft_id) else {
                return Ok(None);
            };
            let parts = split_parts(&view.markdown);
            let text = parts.get(part).ok_or(ReflectionError::Invalid)?;
            Ok(Some((*text).to_owned()))
        })
    }

    /// The reading order `requester` may see: rounds in order, turns in order, independent of
    /// [`Self::layout`]. Each turn's text comes through [`DraftSet::view`], so a draft the
    /// requester may not read, a withdrawn draft, an unwritten draft and a blank part are all the
    /// same placeholder entry (`markdown: None`), with nothing that tells them apart. Fails,
    /// returning nothing, if a turn names a participant the contract lacks, or a part that does
    /// not exist in a draft the requester can read, so a stale structure never shows part of a
    /// reflection. A part of a draft the requester cannot read is not checked, so the error says
    /// nothing about prose they may not see.
    pub fn reading_order_for<'a>(
        &'a self,
        contract: &'a CollaborationContract,
        drafts: &DraftSet,
        requester: &str,
        active: &[&str],
    ) -> Result<Vec<ReadingEntry<'a>>, ReflectionError> {
        self.order(contract, |draft_id, part| {
            let Ok(view) = drafts.view(requester, draft_id, active) else {
                return Ok(None);
            };
            let parts = split_parts(&view.markdown);
            let text = parts.get(part).ok_or(ReflectionError::Invalid)?;
            Ok(Some((*text).to_owned()))
        })
    }

    fn order<'a>(
        &'a self,
        contract: &'a CollaborationContract,
        read: impl Fn(&str, usize) -> Result<Option<String>, ReflectionError>,
    ) -> Result<Vec<ReadingEntry<'a>>, ReflectionError> {
        let mut entries = Vec::new();
        for (round_index, round) in self.rounds.iter().enumerate() {
            for (turn_index, turn) in round.turns.iter().enumerate() {
                let participant = contract
                    .participants
                    .iter()
                    .find(|p| p.id.eq_ignore_ascii_case(&turn.draft))
                    .ok_or(ReflectionError::Invalid)?;
                let markdown = read(&participant.id, turn.part)?.filter(|m| !m.trim().is_empty());
                entries.push(ReadingEntry {
                    ordinal: entries.len(),
                    round: round_index,
                    round_id: &round.id,
                    round_prompt: if turn_index == 0 {
                        round.round_prompt.as_deref()
                    } else {
                        None
                    },
                    label: turn.label.as_deref(),
                    participant_id: &participant.id,
                    display_name: &participant.display_name,
                    draft_id: &participant.id,
                    part: turn.part,
                    markdown,
                });
            }
        }
        Ok(entries)
    }

    /// A prose-free digest of everything about the arrangement an author approves: the turn
    /// order, round ids, round prompts and layout. The revision counter is left out because
    /// saving an identical arrangement changes nothing a reader sees. Once the structure is wired
    /// (ADR 0030), a later task appends this to the approval subject's metadata so any change
    /// invalidates approvals like a change to prose does (ADR 0020).
    pub fn binding_frame(&self) -> String {
        fn put(hasher: &mut Blake2s256, part: &[u8]) {
            hasher.update((part.len() as u64).to_be_bytes());
            hasher.update(part);
        }
        let mut hasher = Blake2s256::new();
        hasher.update(b"openblog-reflection-frame-v1\0");
        put(&mut hasher, self.layout.key().as_bytes());
        hasher.update((self.rounds.len() as u64).to_be_bytes());
        for round in &self.rounds {
            put(&mut hasher, round.id.as_bytes());
            match &round.round_prompt {
                Some(prompt) => {
                    hasher.update([1]);
                    put(&mut hasher, prompt.as_bytes());
                }
                None => hasher.update([0]),
            }
            hasher.update((round.turns.len() as u64).to_be_bytes());
            for turn in &round.turns {
                put(&mut hasher, turn.draft.as_bytes());
                hasher.update((turn.part as u64).to_be_bytes());
                // Only a present label adds bytes, so an arrangement without labels keeps the
                // digest it had before labels existed.
                if let Some(label) = &turn.label {
                    hasher.update([1]);
                    put(&mut hasher, label.as_bytes());
                }
            }
        }
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /// Where `layout` places each entry of `order`. Lanes follow the order participants first
    /// appear in, so no stored field and no participant is tied to a side, and any number of
    /// participants gets a placement.
    pub fn placements(layout: ReflectionLayout, order: &[ReadingEntry<'_>]) -> Vec<Placement> {
        let mut seen: Vec<&str> = Vec::new();
        for entry in order {
            if !seen.contains(&entry.participant_id) {
                seen.push(entry.participant_id);
            }
        }
        let people = seen.len().max(1);
        // A dialogue changes side when the speaker changes, never between one author's
        // consecutive turns (ADR 0032).
        let mut dialogue_lane = 0;
        let mut previous: Option<&str> = None;
        order
            .iter()
            .map(|entry| {
                let person = seen
                    .iter()
                    .position(|id| *id == entry.participant_id)
                    .unwrap_or(0);
                match layout {
                    ReflectionLayout::Sequential => Placement { lane: 0, lanes: 1 },
                    ReflectionLayout::SideBySide | ReflectionLayout::Roundtable => Placement {
                        lane: person,
                        lanes: people,
                    },
                    // Two columns only for exactly two voices. With three or more, one speaker
                    // alone against everyone else would imply a split nobody chose, so they read
                    // as one column; a withdrawn contribution leaves one honest column too.
                    ReflectionLayout::PointCounterpoint if people == 2 => Placement {
                        lane: person,
                        lanes: 2,
                    },
                    ReflectionLayout::PointCounterpoint => Placement { lane: 0, lanes: 1 },
                    ReflectionLayout::AlternatingDialogue => {
                        if previous.is_some_and(|last| last != entry.participant_id) {
                            dialogue_lane = 1 - dialogue_lane;
                        }
                        previous = Some(entry.participant_id);
                        Placement {
                            lane: dialogue_lane,
                            lanes: people.min(2),
                        }
                    }
                }
            })
            .collect()
    }
}

/// Join a draft's parts back into one text without its [`PART_MARKER`] lines, for a draft that is
/// shown whole (no structure). A draft without the marker comes back unchanged. The marker never
/// reaches rendered output (ADR 0031).
pub fn strip_part_markers(markdown: &str) -> String {
    split_parts(markdown).join("\n")
}

/// One turn handed to [`compose`]. `body` is Markdown when assembling a Post and rendered HTML
/// when building a preview; either way it is placed unchanged between the turn's own markup.
pub struct ComposedTurn<'a> {
    pub round: usize,
    pub round_prompt: Option<&'a str>,
    pub display_name: &'a str,
    pub label: Option<&'a str>,
    pub placement: Placement,
    pub body: String,
}

/// The stylesheet for [`compose`] output, identical to the rules in `web/base.css` (a test keeps
/// them equal). The preview carries it inline because it loads nothing else.
pub const LAYOUT_CSS: &str = r#"/* Shared reflections: every layout (ADR 0031, ADR 0032). The markup is already in reading
   order; this only places it, and only on wide screens. Below 48em, in print and without CSS it
   reads top to bottom in that same order. */
.ob-reflection .ob-round { margin: 1.5rem 0; }
.ob-reflection .ob-round-prompt { font-weight: 600; }
.ob-reflection .ob-turn { min-width: 0; overflow-wrap: anywhere; }
.ob-reflection .ob-turn-author { font-size: 1.1rem; margin: 0 0 .5rem; }
.ob-reflection .ob-turn-label { font-size: .9rem; font-style: italic; margin: 0 0 .5rem; }
.ob-reflection .ob-turn pre, .ob-reflection .ob-turn table { max-width: 100%; overflow-x: auto; }
.ob-reflection .ob-turn img { max-width: 100%; height: auto; }
@media screen and (min-width: 48em) {
  .ob-reflection-side-by-side.ob-lanes-2 .ob-round,
  .ob-reflection-side-by-side.ob-lanes-3 .ob-round { display: grid; gap: 1rem 2rem; align-items: start; grid-auto-flow: row; }
  .ob-reflection-side-by-side.ob-lanes-2 .ob-round { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ob-reflection-side-by-side.ob-lanes-3 .ob-round { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .ob-reflection-side-by-side .ob-round-prompt { grid-column: 1 / -1; margin: 0; }
  .ob-reflection-side-by-side .ob-lane-0 { grid-column: 1; }
  .ob-reflection-side-by-side .ob-lane-1 { grid-column: 2; }
  .ob-reflection-side-by-side .ob-lane-2 { grid-column: 3; }
  .ob-reflection-point-counterpoint.ob-lanes-2 .ob-round { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem 2rem; align-items: start; grid-auto-flow: row; }
  .ob-reflection-point-counterpoint .ob-round-prompt { grid-column: 1 / -1; margin: 0; }
  .ob-reflection-point-counterpoint .ob-lane-0 { grid-column: 1; }
  .ob-reflection-point-counterpoint .ob-lane-1 { grid-column: 2; }
  .ob-reflection-alternating-dialogue.ob-lanes-2 .ob-turn { max-width: 80%; margin: 0 0 1rem; }
  .ob-reflection-alternating-dialogue.ob-lanes-2 .ob-lane-1 { margin-inline-start: auto; }
  .ob-reflection-roundtable .ob-round { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: 1rem 2rem; align-items: start; }
  .ob-reflection-roundtable .ob-round-prompt { grid-column: 1 / -1; margin: 0; }
}
"#;

/// The widest side-by-side the styles lay out. More lanes read sequentially at every width.
pub const MAX_LAID_OUT_LANES: usize = 3;

/// Untrusted one-line text for the arrangement's own markup. Besides HTML escaping, every ASCII
/// character Markdown can act on is a numeric character reference: the portable Markdown export
/// shows this raw HTML block as literal Markdown (it escapes only `<` and `>`), so a label like
/// `[x](javascript:alert(1))` would otherwise become a live link there (ADR 0033). An HTML parser
/// and a Markdown parser both decode the references back to the same visible text.
fn markup_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            '&' | '[' | ']' | '(' | ')' | '*' | '_' | '`' | '!' | '\\' | '~' | '#' | '|' | ':'
            | '@' => {
                out.push_str(&format!("&#{};", ch as u32));
            }
            _ => out.push(ch),
        }
    }
    out
}

/// Whether `key` is a contributor registry key as the registry writes them
/// (the one rule a credit's contributor id follows, so a key a post can be
/// credited under is a key a bound turn can state), safe in an attribute.
pub(crate) fn is_contributor_key(key: &str) -> bool {
    crate::collaboration::valid_contributor_id(key)
}

/// The arranged markup shared by the published Post and the preview (ADR 0031). The DOM order is
/// exactly the order of `turns`, which is the reading order: a layout only adds classes, and
/// the stylesheet places them, so a reader without CSS, a screen reader and the narrow-width
/// layout all read the same sequence. Every turn has its own heading with the participant's name,
/// so attribution never depends on position. Names and round prompts are untrusted text and are
/// escaped here; `body` is the caller's already-safe content.
pub fn compose(layout: ReflectionLayout, turns: &[ComposedTurn<'_>]) -> String {
    compose_bound(layout, turns, &[])
}

/// The one extra class a bound turn's section carries, `ob-turn-by-<key>`
/// (ADR 0136): the contributor registry key the turn was written under, which
/// is already public in the post's credits sidecar. Only a well-formed key is
/// ever written, so an unbound turn is the safe reading of anything else.
pub const CONTRIBUTOR_CLASS_PREFIX: &str = "ob-turn-by-";

/// [`compose`] with each turn bound to its author's contributor registry key
/// (`contributors[i]` is turn `i`'s; a shorter slice leaves the rest unbound).
/// A bound body states who wrote each section itself, so reordering the
/// credits sidecar later can never move a section to another author's id.
/// With no keys the output is byte for byte what [`compose`] has always
/// written.
pub fn compose_bound(
    layout: ReflectionLayout,
    turns: &[ComposedTurn<'_>],
    contributors: &[Option<&str>],
) -> String {
    let lanes = turns.iter().map(|t| t.placement.lanes).max().unwrap_or(1);
    let mut out = format!(
        "<div class=\"ob-reflection ob-reflection-{} ob-lanes-{}\">\n\n",
        layout.key(),
        lanes.min(MAX_LAID_OUT_LANES + 1)
    );
    let mut open_round: Option<usize> = None;
    for (index, turn) in turns.iter().enumerate() {
        if open_round != Some(turn.round) {
            if open_round.is_some() {
                out.push_str("</div>\n\n");
            }
            out.push_str("<div class=\"ob-round\">\n");
            if let Some(prompt) = turn.round_prompt {
                out.push_str(&format!(
                    "<p class=\"ob-round-prompt\">{}</p>\n",
                    markup_text(prompt)
                ));
            }
            out.push('\n');
            open_round = Some(turn.round);
        }
        let label = turn.label.map_or_else(String::new, |label| {
            format!("<p class=\"ob-turn-label\">{}</p>\n", markup_text(label))
        });
        let bound = contributors
            .get(index)
            .copied()
            .flatten()
            .filter(|key| is_contributor_key(key))
            .map_or_else(String::new, |key| {
                format!(" {CONTRIBUTOR_CLASS_PREFIX}{key}")
            });
        out.push_str(&format!(
            "<section class=\"ob-turn ob-lane-{}{bound}\">\n<h2 class=\"ob-turn-author\">{}</h2>\n{}\n{}\n\n</section>\n\n",
            turn.placement.lane,
            markup_text(turn.display_name),
            label,
            turn.body.trim()
        ));
    }
    if open_round.is_some() {
        out.push_str("</div>\n\n");
    }
    out.push_str("</div>\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world() -> (CollaborationContract, DraftSet) {
        let contract = CollaborationContract::from_json(
            r#"{"version":1,"revision":1,"participants":[{"id":"p0","displayName":"A"},{"id":"p1","displayName":"B"},{"id":"p2","displayName":"C"}],"contributions":[],"reveals":[],"layout":[],"approvals":[]}"#,
        )
        .unwrap();
        let mut drafts = DraftSet::new(&["p0", "p1", "p2"]).unwrap();
        drafts
            .save("p0", "p0", 0, &format!("a\n{PART_MARKER}\nb"), 1)
            .unwrap();
        drafts.save("p1", "p1", 0, "SECRET unrevealed", 1).unwrap();
        (contract, drafts)
    }

    #[test]
    fn default_structure_lists_every_part_of_every_written_draft() {
        let (contract, drafts) = world();
        let s = ReflectionStructure::from_drafts(&contract, &drafts);
        let turns: Vec<(&str, usize)> = s.rounds[0]
            .turns
            .iter()
            .map(|t| (t.draft.as_str(), t.part))
            .collect();
        assert_eq!(turns, [("p0", 0), ("p0", 1), ("p1", 0)]);
        let empty = DraftSet::new(&["p0", "p1", "p2"]).unwrap();
        assert!(ReflectionStructure::from_drafts(&contract, &empty)
            .rounds
            .is_empty());
    }

    #[test]
    fn the_unscoped_order_reads_everything_and_marks_unwritten_turns() {
        let (contract, drafts) = world();
        let mut s = ReflectionStructure::from_drafts(&contract, &drafts);
        s.rounds[0].turns.push(Turn {
            draft: "p2".into(),
            part: 0,
            label: None,
        });
        let order = s.reading_order(&contract, &drafts).unwrap();
        let text: Vec<Option<&str>> = order.iter().map(|e| e.markdown.as_deref()).collect();
        assert_eq!(
            text,
            [Some("a\n"), Some("b"), Some("SECRET unrevealed"), None]
        );
        s.rounds[0].turns.push(Turn {
            draft: "p0".into(),
            part: 5,
            label: None,
        });
        assert!(s.reading_order(&contract, &drafts).is_err());
    }
}
