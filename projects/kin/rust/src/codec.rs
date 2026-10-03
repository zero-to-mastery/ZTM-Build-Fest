//! Canonical encoding and validated metadata. Existing event bytes stay immutable.
use crate::error::KinError;
use crate::event::*;
use crate::protocol::{decode_event, MAX_ITEM_TEXT_BYTES, PROTOCOL_VERSION};

pub fn kind_code(kind: &EventKind) -> u16 {
    match kind {
        EventKind::ItemAdded { .. } => 1,
        EventKind::ItemCompleted { .. } => 2,
        EventKind::ItemReopened { .. } => 3,
        EventKind::ItemArchived { .. } => 4,
        EventKind::HandoffAdded { .. } => 5,
        EventKind::HandoffAcknowledged { .. } => 6,
        EventKind::HandoffArchived { .. } => 7,
        EventKind::TalkAdded { .. } => 8,
        EventKind::TalkResolved { .. } => 9,
        EventKind::TalkReopened { .. } => 10,
        EventKind::TalkArchived { .. } => 11,
        EventKind::PulseSet { .. } => 12,
        EventKind::PulseCleared => 13,
        EventKind::RoutineCreated { .. } => 14,
        EventKind::RoutineOccurrenceCompleted { .. } => 15,
        EventKind::RoutineOccurrenceReopened { .. } => 16,
        EventKind::RoutineArchived { .. } => 17,
    }
}

fn push_text(payload: &mut Vec<u8>, text: &str) -> Result<(), KinError> {
    if text.is_empty() || text.len() > MAX_ITEM_TEXT_BYTES {
        return Err(KinError::MalformedProtocol);
    }
    payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
    payload.extend_from_slice(text.as_bytes());
    Ok(())
}

/// Encodes the supplied schema, including legacy Item schema 1. This never edits
/// canonical source history; callers retain its original bytes when decoding.
pub fn encode_event(event: &EventEnvelope) -> Result<Vec<u8>, KinError> {
    let mut payload = Vec::new();
    match &event.kind {
        EventKind::ItemAdded {
            item_id,
            text,
            classification,
        } => {
            payload.extend_from_slice(&item_id.0);
            if event.event_version == 2 {
                payload.extend_from_slice(&[
                    u8::from(*classification == ItemClassification::Need),
                    0,
                    0,
                    0,
                ]);
            } else if event.event_version != 1 || *classification != ItemClassification::Today {
                return Err(KinError::UnsupportedVersion);
            }
            push_text(&mut payload, text)?;
        }
        EventKind::ItemCompleted { item_id }
        | EventKind::ItemReopened { item_id }
        | EventKind::ItemArchived { item_id } => payload.extend_from_slice(&item_id.0),
        EventKind::HandoffAdded { handoff_id, text } => {
            payload.extend_from_slice(&handoff_id.0);
            push_text(&mut payload, text)?;
        }
        EventKind::HandoffAcknowledged { handoff_id }
        | EventKind::HandoffArchived { handoff_id } => payload.extend_from_slice(&handoff_id.0),
        EventKind::TalkAdded { talk_id, text } => {
            payload.extend_from_slice(&talk_id.0);
            push_text(&mut payload, text)?;
        }
        EventKind::TalkResolved { talk_id }
        | EventKind::TalkReopened { talk_id }
        | EventKind::TalkArchived { talk_id } => payload.extend_from_slice(&talk_id.0),
        EventKind::PulseSet { value, expires_at } => {
            payload.extend_from_slice(&[*value as u8, 0, 0, 0, 0, 0, 0, 0]);
            payload.extend_from_slice(&expires_at.to_le_bytes());
        }
        EventKind::PulseCleared => {}
        EventKind::RoutineCreated {
            routine_id,
            text,
            cadence,
            created_on,
        } => {
            payload.extend_from_slice(&routine_id.0);
            payload.extend_from_slice(&[*cadence as u8, 0, 0, 0]);
            payload.extend_from_slice(&created_on.encoded().to_le_bytes());
            push_text(&mut payload, text)?;
        }
        EventKind::RoutineOccurrenceCompleted { routine_id, key }
        | EventKind::RoutineOccurrenceReopened { routine_id, key } => {
            payload.extend_from_slice(&routine_id.0);
            payload.extend_from_slice(&key.encoded().to_le_bytes());
        }
        EventKind::RoutineArchived { routine_id } => payload.extend_from_slice(&routine_id.0),
    }
    let mut bytes = Vec::with_capacity(88 + payload.len());
    bytes.extend_from_slice(&event.event_version.to_le_bytes());
    bytes.extend_from_slice(&kind_code(&event.kind).to_le_bytes());
    bytes.extend_from_slice(&event.event_id.0);
    bytes.extend_from_slice(&event.household_id.0);
    bytes.extend_from_slice(&event.actor_id.0);
    bytes.extend_from_slice(&event.device_id.0);
    bytes.extend_from_slice(&event.timestamp.to_le_bytes());
    bytes.extend_from_slice(&event.logical_time.to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&payload);
    decode_event(&bytes, PROTOCOL_VERSION)?;
    Ok(bytes)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventMetadata {
    pub event_id: EventId,
    pub household_id: HouseholdId,
    pub actor_id: ActorId,
    pub device_id: DeviceId,
    pub timestamp: i64,
    pub logical_time: u64,
    pub event_version: u16,
    pub kind: u16,
}

pub fn metadata(bytes: &[u8]) -> Result<EventMetadata, KinError> {
    let event = decode_event(bytes, PROTOCOL_VERSION)?;
    Ok(EventMetadata {
        event_id: event.event_id,
        household_id: event.household_id,
        actor_id: event.actor_id,
        device_id: event.device_id,
        timestamp: event.timestamp,
        logical_time: event.logical_time,
        event_version: event.event_version,
        kind: kind_code(&event.kind),
    })
}

pub fn encode_metadata(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    let m = metadata(bytes)?;
    let mut output = Vec::with_capacity(92);
    output.extend_from_slice(b"KMET\x01\0\0\0");
    output.extend_from_slice(&m.event_id.0);
    output.extend_from_slice(&m.household_id.0);
    output.extend_from_slice(&m.actor_id.0);
    output.extend_from_slice(&m.device_id.0);
    output.extend_from_slice(&m.timestamp.to_le_bytes());
    output.extend_from_slice(&m.logical_time.to_le_bytes());
    output.extend_from_slice(&m.event_version.to_le_bytes());
    output.extend_from_slice(&m.kind.to_le_bytes());
    Ok(output)
}

/// A complete batch is validated before returning metadata. Each source record
/// remains authoritative; there is no partial result for a corrupt row.
pub fn encode_metadata_batch(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    use crate::protocol::{MAX_EVENT_COUNT, MAX_PROTOCOL_BYTES};
    if bytes.len() < 12 || bytes.len() > MAX_PROTOCOL_BYTES || &bytes[..4] != b"KMDQ" {
        return Err(KinError::MalformedProtocol);
    }
    if bytes[4..6] != [1, 0] {
        return Err(KinError::UnsupportedVersion);
    }
    if bytes[6..8] != [0; 2] {
        return Err(KinError::MalformedProtocol);
    }
    let count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if count > MAX_EVENT_COUNT {
        return Err(KinError::SizeLimit);
    }
    let mut output = Vec::with_capacity(12 + 92 * count);
    output.extend_from_slice(b"KMDL\x01\0\0\0");
    output.extend_from_slice(&(count as u32).to_le_bytes());
    let mut offset = 12usize;
    for _ in 0..count {
        let length_bytes = bytes
            .get(offset..offset + 4)
            .ok_or(KinError::MalformedProtocol)?;
        let length = u32::from_le_bytes(length_bytes.try_into().unwrap()) as usize;
        offset += 4;
        let end = offset
            .checked_add(length)
            .ok_or(KinError::MalformedProtocol)?;
        output.extend_from_slice(&encode_metadata(
            bytes.get(offset..end).ok_or(KinError::MalformedProtocol)?,
        )?);
        offset = end;
    }
    if offset != bytes.len() {
        return Err(KinError::MalformedProtocol);
    }
    Ok(output)
}
