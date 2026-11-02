//! Folding a validated voice-guide proposal into the saved guide (ADR 0288, #423).
//!
//! Pure and deterministic. The saved guide is read back into its traits and the free text around
//! them; the proposal only adds traits or changes saved ones. A saved trait the proposal does not
//! address is kept word for word, a changed trait is shown with both texts until the author picks
//! one, and text outside the trait format is kept where it was. The same saved guide, proposal and
//! choices always give the same bytes.

use serde_json::{json, Value as Json};

use super::guide::{
    trait_json, Trait, VoiceGuide, ONE_SAMPLE_MARKER, PROVENANCE_MARKER, SECTIONS, UNKNOWN_HEADING,
};

/// The title a guide gets when the saved one has none.
pub const DEFAULT_TITLE: &str = "# Voice guide";
/// The line an empty "What is not yet known" section shows.
pub const NOTHING_FLAGGED: &str = "_Nothing is flagged yet._";

/// One of the fixed sections of a saved guide: its traits and any other lines under its heading.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SavedSection {
    pub id: &'static str,
    pub traits: Vec<Trait>,
    /// Lines under the heading that are not traits, blank edges removed.
    pub notes: Vec<String>,
}

/// A section the author added under a heading of their own, kept verbatim.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnSection {
    pub heading: String,
    pub lines: Vec<String>,
}

/// A saved guide read back into the trait schema and the free text around it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SavedGuide {
    pub title: Option<String>,
    /// Lines between the title and the first section heading.
    pub preamble: Vec<String>,
    pub sections: Vec<SavedSection>,
    pub own: Vec<OwnSection>,
    pub unknown: Vec<String>,
    /// Lines under "What is not yet known" that are not items.
    pub unknown_notes: Vec<String>,
}

fn trim_blank_edges(lines: &mut Vec<String>) {
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    let leading = lines.iter().take_while(|l| l.trim().is_empty()).count();
    lines.drain(..leading);
}

/// Read one rendered trait bullet back: `- <statement>: "<quote>" (<file>.md)`, optionally followed
/// by ` (one sample)`. Anything else, including a hand-written bullet, is not a trait.
pub fn parse_trait_line(line: &str) -> Option<Trait> {
    let bullet = line.trim_end().strip_prefix("- ")?;
    let (rest, one_sample) = match bullet.strip_suffix(ONE_SAMPLE_MARKER) {
        Some(rest) => (rest.strip_suffix(' ')?, true),
        None => (bullet, false),
    };
    let rest = rest.strip_suffix(')')?;
    let open = rest.rfind(" (")?;
    let sample = &rest[open + 2..];
    if !sample.ends_with(".md") || sample.contains(['(', ')', ' ', '"']) {
        return None;
    }
    let body = rest[..open].strip_suffix('"')?;
    let at = body.find(": \"")?;
    let (statement, quote) = (&body[..at], &body[at + 3..]);
    if statement.trim().is_empty()
        || quote.is_empty()
        || line.chars().any(char::is_control)
        || statement.starts_with(' ')
    {
        return None;
    }
    Some(Trait {
        statement: statement.to_string(),
        quote: quote.to_string(),
        sample: sample.to_string(),
        one_sample,
        replaces: None,
    })
}

enum Place {
    Preamble,
    Known(usize),
    Unknown,
    Own(usize),
}

impl SavedGuide {
    /// Read a saved guide. Tolerant: whatever is not a title, a provenance line, a section heading,
    /// a trait or an unknown item is free text and is kept where it sits.
    pub fn parse(markdown: &str) -> Self {
        let mut guide = SavedGuide::default();
        let mut place = Place::Preamble;
        for raw in markdown.lines() {
            let line = raw.trim_end();
            if line.trim_start().starts_with(PROVENANCE_MARKER) {
                continue;
            }
            if matches!(place, Place::Preamble)
                && guide.title.is_none()
                && guide.preamble.iter().all(|l| l.trim().is_empty())
                && line.starts_with("# ")
            {
                guide.title = Some(line.to_string());
                continue;
            }
            if let Some(heading) = line.strip_prefix("## ") {
                let heading = heading.trim();
                place = if heading == UNKNOWN_HEADING {
                    Place::Unknown
                } else if let Some((id, _)) = SECTIONS.iter().find(|(_, h)| *h == heading) {
                    match guide.sections.iter().position(|s| s.id == *id) {
                        Some(at) => Place::Known(at),
                        None => {
                            guide.sections.push(SavedSection {
                                id,
                                ..SavedSection::default()
                            });
                            Place::Known(guide.sections.len() - 1)
                        }
                    }
                } else {
                    guide.own.push(OwnSection {
                        heading: line.to_string(),
                        lines: Vec::new(),
                    });
                    Place::Own(guide.own.len() - 1)
                };
                continue;
            }
            match place {
                Place::Preamble => guide.preamble.push(line.to_string()),
                Place::Known(at) => match parse_trait_line(line) {
                    Some(found) => guide.sections[at].traits.push(found),
                    None => guide.sections[at].notes.push(line.to_string()),
                },
                Place::Unknown => match line.strip_prefix("- ").map(str::trim) {
                    _ if line.trim() == NOTHING_FLAGGED => {}
                    Some(item) if !item.is_empty() => guide.unknown.push(item.to_string()),
                    _ => guide.unknown_notes.push(line.to_string()),
                },
                Place::Own(at) => guide.own[at].lines.push(line.to_string()),
            }
        }
        trim_blank_edges(&mut guide.preamble);
        trim_blank_edges(&mut guide.unknown_notes);
        for section in &mut guide.sections {
            // Blank lines between traits are layout, not notes.
            trim_blank_edges(&mut section.notes);
        }
        for own in &mut guide.own {
            trim_blank_edges(&mut own.lines);
        }
        guide
    }

    /// The saved traits under one section id.
    pub fn traits_of(&self, id: &str) -> &[Trait] {
        self.sections
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.traits.as_slice())
            .unwrap_or(&[])
    }

    /// Whether the guide has text outside the trait schema.
    pub fn has_free_text(&self) -> bool {
        !self.preamble.is_empty()
            || !self.own.is_empty()
            || !self.unknown_notes.is_empty()
            || self.sections.iter().any(|s| !s.notes.is_empty())
    }

    /// The sample files the saved traits cite, sorted, once each.
    pub fn cited_samples(&self) -> Vec<&str> {
        let mut files: Vec<&str> = self
            .sections
            .iter()
            .flat_map(|s| s.traits.iter().map(|t| t.sample.as_str()))
            .collect();
        files.sort_unstable();
        files.dedup();
        files
    }
}

/// Which text of a changed trait the author keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    /// Keep the saved guide's trait.
    Current,
    /// Take the proposal's trait.
    Proposed,
}

/// What became of one trait in the merge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// A saved trait the proposal did not address, kept word for word.
    Kept,
    /// A saved trait the proposal repeated exactly.
    Unchanged,
    /// A saved trait the proposal changes; the author picks one. `change` numbers the changes in
    /// the order they appear in the guide.
    Changed { change: usize, proposed: Trait },
    /// A new trait from the proposal.
    Added,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergedTrait {
    /// The saved trait, or for `Added` the proposed one.
    pub item: Trait,
    pub status: Status,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergedSection {
    pub id: &'static str,
    pub heading: &'static str,
    pub traits: Vec<MergedTrait>,
    pub notes: Vec<String>,
}

/// Whether a saved trait's quote was found again in the sample it cites.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuoteCheck {
    Verified,
    /// The sample exists but no longer contains the quote word for word.
    NotInSample,
    /// The cited sample no longer exists. The trait is kept and flagged, never dropped.
    SampleMissing,
}

impl QuoteCheck {
    /// Check a trait's quote against the text of the sample it cites, if that sample exists.
    pub fn of(item: &Trait, sample_text: Option<&str>) -> Self {
        match sample_text {
            Some(text) if text.contains(&item.quote) => QuoteCheck::Verified,
            Some(_) => QuoteCheck::NotInSample,
            None => QuoteCheck::SampleMissing,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            QuoteCheck::Verified => "verified",
            QuoteCheck::NotInSample => "not-in-sample",
            QuoteCheck::SampleMissing => "sample-missing",
        }
    }
}

/// One line of the merged guide: fixed text, or a changed trait that needs the author's choice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Line {
    Text(String),
    Choice {
        change: usize,
        current: String,
        proposed: String,
    },
}

/// The saved guide with a proposal folded in, before the author's choices.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergedGuide {
    pub title: String,
    pub preamble: Vec<String>,
    /// Every fixed section, in the fixed order, empty ones included.
    pub sections: Vec<MergedSection>,
    pub own: Vec<OwnSection>,
    /// The unknown items and whether each was already in the saved guide.
    pub unknown: Vec<(String, bool)>,
    pub unknown_notes: Vec<String>,
    pub changes: usize,
    pub free_text: bool,
}

/// Fold a proposal into a saved guide. The proposal must have been validated against this saved
/// guide (`VoiceGuide::from_json_against`), so every `replaces` names a saved trait once.
pub fn merge(saved: &SavedGuide, proposal: &VoiceGuide) -> MergedGuide {
    let mut changes = 0;
    let sections = SECTIONS
        .iter()
        .map(|(id, heading)| {
            let proposed = proposal
                .sections
                .iter()
                .find(|s| s.id == *id)
                .map(|s| s.traits.as_slice())
                .unwrap_or(&[]);
            let saved_section = saved.sections.iter().find(|s| s.id == *id);
            let mut traits = Vec::new();
            for old in saved_section.map(|s| s.traits.as_slice()).unwrap_or(&[]) {
                let status = if let Some(new) = proposed
                    .iter()
                    .find(|t| t.replaces.as_deref() == Some(old.statement.as_str()))
                {
                    changes += 1;
                    Status::Changed {
                        change: changes - 1,
                        proposed: Trait {
                            replaces: None,
                            ..new.clone()
                        },
                    }
                } else if proposed
                    .iter()
                    .any(|t| t.replaces.is_none() && t.same_claim(old))
                {
                    Status::Unchanged
                } else {
                    Status::Kept
                };
                traits.push(MergedTrait {
                    item: old.clone(),
                    status,
                });
            }
            let saved_traits = saved.traits_of(id);
            for new in proposed {
                let addresses_saved =
                    new.replaces.is_some() || saved_traits.iter().any(|old| old.same_claim(new));
                if !addresses_saved {
                    traits.push(MergedTrait {
                        item: new.clone(),
                        status: Status::Added,
                    });
                }
            }
            MergedSection {
                id,
                heading,
                traits,
                notes: saved_section.map(|s| s.notes.clone()).unwrap_or_default(),
            }
        })
        .collect();
    let mut unknown: Vec<(String, bool)> = saved
        .unknown
        .iter()
        .map(|item| (item.clone(), true))
        .collect();
    for item in &proposal.unknown {
        if !unknown.iter().any(|(known, _)| known == item) {
            unknown.push((item.clone(), false));
        }
    }
    MergedGuide {
        title: saved
            .title
            .clone()
            .unwrap_or_else(|| DEFAULT_TITLE.to_string()),
        preamble: saved.preamble.clone(),
        sections,
        own: saved.own.clone(),
        unknown,
        unknown_notes: saved.unknown_notes.clone(),
        changes,
        free_text: saved.has_free_text(),
    }
}

impl MergedGuide {
    /// The guide as lines, with the provenance comment (if any) under the title.
    pub fn lines(&self, provenance: Option<&str>) -> Vec<Line> {
        let text = |s: &str| Line::Text(s.to_string());
        let mut out = vec![text(&self.title)];
        if let Some(line) = provenance {
            out.push(text(line));
        }
        if !self.preamble.is_empty() {
            out.push(text(""));
            out.extend(self.preamble.iter().map(|l| text(l)));
        }
        for section in &self.sections {
            if section.traits.is_empty() && section.notes.is_empty() {
                continue;
            }
            out.push(text(""));
            out.push(text(&format!("## {}", section.heading)));
            out.push(text(""));
            for merged in &section.traits {
                out.push(match &merged.status {
                    Status::Changed { change, proposed } => Line::Choice {
                        change: *change,
                        current: merged.item.line(),
                        proposed: proposed.line(),
                    },
                    _ => Line::Text(merged.item.line()),
                });
            }
            if !section.notes.is_empty() {
                if !section.traits.is_empty() {
                    out.push(text(""));
                }
                out.extend(section.notes.iter().map(|l| text(l)));
            }
        }
        for own in &self.own {
            out.push(text(""));
            out.push(text(&own.heading));
            if !own.lines.is_empty() {
                out.push(text(""));
                out.extend(own.lines.iter().map(|l| text(l)));
            }
        }
        out.push(text(""));
        out.push(text(&format!("## {UNKNOWN_HEADING}")));
        out.push(text(""));
        if self.unknown.is_empty() {
            out.push(text(NOTHING_FLAGGED));
        } else {
            out.extend(
                self.unknown
                    .iter()
                    .map(|(item, _)| text(&format!("- {item}"))),
            );
        }
        if !self.unknown_notes.is_empty() {
            out.push(text(""));
            out.extend(self.unknown_notes.iter().map(|l| text(l)));
        }
        out
    }

    /// The guide as Markdown, with `choose` deciding each change.
    pub fn render(&self, provenance: Option<&str>, choose: impl Fn(usize) -> Choice) -> String {
        let mut markdown: String = self
            .lines(provenance)
            .into_iter()
            .map(|line| match line {
                Line::Text(text) => text,
                Line::Choice {
                    change,
                    current,
                    proposed,
                } => match choose(change) {
                    Choice::Current => current,
                    Choice::Proposed => proposed,
                },
            })
            .collect::<Vec<_>>()
            .join("\n");
        markdown.push('\n');
        markdown
    }

    /// The merge as the Admin reads it: each section's traits with what became of them and, for a
    /// saved trait, whether its quote is still in its sample; the unknown items; and the lines the
    /// browser joins once every change is decided.
    pub fn to_json(&self, provenance: Option<&str>, check: impl Fn(&Trait) -> QuoteCheck) -> Json {
        let sections: Vec<Json> = self
            .sections
            .iter()
            .filter(|s| !s.traits.is_empty())
            .map(|section| {
                let traits: Vec<Json> = section
                    .traits
                    .iter()
                    .map(|merged| match &merged.status {
                        Status::Kept | Status::Unchanged => json!({
                            "status": if merged.status == Status::Kept { "kept" } else { "unchanged" },
                            "current": trait_json(&merged.item),
                            "check": check(&merged.item).as_str(),
                        }),
                        Status::Changed { change, proposed } => json!({
                            "status": "changed",
                            "change": change,
                            "current": trait_json(&merged.item),
                            "check": check(&merged.item).as_str(),
                            "proposed": trait_json(proposed),
                        }),
                        Status::Added => json!({
                            "status": "added",
                            "proposed": trait_json(&merged.item),
                        }),
                    })
                    .collect();
                json!({ "id": section.id, "heading": section.heading, "traits": traits })
            })
            .collect();
        let lines: Vec<Json> = self
            .lines(provenance)
            .into_iter()
            .map(|line| match line {
                Line::Text(text) => Json::String(text),
                Line::Choice {
                    change,
                    current,
                    proposed,
                } => json!({ "change": change, "current": current, "proposed": proposed }),
            })
            .collect();
        json!({
            "sections": sections,
            "unknown": self.unknown.iter().map(|(text, kept)| json!({
                "text": text,
                "status": if *kept { "kept" } else { "added" },
            })).collect::<Vec<_>>(),
            "changes": self.changes,
            "freeText": self.free_text,
            "ownSections": self.own.iter().map(|o| o.heading.trim_start_matches('#').trim().to_string()).collect::<Vec<_>>(),
            "lines": lines,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::guide::SampleText;
    use super::*;

    const A: &str = "2026-10-01-a-mistake-i-made-rough.md";
    const B: &str = "2026-10-02-a-book-i-loved-rough.md";
    const C: &str = "2026-10-03-a-place-rough.md";
    const C_TEXT: &str = "we walked. and walked. and walked. then the rain came in sideways";

    const SAVED: &str = "# My voice\n<!-- openblog:voice-provenance sources=portable -->\n\nI wrote this intro myself.\n\n## Sentences and rhythm\n\n- Short bursts: \"so i deleted\" (2026-10-01-a-mistake-i-made-rough.md) (one sample)\n- Long run-on: \"and just stared at it\" (2026-10-01-a-mistake-i-made-rough.md)\n\nI think this is right.\n\n## Word choice\n\n- Says honestly: \"honestly it was\" (2026-10-02-a-book-i-loved-rough.md)\n- I like short words (one sample)\n\n## Things my editor told me\n\nNever say utilize.\n\n## What is not yet known\n\n- How you end a long piece\n";

    fn current() -> SavedGuide {
        SavedGuide::parse(SAVED)
    }

    fn samples() -> Vec<SampleText<'static>> {
        vec![SampleText {
            file: C,
            text: C_TEXT,
        }]
    }

    #[test]
    fn a_saved_guide_reads_back_into_traits_and_free_text() {
        let saved = current();
        assert_eq!(saved.title.as_deref(), Some("# My voice"));
        assert_eq!(saved.preamble, vec!["I wrote this intro myself."]);
        assert_eq!(saved.traits_of("sentences").len(), 2);
        assert!(saved.traits_of("sentences")[0].one_sample);
        assert_eq!(saved.sections[0].notes, vec!["I think this is right."]);
        // A hand-written bullet is free text, not a trait.
        assert_eq!(saved.traits_of("diction").len(), 1);
        assert_eq!(
            saved.sections[1].notes,
            vec!["- I like short words (one sample)"]
        );
        assert_eq!(saved.own[0].heading, "## Things my editor told me");
        assert_eq!(saved.unknown, vec!["How you end a long piece"]);
        assert!(saved.has_free_text());
        assert_eq!(saved.cited_samples(), vec![A, B]);
    }

    #[test]
    fn a_rendered_guide_reads_back_to_the_same_bytes() {
        let proposal = VoiceGuide::from_json(
            &json!({ "sections": [{ "id": "humor", "traits": [
                { "statement": "Dry \"jokes\": deadpan", "quote": "then the rain came in sideways", "sample": C, "oneSample": true }
            ]}], "unknown": ["Openings"] }),
            &samples(),
        )
        .unwrap();
        let rendered = proposal.render();
        let again = merge(
            &SavedGuide::parse(&rendered),
            &VoiceGuide {
                sections: Vec::new(),
                unknown: Vec::new(),
            },
        )
        .render(None, |_| Choice::Proposed);
        assert_eq!(again, rendered);
    }

    #[test]
    fn traits_the_proposal_does_not_address_are_kept_word_for_word_with_the_free_text() {
        let saved = current();
        let proposal = VoiceGuide::from_json_against(
            &json!({ "sections": [{ "id": "sentences", "traits": [
                { "statement": "Repeats a word for rhythm", "quote": "and walked. and walked.", "sample": C, "oneSample": true }
            ]}], "unknown": ["How you end a long piece", "Dialogue"] }),
            &samples(),
            &saved,
        )
        .unwrap();
        let merged = merge(&saved, &proposal);
        assert_eq!(merged.changes, 0);
        let markdown = merged.render(None, |_| unreachable!());
        assert_eq!(
            markdown,
            "# My voice\n\nI wrote this intro myself.\n\n## Sentences and rhythm\n\n- Short bursts: \"so i deleted\" (2026-10-01-a-mistake-i-made-rough.md) (one sample)\n- Long run-on: \"and just stared at it\" (2026-10-01-a-mistake-i-made-rough.md)\n- Repeats a word for rhythm: \"and walked. and walked.\" (2026-10-03-a-place-rough.md) (one sample)\n\nI think this is right.\n\n## Word choice\n\n- Says honestly: \"honestly it was\" (2026-10-02-a-book-i-loved-rough.md)\n\n- I like short words (one sample)\n\n## Things my editor told me\n\nNever say utilize.\n\n## What is not yet known\n\n- How you end a long piece\n- Dialogue\n"
        );
        let statuses: Vec<_> = merged.sections[0]
            .traits
            .iter()
            .map(|t| t.status.clone())
            .collect();
        assert_eq!(statuses, vec![Status::Kept, Status::Kept, Status::Added]);
    }

    #[test]
    fn a_changed_trait_is_shown_with_both_texts_and_the_author_chooses() {
        let saved = current();
        let proposal = VoiceGuide::from_json_against(
            &json!({ "sections": [{ "id": "sentences", "traits": [
                { "statement": "Short bursts, and repeats them", "quote": "and walked. and walked.", "sample": C, "oneSample": false, "replaces": "Short bursts" }
            ]}], "unknown": [] }),
            &samples(),
            &saved,
        )
        .unwrap();
        let merged = merge(&saved, &proposal);
        assert_eq!(merged.changes, 1);
        let lines = merged.lines(None);
        assert!(lines.iter().any(|l| matches!(l, Line::Choice { change: 0, current, proposed }
            if current.starts_with("- Short bursts: ") && proposed.starts_with("- Short bursts, and repeats them: "))));
        let kept = merged.render(None, |_| Choice::Current);
        let taken = merged.render(None, |_| Choice::Proposed);
        assert!(kept.contains("- Short bursts: \"so i deleted\""));
        assert!(!kept.contains("repeats them"));
        assert!(taken.contains("- Short bursts, and repeats them: \"and walked. and walked.\" (2026-10-03-a-place-rough.md)\n"));
        assert!(!taken.contains("- Short bursts: "));
        // Only the chosen line differs.
        assert_eq!(kept.lines().count(), taken.lines().count());
        let json = merged.to_json(None, |t| QuoteCheck::of(t, None));
        assert_eq!(json["changes"], 1);
        assert_eq!(json["sections"][0]["traits"][0]["status"], "changed");
        assert_eq!(json["sections"][0]["traits"][0]["check"], "sample-missing");
        assert_eq!(json["sections"][0]["traits"][1]["status"], "kept");
        assert!(json["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["change"] == 0));
    }

    #[test]
    fn the_same_statement_changes_the_saved_trait_even_without_replaces() {
        let saved = current();
        let proposal = VoiceGuide::from_json_against(
            &json!({ "sections": [{ "id": "diction", "traits": [
                { "statement": "Says honestly", "quote": "we walked.", "sample": C, "oneSample": false }
            ]}], "unknown": [] }),
            &samples(),
            &saved,
        )
        .unwrap();
        assert_eq!(merge(&saved, &proposal).changes, 1);
    }

    #[test]
    fn a_repeated_saved_trait_may_cite_an_unselected_sample_but_a_new_one_may_not() {
        let saved = current();
        let repeated = json!({ "sections": [{ "id": "diction", "traits": [
            { "statement": "Says honestly", "quote": "honestly it was", "sample": B, "oneSample": false }
        ]}], "unknown": [] });
        let proposal = VoiceGuide::from_json_against(&repeated, &samples(), &saved).unwrap();
        let merged = merge(&saved, &proposal);
        assert_eq!(merged.changes, 0);
        assert_eq!(merged.sections[1].traits[0].status, Status::Unchanged);
        let mut new = repeated.clone();
        new["sections"][0]["traits"][0]["statement"] = json!("Something else");
        let error = VoiceGuide::from_json_against(&new, &samples(), &saved).unwrap_err();
        assert!(error.contains("was not selected"), "{error}");
    }

    #[test]
    fn replaces_must_name_a_saved_trait_in_that_section_once() {
        let saved = current();
        let check = |traits: Json| {
            VoiceGuide::from_json_against(
                &json!({ "sections": [{ "id": "sentences", "traits": traits }], "unknown": [] }),
                &samples(),
                &saved,
            )
        };
        let missing = check(json!([
            { "statement": "x", "quote": "we walked.", "sample": C, "oneSample": true, "replaces": "Says honestly" }
        ]))
        .unwrap_err();
        assert!(missing.contains("not in that section"), "{missing}");
        let twice = check(json!([
            { "statement": "x", "quote": "we walked.", "sample": C, "oneSample": true, "replaces": "Short bursts" },
            { "statement": "y", "quote": "we walked.", "sample": C, "oneSample": true, "replaces": "Short bursts" }
        ]))
        .unwrap_err();
        assert!(twice.contains("two traits"), "{twice}");
        // A changed trait is new evidence: it must quote a selected sample.
        assert!(check(json!([
            { "statement": "x", "quote": "so i deleted", "sample": A, "oneSample": true, "replaces": "Short bursts" }
        ]))
        .is_err());
    }

    #[test]
    fn carried_quotes_are_checked_against_their_samples_and_flagged_not_dropped() {
        let saved = current();
        let item = &saved.traits_of("sentences")[0];
        assert_eq!(
            QuoteCheck::of(item, Some("well so i deleted it")),
            QuoteCheck::Verified
        );
        assert_eq!(
            QuoteCheck::of(item, Some("edited since")),
            QuoteCheck::NotInSample
        );
        assert_eq!(QuoteCheck::of(item, None), QuoteCheck::SampleMissing);
        let empty = VoiceGuide::from_json_against(
            &json!({ "sections": [], "unknown": [] }),
            &samples(),
            &saved,
        )
        .unwrap();
        let merged = merge(&saved, &empty);
        let json = merged.to_json(None, |t| QuoteCheck::of(t, None));
        assert_eq!(json["sections"][0]["traits"][0]["check"], "sample-missing");
        assert!(merged
            .render(None, |_| Choice::Current)
            .contains("Short bursts"));
    }

    #[test]
    fn the_merge_is_byte_stable() {
        let saved = current();
        let value = json!({ "sections": [{ "id": "sentences", "traits": [
            { "statement": "Short bursts", "quote": "we walked.", "sample": C, "oneSample": false }
        ]}], "unknown": ["Dialogue"] });
        let one = merge(
            &saved,
            &VoiceGuide::from_json_against(&value, &samples(), &saved).unwrap(),
        );
        let two = merge(
            &saved,
            &VoiceGuide::from_json_against(&value, &samples(), &saved).unwrap(),
        );
        let provenance = Some("<!-- openblog:voice-provenance sources=portable -->");
        assert_eq!(
            one.render(provenance, |_| Choice::Proposed),
            two.render(provenance, |_| Choice::Proposed)
        );
        assert!(one
            .render(provenance, |_| Choice::Proposed)
            .starts_with("# My voice\n<!-- openblog:voice-provenance sources=portable -->\n\n"));
    }

    #[test]
    fn trait_lines_parse_only_in_the_rendered_shape() {
        assert!(parse_trait_line("- a: \"b\" (x.md)").is_some());
        assert!(
            parse_trait_line("- a: \"b\" (x.md) (one sample)")
                .unwrap()
                .one_sample
        );
        assert!(parse_trait_line("- a: \"b\" (not a file)").is_none());
        assert!(parse_trait_line("- a \"b\" (x.md)").is_none());
        assert!(parse_trait_line("* a: \"b\" (x.md)").is_none());
        assert!(parse_trait_line("- a: \"\" (x.md)").is_none());
    }
}
