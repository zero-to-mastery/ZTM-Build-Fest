use crate::error::KinError;
use crate::event::{
    valid_timestamp, ActorId, DeviceId, EventEnvelope, EventId, EventKind, HandoffId, HouseholdId,
    IdentityBinding, ItemClassification, ItemId, PulseValue, RoutineId, TalkId,
};
use crate::recurrence::{Cadence, CivilDate};
use crate::state::{
    CatchUpSummary, HandoffStatus, HouseholdState, ItemStatus, PulseStatus, SummaryEntityKind,
    SummaryKind, TalkStatus, MAX_SUMMARY_ENTRIES,
};

pub const PROTOCOL_V1: u16 = 1;
pub const PROTOCOL_V2: u16 = 2;
pub const PROTOCOL_V3: u16 = 3;
pub const PROTOCOL_V4: u16 = 4;
pub const PROTOCOL_V5: u16 = 5;
pub const PROTOCOL_V6: u16 = 6;
pub const PROTOCOL_V7: u16 = 7;
pub const PROTOCOL_V8: u16 = 8;
pub const PROTOCOL_VERSION: u16 = PROTOCOL_V8;
pub const ERROR_PROTOCOL_VERSION: u16 = PROTOCOL_V1;
pub const MAX_EVENT_COUNT: usize = 10_000;
pub const MAX_PROTOCOL_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_ITEM_TEXT_BYTES: usize = 4096;
const REQUEST_HEADER_BYTES: usize = 12;
const EVENT_HEADER_BYTES: usize = 88;
const RESULT_HEADER_BYTES: usize = 12;
const ITEM_HEADER_BYTES: usize = 48;
const V6_REQUEST_HEADER_BYTES: usize = 40;
const V6_RESULT_HEADER_BYTES: usize = 52;
const SUMMARY_HEADER_BYTES: usize = 24;
const V8_REQUEST_HEADER_BYTES: usize = 64;
const V8_BINDING_BYTES: usize = 96;
const MAX_IDENTITY_BINDINGS: usize = 256;

pub fn decode_request(bytes: &[u8]) -> Result<(u16, Vec<EventEnvelope>, Option<i64>), KinError> {
    let request = decode_request_with_summary(bytes)?;
    Ok((request.protocol_version, request.events, request.as_of))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodedRequest {
    pub protocol_version: u16,
    pub events: Vec<EventEnvelope>,
    pub as_of: Option<i64>,
    pub summary_cursor: Option<EventId>,
    pub civil_date: Option<CivilDate>,
    pub target_household_id: Option<HouseholdId>,
    pub identity_bindings: Vec<IdentityBinding>,
}

pub fn decode_request_with_summary(bytes: &[u8]) -> Result<DecodedRequest, KinError> {
    if bytes.len() > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    if bytes.len() < REQUEST_HEADER_BYTES || &bytes[..4] != b"KINE" {
        return Err(KinError::MalformedProtocol);
    }

    let version = read_u16(bytes, 4)?;
    if !matches!(
        version,
        PROTOCOL_V1
            | PROTOCOL_V2
            | PROTOCOL_V3
            | PROTOCOL_V4
            | PROTOCOL_V5
            | PROTOCOL_V6
            | PROTOCOL_V7
            | PROTOCOL_V8
    ) {
        return Err(KinError::UnsupportedVersion);
    }
    if read_u16(bytes, 6)? != 0 {
        return Err(KinError::MalformedProtocol);
    }
    let event_count = read_u32(bytes, 8)? as usize;
    if event_count > MAX_EVENT_COUNT {
        return Err(KinError::SizeLimit);
    }

    let as_of = if version >= PROTOCOL_V5 {
        let value = read_i64(bytes, 12)?;
        if !valid_timestamp(value) {
            return Err(KinError::MalformedProtocol);
        }
        Some(value)
    } else {
        None
    };
    let summary_cursor = if version >= PROTOCOL_V6 {
        let cursor_present = *bytes.get(20).ok_or(KinError::MalformedProtocol)?;
        if !bytes
            .get(21..24)
            .is_some_and(|reserved| reserved.iter().all(|value| *value == 0))
        {
            return Err(KinError::MalformedProtocol);
        }
        let cursor_id = read_id(bytes, 24)?;
        match cursor_present {
            0 if cursor_id == [0; 16] => None,
            0 => return Err(KinError::MalformedProtocol),
            1 => Some(EventId(cursor_id)),
            _ => return Err(KinError::MalformedProtocol),
        }
    } else {
        None
    };
    let civil_date = if version >= PROTOCOL_V7 {
        Some(CivilDate::from_encoded(read_u32(bytes, 40)?)?)
    } else {
        None
    };
    let (target_household_id, identity_bindings) = if version == PROTOCOL_V8 {
        let target = HouseholdId(read_id(bytes, 44)?);
        let binding_count = read_u16(bytes, 60)? as usize;
        if binding_count > MAX_IDENTITY_BINDINGS || read_u16(bytes, 62)? != 0 {
            return Err(if binding_count > MAX_IDENTITY_BINDINGS {
                KinError::SizeLimit
            } else {
                KinError::MalformedProtocol
            });
        }
        let mut bindings = Vec::new();
        bindings
            .try_reserve_exact(binding_count)
            .map_err(|_| KinError::SizeLimit)?;
        let mut offset = V8_REQUEST_HEADER_BYTES;
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..binding_count {
            let record = bytes
                .get(offset..offset + V8_BINDING_BYTES)
                .ok_or(KinError::MalformedProtocol)?;
            let binding = IdentityBinding {
                legacy_household_id: HouseholdId(read_id(record, 0)?),
                legacy_actor_id: ActorId(read_id(record, 16)?),
                legacy_device_id: DeviceId(read_id(record, 32)?),
                household_id: HouseholdId(read_id(record, 48)?),
                actor_id: ActorId(read_id(record, 64)?),
                device_id: DeviceId(read_id(record, 80)?),
            };
            let key = (
                binding.legacy_household_id,
                binding.legacy_actor_id,
                binding.legacy_device_id,
            );
            if binding.household_id != target || !seen.insert(key) {
                return Err(KinError::InvalidEvent);
            }
            bindings.push(binding);
            offset += V8_BINDING_BYTES;
        }
        (Some(target), bindings)
    } else {
        (None, Vec::new())
    };
    let mut events = Vec::new();
    events
        .try_reserve_exact(event_count)
        .map_err(|_| KinError::SizeLimit)?;
    let mut offset = match version {
        PROTOCOL_V8 => V8_REQUEST_HEADER_BYTES + identity_bindings.len() * V8_BINDING_BYTES,
        PROTOCOL_V7 => 44,
        PROTOCOL_V6 => V6_REQUEST_HEADER_BYTES,
        PROTOCOL_V5 => 20,
        _ => REQUEST_HEADER_BYTES,
    };
    for _ in 0..event_count {
        let header_end = offset
            .checked_add(EVENT_HEADER_BYTES)
            .ok_or(KinError::MalformedProtocol)?;
        let header = bytes
            .get(offset..header_end)
            .ok_or(KinError::MalformedProtocol)?;
        let payload_length = read_u32(header, 84)? as usize;
        let record_end = header_end
            .checked_add(payload_length)
            .ok_or(KinError::MalformedProtocol)?;
        let record = bytes
            .get(offset..record_end)
            .ok_or(KinError::MalformedProtocol)?;
        let mut event = decode_event(record, version)?;
        if let Some(target_household_id) = target_household_id {
            if let Some(binding) = identity_bindings.iter().find(|binding| {
                binding.legacy_household_id == event.household_id
                    && binding.legacy_actor_id == event.actor_id
                    && binding.legacy_device_id == event.device_id
            }) {
                // Normalize replay identity only; canonical_bytes retain the signed source event.
                event.household_id = binding.household_id;
                event.actor_id = binding.actor_id;
                event.device_id = binding.device_id;
            } else if event.household_id != target_household_id {
                return Err(KinError::InvalidEvent);
            }
        }
        events.push(event);
        offset = record_end;
    }
    if offset != bytes.len() {
        return Err(KinError::MalformedProtocol);
    }
    Ok(DecodedRequest {
        protocol_version: version,
        events,
        as_of,
        summary_cursor,
        civil_date,
        target_household_id,
        identity_bindings,
    })
}

pub fn encode_state(state: &HouseholdState, protocol_version: u16) -> Result<Vec<u8>, KinError> {
    if !state.routines.is_empty() {
        return Err(KinError::UnsupportedVersion);
    }
    encode_legacy_entities(state, protocol_version)
}

fn encode_legacy_entities(
    state: &HouseholdState,
    protocol_version: u16,
) -> Result<Vec<u8>, KinError> {
    if !matches!(
        protocol_version,
        PROTOCOL_V1 | PROTOCOL_V2 | PROTOCOL_V3 | PROTOCOL_V4 | PROTOCOL_V5
    ) {
        return Err(KinError::UnsupportedVersion);
    }
    if protocol_version < PROTOCOL_V3 && !state.handoffs.is_empty() {
        return Err(KinError::UnsupportedVersion);
    }
    if protocol_version < PROTOCOL_V4 && !state.talks.is_empty() {
        return Err(KinError::UnsupportedVersion);
    }
    if protocol_version < PROTOCOL_V5 && !state.pulses.is_empty() {
        return Err(KinError::UnsupportedVersion);
    }
    if state
        .items
        .len()
        .saturating_add(state.handoffs.len())
        .saturating_add(state.talks.len())
        .saturating_add(state.pulses.len())
        .saturating_add(state.routines.len())
        > MAX_EVENT_COUNT
    {
        return Err(KinError::SizeLimit);
    }
    let item_count = u32::try_from(state.items.len()).map_err(|_| KinError::SizeLimit)?;
    let mut result = Vec::new();
    result
        .try_reserve_exact(RESULT_HEADER_BYTES)
        .map_err(|_| KinError::SizeLimit)?;
    result.extend_from_slice(b"KINS");
    push_u16(&mut result, protocol_version);
    push_u16(&mut result, 0);
    push_u32(&mut result, item_count);
    if protocol_version >= PROTOCOL_V3 {
        push_u32(&mut result, state.handoffs.len() as u32);
    }
    if protocol_version >= PROTOCOL_V4 {
        push_u32(&mut result, state.talks.len() as u32);
    }

    if protocol_version >= PROTOCOL_V5 {
        push_u32(&mut result, state.pulses.len() as u32);
    }

    for item in &state.items {
        let text_bytes = item.text.as_bytes();
        let text_length = u32::try_from(text_bytes.len()).map_err(|_| KinError::SizeLimit)?;
        let expected_length = result
            .len()
            .checked_add(ITEM_HEADER_BYTES)
            .and_then(|length| length.checked_add(text_bytes.len()))
            .ok_or(KinError::SizeLimit)?;
        if expected_length > MAX_PROTOCOL_BYTES {
            return Err(KinError::SizeLimit);
        }
        result
            .try_reserve(expected_length - result.len())
            .map_err(|_| KinError::SizeLimit)?;
        result.extend_from_slice(&item.item_id.0);
        result.extend_from_slice(&item.created_by.0);
        result.extend_from_slice(&item.created_at.to_le_bytes());
        if protocol_version == PROTOCOL_V1 {
            if item.classification != ItemClassification::Today
                || item.status == ItemStatus::Archived
            {
                return Err(KinError::UnsupportedVersion);
            }
            result.push(match item.status {
                ItemStatus::Active => 0,
                ItemStatus::Completed => 1,
                ItemStatus::Archived => unreachable!(),
            });
            result.extend_from_slice(&[0; 3]);
        } else {
            result.push(match item.classification {
                ItemClassification::Today => 0,
                ItemClassification::Need => 1,
            });
            result.push(match item.status {
                ItemStatus::Active => 0,
                ItemStatus::Completed => 1,
                ItemStatus::Archived => 2,
            });
            result.extend_from_slice(&[0; 2]);
        }
        push_u32(&mut result, text_length);
        result.extend_from_slice(text_bytes);
    }
    for handoff in &state.handoffs {
        let text = handoff.text.as_bytes();
        let additional = ITEM_HEADER_BYTES
            .checked_add(text.len())
            .ok_or(KinError::SizeLimit)?;
        if result
            .len()
            .checked_add(additional)
            .ok_or(KinError::SizeLimit)?
            > MAX_PROTOCOL_BYTES
        {
            return Err(KinError::SizeLimit);
        }
        result
            .try_reserve(additional)
            .map_err(|_| KinError::SizeLimit)?;
        result.extend_from_slice(&handoff.handoff_id.0);
        result.extend_from_slice(&handoff.created_by.0);
        result.extend_from_slice(&handoff.created_at.to_le_bytes());
        result.push(match handoff.status {
            HandoffStatus::Unacknowledged => 0,
            HandoffStatus::Acknowledged => 1,
            HandoffStatus::Archived => 2,
        });
        result.extend_from_slice(&[0; 3]);
        push_u32(&mut result, text.len() as u32);
        result.extend_from_slice(text);
    }
    for talk in &state.talks {
        let text = talk.text.as_bytes();
        let additional = ITEM_HEADER_BYTES
            .checked_add(text.len())
            .ok_or(KinError::SizeLimit)?;
        if result
            .len()
            .checked_add(additional)
            .ok_or(KinError::SizeLimit)?
            > MAX_PROTOCOL_BYTES
        {
            return Err(KinError::SizeLimit);
        }
        result
            .try_reserve(additional)
            .map_err(|_| KinError::SizeLimit)?;
        result.extend_from_slice(&talk.talk_id.0);
        result.extend_from_slice(&talk.created_by.0);
        result.extend_from_slice(&talk.created_at.to_le_bytes());
        result.push(match talk.status {
            TalkStatus::Open => 0,
            TalkStatus::Resolved => 1,
            TalkStatus::Archived => 2,
        });
        result.extend_from_slice(&[0; 3]);
        push_u32(&mut result, text.len() as u32);
        result.extend_from_slice(text);
    }
    for pulse in &state.pulses {
        if result.len().checked_add(40).ok_or(KinError::SizeLimit)? > MAX_PROTOCOL_BYTES {
            return Err(KinError::SizeLimit);
        }
        result.try_reserve(40).map_err(|_| KinError::SizeLimit)?;
        result.extend_from_slice(&pulse.actor_id.0);
        result.extend_from_slice(&pulse.set_at.to_le_bytes());
        result.extend_from_slice(&pulse.expires_at.to_le_bytes());
        result.push(pulse.value as u8);
        result.push(match pulse.status {
            PulseStatus::Active => 0,
            PulseStatus::Expired => 1,
        });
        result.extend_from_slice(&[0; 6]);
    }
    Ok(result)
}

pub fn encode_state_v6(
    state: &HouseholdState,
    summary: &CatchUpSummary,
) -> Result<Vec<u8>, KinError> {
    encode_state_with_summary(state, summary, PROTOCOL_V6)
}

pub fn encode_state_v7(
    state: &HouseholdState,
    summary: &CatchUpSummary,
) -> Result<Vec<u8>, KinError> {
    encode_state_with_summary(state, summary, PROTOCOL_V7)
}

pub fn encode_state_v8(
    state: &HouseholdState,
    summary: &CatchUpSummary,
) -> Result<Vec<u8>, KinError> {
    encode_state_with_summary(state, summary, PROTOCOL_V8)
}

fn encode_state_with_summary(
    state: &HouseholdState,
    summary: &CatchUpSummary,
    version: u16,
) -> Result<Vec<u8>, KinError> {
    if version == PROTOCOL_V6
        && (!state.routines.is_empty() || summary.entries.iter().any(|entry| entry.kind as u8 > 11))
    {
        return Err(KinError::UnsupportedVersion);
    }
    let previous = encode_legacy_entities(state, PROTOCOL_V5)?;
    let mut routine_bytes = Vec::new();
    for routine in &state.routines {
        if routine.text.is_empty()
            || routine.text.len() > MAX_ITEM_TEXT_BYTES
            || !valid_timestamp(routine.created_at)
            || (routine.archived && routine.occurrence_key.is_some())
            || (routine.completed && routine.occurrence_key.is_none())
        {
            return Err(KinError::MalformedProtocol);
        }
        if let Some(key) = routine.occurrence_key {
            routine.cadence.validate_key(routine.created_on, key)?;
        }
        let length = routine_bytes
            .len()
            .checked_add(56 + routine.text.len())
            .ok_or(KinError::SizeLimit)?;
        if length > MAX_PROTOCOL_BYTES {
            return Err(KinError::SizeLimit);
        }
        routine_bytes
            .try_reserve(56 + routine.text.len())
            .map_err(|_| KinError::SizeLimit)?;
        routine_bytes.extend_from_slice(&routine.routine_id.0);
        routine_bytes.extend_from_slice(&routine.created_by.0);
        routine_bytes.extend_from_slice(&routine.created_at.to_le_bytes());
        push_u32(&mut routine_bytes, routine.created_on.encoded());
        push_u32(
            &mut routine_bytes,
            routine.occurrence_key.map_or(0, CivilDate::encoded),
        );
        routine_bytes.push(routine.cadence as u8);
        routine_bytes.push(u8::from(routine.archived));
        routine_bytes.push(if routine.occurrence_key.is_none() {
            0
        } else if routine.completed {
            2
        } else {
            1
        });
        routine_bytes.push(0);
        push_u32(&mut routine_bytes, routine.text.len() as u32);
        routine_bytes.extend_from_slice(routine.text.as_bytes());
    }
    let summary_count = summary.entries.len();
    if summary_count > MAX_SUMMARY_ENTRIES
        || summary_count > summary.total_count as usize
        || summary.total_count as usize > MAX_EVENT_COUNT
        || (summary.total_count > 0 && summary.through_event_id.is_none())
    {
        return Err(KinError::MalformedProtocol);
    }

    let mut summary_bytes = 0usize;
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
            || (entry.kind == SummaryKind::ItemAdded) != entry.classification.is_some()
            || entry.text.is_empty()
            || entry.text.len() > MAX_ITEM_TEXT_BYTES
        {
            return Err(KinError::MalformedProtocol);
        }
        summary_bytes = summary_bytes
            .checked_add(SUMMARY_HEADER_BYTES)
            .and_then(|length| length.checked_add(entry.text.len()))
            .ok_or(KinError::SizeLimit)?;
    }

    let entity_bytes = previous.len().checked_sub(24).ok_or(KinError::Internal)?;
    let result_length = V6_RESULT_HEADER_BYTES
        .checked_add(entity_bytes)
        .and_then(|length| {
            length.checked_add(if version >= PROTOCOL_V7 {
                4 + routine_bytes.len()
            } else {
                0
            })
        })
        .and_then(|length| length.checked_add(summary_bytes))
        .ok_or(KinError::SizeLimit)?;
    if result_length > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }

    let mut result = Vec::new();
    result
        .try_reserve_exact(result_length)
        .map_err(|_| KinError::SizeLimit)?;
    result.extend_from_slice(b"KINS");
    push_u16(&mut result, version);
    push_u16(&mut result, 0);
    result.extend_from_slice(&previous[8..24]);
    push_u32(&mut result, summary_count as u32);
    push_u32(&mut result, summary.total_count);
    match summary.through_event_id {
        Some(event_id) => {
            result.push(1);
            result.extend_from_slice(&[0; 3]);
            result.extend_from_slice(&event_id.0);
        }
        None => {
            result.push(0);
            result.extend_from_slice(&[0; 3]);
            result.extend_from_slice(&[0; 16]);
        }
    }
    if version >= PROTOCOL_V7 {
        push_u32(&mut result, state.routines.len() as u32);
    }
    result.extend_from_slice(&previous[24..]);
    result.extend_from_slice(&routine_bytes);

    for entry in &summary.entries {
        result.extend_from_slice(&entry.event_id.0);
        result.push(entry.kind as u8);
        result.push(entry.entity_kind as u8);
        result.push(match entry.classification {
            Some(ItemClassification::Today) => 0,
            Some(ItemClassification::Need) => 1,
            None => u8::MAX,
        });
        result.push(0);
        push_u32(&mut result, entry.text.len() as u32);
        result.extend_from_slice(entry.text.as_bytes());
    }
    Ok(result)
}

pub fn decode_event(record: &[u8], protocol_version: u16) -> Result<EventEnvelope, KinError> {
    if !(PROTOCOL_V1..=PROTOCOL_V8).contains(&protocol_version) {
        return Err(KinError::UnsupportedVersion);
    }
    if record.len() > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    if record.len() < EVENT_HEADER_BYTES {
        return Err(KinError::MalformedProtocol);
    }
    let event_version = read_u16(record, 0)?;
    if !(event_version == 1 || (event_version == 2 && protocol_version >= PROTOCOL_V2)) {
        return Err(KinError::UnsupportedVersion);
    }
    let event_kind = read_u16(record, 2)?;
    let payload_length = read_u32(record, 84)? as usize;
    let expected_length = EVENT_HEADER_BYTES
        .checked_add(payload_length)
        .ok_or(KinError::MalformedProtocol)?;
    if record.len() != expected_length {
        return Err(KinError::MalformedProtocol);
    }

    let payload = &record[EVENT_HEADER_BYTES..];
    let kind = match (event_version, event_kind) {
        (1, 14) if protocol_version >= PROTOCOL_V7 => {
            if payload.len() < 28
                || payload[17..20] != [0; 3]
                || !valid_timestamp(read_i64(record, 68)?)
            {
                return Err(KinError::MalformedProtocol);
            }
            let length = read_u32(payload, 24)? as usize;
            if !(1..=MAX_ITEM_TEXT_BYTES).contains(&length) || payload.len() != 28 + length {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::RoutineCreated {
                routine_id: RoutineId(read_id(payload, 0)?),
                cadence: Cadence::try_from(payload[16])?,
                created_on: CivilDate::from_encoded(read_u32(payload, 20)?)?,
                text: std::str::from_utf8(&payload[28..])
                    .map_err(|_| KinError::MalformedProtocol)?
                    .to_owned(),
            }
        }
        (1, 15..=17) if protocol_version >= PROTOCOL_V7 => {
            if payload.len() != if event_kind == 17 { 16 } else { 20 }
                || !valid_timestamp(read_i64(record, 68)?)
            {
                return Err(KinError::MalformedProtocol);
            }
            let routine_id = RoutineId(read_id(payload, 0)?);
            if event_kind == 17 {
                EventKind::RoutineArchived { routine_id }
            } else {
                let key = CivilDate::from_encoded(read_u32(payload, 16)?)?;
                if event_kind == 15 {
                    EventKind::RoutineOccurrenceCompleted { routine_id, key }
                } else {
                    EventKind::RoutineOccurrenceReopened { routine_id, key }
                }
            }
        }
        (1, 12) if protocol_version >= PROTOCOL_V5 => {
            if payload.len() != 16 || payload[1..8] != [0; 7] {
                return Err(KinError::MalformedProtocol);
            }
            let value = match payload[0] {
                0 => PulseValue::Good,
                1 => PulseValue::Okay,
                2 => PulseValue::Drained,
                3 => PulseValue::RoughDay,
                4 => PulseValue::NeedQuiet,
                _ => return Err(KinError::MalformedProtocol),
            };
            let expires_at = read_i64(payload, 8)?;
            if !valid_timestamp(expires_at) || !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::PulseSet { value, expires_at }
        }
        (1, 13) if protocol_version >= PROTOCOL_V5 => {
            if !payload.is_empty() || !valid_timestamp(read_i64(record, 68)?) {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::PulseCleared
        }
        (1, 1) => {
            if payload.len() < 20 {
                return Err(KinError::MalformedProtocol);
            }
            let text_length = read_u32(payload, 16)? as usize;
            if !(1..=MAX_ITEM_TEXT_BYTES).contains(&text_length)
                || payload.len()
                    != 20usize
                        .checked_add(text_length)
                        .ok_or(KinError::MalformedProtocol)?
            {
                return Err(KinError::MalformedProtocol);
            }
            let decoded_text =
                std::str::from_utf8(&payload[20..]).map_err(|_| KinError::MalformedProtocol)?;
            let mut text = String::new();
            text.try_reserve_exact(text_length)
                .map_err(|_| KinError::SizeLimit)?;
            text.push_str(decoded_text);
            EventKind::ItemAdded {
                item_id: ItemId(read_id(payload, 0)?),
                text,
                classification: ItemClassification::Today,
            }
        }
        (2, 1) => {
            if protocol_version < PROTOCOL_V2 || payload.len() < 24 {
                return Err(KinError::MalformedProtocol);
            }
            let classification = match payload[16] {
                0 => ItemClassification::Today,
                1 => ItemClassification::Need,
                _ => return Err(KinError::MalformedProtocol),
            };
            if payload[17..20] != [0; 3] {
                return Err(KinError::MalformedProtocol);
            }
            let text_length = read_u32(payload, 20)? as usize;
            if !(1..=MAX_ITEM_TEXT_BYTES).contains(&text_length)
                || payload.len()
                    != 24usize
                        .checked_add(text_length)
                        .ok_or(KinError::MalformedProtocol)?
            {
                return Err(KinError::MalformedProtocol);
            }
            let decoded_text =
                std::str::from_utf8(&payload[24..]).map_err(|_| KinError::MalformedProtocol)?;
            let mut text = String::new();
            text.try_reserve_exact(text_length)
                .map_err(|_| KinError::SizeLimit)?;
            text.push_str(decoded_text);
            EventKind::ItemAdded {
                item_id: ItemId(read_id(payload, 0)?),
                text,
                classification,
            }
        }
        (1, 2) => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ItemCompleted {
                item_id: ItemId(read_id(payload, 0)?),
            }
        }
        (1, 3) if protocol_version >= PROTOCOL_V2 => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ItemReopened {
                item_id: ItemId(read_id(payload, 0)?),
            }
        }
        (1, 4) if protocol_version >= PROTOCOL_V2 => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::ItemArchived {
                item_id: ItemId(read_id(payload, 0)?),
            }
        }
        (1, 5) if protocol_version >= PROTOCOL_V3 => {
            if payload.len() < 20 {
                return Err(KinError::MalformedProtocol);
            }
            let length = read_u32(payload, 16)? as usize;
            if !(1..=MAX_ITEM_TEXT_BYTES).contains(&length)
                || payload.len()
                    != 20usize
                        .checked_add(length)
                        .ok_or(KinError::MalformedProtocol)?
            {
                return Err(KinError::MalformedProtocol);
            }
            let text =
                std::str::from_utf8(&payload[20..]).map_err(|_| KinError::MalformedProtocol)?;
            EventKind::HandoffAdded {
                handoff_id: HandoffId(read_id(payload, 0)?),
                text: text.to_owned(),
            }
        }
        (1, 6 | 7) if protocol_version >= PROTOCOL_V3 => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            let handoff_id = HandoffId(read_id(payload, 0)?);
            if event_kind == 6 {
                EventKind::HandoffAcknowledged { handoff_id }
            } else {
                EventKind::HandoffArchived { handoff_id }
            }
        }
        (1, 8) if protocol_version >= PROTOCOL_V4 => {
            if payload.len() < 20 {
                return Err(KinError::MalformedProtocol);
            }
            let length = read_u32(payload, 16)? as usize;
            if !(1..=MAX_ITEM_TEXT_BYTES).contains(&length)
                || payload.len()
                    != 20usize
                        .checked_add(length)
                        .ok_or(KinError::MalformedProtocol)?
            {
                return Err(KinError::MalformedProtocol);
            }
            let text =
                std::str::from_utf8(&payload[20..]).map_err(|_| KinError::MalformedProtocol)?;
            EventKind::TalkAdded {
                talk_id: TalkId(read_id(payload, 0)?),
                text: text.to_owned(),
            }
        }
        (1, 9..=11) if protocol_version >= PROTOCOL_V4 => {
            if payload.len() != 16 {
                return Err(KinError::MalformedProtocol);
            }
            let talk_id = TalkId(read_id(payload, 0)?);
            if event_kind == 9 {
                EventKind::TalkResolved { talk_id }
            } else if event_kind == 10 {
                EventKind::TalkReopened { talk_id }
            } else {
                EventKind::TalkArchived { talk_id }
            }
        }
        _ => return Err(KinError::UnsupportedVersion),
    };

    let mut canonical_bytes = Vec::new();
    canonical_bytes
        .try_reserve_exact(record.len())
        .map_err(|_| KinError::SizeLimit)?;
    canonical_bytes.extend_from_slice(record);
    Ok(EventEnvelope {
        event_id: EventId(read_id(record, 4)?),
        household_id: HouseholdId(read_id(record, 20)?),
        actor_id: ActorId(read_id(record, 36)?),
        device_id: DeviceId(read_id(record, 52)?),
        timestamp: read_i64(record, 68)?,
        logical_time: read_u64(record, 76)?,
        event_version,
        kind,
        canonical_bytes,
    })
}

fn read_id(bytes: &[u8], offset: usize) -> Result<[u8; 16], KinError> {
    let id_bytes = bytes
        .get(offset..offset + 16)
        .ok_or(KinError::MalformedProtocol)?;
    let mut id = [0; 16];
    id.copy_from_slice(id_bytes);
    Ok(id)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, KinError> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or(KinError::MalformedProtocol)?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, KinError> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or(KinError::MalformedProtocol)?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, KinError> {
    let value = bytes
        .get(offset..offset + 8)
        .ok_or(KinError::MalformedProtocol)?;
    Ok(u64::from_le_bytes(
        value.try_into().map_err(|_| KinError::MalformedProtocol)?,
    ))
}

fn read_i64(bytes: &[u8], offset: usize) -> Result<i64, KinError> {
    let value = bytes
        .get(offset..offset + 8)
        .ok_or(KinError::MalformedProtocol)?;
    Ok(i64::from_le_bytes(
        value.try_into().map_err(|_| KinError::MalformedProtocol)?,
    ))
}

fn push_u16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{rebuild, rebuild_at, summarize, summarize_validated};

    fn request_with(record: &[u8], version: u16, count: u32) -> Vec<u8> {
        let mut bytes = b"KINE".to_vec();
        bytes.extend_from_slice(&version.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&count.to_le_bytes());
        if version == PROTOCOL_V5 || version == PROTOCOL_V6 {
            bytes.extend_from_slice(&0i64.to_le_bytes());
        }
        if version == PROTOCOL_V6 {
            bytes.push(0);
            bytes.extend_from_slice(&[0; 3]);
            bytes.extend_from_slice(&[0; 16]);
        }
        bytes.extend_from_slice(record);
        bytes
    }

    fn added_record(text: &[u8]) -> Vec<u8> {
        let mut payload = vec![0x11; 16];
        payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
        payload.extend_from_slice(text);
        let mut record = Vec::new();
        record.extend_from_slice(&1u16.to_le_bytes());
        record.extend_from_slice(&1u16.to_le_bytes());
        record.extend_from_slice(&[1; 16]);
        record.extend_from_slice(&[0xaa; 16]);
        record.extend_from_slice(&[0xbb; 16]);
        record.extend_from_slice(&[0xcc; 16]);
        record.extend_from_slice(&1i64.to_le_bytes());
        record.extend_from_slice(&1u64.to_le_bytes());
        record.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        record.extend_from_slice(&payload);
        record
    }

    fn numbered_id(value: u32) -> [u8; 16] {
        let mut id = [0; 16];
        id[..4].copy_from_slice(&value.to_le_bytes());
        id
    }

    fn added_record_v2(
        event_number: u32,
        item_number: u32,
        text: &[u8],
        classification: u8,
    ) -> Vec<u8> {
        let mut payload = numbered_id(item_number).to_vec();
        payload.push(classification);
        payload.extend_from_slice(&[0; 3]);
        payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
        payload.extend_from_slice(text);
        let mut record = Vec::new();
        record.extend_from_slice(&2u16.to_le_bytes());
        record.extend_from_slice(&1u16.to_le_bytes());
        record.extend_from_slice(&numbered_id(event_number));
        record.extend_from_slice(&[0xaa; 16]);
        record.extend_from_slice(&[0xbb; 16]);
        record.extend_from_slice(&[0xcc; 16]);
        record.extend_from_slice(&i64::from(event_number).to_le_bytes());
        record.extend_from_slice(&u64::from(event_number).to_le_bytes());
        record.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        record.extend_from_slice(&payload);
        record
    }

    fn distributed_record(
        event_number: u32,
        item_number: u32,
        text: &[u8],
        legacy_household: u8,
        legacy_actor: u8,
        legacy_device: u8,
        logical_time: u64,
    ) -> Vec<u8> {
        let mut record = added_record_v2(event_number, item_number, text, 1);
        record[20..36].fill(legacy_household);
        record[36..52].fill(legacy_actor);
        record[52..68].fill(legacy_device);
        record[76..84].copy_from_slice(&logical_time.to_le_bytes());
        record
    }

    fn distributed_item_action(
        event_number: u32,
        kind: u16,
        item_number: u32,
        legacy_household: u8,
        legacy_actor: u8,
        legacy_device: u8,
        logical_time: u64,
    ) -> Vec<u8> {
        let mut record = vec![0; 104];
        record[..2].copy_from_slice(&1u16.to_le_bytes());
        record[2..4].copy_from_slice(&kind.to_le_bytes());
        record[4..20].copy_from_slice(&numbered_id(event_number));
        record[20..36].fill(legacy_household);
        record[36..52].fill(legacy_actor);
        record[52..68].fill(legacy_device);
        record[68..76].copy_from_slice(&1i64.to_le_bytes());
        record[76..84].copy_from_slice(&logical_time.to_le_bytes());
        record[84..88].copy_from_slice(&16u32.to_le_bytes());
        record[88..104].copy_from_slice(&numbered_id(item_number));
        record
    }

    fn distributed_request(records: &[Vec<u8>], bindings: &[IdentityBinding]) -> Vec<u8> {
        let mut bytes = b"KINE".to_vec();
        bytes.extend_from_slice(&PROTOCOL_V8.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&(records.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&0i64.to_le_bytes());
        bytes.extend_from_slice(&[0; 4]);
        bytes.extend_from_slice(&[0; 16]);
        bytes.extend_from_slice(&20261002u32.to_le_bytes());
        bytes.extend_from_slice(&[0x99; 16]);
        bytes.extend_from_slice(&(bindings.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        for binding in bindings {
            bytes.extend_from_slice(&binding.legacy_household_id.0);
            bytes.extend_from_slice(&binding.legacy_actor_id.0);
            bytes.extend_from_slice(&binding.legacy_device_id.0);
            bytes.extend_from_slice(&binding.household_id.0);
            bytes.extend_from_slice(&binding.actor_id.0);
            bytes.extend_from_slice(&binding.device_id.0);
        }
        for record in records {
            bytes.extend_from_slice(record);
        }
        bytes
    }

    fn identity_binding(
        household: u8,
        actor: u8,
        device: u8,
        member: u8,
        target_device: u8,
    ) -> IdentityBinding {
        IdentityBinding {
            legacy_household_id: HouseholdId([household; 16]),
            legacy_actor_id: ActorId([actor; 16]),
            legacy_device_id: DeviceId([device; 16]),
            household_id: HouseholdId([0x99; 16]),
            actor_id: ActorId([member; 16]),
            device_id: DeviceId([target_device; 16]),
        }
    }

    #[test]
    fn empty_request_rebuilds_empty_state() {
        for version in [PROTOCOL_V1, PROTOCOL_V2] {
            let request = request_with(&[], version, 0);
            let (protocol_version, events, _) = decode_request(&request).unwrap();
            let result = encode_state(&rebuild(&events).unwrap(), protocol_version).unwrap();
            assert_eq!(
                result,
                [b"KINS".as_slice(), &[version as u8, 0, 0, 0, 0, 0, 0, 0]].concat()
            );
        }
    }

    #[test]
    fn v6_request_and_result_preserve_snapshot_cursor_and_summary_record() {
        let request = request_with(&added_record(b"Milk"), PROTOCOL_V6, 1);
        let decoded = decode_request_with_summary(&request).unwrap();
        assert_eq!(decoded.protocol_version, PROTOCOL_V6);
        assert_eq!(decoded.as_of, Some(0));
        assert_eq!(decoded.summary_cursor, None);

        let state = rebuild_at(&decoded.events, 0).unwrap();
        let summary = summarize(&decoded.events, decoded.summary_cursor).unwrap();
        let result = encode_state_v6(&state, &summary).unwrap();

        assert_eq!(result.len(), 52 + 52 + 28);
        assert_eq!(&result[..4], b"KINS");
        assert_eq!(read_u16(&result, 4), Ok(PROTOCOL_V6));
        assert_eq!(read_u32(&result, 8), Ok(1));
        assert_eq!(read_u32(&result, 12), Ok(0));
        assert_eq!(read_u32(&result, 16), Ok(0));
        assert_eq!(read_u32(&result, 20), Ok(0));
        assert_eq!(read_u32(&result, 24), Ok(1));
        assert_eq!(read_u32(&result, 28), Ok(1));
        assert_eq!(result[32], 1);
        assert_eq!(&result[36..52], &[1; 16]);
        assert_eq!(&result[52 + 52..52 + 68], &[1; 16]);
        assert_eq!(result[52 + 68], SummaryKind::ItemAdded as u8);
        assert_eq!(result[52 + 69], SummaryEntityKind::Item as u8);
        assert_eq!(result[52 + 70], 0);
        assert_eq!(result[52 + 71], 0);
        assert_eq!(read_u32(&result, 52 + 72), Ok(4));
        assert_eq!(&result[52 + 76..], b"Milk");
    }

    #[test]
    fn v6_cursor_excludes_its_event_but_not_the_snapshot_boundary() {
        let mut request = request_with(&added_record(b"Milk"), PROTOCOL_V6, 1);
        request[20] = 1;
        request[24..40].fill(1);
        let decoded = decode_request_with_summary(&request).unwrap();
        let state = rebuild_at(&decoded.events, 0).unwrap();
        let summary = summarize(&decoded.events, decoded.summary_cursor).unwrap();
        let result = encode_state_v6(&state, &summary).unwrap();

        assert_eq!(read_u32(&result, 24), Ok(0));
        assert_eq!(read_u32(&result, 28), Ok(0));
        assert_eq!(result[32], 1);
        assert_eq!(&result[36..52], &[1; 16]);
    }

    #[test]
    fn v8_resolves_signed_identity_context_without_changing_canonical_bytes() {
        let first = distributed_record(3, 3, b"B", 0xdd, 0xee, 0xff, 5);
        let second = distributed_record(2, 2, b"A", 0xaa, 0xbb, 0xcc, 5);
        let bindings = [
            identity_binding(0xaa, 0xbb, 0xcc, 0x11, 0x01),
            identity_binding(0xdd, 0xee, 0xff, 0x22, 0x02),
        ];
        let request = distributed_request(&[first.clone(), second.clone()], &bindings);
        let decoded = decode_request_with_summary(&request).unwrap();
        assert_eq!(decoded.protocol_version, PROTOCOL_V8);
        assert_eq!(decoded.target_household_id, Some(HouseholdId([0x99; 16])));
        assert_eq!(decoded.identity_bindings, bindings);
        assert_eq!(decoded.events[0].event_id, EventId(numbered_id(3)));
        assert_eq!(decoded.events[0].device_id, DeviceId([0x02; 16]));
        assert_eq!(&decoded.events[0].canonical_bytes[20..36], &[0xdd; 16]);
        assert_eq!(decoded.events[1].event_id, EventId(numbered_id(2)));
        assert_eq!(decoded.events[1].device_id, DeviceId([0x01; 16]));

        let state = crate::state::rebuild_distributed_on(
            &decoded.events,
            0,
            CivilDate::from_encoded(20261002).unwrap(),
        )
        .unwrap();
        assert_eq!(state.items[0].item_id.0, numbered_id(2));
        assert_eq!(state.items[1].item_id.0, numbered_id(3));
        let summary = summarize_validated(&decoded.events, None, &state).unwrap();
        assert_eq!(summary.through_event_id, Some(EventId(numbered_id(2))));
        let result = encode_state_v8(&state, &summary).unwrap();
        assert_eq!(read_u16(&result, 4), Ok(PROTOCOL_V8));

        let reversed =
            decode_request_with_summary(&distributed_request(&[second, first], &bindings)).unwrap();
        let reversed_state = crate::state::rebuild_distributed_on(
            &reversed.events,
            0,
            CivilDate::from_encoded(20261002).unwrap(),
        )
        .unwrap();
        assert_eq!(state, reversed_state);
    }

    #[test]
    fn v8_rejects_unbound_legacy_identity_and_malformed_binding_tables() {
        let record = distributed_record(1, 1, b"A", 0xaa, 0xbb, 0xcc, 1);
        assert_eq!(
            decode_request_with_summary(&distributed_request(std::slice::from_ref(&record), &[],)),
            Err(KinError::InvalidEvent)
        );

        let mut truncated_binding =
            distributed_request(&[], &[identity_binding(0xaa, 0xbb, 0xcc, 0x11, 0x01)]);
        truncated_binding.truncate(64 + 95);
        assert_eq!(
            decode_request_with_summary(&truncated_binding),
            Err(KinError::MalformedProtocol)
        );

        let duplicate = identity_binding(0xaa, 0xbb, 0xcc, 0x11, 0x01);
        assert_eq!(
            decode_request_with_summary(&distributed_request(&[], &[duplicate, duplicate],)),
            Err(KinError::InvalidEvent)
        );
    }

    #[test]
    fn v8_terminal_archive_wins_equal_time_concurrent_item_completion() {
        let added = distributed_record(1, 7, b"Task", 0xaa, 0xbb, 0xcc, 5);
        let archived = distributed_item_action(2, 4, 7, 0xaa, 0xbb, 0xcc, 6);
        let completed = distributed_item_action(3, 2, 7, 0xdd, 0xee, 0xff, 6);
        let canonical_completion = completed.clone();
        let bindings = [
            identity_binding(0xaa, 0xbb, 0xcc, 0x11, 0x01),
            identity_binding(0xdd, 0xee, 0xff, 0x22, 0x02),
        ];
        let decoded = decode_request_with_summary(&distributed_request(
            &[completed, archived, added],
            &bindings,
        ))
        .unwrap();
        let state = crate::state::rebuild_distributed_on(
            &decoded.events,
            0,
            CivilDate::from_encoded(20261002).unwrap(),
        )
        .unwrap();
        assert_eq!(state.items[0].status, crate::state::ItemStatus::Archived);
        assert!(decoded
            .events
            .iter()
            .any(|event| event.canonical_bytes == canonical_completion));

        let causally_later = distributed_item_action(4, 2, 7, 0xdd, 0xee, 0xff, 7);
        let decoded = decode_request_with_summary(&distributed_request(
            &[
                distributed_record(1, 7, b"Task", 0xaa, 0xbb, 0xcc, 5),
                distributed_item_action(2, 4, 7, 0xaa, 0xbb, 0xcc, 6),
                causally_later,
            ],
            &bindings,
        ))
        .unwrap();
        assert_eq!(
            crate::state::rebuild_distributed_on(
                &decoded.events,
                0,
                CivilDate::from_encoded(20261002).unwrap(),
            ),
            Err(KinError::InvalidEvent)
        );
    }

    #[test]
    fn v8_maximum_equal_time_history_replays_deterministically_with_arrival_boundary() {
        let records: Vec<Vec<u8>> = (1..=10_000)
            .map(|number| distributed_record(number, number, b"x", 0xaa, 0xbb, 0xcc, 7))
            .collect();
        let bindings = [identity_binding(0xaa, 0xbb, 0xcc, 0x11, 0x01)];
        let request = distributed_request(&records, &bindings);
        let decoded = decode_request_with_summary(&request).unwrap();
        let date = CivilDate::from_encoded(20261002).unwrap();
        let state = crate::state::rebuild_distributed_on(&decoded.events, 0, date).unwrap();
        assert_eq!(state.items.len(), 10_000);
        let mut expected_item_ids: Vec<[u8; 16]> = (1..=10_000).map(numbered_id).collect();
        expected_item_ids.sort();
        assert_eq!(
            state
                .items
                .iter()
                .map(|item| item.item_id.0)
                .collect::<Vec<_>>(),
            expected_item_ids
        );
        assert_eq!(
            decoded.events.last().unwrap().event_id,
            EventId(numbered_id(10_000))
        );
        assert_eq!(
            summarize_validated(&decoded.events, None, &state)
                .unwrap()
                .through_event_id,
            Some(EventId(numbered_id(10_000)))
        );
    }

    #[test]
    fn v6_cursor_header_requires_exact_flags_and_reserved_bytes() {
        let request = request_with(&[], PROTOCOL_V6, 0);
        let mut trailing_request = request.clone();
        trailing_request.push(0);
        assert_eq!(
            decode_request_with_summary(&trailing_request),
            Err(KinError::MalformedProtocol)
        );
        for length in 0..V6_REQUEST_HEADER_BYTES {
            assert_eq!(
                decode_request_with_summary(&request[..length]),
                Err(KinError::MalformedProtocol)
            );
        }
        for (offset, value) in [(20, 2), (21, 1), (22, 1), (23, 1), (24, 1)] {
            let mut malformed = request.clone();
            malformed[offset] = value;
            assert_eq!(
                decode_request_with_summary(&malformed),
                Err(KinError::MalformedProtocol)
            );
        }
        let mut invalid_time = request;
        invalid_time[12..20].copy_from_slice(&(i64::MAX).to_le_bytes());
        assert_eq!(
            decode_request_with_summary(&invalid_time),
            Err(KinError::MalformedProtocol)
        );
    }

    #[test]
    fn protocol_v1_history_keeps_its_bytes_and_normalizes_to_today() {
        let request = request_with(&added_record(b"Milk"), PROTOCOL_V1, 1);
        let (version, events, _) = decode_request(&request).unwrap();
        assert_eq!(version, PROTOCOL_V1);
        assert_eq!(events[0].event_version, 1);
        assert!(matches!(
            events[0].kind,
            EventKind::ItemAdded {
                classification: ItemClassification::Today,
                ..
            }
        ));
        let state = rebuild(&events).unwrap();
        let result = encode_state(&state, PROTOCOL_V1).unwrap();
        assert_eq!(read_u16(&result, 4), Ok(PROTOCOL_V1));
        assert_eq!(result[RESULT_HEADER_BYTES + 40], 0);
        assert_eq!(
            &result[RESULT_HEADER_BYTES + 41..RESULT_HEADER_BYTES + 44],
            &[0; 3]
        );
    }

    #[test]
    fn protocol_v2_carries_classification_and_status() {
        let request = request_with(&added_record_v2(1, 0x22, b"Buy wipes", 1), PROTOCOL_V2, 1);
        let (version, events, _) = decode_request(&request).unwrap();
        assert_eq!(version, PROTOCOL_V2);
        assert!(matches!(
            events[0].kind,
            EventKind::ItemAdded {
                classification: ItemClassification::Need,
                ..
            }
        ));
        let state = rebuild(&events).unwrap();
        let result = encode_state(&state, PROTOCOL_V2).unwrap();
        assert_eq!(read_u16(&result, 4), Ok(PROTOCOL_V2));
        assert_eq!(result[RESULT_HEADER_BYTES + 40], 1);
        assert_eq!(result[RESULT_HEADER_BYTES + 41], 0);
        assert_eq!(
            &result[RESULT_HEADER_BYTES + 42..RESULT_HEADER_BYTES + 44],
            &[0; 2]
        );
    }

    #[test]
    fn protocol_v2_mixed_legacy_and_current_events_replay() {
        let legacy = added_record(b"Legacy item");
        let current = added_record_v2(2, 0x22, b"Current item", 1);
        let mut request = request_with(&legacy, PROTOCOL_V2, 2);
        request.extend_from_slice(&current);
        let (_, events, _) = decode_request(&request).unwrap();
        let state = rebuild(&events).unwrap();
        assert_eq!(state.items.len(), 2);
        assert_eq!(state.items[0].classification, ItemClassification::Today);
        assert_eq!(state.items[1].classification, ItemClassification::Need);
        assert_eq!(state.items[0].text, "Legacy item");
        assert_eq!(state.items[1].text, "Current item");
    }

    #[test]
    fn maximum_event_count_projects_deterministically_within_result_limit() {
        let mut request = Vec::with_capacity(REQUEST_HEADER_BYTES + MAX_EVENT_COUNT * 109);
        request.extend_from_slice(b"KINE");
        push_u16(&mut request, PROTOCOL_V2);
        push_u16(&mut request, 0);
        push_u32(&mut request, MAX_EVENT_COUNT as u32);
        for value in 1..=MAX_EVENT_COUNT as u32 {
            request.extend_from_slice(&added_record_v2(value, value, b"x", 1));
        }

        assert!(request.len() <= MAX_PROTOCOL_BYTES);
        let (_, events, _) = decode_request(&request).unwrap();
        let state = rebuild(&events).unwrap();
        assert_eq!(state.items.len(), MAX_EVENT_COUNT);
        assert_eq!(state.items[0].text, "x");
        assert_eq!(
            state.items[MAX_EVENT_COUNT - 1].classification,
            ItemClassification::Need
        );

        let first_result = encode_state(&state, PROTOCOL_V2).unwrap();
        let second_result = encode_state(&rebuild(&events).unwrap(), PROTOCOL_V2).unwrap();
        assert!(first_result.len() <= MAX_PROTOCOL_BYTES);
        assert_eq!(first_result, second_result);
    }

    #[test]
    fn protocol_v2_rejects_invalid_classification_and_reserved_bytes() {
        for invalid_field in [16usize, 17] {
            let mut record = added_record_v2(1, 0x11, b"Milk", 0);
            record[EVENT_HEADER_BYTES + invalid_field] = if invalid_field == 16 { 2 } else { 1 };
            let request = request_with(&record, PROTOCOL_V2, 1);
            assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
        }
    }

    #[test]
    fn protocol_v2_truncated_add_payload_fails_at_every_boundary() {
        let record = added_record_v2(1, 0x11, b"Milk", 1);
        for record_length in EVENT_HEADER_BYTES..record.len() {
            let request = request_with(&record[..record_length], PROTOCOL_V2, 1);
            assert_eq!(
                decode_request(&request),
                Err(KinError::MalformedProtocol),
                "length {record_length}"
            );
        }
    }

    #[test]
    fn protocol_v1_rejects_new_lifecycle_kinds() {
        let mut record = added_record(b"Milk");
        record[2..4].copy_from_slice(&3u16.to_le_bytes());
        record[84..88].copy_from_slice(&16u32.to_le_bytes());
        record.truncate(EVENT_HEADER_BYTES + 16);
        let request = request_with(&record, PROTOCOL_V1, 1);
        assert_eq!(decode_request(&request), Err(KinError::UnsupportedVersion));
    }

    #[test]
    fn unsupported_protocol_is_rejected() {
        let request = request_with(&[], 99, 0);
        assert_eq!(decode_request(&request), Err(KinError::UnsupportedVersion));
    }

    #[test]
    fn truncated_request_header_is_rejected_at_every_short_length() {
        let header = request_with(&[], PROTOCOL_V6, 0);
        for length in 0..REQUEST_HEADER_BYTES {
            assert_eq!(
                decode_request(&header[..length]),
                Err(KinError::MalformedProtocol),
                "length {length}"
            );
        }
    }

    #[test]
    fn nonzero_request_reserved_field_is_rejected() {
        let mut request = request_with(&[], PROTOCOL_V6, 0);
        request[6] = 1;
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn truncated_event_header_is_rejected_at_every_short_length() {
        let record = added_record(b"Milk");
        for record_length in 0..EVENT_HEADER_BYTES {
            let request = request_with(&record[..record_length], PROTOCOL_V6, 1);
            assert_eq!(
                decode_request(&request),
                Err(KinError::MalformedProtocol),
                "record length {record_length}"
            );
        }
    }

    #[test]
    fn truncated_event_payload_is_rejected_at_every_short_length() {
        let record = added_record(b"Milk");
        for record_length in EVENT_HEADER_BYTES..record.len() {
            let request = request_with(&record[..record_length], PROTOCOL_V6, 1);
            assert_eq!(
                decode_request(&request),
                Err(KinError::MalformedProtocol),
                "record length {record_length}"
            );
        }
    }

    #[test]
    fn declared_payload_larger_than_available_bytes_is_rejected() {
        let mut record = added_record(b"Milk");
        record[84..88].copy_from_slice(&u32::MAX.to_le_bytes());
        let request = request_with(&record, PROTOCOL_V6, 1);
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn unsupported_event_schema_is_rejected() {
        let mut record = added_record(b"Buy milk");
        record[..2].copy_from_slice(&3u16.to_le_bytes());
        let request = request_with(&record, PROTOCOL_V6, 1);
        assert_eq!(decode_request(&request), Err(KinError::UnsupportedVersion));
    }

    #[test]
    fn unsupported_event_kind_is_rejected() {
        let mut record = added_record(b"Buy milk");
        record[2..4].copy_from_slice(&99u16.to_le_bytes());
        let request = request_with(&record, PROTOCOL_V6, 1);
        assert_eq!(decode_request(&request), Err(KinError::UnsupportedVersion));
    }

    #[test]
    fn completion_payload_with_wrong_length_is_rejected() {
        let mut record = added_record(b"Milk");
        record[2..4].copy_from_slice(&2u16.to_le_bytes());
        let request = request_with(&record, PROTOCOL_V6, 1);
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn reopen_and_archive_payload_lengths_are_exact() {
        for kind in [3u16, 4u16] {
            for payload_length in (0..=17).filter(|length| *length != 16) {
                let mut record = added_record(b"Milk");
                record[2..4].copy_from_slice(&kind.to_le_bytes());
                record[84..88].copy_from_slice(&(payload_length as u32).to_le_bytes());
                record.resize(EVENT_HEADER_BYTES + payload_length, 0);
                let request = request_with(&record, PROTOCOL_V2, 1);
                assert_eq!(
                    decode_request(&request),
                    Err(KinError::MalformedProtocol),
                    "kind {kind}, payload length {payload_length}"
                );
            }
        }
    }

    #[test]
    fn protocol_v1_cannot_serialize_unrepresentable_current_state() {
        let (_, events, _) = decode_request(&request_with(
            &added_record_v2(1, 0x11, b"Milk", 1),
            PROTOCOL_V2,
            1,
        ))
        .unwrap();
        let mut state = rebuild(&events).unwrap();
        assert_eq!(
            encode_state(&state, PROTOCOL_V1),
            Err(KinError::UnsupportedVersion)
        );
        state.items[0].classification = ItemClassification::Today;
        state.items[0].status = ItemStatus::Archived;
        assert_eq!(
            encode_state(&state, PROTOCOL_V1),
            Err(KinError::UnsupportedVersion)
        );
    }

    #[test]
    fn malformed_text_length_is_rejected() {
        let mut record = added_record(b"hi");
        record[EVENT_HEADER_BYTES + 16..EVENT_HEADER_BYTES + 20]
            .copy_from_slice(&5u32.to_le_bytes());
        let request = request_with(&record, PROTOCOL_V6, 1);
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn empty_or_oversized_text_payloads_are_rejected() {
        for (declared_length, text) in [(0u32, b"".as_slice()), (4097, b"x".as_slice())] {
            let mut record = added_record(text);
            record[EVENT_HEADER_BYTES + 16..EVENT_HEADER_BYTES + 20]
                .copy_from_slice(&declared_length.to_le_bytes());
            let request = request_with(&record, PROTOCOL_V6, 1);
            assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
        }
    }

    #[test]
    fn invalid_utf8_is_rejected() {
        let record = added_record(&[0xff]);
        let request = request_with(&record, PROTOCOL_V6, 1);
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn trailing_request_bytes_are_rejected() {
        let mut request = request_with(&[], PROTOCOL_V6, 0);
        request.push(0);
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn event_count_limit_is_enforced_before_record_parsing() {
        let request = request_with(&[], PROTOCOL_V6, (MAX_EVENT_COUNT + 1) as u32);
        assert_eq!(decode_request(&request), Err(KinError::SizeLimit));
    }

    #[test]
    fn maximum_utf8_item_text_is_accepted() {
        let record = added_record(&vec![b'x'; MAX_ITEM_TEXT_BYTES]);
        let request = request_with(&record, PROTOCOL_V6, 1);
        let (_, events, _) = decode_request(&request).unwrap();
        assert!(
            matches!(&events[0].kind, EventKind::ItemAdded { text, .. } if text.len() == MAX_ITEM_TEXT_BYTES)
        );
    }

    #[test]
    fn bom_and_emoji_text_are_preserved() {
        let text = "\u{feff}milk 🥛";
        let record = added_record(text.as_bytes());
        let request = request_with(&record, PROTOCOL_V6, 1);
        let (_, events, _) = decode_request(&request).unwrap();
        assert!(
            matches!(&events[0].kind, EventKind::ItemAdded { text: decoded, .. } if decoded == text)
        );
    }

    #[test]
    fn item_text_above_byte_limit_is_rejected() {
        let record = added_record(&vec![b'x'; MAX_ITEM_TEXT_BYTES + 1]);
        let request = request_with(&record, PROTOCOL_V6, 1);
        assert_eq!(decode_request(&request), Err(KinError::MalformedProtocol));
    }
    fn handoff_record(kind: u16, sequence: u8) -> Vec<u8> {
        let mut record = added_record(b"Dishwasher running");
        record[2..4].copy_from_slice(&kind.to_le_bytes());
        record[4..20].fill(sequence);
        record[76..84].copy_from_slice(&u64::from(sequence).to_le_bytes());
        if kind != 5 {
            record.truncate(104);
            record[84..88].copy_from_slice(&16u32.to_le_bytes());
        }
        record
    }

    fn handoff_replay(records: &[Vec<u8>]) -> Result<HouseholdState, KinError> {
        let (_, events, _) =
            decode_request(&request_with(&records.concat(), 3, records.len() as u32))?;
        rebuild(&events)
    }

    #[test]
    fn handoff_lifecycle_and_terminal_archive() {
        for kinds in [
            vec![5],
            vec![5, 6],
            vec![5, 6, 6],
            vec![5, 7],
            vec![5, 6, 7],
        ] {
            let records: Vec<_> = kinds
                .iter()
                .enumerate()
                .map(|(i, k)| handoff_record(*k, i as u8 + 1))
                .collect();
            let state = handoff_replay(&records).unwrap();
            let handoff = &state.handoffs[0];
            assert_eq!(handoff.created_by, ActorId([0xbb; 16]));
            assert_eq!(handoff.created_at, 1);
            assert_eq!(handoff.text, "Dishwasher running");
            assert_eq!(
                handoff.status,
                match kinds.last().unwrap() {
                    5 => HandoffStatus::Unacknowledged,
                    6 => HandoffStatus::Acknowledged,
                    _ => HandoffStatus::Archived,
                }
            );
            assert_eq!(handoff_replay(&records).unwrap(), state);
            for version in [1, 2] {
                assert_eq!(
                    encode_state(&state, version),
                    Err(KinError::UnsupportedVersion)
                );
            }
            if handoff.status == HandoffStatus::Archived {
                for kind in [5, 6, 7] {
                    let mut invalid = records.clone();
                    invalid.push(handoff_record(kind, invalid.len() as u8 + 1));
                    assert_eq!(handoff_replay(&invalid), Err(KinError::InvalidEvent));
                }
            }
        }
        for kind in [6, 7] {
            assert_eq!(
                handoff_replay(&[handoff_record(kind, 1)]),
                Err(KinError::InvalidEvent)
            );
        }
    }

    #[test]
    fn handoff_identity_deduplication_and_mixed_replay() {
        let added = handoff_record(5, 1);
        assert_eq!(
            handoff_replay(&[added.clone(), added.clone()])
                .unwrap()
                .handoffs
                .len(),
            1
        );
        let mut conflict = added.clone();
        *conflict.last_mut().unwrap() = b'x';
        assert_eq!(
            handoff_replay(&[added.clone(), conflict]),
            Err(KinError::InvalidEvent)
        );
        assert_eq!(
            handoff_replay(&[added.clone(), handoff_record(5, 2)]),
            Err(KinError::InvalidEvent)
        );
        let item = added_record_v2(2, 2, b"Milk", 1);
        let records = vec![added.clone(), item.clone(), handoff_record(6, 3)];
        let state = handoff_replay(&records).unwrap();
        assert_eq!(state.items.len(), 1);
        assert_eq!(state.handoffs.len(), 1);
        let bytes = encode_state(&state, 3).unwrap();
        assert_eq!(
            &bytes[..16],
            &[75, 73, 78, 83, 3, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
        );
        let (_, events, _) = decode_request(&request_with(&records.concat(), 3, 3)).unwrap();
        assert_eq!(events[0].canonical_bytes, added);
        assert_eq!(events[1].canonical_bytes, item);
        for version in [1, 2] {
            for kind in [5, 6, 7] {
                assert_eq!(
                    decode_request(&request_with(&handoff_record(kind, 1), version, 1)),
                    Err(KinError::UnsupportedVersion)
                );
            }
        }
    }
    #[test]
    fn handoff_payload_boundaries_and_versions_fail_closed() {
        for kind in [5, 6, 7] {
            let record = handoff_record(kind, 1);
            for length in 0..record.len() - 88 {
                let mut truncated = record[..88 + length].to_vec();
                truncated[84..88].copy_from_slice(&(length as u32).to_le_bytes());
                assert_eq!(
                    decode_request(&request_with(&truncated, 3, 1)),
                    Err(KinError::MalformedProtocol)
                );
            }
            let mut trailing = record.clone();
            trailing.push(0);
            let length = (trailing.len() - 88) as u32;
            trailing[84..88].copy_from_slice(&length.to_le_bytes());
            assert_eq!(
                decode_request(&request_with(&trailing, 3, 1)),
                Err(KinError::MalformedProtocol)
            );
            for version in [0u16, 2, 3, u16::MAX] {
                let mut invalid = record.clone();
                invalid[..2].copy_from_slice(&version.to_le_bytes());
                assert_eq!(
                    decode_request(&request_with(&invalid, 3, 1)),
                    Err(KinError::UnsupportedVersion)
                );
            }
            let mut extreme = record.clone();
            extreme[84..88].copy_from_slice(&u32::MAX.to_le_bytes());
            assert_eq!(
                decode_request(&request_with(&extreme, 3, 1)),
                Err(KinError::MalformedProtocol)
            );
        }
    }

    #[test]
    fn handoff_text_validation_and_actor_provenance() {
        for text in [vec![], vec![b'x'; 4097], vec![0xff]] {
            let mut record = added_record(&text);
            record[2..4].copy_from_slice(&5u16.to_le_bytes());
            assert_eq!(handoff_replay(&[record]), Err(KinError::MalformedProtocol));
        }
        let mut blank = added_record(b" \t\n");
        blank[2..4].copy_from_slice(&5u16.to_le_bytes());
        assert_eq!(handoff_replay(&[blank]), Err(KinError::InvalidEvent));
        for same_actor in [false, true] {
            let added = handoff_record(5, 1);
            let mut ack = handoff_record(6, 2);
            if !same_actor {
                ack[36..52].fill(0xdd);
            }
            let (_, events, _) =
                decode_request(&request_with(&[added, ack.clone()].concat(), 3, 2)).unwrap();
            assert_eq!(
                events[1].actor_id,
                ActorId(if same_actor { [0xbb; 16] } else { [0xdd; 16] })
            );
            assert_eq!(events[1].canonical_bytes, ack);
            let state = rebuild(&events).unwrap();
            assert_eq!(state.handoffs[0].created_by, ActorId([0xbb; 16]));
            assert_eq!(state.handoffs[0].status, HandoffStatus::Acknowledged);
        }
    }

    #[test]
    fn handoff_ids_have_separate_namespace_and_exact_result_bytes() {
        let legacy = added_record(b"Item");
        let added = handoff_record(5, 2); // same raw entity ID; distinct typed namespace
        let state = handoff_replay(&[legacy, added]).unwrap();
        assert_eq!(state.items.len(), 1);
        assert_eq!(state.handoffs.len(), 1);
        let bytes = encode_state(&state, 3).unwrap();
        let offset = 16 + 48 + 4;
        assert_eq!(&bytes[offset..offset + 16], &[0x11; 16]);
        assert_eq!(&bytes[offset + 16..offset + 32], &[0xbb; 16]);
        assert_eq!(&bytes[offset + 32..offset + 40], &1i64.to_le_bytes());
        assert_eq!(&bytes[offset + 40..offset + 44], &[0; 4]);
        assert_eq!(&bytes[offset + 44..offset + 48], &18u32.to_le_bytes());
        assert_eq!(&bytes[offset + 48..], b"Dishwasher running");
    }
    #[test]
    fn handoff_request_header_and_length_hardening() {
        let request = request_with(&handoff_record(5, 1), 3, 1);
        for length in 0..100 {
            assert_eq!(
                decode_request(&request[..length]),
                Err(KinError::MalformedProtocol)
            );
        }
        for offset in [6, 7] {
            let mut invalid = request.clone();
            invalid[offset] = 1;
            assert_eq!(decode_request(&invalid), Err(KinError::MalformedProtocol));
        }
        for length in [0u32, 4097, u32::MAX] {
            let mut invalid = request.clone();
            invalid[116..120].copy_from_slice(&length.to_le_bytes());
            assert_eq!(decode_request(&invalid), Err(KinError::MalformedProtocol));
        }
        let mut trailing = request;
        trailing.push(0);
        assert_eq!(decode_request(&trailing), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn maximum_mixed_handoff_replay_is_deterministic() {
        let mut records = Vec::new();
        for number in 1..=MAX_EVENT_COUNT as u32 {
            let mut record = if number % 2 == 0 {
                added_record_v2(number, number, b"x", 1)
            } else {
                let mut row = added_record(b"x");
                row[2..4].copy_from_slice(&5u16.to_le_bytes());
                row
            };
            record[4..20].copy_from_slice(&numbered_id(number));
            record[88..104].copy_from_slice(&numbered_id(number));
            record[76..84].copy_from_slice(&u64::from(number).to_le_bytes());
            records.push(record);
        }
        let state = handoff_replay(&records).unwrap();
        assert_eq!(state.handoffs.len(), 5000);
        assert_eq!(state.items.len(), 5000);
        let result = encode_state(&state, 3).unwrap();
        assert_eq!(result.len(), 16 + 10000 * 49);
        assert_eq!(
            result,
            encode_state(&handoff_replay(&records).unwrap(), 3).unwrap()
        );
    }
    fn talk_record(kind: u16, sequence: u8) -> Vec<u8> {
        let mut record = handoff_record(if kind == 8 { 5 } else { 6 }, sequence);
        record[2..4].copy_from_slice(&kind.to_le_bytes());
        record
    }

    fn talk_replay(records: &[Vec<u8>]) -> Result<HouseholdState, KinError> {
        let (_, events, _) =
            decode_request(&request_with(&records.concat(), 4, records.len() as u32))?;
        rebuild(&events)
    }

    #[test]
    fn talk_lifecycle_and_terminal_archive() {
        for (kinds, expected) in [
            (vec![8], TalkStatus::Open),
            (vec![8, 9], TalkStatus::Resolved),
            (vec![8, 9, 9], TalkStatus::Resolved),
            (vec![8, 9, 10], TalkStatus::Open),
            (vec![8, 10], TalkStatus::Open),
            (vec![8, 11], TalkStatus::Archived),
            (vec![8, 9, 11], TalkStatus::Archived),
        ] {
            let records: Vec<_> = kinds
                .iter()
                .enumerate()
                .map(|(i, k)| talk_record(*k, i as u8 + 1))
                .collect();
            let state = talk_replay(&records).unwrap();
            assert_eq!(state.talks[0].status, expected);
            assert_eq!(state.talks[0].created_by, ActorId([0xbb; 16]));
            assert_eq!(state.talks[0].created_at, 1);
            assert_eq!(talk_replay(&records).unwrap(), state);
            for version in [1, 2, 3] {
                assert_eq!(
                    encode_state(&state, version),
                    Err(KinError::UnsupportedVersion)
                );
            }
            if expected == TalkStatus::Archived {
                for kind in [8, 9, 10, 11] {
                    let mut invalid = records.clone();
                    invalid.push(talk_record(kind, invalid.len() as u8 + 1));
                    assert_eq!(talk_replay(&invalid), Err(KinError::InvalidEvent));
                }
            }
        }
        for kind in [9, 10, 11] {
            assert_eq!(
                talk_replay(&[talk_record(kind, 1)]),
                Err(KinError::InvalidEvent)
            );
        }
    }

    #[test]
    fn talk_identity_mixed_replay_and_legacy_rejection() {
        let added = talk_record(8, 1);
        assert_eq!(
            talk_replay(&[added.clone(), added.clone()])
                .unwrap()
                .talks
                .len(),
            1
        );
        let mut conflict = added.clone();
        *conflict.last_mut().unwrap() = b'x';
        assert_eq!(
            talk_replay(&[added.clone(), conflict]),
            Err(KinError::InvalidEvent)
        );
        assert_eq!(
            talk_replay(&[added, talk_record(8, 2)]),
            Err(KinError::InvalidEvent)
        );
        let records = vec![
            added_record(b"Milk"),
            added_record_v2(2, 2, b"Need", 1),
            handoff_record(5, 3),
            talk_record(8, 4),
        ];
        let state = talk_replay(&records).unwrap();
        assert_eq!(
            (state.items.len(), state.handoffs.len(), state.talks.len()),
            (2, 1, 1)
        );
        let bytes = encode_state(&state, 4).unwrap();
        assert_eq!(
            &bytes[..20],
            &[75, 73, 78, 83, 4, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
        );
        let (_, events, _) = decode_request(&request_with(&records.concat(), 4, 4)).unwrap();
        for (event, original) in events.iter().zip(records) {
            assert_eq!(event.canonical_bytes, original);
        }
        for version in [1, 2, 3] {
            for kind in [8, 9, 10, 11] {
                assert_eq!(
                    decode_request(&request_with(&talk_record(kind, 1), version, 1)),
                    Err(KinError::UnsupportedVersion)
                );
            }
        }
    }
    #[test]
    fn talk_payload_boundaries_and_versions_fail_closed() {
        for kind in [8, 9, 10, 11] {
            let record = talk_record(kind, 1);
            for length in 0..record.len() - 88 {
                let mut truncated = record[..88 + length].to_vec();
                truncated[84..88].copy_from_slice(&(length as u32).to_le_bytes());
                assert_eq!(
                    decode_request(&request_with(&truncated, 4, 1)),
                    Err(KinError::MalformedProtocol)
                );
            }
            let mut trailing = record.clone();
            trailing.push(0);
            let length = (trailing.len() - 88) as u32;
            trailing[84..88].copy_from_slice(&length.to_le_bytes());
            assert_eq!(
                decode_request(&request_with(&trailing, 4, 1)),
                Err(KinError::MalformedProtocol)
            );
            for version in [0u16, 2, 3, u16::MAX] {
                let mut invalid = record.clone();
                invalid[..2].copy_from_slice(&version.to_le_bytes());
                assert_eq!(
                    decode_request(&request_with(&invalid, 4, 1)),
                    Err(KinError::UnsupportedVersion)
                );
            }
            let mut extreme = record.clone();
            extreme[84..88].copy_from_slice(&u32::MAX.to_le_bytes());
            assert_eq!(
                decode_request(&request_with(&extreme, 4, 1)),
                Err(KinError::MalformedProtocol)
            );
        }
    }

    #[test]
    fn talk_text_and_exact_result_record() {
        for text in [vec![], vec![b'x'; 4097], vec![0xff]] {
            let mut row = added_record(&text);
            row[2..4].copy_from_slice(&8u16.to_le_bytes());
            assert_eq!(talk_replay(&[row]), Err(KinError::MalformedProtocol));
        }
        let mut row = added_record(b" \t\n");
        row[2..4].copy_from_slice(&8u16.to_le_bytes());
        assert_eq!(talk_replay(&[row]), Err(KinError::InvalidEvent));
        for (kind, status) in [(8, 0), (9, 1), (10, 0), (11, 2)] {
            let mut rows = vec![talk_record(8, 1)];
            if kind != 8 {
                rows.push(talk_record(kind, 2));
            }
            let state = talk_replay(&rows).unwrap();
            let bytes = encode_state(&state, 4).unwrap();
            assert_eq!(
                &bytes[..20],
                &[75, 73, 78, 83, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]
            );
            assert_eq!(&bytes[20..36], &[0x11; 16]);
            assert_eq!(&bytes[36..52], &[0xbb; 16]);
            assert_eq!(&bytes[52..60], &1i64.to_le_bytes());
            assert_eq!(&bytes[60..64], &[status, 0, 0, 0]);
            assert_eq!(&bytes[64..68], &18u32.to_le_bytes());
            assert_eq!(&bytes[68..], b"Dishwasher running");
        }
    }

    #[test]
    fn v4_combined_entity_limit() {
        let mut state = talk_replay(&[
            added_record(b"Milk"),
            handoff_record(5, 2),
            talk_record(8, 3),
        ])
        .unwrap();
        state.items.resize(3333, state.items[0].clone());
        state.handoffs.resize(3333, state.handoffs[0].clone());
        state.talks.resize(3334, state.talks[0].clone());
        assert!(encode_state(&state, 4).is_ok());
        state.talks.push(state.talks[0].clone());
        assert_eq!(encode_state(&state, 4), Err(KinError::SizeLimit));
    }
    #[test]
    fn talk_request_header_and_length_hardening() {
        let request = request_with(&talk_record(8, 1), 4, 1);
        for length in 0..100 {
            assert_eq!(
                decode_request(&request[..length]),
                Err(KinError::MalformedProtocol)
            );
        }
        for offset in [6, 7] {
            let mut invalid = request.clone();
            invalid[offset] = 1;
            assert_eq!(decode_request(&invalid), Err(KinError::MalformedProtocol));
        }
        for length in [0u32, 4097, u32::MAX] {
            let mut invalid = request.clone();
            invalid[116..120].copy_from_slice(&length.to_le_bytes());
            assert_eq!(decode_request(&invalid), Err(KinError::MalformedProtocol));
        }
        let mut trailing = request;
        trailing.push(0);
        assert_eq!(decode_request(&trailing), Err(KinError::MalformedProtocol));
    }

    #[test]
    fn maximum_mixed_talk_replay_is_deterministic() {
        let mut records = Vec::new();
        for number in 1..=MAX_EVENT_COUNT as u32 {
            let mut record = match number % 3 {
                0 => added_record_v2(number, number, b"x", 1),
                1 => handoff_record(5, 1),
                _ => talk_record(8, 1),
            };
            record[4..20].copy_from_slice(&numbered_id(number));
            record[88..104].copy_from_slice(&numbered_id(number));
            record[76..84].copy_from_slice(&u64::from(number).to_le_bytes());
            records.push(record);
        }
        let state = talk_replay(&records).unwrap();
        assert_eq!(
            (state.items.len(), state.handoffs.len(), state.talks.len()),
            (3333, 3334, 3333)
        );
        let result = encode_state(&state, 4).unwrap();
        assert!(result.len() < MAX_PROTOCOL_BYTES);
        assert_eq!(
            result,
            encode_state(&talk_replay(&records).unwrap(), 4).unwrap()
        );
        for collection in [
            state
                .items
                .iter()
                .map(|row| row.item_id.0)
                .collect::<Vec<_>>(),
            state.handoffs.iter().map(|row| row.handoff_id.0).collect(),
            state.talks.iter().map(|row| row.talk_id.0).collect(),
        ] {
            assert!(collection.windows(2).all(|pair| u32::from_le_bytes(
                pair[0][..4].try_into().unwrap()
            ) < u32::from_le_bytes(
                pair[1][..4].try_into().unwrap()
            )));
        }
    }
}
