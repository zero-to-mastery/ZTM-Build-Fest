use crate::error::KinError;
use crate::event::PulseValue;
use crate::protocol::{decode_request, encode_state};
use crate::state::{rebuild, rebuild_at, HouseholdState, PulseStatus};

fn record(sequence: u64, actor: u8, value: Option<u8>, expiry: i64) -> Vec<u8> {
    let mut bytes = vec![0; if value.is_some() { 104 } else { 88 }];
    bytes[0] = 1;
    bytes[2] = if value.is_some() { 12 } else { 13 };
    bytes[4..12].copy_from_slice(&sequence.to_le_bytes());
    bytes[20..36].fill(0xaa);
    bytes[36..52].fill(actor);
    bytes[52..68].fill(0xcc);
    bytes[68..76].copy_from_slice(&1000i64.to_le_bytes());
    bytes[76..84].copy_from_slice(&sequence.to_le_bytes());
    if let Some(value) = value {
        bytes[84] = 16;
        bytes[88] = value;
        bytes[96..104].copy_from_slice(&expiry.to_le_bytes());
    }
    bytes
}

fn request(records: &[Vec<u8>], version: u16, as_of: i64) -> Vec<u8> {
    let mut bytes = b"KINE".to_vec();
    bytes.extend_from_slice(&version.to_le_bytes());
    bytes.extend_from_slice(&[0; 2]);
    bytes.extend_from_slice(&(records.len() as u32).to_le_bytes());
    if version == 5 {
        bytes.extend_from_slice(&as_of.to_le_bytes());
    }
    for record in records {
        bytes.extend_from_slice(record);
    }
    bytes
}

fn project(records: &[Vec<u8>], as_of: i64) -> Result<HouseholdState, KinError> {
    let (_, events, time) = decode_request(&request(records, 5, as_of))?;
    rebuild_at(&events, time.unwrap())
}

#[test]
fn pulse_expiry_is_explicit_and_reversible() {
    let records = [record(1, 1, Some(2), 2000)];
    for time in [1999, 2000, 2001, 1000, 3000, -1000] {
        let state = project(&records, time).unwrap();
        assert_eq!(
            state.pulses[0].status,
            if time < 2000 {
                PulseStatus::Active
            } else {
                PulseStatus::Expired
            }
        );
        assert_eq!(state, project(&records, time).unwrap());
    }
}

#[test]
fn pulse_actor_replacement_clear_and_repeated_intent() {
    let mut records = vec![record(1, 2, Some(0), 2000), record(2, 1, Some(2), 3000)];
    let state = project(&records, 1500).unwrap();
    assert_eq!(state.pulses.len(), 2);
    assert_eq!(state.pulses[0].actor_id.0, [1; 16]);
    records.push(record(3, 2, Some(4), 4000));
    let state = project(&records, 1500).unwrap();
    assert_eq!(state.pulses[1].value, PulseValue::NeedQuiet);
    assert_eq!(state.pulses[0].value, PulseValue::Drained);
    records.push(record(4, 2, None, 0));
    records.push(record(5, 2, None, 0));
    assert_eq!(project(&records, 1500).unwrap().pulses.len(), 1);
    records.push(record(6, 2, Some(1), 5000));
    assert_eq!(
        project(&records, 1500).unwrap().pulses[1].value,
        PulseValue::Okay
    );
}

#[test]
fn pulse_legacy_protocols_fail_closed_and_identity_is_idempotent() {
    for kind in [Some(0), None] {
        for version in 1..=4 {
            assert_eq!(
                decode_request(&request(&[record(1, 1, kind, 2000)], version, 0)),
                Err(KinError::UnsupportedVersion)
            );
        }
    }
    let a = record(1, 1, Some(0), 2000);
    assert_eq!(
        project(&[a.clone(), a.clone()], 1500).unwrap().pulses.len(),
        1
    );
    assert_eq!(
        project(&[a.clone(), record(1, 1, Some(2), 2000)], 1500),
        Err(KinError::InvalidEvent)
    );
    let (_, events, _) = decode_request(&request(&[a], 5, 1500)).unwrap();
    assert_eq!(rebuild(&events), Err(KinError::UnsupportedVersion));
    let state = rebuild_at(&events, 1500).unwrap();
    for version in 1..=4 {
        assert_eq!(
            encode_state(&state, version),
            Err(KinError::UnsupportedVersion)
        );
    }
}

#[test]
fn pulse_v5_exact_result_and_empty_layout() {
    let state = project(&[record(1, 7, Some(3), 2000)], 2000).unwrap();
    let result = encode_state(&state, 5).unwrap();
    let mut expected = vec![75, 73, 78, 83, 5, 0, 0, 0];
    expected.extend_from_slice(&[0; 12]);
    expected.extend_from_slice(&1u32.to_le_bytes());
    expected.extend_from_slice(&[7; 16]);
    expected.extend_from_slice(&1000i64.to_le_bytes());
    expected.extend_from_slice(&2000i64.to_le_bytes());
    expected.extend_from_slice(&[3, 1, 0, 0, 0, 0, 0, 0]);
    assert_eq!(result, expected);
    assert_eq!(
        encode_state(&project(&[], 0).unwrap(), 5).unwrap().len(),
        24
    );
}

#[test]
fn pulse_basic_invalid_payload_and_duration() {
    assert_eq!(
        project(&[record(1, 1, Some(5), 2000)], 0),
        Err(KinError::MalformedProtocol)
    );
    for expiry in [999, 1000] {
        assert_eq!(
            project(&[record(1, 1, Some(0), expiry)], 0),
            Err(KinError::InvalidEvent)
        );
    }
    let mut bad = record(1, 1, Some(0), 2000);
    bad[89] = 1;
    assert_eq!(project(&[bad], 0), Err(KinError::MalformedProtocol));
}

#[test]
fn pulse_all_payload_lengths_schemas_and_reserved_bytes() {
    for value in [Some(0), None] {
        let good = record(1, 1, value, 2000);
        for length in 0..=20 {
            if length == good.len() - 88 {
                continue;
            }
            let mut bad = good.clone();
            bad.resize(88 + length, 0);
            bad[84..88].copy_from_slice(&(length as u32).to_le_bytes());
            assert_eq!(project(&[bad], 0), Err(KinError::MalformedProtocol));
        }
        for schema in [0u16, 2, 3, u16::MAX] {
            let mut bad = good.clone();
            bad[..2].copy_from_slice(&schema.to_le_bytes());
            assert_eq!(project(&[bad], 0), Err(KinError::UnsupportedVersion));
        }
    }
    for offset in 89..96 {
        let mut bad = record(1, 1, Some(0), 2000);
        bad[offset] = 1;
        assert_eq!(project(&[bad], 0), Err(KinError::MalformedProtocol));
    }
    for value in 5..=255 {
        assert_eq!(
            project(&[record(1, 1, Some(value), 2000)], 0),
            Err(KinError::MalformedProtocol)
        );
    }
}

#[test]
fn pulse_timestamp_ranges_and_projection_rejection() {
    use crate::event::MAX_TIMESTAMP;
    for invalid in [i64::MIN, -MAX_TIMESTAMP - 1, MAX_TIMESTAMP + 1, i64::MAX] {
        assert_eq!(project(&[], invalid), Err(KinError::MalformedProtocol));
        assert_eq!(
            project(&[record(1, 1, Some(0), invalid)], 0),
            Err(KinError::MalformedProtocol)
        );
        for kind in [Some(0), None] {
            let mut bad = record(1, 1, kind, 2000);
            bad[68..76].copy_from_slice(&invalid.to_le_bytes());
            assert_eq!(project(&[bad], 0), Err(KinError::MalformedProtocol));
        }
    }
    let mut full_range = record(1, 1, Some(0), MAX_TIMESTAMP);
    full_range[68..76].copy_from_slice(&(-MAX_TIMESTAMP).to_le_bytes());
    assert_eq!(
        project(&[full_range.clone()], -MAX_TIMESTAMP)
            .unwrap()
            .pulses[0]
            .status,
        PulseStatus::Active
    );
    assert_eq!(
        project(&[full_range], MAX_TIMESTAMP).unwrap().pulses[0].status,
        PulseStatus::Expired
    );
}

#[test]
fn v5_headers_trailing_bytes_versions_and_combined_counts() {
    let valid = request(&[record(1, 1, Some(0), 2000)], 5, 1500);
    let mut trailing = valid.clone();
    trailing.push(0);
    assert_eq!(decode_request(&trailing), Err(KinError::MalformedProtocol));
    for version in [0u16, 9, u16::MAX] {
        let mut bad = valid.clone();
        bad[4..6].copy_from_slice(&version.to_le_bytes());
        assert_eq!(decode_request(&bad), Err(KinError::UnsupportedVersion));
    }
    for offset in [6, 7] {
        let mut bad = valid.clone();
        bad[offset] = 1;
        assert_eq!(decode_request(&bad), Err(KinError::MalformedProtocol));
    }
    for count in [10001u32, u32::MAX] {
        let mut bad = valid.clone();
        bad[8..12].copy_from_slice(&count.to_le_bytes());
        assert_eq!(decode_request(&bad), Err(KinError::SizeLimit));
    }
    let mut state = project(&[record(1, 1, Some(0), 2000)], 0).unwrap();
    state.pulses = vec![state.pulses[0].clone(); 10000];
    state.items.push(crate::state::ItemState {
        item_id: crate::event::ItemId([1; 16]),
        text: "x".into(),
        created_by: crate::event::ActorId([1; 16]),
        created_at: 0,
        classification: crate::event::ItemClassification::Today,
        status: crate::state::ItemStatus::Active,
    });
    assert_eq!(encode_state(&state, 5), Err(KinError::SizeLimit));
}

#[test]
fn explicit_time_does_not_change_legacy_entities() {
    let mut item = record(1, 1, Some(0), 2000);
    item.resize(109, 0);
    item[2] = 1;
    item[84] = 21;
    item[88..104].fill(7);
    item[104] = 1;
    item[108] = b'x';
    let (_, events, _) = decode_request(&request(&[item.clone()], 4, 0)).unwrap();
    let legacy = rebuild(&events).unwrap();
    for time in [-1000, 0, 1000, 2000, 3000] {
        assert_eq!(project(&[item.clone()], time).unwrap(), legacy);
        let mixed = project(&[item.clone(), record(2, 1, Some(0), 2000)], time).unwrap();
        assert_eq!(mixed.items, legacy.items);
    }
}

#[test]
fn v5_every_truncated_request_header_envelope_and_pulse_payload() {
    for kind in [Some(4), None] {
        let valid = request(&[record(1, 1, kind, 2000)], 5, 1000);
        for length in 0..valid.len() {
            assert_eq!(
                decode_request(&valid[..length]),
                Err(KinError::MalformedProtocol),
                "length {length}"
            );
        }
        let mut extreme = valid.clone();
        extreme[104..108].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(decode_request(&extreme), Err(KinError::MalformedProtocol));
    }
}

#[test]
fn v5_maximum_mixed_replay_is_deterministic_and_time_isolated() {
    let mut records = Vec::new();
    for sequence in 1..=10000u64 {
        let mut bytes = record(sequence, 1, Some((sequence % 5) as u8), 2000);
        if sequence % 4 == 0 {
            bytes[36..44].copy_from_slice(&sequence.to_le_bytes());
        } else {
            bytes[2] = match sequence % 4 {
                1 => 1,
                2 => 5,
                _ => 8,
            };
            bytes.resize(109, 0);
            bytes[84..88].copy_from_slice(&21u32.to_le_bytes());
            bytes[88..104].fill(0);
            bytes[88..96].copy_from_slice(&sequence.to_le_bytes());
            bytes[104] = 1;
            bytes[108] = b'x';
        }
        records.push(bytes);
    }
    let active = project(&records, 1999).unwrap();
    let expired = project(&records, 2000).unwrap();
    assert_eq!(
        (
            active.items.len(),
            active.handoffs.len(),
            active.talks.len(),
            active.pulses.len()
        ),
        (2500, 2500, 2500, 2500)
    );
    assert_eq!(active.items, expired.items);
    assert_eq!(active.handoffs, expired.handoffs);
    assert_eq!(active.talks, expired.talks);
    assert!(active
        .pulses
        .iter()
        .all(|p| p.status == PulseStatus::Active));
    assert!(expired
        .pulses
        .iter()
        .all(|p| p.status == PulseStatus::Expired));
    let bytes = encode_state(&active, 5).unwrap();
    assert!(bytes.len() < crate::protocol::MAX_PROTOCOL_BYTES);
    assert_eq!(
        bytes,
        encode_state(&project(&records, 1999).unwrap(), 5).unwrap()
    );
}
