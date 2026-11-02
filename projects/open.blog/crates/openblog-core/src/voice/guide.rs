//! The voice guide: the validated shape of a provider's proposal, its deterministic Markdown
//! rendering, and the reading of `(one sample)` markers back out of a saved guide (ADR 0279,
//! ADR 0281).
//!
//! Pure and network free. A guide is built from the author's own words: every trait carries a short
//! verbatim quote and the file name of the sample it came from, and a result whose quote does not
//! occur in a selected sample is rejected before anyone sees it as a guide.

use serde_json::Value as Json;

pub use super::merge::{merge, Choice, SavedGuide};

/// The start of the provenance comment a saved guide carries on the line after its title.
pub const PROVENANCE_MARKER: &str = "<!-- openblog:voice-provenance";

/// Whether a voice guide's provenance line says it quotes a private sample. Such a guide must
/// never be saved, exported or imported into the portable (Git-tracked) folder.
pub fn quotes_private_samples(content: &str) -> bool {
    content.lines().any(|line| {
        line.trim_start().starts_with(PROVENANCE_MARKER)
            && line.split("sources=").nth(1).is_some_and(|sources| {
                sources
                    .split("-->")
                    .next()
                    .unwrap_or("")
                    .split(',')
                    .any(|v| v.trim() == "private")
            })
    })
}

/// The only section ids a proposal may use, with the heading each renders under. The order is the
/// order of the rendered guide, whatever order the provider answered in.
pub const SECTIONS: [(&str, &str); 7] = [
    ("sentences", "Sentences and rhythm"),
    ("diction", "Word choice"),
    ("structure", "How a piece is put together"),
    ("openings-and-endings", "Openings and endings"),
    ("stance", "Stance and point of view"),
    ("humor", "Humor and warmth"),
    ("habits", "Habits and quirks"),
];

/// The heading of the closing section, which is always rendered.
pub const UNKNOWN_HEADING: &str = "What is not yet known";
/// The marker written after a trait that rests on a single sample.
pub const ONE_SAMPLE_MARKER: &str = "(one sample)";

pub const MAX_TRAITS_PER_SECTION: usize = 12;
pub const MAX_UNKNOWN: usize = 20;
pub const MAX_STATEMENT_CHARS: usize = 300;
pub const MAX_QUOTE_CHARS: usize = 300;
pub const MAX_UNKNOWN_CHARS: usize = 300;

/// One observed habit of the author's writing, with its evidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trait {
    pub statement: String,
    /// A short passage that occurs word for word in the named sample.
    pub quote: String,
    /// The file name of the sample the quote comes from.
    pub sample: String,
    /// True until a second sample shows the same habit.
    pub one_sample: bool,
    /// The statement of the saved guide's trait, in the same section, that this one changes. Only
    /// a proposal sets it; a trait read from a saved guide never does (ADR 0288).
    pub replaces: Option<String>,
}

impl Trait {
    /// The trait as one guide bullet: `- <statement>: "<quote>" (<file>)`, with ` (one sample)`
    /// appended when it rests on one sample.
    pub fn line(&self) -> String {
        format!(
            "- {}: \"{}\" ({}){}",
            self.statement,
            self.quote,
            self.sample,
            if self.one_sample {
                format!(" {ONE_SAMPLE_MARKER}")
            } else {
                String::new()
            }
        )
    }

    /// The same claim with the same evidence, whatever `replaces` says.
    pub fn same_claim(&self, other: &Trait) -> bool {
        self.statement == other.statement
            && self.quote == other.quote
            && self.sample == other.sample
            && self.one_sample == other.one_sample
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Section {
    pub id: String,
    pub traits: Vec<Trait>,
}

/// A validated proposal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoiceGuide {
    pub sections: Vec<Section>,
    pub unknown: Vec<String>,
}

/// A selected sample as the validator needs it: its file name and the author's text.
#[derive(Clone, Copy, Debug)]
pub struct SampleText<'a> {
    pub file: &'a str,
    pub text: &'a str,
}

fn plain(value: &Json, what: &str, maximum: usize) -> Result<String, String> {
    let text = value
        .as_str()
        .ok_or_else(|| format!("{what} must be text"))?;
    if text.trim().is_empty() {
        return Err(format!("{what} is empty"));
    }
    if text.chars().count() > maximum {
        return Err(format!("{what} is longer than {maximum} characters"));
    }
    if text.chars().any(char::is_control) {
        return Err(format!("{what} contains a control character"));
    }
    Ok(text.to_string())
}

impl VoiceGuide {
    /// Validate a provider result against the samples that were selected for the request, with no
    /// saved guide. The error is one plain sentence naming the first problem; nothing partial is
    /// returned.
    pub fn from_json(value: &Json, samples: &[SampleText<'_>]) -> Result<Self, String> {
        Self::from_json_against(value, samples, &SavedGuide::default())
    }

    /// Validate a provider result against the selected samples and the saved guide it was asked to
    /// keep (ADR 0288). A new or changed trait must quote a selected sample word for word. A trait
    /// that repeats a saved claim exactly may cite a sample that was not selected, since the merge
    /// keeps it anyway. `replaces` must name a saved trait in the same section, at most once; a
    /// trait whose statement matches a saved one in its section changes that trait even without it.
    pub fn from_json_against(
        value: &Json,
        samples: &[SampleText<'_>],
        saved: &SavedGuide,
    ) -> Result<Self, String> {
        let object = value
            .as_object()
            .filter(|o| o.len() == 2 && o.contains_key("sections") && o.contains_key("unknown"))
            .ok_or("the voice guide must contain only `sections` and `unknown`")?;
        let raw_sections = object["sections"]
            .as_array()
            .ok_or("`sections` must be a list")?;
        if raw_sections.len() > SECTIONS.len() {
            return Err("the voice guide has more sections than exist".into());
        }
        let mut sections: Vec<Section> = Vec::new();
        for raw in raw_sections {
            let section = raw
                .as_object()
                .filter(|o| o.len() == 2 && o.contains_key("id") && o.contains_key("traits"))
                .ok_or("each section must contain only `id` and `traits`")?;
            let id = section["id"].as_str().unwrap_or_default();
            if !SECTIONS.iter().any(|(known, _)| *known == id) {
                return Err(format!("`{id}` is not a voice guide section"));
            }
            if sections.iter().any(|s| s.id == id) {
                return Err(format!("the section `{id}` appears twice"));
            }
            let raw_traits = section["traits"]
                .as_array()
                .ok_or("`traits` must be a list")?;
            if raw_traits.len() > MAX_TRAITS_PER_SECTION {
                return Err(format!(
                    "the section `{id}` has more than {MAX_TRAITS_PER_SECTION} traits"
                ));
            }
            let saved_traits = saved.traits_of(id);
            let mut traits: Vec<Trait> = Vec::with_capacity(raw_traits.len());
            for raw in raw_traits {
                let item = raw
                    .as_object()
                    .filter(|o| {
                        let extra = usize::from(o.contains_key("replaces"));
                        o.len() == 4 + extra
                            && ["statement", "quote", "sample", "oneSample"]
                                .iter()
                                .all(|key| o.contains_key(*key))
                    })
                    .ok_or(
                        "each trait must contain exactly `statement`, `quote`, `sample`, `oneSample` and optionally `replaces`",
                    )?;
                let statement = plain(&item["statement"], "a statement", MAX_STATEMENT_CHARS)?;
                let quote = plain(&item["quote"], "a quote", MAX_QUOTE_CHARS)?;
                let sample = plain(&item["sample"], "a sample name", 200)?;
                let one_sample = item["oneSample"]
                    .as_bool()
                    .ok_or("`oneSample` must be true or false")?;
                let replaces = match item.get("replaces") {
                    None | Some(Json::Null) => None,
                    Some(value) => Some(plain(value, "`replaces`", MAX_STATEMENT_CHARS)?),
                };
                let mut found = Trait {
                    statement,
                    quote,
                    sample,
                    one_sample,
                    replaces,
                };
                // The same statement as a saved trait in this section is that trait, kept or changed.
                if found.replaces.is_none() {
                    if let Some(old) = saved_traits.iter().find(|t| t.statement == found.statement)
                    {
                        if !old.same_claim(&found) {
                            found.replaces = Some(old.statement.clone());
                        }
                    }
                }
                if let Some(target) = &found.replaces {
                    if !saved_traits.iter().any(|t| &t.statement == target) {
                        return Err(format!(
                            "a trait replaces \"{target}\", which is not in that section of the saved guide"
                        ));
                    }
                    if traits.iter().any(|t| t.replaces.as_ref() == Some(target)) {
                        return Err(format!("two traits change the saved trait \"{target}\""));
                    }
                }
                let repeats_saved =
                    found.replaces.is_none() && saved_traits.iter().any(|t| t.same_claim(&found));
                match samples.iter().find(|s| s.file == found.sample) {
                    Some(named) => {
                        if !named.text.contains(&found.quote) {
                            return Err(format!(
                                "the quote \"{}\" does not occur word for word in {}",
                                found.quote, found.sample
                            ));
                        }
                    }
                    None if repeats_saved => {}
                    None => {
                        return Err(format!("the sample `{}` was not selected", found.sample));
                    }
                }
                traits.push(found);
            }
            sections.push(Section {
                id: id.to_string(),
                traits,
            });
        }
        let raw_unknown = object["unknown"]
            .as_array()
            .ok_or("`unknown` must be a list")?;
        if raw_unknown.len() > MAX_UNKNOWN {
            return Err(format!(
                "the list of what is not yet known has more than {MAX_UNKNOWN} items"
            ));
        }
        let unknown = raw_unknown
            .iter()
            .map(|item| plain(item, "an item of what is not yet known", MAX_UNKNOWN_CHARS))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { sections, unknown })
    }

    /// The proposal as JSON for the Admin: each section with its heading, in the fixed order.
    pub fn to_json(&self) -> Json {
        let sections: Vec<Json> = SECTIONS
            .iter()
            .filter_map(|(id, heading)| {
                let section = self.sections.iter().find(|s| s.id == *id)?;
                Some(serde_json::json!({
                    "id": id,
                    "heading": heading,
                    "traits": section.traits.iter().map(trait_json).collect::<Vec<_>>(),
                }))
            })
            .collect();
        serde_json::json!({ "sections": sections, "unknown": self.unknown })
    }
    /// The guide as Markdown, with no saved guide to fold into. The same guide always renders to
    /// the same bytes: sections follow the fixed order, empty sections are left out, and the last
    /// section is always there.
    pub fn render(&self) -> String {
        merge(&SavedGuide::default(), self).render(None, |_| Choice::Proposed)
    }
}

/// A trait as the Admin reads it.
pub fn trait_json(t: &Trait) -> Json {
    serde_json::json!({
        "statement": t.statement,
        "quote": t.quote,
        "sample": t.sample,
        "oneSample": t.one_sample,
        "replaces": t.replaces,
    })
}

/// A trait in a saved guide that still rests on one sample.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OneSampleTrait {
    /// The heading it sits under.
    pub section: String,
    pub statement: String,
    /// The sample named in parentheses, if the line has one.
    pub sample: Option<String>,
}

/// The traits marked `(one sample)` in a guide's Markdown, in the order they appear. Tolerant of a
/// guide the author edited by hand: any bullet whose line ends with the marker counts, wherever it
/// sits, and the text before the first `: "` is its statement.
pub fn one_sample_traits(guide: &str) -> Vec<OneSampleTrait> {
    let mut section = String::new();
    let mut found = Vec::new();
    for line in guide.lines() {
        let line = line.trim_end();
        if let Some(heading) = line.strip_prefix("## ") {
            section = heading.trim().to_string();
            continue;
        }
        let Some(bullet) = line.strip_prefix("- ") else {
            continue;
        };
        let Some(rest) = bullet.strip_suffix(ONE_SAMPLE_MARKER) else {
            continue;
        };
        let rest = rest.trim_end();
        let (body, sample) = match rest
            .strip_suffix(')')
            .and_then(|r| r.rfind('(').map(|at| (&r[..at], &r[at + 1..])))
        {
            Some((body, name)) if !name.is_empty() => (body.trim_end(), Some(name.to_string())),
            _ => (rest, None),
        };
        let statement = body.split(": \"").next().unwrap_or(body).trim().to_string();
        found.push(OneSampleTrait {
            section: section.clone(),
            statement,
            sample,
        });
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ROUGH: &str = "2026-10-28-a-mistake-i-made-rough.md";
    const OTHER: &str = "2026-10-29-a-book-i-loved-rough.md";
    const TEXT: &str = "so i deleted the wrong folder and just stared at it";
    const OTHER_TEXT: &str = "honestly it was a quiet book, and that was the point";

    fn samples() -> Vec<SampleText<'static>> {
        vec![
            SampleText {
                file: ROUGH,
                text: TEXT,
            },
            SampleText {
                file: OTHER,
                text: OTHER_TEXT,
            },
        ]
    }

    fn proposal() -> Json {
        json!({
            "sections": [
                { "id": "diction", "traits": [
                    { "statement": "Opens with a plain \"so\"", "quote": "so i deleted", "sample": ROUGH, "oneSample": true },
                    { "statement": "Says honestly", "quote": "honestly it was", "sample": OTHER, "oneSample": false }
                ]},
                { "id": "sentences", "traits": [
                    { "statement": "Long run-on", "quote": "and just stared at it", "sample": ROUGH, "oneSample": true }
                ]}
            ],
            "unknown": ["How you write a conclusion"]
        })
    }

    #[test]
    fn a_valid_result_renders_in_the_fixed_section_order() {
        let guide = VoiceGuide::from_json(&proposal(), &samples()).unwrap();
        let markdown = guide.render();
        assert_eq!(
            markdown,
            format!(
                "# Voice guide\n\n## Sentences and rhythm\n\n- Long run-on: \"and just stared at it\" ({ROUGH}) (one sample)\n\n## Word choice\n\n- Opens with a plain \"so\": \"so i deleted\" ({ROUGH}) (one sample)\n- Says honestly: \"honestly it was\" ({OTHER})\n\n## What is not yet known\n\n- How you write a conclusion\n"
            )
        );
    }

    #[test]
    fn rendering_is_byte_stable_whatever_order_the_provider_used() {
        let first = VoiceGuide::from_json(&proposal(), &samples()).unwrap();
        let mut reordered = proposal();
        reordered["sections"].as_array_mut().unwrap().reverse();
        let second = VoiceGuide::from_json(&reordered, &samples()).unwrap();
        assert_eq!(first.render(), second.render());
        assert_eq!(first.render(), first.render());
    }

    #[test]
    fn an_empty_guide_still_ends_with_what_is_not_yet_known() {
        let guide =
            VoiceGuide::from_json(&json!({ "sections": [], "unknown": [] }), &samples()).unwrap();
        assert_eq!(
            guide.render(),
            "# Voice guide\n\n## What is not yet known\n\n_Nothing is flagged yet._\n"
        );
    }

    #[test]
    fn a_quote_that_does_not_occur_is_rejected_with_a_plain_reason() {
        let mut result = proposal();
        result["sections"][0]["traits"][0]["quote"] = json!("so I deleted");
        let error = VoiceGuide::from_json(&result, &samples()).unwrap_err();
        assert!(error.contains("does not occur word for word"), "{error}");
    }

    #[test]
    fn a_quote_must_come_from_the_sample_it_names() {
        let mut result = proposal();
        result["sections"][0]["traits"][0]["sample"] = json!(OTHER);
        assert!(VoiceGuide::from_json(&result, &samples()).is_err());
    }

    #[test]
    fn a_sample_that_was_not_selected_is_rejected() {
        let mut result = proposal();
        result["sections"][0]["traits"][0]["sample"] = json!("2026-01-01-other-rough.md");
        let error = VoiceGuide::from_json(&result, &samples()).unwrap_err();
        assert!(error.contains("was not selected"), "{error}");
        assert!(VoiceGuide::from_json(&proposal(), &samples()[..1]).is_err());
    }

    #[test]
    fn unknown_sections_duplicates_extras_and_bad_sizes_are_rejected() {
        let check = |edit: &dyn Fn(&mut Json)| {
            let mut result = proposal();
            edit(&mut result);
            assert!(VoiceGuide::from_json(&result, &samples()).is_err());
        };
        check(&|r| r["sections"][0]["id"] = json!("tone"));
        check(&|r| r["sections"][1]["id"] = json!("diction"));
        check(&|r| r["extra"] = json!(1));
        check(&|r| r["sections"][0]["extra"] = json!(1));
        check(&|r| r["sections"][0]["traits"][0]["extra"] = json!(1));
        check(&|r| r["sections"][0]["traits"][0]["oneSample"] = json!("yes"));
        check(&|r| r["sections"][0]["traits"][0]["statement"] = json!(""));
        check(&|r| r["sections"][0]["traits"][0]["statement"] = json!("x".repeat(301)));
        check(&|r| r["unknown"] = json!(vec!["x"; 21]));
        check(&|r| r["unknown"] = json!([1]));
        check(&|r| {
            r["sections"][0]["traits"] = json!(vec![
                json!({ "statement": "a", "quote": "so i", "sample": ROUGH, "oneSample": true });
                13
            ])
        });
    }

    #[test]
    fn control_characters_are_rejected_everywhere() {
        for field in ["statement", "quote"] {
            let mut result = proposal();
            result["sections"][0]["traits"][0][field] = json!("so\ti");
            assert!(
                VoiceGuide::from_json(&result, &samples()).is_err(),
                "{field}"
            );
        }
        let mut result = proposal();
        result["unknown"] = json!(["line one\nline two"]);
        assert!(VoiceGuide::from_json(&result, &samples()).is_err());
    }

    #[test]
    fn one_sample_markers_are_read_back_from_a_rendered_or_hand_edited_guide() {
        let rendered = VoiceGuide::from_json(&proposal(), &samples())
            .unwrap()
            .render();
        let traits = one_sample_traits(&rendered);
        assert_eq!(traits.len(), 2);
        assert_eq!(traits[0].section, "Sentences and rhythm");
        assert_eq!(traits[0].statement, "Long run-on");
        assert_eq!(traits[0].sample.as_deref(), Some(ROUGH));
        assert_eq!(traits[1].statement, "Opens with a plain \"so\"");
        let by_hand =
            "# Mine\n\n## Notes\n\n- I like short words (one sample)\nnot a bullet (one sample)\n";
        let traits = one_sample_traits(by_hand);
        assert_eq!(traits.len(), 1);
        assert_eq!(traits[0].statement, "I like short words");
        assert_eq!(traits[0].sample, None);
    }
}
