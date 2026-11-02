//! Shared protocol-24 wire constants and little-endian field access.
//!
//! Every multibyte integer is little-endian; IDs are 16 opaque bytes; text is
//! strict UTF-8 with no terminator. Readers fail with `MalformedProtocol` on
//! truncation instead of panicking.
use crate::error::KinError;

/// The only supported request and projection protocol.
pub const PROTOCOL_VERSION: u16 = 24;
/// KERR error buffers keep their original version-1 layout.
pub const ERROR_PROTOCOL_VERSION: u16 = 1;
pub const MAX_EVENT_COUNT: usize = 10_000;
pub const MAX_PROTOCOL_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_MAINTENANCE_EVENTS: usize = 8192;
pub const MAX_ITEM_TEXT_BYTES: usize = 4096;
/// Canonical event envelope header preceding each payload.
pub const EVENT_HEADER_BYTES: usize = 88;
/// KINE request header: magic, version, reserved, count, as_of, cursor,
/// civil date, target household, binding count, reserved.
pub const REQUEST_HEADER_BYTES: usize = 64;
/// One identity binding: three legacy IDs and three authenticated IDs.
pub const BINDING_BYTES: usize = 96;
pub const MAX_IDENTITY_BINDINGS: usize = 256;
/// KINS projection header.
pub const RESULT_HEADER_BYTES: usize = 96;

pub(crate) fn read_id(bytes: &[u8], offset: usize) -> Result<[u8; 16], KinError> {
    let id_bytes = bytes
        .get(offset..offset + 16)
        .ok_or(KinError::MalformedProtocol)?;
    let mut id = [0; 16];
    id.copy_from_slice(id_bytes);
    Ok(id)
}

pub(crate) fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, KinError> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or(KinError::MalformedProtocol)?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

pub(crate) fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, KinError> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or(KinError::MalformedProtocol)?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

pub(crate) fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, KinError> {
    let value = bytes
        .get(offset..offset + 8)
        .ok_or(KinError::MalformedProtocol)?;
    Ok(u64::from_le_bytes(
        value.try_into().map_err(|_| KinError::MalformedProtocol)?,
    ))
}

pub(crate) fn read_i64(bytes: &[u8], offset: usize) -> Result<i64, KinError> {
    let value = bytes
        .get(offset..offset + 8)
        .ok_or(KinError::MalformedProtocol)?;
    Ok(i64::from_le_bytes(
        value.try_into().map_err(|_| KinError::MalformedProtocol)?,
    ))
}

pub(crate) fn push_u16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

pub(crate) fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}
