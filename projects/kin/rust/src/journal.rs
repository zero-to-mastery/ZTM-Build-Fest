//! A member's journal (#496, #497, #501; ADR 0019): dated entries in the
//! member's private log, which only their own devices can read.
//!
//! **Kinds 101–109** are the journal's share of the private range (100–199).
//! Four are defined; 105–109 are reserved for it and fail with code 3 until a
//! later release defines them.
//!
//! | Kind | Name | Payload |
//! |---|---|---|
//! | 101 | `JOURNAL_ENTRY_CREATED` | entry ID [16], then the entry's content |
//! | 102 | `JOURNAL_ENTRY_EDITED` | entry ID [16], then the whole new content |
//! | 103 | `JOURNAL_ENTRY_DELETED` | entry ID [16] |
//! | 104 | `JOURNAL_ENTRY_RESTORED` | entry ID [16] (Undo of a delete) |
//!
//! **Content** (after the entry ID): civil date u32 (YYYYMMDD), title length
//! u16, photo count u8, reserved u8 (0), body length u32, the title, the body,
//! then each photo (136 bytes): type u8 (1 JPEG, 2 PNG, 3 WebP), reserved
//! [3] (0), sealed size u32, the photo's blob reference [32] and key [32],
//! its thumbnail's blob reference [32] and key [32]. A photo's blobs are
//! sealed on the device under their own random keys, which travel only here,
//! inside a record sealed under the member key; the private blob store holds
//! the ciphertext (SYNC.md "Private blobs").
//!
//! The payload is strict: it decodes only in its one canonical form (code
//! 2). The title is at most 200 bytes with no control characters and no
//! leading or trailing white space; the body is at most 20,000 bytes with no
//! control characters but line feeds and no leading or trailing white space;
//! at most 10 photos, each with a known type, a sealed size from 29 bytes to
//! 4 MiB + 4 KiB (the household attachment bound), non-zero references and
//! keys, and no reference twice in one entry; and an entry has a title, a
//! body or a photo. Nothing here is a score: no word counts, streaks or moods
//! (PRODUCT-BOUNDARIES).
//!
//! **Replay** never fails on a decoded journal event (beyond the private
//! log's one-author rule, private.rs). A creation for an ID already seen is
//! ignored (the first wins); an edit replaces the content of an entry it
//! knows, deleted or not; a delete hides a live entry and a restore shows a
//! deleted one again; events for an unknown entry are ignored. The latest in
//! replay order wins. A deleted entry's content stays in the log, as every
//! event does; KPRV leaves it out.
//!
//! **Commands** (`kin_private_execute`, private_command.rs) enforce the rest with
//! code 4: a new entry's ID is unused; an edit names a live entry and changes
//! something; a delete names a live entry; a restore names a deleted one.
//! Live entries are bounded (10,000 and 32 MiB of title and body text, code
//! 5) so the KPRV projection stays far inside the protocol limit.
use std::collections::BTreeMap;

use crate::error::KinError;
use crate::event::{DeviceId, EventEnvelope, PrivateRecordId};
use crate::recurrence::CivilDate;
use crate::wire::{read_id, read_u16, read_u32};

pub const JOURNAL_ENTRY_CREATED: u16 = 101;
pub const JOURNAL_ENTRY_EDITED: u16 = 102;
pub const JOURNAL_ENTRY_DELETED: u16 = 103;
pub const JOURNAL_ENTRY_RESTORED: u16 = 104;
/// The journal's reserved kinds.
pub const FIRST_JOURNAL_KIND: u16 = 101;
pub const LAST_JOURNAL_KIND: u16 = 109;
pub const MAX_JOURNAL_TITLE_BYTES: usize = 200;
pub const MAX_JOURNAL_BODY_BYTES: usize = 20_000;
pub const MAX_JOURNAL_PHOTOS: usize = 10;
/// Most entries that aren't deleted.
pub const MAX_JOURNAL_ENTRIES: usize = 10_000;
/// Most title and body bytes across entries that aren't deleted.
pub const MAX_JOURNAL_TEXT_BYTES: usize = 32 * 1024 * 1024;
/// A sealed photo blob's bounds: a format-1 blob's overhead (version, nonce,
/// tag) and the household attachment limit.
pub const MIN_JOURNAL_PHOTO_BYTES: u32 = 29;
pub const MAX_JOURNAL_PHOTO_BYTES: u32 = 4 * 1024 * 1024 + 4096;
/// Bytes before the title in a content payload (entry ID included).
const CONTENT_HEADER_BYTES: usize = 28;
/// Bytes per photo, in a payload and in KPRV.
pub const JOURNAL_PHOTO_BYTES: usize = 136;
/// Bytes before the title in a KPRV journal entry.
pub const KPRV_ENTRY_HEADER_BYTES: usize = 60;

/// Whether a kind code belongs to the journal (101–109), known or not.
pub const fn is_journal_code(code: u16) -> bool {
    code >= FIRST_JOURNAL_KIND && code <= LAST_JOURNAL_KIND
}

/// One photo on an entry: its sealed blob and thumbnail, by reference, with
/// the keys that open them.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JournalPhoto {
    /// 1 JPEG, 2 PNG, 3 WebP.
    pub kind: u8,
    /// The sealed photo blob's size in bytes.
    pub size: u32,
    pub blob: [u8; 32],
    pub key: [u8; 32],
    pub thumbnail: [u8; 32],
    pub thumbnail_key: [u8; 32],
}

/// What an entry says: its date, optional title, plain-text body and photos.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JournalContent {
    pub date: CivilDate,
    pub title: String,
    pub body: String,
    pub photos: Vec<JournalPhoto>,
}

impl JournalContent {
    fn text_bytes(&self) -> usize {
        self.title.len() + self.body.len()
    }
}

/// A journal event (kinds 101–104).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JournalEvent {
    Created {
        entry_id: PrivateRecordId,
        content: JournalContent,
    },
    Edited {
        entry_id: PrivateRecordId,
        content: JournalContent,
    },
    Deleted {
        entry_id: PrivateRecordId,
    },
    Restored {
        entry_id: PrivateRecordId,
    },
}

impl JournalEvent {
    pub const fn code(&self) -> u16 {
        match self {
            Self::Created { .. } => JOURNAL_ENTRY_CREATED,
            Self::Edited { .. } => JOURNAL_ENTRY_EDITED,
            Self::Deleted { .. } => JOURNAL_ENTRY_DELETED,
            Self::Restored { .. } => JOURNAL_ENTRY_RESTORED,
        }
    }

    pub const fn entry_id(&self) -> PrivateRecordId {
        match self {
            Self::Created { entry_id, .. }
            | Self::Edited { entry_id, .. }
            | Self::Deleted { entry_id }
            | Self::Restored { entry_id } => *entry_id,
        }
    }
}

/// White space at either end (the host trims before it saves).
fn untrimmed(text: &str) -> bool {
    text.starts_with(char::is_whitespace) || text.ends_with(char::is_whitespace)
}

fn valid_title(title: &str) -> bool {
    title.len() <= MAX_JOURNAL_TITLE_BYTES
        && !untrimmed(title)
        && !title.chars().any(char::is_control)
}

fn valid_body(body: &str) -> bool {
    body.len() <= MAX_JOURNAL_BODY_BYTES
        && !untrimmed(body)
        && !body
            .chars()
            .any(|character| character.is_control() && character != '\n')
}

fn valid_photo(photo: &JournalPhoto) -> bool {
    (1..=3).contains(&photo.kind)
        && (MIN_JOURNAL_PHOTO_BYTES..=MAX_JOURNAL_PHOTO_BYTES).contains(&photo.size)
        && [photo.blob, photo.key, photo.thumbnail, photo.thumbnail_key]
            .iter()
            .all(|bytes| bytes != &[0; 32])
}

fn valid_content(content: &JournalContent) -> bool {
    if !valid_title(&content.title)
        || !valid_body(&content.body)
        || content.photos.len() > MAX_JOURNAL_PHOTOS
        || !content.photos.iter().all(valid_photo)
        || (content.title.is_empty() && content.body.is_empty() && content.photos.is_empty())
    {
        return false;
    }
    // No blob named twice in one entry.
    let mut refs: Vec<&[u8; 32]> = content
        .photos
        .iter()
        .flat_map(|photo| [&photo.blob, &photo.thumbnail])
        .collect();
    let count = refs.len();
    refs.sort_unstable();
    refs.dedup();
    refs.len() == count
}

fn push_photo(out: &mut Vec<u8>, photo: &JournalPhoto) {
    out.push(photo.kind);
    out.extend_from_slice(&[0; 3]);
    out.extend_from_slice(&photo.size.to_le_bytes());
    out.extend_from_slice(&photo.blob);
    out.extend_from_slice(&photo.key);
    out.extend_from_slice(&photo.thumbnail);
    out.extend_from_slice(&photo.thumbnail_key);
}

fn read_photo(bytes: &[u8]) -> Result<JournalPhoto, KinError> {
    if bytes.len() != JOURNAL_PHOTO_BYTES || bytes[1..4] != [0; 3] {
        return Err(KinError::MalformedProtocol);
    }
    let array = |at: usize| -> [u8; 32] { bytes[at..at + 32].try_into().unwrap_or([0; 32]) };
    Ok(JournalPhoto {
        kind: bytes[0],
        size: read_u32(bytes, 4)?,
        blob: array(8),
        key: array(40),
        thumbnail: array(72),
        thumbnail_key: array(104),
    })
}

fn encode_content(entry_id: PrivateRecordId, content: &JournalContent) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        CONTENT_HEADER_BYTES
            + content.title.len()
            + content.body.len()
            + JOURNAL_PHOTO_BYTES * content.photos.len(),
    );
    out.extend_from_slice(&entry_id.0);
    out.extend_from_slice(&content.date.encoded().to_le_bytes());
    out.extend_from_slice(&(content.title.len() as u16).to_le_bytes());
    out.push(content.photos.len() as u8);
    out.push(0);
    out.extend_from_slice(&(content.body.len() as u32).to_le_bytes());
    out.extend_from_slice(content.title.as_bytes());
    out.extend_from_slice(content.body.as_bytes());
    for photo in &content.photos {
        push_photo(&mut out, photo);
    }
    out
}

fn decode_content(payload: &[u8]) -> Result<(PrivateRecordId, JournalContent), KinError> {
    if payload.len() < CONTENT_HEADER_BYTES || payload[23] != 0 {
        return Err(KinError::MalformedProtocol);
    }
    let entry_id = PrivateRecordId(read_id(payload, 0)?);
    let date = CivilDate::from_encoded(read_u32(payload, 16)?)?;
    let title_length = usize::from(read_u16(payload, 20)?);
    let photo_count = usize::from(payload[22]);
    let body_length = read_u32(payload, 24)? as usize;
    if entry_id.0 == [0; 16]
        || title_length > MAX_JOURNAL_TITLE_BYTES
        || body_length > MAX_JOURNAL_BODY_BYTES
        || photo_count > MAX_JOURNAL_PHOTOS
        || payload.len()
            != CONTENT_HEADER_BYTES + title_length + body_length + JOURNAL_PHOTO_BYTES * photo_count
    {
        return Err(KinError::MalformedProtocol);
    }
    let text = |from: usize, length: usize| {
        std::str::from_utf8(&payload[from..from + length])
            .map(str::to_owned)
            .map_err(|_| KinError::MalformedProtocol)
    };
    let title = text(CONTENT_HEADER_BYTES, title_length)?;
    let body = text(CONTENT_HEADER_BYTES + title_length, body_length)?;
    let photos_at = CONTENT_HEADER_BYTES + title_length + body_length;
    let photos = payload[photos_at..]
        .chunks_exact(JOURNAL_PHOTO_BYTES)
        .map(read_photo)
        .collect::<Result<Vec<_>, _>>()?;
    let content = JournalContent {
        date,
        title,
        body,
        photos,
    };
    if !valid_content(&content) {
        return Err(KinError::MalformedProtocol);
    }
    Ok((entry_id, content))
}

/// The canonical payload of a journal event; a malformed one fails with
/// code 2 (it could never decode).
pub fn encode_payload(event: &JournalEvent) -> Result<Vec<u8>, KinError> {
    match event {
        JournalEvent::Created { entry_id, content }
        | JournalEvent::Edited { entry_id, content } => {
            if entry_id.0 == [0; 16] || !valid_content(content) {
                return Err(KinError::MalformedProtocol);
            }
            Ok(encode_content(*entry_id, content))
        }
        JournalEvent::Deleted { entry_id } | JournalEvent::Restored { entry_id } => {
            if entry_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            Ok(entry_id.0.to_vec())
        }
    }
}

/// Decodes a journal payload strictly. A journal code this engine doesn't
/// know (105–109) is unsupported: a later release added it.
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<JournalEvent, KinError> {
    match code {
        JOURNAL_ENTRY_CREATED | JOURNAL_ENTRY_EDITED => {
            let (entry_id, content) = decode_content(payload)?;
            Ok(if code == JOURNAL_ENTRY_CREATED {
                JournalEvent::Created { entry_id, content }
            } else {
                JournalEvent::Edited { entry_id, content }
            })
        }
        JOURNAL_ENTRY_DELETED | JOURNAL_ENTRY_RESTORED => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            let entry_id = PrivateRecordId(read_id(payload, 0)?);
            if entry_id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            Ok(if code == JOURNAL_ENTRY_DELETED {
                JournalEvent::Deleted { entry_id }
            } else {
                JournalEvent::Restored { entry_id }
            })
        }
        _ => Err(KinError::UnsupportedVersion),
    }
}

/// One entry as replayed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JournalEntry {
    pub content: JournalContent,
    /// Logical time of the event that created it.
    pub created: u64,
    /// Logical time and device of its latest change.
    pub updated: u64,
    pub device_id: DeviceId,
    pub deleted: bool,
}

/// The member's journal as replayed, with running totals for the live
/// (not deleted) entries.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct JournalState {
    entries: BTreeMap<PrivateRecordId, JournalEntry>,
    live: usize,
    live_text_bytes: usize,
}

impl JournalState {
    pub fn entry(&self, id: &PrivateRecordId) -> Option<&JournalEntry> {
        self.entries.get(id)
    }

    /// Entries that aren't deleted, newest first: by date descending, then
    /// by when they were created (later first), then by ID.
    pub fn live_entries(&self) -> Vec<(&PrivateRecordId, &JournalEntry)> {
        let mut live: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, entry)| !entry.deleted)
            .collect();
        live.sort_by(|(left_id, left), (right_id, right)| {
            right
                .content
                .date
                .cmp(&left.content.date)
                .then(right.created.cmp(&left.created))
                .then(left_id.cmp(right_id))
        });
        live
    }

    /// Whether no entry was ever written (deleted ones count).
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn live_count(&self) -> usize {
        self.live
    }

    pub fn live_text_bytes(&self) -> usize {
        self.live_text_bytes
    }

    fn count(&mut self, entry: &JournalEntry, sign: bool) {
        if entry.deleted {
            return;
        }
        let bytes = entry.content.text_bytes();
        if sign {
            self.live += 1;
            self.live_text_bytes += bytes;
        } else {
            self.live -= 1;
            self.live_text_bytes -= bytes;
        }
    }

    /// Replays one journal event (see the module doc). Never fails.
    pub fn apply(&mut self, envelope: &EventEnvelope, event: &JournalEvent) {
        let id = event.entry_id();
        let Some(mut entry) = self.entries.get(&id).cloned() else {
            if let JournalEvent::Created { content, .. } = event {
                let entry = JournalEntry {
                    content: content.clone(),
                    created: envelope.logical_time,
                    updated: envelope.logical_time,
                    device_id: envelope.device_id,
                    deleted: false,
                };
                self.count(&entry, true);
                self.entries.insert(id, entry);
            }
            return;
        };
        let before = entry.clone();
        match event {
            // The first creation wins.
            JournalEvent::Created { .. } => return,
            JournalEvent::Edited { content, .. } => entry.content = content.clone(),
            JournalEvent::Deleted { .. } if !entry.deleted => entry.deleted = true,
            JournalEvent::Restored { .. } if entry.deleted => entry.deleted = false,
            JournalEvent::Deleted { .. } | JournalEvent::Restored { .. } => return,
        }
        entry.updated = envelope.logical_time;
        entry.device_id = envelope.device_id;
        self.count(&before, false);
        self.count(&entry, true);
        self.entries.insert(id, entry);
    }

    /// Whether a new journal event may be written now (module doc,
    /// "Commands").
    pub fn check_command(&self, event: &JournalEvent) -> Result<(), KinError> {
        let entry = self.entries.get(&event.entry_id());
        let fits = |count: usize, bytes: usize| {
            if count > MAX_JOURNAL_ENTRIES || bytes > MAX_JOURNAL_TEXT_BYTES {
                Err(KinError::SizeLimit)
            } else {
                Ok(())
            }
        };
        match (event, entry) {
            (JournalEvent::Created { content, .. }, None) => {
                fits(self.live + 1, self.live_text_bytes + content.text_bytes())
            }
            (JournalEvent::Edited { content, .. }, Some(entry))
                if !entry.deleted && entry.content != *content =>
            {
                fits(
                    self.live,
                    self.live_text_bytes - entry.content.text_bytes() + content.text_bytes(),
                )
            }
            (JournalEvent::Deleted { .. }, Some(entry)) if !entry.deleted => Ok(()),
            (JournalEvent::Restored { .. }, Some(entry)) if entry.deleted => fits(
                self.live + 1,
                self.live_text_bytes + entry.content.text_bytes(),
            ),
            _ => Err(KinError::InvalidEvent),
        }
    }
}

/// The KPRV journal section's bytes: entry count u32, then each live entry
/// newest first (`live_entries`): ID [16], created logical time u64, updated
/// logical time u64, device ID [16] (of the latest change), date u32, title
/// length u16, photo count u8, reserved u8, body length u32, the title, the
/// body, then the photos as in the payload.
pub fn encode_section(state: &JournalState) -> Vec<u8> {
    let live = state.live_entries();
    let size = 4 + live
        .iter()
        .map(|(_, entry)| {
            KPRV_ENTRY_HEADER_BYTES
                + entry.content.text_bytes()
                + JOURNAL_PHOTO_BYTES * entry.content.photos.len()
        })
        .sum::<usize>();
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(&(live.len() as u32).to_le_bytes());
    for (id, entry) in live {
        let content = &entry.content;
        out.extend_from_slice(&id.0);
        out.extend_from_slice(&entry.created.to_le_bytes());
        out.extend_from_slice(&entry.updated.to_le_bytes());
        out.extend_from_slice(&entry.device_id.0);
        out.extend_from_slice(&content.date.encoded().to_le_bytes());
        out.extend_from_slice(&(content.title.len() as u16).to_le_bytes());
        out.push(content.photos.len() as u8);
        out.push(0);
        out.extend_from_slice(&(content.body.len() as u32).to_le_bytes());
        out.extend_from_slice(content.title.as_bytes());
        out.extend_from_slice(content.body.as_bytes());
        for photo in &content.photos {
            push_photo(&mut out, photo);
        }
    }
    out
}
