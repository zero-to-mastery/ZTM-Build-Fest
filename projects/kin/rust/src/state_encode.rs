//! Protocol-24 KINS projection encoding.
//!
//! Header (96 bytes): "KINS", version 24, reserved 0, then u32 counts for
//! Items, Handoffs, Talks and Pulses; summary count and total; through-present
//! flag (u8 + 3 reserved) and the through event ID; then u32 counts for
//! Routines, Areas, Notes and Steps; the household mode (u8 + 3 reserved);
//! and u32 counts for Pins, Playbooks, Reference Records, Maintenance events,
//! Attachments and Responsibilities.
//!
//! Section table (112 bytes): one (u32 revision, u32 byte length) entry per
//! domain section, in body order (`sections.rs`). This encoder writes
//! revision 0; the ABI layer stamps real revisions.
//!
//! Body, one contiguous section per domain: Items (records, then one Area ID,
//! the Steps, one planning date and one last-changed timestamp per Item);
//! Handoffs; Talks; Pulses; Routines (records, then one next-occurrence date
//! per Routine); Areas; Notes; Pins; Playbooks; Reference Records;
//! Maintenance events; Attachments; Responsibilities; then the catch-up
//! summary entries. ABI.md has every field.
mod records;

use crate::error::KinError;
use crate::event::{valid_timestamp, ItemClassification};
use crate::sections::{SECTION_COUNT, SECTION_ENTRY_BYTES, SECTION_TABLE_BYTES};
use crate::state::{
    CatchUpSummary, HouseholdState, SummaryEntityKind, SummaryKind, MAX_SUMMARY_ENTRIES,
};
use crate::wire::{
    push_u16, push_u32, MAX_EVENT_COUNT, MAX_ITEM_TEXT_BYTES, MAX_MAINTENANCE_EVENTS,
    MAX_PROTOCOL_BYTES, PROTOCOL_VERSION, RESULT_HEADER_BYTES,
};
use records::*;

/// Appends bounded sections, failing with `SizeLimit` before the result could
/// exceed the 64 MiB protocol bound.
pub(super) struct Output {
    bytes: Vec<u8>,
    /// End offset of each finished section, in body order.
    section_ends: Vec<usize>,
}

impl Output {
    pub(super) fn reserve(&mut self, additional: usize) -> Result<(), KinError> {
        let total = self
            .bytes
            .len()
            .checked_add(additional)
            .ok_or(KinError::SizeLimit)?;
        if total > MAX_PROTOCOL_BYTES {
            return Err(KinError::SizeLimit);
        }
        self.bytes
            .try_reserve(additional)
            .map_err(|_| KinError::SizeLimit)
    }

    pub(super) fn bytes(&mut self, bytes: &[u8]) -> Result<(), KinError> {
        self.reserve(bytes.len())?;
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    pub(super) fn u8(&mut self, value: u8) -> Result<(), KinError> {
        self.bytes(&[value])
    }

    pub(super) fn u16(&mut self, value: u16) -> Result<(), KinError> {
        self.reserve(2)?;
        push_u16(&mut self.bytes, value);
        Ok(())
    }

    pub(super) fn u32(&mut self, value: u32) -> Result<(), KinError> {
        self.reserve(4)?;
        push_u32(&mut self.bytes, value);
        Ok(())
    }

    pub(super) fn count(&mut self, value: usize) -> Result<(), KinError> {
        self.u32(u32::try_from(value).map_err(|_| KinError::SizeLimit)?)
    }

    /// A length in a one-byte field; a longer value is a size error.
    pub(super) fn len_u8(&mut self, length: usize) -> Result<(), KinError> {
        self.u8(u8::try_from(length).map_err(|_| KinError::SizeLimit)?)
    }

    /// A length in a two-byte field; a longer value is a size error.
    pub(super) fn len_u16(&mut self, length: usize) -> Result<(), KinError> {
        self.u16(u16::try_from(length).map_err(|_| KinError::SizeLimit)?)
    }

    pub(super) fn text(&mut self, text: &str) -> Result<(), KinError> {
        self.count(text.len())?;
        self.bytes(text.as_bytes())
    }

    pub(super) fn id_or_zero(&mut self, id: Option<[u8; 16]>) -> Result<(), KinError> {
        self.bytes(&id.unwrap_or([0; 16]))
    }

    fn end_section(&mut self) {
        self.section_ends.push(self.bytes.len());
    }

    /// Fills the section table's byte lengths; revisions stay 0.
    fn finish(mut self) -> Vec<u8> {
        debug_assert_eq!(self.section_ends.len(), SECTION_COUNT);
        let mut start = RESULT_HEADER_BYTES + SECTION_TABLE_BYTES;
        for (index, end) in self.section_ends.iter().enumerate() {
            let at = RESULT_HEADER_BYTES + index * SECTION_ENTRY_BYTES + 4;
            // Bounded by MAX_PROTOCOL_BYTES, so every length fits in u32.
            self.bytes[at..at + 4].copy_from_slice(&((end - start) as u32).to_le_bytes());
            start = *end;
        }
        self.bytes
    }
}

pub(super) fn classification_code(classification: ItemClassification) -> u8 {
    match classification {
        ItemClassification::Today => 0,
        ItemClassification::Need => 1,
        ItemClassification::Shopping => 2,
        ItemClassification::Staple => 3,
    }
}

pub fn encode_state(state: &HouseholdState, summary: &CatchUpSummary) -> Result<Vec<u8>, KinError> {
    validate(state, summary)?;
    let mut out = Output {
        bytes: Vec::new(),
        section_ends: Vec::with_capacity(SECTION_COUNT),
    };
    // One allocation for the common case instead of repeated doubling, which
    // copied a 40 MB projection several times over.
    out.reserve(estimated_size(state, summary).min(MAX_PROTOCOL_BYTES))?;
    header(&mut out, state, summary)?;
    out.bytes(&[0; SECTION_TABLE_BYTES])?;
    // Section order must match `sections::SECTIONS` exactly: the table and the
    // JS decoder (projection-decode.js) label sections by position. Each
    // writer is followed by `end_section()`, which records where it ended.
    items(&mut out, state)?;
    out.end_section();
    handoffs(&mut out, state)?;
    out.end_section();
    talks(&mut out, state)?;
    out.end_section();
    pulses(&mut out, state)?;
    out.end_section();
    routines(&mut out, state)?;
    out.end_section();
    areas(&mut out, state)?;
    out.end_section();
    notes(&mut out, state)?;
    out.end_section();
    pins(&mut out, state)?;
    out.end_section();
    playbooks(&mut out, state)?;
    out.end_section();
    reference_records(&mut out, state)?;
    out.end_section();
    maintenance(&mut out, state)?;
    out.end_section();
    attachments(&mut out, state)?;
    out.end_section();
    responsibilities(&mut out, state)?;
    out.end_section();
    summary_entries(&mut out, summary)?;
    out.end_section();
    Ok(out.finish())
}

fn header(
    out: &mut Output,
    state: &HouseholdState,
    summary: &CatchUpSummary,
) -> Result<(), KinError> {
    let step_count = state
        .items
        .iter()
        .map(|item| item.steps.len())
        .sum::<usize>();
    out.reserve(RESULT_HEADER_BYTES + SECTION_TABLE_BYTES)?;
    out.bytes(b"KINS")?;
    out.u16(PROTOCOL_VERSION)?;
    out.u16(0)?;
    out.count(state.items.len())?;
    out.count(state.handoffs.len())?;
    out.count(state.talks.len())?;
    out.count(state.pulses.len())?;
    out.count(summary.entries.len())?;
    out.u32(summary.total_count)?;
    out.u8(u8::from(summary.through_event_id.is_some()))?;
    out.bytes(&[0; 3])?;
    out.id_or_zero(summary.through_event_id.map(|id| id.0))?;
    out.count(state.routines.len())?;
    out.count(state.areas.len())?;
    out.count(state.notes.len())?;
    out.count(step_count)?;
    out.u8(state.mode as u8)?;
    out.bytes(&[0; 3])?;
    out.count(state.pins.len())?;
    out.count(state.playbooks.len())?;
    out.count(state.reference_records.len())?;
    out.count(state.maintenance_events.len())?;
    out.count(state.attachments.len())?;
    out.count(state.responsibilities.len())
}

/// The projection's size from its fixed record sizes and text lengths. An
/// estimate only: what it misses grows the buffer as usual.
fn estimated_size(state: &HouseholdState, summary: &CatchUpSummary) -> usize {
    let items: usize = state
        .items
        .iter()
        .map(|item| {
            76 + item.text.len()
                + item
                    .steps
                    .iter()
                    .map(|step| 40 + step.text.len())
                    .sum::<usize>()
        })
        .sum();
    let texts = |lengths: &mut dyn Iterator<Item = usize>| lengths.sum::<usize>();
    RESULT_HEADER_BYTES
        + SECTION_TABLE_BYTES
        + items
        + texts(&mut state.handoffs.iter().map(|handoff| 48 + handoff.text.len()))
        + texts(&mut state.talks.iter().map(|talk| 48 + talk.text.len()))
        + state.pulses.len() * 40
        + texts(&mut state.routines.iter().map(|routine| 60 + routine.text.len()))
        + texts(
            &mut state
                .notes
                .iter()
                .map(|note| 92 + note.title.len() + note.body.len()),
        )
        + texts(&mut summary.entries.iter().map(|entry| 24 + entry.text.len()))
        + 4096
}

/// Structural checks on the derived state that must hold before encoding; a
/// failure means the projection is not representable, never a partial result.
fn validate(state: &HouseholdState, summary: &CatchUpSummary) -> Result<(), KinError> {
    if state
        .items
        .len()
        .saturating_add(state.handoffs.len())
        .saturating_add(state.talks.len())
        .saturating_add(state.pulses.len())
        .saturating_add(state.routines.len())
        > MAX_EVENT_COUNT
        || state.pins.len() > crate::state::MAX_PINS
        || state.areas.len() > crate::state::MAX_AREAS
        || state.notes.len() > crate::state::MAX_NOTES
        || state.reference_records.len() > crate::state::MAX_REFERENCE_RECORDS
        || state.maintenance_events.len() > MAX_MAINTENANCE_EVENTS
        || state.attachments.len() > crate::state::MAX_ATTACHMENTS
        || state
            .items
            .iter()
            .any(|item| item.steps.len() > crate::state::MAX_STEPS_PER_ITEM)
    {
        return Err(KinError::SizeLimit);
    }
    for routine in &state.routines {
        if routine.text.is_empty()
            || routine.text.len() > MAX_ITEM_TEXT_BYTES
            || !valid_timestamp(routine.created_at)
            || (routine.archived && routine.occurrence_key.is_some())
            || (routine.completed && routine.occurrence_key.is_none())
            || (routine.archived && routine.next_start.is_some())
            || routine
                .next_start
                .zip(routine.occurrence_key)
                .is_some_and(|(next, key)| next <= key)
        {
            return Err(KinError::MalformedProtocol);
        }
        if let Some(key) = routine.occurrence_key {
            routine.cadence.validate_key(routine.created_on, key)?;
        }
    }
    if state
        .items
        .iter()
        .any(|item| !valid_timestamp(item.last_changed_at))
    {
        return Err(KinError::MalformedProtocol);
    }
    let summary_count = summary.entries.len();
    if summary_count > MAX_SUMMARY_ENTRIES
        || summary_count > summary.total_count as usize
        || summary.total_count as usize > MAX_EVENT_COUNT
        || (summary.total_count > 0 && summary.through_event_id.is_none())
    {
        return Err(KinError::MalformedProtocol);
    }
    for entry in &summary.entries {
        let expected_entity = match entry.kind {
            SummaryKind::ItemAdded
            | SummaryKind::ItemCompleted
            | SummaryKind::ItemReopened
            | SummaryKind::ItemArchived => SummaryEntityKind::Item,
            SummaryKind::HandoffAdded
            | SummaryKind::HandoffAcknowledged
            | SummaryKind::HandoffArchived => SummaryEntityKind::Handoff,
            SummaryKind::TalkAdded
            | SummaryKind::TalkResolved
            | SummaryKind::TalkReopened
            | SummaryKind::TalkArchived => SummaryEntityKind::Talk,
            SummaryKind::RoutineCreated
            | SummaryKind::RoutineOccurrenceCompleted
            | SummaryKind::RoutineOccurrenceReopened
            | SummaryKind::RoutineArchived => SummaryEntityKind::Routine,
        };
        if entry.entity_kind != expected_entity
            || (entry.entity_kind == SummaryEntityKind::Item) != entry.classification.is_some()
            || entry.text.is_empty()
            || entry.text.len() > MAX_ITEM_TEXT_BYTES
        {
            return Err(KinError::MalformedProtocol);
        }
    }
    Ok(())
}
