//! What is missing from the author's voice material (ADR 0281): one deterministic answer that the
//! CLI, Admin and the provider's voice-guide input all share. Not AI; the same inputs give the
//! same output, in catalog order.

use std::collections::{BTreeMap, BTreeSet};

use super::catalog::Catalog;
use super::draw::LibraryEntry;
use super::guide::{one_sample_traits, OneSampleTrait};
use super::VoiceStage;

/// The gaps in a library, for a catalog and an optional saved guide.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Gaps {
    /// Packs none of whose prompts has a sample at any stage.
    pub unanswered_packs: Vec<String>,
    /// Prompts with no sample at any stage.
    pub unanswered_prompts: Vec<String>,
    /// Prompts with a rough draft and no polished draft.
    pub rough_only_prompts: Vec<String>,
    /// Traits in the guide that rest on one sample.
    pub one_sample_traits: Vec<OneSampleTrait>,
}

impl Gaps {
    pub fn is_empty(&self) -> bool {
        self.unanswered_packs.is_empty()
            && self.unanswered_prompts.is_empty()
            && self.rough_only_prompts.is_empty()
            && self.one_sample_traits.is_empty()
    }
}

/// Compute the gaps. `library` is the valid samples (see `LibraryEntry`); `guide` is the saved
/// guide's Markdown, if there is one. Pack and prompt ids follow the catalog's order; one-sample
/// traits follow the guide's.
pub fn gaps(catalog: &Catalog, library: &[LibraryEntry], guide: Option<&str>) -> Gaps {
    let mut stages: BTreeMap<&str, BTreeSet<VoiceStage>> = BTreeMap::new();
    for entry in library {
        stages
            .entry(entry.prompt.as_str())
            .or_default()
            .insert(entry.stage);
    }
    let mut result = Gaps::default();
    for pack in &catalog.packs {
        let mut any = false;
        for prompt in &pack.prompts {
            match stages.get(prompt.id.as_str()) {
                None => result.unanswered_prompts.push(prompt.id.clone()),
                Some(have) => {
                    any = true;
                    if !have.contains(&VoiceStage::Polished) {
                        result.rough_only_prompts.push(prompt.id.clone());
                    }
                }
            }
        }
        if !any {
            result.unanswered_packs.push(pack.id.clone());
        }
    }
    result.one_sample_traits = guide.map(one_sample_traits).unwrap_or_default();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Catalog {
        let mut text = String::from("---\nversion: 1\nrule: r\n---\n");
        for (pack, count) in [("a", 3), ("b", 2), ("c", 2)] {
            text.push_str(&format!("## {pack}: Pack {pack}\n"));
            for n in 1..=count {
                text.push_str(&format!(
                    "### {pack}{n}: P {pack}{n}\nwords: 10-20\nWrite.\n"
                ));
            }
        }
        Catalog::parse_bundled(&text).unwrap()
    }

    fn entry(prompt: &str, stage: VoiceStage) -> LibraryEntry {
        LibraryEntry {
            prompt: prompt.into(),
            stage,
        }
    }

    #[test]
    fn an_empty_library_leaves_everything_unanswered_in_catalog_order() {
        let catalog = catalog();
        let found = gaps(&catalog, &[], None);
        let packs: Vec<&str> = catalog.packs.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(found.unanswered_packs, packs);
        let prompts: Vec<&str> = catalog.prompts().map(|p| p.id.as_str()).collect();
        assert_eq!(found.unanswered_prompts, prompts);
        assert!(found.rough_only_prompts.is_empty());
        assert!(found.one_sample_traits.is_empty());
    }

    #[test]
    fn a_mixed_library_separates_answered_rough_only_and_polished() {
        let catalog = catalog();
        let all: Vec<&str> = catalog.prompts().map(|p| p.id.as_str()).collect();
        let first_pack = &catalog.packs[0];
        let (rough_only, polished) = (&first_pack.prompts[0].id, &first_pack.prompts[1].id);
        let library = vec![
            entry(polished, VoiceStage::Rough),
            entry(rough_only, VoiceStage::Rough),
            entry(polished, VoiceStage::Polished),
        ];
        let found = gaps(&catalog, &library, None);
        assert_eq!(found.rough_only_prompts, vec![rough_only.clone()]);
        assert!(!found.unanswered_prompts.contains(rough_only));
        assert!(!found.unanswered_prompts.contains(polished));
        assert_eq!(found.unanswered_prompts.len(), all.len() - 2);
        assert!(!found.unanswered_packs.contains(&first_pack.id));
        assert_eq!(found.unanswered_packs.len(), catalog.packs.len() - 1);
        // Catalog order, not library order.
        let positions: Vec<usize> = found
            .unanswered_prompts
            .iter()
            .map(|id| all.iter().position(|p| p == id).unwrap())
            .collect();
        assert!(positions.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn a_prompt_the_catalog_no_longer_has_is_ignored() {
        let found = gaps(
            &catalog(),
            &[entry("gone-from-the-catalog", VoiceStage::Rough)],
            None,
        );
        assert!(found.rough_only_prompts.is_empty());
    }

    #[test]
    fn one_sample_traits_come_from_the_guide_markers_in_order() {
        let guide = "## Word choice\n\n- Plain \"so\": \"so i\" (a-rough.md) (one sample)\n- Says honestly: \"honestly\" (b-rough.md)\n\n## Humor and warmth\n\n- Dry: \"fine\" (b-rough.md) (one sample)\n";
        let found = gaps(&catalog(), &[], Some(guide));
        assert_eq!(found.one_sample_traits.len(), 2);
        assert_eq!(found.one_sample_traits[0].section, "Word choice");
        assert_eq!(found.one_sample_traits[1].statement, "Dry");
        assert!(!found.is_empty());
        assert!(gaps(&catalog(), &[], Some("# Guide\n"))
            .one_sample_traits
            .is_empty());
    }
}
