//! Stable passage targets in a published post (ADRs 0076 and 0077).
//!
//! A reader's question, correction or annotation points at a place in a
//! post's text. Element ids that come from position, such as citation marker
//! ids, change when the post changes and are never stored (ADR 0059). A
//! passage target instead names a section anchor (the heading id the author
//! controls) and either the whole section, checked by its digest, or a
//! quotation with a little of the text on each side.
//!
//! Targets are resolved against a [`PassageDocument`], the post's passage
//! text as published. A target resolves to the same text or is reported
//! stale with a reason; it never silently points at different text.
//! Resolution is a pure function of the target, the revision the reader saw
//! and the document: nothing here changes a post, a file or browser data.

use blake2::{Blake2s256, Digest};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::escape;

/// The version of the target format; a reader of this version refuses a
/// higher one instead of guessing.
pub const PASSAGE_TARGET_VERSION: u64 = 1;
/// The version of the passage text model, written into every revision, so
/// a revision of an older model never compares equal to a newer one.
pub const PASSAGE_TEXT_MODEL: u32 = 1;
/// The longest quotation, in Unicode scalar values.
pub const MAX_QUOTE_CHARS: usize = 500;
/// The most context kept on each side of a quotation.
pub const MAX_CONTEXT_CHARS: usize = 64;
/// The longest section anchor.
pub const MAX_ANCHOR_CHARS: usize = 200;
/// The largest offset a quotation can start at inside its section.
pub const MAX_SECTION_CHARS: usize = 1_000_000;
/// The largest serialized target accepted, before it is parsed.
pub const MAX_TARGET_JSON_BYTES: usize = 16 * 1024;
/// How much context must still agree, on at least one side, for a
/// quotation found again after an edit to count as the same passage. A side
/// shorter than this must agree in full.
pub const CONTEXT_AGREEMENT_CHARS: usize = 8;

/// Why a target or a request to make one was refused. Messages name the
/// field only and never repeat the text that was sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetError {
    pub code: TargetErrorCode,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetErrorCode {
    TooLarge,
    Malformed,
    UnsupportedVersion,
    InvalidAnchor,
    InvalidDigest,
    EmptyQuote,
    QuoteTooLong,
    ContextTooLong,
    NotNormalized,
    ForbiddenCharacter,
    SplitCharacter,
    InvalidRange,
}

impl TargetError {
    fn new(code: TargetErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for TargetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TargetError {}

/// Collapse every run of whitespace (Unicode `White_Space`) to one space and
/// trim the ends. This is the only normalization: case and Unicode
/// normalization forms are kept exactly, so a quotation copied from the
/// page matches the page, and nothing else does.
pub fn normalize_passage_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_space = false;
    for character in input.chars() {
        if character.is_whitespace() {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(character);
        }
    }
    out
}

/// A character that continues the user-perceived character before it, so a
/// target may not begin or end in front of it: combining marks of the
/// common scripts, joiners, variation selectors, emoji modifiers and tags.
/// It is a fixed, conservative approximation of UAX #29 that needs no
/// Unicode tables, so the browser and the build always agree.
pub fn is_continuing_character(character: char) -> bool {
    matches!(
        character as u32,
        0x0300..=0x036F
            | 0x0483..=0x0489
            | 0x0591..=0x05BD
            | 0x05BF
            | 0x05C1..=0x05C2
            | 0x05C4..=0x05C5
            | 0x05C7
            | 0x0610..=0x061A
            | 0x064B..=0x065F
            | 0x0670
            | 0x06D6..=0x06DC
            | 0x06DF..=0x06E4
            | 0x06E7..=0x06E8
            | 0x06EA..=0x06ED
            | 0x0900..=0x0903
            | 0x093A..=0x093C
            | 0x093E..=0x094F
            | 0x0951..=0x0957
            | 0x0962..=0x0963
            | 0x0981..=0x0983
            | 0x09BC
            | 0x09BE..=0x09CD
            | 0x09D7
            | 0x09E2..=0x09E3
            | 0x0E31
            | 0x0E34..=0x0E3A
            | 0x0E47..=0x0E4E
            | 0x1AB0..=0x1AFF
            | 0x1DC0..=0x1DFF
            | 0x200C..=0x200D
            | 0x20D0..=0x20FF
            | 0x302A..=0x302F
            | 0x3099..=0x309A
            | 0xFE00..=0xFE0F
            | 0xFE20..=0xFE2F
            | 0x1F3FB..=0x1F3FF
            | 0xE0020..=0xE007F
            | 0xE0100..=0xE01EF
    )
}

/// Whether a target may begin or end at `index` of `chars`.
fn is_boundary(chars: &[char], index: usize) -> bool {
    index == 0
        || index >= chars.len()
        || (!is_continuing_character(chars[index]) && chars[index - 1] != '\u{200D}')
}

/// Control characters, and the bidirectional embeddings, overrides and
/// isolates that can make a quotation display differently from its text.
fn is_forbidden(character: char) -> bool {
    character.is_control() || crate::research_notes::bidi_override(character)
}

/// One section of a post's passage text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PassageSection {
    /// The heading id, or `None` for the text before the first heading.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    /// The heading's title and the section's text, whitespace collapsed.
    pub text: String,
    /// A fingerprint of `text`, so a section target can tell an unchanged
    /// section from a changed one.
    pub digest: String,
}

/// A post's passage text as published: the text a reader can quote,
/// section by section, and its revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PassageDocument {
    /// `p<model>:<32 hex digits>`, a fingerprint of every anchor and text.
    pub revision: String,
    pub sections: Vec<PassageSection>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn put(hasher: &mut Blake2s256, part: &[u8]) {
    hasher.update((part.len() as u64).to_be_bytes());
    hasher.update(part);
}

/// The digest of one section's normalized text.
pub fn section_digest(text: &str) -> String {
    let mut hasher = Blake2s256::new();
    hasher.update(b"openblog-passage-section-v1\0");
    put(&mut hasher, text.as_bytes());
    hex(&hasher.finalize()[..16])
}

/// The digest of one author's published section of a shared reflection,
/// from the section's normalized Markdown. It has its own label: a turn is
/// not a heading section, so its digest is never equal to (and never mistaken
/// for) the digest B5 gives a heading section with the same words, and a
/// stored target of one kind cannot resolve against the other.
pub fn attributed_section_digest(text: &str) -> String {
    let mut hasher = Blake2s256::new();
    hasher.update(b"openblog-attributed-section-v1\0");
    put(&mut hasher, text.as_bytes());
    hex(&hasher.finalize()[..16])
}

/// Whether `value` is written like a passage revision of any model.
pub fn is_passage_revision(value: &str) -> bool {
    let Some((model, digest)) = value.split_once(':') else {
        return false;
    };
    let Some(number) = model.strip_prefix('p') else {
        return false;
    };
    !number.is_empty()
        && number.len() <= 4
        && !number.starts_with('0')
        && number.bytes().all(|byte| byte.is_ascii_digit())
        && is_digest(digest)
}

fn is_digest(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

impl PassageDocument {
    /// A document from sections in reading order. Text is normalized here;
    /// the text before the first heading is dropped when it is empty.
    pub fn from_sections(sections: Vec<(Option<String>, String)>) -> Self {
        let sections: Vec<PassageSection> = sections
            .into_iter()
            .map(|(anchor, text)| {
                let text = normalize_passage_text(&text);
                PassageSection {
                    digest: section_digest(&text),
                    anchor,
                    text,
                }
            })
            .filter(|section| section.anchor.is_some() || !section.text.is_empty())
            .collect();
        let mut hasher = Blake2s256::new();
        hasher.update(b"openblog-passage-revision-v1\0");
        hasher.update((sections.len() as u64).to_be_bytes());
        for section in &sections {
            match &section.anchor {
                None => hasher.update([0]),
                Some(anchor) => {
                    hasher.update([1]);
                    put(&mut hasher, anchor.as_bytes());
                }
            }
            put(&mut hasher, section.text.as_bytes());
        }
        let revision = format!("p{PASSAGE_TEXT_MODEL}:{}", hex(&hasher.finalize()[..16]));
        Self { revision, sections }
    }

    /// The passage text of a publication body, read as the native page
    /// renders it (see [`crate::markdown`]), without embeds; see
    /// [`PassageDocument::of_post`] for a post under a site's settings.
    pub fn from_markdown(markdown: &str, smart_punctuation: bool) -> Self {
        Self::from_sections(crate::markdown::passage_sections(
            markdown,
            smart_punctuation,
            false,
            None,
            false,
        ))
    }

    /// The passage text of a loaded post: its publication Markdown, without
    /// the generated citation notes region of a post that publishes them.
    pub fn of_post(post: &crate::Post, config: &crate::SiteConfig) -> Self {
        let labels = post
            .citations()
            .map(|summary| crate::bibliography::CitationNoteLabels {
                prefix: &summary.prefix,
                locale: summary.locale,
            });
        Self::from_sections(crate::markdown::passage_sections(
            post.publication_markdown(),
            config.markdown.smart_punctuation,
            config.markdown.embeds,
            labels.as_ref(),
            post.reading_depth().is_some(),
        ))
    }

    fn sections_with(&self, anchor: Option<&str>) -> Vec<usize> {
        self.sections
            .iter()
            .enumerate()
            .filter(|(_, section)| section.anchor.as_deref() == anchor)
            .map(|(index, _)| index)
            .collect()
    }

    fn location(&self, index: usize, start: usize, end: usize) -> Location {
        Location {
            section: self.sections[index].anchor.clone(),
            index: Some(index),
            start,
            end,
        }
    }

    /// The text a location points at, read from the section the location
    /// names by its index. Two sections may share an anchor (an author's
    /// `{#id}` can repeat a generated one), so the anchor alone never picks
    /// the section; a location whose anchor does not match its index's
    /// section points at nothing.
    pub fn text_at(&self, location: &Location) -> Option<String> {
        let section = self.sections.get(location.index?)?;
        if section.anchor != location.section {
            return None;
        }
        let chars: Vec<char> = section.text.chars().collect();
        (location.start <= location.end && location.end <= chars.len())
            .then(|| chars[location.start..location.end].iter().collect())
    }

    /// A target for the whole post, which has no section or selector.
    pub fn work_target(&self) -> PassageTarget {
        PassageTarget {
            section: None,
            selector: PassageSelector::Work,
        }
    }

    /// A target for the whole of section `index`, with its digest.
    pub fn section_target(&self, index: usize) -> Result<PassageTarget, TargetError> {
        let section = self.sections.get(index).ok_or_else(|| {
            TargetError::new(TargetErrorCode::InvalidRange, "there is no such section")
        })?;
        let target = PassageTarget {
            section: section.anchor.clone(),
            selector: PassageSelector::Section {
                digest: Some(section.digest.clone()),
            },
        };
        target.validate()?;
        Ok(target)
    }

    /// A quotation target for characters `start..end` of section `index`,
    /// with up to [`MAX_CONTEXT_CHARS`] of context on each side, cut at
    /// character boundaries. Spaces at either end of the range are left
    /// out; a range that starts or ends inside a character is refused.
    pub fn quote(
        &self,
        index: usize,
        start: usize,
        end: usize,
    ) -> Result<PassageTarget, TargetError> {
        let section = self.sections.get(index).ok_or_else(|| {
            TargetError::new(TargetErrorCode::InvalidRange, "there is no such section")
        })?;
        let chars: Vec<char> = section.text.chars().collect();
        if start > end || end > chars.len() {
            return Err(TargetError::new(
                TargetErrorCode::InvalidRange,
                "the selection is outside the section",
            ));
        }
        let (mut start, mut end) = (start, end);
        while start < end && chars[start] == ' ' {
            start += 1;
        }
        while end > start && chars[end - 1] == ' ' {
            end -= 1;
        }
        if start == end {
            return Err(TargetError::new(
                TargetErrorCode::EmptyQuote,
                "the selection holds no text",
            ));
        }
        if !is_boundary(&chars, start) || !is_boundary(&chars, end) {
            return Err(TargetError::new(
                TargetErrorCode::SplitCharacter,
                "the selection starts or ends inside a character",
            ));
        }
        let mut prefix_start = start.saturating_sub(MAX_CONTEXT_CHARS);
        while !is_boundary(&chars, prefix_start) {
            prefix_start += 1;
        }
        let mut suffix_end = (end + MAX_CONTEXT_CHARS).min(chars.len());
        while !is_boundary(&chars, suffix_end) {
            suffix_end -= 1;
        }
        let target = PassageTarget {
            section: section.anchor.clone(),
            selector: PassageSelector::Quote(TextQuote {
                exact: chars[start..end].iter().collect(),
                prefix: chars[prefix_start..start].iter().collect(),
                suffix: chars[end..suffix_end].iter().collect(),
                start,
            }),
        };
        target.validate()?;
        Ok(target)
    }

    /// Resolve a target against this document. `seen` is the revision the
    /// reader saw, when known; only a target seen at this very revision can
    /// be [`Resolution::Current`].
    pub fn resolve(&self, target: &PassageTarget, seen: Option<&str>) -> Resolution {
        let same_revision = seen == Some(self.revision.as_str());
        let anchor = target.section.as_deref();
        let section_present = !self.sections_with(anchor).is_empty();
        match &target.selector {
            // The whole post is there as long as this document is.
            PassageSelector::Work => Resolution::Current(Location {
                section: None,
                index: None,
                start: 0,
                end: 0,
            }),
            PassageSelector::Section { digest } => {
                self.resolve_section(anchor, digest.as_deref(), same_revision, section_present)
            }
            PassageSelector::Quote(quote) => {
                self.resolve_quote(anchor, quote, same_revision, section_present)
            }
        }
    }

    fn resolve_section(
        &self,
        anchor: Option<&str>,
        digest: Option<&str>,
        same_revision: bool,
        section_present: bool,
    ) -> Resolution {
        let stale = |reason| {
            Resolution::Stale(Stale {
                reason,
                section_present,
            })
        };
        let whole =
            |index: usize| self.location(index, 0, self.sections[index].text.chars().count());
        let named = self.sections_with(anchor);
        let Some(digest) = digest else {
            return match named.as_slice() {
                [] => stale(StaleReason::SectionRemoved),
                [index] if same_revision => Resolution::Current(whole(*index)),
                [_] => stale(StaleReason::Unverified),
                _ => stale(StaleReason::Ambiguous),
            };
        };
        let same_text: Vec<usize> = (0..self.sections.len())
            .filter(|index| self.sections[*index].digest == digest)
            .collect();
        let unchanged: Vec<usize> = same_text
            .iter()
            .copied()
            .filter(|index| named.contains(index))
            .collect();
        match (unchanged.as_slice(), same_text.as_slice()) {
            ([index], _) if same_revision => Resolution::Current(whole(*index)),
            ([index], _) => Resolution::Reanchored(whole(*index)),
            ([_, _, ..], _) => stale(StaleReason::Ambiguous),
            // The same text under one other anchor is the same section,
            // renamed or renumbered.
            ([], [index]) => Resolution::Reanchored(whole(*index)),
            ([], [_, _, ..]) => stale(StaleReason::Ambiguous),
            ([], []) if named.is_empty() => stale(StaleReason::SectionRemoved),
            ([], []) => stale(StaleReason::SectionChanged),
        }
    }

    fn resolve_quote(
        &self,
        anchor: Option<&str>,
        quote: &TextQuote,
        same_revision: bool,
        section_present: bool,
    ) -> Resolution {
        let exact: Vec<char> = quote.exact.chars().collect();
        let prefix: Vec<char> = quote.prefix.chars().collect();
        let suffix: Vec<char> = quote.suffix.chars().collect();
        let named = self.sections_with(anchor);

        if same_revision {
            for &index in &named {
                let chars: Vec<char> = self.sections[index].text.chars().collect();
                let end = quote.start + exact.len();
                if end <= chars.len()
                    && chars[quote.start..end] == exact[..]
                    && chars[..quote.start].ends_with(&prefix)
                    && chars[end..].starts_with(&suffix)
                    && is_boundary(&chars, quote.start)
                    && is_boundary(&chars, end)
                {
                    return Resolution::Current(self.location(index, quote.start, end));
                }
            }
        }

        let mut found = false;
        // (context agreement, same section), section, start; and whether
        // another candidate scores the same.
        let mut best: Option<((usize, bool), usize, usize)> = None;
        let mut tied = false;
        for (index, section) in self.sections.iter().enumerate() {
            let chars: Vec<char> = section.text.chars().collect();
            if exact.len() > chars.len() {
                continue;
            }
            for start in 0..=chars.len() - exact.len() {
                let end = start + exact.len();
                if chars[start..end] != exact[..]
                    || !is_boundary(&chars, start)
                    || !is_boundary(&chars, end)
                {
                    continue;
                }
                found = true;
                let before = common_suffix(&prefix, &chars[..start]);
                let after = common_prefix(&suffix, &chars[end..]);
                let agrees = |common: usize, wanted: usize, at_edge: bool| {
                    if wanted == 0 {
                        at_edge
                    } else {
                        common >= wanted.min(CONTEXT_AGREEMENT_CHARS)
                    }
                };
                if !agrees(before, prefix.len(), start == 0)
                    && !agrees(after, suffix.len(), end == chars.len())
                {
                    continue;
                }
                let score = (before + after, named.contains(&index));
                match &best {
                    Some((known, _, _)) if *known > score => {}
                    Some((known, _, _)) if *known == score => tied = true,
                    _ => {
                        best = Some((score, index, start));
                        tied = false;
                    }
                }
            }
        }
        let stale = |reason| {
            Resolution::Stale(Stale {
                reason,
                section_present,
            })
        };
        match best {
            Some(_) if tied => stale(StaleReason::Ambiguous),
            Some((_, index, start)) => {
                Resolution::Reanchored(self.location(index, start, start + exact.len()))
            }
            None if found => stale(StaleReason::ContextChanged),
            None => stale(StaleReason::QuoteNotFound),
        }
    }
}

/// How many characters at the end of `wanted` match the end of `text`.
fn common_suffix(wanted: &[char], text: &[char]) -> usize {
    wanted
        .iter()
        .rev()
        .zip(text.iter().rev())
        .take_while(|(a, b)| a == b)
        .count()
}

/// How many characters at the start of `wanted` match the start of `text`.
fn common_prefix(wanted: &[char], text: &[char]) -> usize {
    wanted
        .iter()
        .zip(text.iter())
        .take_while(|(a, b)| a == b)
        .count()
}

/// A quotation and the text around it, inside one section. Offsets count
/// Unicode scalar values of the section's passage text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextQuote {
    pub exact: String,
    /// Up to [`MAX_CONTEXT_CHARS`] of the section's text right before
    /// `exact`; empty when the quotation starts the section.
    pub prefix: String,
    /// Up to [`MAX_CONTEXT_CHARS`] right after it; empty when it ends the
    /// section.
    pub suffix: String,
    /// Where `exact` started in its section at the revision the reader saw.
    /// A hint: only trusted at that same revision.
    pub start: usize,
}

/// What a target selects inside its section.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PassageSelector {
    /// The whole section. Without a digest it can only be checked against
    /// the revision the reader saw.
    Section {
        digest: Option<String>,
    },
    Quote(TextQuote),
    /// The whole post: no section and no selector. It stays current while
    /// the post is published, whatever its text, so a reflection on the
    /// whole work keeps valid provenance.
    Work,
}

/// A durable pointer at published text: a section anchor and a selector.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PassageTarget {
    /// The heading id of the section, or `None` for the text before the
    /// first heading.
    pub section: Option<String>,
    pub selector: PassageSelector,
}

/// The serialized form, one flat object (ADR 0076).
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireTarget {
    version: u64,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    section: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exact: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    suffix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    start: Option<u64>,
}

fn check_text(field: &str, value: &str, max: usize, trimmed: bool) -> Result<usize, TargetError> {
    let count = value.chars().count();
    if count > max {
        let code = if field == "exact" {
            TargetErrorCode::QuoteTooLong
        } else {
            TargetErrorCode::ContextTooLong
        };
        return Err(TargetError::new(
            code,
            format!("`{field}` is longer than {max} characters"),
        ));
    }
    if value.chars().any(is_forbidden) {
        return Err(TargetError::new(
            TargetErrorCode::ForbiddenCharacter,
            format!("`{field}` holds a control or text-direction character"),
        ));
    }
    let spaced = value.chars().any(|c| c.is_whitespace() && c != ' ') || value.contains("  ");
    if spaced || (trimmed && (value.starts_with(' ') || value.ends_with(' '))) {
        return Err(TargetError::new(
            TargetErrorCode::NotNormalized,
            format!("`{field}` is not passage text: whitespace must be single spaces"),
        ));
    }
    Ok(count)
}

impl PassageTarget {
    /// Check every bound and character rule (ADR 0076).
    pub fn validate(&self) -> Result<(), TargetError> {
        if let Some(anchor) = &self.section {
            let count = anchor.chars().count();
            if count == 0
                || count > MAX_ANCHOR_CHARS
                || anchor.chars().any(|c| c.is_whitespace() || is_forbidden(c))
            {
                return Err(TargetError::new(
                    TargetErrorCode::InvalidAnchor,
                    format!("`section` must be a heading id of 1 to {MAX_ANCHOR_CHARS} characters without spaces"),
                ));
            }
        }
        match &self.selector {
            PassageSelector::Work => {
                if self.section.is_some() {
                    return Err(TargetError::new(
                        TargetErrorCode::Malformed,
                        "a work target has no `section`",
                    ));
                }
            }
            PassageSelector::Section { digest } => {
                if digest.as_deref().is_some_and(|digest| !is_digest(digest)) {
                    return Err(TargetError::new(
                        TargetErrorCode::InvalidDigest,
                        "`digest` must be 32 lowercase hexadecimal digits",
                    ));
                }
            }
            PassageSelector::Quote(quote) => {
                if quote.exact.is_empty() {
                    return Err(TargetError::new(
                        TargetErrorCode::EmptyQuote,
                        "`exact` must quote some text",
                    ));
                }
                check_text("exact", &quote.exact, MAX_QUOTE_CHARS, true)?;
                check_text("prefix", &quote.prefix, MAX_CONTEXT_CHARS, false)?;
                check_text("suffix", &quote.suffix, MAX_CONTEXT_CHARS, false)?;
                let split = |value: &str, starts: bool| {
                    let chars: Vec<char> = value.chars().collect();
                    !chars.is_empty()
                        && if starts {
                            is_continuing_character(chars[0])
                        } else {
                            chars[chars.len() - 1] == '\u{200D}'
                        }
                };
                // The context must leave the quotation whole too: a prefix
                // may not end in a joiner, nor a suffix start with a
                // continuing character.
                let joins_quote = quote.prefix.ends_with('\u{200D}')
                    || quote
                        .suffix
                        .chars()
                        .next()
                        .is_some_and(is_continuing_character);
                if split(&quote.exact, true)
                    || split(&quote.exact, false)
                    || split(&quote.prefix, true)
                    || split(&quote.suffix, false)
                    || joins_quote
                {
                    return Err(TargetError::new(
                        TargetErrorCode::SplitCharacter,
                        "a quotation or its context starts or ends inside a character",
                    ));
                }
                if quote.start > MAX_SECTION_CHARS {
                    return Err(TargetError::new(
                        TargetErrorCode::InvalidRange,
                        format!("`start` is beyond {MAX_SECTION_CHARS}"),
                    ));
                }
            }
        }
        Ok(())
    }

    /// Read a target from its JSON value, refusing a newer version, an
    /// unknown field or any rule it breaks. Nothing is repaired.
    pub fn from_value(value: &Value) -> Result<Self, TargetError> {
        let malformed = |what: &str| TargetError::new(TargetErrorCode::Malformed, what.to_string());
        let object = value
            .as_object()
            .ok_or_else(|| malformed("a passage target must be a JSON object"))?;
        match object.get("version").and_then(Value::as_u64) {
            Some(PASSAGE_TARGET_VERSION) => {}
            Some(version) if version > PASSAGE_TARGET_VERSION => {
                return Err(TargetError::new(
                    TargetErrorCode::UnsupportedVersion,
                    format!("this passage target is version {version}, newer than the version {PASSAGE_TARGET_VERSION} this open.blog reads"),
                ));
            }
            _ => return Err(malformed("a passage target needs `version` 1")),
        }
        let wire: WireTarget = serde_json::from_value(value.clone()).map_err(|_| {
            malformed("a passage target has a field this version does not define, or a field of the wrong type")
        })?;
        let target = match wire.kind.as_str() {
            "work" => {
                if wire.section.is_some()
                    || wire.digest.is_some()
                    || wire.exact.is_some()
                    || wire.prefix.is_some()
                    || wire.suffix.is_some()
                    || wire.start.is_some()
                {
                    return Err(malformed("a work target has no section or selector fields"));
                }
                PassageTarget {
                    section: None,
                    selector: PassageSelector::Work,
                }
            }
            "section" => {
                if wire.exact.is_some()
                    || wire.prefix.is_some()
                    || wire.suffix.is_some()
                    || wire.start.is_some()
                {
                    return Err(malformed("a section target has no quotation fields"));
                }
                PassageTarget {
                    section: wire.section,
                    selector: PassageSelector::Section {
                        digest: wire.digest,
                    },
                }
            }
            "quote" => {
                let (Some(exact), Some(prefix), Some(suffix), Some(start)) =
                    (wire.exact, wire.prefix, wire.suffix, wire.start)
                else {
                    return Err(malformed(
                        "a quote target needs `exact`, `prefix`, `suffix` and `start`",
                    ));
                };
                if wire.digest.is_some() {
                    return Err(malformed("a quote target has no `digest`"));
                }
                let start = usize::try_from(start)
                    .ok()
                    .filter(|start| *start <= MAX_SECTION_CHARS)
                    .ok_or_else(|| {
                        TargetError::new(
                            TargetErrorCode::InvalidRange,
                            format!("`start` is beyond {MAX_SECTION_CHARS}"),
                        )
                    })?;
                PassageTarget {
                    section: wire.section,
                    selector: PassageSelector::Quote(TextQuote {
                        exact,
                        prefix,
                        suffix,
                        start,
                    }),
                }
            }
            _ => return Err(malformed("`kind` must be `work`, `section` or `quote`")),
        };
        target.validate()?;
        Ok(target)
    }

    /// Read a target from JSON text no larger than [`MAX_TARGET_JSON_BYTES`].
    pub fn from_json(text: &str) -> Result<Self, TargetError> {
        if text.len() > MAX_TARGET_JSON_BYTES {
            return Err(TargetError::new(
                TargetErrorCode::TooLarge,
                format!("a passage target is larger than {MAX_TARGET_JSON_BYTES} bytes"),
            ));
        }
        let value: Value = serde_json::from_str(text).map_err(|_| {
            TargetError::new(
                TargetErrorCode::Malformed,
                "a passage target is not valid JSON",
            )
        })?;
        Self::from_value(&value)
    }

    fn wire(&self) -> WireTarget {
        let mut wire = WireTarget {
            version: PASSAGE_TARGET_VERSION,
            kind: String::new(),
            section: self.section.clone(),
            digest: None,
            exact: None,
            prefix: None,
            suffix: None,
            start: None,
        };
        match &self.selector {
            PassageSelector::Work => wire.kind = "work".into(),
            PassageSelector::Section { digest } => {
                wire.kind = "section".into();
                wire.digest = digest.clone();
            }
            PassageSelector::Quote(quote) => {
                wire.kind = "quote".into();
                wire.exact = Some(quote.exact.clone());
                wire.prefix = Some(quote.prefix.clone());
                wire.suffix = Some(quote.suffix.clone());
                wire.start = Some(quote.start as u64);
            }
        }
        wire
    }

    /// The JSON value, in a fixed field order.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self.wire()).expect("a passage target always serializes")
    }

    /// Canonical JSON text.
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.wire()).expect("a passage target always serializes")
    }

    /// The quotation with its context as escaped HTML, for a moderator or a
    /// revision note: `prefix<mark>exact</mark>suffix` inside one span. A
    /// section target shows nothing quoted, so this is `None`.
    pub fn context_html(&self) -> Option<String> {
        let PassageSelector::Quote(quote) = &self.selector else {
            return None;
        };
        let mut html = String::from("<span class=\"ob-passage-context\">");
        escape::push_text(&mut html, &quote.prefix);
        html.push_str("<mark>");
        escape::push_text(&mut html, &quote.exact);
        html.push_str("</mark>");
        escape::push_text(&mut html, &quote.suffix);
        html.push_str("</span>");
        Some(html)
    }
}

/// Where a resolved target points now. Offsets count Unicode scalar values
/// of the section's passage text; a section target spans the whole section.
/// `index` is the section's position in the document, the only unambiguous
/// name for it: anchors can repeat. A work target points at no section, so it
/// has no index and an empty range.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Location {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
    pub start: usize,
    pub end: usize,
}

/// Why a target no longer resolves.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StaleReason {
    /// The quoted text is nowhere in the post.
    QuoteNotFound,
    /// The quoted text is still there, but none of its context is.
    ContextChanged,
    /// The text is found in more than one place equally well.
    Ambiguous,
    /// The section is gone and no section holds its text.
    SectionRemoved,
    /// The section is still there with different text.
    SectionChanged,
    /// A section target without a digest, seen at another revision: the
    /// section is there, but nothing shows whether its text changed.
    Unverified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stale {
    pub reason: StaleReason,
    /// Whether a section with the target's anchor still exists, for honest
    /// context ("this was in Methods, which has since changed"). It is
    /// never a location.
    pub section_present: bool,
}

/// The outcome of resolving a target (ADR 0077).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Resolution {
    /// Seen at this revision, and the text is where the target says.
    Current(Location),
    /// Seen at another revision; the same text was found again, uniquely,
    /// as the same passage (it may have moved).
    Reanchored(Location),
    /// The text the reader saw cannot be found as the same passage.
    Stale(Stale),
}

impl Resolution {
    pub fn location(&self) -> Option<&Location> {
        match self {
            Self::Current(location) | Self::Reanchored(location) => Some(location),
            Self::Stale(_) => None,
        }
    }

    pub fn is_stale(&self) -> bool {
        matches!(self, Self::Stale(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The attributed-section digest is a stored identity: a target written
    /// by one release must resolve in the next, so its exact bytes (label, NUL
    /// separator, length prefix, text) are pinned. Changing any of them
    /// changes every stored value, and so must fail here. The values were
    /// computed independently with BLAKE2s-256, truncated to 16 bytes.
    #[test]
    fn the_attributed_section_digest_is_pinned() {
        assert_eq!(
            attributed_section_digest("A section of words."),
            "ac8d1f6dcb8cf8257736552796f2e483"
        );
        assert_eq!(
            attributed_section_digest(""),
            "ff6c72bdeffde294efd45914a34b5773"
        );
        assert_ne!(
            attributed_section_digest("A section of words."),
            section_digest("A section of words."),
            "a turn is never mistaken for a heading section"
        );
    }

    #[test]
    fn whitespace_collapses_and_nothing_else_changes() {
        assert_eq!(normalize_passage_text("  a\t\nb\u{00A0} c  "), "a b c");
        assert_eq!(normalize_passage_text("Cafe\u{301} É"), "Cafe\u{301} É");
        assert_eq!(normalize_passage_text(" \n "), "");
    }

    #[test]
    fn revisions_are_written_with_their_model() {
        let doc = PassageDocument::from_sections(vec![(None, "Hello".into())]);
        assert!(doc.revision.starts_with("p1:"));
        assert!(is_passage_revision(&doc.revision));
        assert!(is_passage_revision("p2:0123456789abcdef0123456789abcdef"));
        for bad in [
            "p0:0123456789abcdef0123456789abcdef",
            "p1:0123",
            "x1:0123456789abcdef0123456789abcdef",
            "p1:0123456789ABCDEF0123456789abcdef",
        ] {
            assert!(!is_passage_revision(bad), "{bad}");
        }
    }

    #[test]
    fn boundaries_never_split_a_combined_character() {
        let chars: Vec<char> = "e\u{301}x\u{200D}y".chars().collect();
        assert!(is_boundary(&chars, 0));
        assert!(!is_boundary(&chars, 1), "before a combining mark");
        assert!(is_boundary(&chars, 2));
        assert!(!is_boundary(&chars, 3), "before a joiner");
        assert!(!is_boundary(&chars, 4), "after a joiner");
        assert!(is_boundary(&chars, 5));
    }
}
