//! Protocol-24 KINE replay request decoding.
//!
//! ```text
//! offset size field
//! 0      4    "KINE"
//! 4      2    protocol_version = 24
//! 6      2    reserved = 0
//! 8      4    event_count (<= 10,000)
//! 12     8    as_of: i64 UTC milliseconds
//! 20     1    cursor_present (0 or 1)
//! 21     3    reserved = 0
//! 24     16   cursor event ID (all zero when absent)
//! 40     4    civil date YYYYMMDD
//! 44     16   target household ID (all zero: local replay, no bindings)
//! 60     2    identity_binding_count (<= 256)
//! 62     2    reserved = 0
//! 64     96*n identity bindings, then event_count canonical event records
//! ```
//!
//! Identity bindings map a pre-sync placeholder (household, actor, device)
//! tuple to the authenticated identity that imported that history. They are
//! not a format migration: a household created locally keeps its placeholder
//! IDs in canonical bytes forever, and every replay of that history after sync
//! is enabled needs the binding (IDENTITY.md, SYNC.md).
use crate::error::KinError;
use crate::event::{
    valid_timestamp, ActorId, DeviceId, EventEnvelope, EventId, HouseholdId, IdentityBinding,
};
use crate::event_decode::decode_event;
use crate::recurrence::CivilDate;
use crate::wire::{
    read_i64, read_id, read_u16, read_u32, BINDING_BYTES, EVENT_HEADER_BYTES, MAX_EVENT_COUNT,
    MAX_IDENTITY_BINDINGS, MAX_PROTOCOL_BYTES, PROTOCOL_VERSION, REQUEST_HEADER_BYTES,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodedRequest {
    /// Events in input (local arrival) order. Replay sorts its own copy; the
    /// catch-up summary uses this order.
    pub events: Vec<EventEnvelope>,
    pub as_of: i64,
    pub summary_cursor: Option<EventId>,
    pub civil_date: CivilDate,
    pub target_household_id: Option<HouseholdId>,
    pub identity_bindings: Vec<IdentityBinding>,
}

impl DecodedRequest {
    /// A local (unbound) request over `events`.
    pub fn local(events: Vec<EventEnvelope>, as_of: i64, civil_date: CivilDate) -> Self {
        Self {
            events,
            as_of,
            summary_cursor: None,
            civil_date,
            target_household_id: None,
            identity_bindings: Vec::new(),
        }
    }
}

/// A whole KINE request: the context and its event records.
pub fn decode_request(bytes: &[u8]) -> Result<DecodedRequest, KinError> {
    let (mut request, event_count, mut offset) = decode_header(bytes)?;
    request
        .events
        .try_reserve_exact(event_count)
        .map_err(|_| KinError::SizeLimit)?;
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
        request.push_record(record)?;
        offset = record_end;
    }
    if offset != bytes.len() {
        return Err(KinError::MalformedProtocol);
    }
    Ok(request)
}

/// Only the context of a KINE request (as_of, cursor, civil date, target
/// household and bindings), for replaying the history an engine instance
/// holds (history.rs). The request must carry no event records.
pub fn decode_context(bytes: &[u8]) -> Result<DecodedRequest, KinError> {
    let (request, event_count, offset) = decode_header(bytes)?;
    if event_count != 0 || offset != bytes.len() {
        return Err(KinError::MalformedProtocol);
    }
    Ok(request)
}

impl DecodedRequest {
    /// Decodes one canonical record and appends it, with its replay identity
    /// normalized through the bindings. canonical_bytes keep the signed source.
    pub fn push_record(&mut self, record: &[u8]) -> Result<(), KinError> {
        if self.events.len() >= MAX_EVENT_COUNT {
            return Err(KinError::SizeLimit);
        }
        let event = self.decode_bound(record)?;
        // A household request never carries chat, board or private events
        // (history.rs).
        if event.kind.is_chat() || event.kind.is_board() || event.kind.is_private() {
            return Err(KinError::InvalidEvent);
        }
        self.events.push(event);
        Ok(())
    }

    /// Decodes one canonical record with its replay identity normalized
    /// through this request's bindings, without adding it to `events`.
    pub fn decode_bound(&self, record: &[u8]) -> Result<EventEnvelope, KinError> {
        let mut event = decode_event(record)?;
        if let Some(target_household_id) = self.target_household_id {
            if let Some(binding) = self.identity_bindings.iter().find(|binding| {
                binding.legacy_household_id == event.household_id
                    && binding.legacy_actor_id == event.actor_id
                    && binding.legacy_device_id == event.device_id
            }) {
                event.household_id = binding.household_id;
                event.actor_id = binding.actor_id;
                event.device_id = binding.device_id;
            } else if event.household_id != target_household_id {
                return Err(KinError::InvalidEvent);
            }
        }
        Ok(event)
    }
}

/// The header and bindings; returns the request without events, the declared
/// event count and the offset of the first record.
fn decode_header(bytes: &[u8]) -> Result<(DecodedRequest, usize, usize), KinError> {
    if bytes.len() > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    if bytes.len() < 6 || &bytes[..4] != b"KINE" {
        return Err(KinError::MalformedProtocol);
    }
    if read_u16(bytes, 4)? != PROTOCOL_VERSION {
        return Err(KinError::UnsupportedVersion);
    }
    if bytes.len() < REQUEST_HEADER_BYTES || read_u16(bytes, 6)? != 0 {
        return Err(KinError::MalformedProtocol);
    }
    let event_count = read_u32(bytes, 8)? as usize;
    if event_count > MAX_EVENT_COUNT {
        return Err(KinError::SizeLimit);
    }
    let as_of = read_i64(bytes, 12)?;
    if !valid_timestamp(as_of) {
        return Err(KinError::MalformedProtocol);
    }
    if bytes[21..24] != [0; 3] {
        return Err(KinError::MalformedProtocol);
    }
    let cursor_id = read_id(bytes, 24)?;
    let summary_cursor = match bytes[20] {
        0 if cursor_id == [0; 16] => None,
        // A present cursor names a real event; event IDs are never all zero.
        1 if cursor_id != [0; 16] => Some(EventId(cursor_id)),
        _ => return Err(KinError::MalformedProtocol),
    };
    let civil_date = CivilDate::from_encoded(read_u32(bytes, 40)?)?;
    let target = read_id(bytes, 44)?;
    let target_household_id = (target != [0; 16]).then_some(HouseholdId(target));
    let binding_count = read_u16(bytes, 60)? as usize;
    if binding_count > MAX_IDENTITY_BINDINGS {
        return Err(KinError::SizeLimit);
    }
    if read_u16(bytes, 62)? != 0 {
        return Err(KinError::MalformedProtocol);
    }
    let mut identity_bindings = Vec::new();
    identity_bindings
        .try_reserve_exact(binding_count)
        .map_err(|_| KinError::SizeLimit)?;
    let mut offset = REQUEST_HEADER_BYTES;
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..binding_count {
        let record = bytes
            .get(offset..offset + BINDING_BYTES)
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
        if Some(binding.household_id) != target_household_id || !seen.insert(key) {
            return Err(KinError::InvalidEvent);
        }
        identity_bindings.push(binding);
        offset += BINDING_BYTES;
    }
    let request = DecodedRequest {
        events: Vec::new(),
        as_of,
        summary_cursor,
        civil_date,
        target_household_id,
        identity_bindings,
    };
    Ok((request, event_count, offset))
}
