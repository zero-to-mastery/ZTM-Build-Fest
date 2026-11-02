//! "Just for me" (#510, #511, #514): a member's private to-dos and short
//! notes, kept in their private log (private.rs, ADR 0019) and never in the
//! household history.
//!
//! Kinds 110–119 belong to this list (the journal uses 101–109; reminders and
//! settings that follow a member use 120–139). Each is a schema 1 event whose
//! payload starts with the item's ID, except the list setting (118):
//!
//! | Kind | Name | Payload after the ID |
//! |---|---|---|
//! | 110 | `PRIVATE_ITEM_ADDED` | date u32 (0 none), text length u32, text |
//! | 111 | `PRIVATE_ITEM_EDITED` | text length u32, text |
//! | 112 | `PRIVATE_ITEM_COMPLETED` | — |
//! | 113 | `PRIVATE_ITEM_REOPENED` | — |
//! | 114 | `PRIVATE_ITEM_DATED` | date u32 (0 clears it) |
//! | 115 | `PRIVATE_ITEM_DELETED` | — |
//! | 116 | `PRIVATE_ITEM_RESTORED` | — (Undo of a delete) |
//! | 117 | `PRIVATE_ITEM_NOTE_SET` | note length u32, note (0 clears it) |
//! | 118 | `PRIVATE_ITEMS_ON_TODAY_SET` | no ID: on u8 (0 or 1), 3 zero bytes |
//!
//! Kind 119 is reserved. Text is 1–4,096 bytes of UTF-8 with no control
//! characters, like a household item's; a note is at most 2,048 bytes and may
//! hold line feeds. A date is a valid civil date (YYYYMMDD).
//!
//! Replay never fails on a decoded event (beyond the private log's own
//! one-author rule): an add for an ID the list already has, a change to an ID
//! it lacks, and an add or restore past `MAX_PRIVATE_ITEMS` live items change
//! nothing. Deleting keeps the item as a tombstone, so Undo can restore it.
//! Commands are stricter (`PrivateItems::check_command`): a new ID, a live
//! item, a change that changes something, trimmed text and room in the list.
use std::collections::BTreeMap;

use crate::error::KinError;
use crate::event::{EventEnvelope, PrivateRecordId};
use crate::recurrence::CivilDate;
use crate::wire::{read_id, read_u32, MAX_ITEM_TEXT_BYTES};

pub const FIRST_ITEM_KIND: u16 = 110;
pub const LAST_ITEM_KIND: u16 = 119;
pub const PRIVATE_ITEM_ADDED: u16 = 110;
pub const PRIVATE_ITEM_EDITED: u16 = 111;
pub const PRIVATE_ITEM_COMPLETED: u16 = 112;
pub const PRIVATE_ITEM_REOPENED: u16 = 113;
pub const PRIVATE_ITEM_DATED: u16 = 114;
pub const PRIVATE_ITEM_DELETED: u16 = 115;
pub const PRIVATE_ITEM_RESTORED: u16 = 116;
pub const PRIVATE_ITEM_NOTE_SET: u16 = 117;
pub const PRIVATE_ITEMS_ON_TODAY_SET: u16 = 118;
/// Most live (not deleted) items one member's list holds.
pub const MAX_PRIVATE_ITEMS: usize = 2_000;
/// Largest note on a private item, in UTF-8 bytes.
pub const MAX_PRIVATE_ITEM_NOTE_BYTES: usize = 2_048;
/// The KPRV section that carries the list (`encode_section`). The journal's
/// section has a lower code; 11 mirrors the kind range.
pub const SECTION_ITEMS: u16 = 11;
/// KPRV section 11 flag: dated items stay off Today and This week.
pub const FLAG_OFF_TODAY: u32 = 1;

/// Whether a code is one of this list's known kinds (119 is reserved and
/// decodes as unsupported, like any private kind this engine doesn't know).
pub const fn is_item_code(code: u16) -> bool {
    code >= FIRST_ITEM_KIND && code <= PRIVATE_ITEMS_ON_TODAY_SET
}

/// One "Just for me" event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PrivateItemEvent {
    Added {
        item_id: PrivateRecordId,
        text: String,
        date: Option<CivilDate>,
    },
    Edited {
        item_id: PrivateRecordId,
        text: String,
    },
    Completed {
        item_id: PrivateRecordId,
    },
    Reopened {
        item_id: PrivateRecordId,
    },
    Dated {
        item_id: PrivateRecordId,
        date: Option<CivilDate>,
    },
    Deleted {
        item_id: PrivateRecordId,
    },
    Restored {
        item_id: PrivateRecordId,
    },
    NoteSet {
        item_id: PrivateRecordId,
        note: String,
    },
    /// Whether dated private items show on the member's own Today and This
    /// week (#514). On until the member turns it off.
    OnTodaySet {
        on: bool,
    },
}

impl PrivateItemEvent {
    pub const fn code(&self) -> u16 {
        match self {
            Self::Added { .. } => PRIVATE_ITEM_ADDED,
            Self::Edited { .. } => PRIVATE_ITEM_EDITED,
            Self::Completed { .. } => PRIVATE_ITEM_COMPLETED,
            Self::Reopened { .. } => PRIVATE_ITEM_REOPENED,
            Self::Dated { .. } => PRIVATE_ITEM_DATED,
            Self::Deleted { .. } => PRIVATE_ITEM_DELETED,
            Self::Restored { .. } => PRIVATE_ITEM_RESTORED,
            Self::NoteSet { .. } => PRIVATE_ITEM_NOTE_SET,
            Self::OnTodaySet { .. } => PRIVATE_ITEMS_ON_TODAY_SET,
        }
    }

    /// The item the event is about (none for the list setting).
    pub const fn item_id(&self) -> Option<PrivateRecordId> {
        match self {
            Self::Added { item_id, .. }
            | Self::Edited { item_id, .. }
            | Self::Completed { item_id }
            | Self::Reopened { item_id }
            | Self::Dated { item_id, .. }
            | Self::Deleted { item_id }
            | Self::Restored { item_id }
            | Self::NoteSet { item_id, .. } => Some(*item_id),
            Self::OnTodaySet { .. } => None,
        }
    }

    /// The canonical payload (module doc). Refuses what `decode` would.
    pub fn encode(&self) -> Result<Vec<u8>, KinError> {
        let mut payload = Vec::new();
        if let Some(id) = self.item_id() {
            if id.0 == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            payload.extend_from_slice(&id.0);
        }
        match self {
            Self::Added { text, date, .. } => {
                check_text(text)?;
                payload.extend_from_slice(&date.map_or(0, CivilDate::encoded).to_le_bytes());
                push_text(&mut payload, text);
            }
            Self::Edited { text, .. } => {
                check_text(text)?;
                push_text(&mut payload, text);
            }
            Self::Dated { date, .. } => {
                payload.extend_from_slice(&date.map_or(0, CivilDate::encoded).to_le_bytes());
            }
            Self::NoteSet { note, .. } => {
                check_note(note)?;
                push_text(&mut payload, note);
            }
            Self::OnTodaySet { on } => payload.extend_from_slice(&[u8::from(*on), 0, 0, 0]),
            Self::Completed { .. }
            | Self::Reopened { .. }
            | Self::Deleted { .. }
            | Self::Restored { .. } => {}
        }
        Ok(payload)
    }

    /// Decodes a payload strictly: exact lengths, non-zero IDs, valid dates
    /// and text, zero reserved bytes.
    pub fn decode(code: u16, payload: &[u8]) -> Result<Self, KinError> {
        let malformed = KinError::MalformedProtocol;
        if code == PRIVATE_ITEMS_ON_TODAY_SET {
            return match payload {
                [on @ (0 | 1), 0, 0, 0] => Ok(Self::OnTodaySet { on: *on == 1 }),
                _ => Err(malformed),
            };
        }
        if !is_item_code(code) {
            return Err(KinError::UnsupportedVersion);
        }
        let item_id = PrivateRecordId(read_id(payload, 0)?);
        if item_id.0 == [0; 16] {
            return Err(malformed);
        }
        let rest = &payload[16..];
        let only_id = |event: Self| {
            if rest.is_empty() {
                Ok(event)
            } else {
                Err(KinError::MalformedProtocol)
            }
        };
        match code {
            PRIVATE_ITEM_ADDED => {
                let date = read_date(rest)?;
                let text = read_text(&rest[4..])?;
                check_text(&text)?;
                Ok(Self::Added {
                    item_id,
                    text,
                    date,
                })
            }
            PRIVATE_ITEM_EDITED => {
                let text = read_text(rest)?;
                check_text(&text)?;
                Ok(Self::Edited { item_id, text })
            }
            PRIVATE_ITEM_COMPLETED => only_id(Self::Completed { item_id }),
            PRIVATE_ITEM_REOPENED => only_id(Self::Reopened { item_id }),
            PRIVATE_ITEM_DATED => {
                if rest.len() != 4 {
                    return Err(malformed);
                }
                Ok(Self::Dated {
                    item_id,
                    date: read_date(rest)?,
                })
            }
            PRIVATE_ITEM_DELETED => only_id(Self::Deleted { item_id }),
            PRIVATE_ITEM_RESTORED => only_id(Self::Restored { item_id }),
            PRIVATE_ITEM_NOTE_SET => {
                let note = read_text(rest)?;
                check_note(&note)?;
                Ok(Self::NoteSet { item_id, note })
            }
            _ => Err(KinError::UnsupportedVersion),
        }
    }
}

fn push_text(payload: &mut Vec<u8>, text: &str) {
    payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
    payload.extend_from_slice(text.as_bytes());
}

/// A date field: 0 is none, anything else must be a valid civil date.
fn read_date(bytes: &[u8]) -> Result<Option<CivilDate>, KinError> {
    let encoded = read_u32(bytes, 0)?;
    (encoded != 0)
        .then(|| CivilDate::from_encoded(encoded))
        .transpose()
}

/// A length-prefixed text that ends the payload exactly.
fn read_text(bytes: &[u8]) -> Result<String, KinError> {
    let length = read_u32(bytes, 0)? as usize;
    if bytes.len() - 4 != length {
        return Err(KinError::MalformedProtocol);
    }
    std::str::from_utf8(&bytes[4..])
        .map(str::to_owned)
        .map_err(|_| KinError::MalformedProtocol)
}

/// An item's text: 1–4,096 bytes, no control characters (no line breaks: a
/// to-do is one line, its note holds the rest).
fn check_text(text: &str) -> Result<(), KinError> {
    if text.is_empty() || text.len() > MAX_ITEM_TEXT_BYTES || text.chars().any(char::is_control) {
        return Err(KinError::MalformedProtocol);
    }
    Ok(())
}

/// A note: at most 2,048 bytes (empty clears it), line feeds allowed, no
/// other control characters.
fn check_note(note: &str) -> Result<(), KinError> {
    if note.len() > MAX_PRIVATE_ITEM_NOTE_BYTES
        || note
            .chars()
            .any(|character| character.is_control() && character != '\n')
    {
        return Err(KinError::MalformedProtocol);
    }
    Ok(())
}

/// One private item as replayed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateItem {
    pub text: String,
    /// Empty when there is none.
    pub note: String,
    pub date: Option<CivilDate>,
    pub completed: bool,
    /// A tombstone: kept so Undo can restore it, never listed.
    pub deleted: bool,
    /// The timestamp of the add (UTC milliseconds).
    pub added_at: i64,
    /// The logical time of the last event that changed it.
    pub changed_at: u64,
}

/// One member's "Just for me" list as replayed.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PrivateItems {
    items: BTreeMap<PrivateRecordId, PrivateItem>,
    live: usize,
    off_today: bool,
    /// Whether the member ever set the Today setting (KPRV shows the section
    /// once there is an item or a setting).
    setting_set: bool,
}

impl PrivateItems {
    /// Live items by ID (ascending); deleted ones are left out.
    pub fn live(&self) -> impl Iterator<Item = (&PrivateRecordId, &PrivateItem)> {
        self.items.iter().filter(|(_, item)| !item.deleted)
    }

    /// Any item by ID, deleted or not.
    pub fn get(&self, id: &PrivateRecordId) -> Option<&PrivateItem> {
        self.items.get(id)
    }

    pub fn live_count(&self) -> usize {
        self.live
    }

    /// Whether dated items show on Today and This week (on by default).
    pub fn on_today(&self) -> bool {
        !self.off_today
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty() && !self.setting_set
    }

    /// Replays one event (module doc: it never fails).
    pub fn apply(&mut self, event: &PrivateItemEvent, envelope: &EventEnvelope) {
        let at = envelope.logical_time;
        match event {
            PrivateItemEvent::Added {
                item_id,
                text,
                date,
            } => {
                if self.items.contains_key(item_id) || self.live >= MAX_PRIVATE_ITEMS {
                    return;
                }
                self.items.insert(
                    *item_id,
                    PrivateItem {
                        text: text.clone(),
                        note: String::new(),
                        date: *date,
                        completed: false,
                        deleted: false,
                        added_at: envelope.timestamp,
                        changed_at: at,
                    },
                );
                self.live += 1;
            }
            PrivateItemEvent::OnTodaySet { on } => {
                self.off_today = !on;
                self.setting_set = true;
            }
            _ => {
                let Some(id) = event.item_id() else { return };
                let live = self.live;
                let Some(item) = self.items.get_mut(&id) else {
                    return;
                };
                match event {
                    PrivateItemEvent::Edited { text, .. } => item.text.clone_from(text),
                    PrivateItemEvent::Completed { .. } => item.completed = true,
                    PrivateItemEvent::Reopened { .. } => item.completed = false,
                    PrivateItemEvent::Dated { date, .. } => item.date = *date,
                    PrivateItemEvent::NoteSet { note, .. } => item.note.clone_from(note),
                    PrivateItemEvent::Deleted { .. } => {
                        if item.deleted {
                            return;
                        }
                        item.deleted = true;
                        self.live -= 1;
                    }
                    PrivateItemEvent::Restored { .. } => {
                        if !item.deleted || live >= MAX_PRIVATE_ITEMS {
                            return;
                        }
                        item.deleted = false;
                        self.live += 1;
                    }
                    PrivateItemEvent::Added { .. } | PrivateItemEvent::OnTodaySet { .. } => {}
                }
                item.changed_at = at;
            }
        }
    }

    /// Whether a new event may be written: what replay would ignore, or a
    /// change that changes nothing, is refused (code 4).
    pub fn check_command(&self, event: &PrivateItemEvent) -> Result<(), KinError> {
        let refuse = Err(KinError::InvalidEvent);
        let trimmed = |text: &str| text.trim() == text;
        let live = |id: &PrivateRecordId| self.items.get(id).filter(|item| !item.deleted);
        let ok = match event {
            PrivateItemEvent::Added { item_id, text, .. } => {
                !self.items.contains_key(item_id) && self.live < MAX_PRIVATE_ITEMS && trimmed(text)
            }
            PrivateItemEvent::Edited { item_id, text } => {
                live(item_id).is_some_and(|item| item.text != *text) && trimmed(text)
            }
            PrivateItemEvent::Completed { item_id } => {
                live(item_id).is_some_and(|item| !item.completed)
            }
            PrivateItemEvent::Reopened { item_id } => {
                live(item_id).is_some_and(|item| item.completed)
            }
            PrivateItemEvent::Dated { item_id, date } => {
                live(item_id).is_some_and(|item| item.date != *date)
            }
            PrivateItemEvent::Deleted { item_id } => live(item_id).is_some(),
            PrivateItemEvent::Restored { item_id } => {
                self.items.get(item_id).is_some_and(|item| item.deleted)
                    && self.live < MAX_PRIVATE_ITEMS
            }
            PrivateItemEvent::NoteSet { item_id, note } => {
                live(item_id).is_some_and(|item| item.note != *note) && trimmed(note)
            }
            PrivateItemEvent::OnTodaySet { on } => *on != self.on_today(),
        };
        if ok {
            Ok(())
        } else {
            refuse
        }
    }

    /// KPRV section 11: flags u32 (bit 0: dated items stay off Today and
    /// This week), live item count u32, then each live item in ascending ID
    /// order: ID [16], added timestamp i64, changed logical time u64, date
    /// u32 (0 none), status u8 (0 open, 1 done), 3 zero bytes, text length
    /// u32, note length u32, text, note.
    pub fn encode_section(&self) -> Result<Vec<u8>, KinError> {
        let size = self.live().try_fold(8usize, |size, (_, item)| {
            size.checked_add(48 + item.text.len() + item.note.len())
        });
        let mut out = Vec::new();
        out.try_reserve_exact(size.ok_or(KinError::SizeLimit)?)
            .map_err(|_| KinError::SizeLimit)?;
        let flags = if self.off_today { FLAG_OFF_TODAY } else { 0 };
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&(self.live as u32).to_le_bytes());
        for (id, item) in self.live() {
            out.extend_from_slice(&id.0);
            out.extend_from_slice(&item.added_at.to_le_bytes());
            out.extend_from_slice(&item.changed_at.to_le_bytes());
            out.extend_from_slice(&item.date.map_or(0, CivilDate::encoded).to_le_bytes());
            out.extend_from_slice(&[u8::from(item.completed), 0, 0, 0]);
            out.extend_from_slice(&(item.text.len() as u32).to_le_bytes());
            out.extend_from_slice(&(item.note.len() as u32).to_le_bytes());
            out.extend_from_slice(item.text.as_bytes());
            out.extend_from_slice(item.note.as_bytes());
        }
        Ok(out)
    }
}
