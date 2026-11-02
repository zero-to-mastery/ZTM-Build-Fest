// Protocol-24 projection layout, bounds and determinism.
use crate::core::replay;
use crate::error::KinError;
use crate::event::{EventId, ItemClassification};
use crate::recurrence::CivilDate;
use crate::state::{
    rebuild, CatchUpSummary, HouseholdState, SummaryEntityKind, SummaryEntry, SummaryKind,
};
use crate::state_encode::encode_state;
use crate::test_support::*;
use crate::wire::{MAX_EVENT_COUNT, MAX_PROTOCOL_BYTES};

fn none() -> CatchUpSummary {
    CatchUpSummary {
        entries: Vec::new(),
        total_count: 0,
        through_event_id: None,
    }
}

fn project(records: &[Vec<u8>]) -> HouseholdState {
    let request = crate::request::decode_request(&kine(records, 0, TEST_DATE, None)).unwrap();
    rebuild(
        &request.events,
        0,
        CivilDate::from_encoded(TEST_DATE).unwrap(),
    )
    .unwrap()
}

#[test]
fn item_record_carries_classification_status_and_last_changed() {
    let state = project(&[
        item_record(1, 0x22, b"Buy wipes", 3),
        reference_record(4, 2, 0x22),
    ]);
    let bytes = encode_state(&state, &none()).unwrap();
    assert_eq!(header_u32(&bytes, 8), 1);
    assert_eq!(&bytes[BODY..BODY + 16], &numbered_id(0x22));
    assert_eq!(&bytes[BODY + 16..BODY + 32], &[0xbb; 16]);
    assert_eq!(&bytes[BODY + 32..BODY + 40], &1i64.to_le_bytes());
    assert_eq!(&bytes[BODY + 40..BODY + 44], &[3, 2, 0, 0]); // Staple, archived
    assert_eq!(header_u32(&bytes, BODY + 44), 9);
    let after_text = BODY + 48 + 9;
    // Per-Item Area ID, planning date, then last-changed timestamp.
    assert_eq!(&bytes[after_text..after_text + 16], &[0; 16]);
    assert_eq!(header_u32(&bytes, after_text + 16), 0);
    assert_eq!(
        &bytes[after_text + 20..after_text + 28],
        &2i64.to_le_bytes()
    );
    assert_eq!(bytes.len(), after_text + 28);
}

#[test]
fn handoff_and_talk_records_follow_items_in_order() {
    let state = project(&[
        item_record(1, 0x11, b"Item", 1),
        text_record(5, 2, 0x11, b"Dishwasher running"),
        text_record(8, 3, 0x11, b"Dishwasher running"),
        reference_record(9, 4, 0x11),
    ]);
    let bytes = encode_state(&state, &none()).unwrap();
    assert_eq!(
        [
            header_u32(&bytes, 8),
            header_u32(&bytes, 12),
            header_u32(&bytes, 16)
        ],
        [1, 1, 1]
    );
    // The Items section ends with the Item's Area ID, planning date and last change.
    let handoff = BODY + 48 + 4 + 16 + 4 + 8;
    assert_eq!(&bytes[handoff..handoff + 16], &numbered_id(0x11));
    assert_eq!(&bytes[handoff + 32..handoff + 40], &2i64.to_le_bytes());
    assert_eq!(&bytes[handoff + 40..handoff + 44], &[0; 4]); // unacknowledged
    assert_eq!(header_u32(&bytes, handoff + 44), 18);
    assert_eq!(&bytes[handoff + 48..handoff + 66], b"Dishwasher running");
    let talk = handoff + 66;
    assert_eq!(&bytes[talk + 40..talk + 44], &[1, 0, 0, 0]); // resolved
}

#[test]
fn combined_entity_limit_is_enforced() {
    let mut state = project(&[
        item_record(1, 0x11, b"Milk", 1),
        text_record(5, 2, 0x11, b"x"),
        text_record(8, 3, 0x11, b"x"),
    ]);
    state.items.resize(3333, state.items[0].clone());
    state.handoffs.resize(3333, state.handoffs[0].clone());
    state.talks.resize(3334, state.talks[0].clone());
    assert!(encode_state(&state, &none()).is_ok());
    state.talks.push(state.talks[0].clone());
    assert_eq!(encode_state(&state, &none()), Err(KinError::SizeLimit));
}

#[test]
fn summary_entries_encode_codes_and_must_be_consistent() {
    let empty = project(&[]);
    let entry = SummaryEntry {
        event_id: EventId([0x24; 16]),
        kind: SummaryKind::ItemAdded,
        entity_kind: SummaryEntityKind::Item,
        text: "Laundry detergent".into(),
        classification: Some(ItemClassification::Staple),
    };
    let summary = CatchUpSummary {
        entries: vec![entry.clone()],
        total_count: 1,
        through_event_id: Some(EventId([0x24; 16])),
    };
    let bytes = encode_state(&empty, &summary).unwrap();
    assert_eq!(&bytes[BODY..BODY + 16], &[0x24; 16]);
    assert_eq!(&bytes[BODY + 16..BODY + 20], &[1, 1, 3, 0]);
    for broken in [
        CatchUpSummary {
            total_count: 0,
            ..summary.clone()
        },
        CatchUpSummary {
            through_event_id: None,
            ..summary.clone()
        },
        CatchUpSummary {
            entries: vec![SummaryEntry {
                classification: None,
                ..entry.clone()
            }],
            ..summary.clone()
        },
        CatchUpSummary {
            entries: vec![SummaryEntry {
                entity_kind: SummaryEntityKind::Talk,
                ..entry.clone()
            }],
            ..summary.clone()
        },
        CatchUpSummary {
            entries: vec![SummaryEntry {
                text: String::new(),
                ..entry
            }],
            ..summary
        },
    ] {
        assert_eq!(
            encode_state(&empty, &broken),
            Err(KinError::MalformedProtocol)
        );
    }
}

#[test]
fn maximum_mixed_replay_is_deterministic_and_ordered() {
    let records: Vec<Vec<u8>> = (1..=MAX_EVENT_COUNT as u32)
        .map(|n| match n % 3 {
            0 => item_record(n, n, b"x", 1),
            1 => text_record(5, n, n, b"x"),
            _ => text_record(8, n, n, b"x"),
        })
        .collect();
    let request = kine(&records, 0, TEST_DATE, None);
    let result = replay(&request).unwrap();
    assert_eq!(
        [
            header_u32(&result, 8),
            header_u32(&result, 12),
            header_u32(&result, 16)
        ],
        [3333, 3334, 3333]
    );
    assert!(result.len() < MAX_PROTOCOL_BYTES);
    assert_eq!(result, replay(&request).unwrap());
    let state = project(&records);
    for ids in [
        state
            .items
            .iter()
            .map(|row| row.item_id.0)
            .collect::<Vec<_>>(),
        state.handoffs.iter().map(|row| row.handoff_id.0).collect(),
        state.talks.iter().map(|row| row.talk_id.0).collect(),
    ] {
        assert!(ids
            .windows(2)
            .all(|pair| u32::from_le_bytes(pair[0][..4].try_into().unwrap())
                < u32::from_le_bytes(pair[1][..4].try_into().unwrap())));
    }
}
