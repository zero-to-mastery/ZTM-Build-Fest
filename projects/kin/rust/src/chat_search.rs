//! Chat search (#124): case-folded, accent-insensitive substring matching
//! over the decrypted text arena. Nothing is indexed or kept between calls:
//! each search folds the texts it looks at and forgets them.
//!
//! Request KCHF (all integers little-endian):
//!
//! ```text
//!  0  "KCHF"
//!  4  u16 version (1)        6  u16 reserved (0)
//!  8  u32 limit (1..=200)   12  u32 flags (bit 0: attachments only,
//!                               bit 1: mentioning one member, #130)
//! 16  i64 from (posted at or after; 0 = no bound)
//! 24  i64 to   (posted before; 0 = no bound)
//! 32  u32 query bytes (at most 256)   36  u32 admin count (at most 16)
//! 40  u32 author count (at most 16)   44  u32 excluded count (at most 10,000)
//! 48  query (UTF-8), admins (16 each), authors (16 each),
//!     excluded message IDs (16 each), the mentioned member (16, only with
//!     flag bit 1: messages that mention them by name or `@everyone`), then
//!     the record-less KINE context
//! ```
//!
//! An empty query lists the messages that pass the filters. A query matches
//! text messages only. `excluded` are messages the member hid for
//! themselves.
//!
//! Result KCHR:
//!
//! ```text
//!  0  "KCHR"   4  u16 version (1)   6  u16 reserved (0)
//!  8  u32 total matches   12  u32 result count
//! 16  u32 unsearched total   20  u32 unsearched listed (at most 256)
//! 24  results, newest first: id(16), index u32, range count u32,
//!     author(16), posted at i64, content kind u32 (1 text, 2 attachment),
//!     excerpt offset u32, excerpt length u32 (60 bytes so far), then
//!     (start u32, end u32) byte ranges into the whole text, at most 4,
//!     then the excerpt: up to ~160 bytes of the text around the first match
//!     (empty without a query), starting at the excerpt offset
//!     unsearched: id(16), blob ref(32), blob key(32): texts the arena
//!     doesn't hold yet, for the host to open and search again
//! ```

use crate::chat::{ChatMessageStatus, ChatState, ChatTexts};
use crate::error::KinError;
use crate::event::{ActorId, ChatContentKind};
use std::collections::BTreeSet;

const REQUEST_VERSION: u16 = 1;
const RESULT_VERSION: u16 = 1;
pub const MAX_SEARCH_RESULTS: usize = 200;
pub const MAX_SEARCH_QUERY_BYTES: usize = 256;
pub const MAX_SEARCH_FILTER_AUTHORS: usize = 16;
pub const MAX_SEARCH_EXCLUDED: usize = 10_000;
pub const MAX_UNSEARCHED_LISTED: usize = 256;
pub const MAX_RANGES: usize = 4;
const FLAG_ATTACHMENTS_ONLY: u32 = 1;
const FLAG_MENTIONING: u32 = 2;

/// A decoded KCHF request.
#[derive(Debug)]
pub struct SearchRequest<'a> {
    pub limit: usize,
    pub attachments_only: bool,
    pub from: i64,
    pub to: i64,
    pub query: &'a str,
    pub admins: Vec<ActorId>,
    pub authors: Vec<ActorId>,
    pub excluded: BTreeSet<[u8; 16]>,
    /// Only messages that mention this member (#130).
    pub mentioning: Option<ActorId>,
    pub context: &'a [u8],
}

fn ids(bytes: &[u8]) -> Vec<[u8; 16]> {
    bytes
        .chunks_exact(16)
        .map(|chunk| chunk.try_into().unwrap())
        .collect()
}

pub fn decode_search_request(bytes: &[u8]) -> Result<SearchRequest<'_>, KinError> {
    if bytes.len() < 48 || &bytes[..4] != b"KCHF" {
        return Err(KinError::MalformedProtocol);
    }
    if u16::from_le_bytes([bytes[4], bytes[5]]) != REQUEST_VERSION {
        return Err(KinError::UnsupportedVersion);
    }
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    let limit = word(8) as usize;
    let flags = word(12);
    let from = i64::from_le_bytes(bytes[16..24].try_into().unwrap());
    let to = i64::from_le_bytes(bytes[24..32].try_into().unwrap());
    let query_length = word(32) as usize;
    let admin_count = word(36) as usize;
    let author_count = word(40) as usize;
    let excluded_count = word(44) as usize;
    if bytes[6..8] != [0; 2]
        || flags & !(FLAG_ATTACHMENTS_ONLY | FLAG_MENTIONING) != 0
        || limit == 0
        || limit > MAX_SEARCH_RESULTS
        || from < 0
        || to < 0
        || (to != 0 && to <= from)
        || query_length > MAX_SEARCH_QUERY_BYTES
        || admin_count > crate::chat::MAX_CHAT_ADMINS
        || author_count > MAX_SEARCH_FILTER_AUTHORS
        || excluded_count > MAX_SEARCH_EXCLUDED
    {
        return Err(KinError::MalformedProtocol);
    }
    let query_at = 48;
    let admins_at = query_at + query_length;
    let authors_at = admins_at + admin_count * 16;
    let excluded_at = authors_at + author_count * 16;
    let mentioning_at = excluded_at + excluded_count * 16;
    let context_at = mentioning_at + if flags & FLAG_MENTIONING != 0 { 16 } else { 0 };
    if bytes.len() < context_at {
        return Err(KinError::MalformedProtocol);
    }
    let query = std::str::from_utf8(&bytes[query_at..admins_at])
        .map_err(|_| KinError::MalformedProtocol)?;
    let actors = |range: &[u8]| ids(range).into_iter().map(ActorId).collect::<Vec<_>>();
    let admins = actors(&bytes[admins_at..authors_at]);
    let authors = actors(&bytes[authors_at..excluded_at]);
    if admins
        .iter()
        .chain(&authors)
        .any(|actor| actor.0 == [0; 16])
    {
        return Err(KinError::MalformedProtocol);
    }
    let mentioning = if flags & FLAG_MENTIONING != 0 {
        let id: [u8; 16] = bytes[mentioning_at..context_at].try_into().unwrap();
        if id == [0; 16] {
            return Err(KinError::MalformedProtocol);
        }
        Some(ActorId(id))
    } else {
        None
    };
    Ok(SearchRequest {
        limit,
        attachments_only: flags & FLAG_ATTACHMENTS_ONLY != 0,
        from,
        to,
        query,
        admins,
        authors,
        excluded: ids(&bytes[excluded_at..mentioning_at])
            .into_iter()
            .collect(),
        mentioning,
        context: &bytes[context_at..],
    })
}

// ---- folding ---------------------------------------------------------

/// Base letters of U+0100..=U+017F after lowercasing; `#` marks the few that
/// fold to two letters (handled in `base`).
const LATIN_EXTENDED_A: &[u8; 128] = b"aaaaaaccccccccdd\
ddeeeeeeeeeegggg\
gggghhhhiiiiiiii\
ii##jjkkklllllll\
lllnnnnnnnnnoooo\
oo##rrrrrrssssss\
sstttttt\
uuuuuuuu\
uuuuwwyyyzzzzzzs";

/// The letters a lowercase scalar folds to, without accents, or `None` if it
/// folds to itself.
fn base(c: char) -> Option<&'static str> {
    const LATIN_1: &[&str; 32] = &[
        "a", "a", "a", "a", "a", "a", "ae", "c", "e", "e", "e", "e", "i", "i", "i", "i", "d", "n",
        "o", "o", "o", "o", "o", "\u{f7}", "o", "u", "u", "u", "u", "y", "th", "y",
    ];
    const LETTERS: &str = "abcdefghijklmnopqrstuvwxyz";
    match c as u32 {
        0xdf => Some("ss"),
        code @ 0xe0..=0xff => Some(LATIN_1[(code - 0xe0) as usize]),
        0x132 | 0x133 => Some("ij"),
        0x152 | 0x153 => Some("oe"),
        0x1a0 | 0x1a1 => Some("o"),
        0x1af | 0x1b0 => Some("u"),
        0x1cd | 0x1ce => Some("a"),
        0x1cf | 0x1d0 => Some("i"),
        0x1d1 | 0x1d2 => Some("o"),
        0x1d3 | 0x1d4 => Some("u"),
        0x219 => Some("s"),
        0x21b => Some("t"),
        0x3c2 => Some("\u{3c3}"),
        // Latin Extended Additional (Vietnamese): runs of one base letter.
        0x1ea0..=0x1eb7 => Some("a"),
        0x1eb8..=0x1ec7 => Some("e"),
        0x1ec8..=0x1ecb => Some("i"),
        0x1ecc..=0x1ee3 => Some("o"),
        0x1ee4..=0x1ef1 => Some("u"),
        0x1ef2..=0x1ef9 => Some("y"),
        code @ 0x100..=0x17f => {
            let letter = LATIN_EXTENDED_A[(code - 0x100) as usize];
            LETTERS.find(letter as char).map(|at| &LETTERS[at..at + 1])
        }
        _ => None,
    }
}

/// Marks that don't change what a letter is: combining accents (so text
/// typed with separate accents matches too) and the emoji presentation
/// selectors.
fn ignorable(c: char) -> bool {
    matches!(c as u32, 0x300..=0x36f | 0xfe0e | 0xfe0f)
}

/// Scalars that continue the grapheme before them: a match may not end right
/// before one, start with one, nor start right after a joiner.
fn extends(c: char) -> bool {
    matches!(
        c as u32,
        0x200c
            | 0x200d
            | 0x300..=0x36f
            | 0x1ab0..=0x1aff
            | 0x1dc0..=0x1dff
            | 0x20d0..=0x20ff
            | 0xfe00..=0xfe0f
            | 0xfe20..=0xfe2f
            | 0x1f3fb..=0x1f3ff
            | 0xe0020..=0xe007f
    )
}

fn regional(c: char) -> bool {
    matches!(c as u32, 0x1f1e6..=0x1f1ff)
}

/// Whether a match of `text[start..end]` begins or ends inside a grapheme:
/// after a joiner, before a continuing scalar, starting with one, or
/// splitting a pair of regional indicators (a flag).
fn splits_grapheme(text: &str, start: usize, end: usize) -> bool {
    let first = text[start..].chars().next();
    if text[..start]
        .chars()
        .next_back()
        .is_some_and(|c| c as u32 == 0x200d)
        || first.is_some_and(|c| extends(c) && c as u32 != 0x200d)
        || text[end..].chars().next().is_some_and(extends)
    {
        return true;
    }
    // Flags are pairs: a run of indicators splits into two at a time.
    if first.is_some_and(regional) {
        let before = text[..start]
            .chars()
            .rev()
            .take_while(|&c| regional(c))
            .count();
        if before % 2 == 1 {
            return true;
        }
    }
    // A match ending on an indicator that pairs with the next one splits it.
    if text[..end].chars().next_back().is_some_and(regional)
        && text[end..].chars().next().is_some_and(regional)
    {
        let run = text[..end]
            .chars()
            .rev()
            .take_while(|&c| regional(c))
            .count();
        if run % 2 == 1 {
            return true;
        }
    }
    false
}

/// Folds `c`, calling `push` for each resulting scalar.
fn fold(c: char, mut push: impl FnMut(char)) {
    for lower in c.to_lowercase() {
        // A lowercase form may carry its own accent (İ is i and a dot).
        if ignorable(lower) {
            continue;
        }
        match base(lower) {
            Some(letters) => letters.chars().for_each(&mut push),
            None => push(lower),
        }
    }
}

fn fold_query(query: &str) -> Vec<char> {
    let mut folded = Vec::with_capacity(query.len());
    for c in query.chars().filter(|&c| !ignorable(c)) {
        fold(c, |c| folded.push(c));
    }
    folded
}

/// One folded scalar and the byte span of the original it came from (an
/// ignorable mark after it is folded into its span).
pub struct Folded {
    pub c: char,
    pub start: u32,
    pub end: u32,
}

fn fold_text(text: &str, out: &mut Vec<Folded>) {
    out.clear();
    out.reserve(text.len());
    for (start, c) in text.char_indices() {
        if c.is_ascii() {
            out.push(Folded {
                c: c.to_ascii_lowercase(),
                start: start as u32,
                end: start as u32 + 1,
            });
            continue;
        }
        let end = (start + c.len_utf8()) as u32;
        if ignorable(c) {
            if let Some(last) = out.last_mut() {
                last.end = end;
            }
            continue;
        }
        fold(c, |folded| {
            out.push(Folded {
                c: folded,
                start: start as u32,
                end,
            })
        });
    }
}

/// Up to `MAX_RANGES` byte ranges of `text` matching `query`, and whether
/// there were more. Ranges don't overlap and never cut a grapheme.
pub fn find(text: &str, query: &[char], scratch: &mut Vec<Folded>) -> (Vec<(u32, u32)>, bool) {
    let mut ranges = Vec::new();
    if query.is_empty() {
        return (ranges, false);
    }
    if text.is_ascii() && query.iter().all(char::is_ascii) {
        return find_ascii(text.as_bytes(), query, ranges);
    }
    fold_text(text, scratch);
    let mut at = 0;
    while at + query.len() <= scratch.len() {
        if scratch[at].c != query[0] {
            at += 1;
            continue;
        }
        if scratch[at..at + query.len()]
            .iter()
            .zip(query)
            .any(|(folded, wanted)| folded.c != *wanted)
        {
            at += 1;
            continue;
        }
        let start = scratch[at].start as usize;
        let end = scratch[at + query.len() - 1].end as usize;
        if splits_grapheme(text, start, end) {
            at += 1;
            continue;
        }
        if ranges.len() == MAX_RANGES {
            return (ranges, true);
        }
        ranges.push((start as u32, end as u32));
        at += query.len();
    }
    (ranges, false)
}

/// The common case, without folding: ASCII text against an ASCII query
/// (already lowercase). Nothing here can cut a grapheme.
fn find_ascii(text: &[u8], query: &[char], mut ranges: Vec<(u32, u32)>) -> (Vec<(u32, u32)>, bool) {
    let first = query[0] as u8;
    let mut at = 0;
    while at + query.len() <= text.len() {
        if text[at].to_ascii_lowercase() != first
            || !text[at + 1..at + query.len()]
                .iter()
                .zip(&query[1..])
                .all(|(byte, wanted)| byte.to_ascii_lowercase() == *wanted as u8)
        {
            at += 1;
            continue;
        }
        if ranges.len() == MAX_RANGES {
            return (ranges, true);
        }
        ranges.push((at as u32, (at + query.len()) as u32));
        at += query.len();
    }
    (ranges, false)
}

// ---- search ----------------------------------------------------------

/// One result before it is encoded.
struct Hit {
    index: usize,
    ranges: Vec<(u32, u32)>,
    offset: u32,
    excerpt: Vec<u8>,
}

/// Most bytes of text a result shows around its first match, and how many of
/// them come before it.
const EXCERPT_BYTES: usize = 160;
const EXCERPT_LEAD: usize = 48;

/// The window of `text` a result shows: its byte offset and the text, cut on
/// character boundaries and always holding the whole first match.
fn excerpt(text: &str, first: (u32, u32)) -> (u32, &str) {
    let (match_start, match_end) = (first.0 as usize, first.1 as usize);
    let mut start = match_start.saturating_sub(EXCERPT_LEAD);
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (start + EXCERPT_BYTES).max(match_end).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (start as u32, &text[start..end])
}

/// Searches a chat state against the arena and encodes KCHR.
pub fn encode_search(
    state: &ChatState,
    request: &SearchRequest<'_>,
    texts: &ChatTexts,
) -> Result<Vec<u8>, KinError> {
    let query = fold_query(request.query);
    let searching = !query.is_empty();
    // A query of nothing but accents or selectors says nothing to find.
    let empty_result = !request.query.is_empty() && !searching;
    let mut scratch = Vec::new();
    let mut total = 0u32;
    let mut results: Vec<Hit> = Vec::new();
    let mut unsearched = 0u32;
    let mut unsearched_listed: Vec<usize> = Vec::new();
    // Newest first, so the limit and the unsearched list favor recent talk.
    for (index, message) in state.messages.iter().enumerate().rev() {
        if empty_result {
            break;
        }
        let shown = if request.admins.is_empty() {
            message.status
        } else {
            state.shown_status(message, &request.admins)
        };
        if !matches!(shown, ChatMessageStatus::Live | ChatMessageStatus::Edited)
            || request.excluded.contains(&message.message_id.0)
            || (request.from != 0 && message.posted_at < request.from)
            || (request.to != 0 && message.posted_at >= request.to)
            || (!request.authors.is_empty() && !request.authors.contains(&message.author))
            || request
                .mentioning
                .is_some_and(|member| !message.mentions.includes(&member))
        {
            continue;
        }
        let attachment = message.content_kind == ChatContentKind::Attachment;
        if request.attachments_only && !attachment {
            continue;
        }
        if !searching {
            total += 1;
            if results.len() < request.limit {
                results.push(Hit {
                    index,
                    ranges: Vec::new(),
                    offset: 0,
                    excerpt: Vec::new(),
                });
            }
            continue;
        }
        if attachment {
            continue;
        }
        let Some(text) = texts.get(&message.blob_ref) else {
            unsearched += 1;
            if unsearched_listed.len() < MAX_UNSEARCHED_LISTED {
                unsearched_listed.push(index);
            }
            continue;
        };
        let Ok(text) = std::str::from_utf8(text) else {
            continue;
        };
        let (ranges, _) = find(text, &query, &mut scratch);
        if ranges.is_empty() {
            continue;
        }
        total += 1;
        if results.len() < request.limit {
            let (offset, excerpt) = excerpt(text, ranges[0]);
            results.push(Hit {
                index,
                ranges,
                offset,
                excerpt: excerpt.as_bytes().to_vec(),
            });
        }
    }
    let size = 24usize
        .checked_add(
            results
                .iter()
                .map(|hit| 60 + hit.ranges.len() * 8 + hit.excerpt.len())
                .sum::<usize>(),
        )
        .and_then(|size| size.checked_add(unsearched_listed.len() * 80))
        .ok_or(KinError::SizeLimit)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size)
        .map_err(|_| KinError::SizeLimit)?;
    bytes.extend_from_slice(b"KCHR");
    bytes.extend_from_slice(&RESULT_VERSION.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&total.to_le_bytes());
    bytes.extend_from_slice(&(results.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&unsearched.to_le_bytes());
    bytes.extend_from_slice(&(unsearched_listed.len() as u32).to_le_bytes());
    for hit in &results {
        let message = &state.messages[hit.index];
        bytes.extend_from_slice(&message.message_id.0);
        bytes.extend_from_slice(&(hit.index as u32).to_le_bytes());
        bytes.extend_from_slice(&(hit.ranges.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&message.author.0);
        bytes.extend_from_slice(&message.posted_at.to_le_bytes());
        let kind: u32 = match message.content_kind {
            ChatContentKind::Text => 1,
            ChatContentKind::Attachment => 2,
            ChatContentKind::Poll(_) => 3,
        };
        bytes.extend_from_slice(&kind.to_le_bytes());
        bytes.extend_from_slice(&hit.offset.to_le_bytes());
        bytes.extend_from_slice(&(hit.excerpt.len() as u32).to_le_bytes());
        for (start, end) in &hit.ranges {
            bytes.extend_from_slice(&start.to_le_bytes());
            bytes.extend_from_slice(&end.to_le_bytes());
        }
        bytes.extend_from_slice(&hit.excerpt);
    }
    for index in unsearched_listed {
        let message = &state.messages[index];
        bytes.extend_from_slice(&message.message_id.0);
        bytes.extend_from_slice(&message.blob_ref);
        bytes.extend_from_slice(&message.blob_key);
    }
    Ok(bytes)
}
