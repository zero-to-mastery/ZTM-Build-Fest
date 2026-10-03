//! Household intent validation. Browser capabilities supply identity, randomness
//! and time explicitly; authentication/pairing are separate adapter concerns.
use crate::codec::{encode_event, encode_metadata};
use crate::core::{encode_projection, project};
use crate::error::KinError;
use crate::event::*;
use crate::protocol::{
    decode_event, decode_request_with_summary, DecodedRequest, MAX_EVENT_COUNT,
    MAX_ITEM_TEXT_BYTES, MAX_PROTOCOL_BYTES, PROTOCOL_VERSION,
};
use crate::recurrence::{Cadence, CivilDate};
use crate::state::HouseholdState;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HouseholdCommand {
    AddItem {
        id: ItemId,
        text: String,
        classification: ItemClassification,
    },
    CompleteItem(ItemId),
    ReopenItem(ItemId),
    ArchiveItem(ItemId),
    CaptureHandoff {
        id: HandoffId,
        text: String,
    },
    AcknowledgeHandoff(HandoffId),
    ArchiveHandoff(HandoffId),
    CaptureTalk {
        id: TalkId,
        text: String,
    },
    ResolveTalk(TalkId),
    ReopenTalk(TalkId),
    ArchiveTalk(TalkId),
    SetPulse {
        value: PulseValue,
        expires_at: i64,
    },
    ClearPulse,
    CreateRoutine {
        id: RoutineId,
        text: String,
        cadence: Cadence,
        created_on: CivilDate,
    },
    CompleteOccurrence {
        id: RoutineId,
        key: CivilDate,
    },
    ReopenOccurrence {
        id: RoutineId,
        key: CivilDate,
    },
    ArchiveRoutine(RoutineId),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommandContext {
    pub event_id: EventId,
    pub household_id: HouseholdId,
    pub actor_id: ActorId,
    pub device_id: DeviceId,
    pub timestamp: i64,
    pub logical_time: u64,
}

pub fn create_event(
    command: &HouseholdCommand,
    context: CommandContext,
) -> Result<EventEnvelope, KinError> {
    use HouseholdCommand::*;
    let kind = match command {
        AddItem {
            id,
            text,
            classification,
        } => EventKind::ItemAdded {
            item_id: *id,
            text: text.clone(),
            classification: *classification,
        },
        CompleteItem(id) => EventKind::ItemCompleted { item_id: *id },
        ReopenItem(id) => EventKind::ItemReopened { item_id: *id },
        ArchiveItem(id) => EventKind::ItemArchived { item_id: *id },
        CaptureHandoff { id, text } => EventKind::HandoffAdded {
            handoff_id: *id,
            text: text.clone(),
        },
        AcknowledgeHandoff(id) => EventKind::HandoffAcknowledged { handoff_id: *id },
        ArchiveHandoff(id) => EventKind::HandoffArchived { handoff_id: *id },
        CaptureTalk { id, text } => EventKind::TalkAdded {
            talk_id: *id,
            text: text.clone(),
        },
        ResolveTalk(id) => EventKind::TalkResolved { talk_id: *id },
        ReopenTalk(id) => EventKind::TalkReopened { talk_id: *id },
        ArchiveTalk(id) => EventKind::TalkArchived { talk_id: *id },
        SetPulse { value, expires_at } => EventKind::PulseSet {
            value: *value,
            expires_at: *expires_at,
        },
        ClearPulse => EventKind::PulseCleared,
        CreateRoutine {
            id,
            text,
            cadence,
            created_on,
        } => EventKind::RoutineCreated {
            routine_id: *id,
            text: text.clone(),
            cadence: *cadence,
            created_on: *created_on,
        },
        CompleteOccurrence { id, key } => EventKind::RoutineOccurrenceCompleted {
            routine_id: *id,
            key: *key,
        },
        ReopenOccurrence { id, key } => EventKind::RoutineOccurrenceReopened {
            routine_id: *id,
            key: *key,
        },
        ArchiveRoutine(id) => EventKind::RoutineArchived { routine_id: *id },
    };
    let event = EventEnvelope {
        event_id: context.event_id,
        household_id: context.household_id,
        actor_id: context.actor_id,
        device_id: context.device_id,
        timestamp: context.timestamp,
        logical_time: context.logical_time,
        event_version: if matches!(command, AddItem { .. }) {
            2
        } else {
            1
        },
        kind,
        canonical_bytes: Vec::new(),
    };
    decode_event(&encode_event(&event)?, PROTOCOL_VERSION)
}

pub struct CommandResult {
    pub event: EventEnvelope,
    pub projection: HouseholdState,
    pub encoded_projection: Vec<u8>,
}

/// Full validation happens before the adapter persists anything. Historical
/// replay remains idempotent; a stale local Routine intent is rejected here.
pub fn execute(
    command: &HouseholdCommand,
    context: CommandContext,
    mut request: DecodedRequest,
) -> Result<CommandResult, KinError> {
    if request.events.len() >= MAX_EVENT_COUNT
        || !valid_timestamp(context.timestamp)
        || context.logical_time == 0
        || context.logical_time == u64::MAX
    {
        return Err(KinError::InvalidEvent);
    }
    if request
        .target_household_id
        .is_some_and(|household| household != context.household_id)
        || request.events.iter().any(|event| {
            event.household_id != context.household_id
                || event.logical_time >= context.logical_time
                || event.event_id == context.event_id
        })
    {
        return Err(KinError::InvalidEvent);
    }
    let current = project(&request)?;
    let routine_intent = match command {
        HouseholdCommand::CompleteOccurrence { id, key } => Some((id, key, false)),
        HouseholdCommand::ReopenOccurrence { id, key } => Some((id, key, true)),
        _ => None,
    };
    if let Some((id, key, completed)) = routine_intent {
        let routine = current
            .routines
            .iter()
            .find(|r| r.routine_id == *id)
            .ok_or(KinError::InvalidEvent)?;
        if routine.archived
            || routine.occurrence_key != Some(*key)
            || routine.completed != completed
        {
            return Err(KinError::InvalidEvent);
        }
    }
    if let HouseholdCommand::CreateRoutine { created_on, .. } = command {
        if request.civil_date != Some(*created_on) {
            return Err(KinError::InvalidEvent);
        }
    }
    let event = create_event(command, context)?;
    request.events.push(event.clone());
    let projection = project(&request)?;
    let encoded_projection = encode_projection(&request, &projection)?;
    Ok(CommandResult {
        event,
        projection,
        encoded_projection,
    })
}

fn field<const N: usize>(bytes: &[u8], offset: usize) -> Result<[u8; N], KinError> {
    bytes
        .get(offset..offset + N)
        .ok_or(KinError::MalformedProtocol)?
        .try_into()
        .map_err(|_| KinError::MalformedProtocol)
}

/// KCMD v1 is an intent transport, independent of immutable event schemas.
pub fn decode_command(bytes: &[u8]) -> Result<(HouseholdCommand, CommandContext), KinError> {
    if bytes.len() < 128 || bytes.len() > 128 + MAX_ITEM_TEXT_BYTES || &bytes[..4] != b"KCMD" {
        return Err(KinError::MalformedProtocol);
    }
    if u16::from_le_bytes(field(bytes, 4)?) != 1 {
        return Err(KinError::UnsupportedVersion);
    }
    if bytes[6..8] != [0; 2] || bytes[10..12] != [0; 2] || bytes[113..116] != [0; 3] {
        return Err(KinError::MalformedProtocol);
    }
    let kind = u16::from_le_bytes(field(bytes, 8)?);
    let id = field(bytes, 92)?;
    let date = u32::from_le_bytes(field(bytes, 108)?);
    let option = bytes[112];
    let expires = i64::from_le_bytes(field(bytes, 116)?);
    let text_length = u32::from_le_bytes(field(bytes, 124)?) as usize;
    if bytes.len() != 128 + text_length {
        return Err(KinError::MalformedProtocol);
    }
    let text = std::str::from_utf8(&bytes[128..])
        .map_err(|_| KinError::MalformedProtocol)?
        .to_owned();
    if !matches!(kind, 1 | 5 | 8 | 14) && !text.is_empty()
        || !matches!(kind, 14..=16) && date != 0
        || !matches!(kind, 1 | 12 | 14) && option != 0
        || kind != 12 && expires != 0
        || matches!(kind, 12 | 13) && id != [0; 16]
    {
        return Err(KinError::MalformedProtocol);
    }
    use HouseholdCommand::*;
    let command = match kind {
        1 => AddItem {
            id: ItemId(id),
            text,
            classification: match option {
                0 => ItemClassification::Today,
                1 => ItemClassification::Need,
                _ => return Err(KinError::MalformedProtocol),
            },
        },
        2 => CompleteItem(ItemId(id)),
        3 => ReopenItem(ItemId(id)),
        4 => ArchiveItem(ItemId(id)),
        5 => CaptureHandoff {
            id: HandoffId(id),
            text,
        },
        6 => AcknowledgeHandoff(HandoffId(id)),
        7 => ArchiveHandoff(HandoffId(id)),
        8 => CaptureTalk {
            id: TalkId(id),
            text,
        },
        9 => ResolveTalk(TalkId(id)),
        10 => ReopenTalk(TalkId(id)),
        11 => ArchiveTalk(TalkId(id)),
        12 => SetPulse {
            value: match option {
                0 => PulseValue::Good,
                1 => PulseValue::Okay,
                2 => PulseValue::Drained,
                3 => PulseValue::RoughDay,
                4 => PulseValue::NeedQuiet,
                _ => return Err(KinError::MalformedProtocol),
            },
            expires_at: expires,
        },
        13 => ClearPulse,
        14 => CreateRoutine {
            id: RoutineId(id),
            text,
            cadence: Cadence::try_from(option)?,
            created_on: CivilDate::from_encoded(date)?,
        },
        15 => CompleteOccurrence {
            id: RoutineId(id),
            key: CivilDate::from_encoded(date)?,
        },
        16 => ReopenOccurrence {
            id: RoutineId(id),
            key: CivilDate::from_encoded(date)?,
        },
        17 => ArchiveRoutine(RoutineId(id)),
        _ => return Err(KinError::UnsupportedVersion),
    };
    let context = CommandContext {
        event_id: EventId(field(bytes, 12)?),
        household_id: HouseholdId(field(bytes, 28)?),
        actor_id: ActorId(field(bytes, 44)?),
        device_id: DeviceId(field(bytes, 60)?),
        timestamp: i64::from_le_bytes(field(bytes, 76)?),
        logical_time: u64::from_le_bytes(field(bytes, 84)?),
    };
    Ok((command, context))
}

pub fn encode_command(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    let (command, context) = decode_command(bytes)?;
    Ok(create_event(&command, context)?.canonical_bytes)
}

pub fn execute_request(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    if bytes.len() > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let command_length = u32::from_le_bytes(field(bytes, 0)?) as usize;
    let end = 4usize
        .checked_add(command_length)
        .ok_or(KinError::MalformedProtocol)?;
    let (command, context) = decode_command(bytes.get(4..end).ok_or(KinError::MalformedProtocol)?)?;
    let request =
        decode_request_with_summary(bytes.get(end..).ok_or(KinError::MalformedProtocol)?)?;
    let result = execute(&command, context, request)?;
    let metadata = encode_metadata(&result.event.canonical_bytes)?;
    let length =
        20 + result.event.canonical_bytes.len() + metadata.len() + result.encoded_projection.len();
    if length > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let mut output = Vec::with_capacity(length);
    output.extend_from_slice(b"KCMT\x01\0\0\0");
    output.extend_from_slice(&(result.event.canonical_bytes.len() as u32).to_le_bytes());
    output.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    output.extend_from_slice(&(result.encoded_projection.len() as u32).to_le_bytes());
    output.extend_from_slice(&result.event.canonical_bytes);
    output.extend_from_slice(&metadata);
    output.extend_from_slice(&result.encoded_projection);
    Ok(output)
}
