//! The sitter page (#442, ADR 0017).
//!
//! **The page (kind 70, `SitterPageSet`).** An optional short intro and an
//! ordered list of at most `MAX_SITTER_ENTRIES` entries, each naming an
//! existing record by kind and ID: a note, a reference record or a routine.
//! Nothing is copied: the host shows each entry's current content from the
//! main projection, so editing a note updates the page. Each event replaces
//! the previous page; the latest in replay order wins.
//!
//! The payload is strict, like store sections: it decodes only if it
//! re-encodes to the same bytes, so the structure is checked there (code 2):
//! at most 30 entries, kind codes 1–3, non-zero IDs, no entry twice, the intro
//! already trimmed, at most 500 bytes, no control characters but newline.
//! Replay never fails on a decoded event. Commands enforce the rest (code 4):
//! every entry names a record of its kind that exists and isn't archived, and
//! the page must change.
//!
//! Replay is tolerant: an entry whose record is archived or unknown (never
//! seen, or not yet seen on this device) is kept in the event but skipped in
//! the resolved page, so it shows again if a record with that ID appears.
//!
//! **Who may change it.** Adults only (owner decision): not Limited or
//! Temporary members. Rust does not know a member's kind; the service and the
//! host do (`memberKind` in the sync status). The host refuses the command
//! for a non-Adult before it reaches Rust (`kin-sitter.js`,
//! `canChangeSitterPage`), as it does for removing attachments. Replay accepts
//! a page from any member: a kind-70 event from another device is history,
//! and the service has already admitted its author to the household.
//!
//! Hosts read the page through `kin_sitter_page` (KSIT), below; it is not part
//! of the KINS projection.
use std::sync::Arc;

use crate::error::KinError;
use crate::event::{EventEnvelope, EventKind};
use crate::meals::{push_text, read_text};
use crate::state::{NoteState, NoteStatus, ReferenceRecordState, RoutineState};
use crate::wire::{read_id, read_u16};

pub const SITTER_PAGE_SET: u16 = 70;

/// At most this many entries on the page.
pub const MAX_SITTER_ENTRIES: usize = 30;
/// The intro's UTF-8 length, after trimming.
pub const MAX_SITTER_INTRO_BYTES: usize = 500;
/// One entry in the payload and in KSIT: kind u8, three reserved, ID [16].
pub const SITTER_ENTRY_BYTES: usize = 20;

pub const fn is_sitter_code(code: u16) -> bool {
    code == SITTER_PAGE_SET
}

/// What an entry points at. The codes are the payload's kind byte.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
#[repr(u8)]
pub enum SitterEntryKind {
    Note = 1,
    ReferenceRecord = 2,
    Routine = 3,
}

impl SitterEntryKind {
    pub const fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::Note),
            2 => Some(Self::ReferenceRecord),
            3 => Some(Self::Routine),
            _ => None,
        }
    }
}

/// One entry: the kind of record and its ID.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SitterEntry {
    pub kind: SitterEntryKind,
    pub id: [u8; 16],
}

/// An intro in canonical form: trimmed (Unicode white space, as `str::trim`),
/// 0–500 UTF-8 bytes, no control characters other than newline.
pub fn normalize_sitter_intro(intro: &str) -> Result<String, KinError> {
    let intro = intro.trim();
    if intro.len() > MAX_SITTER_INTRO_BYTES
        || intro
            .chars()
            .any(|character| character != '\n' && character.is_control())
    {
        return Err(KinError::InvalidEvent);
    }
    Ok(intro.to_owned())
}

/// The page as last set. The empty page (no intro, no entries) is what a
/// household has before anyone sets one. Shared with finalized states.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SitterPageState {
    pub intro: String,
    pub entries: Vec<SitterEntry>,
}

/// The records an entry may point at, borrowed from the household state.
#[derive(Clone, Copy)]
pub struct SitterRecords<'a> {
    pub notes: &'a [NoteState],
    pub reference_records: &'a [ReferenceRecordState],
    pub routines: &'a [RoutineState],
}

impl SitterRecords<'_> {
    /// Whether `entry` names a record of its kind that exists and isn't
    /// archived.
    pub fn shows(&self, entry: &SitterEntry) -> bool {
        match entry.kind {
            SitterEntryKind::Note => self
                .notes
                .iter()
                .any(|note| note.note_id.0 == entry.id && note.status == NoteStatus::Active),
            SitterEntryKind::ReferenceRecord => self
                .reference_records
                .iter()
                .any(|record| record.record_id.0 == entry.id && !record.archived),
            SitterEntryKind::Routine => self
                .routines
                .iter()
                .any(|routine| routine.routine_id.0 == entry.id && !routine.archived),
        }
    }
}

impl SitterPageState {
    fn apply(&mut self, event: &EventEnvelope) {
        if let EventKind::SitterPageSet { intro, entries } = &event.kind {
            self.intro.clone_from(intro);
            self.entries.clone_from(entries);
        }
    }

    /// The entries that show, in the page's order: those whose record exists
    /// and isn't archived.
    pub fn resolved<'a>(
        &'a self,
        records: SitterRecords<'a>,
    ) -> impl Iterator<Item = &'a SitterEntry> + 'a {
        self.entries
            .iter()
            .filter(move |entry| records.shows(entry))
    }

    /// Whether `kind`, authored now, is a change this page accepts. Who may
    /// author it is the host's check (module docs).
    pub fn check_command(&self, kind: &EventKind, records: SitterRecords) -> Result<(), KinError> {
        let EventKind::SitterPageSet { intro, entries } = kind else {
            return Err(KinError::InvalidEvent);
        };
        check_page(intro, entries)?;
        if !entries.iter().all(|entry| records.shows(entry)) {
            return Err(KinError::InvalidEvent);
        }
        if *intro == self.intro && *entries == self.entries {
            return Err(KinError::InvalidEvent);
        }
        Ok(())
    }
}

/// Replays one sitter-page event into the shared state (copy-on-write).
pub fn apply(page: &mut Arc<SitterPageState>, event: &EventEnvelope) -> Result<(), KinError> {
    if event.actor_id.0 == [0; 16] || event.device_id.0 == [0; 16] {
        return Err(KinError::InvalidEvent);
    }
    Arc::make_mut(page).apply(event);
    Ok(())
}

/// The page's structure: at most 30 entries, IDs non-zero, no entry twice,
/// the intro canonical. Code 2: the payload isn't canonical.
fn check_page(intro: &str, entries: &[SitterEntry]) -> Result<(), KinError> {
    if entries.len() > MAX_SITTER_ENTRIES
        || normalize_sitter_intro(intro).ok().as_deref() != Some(intro)
    {
        return Err(KinError::MalformedProtocol);
    }
    for (index, entry) in entries.iter().enumerate() {
        if entry.id == [0; 16] || entries[..index].contains(entry) {
            return Err(KinError::MalformedProtocol);
        }
    }
    Ok(())
}

fn push_entry(out: &mut Vec<u8>, entry: &SitterEntry) {
    out.extend_from_slice(&[entry.kind as u8, 0, 0, 0]);
    out.extend_from_slice(&entry.id);
}

/// The canonical kind-70 payload: entry count u16, reserved u16, each entry
/// (kind u8, three reserved, record ID [16]), then the intro (u16 length +
/// UTF-8; 0 for none).
pub fn encode_payload(kind: &EventKind) -> Result<Vec<u8>, KinError> {
    let EventKind::SitterPageSet { intro, entries } = kind else {
        return Err(KinError::Internal);
    };
    check_page(intro, entries)?;
    let mut out = Vec::with_capacity(4 + entries.len() * SITTER_ENTRY_BYTES + 2 + intro.len());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    for entry in entries {
        push_entry(&mut out, entry);
    }
    push_text(&mut out, intro);
    Ok(out)
}

/// Decodes a kind-70 payload strictly; the result re-encodes to the same
/// bytes.
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<EventKind, KinError> {
    if code != SITTER_PAGE_SET {
        return Err(KinError::MalformedProtocol);
    }
    let count = usize::from(read_u16(payload, 0)?);
    if count > MAX_SITTER_ENTRIES || read_u16(payload, 2)? != 0 {
        return Err(KinError::MalformedProtocol);
    }
    let mut entries = Vec::with_capacity(count);
    let mut at = 4;
    for _ in 0..count {
        let head = payload.get(at..at + 4).ok_or(KinError::MalformedProtocol)?;
        let kind = SitterEntryKind::from_code(head[0]).ok_or(KinError::MalformedProtocol)?;
        if head[1..] != [0; 3] {
            return Err(KinError::MalformedProtocol);
        }
        entries.push(SitterEntry {
            kind,
            id: read_id(payload, at + 4)?,
        });
        at += SITTER_ENTRY_BYTES;
    }
    let intro = read_text(payload, &mut at)?;
    if at != payload.len() {
        return Err(KinError::MalformedProtocol);
    }
    let kind = EventKind::SitterPageSet { intro, entries };
    if encode_payload(&kind)? != payload {
        return Err(KinError::MalformedProtocol);
    }
    Ok(kind)
}

/// KSIT v1, the sitter page as the host shows it: "KSIT", version u16 = 1,
/// reserved u16, entry count u32, then each entry that shows, in the page's
/// order (kind u8, three reserved, record ID [16]), then the intro (u16
/// length + UTF-8). The host takes titles, fields and text from the main
/// projection by ID.
pub fn encode_page(page: &SitterPageState, records: SitterRecords) -> Vec<u8> {
    let mut out =
        Vec::with_capacity(12 + page.entries.len() * SITTER_ENTRY_BYTES + 2 + page.intro.len());
    out.extend_from_slice(b"KSIT");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&[0; 4]);
    let mut count = 0u32;
    for entry in page.resolved(records) {
        push_entry(&mut out, entry);
        count += 1;
    }
    out[8..12].copy_from_slice(&count.to_le_bytes());
    push_text(&mut out, &page.intro);
    out
}
