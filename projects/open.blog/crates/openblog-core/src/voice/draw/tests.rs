use std::collections::BTreeSet;

use super::*;

fn catalog() -> Catalog {
    let mut text = String::from("---\nversion: 1\nrule: r\n---\n");
    for (pack, count) in [("a", 3), ("b", 2), ("c", 4), ("d", 1), ("e", 3)] {
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

fn ids(draw: &[&Prompt]) -> Vec<String> {
    draw.iter().map(|p| p.id.clone()).collect()
}

fn packs(draw: &[&Prompt]) -> BTreeSet<String> {
    draw.iter().map(|p| p.pack.clone()).collect()
}

#[test]
fn the_same_seed_gives_the_same_draw_and_seeds_differ() {
    let catalog = catalog();
    let first = ids(&draw_three(&catalog, &[], 7));
    assert_eq!(first, ids(&draw_three(&catalog, &[], 7)));
    let all: BTreeSet<Vec<String>> = (0..40)
        .map(|seed| ids(&draw_three(&catalog, &[], seed)))
        .collect();
    assert!(all.len() > 10, "{} distinct draws", all.len());
}

#[test]
fn the_generator_is_pinned_so_a_seed_means_the_same_in_every_release() {
    let mut rng = Rng(0);
    assert_eq!(rng.next(), 0xe220_a839_7b1d_cdaf);
}

#[test]
fn an_empty_library_gives_three_different_packs_for_every_seed() {
    let catalog = catalog();
    for seed in 0..200 {
        let draw = draw_three(&catalog, &[], seed);
        assert_eq!(draw.len(), 3);
        assert_eq!(packs(&draw).len(), 3, "seed {seed}");
    }
}

#[test]
fn unanswered_prompts_come_before_rough_only_before_polished() {
    let catalog = catalog();
    // Everything answered except d1 and e1; pack a rough only; the rest polished.
    let mut library = Vec::new();
    for prompt in catalog.prompts() {
        let stage = if prompt.pack == "a" {
            VoiceStage::Rough
        } else {
            VoiceStage::Polished
        };
        if prompt.id != "d1" && prompt.id != "e1" {
            library.push(entry(&prompt.id, stage));
        }
    }
    for seed in 0..100 {
        let draw = ids(&draw_three(&catalog, &library, seed));
        assert!(draw.contains(&"d1".to_string()), "{draw:?}");
        assert!(draw.contains(&"e1".to_string()), "{draw:?}");
        // The third is rough only, from the one pack that has any.
        assert!(draw.iter().any(|id| id.starts_with('a')), "{draw:?}");
    }
}

#[test]
fn never_two_from_one_pack_while_another_pack_is_available() {
    let catalog = catalog();
    // Only pack c has unanswered prompts; the draw still spreads over packs.
    let library: Vec<LibraryEntry> = catalog
        .prompts()
        .filter(|p| p.pack != "c")
        .map(|p| entry(&p.id, VoiceStage::Polished))
        .collect();
    for seed in 0..100 {
        let draw = draw_three(&catalog, &library, seed);
        assert_eq!(packs(&draw).len(), 3, "seed {seed}");
        assert!(draw.iter().any(|p| p.pack == "c"));
    }
}

#[test]
fn with_every_prompt_answered_a_draw_still_returns_three() {
    let catalog = catalog();
    let library: Vec<LibraryEntry> = catalog
        .prompts()
        .map(|p| entry(&p.id, VoiceStage::Polished))
        .collect();
    for seed in 0..100 {
        let draw = draw_three(&catalog, &library, seed);
        assert_eq!(draw.len(), 3);
        assert_eq!(ids(&draw).iter().collect::<BTreeSet<_>>().len(), 3);
        assert_eq!(packs(&draw).len(), 3);
    }
}

#[test]
fn a_redraw_avoids_the_previous_three() {
    let catalog = catalog();
    for seed in 0..100 {
        let first = draw_three(&catalog, &[], seed);
        let previous: Vec<&str> = first.iter().map(|p| p.id.as_str()).collect();
        let again = redraw_three(&catalog, &[], seed.wrapping_add(1), &previous);
        assert_eq!(again.len(), 3);
        for prompt in &again {
            assert!(!previous.contains(&prompt.id.as_str()), "seed {seed}");
        }
        assert_eq!(packs(&again).len(), 3);
    }
}

#[test]
fn a_tiny_catalog_still_draws_what_it_has() {
    let text = "---\nversion: 1\nrule: r\n---\n## a: A\n### a1: One\nwords: 1-2\nx\n### a2: Two\nwords: 1-2\ny\n";
    let tiny = Catalog::parse_bundled(text).unwrap();
    assert_eq!(draw_three(&tiny, &[], 3).len(), 2);
    assert_eq!(redraw_three(&tiny, &[], 3, &["a1", "a2"]).len(), 2);
    let empty = Catalog::merge(
        Catalog::parse_bundled(text).unwrap(),
        Catalog::parse_site("---\ndisabled: [a]\n---\n").unwrap(),
    )
    .unwrap();
    assert!(draw_three(&empty, &[], 3).is_empty());
}

#[test]
fn small_packs_are_not_starved() {
    let catalog = catalog();
    // Pack d has one prompt among thirteen; picking packs first gives it a fair share.
    let hits = (0..300)
        .filter(|seed| {
            draw_three(&catalog, &[], *seed)
                .iter()
                .any(|p| p.pack == "d")
        })
        .count();
    assert!(hits > 120, "pack d appeared in {hits} of 300 draws");
}
