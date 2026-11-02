use crate::error::KinError;
use crate::event::PulseValue;
use crate::request::decode_request;
use crate::state::{rebuild, CatchUpSummary, HouseholdState, PulseStatus};
use crate::state_encode::encode_state;
use crate::test_support::{header_u32, kine, BODY, TEST_DATE};

fn no_summary() -> CatchUpSummary {
    CatchUpSummary {
        entries: Vec::new(),
        total_count: 0,
        through_event_id: None,
    }
}

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

fn request(records: &[Vec<u8>], as_of: i64) -> Vec<u8> {
    kine(records, as_of, TEST_DATE, None)
}

/// A schema-2 Item (kind 1), Handoff (5) or Talk (8) with one-byte text.
fn entity(sequence: u64, kind: u16) -> Vec<u8> {
    let mut bytes = record(sequence, 1, Some(0), 2000);
    bytes[2..4].copy_from_slice(&kind.to_le_bytes());
    let payload: Vec<u8> = if kind == 1 {
        bytes[0] = 2;
        let mut payload = sequence.to_le_bytes().to_vec();
        payload.resize(16, 0);
        payload.extend_from_slice(&[0, 0, 0, 0, 1, 0, 0, 0, b'x']);
        payload
    } else {
        let mut payload = sequence.to_le_bytes().to_vec();
        payload.resize(16, 0);
        payload.extend_from_slice(&[1, 0, 0, 0, b'x']);
        payload
    };
    bytes.truncate(88);
    bytes[84..88].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&payload);
    bytes
}

fn project(records: &[Vec<u8>], as_of: i64) -> Result<HouseholdState, KinError> {
    let request = decode_request(&request(records, as_of))?;
    rebuild(&request.events, request.as_of, request.civil_date)
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
fn pulse_identity_is_idempotent_and_conflicts_fail() {
    let a = record(1, 1, Some(0), 2000);
    assert_eq!(
        project(&[a.clone(), a.clone()], 1500).unwrap().pulses.len(),
        1
    );
    assert_eq!(
        project(&[a, record(1, 1, Some(2), 2000)], 1500),
        Err(KinError::InvalidEvent)
    );
}

#[test]
fn pulse_exact_result_record_and_empty_layout() {
    let state = project(&[record(1, 7, Some(3), 2000)], 2000).unwrap();
    let result = encode_state(&state, &no_summary()).unwrap();
    assert_eq!(header_u32(&result, 20), 1, "pulse count");
    let mut expected = Vec::new();
    expected.extend_from_slice(&[7; 16]);
    expected.extend_from_slice(&1000i64.to_le_bytes());
    expected.extend_from_slice(&2000i64.to_le_bytes());
    expected.extend_from_slice(&[3, 1, 0, 0, 0, 0, 0, 0]);
    assert_eq!(&result[BODY..BODY + 40], expected.as_slice());
    assert_eq!(
        encode_state(&project(&[], 0).unwrap(), &no_summary())
            .unwrap()
            .len(),
        BODY
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
fn request_headers_trailing_bytes_versions_and_combined_counts() {
    let valid = request(&[record(1, 1, Some(0), 2000)], 1500);
    let mut trailing = valid.clone();
    trailing.push(0);
    assert_eq!(decode_request(&trailing), Err(KinError::MalformedProtocol));
    for version in [0u16, 5, 23, 25, u16::MAX] {
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
        last_changed_at: 0,
        classification: crate::event::ItemClassification::Today,
        planning_date: None,
        status: crate::state::ItemStatus::Active,
        area_id: None,
        steps: Vec::new(),
    });
    assert_eq!(
        encode_state(&state, &no_summary()),
        Err(KinError::SizeLimit)
    );
}

#[test]
fn explicit_time_does_not_change_other_entities() {
    let item = entity(1, 1);
    let baseline = project(std::slice::from_ref(&item), 0).unwrap();
    for time in [-1000, 0, 1000, 2000, 3000] {
        assert_eq!(
            project(std::slice::from_ref(&item), time).unwrap(),
            baseline
        );
        let mixed = project(&[item.clone(), record(2, 1, Some(0), 2000)], time).unwrap();
        assert_eq!(mixed.items, baseline.items);
    }
}

#[test]
fn every_truncated_request_header_envelope_and_pulse_payload() {
    for kind in [Some(4), None] {
        let valid = request(&[record(1, 1, kind, 2000)], 1000);
        for length in 0..valid.len() {
            assert_eq!(
                decode_request(&valid[..length]),
                Err(KinError::MalformedProtocol),
                "length {length}"
            );
        }
        let mut extreme = valid.clone();
        extreme[148..152].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(decode_request(&extreme), Err(KinError::MalformedProtocol));
    }
}

#[test]
fn maximum_mixed_replay_is_deterministic_and_time_isolated() {
    let mut records = Vec::new();
    for sequence in 1..=10000u64 {
        records.push(if sequence % 4 == 0 {
            let mut bytes = record(sequence, 1, Some((sequence % 5) as u8), 2000);
            bytes[36..44].copy_from_slice(&sequence.to_le_bytes());
            bytes
        } else {
            entity(sequence, [1, 5, 8][(sequence % 4) as usize - 1])
        });
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
    let bytes = encode_state(&active, &no_summary()).unwrap();
    assert!(bytes.len() < crate::wire::MAX_PROTOCOL_BYTES);
    assert_eq!(
        bytes,
        encode_state(&project(&records, 1999).unwrap(), &no_summary()).unwrap()
    );
}
