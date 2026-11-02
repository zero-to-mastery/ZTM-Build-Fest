//! Household chat (#109): the chat domain's state, its text rules, the text
//! arena, and the page the host reads.
//!
//! Chat events carry metadata and a reference only. Each message's text (or
//! attachment) lives in a content blob encrypted with its own random key,
//! outside the immutable log (#110), so deleting a message can delete its
//! content. An event holds the blob's 32-byte content hash (`blob_ref`) and
//! its 32-byte key; the text reaches Rust only when the host has fetched and
//! decrypted a blob and asks Rust to check it (`check_text`).
//!
//! Chat is not part of the KINS projection. It leaves the engine through
//! `kin_chat_page` (core.rs), like device names through `kin_device_names`.
//!
//! State is kept for fixed-size records in posting (replay) order, with the
//! decrypted texts in a separate append-only arena referenced by offset and
//! length. The arena lives on the engine instance, only while it is
//! unlocked (`kin_clear` drops it with everything else).
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

use crate::error::KinError;
use crate::event::{ActorId, ChatContentKind, ChatMessageId, DeviceId};

/// Most Unicode scalar values a message's text may have.
pub const MAX_CHAT_TEXT_CHARS: usize = 4_000;
pub const MAX_CHAT_TEXT_BYTES: usize = MAX_CHAT_TEXT_CHARS * 4;
/// Most messages one page returns.
pub const MAX_CHAT_PAGE: usize = 500;
/// Most events the chat log holds (history.rs): 100,000 messages with room
/// for their edits and deletions.
pub const MAX_CHAT_EVENT_COUNT: usize = 250_000;
/// Admins a page request may name.
pub const MAX_CHAT_ADMINS: usize = 16;
/// Members a command may name as able to read chat (#130), and so as
/// mentionable.
pub const MAX_CHAT_MEMBERS: usize = 64;
/// Most members one message may mention by name (#130); `@everyone` is a flag.
pub const MAX_CHAT_MENTIONS: usize = 20;
/// Most bytes one reaction emoji may have (#127).
pub const MAX_EMOJI_BYTES: usize = 32;
/// Most different emoji a message may collect; commands refuse a new one
/// past it and replay ignores it.
pub const MAX_REACTION_GROUPS: usize = 24;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ChatMessageStatus {
    Live = 0,
    Edited = 1,
    /// Deleted by its author for everyone.
    Deleted = 2,
    /// Deleted for everyone by a household admin (decided at page time from
    /// the admins the host names; see `ChatState::removed_by_admin`).
    RemovedByAdmin = 3,
}

/// Who a message mentions (#130): members by ID, and everyone who can read
/// chat. Member IDs are kept in ascending order, once each, so a mention list
/// has one encoding.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ChatMentions {
    pub everyone: bool,
    pub members: Vec<ActorId>,
}

const MENTIONS_EVERYONE: u8 = 1;
const MENTIONS_REPLY: u8 = 2;

impl ChatMentions {
    pub fn is_empty(&self) -> bool {
        !self.everyone && self.members.is_empty()
    }

    /// Whether this names no more than `MAX_CHAT_MENTIONS` members, none
    /// zero, in ascending order without repeats.
    pub fn is_valid(&self) -> bool {
        self.members.len() <= MAX_CHAT_MENTIONS
            && self.members.iter().all(|member| member.0 != [0; 16])
            && self.members.windows(2).all(|pair| pair[0].0 < pair[1].0)
    }

    /// Whether `actor` is mentioned, by name or by `@everyone`.
    pub fn includes(&self, actor: &ActorId) -> bool {
        self.everyone || self.members.contains(actor)
    }

    /// The bytes that follow a post's or edit's fixed part: nothing, or for
    /// a reply alone its 16-byte message ID, or (with mentions) flags u8 (1
    /// everyone, 2 a reply follows), count u8, the member IDs, then the
    /// reply ID if flagged.
    pub fn encode_tail(&self, reply: Option<&ChatMessageId>) -> Vec<u8> {
        if self.is_empty() {
            return reply.map(|id| id.0.to_vec()).unwrap_or_default();
        }
        let mut bytes = vec![
            (u8::from(self.everyone) * MENTIONS_EVERYONE)
                | (u8::from(reply.is_some()) * MENTIONS_REPLY),
            self.members.len() as u8,
        ];
        for member in &self.members {
            bytes.extend_from_slice(&member.0);
        }
        if let Some(reply) = reply {
            bytes.extend_from_slice(&reply.0);
        }
        bytes
    }

    /// The inverse of `encode_tail`. `allow_reply` is false for an edit.
    /// Anything that is not the one encoding of its meaning is malformed.
    pub fn decode_tail(
        tail: &[u8],
        allow_reply: bool,
    ) -> Result<(ChatMentions, Option<ChatMessageId>), KinError> {
        let reply_id = |bytes: &[u8]| -> Result<ChatMessageId, KinError> {
            let id: [u8; 16] = bytes.try_into().map_err(|_| KinError::MalformedProtocol)?;
            if id == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            Ok(ChatMessageId(id))
        };
        if tail.is_empty() {
            return Ok((ChatMentions::default(), None));
        }
        if tail.len() == 16 {
            return if allow_reply {
                Ok((ChatMentions::default(), Some(reply_id(tail)?)))
            } else {
                Err(KinError::MalformedProtocol)
            };
        }
        if tail.len() < 2 {
            return Err(KinError::MalformedProtocol);
        }
        let (flags, count) = (tail[0], tail[1] as usize);
        let replied = flags & MENTIONS_REPLY != 0;
        if flags & !(MENTIONS_EVERYONE | MENTIONS_REPLY) != 0
            || replied && !allow_reply
            || count > MAX_CHAT_MENTIONS
            || tail.len() != 2 + count * 16 + if replied { 16 } else { 0 }
        {
            return Err(KinError::MalformedProtocol);
        }
        let members = tail[2..2 + count * 16]
            .chunks_exact(16)
            .map(|chunk| ActorId(chunk.try_into().unwrap()))
            .collect::<Vec<_>>();
        let mentions = ChatMentions {
            everyone: flags & MENTIONS_EVERYONE != 0,
            members,
        };
        if mentions.is_empty() || !mentions.is_valid() {
            return Err(KinError::MalformedProtocol);
        }
        let reply = replied
            .then(|| reply_id(&tail[2 + count * 16..]))
            .transpose()?;
        Ok((mentions, reply))
    }
}

/// One message, as replay leaves it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatMessage {
    pub message_id: ChatMessageId,
    pub author: ActorId,
    pub device: DeviceId,
    pub posted_at: i64,
    /// 0 until the first edit.
    pub edited_at: i64,
    pub status: ChatMessageStatus,
    pub content_kind: ChatContentKind,
    /// The current content blob. Zero once deleted.
    pub blob_ref: [u8; 32],
    pub blob_key: [u8; 32],
    /// The message this one answers, if it is a reply (#129).
    pub reply_to: Option<ChatMessageId>,
    /// Who the message mentions (#130): replaced by an edit.
    pub mentions: ChatMentions,
}

/// One emoji on one message and the members who chose it, in the order replay
/// saw them (#127).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReactionGroup {
    pub emoji: String,
    pub actors: Vec<ActorId>,
}

/// Most messages a household can have pinned at once (#131).
pub const MAX_PINS: usize = 10;
/// Most pins a log keeps, shown or not: commands stop at `MAX_PINS` shown
/// pins, so only concurrent pins or removed messages reach past it.
pub const MAX_PIN_RECORDS: usize = 64;

/// A pinned message and who pinned it (#131).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatPin {
    pub message_id: ChatMessageId,
    pub by: ActorId,
}

/// Fewest and most options a poll has (#135).
pub const MIN_POLL_OPTIONS: u8 = 2;
pub const MAX_POLL_OPTIONS: u8 = 10;
/// Most members whose votes one poll keeps; a household has at most 64
/// members who can read chat, so only a rogue log reaches it.
pub const MAX_POLL_VOTERS: usize = 64;

/// What a poll allows (#135): how many options it has and whether a member
/// may choose several. The question and options themselves are the content
/// blob.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PollSpec {
    pub options: u8,
    pub multiple: bool,
}

impl PollSpec {
    pub fn is_valid(&self) -> bool {
        (MIN_POLL_OPTIONS..=MAX_POLL_OPTIONS).contains(&self.options)
    }

    /// Whether `choice` (bit n is option n) is a vote this poll accepts:
    /// only its own options, and one at most unless it allows several. None
    /// is accepted too: it clears the member's vote.
    pub fn allows(&self, choice: u16) -> bool {
        choice >> self.options == 0 && (self.multiple || choice.count_ones() <= 1)
    }
}

/// The votes of one poll as replay leaves them (#135).
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PollState {
    /// Each voter's current choice (never zero), the last write in replay
    /// order.
    pub votes: BTreeMap<ActorId, u16>,
    pub closed: bool,
}

/// Event kind 65 (#312, ADR 0014): a "Talk later" flag on a message.
pub const CHAT_TOPIC_SET: u16 = 65;

/// Most open or resolved topics a chat log keeps (#312). A command that would
/// add one more is refused; replay ignores a new topic past it.
pub const MAX_TOPICS: usize = 200;

/// Where a "Talk later" topic stands (#312): the payload's state byte.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatTopicState {
    /// Taken off the list ("Remove from list"): the topic is dropped.
    Cleared = 0,
    /// On the list, to talk about ("Talk later", "Reopen").
    Open = 1,
    /// Talked about ("Resolved"); still on the list.
    Resolved = 2,
}

impl ChatTopicState {
    pub const fn code(self) -> u8 {
        self as u8
    }

    pub const fn from_code(code: u8) -> Option<Self> {
        match code {
            0 => Some(Self::Cleared),
            1 => Some(Self::Open),
            2 => Some(Self::Resolved),
            _ => None,
        }
    }
}

/// One message on the "To talk about" list (#312), as replay leaves it.
/// A cleared topic has no record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatTopic {
    pub message_id: ChatMessageId,
    /// Open or resolved, never cleared.
    pub state: ChatTopicState,
    /// Who put it on the list (the first actor since it was last cleared).
    pub flagged_by: ActorId,
    /// Who last changed it.
    pub changed_by: ActorId,
    /// `ChatState::topic_clock` at its last change: a page lists the newest
    /// change first.
    pub changed: u64,
}

/// The chat domain of a replay.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ChatState {
    /// Messages in posting order.
    pub messages: Vec<ChatMessage>,
    pub positions: BTreeMap<ChatMessageId, usize>,
    /// Retirement candidates, in replay order: blobs replaced by an edit,
    /// dropped by the author's deletion, or brought by an event that applies
    /// nowhere (an edit after the author deleted, a second post of an
    /// existing ID). A page retires those no visible message shows
    /// (`retired_blobs`); hosts then delete them (#110).
    pub retired: Vec<[u8; 32]>,
    /// Every blob reference any chat event in this log has carried. A
    /// reference is content-addressed and its key random, so honest devices
    /// never repeat one, and commands refuse one this set holds.
    pub seen: BTreeSet<[u8; 32]>,
    /// Admin deletions of other members' messages, by message: who claimed
    /// them, in replay order. Whether a claim counts depends on whether its
    /// author is an admin, which only the service knows, so the host names
    /// the household's admins when it reads a page.
    pub admin_claims: BTreeMap<ChatMessageId, Vec<ActorId>>,
    /// Reactions by message, groups in the order replay first saw each emoji.
    /// A message with none has no entry. A page leaves out those of messages
    /// it shows as deleted or removed.
    pub reactions: BTreeMap<ChatMessageId, Vec<ReactionGroup>>,
    /// Pins in the order replay applied them (#131). A message its author
    /// deleted is dropped from here; one an admin removed stays but is not
    /// shown (`shown_pins`).
    pub pins: Vec<ChatPin>,
    /// Votes by poll (#135); a poll with no votes and still open has no
    /// entry. Deleting the poll for everyone drops its entry.
    pub polls: BTreeMap<ChatMessageId, PollState>,
    /// "Talk later" topics (#312) in the order replay first listed them, at
    /// most `MAX_TOPICS`. Clearing a topic, or its author deleting the
    /// message, drops it; one an admin removed stays but is not shown
    /// (`shown_topics`).
    pub topics: Vec<ChatTopic>,
    /// Counts topic changes in replay order, for `ChatTopic::changed`.
    pub topic_clock: u64,
}

impl ChatState {
    /// The poll `message_id` names, if it is a poll message that still shows
    /// to a reader (live, not deleted), with its options and votes.
    pub fn poll_of(&self, message_id: &ChatMessageId) -> Option<(PollSpec, bool)> {
        let message = self.get(message_id)?;
        match (message.content_kind, message.status) {
            (ChatContentKind::Poll(spec), ChatMessageStatus::Live) => Some((
                spec,
                self.polls.get(message_id).is_some_and(|poll| poll.closed),
            )),
            _ => None,
        }
    }

    pub fn is_pinned(&self, message_id: &ChatMessageId) -> bool {
        self.pins.iter().any(|pin| pin.message_id == *message_id)
    }

    /// The pins a page shows, given the household's admins: those whose
    /// message still shows, oldest pin first, at most `MAX_PINS`.
    pub fn shown_pins(&self, admins: &[ActorId]) -> Vec<&ChatPin> {
        self.pins
            .iter()
            .filter(|pin| {
                self.get(&pin.message_id).is_some_and(|message| {
                    matches!(
                        self.shown_status(message, admins),
                        ChatMessageStatus::Live | ChatMessageStatus::Edited
                    )
                })
            })
            .take(MAX_PINS)
            .collect()
    }

    /// The topic on `message_id`, if it is open or resolved (#312).
    pub fn topic(&self, message_id: &ChatMessageId) -> Option<&ChatTopic> {
        self.topics
            .iter()
            .find(|topic| topic.message_id == *message_id)
    }

    /// The topics a page shows, given the household's admins: those whose
    /// message still shows, newest change first.
    pub fn shown_topics(&self, admins: &[ActorId]) -> Vec<&ChatTopic> {
        let mut shown = self
            .topics
            .iter()
            .filter(|topic| {
                self.get(&topic.message_id).is_some_and(|message| {
                    matches!(
                        self.shown_status(message, admins),
                        ChatMessageStatus::Live | ChatMessageStatus::Edited
                    )
                })
            })
            .collect::<Vec<_>>();
        shown.sort_unstable_by_key(|topic| std::cmp::Reverse(topic.changed));
        shown
    }

    pub fn get(&self, message_id: &ChatMessageId) -> Option<&ChatMessage> {
        self.positions.get(message_id).map(|&at| &self.messages[at])
    }

    /// Whether one of `admins` deleted this message for everyone.
    pub fn removed_by_admin(&self, message_id: &ChatMessageId, admins: &[ActorId]) -> bool {
        self.admin_claims
            .get(message_id)
            .is_some_and(|claims| claims.iter().any(|actor| admins.contains(actor)))
    }

    /// The status a page shows, given the household's admins.
    pub fn shown_status(&self, message: &ChatMessage, admins: &[ActorId]) -> ChatMessageStatus {
        if message.status != ChatMessageStatus::Deleted
            && self.removed_by_admin(&message.message_id, admins)
        {
            ChatMessageStatus::RemovedByAdmin
        } else {
            message.status
        }
    }

    /// The blobs to delete, given the household's admins: the candidates,
    /// then the blobs of messages a named admin removed, each once and only
    /// if no live or edited message shows it. However a log came to hold a
    /// blob reference twice, a blob a page shows is never retired.
    pub fn retired_blobs(&self, admins: &[ActorId]) -> Vec<[u8; 32]> {
        let mut shown: HashSet<[u8; 32], BuildHasherDefault<RefHasher>> =
            HashSet::with_capacity_and_hasher(self.messages.len(), BuildHasherDefault::new());
        let mut removed = Vec::new();
        for message in &self.messages {
            match self.shown_status(message, admins) {
                ChatMessageStatus::Live | ChatMessageStatus::Edited => {
                    shown.insert(message.blob_ref);
                }
                ChatMessageStatus::RemovedByAdmin => removed.push(message.blob_ref),
                ChatMessageStatus::Deleted => {}
            }
        }
        let mut listed = BTreeSet::new();
        self.retired
            .iter()
            .chain(&removed)
            .filter(|blob| **blob != [0; 32] && !shown.contains(*blob) && listed.insert(**blob))
            .copied()
            .collect()
    }
}

/// Checks a message's decrypted text: valid UTF-8, 1 to 4,000 Unicode scalar
/// values, not only whitespace, and no control characters other than tab
/// and line feed. Text is plain text and is never rendered as markup.
pub fn check_text(bytes: &[u8]) -> Result<&str, KinError> {
    if bytes.is_empty() || bytes.len() > MAX_CHAT_TEXT_BYTES {
        return Err(KinError::InvalidEvent);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| KinError::InvalidEvent)?;
    let mut chars = 0usize;
    for character in text.chars() {
        chars += 1;
        let control = character.is_control() && character != '\n' && character != '\t';
        if control || chars > MAX_CHAT_TEXT_CHARS {
            return Err(KinError::InvalidEvent);
        }
    }
    if text.trim().is_empty() {
        return Err(KinError::InvalidEvent);
    }
    Ok(text)
}

/// Whether `text` is one emoji grapheme of at most 32 bytes (#127): a
/// pictograph with an optional variation selector and skin tone, a flag
/// (two regional indicators, or a tag sequence), or a keycap, and several of
/// those joined by zero-width joiners. Anything else, including plain text
/// and more than one emoji, is refused.
pub fn check_emoji(text: &str) -> Result<(), KinError> {
    if text.is_empty() || text.len() > MAX_EMOJI_BYTES {
        return Err(KinError::InvalidEvent);
    }
    let scalars: Vec<u32> = text.chars().map(|character| character as u32).collect();
    let mut at = 0;
    let mut joined = false;
    loop {
        let (end, pictograph) = emoji_element(&scalars, at).ok_or(KinError::InvalidEvent)?;
        // A joiner sits between pictographs only (never beside a flag or
        // keycap), as Unicode's grapheme rules join them.
        if joined && !pictograph {
            return Err(KinError::InvalidEvent);
        }
        at = end;
        if at == scalars.len() {
            return Ok(());
        }
        // Only a joiner continues the grapheme, and it needs an element after.
        if scalars[at] != 0x200D || !pictograph {
            return Err(KinError::InvalidEvent);
        }
        joined = true;
        at += 1;
    }
}

const fn is_regional_indicator(scalar: u32) -> bool {
    matches!(scalar, 0x1F1E6..=0x1F1FF)
}

const fn is_pictograph(scalar: u32) -> bool {
    matches!(
        scalar,
        0xA9 | 0xAE
            | 0x203C
            | 0x2049
            | 0x2122
            | 0x2139
            | 0x2194..=0x21AA
            | 0x231A..=0x231B
            | 0x2328
            | 0x23CF
            | 0x23E9..=0x23F3
            | 0x23F8..=0x23FA
            | 0x24C2
            | 0x25AA..=0x25AB
            | 0x25B6
            | 0x25C0
            | 0x25FB..=0x25FE
            | 0x2600..=0x27BF
            | 0x2934..=0x2935
            | 0x2B05..=0x2B07
            | 0x2B1B..=0x2B1C
            | 0x2B50
            | 0x2B55
            | 0x3030
            | 0x303D
            | 0x3297
            | 0x3299
            | 0x1F000..=0x1F0FF
            | 0x1F10D..=0x1F10F
            | 0x1F170..=0x1F1E5
            | 0x1F200..=0x1F251
            | 0x1F300..=0x1FAFF
    )
}

/// The end of the emoji element starting at `at`, if one does, and whether it
/// is a pictograph (the only kind a joiner may join).
fn emoji_element(scalars: &[u32], at: usize) -> Option<(usize, bool)> {
    let first = *scalars.get(at)?;
    let is_tag = |scalar: &u32| matches!(*scalar, 0xE0020..=0xE007E);
    if is_regional_indicator(first) {
        return scalars
            .get(at + 1)
            .is_some_and(|next| is_regional_indicator(*next))
            .then_some((at + 2, false));
    }
    if matches!(first, 0x23 | 0x2A | 0x30..=0x39) {
        let mut next = at + 1;
        if scalars.get(next) == Some(&0xFE0F) {
            next += 1;
        }
        return (scalars.get(next) == Some(&0x20E3)).then_some((next + 1, false));
    }
    if first == 0x1F3F4 && scalars.get(at + 1).is_some_and(is_tag) {
        let mut next = at + 1;
        while scalars.get(next).is_some_and(is_tag) {
            next += 1;
        }
        return (scalars.get(next) == Some(&0xE007F)).then_some((next + 1, false));
    }
    if !is_pictograph(first) {
        return None;
    }
    let mut next = at + 1;
    if scalars.get(next) == Some(&0xFE0F) {
        next += 1;
    }
    if scalars
        .get(next)
        .is_some_and(|modifier| matches!(*modifier, 0x1F3FB..=0x1F3FF))
    {
        next += 1;
    }
    Some((next, true))
}

/// Decrypted message texts by blob, held only while the engine is unlocked.
/// One contiguous byte arena and an `(offset, length)` span per blob; a text
/// is stored once and never rewritten.
#[derive(Default)]
pub struct ChatTexts {
    bytes: Vec<u8>,
    spans: HashMap<[u8; 32], (u32, u32), BuildHasherDefault<RefHasher>>,
}

/// Hashes a blob reference (already a random-looking digest) by folding its
/// bytes eight at a time: the arena is looked up once per message when
/// searching, so the lookup should cost a few cycles, not a tree walk.
#[derive(Default)]
pub struct RefHasher(u64);

impl Hasher for RefHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut word = [0u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.0 = (self.0.rotate_left(5) ^ u64::from_le_bytes(word))
                .wrapping_mul(0x517c_c1b7_2722_0a95);
        }
    }
}

/// Most text the arena holds (a little over 1,000 full-length messages);
/// beyond it the arena starts again, and the host re-supplies texts.
pub const MAX_CHAT_ARENA_BYTES: usize = 16 * 1024 * 1024;

impl ChatTexts {
    pub const fn new() -> Self {
        Self {
            bytes: Vec::new(),
            spans: HashMap::with_hasher(BuildHasherDefault::new()),
        }
    }

    /// Checks and stores a blob's text. Storing the same blob again is a
    /// no-op (content-addressed: the text can't differ). The caller makes
    /// room first (`make_room`); a text that doesn't fit is refused.
    pub fn put(&mut self, blob_ref: [u8; 32], text: &[u8]) -> Result<(), KinError> {
        if blob_ref == [0; 32] {
            return Err(KinError::MalformedProtocol);
        }
        check_text(text)?;
        if self.spans.contains_key(&blob_ref) {
            return Ok(());
        }
        if self.bytes.len() + text.len() > MAX_CHAT_ARENA_BYTES {
            return Err(KinError::SizeLimit);
        }
        let offset = u32::try_from(self.bytes.len()).map_err(|_| KinError::SizeLimit)?;
        self.grow(text.len())?;
        self.bytes.extend_from_slice(text);
        self.spans.insert(blob_ref, (offset, text.len() as u32));
        Ok(())
    }

    /// Starts the arena over if `incoming` more bytes would not fit, so a
    /// batch is stored whole: nothing it reports as held is dropped by a
    /// later text of the same batch.
    pub fn make_room(&mut self, incoming: usize) {
        if self.bytes.len() + incoming > MAX_CHAT_ARENA_BYTES {
            self.clear();
        }
    }

    /// Grows the buffer by hand: a reallocation by `Vec` would free the old
    /// buffer with decrypted text still in it, out of reach of `forget` and
    /// `clear`. The old buffer is zero-filled before it is released.
    fn grow(&mut self, additional: usize) -> Result<(), KinError> {
        let needed = self.bytes.len() + additional;
        if needed <= self.bytes.capacity() {
            return Ok(());
        }
        // `put` keeps `needed` within the arena's bound.
        let capacity = needed
            .max(self.bytes.capacity() * 2)
            .clamp(4096, MAX_CHAT_ARENA_BYTES);
        let mut bigger = Vec::new();
        bigger
            .try_reserve_exact(capacity)
            .map_err(|_| KinError::SizeLimit)?;
        bigger.extend_from_slice(&self.bytes);
        self.bytes.fill(0);
        self.bytes = bigger;
        Ok(())
    }

    pub fn get(&self, blob_ref: &[u8; 32]) -> Option<&[u8]> {
        self.spans
            .get(blob_ref)
            .map(|&(offset, length)| &self.bytes[offset as usize..(offset + length) as usize])
    }

    /// Forgets a blob's text (its message was edited or deleted) and
    /// zero-fills its bytes, so a deleted message's text doesn't linger in
    /// the arena until the next `clear`. The span itself is not reused.
    pub fn forget(&mut self, blob_ref: &[u8; 32]) {
        if let Some((offset, length)) = self.spans.remove(blob_ref) {
            self.bytes[offset as usize..(offset + length) as usize].fill(0);
        }
    }

    /// Drops every text, zero-filling the arena first.
    pub fn clear(&mut self) {
        self.bytes.fill(0);
        self.bytes = Vec::new();
        self.spans.clear();
    }

    pub fn len(&self) -> usize {
        self.spans.len()
    }

    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }
}

/// KCHQ v1, a page request: "KCHQ", version u16 (1), reserved u16 (0),
/// before u32 (page ends before this index; u32::MAX for the newest),
/// limit u16 (1..=500), flags u8 (bit 0: include texts the arena holds;
/// bit 1: include retired blobs; bit 2: include reactions; bit 3: include pins; bit 4: include polls;
/// bit 5: include topics), reserved u8
/// (0), admin count u32 (at most
/// 16), then 16 bytes per admin actor ID, then the record-less KINE context.
pub struct PageRequest<'a> {
    pub before: u32,
    pub limit: usize,
    pub include_text: bool,
    pub include_retired: bool,
    pub include_reactions: bool,
    pub include_pins: bool,
    pub include_polls: bool,
    pub include_topics: bool,
    pub admins: Vec<ActorId>,
    pub context: &'a [u8],
}

pub const PAGE_REQUEST_VERSION: u16 = 1;
pub const PAGE_VERSION: u16 = 1;
/// Bytes per message record in a KCHP page.
pub const PAGE_RECORD_BYTES: usize = 128;

pub fn decode_page_request(bytes: &[u8]) -> Result<PageRequest<'_>, KinError> {
    if bytes.len() < 20 || &bytes[..4] != b"KCHQ" {
        return Err(KinError::MalformedProtocol);
    }
    if u16::from_le_bytes([bytes[4], bytes[5]]) != PAGE_REQUEST_VERSION {
        return Err(KinError::UnsupportedVersion);
    }
    let flags = bytes[14];
    if bytes[6..8] != [0; 2] || bytes[15] != 0 || flags & !0b11_1111 != 0 {
        return Err(KinError::MalformedProtocol);
    }
    let before = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    let limit = u16::from_le_bytes([bytes[12], bytes[13]]) as usize;
    let admin_count = u32::from_le_bytes(bytes[16..20].try_into().unwrap()) as usize;
    if limit == 0 || limit > MAX_CHAT_PAGE || admin_count > MAX_CHAT_ADMINS {
        return Err(KinError::MalformedProtocol);
    }
    let context_at = 20 + admin_count * 16;
    if bytes.len() < context_at {
        return Err(KinError::MalformedProtocol);
    }
    let admins = bytes[20..context_at]
        .chunks_exact(16)
        .map(|chunk| ActorId(chunk.try_into().unwrap()))
        .collect::<Vec<_>>();
    if admins.iter().any(|admin| admin.0 == [0; 16]) {
        return Err(KinError::MalformedProtocol);
    }
    Ok(PageRequest {
        before,
        limit,
        include_text: flags & 1 != 0,
        include_retired: flags & 2 != 0,
        include_reactions: flags & 4 != 0,
        include_pins: flags & 8 != 0,
        include_polls: flags & 16 != 0,
        include_topics: flags & 32 != 0,
        admins,
        context: &bytes[context_at..],
    })
}

/// Bytes of the fixed part of a reply's quote entry in a page.
pub const PAGE_QUOTE_BYTES: usize = 108;

/// Whether a page record carries a quote: a reply that still shows.
fn quoted(message: &ChatMessage, shown: ChatMessageStatus) -> Option<ChatMessageId> {
    match shown {
        ChatMessageStatus::Live | ChatMessageStatus::Edited => message.reply_to,
        _ => None,
    }
}

/// The text a quote shows: the original's, if it is visible text the arena
/// holds and the request asked for texts.
fn quote_text<'a>(
    state: &ChatState,
    request: &PageRequest<'_>,
    texts: &'a ChatTexts,
    original: &ChatMessageId,
) -> Option<&'a [u8]> {
    let message = state.get(original)?;
    let visible = matches!(
        state.shown_status(message, &request.admins),
        ChatMessageStatus::Live | ChatMessageStatus::Edited
    );
    if request.include_text && visible && message.content_kind == ChatContentKind::Text {
        texts.get(&message.blob_ref).map(first_line)
    } else {
        None
    }
}

/// Most bytes of a quote's text a page carries.
pub const MAX_QUOTE_BYTES: usize = 256;

/// The first line with something in it, cut to `MAX_QUOTE_BYTES` at a
/// character boundary: all a quote shows, so a long original isn't copied
/// into every reply's page entry.
fn first_line(text: &[u8]) -> &[u8] {
    let Ok(text) = std::str::from_utf8(text) else {
        return &[];
    };
    let line = text
        .split('\n')
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let mut end = line.len().min(MAX_QUOTE_BYTES);
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    &line.as_bytes()[..end]
}

/// The mentions a page shows for a message: those of one that shows.
fn shown_mentions(message: &ChatMessage, shown: ChatMessageStatus) -> Option<&ChatMentions> {
    match shown {
        ChatMessageStatus::Live | ChatMessageStatus::Edited if !message.mentions.is_empty() => {
            Some(&message.mentions)
        }
        _ => None,
    }
}

fn shown_reactions<'a>(
    state: &'a ChatState,
    request: &PageRequest<'_>,
    shown: ChatMessageStatus,
    message: &ChatMessage,
) -> &'a [ReactionGroup] {
    if request.include_reactions
        && matches!(shown, ChatMessageStatus::Live | ChatMessageStatus::Edited)
    {
        state
            .reactions
            .get(&message.message_id)
            .map_or(&[][..], Vec::as_slice)
    } else {
        &[]
    }
}

/// KCHP v1, a page: "KCHP", version u16 (1), reserved u16 (0), then u32s:
/// total messages, index of the page's first message, records in the page,
/// text bytes, retired blobs. Then 128 bytes per message, oldest first:
///
/// ```text
/// 0   message ID (16)        16  author (16)          32  posting device (16)
/// 48  posted at i64          56  edited at i64 (0)    64  index u32
/// 68  status u8              69  content kind u8      70  reserved u16
/// 72  blob ref (32)          104 text offset u32      108 text length u32
/// 112 reaction groups u32  116 named mentions u16  118 reserved (10)
/// ```
///
/// Byte 70 is a flag: 1 when the message is a reply that still shows (a
/// quote follows the page, below), else 0. Byte 71 holds the mentions (#130)
/// of a message that shows: bit 0 mentions everyone, bit 1 names members (how
/// many is the u16 at 116, whose IDs follow the quotes); a deleted or removed
/// message has none.
///
/// The blob ref is zero for a deleted or removed message; a text length of
/// 0 means the arena doesn't hold that message's text (texts are never
/// empty). Then 32 bytes of blob key per message, in the same order (zero
/// for a deleted or removed message), then the text bytes, then 32 bytes
/// per retired blob. When the request asked for reactions, the page ends with
/// them: for each message in order that shows reactions, per group (the
/// record's count of them): emoji length u8, the emoji's UTF-8, member count
/// u32, then 16 bytes per member's actor ID. A deleted or removed message
/// shows none, and a page that didn't ask for them has a count of 0
/// everywhere. Last come the quotes (#129), one per record with byte 70 set,
/// in record order: the original's message ID (16), its state u8 (0 this log
/// doesn't hold it, 1 live, 2 edited, 3 deleted, 4 removed by a named admin),
/// its content kind u8 (0 if unknown), 2 reserved, its author (16), blob ref
/// (32) and blob key (32) (zero unless live or edited), its index u32
/// (`0xFFFFFFFF` if unknown), then text length u32 and the text (the arena's,
/// only for visible text and only if the request asked for texts: its first
/// non-blank line, at most 256 bytes). Last of all, the named mentions (#130):
/// for each record with a count at 116, in record order, that many 16-byte
/// member IDs in ascending order.
/// When the request asked for pins (#131), the page ends with them: a count
/// u32 (at most `MAX_PINS`), then per pin, oldest first, who pinned it (16)
/// and the message as a quote entry; only messages that still show are
/// pinned here.
/// Last, when it asked for polls (#135), each shown poll's votes in record
/// order: per voter, in ascending actor order, the actor ID (16), the chosen
/// options as a u16 bit set and 2 zero bytes. A poll record carries its option
/// count at 118, flags at 119 (1 multiple, 2 closed) and the voter count as a
/// u16 at 120.
/// Last of all, when it asked for topics (#312, flag bit 5), the "To talk
/// about" list: a count u32 (at most `MAX_TOPICS`), then per topic, newest
/// change first: the message ID (16), its state u8 (1 open, 2 resolved), 3
/// zero bytes, who flagged it (16), and the message as a quote entry, as a
/// pin's. Only topics whose message still shows are listed.
pub fn encode_page(
    state: &ChatState,
    request: &PageRequest<'_>,
    texts: &ChatTexts,
    retired_blobs: &[[u8; 32]],
) -> Result<Vec<u8>, KinError> {
    let total = state.messages.len();
    let end = (request.before as usize).min(total);
    let start = end.saturating_sub(request.limit);
    let page = &state.messages[start..end];
    let status = |message: &ChatMessage| state.shown_status(message, &request.admins);
    let retired = if request.include_retired {
        retired_blobs
    } else {
        &[]
    };
    // The reactions a page shows: those of visible messages, if asked for.
    let reaction_bytes = page
        .iter()
        .flat_map(|message| shown_reactions(state, request, status(message), message))
        .map(|group| 1 + group.emoji.len() + 4 + group.actors.len() * 16)
        .sum::<usize>();
    let reply_bytes = page
        .iter()
        .filter_map(|message| quoted(message, status(message)))
        .map(|original| {
            PAGE_QUOTE_BYTES + quote_text(state, request, texts, &original).map_or(0, <[u8]>::len)
        })
        .sum::<usize>();
    let mention_bytes = page
        .iter()
        .filter_map(|message| shown_mentions(message, status(message)))
        .map(|mentions| mentions.members.len() * 16)
        .sum::<usize>();
    // Pins (#131) are asked for: a count, then per shown pin who pinned it and
    // the message as a quote entry.
    let pins = if request.include_pins {
        state.shown_pins(&request.admins)
    } else {
        Vec::new()
    };
    let pin_bytes = if request.include_pins {
        4 + pins
            .iter()
            .map(|pin| {
                16 + PAGE_QUOTE_BYTES
                    + quote_text(state, request, texts, &pin.message_id).map_or(0, <[u8]>::len)
            })
            .sum::<usize>()
    } else {
        0
    };
    // Polls (#135) are asked for: each shown poll's open/closed state and
    // option count ride in its record; the votes follow the pins.
    let poll_votes = |message: &ChatMessage| -> Vec<(ActorId, u16)> {
        let visible = matches!(
            status(message),
            ChatMessageStatus::Live | ChatMessageStatus::Edited
        );
        match (request.include_polls && visible, message.content_kind) {
            (true, ChatContentKind::Poll(_)) => state
                .polls
                .get(&message.message_id)
                .map(|poll| {
                    poll.votes
                        .iter()
                        .map(|(who, choice)| (*who, *choice))
                        .collect()
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    };
    let poll_bytes = page
        .iter()
        .map(|message| poll_votes(message).len() * 20)
        .sum::<usize>();
    // Topics (#312) are asked for: a count, then per shown topic its message
    // ID, state, who flagged it and the message as a quote entry.
    let topics = if request.include_topics {
        state.shown_topics(&request.admins)
    } else {
        Vec::new()
    };
    let topic_bytes = if request.include_topics {
        4 + topics
            .iter()
            .map(|topic| {
                36 + PAGE_QUOTE_BYTES
                    + quote_text(state, request, texts, &topic.message_id).map_or(0, <[u8]>::len)
            })
            .sum::<usize>()
    } else {
        0
    };
    let mut text_bytes = 0usize;
    if request.include_text {
        for message in page {
            if (status(message) == ChatMessageStatus::Live
                || status(message) == ChatMessageStatus::Edited)
                && message.content_kind == ChatContentKind::Text
            {
                text_bytes += texts.get(&message.blob_ref).map_or(0, <[u8]>::len);
            }
        }
    }
    let size = 28usize
        .checked_add(page.len() * (PAGE_RECORD_BYTES + 32))
        .and_then(|size| size.checked_add(text_bytes))
        .and_then(|size| size.checked_add(retired.len() * 32))
        .and_then(|size| size.checked_add(reaction_bytes))
        .and_then(|size| size.checked_add(reply_bytes))
        .and_then(|size| size.checked_add(mention_bytes))
        .and_then(|size| size.checked_add(pin_bytes))
        .and_then(|size| size.checked_add(poll_bytes))
        .and_then(|size| size.checked_add(topic_bytes))
        .ok_or(KinError::SizeLimit)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size)
        .map_err(|_| KinError::SizeLimit)?;
    bytes.extend_from_slice(b"KCHP");
    bytes.extend_from_slice(&PAGE_VERSION.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    for value in [total, start, page.len(), text_bytes, retired.len()] {
        bytes.extend_from_slice(
            &u32::try_from(value)
                .map_err(|_| KinError::SizeLimit)?
                .to_le_bytes(),
        );
    }
    let mut text_offset = 0u32;
    let mut text_spans = Vec::with_capacity(page.len());
    for (index, message) in page.iter().enumerate() {
        let shown = status(message);
        let visible = matches!(shown, ChatMessageStatus::Live | ChatMessageStatus::Edited);
        let text =
            if request.include_text && visible && message.content_kind == ChatContentKind::Text {
                texts.get(&message.blob_ref)
            } else {
                None
            };
        bytes.extend_from_slice(&message.message_id.0);
        bytes.extend_from_slice(&message.author.0);
        bytes.extend_from_slice(&message.device.0);
        bytes.extend_from_slice(&message.posted_at.to_le_bytes());
        bytes.extend_from_slice(&message.edited_at.to_le_bytes());
        bytes.extend_from_slice(&((start + index) as u32).to_le_bytes());
        bytes.push(shown as u8);
        bytes.push(message.content_kind.code());
        let mentions = shown_mentions(message, shown);
        bytes.extend_from_slice(&[
            u8::from(quoted(message, shown).is_some()),
            mentions.map_or(0, |found| {
                u8::from(found.everyone) | u8::from(!found.members.is_empty()) << 1
            }),
        ]);
        bytes.extend_from_slice(if visible { &message.blob_ref } else { &[0; 32] });
        match text {
            Some(text) => {
                bytes.extend_from_slice(&text_offset.to_le_bytes());
                bytes.extend_from_slice(&(text.len() as u32).to_le_bytes());
                text_offset += text.len() as u32;
                text_spans.push(text);
            }
            None => bytes.extend_from_slice(&[0; 8]),
        }
        bytes.extend_from_slice(
            &(shown_reactions(state, request, status(message), message).len() as u32).to_le_bytes(),
        );
        bytes.extend_from_slice(
            &(mentions.map_or(0, |found| found.members.len()) as u16).to_le_bytes(),
        );
        // A poll's option count, flags (1 multiple choice, 2 closed) and
        // voter count (#135); zero for everything else.
        let poll = match (request.include_polls && visible, message.content_kind) {
            (true, ChatContentKind::Poll(spec)) => Some((
                spec,
                state
                    .polls
                    .get(&message.message_id)
                    .is_some_and(|poll| poll.closed),
            )),
            _ => None,
        };
        match poll {
            Some((spec, closed)) => {
                bytes.push(spec.options);
                bytes.push(u8::from(spec.multiple) | u8::from(closed) << 1);
                bytes.extend_from_slice(&(poll_votes(message).len() as u16).to_le_bytes());
                bytes.extend_from_slice(&[0; 6]);
            }
            None => bytes.extend_from_slice(&[0; 10]),
        }
    }
    for message in page {
        let visible = matches!(
            status(message),
            ChatMessageStatus::Live | ChatMessageStatus::Edited
        );
        bytes.extend_from_slice(if visible { &message.blob_key } else { &[0; 32] });
    }
    for text in text_spans {
        bytes.extend_from_slice(text);
    }
    for blob in retired {
        bytes.extend_from_slice(blob);
    }
    for message in page {
        for group in shown_reactions(state, request, status(message), message) {
            bytes.push(group.emoji.len() as u8);
            bytes.extend_from_slice(group.emoji.as_bytes());
            bytes.extend_from_slice(&(group.actors.len() as u32).to_le_bytes());
            for actor in &group.actors {
                bytes.extend_from_slice(&actor.0);
            }
        }
    }
    for message in page {
        let Some(original) = quoted(message, status(message)) else {
            continue;
        };
        write_quote(&mut bytes, state, request, texts, &original);
    }
    for message in page {
        if let Some(mentions) = shown_mentions(message, status(message)) {
            for member in &mentions.members {
                bytes.extend_from_slice(&member.0);
            }
        }
    }
    if request.include_pins {
        bytes.extend_from_slice(&(pins.len() as u32).to_le_bytes());
        for pin in &pins {
            bytes.extend_from_slice(&pin.by.0);
            write_quote(&mut bytes, state, request, texts, &pin.message_id);
        }
    }
    for message in page {
        for (voter, choice) in poll_votes(message) {
            bytes.extend_from_slice(&voter.0);
            bytes.extend_from_slice(&choice.to_le_bytes());
            bytes.extend_from_slice(&[0, 0]);
        }
    }
    if request.include_topics {
        bytes.extend_from_slice(&(topics.len() as u32).to_le_bytes());
        for topic in &topics {
            bytes.extend_from_slice(&topic.message_id.0);
            bytes.extend_from_slice(&[topic.state.code(), 0, 0, 0]);
            bytes.extend_from_slice(&topic.flagged_by.0);
            write_quote(&mut bytes, state, request, texts, &topic.message_id);
        }
    }
    debug_assert_eq!(bytes.len(), size);
    Ok(bytes)
}

/// One quote entry (#129), also used by pins (#131) and topics (#312): see
/// `encode_page`.
fn write_quote(
    bytes: &mut Vec<u8>,
    state: &ChatState,
    request: &PageRequest<'_>,
    texts: &ChatTexts,
    original: &ChatMessageId,
) {
    bytes.extend_from_slice(&original.0);
    match state.get(original) {
        Some(found) => {
            let shown = state.shown_status(found, &request.admins);
            let visible = matches!(shown, ChatMessageStatus::Live | ChatMessageStatus::Edited);
            let code = match shown {
                ChatMessageStatus::Live => 1u8,
                ChatMessageStatus::Edited => 2,
                ChatMessageStatus::Deleted => 3,
                ChatMessageStatus::RemovedByAdmin => 4,
            };
            bytes.extend_from_slice(&[code, found.content_kind.code(), 0, 0]);
            bytes.extend_from_slice(&found.author.0);
            bytes.extend_from_slice(if visible { &found.blob_ref } else { &[0; 32] });
            bytes.extend_from_slice(if visible { &found.blob_key } else { &[0; 32] });
            bytes.extend_from_slice(&(state.positions[original] as u32).to_le_bytes());
        }
        None => {
            bytes.extend_from_slice(&[0; 4]);
            bytes.extend_from_slice(&[0; 16 + 32 + 32]);
            bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        }
    }
    let text = quote_text(state, request, texts, original).unwrap_or(&[]);
    bytes.extend_from_slice(&(text.len() as u32).to_le_bytes());
    bytes.extend_from_slice(text);
}

/// KCHT v1, texts for the arena (`kin_chat_text`): "KCHT", version u16 (1),
/// reserved u16 (0), count u32 (1..=500), then per text: blob ref (32),
/// length u32, the UTF-8 text. The result, KCHS v1: "KCHS", version u16 (1),
/// reserved u16 (0), count u32, then one status byte per text in request
/// order: 0 stored (or already held), 1 rejected by `check_text`. A text is
/// checked alone, so one bad blob never keeps the rest of a page out.
pub fn put_texts(bytes: &[u8], texts: &mut ChatTexts) -> Result<Vec<u8>, KinError> {
    if bytes.len() < 12 || &bytes[..4] != b"KCHT" {
        return Err(KinError::MalformedProtocol);
    }
    if u16::from_le_bytes([bytes[4], bytes[5]]) != 1 {
        return Err(KinError::UnsupportedVersion);
    }
    let count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if bytes[6..8] != [0; 2] || count == 0 || count > MAX_CHAT_PAGE {
        return Err(KinError::MalformedProtocol);
    }
    // Frame every entry before storing any, so a malformed request changes
    // nothing.
    let mut entries = Vec::with_capacity(count);
    let mut offset = 12usize;
    for _ in 0..count {
        let header = bytes
            .get(offset..offset + 36)
            .ok_or(KinError::MalformedProtocol)?;
        let blob_ref: [u8; 32] = header[..32].try_into().unwrap();
        let length = u32::from_le_bytes(header[32..36].try_into().unwrap()) as usize;
        let start = offset + 36;
        let end = start
            .checked_add(length)
            .ok_or(KinError::MalformedProtocol)?;
        if blob_ref == [0; 32] || length > MAX_CHAT_TEXT_BYTES || end > bytes.len() {
            return Err(KinError::MalformedProtocol);
        }
        entries.push((blob_ref, start..end));
        offset = end;
    }
    if offset != bytes.len() {
        return Err(KinError::MalformedProtocol);
    }
    // Room for every text that passes and isn't held yet, made once, before
    // storing any.
    let incoming = entries
        .iter()
        .filter(|(blob_ref, range)| {
            texts.get(blob_ref).is_none() && check_text(&bytes[range.clone()]).is_ok()
        })
        .map(|(_, range)| range.len())
        .sum();
    texts.make_room(incoming);
    let mut output = Vec::with_capacity(12 + count);
    output.extend_from_slice(b"KCHS\x01\0\0\0");
    output.extend_from_slice(&(count as u32).to_le_bytes());
    for (blob_ref, range) in entries {
        output.push(match texts.put(blob_ref, &bytes[range]) {
            Ok(()) => 0,
            Err(KinError::InvalidEvent) => 1,
            Err(error) => return Err(error),
        });
    }
    Ok(output)
}
