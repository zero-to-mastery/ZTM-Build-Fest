//! Drawing three prompts that feel random and steadily fill the gaps (ADR 0268).
//!
//! Pure and deterministic: the same catalog, library and seed always give the same draw. Callers
//! pass the entropy, so a test can pin it and a real session can pass the clock or an OS random
//! number.

use std::collections::BTreeMap;

use super::catalog::{Catalog, Prompt};
use super::VoiceStage;

/// How many prompts a draw offers.
pub const DRAW_SIZE: usize = 3;

/// One sample already in the author's library.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibraryEntry {
    pub prompt: String,
    pub stage: VoiceStage,
}

/// A small, fast, well-distributed generator (splitmix64). Fixed here so a seed means the same
/// thing in every release.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        // The modulo bias over a 64-bit draw is far below anything a person could notice.
        (self.next() % n as u64) as usize
    }
}

/// Three prompts for a new session.
pub fn draw_three<'a>(
    catalog: &'a Catalog,
    library: &[LibraryEntry],
    seed: u64,
) -> Vec<&'a Prompt> {
    draw(catalog, library, seed, &[])
}

/// Three different prompts after the author asked for another draw: `previous` are the prompt
/// ids they were just shown, which are avoided unless the catalog is too small to avoid them.
pub fn redraw_three<'a>(
    catalog: &'a Catalog,
    library: &[LibraryEntry],
    seed: u64,
    previous: &[&str],
) -> Vec<&'a Prompt> {
    draw(catalog, library, seed, previous)
}

fn draw<'a>(
    catalog: &'a Catalog,
    library: &[LibraryEntry],
    seed: u64,
    exclude: &[&str],
) -> Vec<&'a Prompt> {
    // 0: no sample, 1: only a rough draft, 2: a polished draft too.
    let mut tier: BTreeMap<&str, u8> = BTreeMap::new();
    for entry in library {
        let level = match entry.stage {
            VoiceStage::Rough => 1,
            VoiceStage::Polished => 2,
        };
        let slot = tier.entry(entry.prompt.as_str()).or_insert(0);
        *slot = (*slot).max(level);
    }

    let mut rng = Rng(seed);
    let mut chosen: Vec<&'a Prompt> = Vec::new();
    while chosen.len() < DRAW_SIZE {
        let candidates: Vec<(&'a Prompt, (bool, bool, u8))> = catalog
            .prompts()
            .filter(|prompt| !chosen.iter().any(|c| c.id == prompt.id))
            .map(|prompt| {
                let key = (
                    chosen.iter().any(|c| c.pack == prompt.pack),
                    exclude.contains(&prompt.id.as_str()),
                    tier.get(prompt.id.as_str()).copied().unwrap_or(0),
                );
                (prompt, key)
            })
            .collect();
        let Some(best) = candidates.iter().map(|(_, key)| *key).min() else {
            break;
        };
        let best: Vec<&'a Prompt> = candidates
            .into_iter()
            .filter(|(_, key)| *key == best)
            .map(|(prompt, _)| prompt)
            .collect();
        // Packs first, then a prompt within the pack, so a small pack is not starved by a big one.
        let mut packs: Vec<&str> = Vec::new();
        for prompt in &best {
            if !packs.contains(&prompt.pack.as_str()) {
                packs.push(prompt.pack.as_str());
            }
        }
        let pack = packs[rng.below(packs.len())];
        let in_pack: Vec<&'a Prompt> = best.into_iter().filter(|p| p.pack == pack).collect();
        chosen.push(in_pack[rng.below(in_pack.len())]);
    }
    chosen
}

#[cfg(test)]
mod tests;
