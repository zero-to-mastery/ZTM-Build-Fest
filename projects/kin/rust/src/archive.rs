//! Versioned, bounded framing for an authenticated encrypted archive. Browser
//! Web Crypto owns authentication; parsing alone never establishes authenticity.
use crate::error::KinError;
use crate::protocol::MAX_PROTOCOL_BYTES;

pub const ARCHIVE_VERSION: u16 = 1;
pub const MAX_ARCHIVE_METADATA: usize = 1024 * 1024;

/// Borrowed views into the caller's archive buffer; decoding does not authenticate it.
#[derive(Debug, Eq, PartialEq)]
pub struct Archive<'a> {
    pub metadata: &'a [u8],
    pub ciphertext: &'a [u8],
}

pub fn encode(metadata: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, KinError> {
    let header = encode_header(metadata.len(), ciphertext.len())?;
    let mut bytes = Vec::with_capacity(16 + metadata.len() + ciphertext.len());
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(metadata);
    bytes.extend_from_slice(ciphertext);
    Ok(bytes)
}

fn encode_header(metadata: usize, ciphertext: usize) -> Result<Vec<u8>, KinError> {
    validate_lengths(metadata, ciphertext)?;
    let mut header = Vec::with_capacity(16);
    header.extend_from_slice(b"KARC");
    header.extend_from_slice(&ARCHIVE_VERSION.to_le_bytes());
    header.extend_from_slice(&[0; 2]);
    header.extend_from_slice(&(metadata as u32).to_le_bytes());
    header.extend_from_slice(&(ciphertext as u32).to_le_bytes());
    Ok(header)
}

fn validate_lengths(metadata: usize, ciphertext: usize) -> Result<(), KinError> {
    if metadata == 0 || ciphertext < 16 {
        return Err(KinError::MalformedProtocol);
    }
    if metadata > MAX_ARCHIVE_METADATA
        || metadata
            .checked_add(ciphertext)
            .and_then(|v| v.checked_add(16))
            .is_none_or(|v| v > MAX_PROTOCOL_BYTES)
    {
        return Err(KinError::SizeLimit);
    }
    Ok(())
}

pub fn decode(bytes: &[u8]) -> Result<Archive<'_>, KinError> {
    let (metadata_len, _) = decode_layout(bytes, bytes.len())?;
    Ok(Archive {
        metadata: &bytes[16..16 + metadata_len],
        ciphertext: &bytes[16 + metadata_len..],
    })
}

fn decode_layout(bytes: &[u8], total_len: usize) -> Result<(usize, usize), KinError> {
    if bytes.len() < 16 || &bytes[..4] != b"KARC" {
        return Err(KinError::MalformedProtocol);
    }
    if u16::from_le_bytes(bytes[4..6].try_into().unwrap()) != ARCHIVE_VERSION {
        return Err(KinError::UnsupportedVersion);
    }
    if bytes[6..8] != [0; 2] {
        return Err(KinError::MalformedProtocol);
    }
    let metadata_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let ciphertext_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    validate_lengths(metadata_len, ciphertext_len)?;
    if total_len != 16 + metadata_len + ciphertext_len {
        return Err(KinError::MalformedProtocol);
    }
    Ok((metadata_len, ciphertext_len))
}

/// The host already owns the opaque payload. Emit the unchanged KARC v1 header
/// from two bounded u32 lengths without copying ciphertext through WASM.
pub fn header_request(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    if bytes.len() != 8 {
        return Err(KinError::MalformedProtocol);
    }
    let metadata = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    let ciphertext = u32::from_le_bytes(bytes[4..].try_into().unwrap()) as usize;
    encode_header(metadata, ciphertext)
}

/// Input is the exact 16-byte header plus actual host buffer length:u32. Rust
/// validates all framing; payload authentication remains the browser's job.
pub fn layout_request(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    if bytes.len() != 20 {
        return Err(KinError::MalformedProtocol);
    }
    let total = u32::from_le_bytes(bytes[16..].try_into().unwrap()) as usize;
    let (metadata, ciphertext) = decode_layout(&bytes[..16], total)?;
    let mut output = Vec::with_capacity(8);
    output.extend_from_slice(&(metadata as u32).to_le_bytes());
    output.extend_from_slice(&(ciphertext as u32).to_le_bytes());
    Ok(output)
}

/// ABI builder input: metadata length followed by metadata and ciphertext.
pub fn build_request(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    let length = u32::from_le_bytes(
        bytes
            .get(..4)
            .ok_or(KinError::MalformedProtocol)?
            .try_into()
            .unwrap(),
    ) as usize;
    let end = 4usize
        .checked_add(length)
        .ok_or(KinError::MalformedProtocol)?;
    encode(
        bytes.get(4..end).ok_or(KinError::MalformedProtocol)?,
        bytes.get(end..).ok_or(KinError::MalformedProtocol)?,
    )
}

pub fn validate_request(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    let archive = decode(bytes)?;
    let mut result = Vec::with_capacity(bytes.len() - 12);
    result.extend_from_slice(&(archive.metadata.len() as u32).to_le_bytes());
    result.extend_from_slice(archive.metadata);
    result.extend_from_slice(archive.ciphertext);
    Ok(result)
}

/// Authenticate/decrypt in the host first. This validates the complete canonical
/// corpus, rejects duplicate archive entries, and derives a replacement plan.
/// It performs no persistence and cannot partially import a failed archive.
pub fn plan_import(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    let request = crate::protocol::decode_request_with_summary(bytes)?;
    let mut ids = std::collections::BTreeSet::new();
    let mut next_logical_time = 1u64;
    for event in &request.events {
        if !ids.insert(event.event_id) {
            return Err(KinError::InvalidEvent);
        }
        next_logical_time = next_logical_time.max(
            event
                .logical_time
                .checked_add(1)
                .ok_or(KinError::InvalidEvent)?,
        );
    }
    let projection = crate::core::project(&request)?;
    let encoded = crate::core::encode_projection(&request, &projection)?;
    if encoded.len() + 24 > MAX_PROTOCOL_BYTES {
        return Err(KinError::SizeLimit);
    }
    let mut output = Vec::with_capacity(24 + encoded.len());
    output.extend_from_slice(b"KIMP\x01\0\0\0");
    output.extend_from_slice(&(request.events.len() as u32).to_le_bytes());
    output.extend_from_slice(&next_logical_time.to_le_bytes());
    output.extend_from_slice(&(encoded.len() as u32).to_le_bytes());
    output.extend_from_slice(&encoded);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compact_framing_matches_v1_and_checks_complete_bounds() {
        let archive = encode(b"metadata", &[7; 16]).unwrap();
        let mut lengths = Vec::new();
        lengths.extend_from_slice(&8u32.to_le_bytes());
        lengths.extend_from_slice(&16u32.to_le_bytes());
        assert_eq!(header_request(&lengths).unwrap(), archive[..16]);
        let mut layout = archive[..16].to_vec();
        layout.extend_from_slice(&(archive.len() as u32).to_le_bytes());
        assert_eq!(layout_request(&layout).unwrap(), lengths);
        for end in 0..20 {
            assert!(layout_request(&layout[..end]).is_err());
        }
        for total in [0, 15, archive.len() as u32 - 1, archive.len() as u32 + 1] {
            layout[16..].copy_from_slice(&total.to_le_bytes());
            assert_eq!(layout_request(&layout), Err(KinError::MalformedProtocol));
        }
        let maximum_ciphertext = MAX_PROTOCOL_BYTES - MAX_ARCHIVE_METADATA - 16;
        let mut maximum = (MAX_ARCHIVE_METADATA as u32).to_le_bytes().to_vec();
        maximum.extend_from_slice(&(maximum_ciphertext as u32).to_le_bytes());
        assert!(header_request(&maximum).is_ok());
        maximum[4..].copy_from_slice(&(maximum_ciphertext as u32 + 1).to_le_bytes());
        assert_eq!(header_request(&maximum), Err(KinError::SizeLimit));
        assert_eq!(header_request(&[255; 8]), Err(KinError::SizeLimit));
        assert!(header_request(&[0; 7]).is_err());
        assert!(header_request(&[0; 9]).is_err());
    }
    #[test]
    fn archive_roundtrip_and_every_truncation() {
        let bytes = encode(b"recovery wrapper metadata", &[23; 32]).unwrap();
        assert_eq!(
            decode(&bytes).unwrap(),
            Archive {
                metadata: b"recovery wrapper metadata",
                ciphertext: &[23; 32]
            }
        );
        for end in 0..bytes.len() {
            assert!(decode(&bytes[..end]).is_err());
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(decode(&trailing).is_err());
        let mut newer = bytes.clone();
        newer[4] = 2;
        assert_eq!(decode(&newer), Err(KinError::UnsupportedVersion));
        let mut flags = bytes.clone();
        flags[6] = 1;
        assert!(decode(&flags).is_err());
        let mut length = bytes;
        length[8..12].fill(255);
        assert_eq!(decode(&length), Err(KinError::SizeLimit));
        assert!(encode(b"", &[0; 16]).is_err());
        assert!(encode(b"metadata", &[0; 15]).is_err());
    }

    #[test]
    fn import_plan_is_complete_and_rejects_duplicate_entries() {
        use crate::command::{create_event, CommandContext, HouseholdCommand};
        use crate::event::*;
        let context = CommandContext {
            event_id: EventId([1; 16]),
            household_id: HouseholdId([2; 16]),
            actor_id: ActorId([3; 16]),
            device_id: DeviceId([4; 16]),
            timestamp: 1234,
            logical_time: 7,
        };
        let command = HouseholdCommand::AddItem {
            id: ItemId([5; 16]),
            text: "Synthetic".into(),
            classification: ItemClassification::Need,
        };
        let event = create_event(&command, context).unwrap();
        let make_request = |count: u32| {
            let mut bytes = vec![0; 44];
            bytes[..8].copy_from_slice(b"KINE\x07\0\0\0");
            bytes[8..12].copy_from_slice(&count.to_le_bytes());
            bytes[12..20].copy_from_slice(&1234i64.to_le_bytes());
            bytes[40..44].copy_from_slice(&20261003u32.to_le_bytes());
            for _ in 0..count {
                bytes.extend_from_slice(&event.canonical_bytes);
            }
            bytes
        };
        let bytes = make_request(1);
        let plan = plan_import(&bytes).unwrap();
        assert_eq!(&plan[..8], b"KIMP\x01\0\0\0");
        assert_eq!(u32::from_le_bytes(plan[8..12].try_into().unwrap()), 1);
        assert_eq!(u64::from_le_bytes(plan[12..20].try_into().unwrap()), 8);
        assert_eq!(&plan[24..28], b"KINS");
        assert_eq!(plan_import(&make_request(2)), Err(KinError::InvalidEvent));
        assert!(plan_import(&bytes[..bytes.len() - 1]).is_err());
        let mut corrupt = bytes;
        corrupt[44] = 255;
        assert_eq!(plan_import(&corrupt), Err(KinError::UnsupportedVersion));
    }
}
