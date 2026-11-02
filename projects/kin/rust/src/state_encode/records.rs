//! Per-section record writers for the KINS body, in body order. Each writes
//! one domain section; `encode_state` closes the section after it.
use super::{classification_code, Output};
use crate::error::KinError;
use crate::recurrence::CivilDate;
use crate::state::{
    CatchUpSummary, HandoffStatus, HouseholdState, ItemStatus, NoteStatus, PulseStatus, TalkStatus,
};

// Enum fields are written as their declared discriminants (`as u8`); those
// numbers are the wire codes in ABI.md and the JS tables that read them back.
// Lengths go through `len_u8` / `len_u16`, which fail instead of truncating.
const PULSE_BYTES: usize = 40;
const SUMMARY_HEADER_BYTES: usize = 24;

/// Item records, then per Item: Area ID, Steps, planning date, last change.
pub(super) fn items(out: &mut Output, state: &HouseholdState) -> Result<(), KinError> {
    for item in &state.items {
        out.bytes(&item.item_id.0)?;
        out.bytes(&item.created_by.0)?;
        out.bytes(&item.created_at.to_le_bytes())?;
        out.u8(classification_code(item.classification))?;
        out.u8(match item.status {
            ItemStatus::Active => 0,
            ItemStatus::Completed => 1,
            ItemStatus::Archived => 2,
        })?;
        out.bytes(&[0; 2])?;
        out.text(&item.text)?;
    }
    for item in &state.items {
        out.id_or_zero(item.area_id.map(|id| id.0))?;
    }
    for item in &state.items {
        for step in &item.steps {
            // Replay already normalizes text. Normalizing again is idempotent and
            // keeps a state built some other way (tests) from encoding bad text.
            let text = crate::state::normalize_step_text(&step.text)?;
            out.bytes(&item.item_id.0)?;
            out.bytes(&step.step_id.0)?;
            out.u8(u8::from(step.completed))?;
            out.u8(u8::from(step.archived))?;
            out.bytes(&[0; 2])?;
            out.text(&text)?;
        }
    }
    for item in &state.items {
        out.u32(item.planning_date.map_or(0, CivilDate::encoded))?;
    }
    for item in &state.items {
        out.bytes(&item.last_changed_at.to_le_bytes())?;
    }
    Ok(())
}

pub(super) fn handoffs(out: &mut Output, state: &HouseholdState) -> Result<(), KinError> {
    for handoff in &state.handoffs {
        out.bytes(&handoff.handoff_id.0)?;
        out.bytes(&handoff.created_by.0)?;
        out.bytes(&handoff.created_at.to_le_bytes())?;
        out.u8(match handoff.status {
            HandoffStatus::Unacknowledged => 0,
            HandoffStatus::Acknowledged => 1,
            HandoffStatus::Archived => 2,
        })?;
        out.bytes(&[0; 3])?;
        out.text(&handoff.text)?;
    }
    Ok(())
}

pub(super) fn talks(out: &mut Output, state: &HouseholdState) -> Result<(), KinError> {
    for talk in &state.talks {
        out.bytes(&talk.talk_id.0)?;
        out.bytes(&talk.created_by.0)?;
        out.bytes(&talk.created_at.to_le_bytes())?;
        out.u8(match talk.status {
            TalkStatus::Open => 0,
            TalkStatus::Resolved => 1,
            TalkStatus::Archived => 2,
        })?;
        out.bytes(&[0; 3])?;
        out.text(&talk.text)?;
    }
    Ok(())
}

pub(super) fn pulses(out: &mut Output, state: &HouseholdState) -> Result<(), KinError> {
    for pulse in &state.pulses {
        out.reserve(PULSE_BYTES)?;
        out.bytes(&pulse.actor_id.0)?;
        out.bytes(&pulse.set_at.to_le_bytes())?;
        out.bytes(&pulse.expires_at.to_le_bytes())?;
        out.u8(pulse.value as u8)?;
        out.u8(match pulse.status {
            PulseStatus::Active => 0,
            PulseStatus::Expired => 1,
        })?;
        out.bytes(&[0; 6])?;
    }
    Ok(())
}

/// Routine records, then one next-occurrence date per Routine.
pub(super) fn routines(out: &mut Output, state: &HouseholdState) -> Result<(), KinError> {
    for routine in &state.routines {
        out.bytes(&routine.routine_id.0)?;
        out.bytes(&routine.created_by.0)?;
        out.bytes(&routine.created_at.to_le_bytes())?;
        out.u32(routine.created_on.encoded())?;
        out.u32(routine.occurrence_key.map_or(0, CivilDate::encoded))?;
        out.u8(routine.cadence as u8)?;
        out.u8(u8::from(routine.archived))?;
        out.u8(if routine.occurrence_key.is_none() {
            0
        } else if routine.completed {
            2
        } else {
            1
        })?;
        out.u8(0)?;
        out.text(&routine.text)?;
    }
    for routine in &state.routines {
        out.u32(routine.next_start.map_or(0, CivilDate::encoded))?;
    }
    Ok(())
}

pub(super) fn areas(out: &mut Output, state: &HouseholdState) -> Result<(), KinError> {
    for area in &state.areas {
        let name = crate::state::normalize_area_name(&area.name)?;
        out.bytes(&area.area_id.0)?;
        out.u8(u8::from(area.archived))?;
        out.bytes(&[0; 3])?;
        out.text(&name)?;
    }
    Ok(())
}

pub(super) fn notes(out: &mut Output, state: &HouseholdState) -> Result<(), KinError> {
    for note in &state.notes {
        let (title, body) = crate::state::normalize_note(&note.title, &note.body)?;
        out.bytes(&note.note_id.0)?;
        out.bytes(&note.created_by.0)?;
        out.bytes(&note.updated_by.0)?;
        out.bytes(&note.created_at.to_le_bytes())?;
        out.bytes(&note.updated_at.to_le_bytes())?;
        out.id_or_zero(note.area_id.map(|id| id.0))?;
        out.u8(u8::from(note.status == NoteStatus::Archived))?;
        out.bytes(&[0; 3])?;
        out.count(title.len())?;
        out.count(body.len())?;
        out.bytes(title.as_bytes())?;
        out.bytes(body.as_bytes())?;
    }
    Ok(())
}

pub(super) fn pins(out: &mut Output, state: &HouseholdState) -> Result<(), KinError> {
    for pin in &state.pins {
        out.u8(pin.target_kind as u8)?;
        out.bytes(&[0; 3])?;
        out.bytes(&pin.target_id)?;
    }
    Ok(())
}

pub(super) fn playbooks(out: &mut Output, state: &HouseholdState) -> Result<(), KinError> {
    for record in &state.playbooks {
        out.bytes(&record.playbook_id.0)?;
        out.u8(u8::from(record.archived))?;
        out.len_u8(record.entries.len())?;
        out.len_u16(record.title.len())?;
        out.bytes(&[0; 2])?;
        out.bytes(record.title.as_bytes())?;
        for entry in &record.entries {
            out.len_u16(entry.len())?;
            out.bytes(entry.as_bytes())?;
        }
    }
    Ok(())
}

pub(super) fn reference_records(out: &mut Output, state: &HouseholdState) -> Result<(), KinError> {
    for record in &state.reference_records {
        let (title, fields) = crate::state::normalize_reference_text(
            &record.title,
            &record
                .fields
                .iter()
                .map(|field| (field.field_id, field.label.clone(), field.value.clone()))
                .collect::<Vec<_>>(),
        )?;
        out.bytes(&record.record_id.0)?;
        out.id_or_zero(record.area_id.map(|id| id.0))?;
        out.len_u16(title.len())?;
        out.len_u8(fields.len())?;
        out.u8(u8::from(record.archived))?;
        out.bytes(title.as_bytes())?;
        for field in fields {
            out.bytes(&field.field_id.0)?;
            out.len_u16(field.label.len())?;
            out.len_u16(field.value.len())?;
            out.bytes(field.label.as_bytes())?;
            out.bytes(field.value.as_bytes())?;
        }
    }
    Ok(())
}

pub(super) fn maintenance(out: &mut Output, state: &HouseholdState) -> Result<(), KinError> {
    for entry in &state.maintenance_events {
        out.bytes(&entry.maintenance_id.0)?;
        out.bytes(&entry.record_id.0)?;
        out.u32(entry.performed_on.encoded())?;
        out.u32(entry.next_on.map_or(0, CivilDate::encoded))?;
        out.id_or_zero(entry.routine_id.map(|id| id.0))?;
        out.u8(u8::from(entry.archived))?;
        out.u8(0)?;
        out.len_u16(entry.summary.len())?;
        out.bytes(entry.summary.as_bytes())?;
    }
    Ok(())
}

pub(super) fn attachments(out: &mut Output, state: &HouseholdState) -> Result<(), KinError> {
    for entry in &state.attachments {
        out.bytes(&entry.attachment_id.0)?;
        out.u8(entry.parent_kind as u8)?;
        out.u8(u8::from(entry.removed))?;
        out.bytes(&[0; 2])?;
        out.bytes(&entry.parent_id)?;
    }
    Ok(())
}

pub(super) fn responsibilities(out: &mut Output, state: &HouseholdState) -> Result<(), KinError> {
    for entry in &state.responsibilities {
        out.u8(entry.target_kind as u8)?;
        out.bytes(&entry.target_id)?;
        out.id_or_zero(entry.member_id.map(|id| id.0))?;
    }
    Ok(())
}

pub(super) fn summary_entries(out: &mut Output, summary: &CatchUpSummary) -> Result<(), KinError> {
    for entry in &summary.entries {
        out.reserve(SUMMARY_HEADER_BYTES + entry.text.len())?;
        out.bytes(&entry.event_id.0)?;
        out.u8(entry.kind as u8)?;
        out.u8(entry.entity_kind as u8)?;
        out.u8(entry.classification.map_or(u8::MAX, classification_code))?;
        out.u8(0)?;
        out.text(&entry.text)?;
    }
    Ok(())
}
