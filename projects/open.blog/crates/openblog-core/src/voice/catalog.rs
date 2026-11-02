//! The voice prompt catalog: packs of prompts, parsed from Markdown, merged with a site's own
//! additions (ADR 0268). Pure: callers pass text in.
//!
//! ```text
//! ---
//! version: 1
//! rule: Write it the way you would say it.
//! ---
//!
//! ## teaching: Teaching
//! A line describing the pack.
//!
//! ### explain-to-a-beginner: Explain it to a beginner
//! words: 80-200
//! The invitation, which can run over several lines.
//! ```
//!
//! A site file (`assistant/voice/catalog.md`) uses the same sections and may add
//! `disabled: [pack-id, ...]` to its front matter.

use std::collections::BTreeSet;

use super::{is_kebab, CATALOG_VERSION};
use crate::frontmatter;

const MAX_TITLE: usize = 80;
const MAX_SUMMARY: usize = 300;
const MAX_INVITATION: usize = 800;
const MAX_WORDS: u32 = 2000;
/// The largest catalog file read.
pub const MAX_CATALOG_BYTES: usize = 128 * 1024;

/// One writing invitation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prompt {
    pub id: String,
    /// The id of the pack it belongs to.
    pub pack: String,
    pub title: String,
    pub invitation: String,
    pub words_min: u32,
    pub words_max: u32,
    /// Whether the site added it, rather than the bundled catalog.
    pub site: bool,
}

/// A named group of prompts for one genre.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pack {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub prompts: Vec<Prompt>,
}

/// A catalog, bundled, site-level or merged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Catalog {
    /// The version stamped on samples made from this catalog.
    pub version: u32,
    /// The standing rule shown with every prompt; stored once.
    pub rule: String,
    pub packs: Vec<Pack>,
    /// Pack ids a site file asks to hide. Empty after a merge, which applies them.
    pub disabled: Vec<String>,
    /// Things that were wrong but not fatal, in plain sentences.
    pub warnings: Vec<String>,
}

impl Catalog {
    /// Parse the bundled catalog: it must carry `version` and `rule`.
    pub fn parse_bundled(source: &str) -> Result<Self, String> {
        let (fields, body, first_line) = split(source)?;
        let version = fields
            .get_u32("version")
            .ok_or("The catalog needs a `version` number in its front matter.")?;
        if version == 0 || version > CATALOG_VERSION {
            return Err(format!(
                "The catalog is version {version}, but this release understands up to {CATALOG_VERSION}."
            ));
        }
        let rule = fields
            .get("rule")
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .ok_or("The catalog needs a `rule` in its front matter.")?
            .to_string();
        let packs = parse_sections(&body, first_line, false)?;
        Ok(Self {
            version,
            rule,
            packs,
            disabled: Vec::new(),
            warnings: Vec::new(),
        })
    }

    /// Parse a site's own catalog: packs and prompts to add, and `disabled` packs to hide. A site
    /// file may be empty of both.
    pub fn parse_site(source: &str) -> Result<Self, String> {
        let (fields, body, first_line) = split(source)?;
        let packs = parse_sections(&body, first_line, true)?;
        Ok(Self {
            version: CATALOG_VERSION,
            rule: String::new(),
            packs,
            disabled: fields.get_list("disabled"),
            warnings: Vec::new(),
        })
    }

    /// Merge a site catalog into the bundled one. Site prompts append (new packs after the bundled
    /// ones, both in id order, so the result does not depend on how the site file was ordered);
    /// a site prompt using a bundled id is refused; packs the site disables are removed, and a
    /// disabled id that names no pack is a warning. The bundled version is kept for stamping.
    pub fn merge(bundled: Self, site: Self) -> Result<Self, String> {
        let bundled_ids: BTreeSet<&str> = bundled
            .packs
            .iter()
            .flat_map(|pack| pack.prompts.iter().map(|prompt| prompt.id.as_str()))
            .collect();
        for pack in &site.packs {
            for prompt in &pack.prompts {
                if bundled_ids.contains(prompt.id.as_str()) {
                    return Err(format!(
                        "The site prompt `{}` uses an id that the bundled catalog already has. Choose a different id.",
                        prompt.id
                    ));
                }
            }
        }
        let mut merged = bundled;
        merged.warnings.extend(site.warnings);
        let mut additions = site.packs;
        additions.sort_by(|a, b| a.id.cmp(&b.id));
        for mut addition in additions {
            addition.prompts.sort_by(|a, b| a.id.cmp(&b.id));
            match merged.packs.iter_mut().find(|pack| pack.id == addition.id) {
                Some(pack) => pack.prompts.extend(addition.prompts),
                None => merged.packs.push(addition),
            }
        }
        let known: BTreeSet<String> = merged.packs.iter().map(|pack| pack.id.clone()).collect();
        let mut disabled = site.disabled;
        disabled.sort();
        disabled.dedup();
        for id in &disabled {
            if !known.contains(id) {
                merged.warnings.push(format!(
                    "The site catalog hides the pack `{id}`, but there is no pack with that id."
                ));
            }
        }
        merged.packs.retain(|pack| !disabled.contains(&pack.id));
        merged.disabled = Vec::new();
        Ok(merged)
    }

    /// Parse the bundled text and, if there is one, the site's, and merge them.
    pub fn load(bundled: &str, site: Option<&str>) -> Result<Self, String> {
        let bundled = Self::parse_bundled(bundled)?;
        let Some(site) = site else {
            return Ok(bundled);
        };
        Self::parse_site(site)
            .and_then(|site| Self::merge(bundled, site))
            .map_err(|e| format!("The site catalog cannot be used. {e}"))
    }

    pub fn pack(&self, id: &str) -> Option<&Pack> {
        self.packs.iter().find(|pack| pack.id == id)
    }

    pub fn prompt(&self, id: &str) -> Option<&Prompt> {
        self.prompts().find(|prompt| prompt.id == id)
    }

    /// Every prompt, in pack order then authored order.
    pub fn prompts(&self) -> impl Iterator<Item = &Prompt> {
        self.packs.iter().flat_map(|pack| pack.prompts.iter())
    }
}

/// Ids a site prompt cannot use: `openblog voice <id>` would run the subcommand instead.
pub const RESERVED_PROMPT_IDS: [&str; 3] = ["polish", "diff", "promote"];

fn split(source: &str) -> Result<(frontmatter::FrontMatter, String, usize), String> {
    if source.len() > MAX_CATALOG_BYTES {
        return Err(format!(
            "The catalog is larger than the {} KiB limit.",
            MAX_CATALOG_BYTES / 1024
        ));
    }
    let source = source.replace("\r\n", "\n");
    let document = frontmatter::parse(&source)
        .map_err(|error| format!("The catalog front matter is not valid: {error}."))?;
    Ok((document.front_matter, document.body, document.body_line))
}

fn heading(rest: &str, line: usize, what: &str) -> Result<(String, String), String> {
    let (id, title) = rest
        .split_once(':')
        .ok_or_else(|| format!("Line {line}: a {what} heading must look like `id: Title`."))?;
    let (id, title) = (id.trim(), title.trim());
    if !is_kebab(id) {
        return Err(format!(
            "Line {line}: the {what} id `{id}` must be lowercase kebab-case."
        ));
    }
    if title.is_empty() || title.chars().count() > MAX_TITLE || title.chars().any(char::is_control)
    {
        return Err(format!(
            "Line {line}: the {what} `{id}` needs a title of 1 to {MAX_TITLE} characters."
        ));
    }
    Ok((id.to_string(), title.to_string()))
}

fn parse_words(text: &str, line: usize, id: &str) -> Result<(u32, u32), String> {
    let bad = || {
        format!("Line {line}: the prompt `{id}` needs `words: low-high`, such as `words: 60-150`.")
    };
    let range = text.strip_prefix("words:").ok_or_else(bad)?;
    let (low, high) = range.trim().split_once('-').ok_or_else(bad)?;
    let low: u32 = low.trim().parse().map_err(|_| bad())?;
    let high: u32 = high.trim().parse().map_err(|_| bad())?;
    if low == 0 || low > high || high > MAX_WORDS {
        return Err(format!(
            "Line {line}: the prompt `{id}` needs a word range from 1 up to {MAX_WORDS}, low first."
        ));
    }
    Ok((low, high))
}

struct Draft {
    id: String,
    title: String,
    words: Option<(u32, u32)>,
    lines: Vec<String>,
    line: usize,
}

fn finish_prompt(draft: Draft, pack: &mut Pack, site: bool) -> Result<(), String> {
    let (words_min, words_max) = draft.words.ok_or_else(|| {
        format!(
            "Line {}: the prompt `{}` needs `words: low-high` right under its heading.",
            draft.line, draft.id
        )
    })?;
    let invitation = draft.lines.join("\n").trim().to_string();
    if invitation.is_empty() || invitation.chars().count() > MAX_INVITATION {
        return Err(format!(
            "Line {}: the prompt `{}` needs an invitation of 1 to {MAX_INVITATION} characters.",
            draft.line, draft.id
        ));
    }
    if invitation.chars().any(|c| c.is_control() && c != '\n') {
        return Err(format!(
            "Line {}: the prompt `{}` has control characters in its invitation.",
            draft.line, draft.id
        ));
    }
    pack.prompts.push(Prompt {
        id: draft.id,
        pack: pack.id.clone(),
        title: draft.title,
        invitation,
        words_min,
        words_max,
        site,
    });
    Ok(())
}

fn finish_pack(pack: Pack, packs: &mut Vec<Pack>, site: bool, line: usize) -> Result<(), String> {
    if pack.prompts.is_empty() {
        return Err(format!(
            "Line {line}: the {} pack `{}` has no prompts.",
            if site { "site" } else { "bundled" },
            pack.id
        ));
    }
    if pack.summary.chars().count() > MAX_SUMMARY {
        return Err(format!(
            "The pack `{}` has a summary longer than {MAX_SUMMARY} characters.",
            pack.id
        ));
    }
    packs.push(pack);
    Ok(())
}

fn parse_sections(body: &str, first_line: usize, site: bool) -> Result<Vec<Pack>, String> {
    let mut packs: Vec<Pack> = Vec::new();
    let mut pack: Option<(Pack, usize)> = None;
    let mut prompt: Option<Draft> = None;
    let mut prompt_ids = BTreeSet::new();
    let mut seen_packs = BTreeSet::new();

    for (offset, raw) in body.lines().enumerate() {
        let line = first_line + offset;
        let text = raw.trim_end();
        if let Some(rest) = text.strip_prefix("### ") {
            let Some((current, _)) = pack.as_mut() else {
                return Err(format!(
                    "Line {line}: a prompt must come under a `## pack` heading."
                ));
            };
            if let Some(done) = prompt.take() {
                finish_prompt(done, current, site)?;
            }
            let (id, title) = heading(rest, line, "prompt")?;
            if site && RESERVED_PROMPT_IDS.contains(&id.as_str()) {
                return Err(format!(
                    "Line {line}: the prompt id `{id}` is reserved because `openblog voice {id}` is a subcommand. Choose a different id."
                ));
            }
            if !prompt_ids.insert(id.clone()) {
                return Err(format!("Line {line}: the prompt id `{id}` is used twice."));
            }
            prompt = Some(Draft {
                id,
                title,
                words: None,
                lines: Vec::new(),
                line,
            });
        } else if let Some(rest) = text.strip_prefix("## ") {
            if let Some((mut current, start)) = pack.take() {
                if let Some(done) = prompt.take() {
                    finish_prompt(done, &mut current, site)?;
                }
                finish_pack(current, &mut packs, site, start)?;
            }
            let (id, title) = heading(rest, line, "pack")?;
            if !seen_packs.insert(id.clone()) {
                return Err(format!("Line {line}: the pack id `{id}` is used twice."));
            }
            pack = Some((
                Pack {
                    id,
                    title,
                    summary: String::new(),
                    prompts: Vec::new(),
                },
                line,
            ));
        } else if let Some(draft) = prompt.as_mut() {
            if text.trim().is_empty() && draft.words.is_none() {
                continue;
            }
            if draft.words.is_none() {
                draft.words = Some(parse_words(text.trim(), line, &draft.id)?);
            } else {
                draft.lines.push(text.to_string());
            }
        } else if let Some((current, _)) = pack.as_mut() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                if !current.summary.is_empty() {
                    current.summary.push(' ');
                }
                current.summary.push_str(trimmed);
            }
        }
        // Anything before the first pack heading (a comment, notes) is ignored.
    }
    if let Some((mut current, start)) = pack.take() {
        if let Some(done) = prompt.take() {
            finish_prompt(done, &mut current, site)?;
        }
        finish_pack(current, &mut packs, site, start)?;
    }
    Ok(packs)
}

#[cfg(test)]
mod tests;
