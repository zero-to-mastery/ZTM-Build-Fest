//! The bundled voice prompt catalog (ADR 0268).
//!
//! The text lives in `voice_prompts/catalog.md`, compiled into the binary. Parsing, merging with a
//! site's own prompts and drawing are pure functions in `openblog_core::voice`.

/// The bundled catalog source.
pub const BUNDLED: &str = include_str!("voice_prompts/catalog.md");

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    #[test]
    fn the_bundled_catalog_has_ten_packs_and_forty_prompts_with_unique_kebab_ids() {
        let mut packs: BTreeMap<String, usize> = BTreeMap::new();
        let mut order = Vec::new();
        let mut ids = BTreeSet::new();
        for line in BUNDLED.lines() {
            if let Some(rest) = line.strip_prefix("### ") {
                let id = rest.split(':').next().unwrap().trim();
                assert!(openblog_core::voice::is_kebab(id), "{id}");
                assert!(ids.insert(id.to_string()), "duplicate prompt id {id}");
                *packs.get_mut(order.last().unwrap()).unwrap() += 1;
            } else if let Some(rest) = line.strip_prefix("## ") {
                let id = rest.split(':').next().unwrap().trim().to_string();
                assert!(openblog_core::voice::is_kebab(&id), "{id}");
                assert!(packs.insert(id.clone(), 0).is_none(), "duplicate pack {id}");
                order.push(id);
            }
        }
        assert!(packs.len() >= 10, "{} packs", packs.len());
        assert!(ids.len() >= 40, "{} prompts", ids.len());
        for (pack, count) in &packs {
            assert!(*count >= 3, "{pack} has {count} prompts");
        }
    }

    #[test]
    fn the_bundled_catalog_parses_with_the_core_parser() {
        let catalog = openblog_core::voice::catalog::Catalog::parse_bundled(BUNDLED).unwrap();
        assert_eq!(catalog.version, openblog_core::voice::CATALOG_VERSION);
        assert!(catalog.packs.len() >= 10);
        assert!(catalog.prompts().count() >= 40);
        assert!(catalog.packs.iter().all(|pack| pack.prompts.len() >= 3));
        let ids: BTreeSet<&str> = catalog.prompts().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.len(), catalog.prompts().count());
        assert!(catalog.rule.contains("the way you would say it"));
        for prompt in catalog.prompts() {
            // Answerable in three minutes: a few hundred words at most.
            assert!(prompt.words_max <= 250, "{}", prompt.id);
        }
    }

    #[test]
    fn the_trades_pack_ships_with_its_eight_prompts_and_can_be_disabled() {
        let catalog = openblog_core::voice::catalog::Catalog::parse_bundled(BUNDLED).unwrap();
        let pack = catalog.packs.iter().find(|p| p.id == "trades").unwrap();
        let ids: Vec<&str> = pack.prompts.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "a-job-that-went-sideways",
                "the-question-every-customer-asks",
                "the-tool-i-would-never-give-up",
                "a-myth-about-my-trade",
                "how-i-price-a-job-honestly",
                "the-best-customer-i-ever-had",
                "what-i-check-before-i-start",
                "the-day-i-knew-i-was-good-at-this",
            ]
        );
        assert!(pack.prompts.iter().all(|p| p.words_min < p.words_max));
        let hidden = openblog_core::voice::catalog::Catalog::load(
            BUNDLED,
            Some("---\ndisabled: [trades]\n---\n"),
        )
        .unwrap();
        assert!(hidden.pack("trades").is_none());
        assert!(catalog.pack("trades").is_some());
    }

    #[test]
    fn the_standing_rule_is_stored_once_not_per_prompt() {
        assert_eq!(BUNDLED.matches("the way you would say it").count(), 1);
        assert!(BUNDLED.starts_with("---\nversion: 1\nrule: "));
    }
}
