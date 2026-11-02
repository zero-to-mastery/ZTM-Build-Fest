//! A member's private log (#489, ADR 0019): records only that member's own
//! devices can read, sealed under the member key (MK) instead of a household
//! key.
//!
//! Private events live in their own log (history.rs `Log::Private`), apart
//! from the household history, chat and the fridge: they never enter
//! household replay, the KINS projection or a household request, and every
//! other log refuses them. An engine instance holds the private log of the
//! one member who is unlocked on this device.
//!
//! Kinds 100–199 are reserved for private records. The journal (#496), the
//! "Just for me" list (#510) and reminders and settings that follow a member
//! (#520) add their own kinds here and their own sections to KPRV. Until
//! then the log has one placeholder kind, `PRIVATE_NOTE_SET` (100): a short
//! private note by ID, enough to prove the log end to end. It is unreleased
//! and the first of those stories may replace it.
//!
//! "Just for me" (#510) owns kinds 110–119 and KPRV section 11
//! (private_items.rs); reminders (120–129) and settings (130–139) that follow
//! a member (#520) own KPRV sections 12 and 13 (private_prefs.rs). New
//! private events are made by `kin_private_execute` (private_command.rs).
//!
//! The journal (#496) owns kinds 101–109 and KPRV section 101 (journal.rs).
//! The placeholder kind 100 stays reserved and decodable; no surface writes
//! it.
//!
//! Replay rules (replay never fails on a decoded private event, beyond the
//! checks every log makes):
//! - Every event in one private log has the same author: the log's member.
//!   An event from anyone else is invalid; the service and the member key
//!   already keep other members out, so this is a consistency check, not the
//!   access control.
//! - A note set to text replaces the note; set to empty text it is removed.
//!   The latest event in replay order wins.
//! - Journal events replay as journal.rs describes.
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::error::KinError;
use crate::event::{ActorId, DeviceId, EventEnvelope, EventKind, PrivateRecordId};
use crate::wire::{read_id, read_u32, MAX_PROTOCOL_BYTES};

/// The first and last kind codes reserved for private records.
pub const FIRST_PRIVATE_KIND: u16 = 100;
pub const LAST_PRIVATE_KIND: u16 = 199;
/// The placeholder private kind (see the module doc).
pub const PRIVATE_NOTE_SET: u16 = 100;
/// Most events one member's private log holds (ADR 0019).
pub const MAX_PRIVATE_EVENT_COUNT: usize = 50_000;
/// Largest private note, in UTF-8 bytes.
pub const MAX_PRIVATE_NOTE_BYTES: usize = 2_048;
/// KPRV sections (`encode_private`).
pub const SECTION_NOTES: u16 = 1;
/// The journal's KPRV section (#496, journal.rs).
pub const SECTION_JOURNAL: u16 = crate::journal::FIRST_JOURNAL_KIND;

/// Whether a kind code is reserved for the private log. Every code in the
/// range belongs to the private log, known or not, so a household log never
/// takes one.
pub const fn is_private_code(code: u16) -> bool {
    code >= FIRST_PRIVATE_KIND && code <= LAST_PRIVATE_KIND
}

/// The canonical payload of a private event.
///
/// `PRIVATE_NOTE_SET`: note ID [16] (never zero), text length u32
/// (0 removes the note, at most `MAX_PRIVATE_NOTE_BYTES`), UTF-8 text.
pub fn encode_payload(kind: &EventKind) -> Result<Vec<u8>, KinError> {
    match kind {
        EventKind::PrivateNoteSet { note_id, text } => {
            if note_id.0 == [0; 16] || !valid_note(text) {
                return Err(KinError::MalformedProtocol);
            }
            let mut payload = Vec::with_capacity(20 + text.len());
            payload.extend_from_slice(&note_id.0);
            payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
            payload.extend_from_slice(text.as_bytes());
            Ok(payload)
        }
        EventKind::PrivateItem(event) => event.encode(),
        kind @ (EventKind::ReminderSet { .. }
        | EventKind::ReminderCleared { .. }
        | EventKind::SettingSet { .. }) => crate::private_prefs::encode_payload(kind),
        EventKind::Journal(event) => crate::journal::encode_payload(event),
        _ => Err(KinError::InvalidEvent),
    }
}

/// Decodes a private payload strictly. A code in the private range that this
/// engine does not know is unsupported (a later release added it).
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<EventKind, KinError> {
    if crate::journal::is_journal_code(code) {
        return crate::journal::decode_payload(code, payload).map(EventKind::Journal);
    }
    match code {
        PRIVATE_NOTE_SET => {
            if payload.len() < 20 {
                return Err(KinError::MalformedProtocol);
            }
            let note_id = PrivateRecordId(read_id(payload, 0)?);
            let length = read_u32(payload, 16)? as usize;
            if note_id.0 == [0; 16] || payload.len() != 20 + length {
                return Err(KinError::MalformedProtocol);
            }
            let text =
                std::str::from_utf8(&payload[20..]).map_err(|_| KinError::MalformedProtocol)?;
            if !valid_note(text) {
                return Err(KinError::MalformedProtocol);
            }
            Ok(EventKind::PrivateNoteSet {
                note_id,
                text: text.to_owned(),
            })
        }
        code if crate::private_items::is_item_code(code) => Ok(EventKind::PrivateItem(
            crate::private_items::PrivateItemEvent::decode(code, payload)?,
        )),
        // Reminders and settings (#520): private_prefs.rs.
        code if crate::private_prefs::is_prefs_code(code) => {
            crate::private_prefs::decode_payload(code, payload)
        }
        _ => Err(KinError::UnsupportedVersion),
    }
}

/// A note's text: empty (removal) or 1..=MAX_PRIVATE_NOTE_BYTES bytes with
/// no control characters but line breaks. Never trimmed here: what the
/// member wrote is what is kept.
fn valid_note(text: &str) -> bool {
    text.len() <= MAX_PRIVATE_NOTE_BYTES
        && !text
            .chars()
            .any(|character| character.is_control() && character != '\n')
}

/// One private note as replayed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateNote {
    pub text: String,
    /// The logical time and device of the event that set it.
    pub logical_time: u64,
    pub device_id: DeviceId,
}

/// One member's private records as replayed.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PrivateState {
    member: Option<ActorId>,
    notes: BTreeMap<PrivateRecordId, PrivateNote>,
    /// "Just for me" (#510, private_items.rs).
    items: crate::private_items::PrivateItems,
    /// Reminders and settings (#520, private_prefs.rs).
    prefs: Arc<crate::private_prefs::PrefsState>,
    /// The journal (#496, journal.rs).
    journal: crate::journal::JournalState,
}

impl PrivateState {
    /// The member every event in this log was written by, once there is one.
    pub fn member(&self) -> Option<ActorId> {
        self.member
    }

    /// Notes by ID (ascending).
    pub fn notes(&self) -> impl Iterator<Item = (&PrivateRecordId, &PrivateNote)> {
        self.notes.iter()
    }

    pub fn note(&self, id: &PrivateRecordId) -> Option<&PrivateNote> {
        self.notes.get(id)
    }

    /// The member's "Just for me" list (#510).
    pub fn items(&self) -> &crate::private_items::PrivateItems {
        &self.items
    }

    /// Reminders and settings that follow the member (#520).
    pub fn prefs(&self) -> &crate::private_prefs::PrefsState {
        &self.prefs
    }

    /// The member's journal (#496).
    pub fn journal(&self) -> &crate::journal::JournalState {
        &self.journal
    }

    /// Whether a new private event may be written (`kin_private_execute`):
    /// each part of the projection judges its own kinds. The placeholder
    /// note has no rule beyond its payload's.
    pub fn check_command(&self, kind: &EventKind) -> Result<(), KinError> {
        match kind {
            EventKind::PrivateNoteSet { .. } => Ok(()),
            EventKind::PrivateItem(event) => self.items.check_command(event),
            EventKind::ReminderSet { .. }
            | EventKind::ReminderCleared { .. }
            | EventKind::SettingSet { .. } => {
                crate::private_prefs::check_command(&self.prefs, kind)
            }
            EventKind::Journal(event) => self.journal.check_command(event),
            _ => Err(KinError::InvalidEvent),
        }
    }
}

/// Replays one private event into the member's state (copy-on-write).
pub fn apply(state: &mut Arc<PrivateState>, event: &EventEnvelope) -> Result<(), KinError> {
    if event.actor_id.0 == [0; 16] || event.device_id.0 == [0; 16] {
        return Err(KinError::InvalidEvent);
    }
    if state.member.is_some_and(|member| member != event.actor_id) {
        return Err(KinError::InvalidEvent);
    }
    let state = Arc::make_mut(state);
    state.member = Some(event.actor_id);
    match &event.kind {
        EventKind::PrivateNoteSet { note_id, text } => {
            if text.is_empty() {
                state.notes.remove(note_id);
            } else {
                state.notes.insert(
                    *note_id,
                    PrivateNote {
                        text: text.clone(),
                        logical_time: event.logical_time,
                        device_id: event.device_id,
                    },
                );
            }
            Ok(())
        }
        EventKind::PrivateItem(item_event) => {
            state.items.apply(item_event, event);
            Ok(())
        }
        EventKind::ReminderSet { .. }
        | EventKind::ReminderCleared { .. }
        | EventKind::SettingSet { .. } => crate::private_prefs::apply(&mut state.prefs, event),
        EventKind::Journal(journal) => {
            state.journal.apply(event, journal);
            Ok(())
        }
        _ => Err(KinError::InvalidEvent),
    }
}

/// KPRV v1, the member's private projection (`kin_private_state`):
///
/// "KPRV", version u16 = 1, reserved u16 = 0; member ID [16] (zero while the
/// log is empty); record count u32 (events in the log); section count u16,
/// reserved u16; then each section: code u16, reserved u16, byte length u32,
/// bytes. Sections appear in ascending code order, each at most once. A
/// reader skips a section whose code it does not know, so the stories that
/// add private records extend KPRV by adding sections, never by changing
/// one.
///
/// Section 1, notes (the placeholder kind): note count u32, then each note
/// in ascending ID order: ID [16], logical time u64, device ID [16], text
/// length u32, text.
///
/// Section 11, "Just for me" (#510, private_items.rs `encode_section`),
/// once the member has a private item or a list setting.
///
/// Section 12, reminders, and section 13, settings (#520, private_prefs.rs
/// `encode_reminders` and `encode_settings`), each once there is one.
///
/// Section 101, the journal (#496, journal.rs `encode_section`), once the
/// member has written an entry.
pub fn encode_private(state: &PrivateState, record_count: usize) -> Result<Vec<u8>, KinError> {
    let mut notes = Vec::new();
    notes.extend_from_slice(&(state.notes.len() as u32).to_le_bytes());
    for (id, note) in &state.notes {
        notes.extend_from_slice(&id.0);
        notes.extend_from_slice(&note.logical_time.to_le_bytes());
        notes.extend_from_slice(&note.device_id.0);
        notes.extend_from_slice(&(note.text.len() as u32).to_le_bytes());
        notes.extend_from_slice(note.text.as_bytes());
    }
    let mut sections: Vec<(u16, Vec<u8>)> = vec![(SECTION_NOTES, notes)];
    if !state.items.is_empty() {
        sections.push((
            crate::private_items::SECTION_ITEMS,
            state.items.encode_section()?,
        ));
    }
    if state.prefs.reminders().next().is_some() {
        sections.push((
            crate::private_prefs::SECTION_REMINDERS,
            crate::private_prefs::encode_reminders(&state.prefs),
        ));
    }
    if state.prefs.settings().next().is_some() {
        sections.push((
            crate::private_prefs::SECTION_SETTINGS,
            crate::private_prefs::encode_settings(&state.prefs),
        ));
    }
    if !state.journal.is_empty() {
        sections.push((
            SECTION_JOURNAL,
            crate::journal::encode_section(&state.journal),
        ));
    }
    let size = sections
        .iter()
        .fold(32, |size, (_, bytes)| size + 8 + bytes.len());
    if size > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let record_count = u32::try_from(record_count).map_err(|_| KinError::SizeLimit)?;
    let mut out = Vec::new();
    out.try_reserve_exact(size)
        .map_err(|_| KinError::SizeLimit)?;
    out.extend_from_slice(b"KPRV");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0; 2]);
    out.extend_from_slice(&state.member.map_or([0; 16], |member| member.0));
    out.extend_from_slice(&record_count.to_le_bytes());
    out.extend_from_slice(&(sections.len() as u16).to_le_bytes());
    out.extend_from_slice(&[0; 2]);
    for (code, bytes) in &sections {
        out.extend_from_slice(&code.to_le_bytes());
        out.extend_from_slice(&[0; 2]);
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    Ok(out)
}
