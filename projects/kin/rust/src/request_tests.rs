// KINE protocol-24 request framing, identity bindings and replay ordering.
use crate::core::replay;
use crate::error::KinError;
use crate::event::{DeviceId, EventId, HouseholdId};
use crate::recurrence::CivilDate;
use crate::request::decode_request;
use crate::state::{rebuild, summarize_validated, ItemStatus};
use crate::test_support::*;
use crate::wire::{MAX_EVENT_COUNT, MAX_PROTOCOL_BYTES, REQUEST_HEADER_BYTES};

fn date() -> CivilDate {
    CivilDate::from_encoded(TEST_DATE).unwrap()
}

fn distributed(
    event: u32,
    item: u32,
    text: &[u8],
    household: u8,
    actor: u8,
    device: u8,
    logical: u64,
) -> Vec<u8> {
    let mut record = item_record(event, item, text, 1);
    record[20..36].fill(household);
    record[36..52].fill(actor);
    record[52..68].fill(device);
    record[76..84].copy_from_slice(&logical.to_le_bytes());
    record
}

fn distributed_action(
    event: u32,
    kind: u16,
    item: u32,
    household: u8,
    actor: u8,
    device: u8,
    logical: u64,
) -> Vec<u8> {
    let mut record = reference_record(kind, event, item);
    record[20..36].fill(household);
    record[36..52].fill(actor);
    record[52..68].fill(device);
    record[68..76].copy_from_slice(&1i64.to_le_bytes());
    record[76..84].copy_from_slice(&logical.to_le_bytes());
    record
}

fn bound(records: &[Vec<u8>], bindings: &[crate::event::IdentityBinding]) -> Vec<u8> {
    bound_kine(records, 0, 20261002, None, Some([0x99; 16]), bindings)
}

#[test]
fn empty_request_projects_the_empty_header_and_section_table() {
    let result = replay(&kine(&[], 0, TEST_DATE, None)).unwrap();
    let mut expected = vec![0; BODY];
    expected[..6].copy_from_slice(b"KINS\x18\0");
    assert_eq!(result, expected);
}

#[test]
fn summary_record_and_snapshot_boundary_layout() {
    let result = replay(&kine(
        &[item_record(1, 0x11, b"Milk", 0)],
        0,
        TEST_DATE,
        None,
    ))
    .unwrap();
    assert_eq!(header_u32(&result, 8), 1, "items");
    assert_eq!(
        (header_u32(&result, 24), header_u32(&result, 28)),
        (1, 1),
        "summary entries/total"
    );
    assert_eq!(result[32], 1, "through present");
    assert_eq!(&result[36..52], &numbered_id(1));
    let summary = result.len() - 28;
    assert_eq!(&result[summary..summary + 16], &numbered_id(1));
    assert_eq!(&result[summary + 16..summary + 20], &[1, 1, 0, 0]); // ItemAdded, Item, Today
    assert_eq!(header_u32(&result, summary + 20), 4);
    assert_eq!(&result[summary + 24..], b"Milk");
}

#[test]
fn cursor_excludes_its_event_but_not_the_snapshot_boundary() {
    let request = kine(
        &[item_record(1, 0x11, b"Milk", 0)],
        0,
        TEST_DATE,
        Some(numbered_id(1)),
    );
    let result = replay(&request).unwrap();
    assert_eq!((header_u32(&result, 24), header_u32(&result, 28)), (0, 0));
    assert_eq!(result[32], 1);
    assert_eq!(&result[36..52], &numbered_id(1));
    let missing = kine(
        &[item_record(1, 0x11, b"Milk", 0)],
        0,
        TEST_DATE,
        Some(numbered_id(9)),
    );
    assert_eq!(replay(&missing), Err(KinError::InvalidEvent));
}

#[test]
fn bindings_resolve_replay_identity_without_changing_canonical_bytes() {
    let first = distributed(3, 3, b"B", 0xdd, 0xee, 0xff, 5);
    let second = distributed(2, 2, b"A", 0xaa, 0xbb, 0xcc, 5);
    let bindings = [
        identity_binding(0xaa, 0xbb, 0xcc, 0x11, 0x01),
        identity_binding(0xdd, 0xee, 0xff, 0x22, 0x02),
    ];
    let decoded = decode_request(&bound(&[first.clone(), second.clone()], &bindings)).unwrap();
    assert_eq!(decoded.target_household_id, Some(HouseholdId([0x99; 16])));
    assert_eq!(decoded.identity_bindings, bindings);
    assert_eq!(decoded.events[0].device_id, DeviceId([0x02; 16]));
    assert_eq!(&decoded.events[0].canonical_bytes[20..36], &[0xdd; 16]);
    assert_eq!(decoded.events[1].device_id, DeviceId([0x01; 16]));
    let state = rebuild(
        &decoded.events,
        0,
        CivilDate::from_encoded(20261002).unwrap(),
    )
    .unwrap();
    // Equal logical times reduce in device order; arrival order sets the boundary.
    assert_eq!(state.items[0].item_id.0, numbered_id(2));
    assert_eq!(state.items[1].item_id.0, numbered_id(3));
    let summary = summarize_validated(&decoded.events, None, &state).unwrap();
    assert_eq!(summary.through_event_id, Some(EventId(numbered_id(2))));
    let reversed = decode_request(&bound(&[second, first], &bindings)).unwrap();
    assert_eq!(
        state,
        rebuild(
            &reversed.events,
            0,
            CivilDate::from_encoded(20261002).unwrap()
        )
        .unwrap()
    );
}

#[test]
fn unbound_identities_and_malformed_binding_tables_fail_closed() {
    let record = distributed(1, 1, b"A", 0xaa, 0xbb, 0xcc, 1);
    assert_eq!(
        decode_request(&bound(std::slice::from_ref(&record), &[])),
        Err(KinError::InvalidEvent)
    );
    let mut truncated = bound(&[], &[identity_binding(0xaa, 0xbb, 0xcc, 0x11, 0x01)]);
    truncated.truncate(REQUEST_HEADER_BYTES + 95);
    assert_eq!(decode_request(&truncated), Err(KinError::MalformedProtocol));
    let duplicate = identity_binding(0xaa, 0xbb, 0xcc, 0x11, 0x01);
    assert_eq!(
        decode_request(&bound(&[], &[duplicate, duplicate])),
        Err(KinError::InvalidEvent)
    );
    let mut foreign = duplicate;
    foreign.household_id = HouseholdId([0x98; 16]);
    assert_eq!(
        decode_request(&bound(&[], &[foreign])),
        Err(KinError::InvalidEvent)
    );
    // A local request (zero target) cannot carry bindings.
    assert_eq!(
        decode_request(&bound_kine(&[], 0, TEST_DATE, None, None, &[duplicate])),
        Err(KinError::InvalidEvent)
    );
    let mut too_many = bound(&[], &[]);
    too_many[60..62].copy_from_slice(&257u16.to_le_bytes());
    assert_eq!(decode_request(&too_many), Err(KinError::SizeLimit));
    // Without a target, events from any one household replay as local history.
    assert!(decode_request(&kine(std::slice::from_ref(&record), 0, TEST_DATE, None)).is_ok());
}

#[test]
fn equal_time_terminal_archive_wins_over_concurrent_completion() {
    let bindings = [
        identity_binding(0xaa, 0xbb, 0xcc, 0x11, 0x01),
        identity_binding(0xdd, 0xee, 0xff, 0x22, 0x02),
    ];
    let added = distributed(1, 7, b"Task", 0xaa, 0xbb, 0xcc, 5);
    let archived = distributed_action(2, 4, 7, 0xaa, 0xbb, 0xcc, 6);
    let completed = distributed_action(3, 2, 7, 0xdd, 0xee, 0xff, 6);
    let decoded = decode_request(&bound(
        &[completed.clone(), archived.clone(), added.clone()],
        &bindings,
    ))
    .unwrap();
    let state = rebuild(&decoded.events, 0, date()).unwrap();
    assert_eq!(state.items[0].status, ItemStatus::Archived);
    assert!(decoded
        .events
        .iter()
        .any(|event| event.canonical_bytes == completed));
    let later = distributed_action(4, 2, 7, 0xdd, 0xee, 0xff, 7);
    let decoded = decode_request(&bound(&[added, archived, later], &bindings)).unwrap();
    assert_eq!(
        rebuild(&decoded.events, 0, date()).unwrap().items[0].status,
        ItemStatus::Archived
    );
}

#[test]
fn maximum_equal_time_history_replays_deterministically_with_arrival_boundary() {
    let records: Vec<Vec<u8>> = (1..=MAX_EVENT_COUNT as u32)
        .map(|number| distributed(number, number, b"x", 0xaa, 0xbb, 0xcc, 7))
        .collect();
    let bindings = [identity_binding(0xaa, 0xbb, 0xcc, 0x11, 0x01)];
    let decoded = decode_request(&bound(&records, &bindings)).unwrap();
    let state = rebuild(&decoded.events, 0, date()).unwrap();
    let mut expected: Vec<[u8; 16]> = (1..=MAX_EVENT_COUNT as u32).map(numbered_id).collect();
    expected.sort();
    assert_eq!(
        state
            .items
            .iter()
            .map(|item| item.item_id.0)
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(
        summarize_validated(&decoded.events, None, &state)
            .unwrap()
            .through_event_id,
        Some(EventId(numbered_id(MAX_EVENT_COUNT as u32)))
    );
}

#[test]
fn maximum_event_count_projects_within_the_result_limit() {
    let records: Vec<Vec<u8>> = (1..=MAX_EVENT_COUNT as u32)
        .map(|n| item_record(n, n, b"x", 1))
        .collect();
    let request = kine(&records, 0, TEST_DATE, None);
    assert!(request.len() <= MAX_PROTOCOL_BYTES);
    let first = replay(&request).unwrap();
    assert_eq!(header_u32(&first, 8), MAX_EVENT_COUNT as u32);
    assert!(first.len() <= MAX_PROTOCOL_BYTES);
    assert_eq!(first, replay(&request).unwrap());
    let mut too_many = kine(&[], 0, TEST_DATE, None);
    too_many[8..12].copy_from_slice(&(MAX_EVENT_COUNT as u32 + 1).to_le_bytes());
    assert_eq!(decode_request(&too_many), Err(KinError::SizeLimit));
}

#[test]
fn only_protocol_24_is_accepted() {
    for version in [0u16, 1, 2, 7, 8, 23, 25, 99, u16::MAX] {
        let mut request = kine(&[], 0, TEST_DATE, None);
        request[4..6].copy_from_slice(&version.to_le_bytes());
        assert_eq!(
            decode_request(&request),
            Err(KinError::UnsupportedVersion),
            "version {version}"
        );
    }
}

#[test]
fn header_truncation_reserved_fields_flags_time_date_and_trailing_bytes() {
    let request = kine(&[], 0, TEST_DATE, None);
    for length in 0..REQUEST_HEADER_BYTES {
        assert_eq!(
            decode_request(&request[..length]),
            Err(KinError::MalformedProtocol),
            "length {length}"
        );
    }
    for (offset, value) in [
        (6, 1),
        (7, 1),
        (20, 2),
        (21, 1),
        (22, 1),
        (23, 1),
        (24, 1),
        (39, 1),
        (62, 1),
        (63, 1),
    ] {
        let mut malformed = request.clone();
        malformed[offset] = value;
        assert_eq!(
            decode_request(&malformed),
            Err(KinError::MalformedProtocol),
            "offset {offset}"
        );
    }
    for time in [
        i64::MIN,
        -8_640_000_000_000_001,
        8_640_000_000_000_001,
        i64::MAX,
    ] {
        let mut malformed = request.clone();
        malformed[12..20].copy_from_slice(&time.to_le_bytes());
        assert_eq!(decode_request(&malformed), Err(KinError::MalformedProtocol));
    }
    for day in [0u32, 20260229, 20261301, u32::MAX] {
        assert_eq!(
            decode_request(&kine(&[], 0, day, None)),
            Err(KinError::MalformedProtocol)
        );
    }
    let mut trailing = request;
    trailing.push(0);
    assert_eq!(decode_request(&trailing), Err(KinError::MalformedProtocol));
}

#[test]
fn every_truncated_event_header_and_payload_is_rejected() {
    let record = item_record(1, 0x11, b"Milk", 1);
    for length in 0..record.len() {
        let mut request = kine(&[], 0, TEST_DATE, None);
        request[8] = 1;
        request.extend_from_slice(&record[..length]);
        assert_eq!(
            decode_request(&request),
            Err(KinError::MalformedProtocol),
            "record length {length}"
        );
    }
    let mut oversized = record;
    oversized[84..88].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(
        decode_request(&kine(&[oversized], 0, TEST_DATE, None)),
        Err(KinError::MalformedProtocol)
    );
}

#[test]
fn a_present_cursor_must_name_an_event() {
    let records = [item_record(1, 0x11, b"Milk", 1)];
    let mut request = kine(&records, 0, TEST_DATE, Some(numbered_id(1)));
    assert!(replay(&request).is_ok());
    request[24..40].fill(0); // flag still says present
    assert_eq!(replay(&request).unwrap_err(), KinError::MalformedProtocol);
}
