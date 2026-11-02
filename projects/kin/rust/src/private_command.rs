//! Private commands (`kin_private_execute`, #511): a new event for the
//! member's private log, validated against that log the way a fridge command
//! is validated against the board log, and returned as KCMT for the host to
//! seal and store (web/private/private-log.js). The log itself is not
//! changed; the host appends the event once it is stored.
//!
//! Input: u32 command length, a KCMD v1 packet whose action is a private
//! kind (100–199) and whose text is the event's exact payload (zero entity
//! ID, date, option and expiry, like a board command), then a record-less
//! KINE context. Every private kind goes through here; each part of the
//! private projection decides whether its own events apply
//! (`PrivateState::check_command`).
//!
//! Refused with code 4: a full log, an invalid time or logical time, a
//! household other than the log's or the context's target, a logical time
//! not after the log's latest, an event ID the log already has, an author
//! other than the log's member, and whatever the part's own rules refuse.
use crate::codec::{encode_event, encode_metadata};
use crate::error::KinError;
use crate::event::{valid_timestamp, ActorId, DeviceId, EventEnvelope, EventId, HouseholdId};
use crate::history::{History, Log};
use crate::wire::{read_i64, read_id, read_u16, read_u32, read_u64, MAX_PROTOCOL_BYTES};

/// The KCMD header length; the payload follows it.
const KCMD_HEADER: usize = 128;

pub fn execute(bytes: &[u8], history: &mut History) -> Result<Vec<u8>, KinError> {
    if bytes.len() > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let command_length = read_u32(bytes, 0)? as usize;
    let end = 4usize
        .checked_add(command_length)
        .ok_or(KinError::MalformedProtocol)?;
    let packet = bytes.get(4..end).ok_or(KinError::MalformedProtocol)?;
    let mut event = decode_packet(packet)?;
    let context =
        crate::request::decode_context(bytes.get(end..).ok_or(KinError::MalformedProtocol)?)?;
    if history.log() != Log::Private
        || history.len() >= history.limit()
        || !valid_timestamp(event.timestamp)
        || event.logical_time == 0
        || event.logical_time > crate::state::MAX_LOGICAL_TIME
        || context
            .target_household_id
            .is_some_and(|household| household != event.household_id)
    {
        return Err(KinError::InvalidEvent);
    }
    let empty = history.is_empty();
    let replay = history.replay(&context)?;
    if !empty
        && (replay.household_id() != Some(event.household_id)
            || replay.last_logical_time() >= event.logical_time
            || replay.contains_event(event.event_id))
    {
        return Err(KinError::InvalidEvent);
    }
    let state = replay.private();
    if state
        .member()
        .is_some_and(|member| member != event.actor_id)
    {
        return Err(KinError::InvalidEvent);
    }
    state.check_command(&event.kind)?;
    event.canonical_bytes = encode_event(&event)?;
    let metadata = encode_metadata(&event.canonical_bytes)?;
    let mut output = Vec::with_capacity(20 + event.canonical_bytes.len() + metadata.len());
    output.extend_from_slice(b"KCMT\x01\0\0\0");
    output.extend_from_slice(&(event.canonical_bytes.len() as u32).to_le_bytes());
    output.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
    // No projection: the host reads KPRV once it has stored the event.
    output.extend_from_slice(&0u32.to_le_bytes());
    output.extend_from_slice(&event.canonical_bytes);
    output.extend_from_slice(&metadata);
    Ok(output)
}

/// KCMD v1 with a private action: "KCMD", version 1, reserved, action u16,
/// reserved, event ID @12, household @28, actor @44, device @60, timestamp
/// i64 @76, logical time u64 @84, entity ID @92, date u32 @108, option u8
/// @112, reserved [3], expiry i64 @116, payload length u32 @124, payload.
fn decode_packet(bytes: &[u8]) -> Result<EventEnvelope, KinError> {
    let malformed = KinError::MalformedProtocol;
    if bytes.len() < KCMD_HEADER || &bytes[..4] != b"KCMD" {
        return Err(malformed);
    }
    if read_u16(bytes, 4)? != 1 {
        return Err(KinError::UnsupportedVersion);
    }
    let code = read_u16(bytes, 8)?;
    if !crate::private::is_private_code(code) {
        return Err(KinError::UnsupportedVersion);
    }
    if bytes[6..8] != [0; 2]
        || bytes[10..12] != [0; 2]
        // No entity ID, date, option, reserved bytes or expiry: the payload
        // carries everything.
        || bytes[92..124].iter().any(|byte| *byte != 0)
        || bytes.len() != KCMD_HEADER + read_u32(bytes, 124)? as usize
    {
        return Err(malformed);
    }
    let kind = crate::private::decode_payload(code, &bytes[KCMD_HEADER..])?;
    let ids = |at| read_id(bytes, at);
    let event = EventEnvelope {
        event_id: EventId(ids(12)?),
        household_id: HouseholdId(ids(28)?),
        actor_id: ActorId(ids(44)?),
        device_id: DeviceId(ids(60)?),
        timestamp: read_i64(bytes, 76)?,
        logical_time: read_u64(bytes, 84)?,
        event_version: 1,
        kind,
        canonical_bytes: Vec::new(),
    };
    if [
        event.event_id.0,
        event.household_id.0,
        event.actor_id.0,
        event.device_id.0,
    ]
    .contains(&[0; 16])
    {
        return Err(malformed);
    }
    Ok(event)
}
