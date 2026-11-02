//! Shared protocol-24 wire builders for tests. Expected bytes are written out
//! independently here; they never come from the production encoders.
use crate::event::{ActorId, DeviceId, HouseholdId, IdentityBinding};
use crate::wire::{PROTOCOL_VERSION, RESULT_HEADER_BYTES};

/// Bytes in the section table after the header: 14 (revision, length) pairs.
pub const SECTION_TABLE: usize = 14 * 8;

/// The default civil date tests replay at, 2026-10-03.
pub const TEST_DATE: u32 = 20261003;

/// Offset of the first entity record (Items, then Handoffs, Talks, Pulses).
pub const BODY: usize = RESULT_HEADER_BYTES + SECTION_TABLE;

/// The byte length a projection's section table records for section `index`.
pub fn section_length(bytes: &[u8], index: usize) -> u32 {
    header_u32(bytes, RESULT_HEADER_BYTES + index * 8 + 4)
}

/// A local (no target household) KINE request over raw canonical records.
pub fn kine(records: &[Vec<u8>], as_of: i64, civil_date: u32, cursor: Option<[u8; 16]>) -> Vec<u8> {
    bound_kine(records, as_of, civil_date, cursor, None, &[])
}

/// A KINE request with an explicit target household and identity bindings.
pub fn bound_kine(
    records: &[Vec<u8>],
    as_of: i64,
    civil_date: u32,
    cursor: Option<[u8; 16]>,
    target: Option<[u8; 16]>,
    bindings: &[IdentityBinding],
) -> Vec<u8> {
    let mut bytes = b"KINE".to_vec();
    bytes.extend_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    bytes.extend_from_slice(&[0; 2]);
    bytes.extend_from_slice(&(records.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&as_of.to_le_bytes());
    bytes.push(u8::from(cursor.is_some()));
    bytes.extend_from_slice(&[0; 3]);
    bytes.extend_from_slice(&cursor.unwrap_or([0; 16]));
    bytes.extend_from_slice(&civil_date.to_le_bytes());
    bytes.extend_from_slice(&target.unwrap_or([0; 16]));
    bytes.extend_from_slice(&(bindings.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&[0; 2]);
    for binding in bindings {
        for id in [
            binding.legacy_household_id.0,
            binding.legacy_actor_id.0,
            binding.legacy_device_id.0,
            binding.household_id.0,
            binding.actor_id.0,
            binding.device_id.0,
        ] {
            bytes.extend_from_slice(&id);
        }
    }
    for record in records {
        bytes.extend_from_slice(record);
    }
    bytes
}

/// A 16-byte ID whose first four bytes are `value` (little-endian).
pub fn numbered_id(value: u32) -> [u8; 16] {
    let mut id = [0; 16];
    id[..4].copy_from_slice(&value.to_le_bytes());
    id
}

fn envelope(version: u16, kind: u16, event: u32, payload: &[u8]) -> Vec<u8> {
    let mut record = Vec::new();
    record.extend_from_slice(&version.to_le_bytes());
    record.extend_from_slice(&kind.to_le_bytes());
    record.extend_from_slice(&numbered_id(event));
    record.extend_from_slice(&[0xaa; 16]);
    record.extend_from_slice(&[0xbb; 16]);
    record.extend_from_slice(&[0xcc; 16]);
    record.extend_from_slice(&i64::from(event).to_le_bytes());
    record.extend_from_slice(&u64::from(event).to_le_bytes());
    record.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    record.extend_from_slice(payload);
    record
}

/// A schema-2 ITEM_ADDED record (household 0xaa, actor 0xbb, device 0xcc;
/// timestamp and logical time equal `event`).
pub fn item_record(event: u32, item: u32, text: &[u8], classification: u8) -> Vec<u8> {
    let mut payload = numbered_id(item).to_vec();
    payload.extend_from_slice(&[classification, 0, 0, 0]);
    payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
    payload.extend_from_slice(text);
    envelope(2, 1, event, &payload)
}

/// A schema-1 text-bearing record (Handoff 5, Talk 8): entity ID, length, text.
pub fn text_record(kind: u16, event: u32, entity: u32, text: &[u8]) -> Vec<u8> {
    let mut payload = numbered_id(entity).to_vec();
    payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
    payload.extend_from_slice(text);
    envelope(1, kind, event, &payload)
}

/// A schema-1 record whose payload is exactly one entity ID.
pub fn reference_record(kind: u16, event: u32, entity: u32) -> Vec<u8> {
    envelope(1, kind, event, &numbered_id(entity))
}

/// A binding from a placeholder tuple to the authenticated household 0x99.
pub fn identity_binding(
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

/// Reads a little-endian u32 from a projection.
pub fn header_u32(projection: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(projection[offset..offset + 4].try_into().unwrap())
}
