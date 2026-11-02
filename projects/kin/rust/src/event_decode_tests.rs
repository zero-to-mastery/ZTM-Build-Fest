// Canonical event decoding plus the Handoff and Talk lifecycles it feeds.
use crate::error::KinError;
use crate::event::{ActorId, EventKind, ItemClassification};
use crate::event_decode::decode_event;
use crate::recurrence::CivilDate;
use crate::request::decode_request;
use crate::state::{rebuild, HandoffStatus, HouseholdState, TalkStatus};
use crate::test_support::*;
use crate::wire::{EVENT_HEADER_BYTES, MAX_ITEM_TEXT_BYTES};

fn project(records: &[Vec<u8>]) -> Result<HouseholdState, KinError> {
    let request = decode_request(&kine(records, 0, TEST_DATE, None))?;
    rebuild(
        &request.events,
        request.as_of,
        CivilDate::from_encoded(TEST_DATE).unwrap(),
    )
}

fn handoff(kind: u16, event: u32) -> Vec<u8> {
    if kind == 5 {
        text_record(5, event, 0x11, b"Dishwasher running")
    } else {
        reference_record(kind, event, 0x11)
    }
}

fn talk(kind: u16, event: u32) -> Vec<u8> {
    if kind == 8 {
        text_record(8, event, 0x11, b"Dishwasher running")
    } else {
        reference_record(kind, event, 0x11)
    }
}

#[test]
fn canonical_bytes_are_kept_exactly() {
    let record = item_record(1, 0x22, "\u{feff}milk 🥛".as_bytes(), 1);
    let event = decode_event(&record).unwrap();
    assert_eq!(event.canonical_bytes, record);
    assert!(
        matches!(&event.kind, EventKind::ItemAdded { text, classification: ItemClassification::Need, .. } if text == "\u{feff}milk 🥛")
    );
}

#[test]
fn classification_codes_and_reserved_bytes() {
    for (code, expected) in [
        (0, ItemClassification::Today),
        (1, ItemClassification::Need),
        (2, ItemClassification::Shopping),
        (3, ItemClassification::Staple),
    ] {
        let event = decode_event(&item_record(1, 0x11, b"Milk", code)).unwrap();
        assert!(
            matches!(event.kind, EventKind::ItemAdded { classification, .. } if classification == expected)
        );
    }
    for code in [4u8, 255] {
        assert_eq!(
            decode_event(&item_record(1, 0x11, b"Milk", code)),
            Err(KinError::MalformedProtocol)
        );
    }
    for offset in 17..20 {
        let mut record = item_record(1, 0x11, b"Milk", 0);
        record[EVENT_HEADER_BYTES + offset] = 1;
        assert_eq!(decode_event(&record), Err(KinError::MalformedProtocol));
    }
}

#[test]
fn schemas_and_kinds_outside_protocol_24_are_unsupported() {
    let add = item_record(1, 0x11, b"Milk", 0);
    for schema in [0u16, 1, 3, u16::MAX] {
        let mut record = add.clone();
        record[..2].copy_from_slice(&schema.to_le_bytes());
        assert_eq!(
            decode_event(&record),
            Err(KinError::UnsupportedVersion),
            "add schema {schema}"
        );
    }
    for kind in [2u16, 5, 12, 29, 41, 42, 43, 51] {
        let mut record = reference_record(kind, 1, 0x11);
        record[..2].copy_from_slice(&2u16.to_le_bytes());
        assert_eq!(
            decode_event(&record),
            Err(KinError::UnsupportedVersion),
            "kind {kind} schema 2"
        );
    }
    // 52–58 are the fridge (#317), 59–63 meals (#333), 64 item emoji (#344),
    // 65 chat topics (#312), 66–67 store sections (#411), 68–69 routine
    // rotations (#429), 70 the sitter page (#442), 71–74 the family calendar
    // (#656), 75–76 the family album (#673), 77–79 the chore chart (#676),
    // 80–82 meal plans (#679); 83 is the first unassigned kind.
    for kind in [0u16, 83, 99, u16::MAX] {
        assert_eq!(
            decode_event(&reference_record(kind, 1, 0x11)),
            Err(KinError::UnsupportedVersion)
        );
    }
}

#[test]
fn fixed_length_payloads_are_exact() {
    for kind in [2u16, 3, 4, 6, 7, 9, 10, 11] {
        for length in (0..=17).filter(|length| *length != 16) {
            let mut record = reference_record(kind, 1, 0x11);
            record[84..88].copy_from_slice(&(length as u32).to_le_bytes());
            record.resize(EVENT_HEADER_BYTES + length, 0);
            assert_eq!(
                decode_event(&record),
                Err(KinError::MalformedProtocol),
                "kind {kind} length {length}"
            );
        }
    }
}

#[test]
fn text_lengths_and_encoding_are_validated() {
    for kind in [5u16, 8] {
        let mut mismatched = text_record(kind, 1, 0x11, b"hi");
        mismatched[EVENT_HEADER_BYTES + 16..EVENT_HEADER_BYTES + 20]
            .copy_from_slice(&5u32.to_le_bytes());
        assert_eq!(decode_event(&mismatched), Err(KinError::MalformedProtocol));
        for text in [Vec::new(), vec![b'x'; MAX_ITEM_TEXT_BYTES + 1], vec![0xff]] {
            assert_eq!(
                decode_event(&text_record(kind, 1, 0x11, &text)),
                Err(KinError::MalformedProtocol)
            );
        }
        assert!(decode_event(&text_record(
            kind,
            1,
            0x11,
            &vec![b'x'; MAX_ITEM_TEXT_BYTES]
        ))
        .is_ok());
        // Blank text decodes but is not a valid household entry.
        assert_eq!(
            project(&[text_record(kind, 1, 0x11, b" \t\n")]),
            Err(KinError::InvalidEvent)
        );
    }
    for text in [Vec::new(), vec![b'x'; MAX_ITEM_TEXT_BYTES + 1], vec![0xff]] {
        assert_eq!(
            decode_event(&item_record(1, 0x11, &text, 1)),
            Err(KinError::MalformedProtocol)
        );
    }
    let mut trailing = text_record(5, 1, 0x11, b"x");
    trailing.push(0);
    let length = (trailing.len() - EVENT_HEADER_BYTES) as u32;
    trailing[84..88].copy_from_slice(&length.to_le_bytes());
    assert_eq!(decode_event(&trailing), Err(KinError::MalformedProtocol));
}

#[test]
fn handoff_lifecycle_terminal_archive_and_provenance() {
    for kinds in [
        vec![5],
        vec![5, 6],
        vec![5, 6, 6],
        vec![5, 7],
        vec![5, 6, 7],
    ] {
        let records: Vec<_> = kinds
            .iter()
            .enumerate()
            .map(|(i, k)| handoff(*k, i as u32 + 1))
            .collect();
        let state = project(&records).unwrap();
        let entry = &state.handoffs[0];
        assert_eq!(
            (entry.created_by, entry.created_at, entry.text.as_str()),
            (ActorId([0xbb; 16]), 1, "Dishwasher running")
        );
        assert_eq!(
            entry.status,
            match kinds.last().unwrap() {
                5 => HandoffStatus::Unacknowledged,
                6 => HandoffStatus::Acknowledged,
                _ => HandoffStatus::Archived,
            }
        );
        if entry.status == HandoffStatus::Archived {
            for kind in [5, 6, 7] {
                let mut invalid = records.clone();
                invalid.push(handoff(kind, invalid.len() as u32 + 1));
                assert_eq!(project(&invalid), Err(KinError::InvalidEvent));
            }
        }
    }
    for kind in [6, 7] {
        assert_eq!(project(&[handoff(kind, 1)]), Err(KinError::InvalidEvent));
    }
    let mut acknowledgement = handoff(6, 2);
    acknowledgement[36..52].fill(0xdd);
    let state = project(&[handoff(5, 1), acknowledgement]).unwrap();
    assert_eq!(state.handoffs[0].created_by, ActorId([0xbb; 16]));
    assert_eq!(state.handoffs[0].status, HandoffStatus::Acknowledged);
}

#[test]
fn talk_lifecycle_and_terminal_archive() {
    for (kinds, expected) in [
        (vec![8], TalkStatus::Open),
        (vec![8, 9], TalkStatus::Resolved),
        (vec![8, 9, 9], TalkStatus::Resolved),
        (vec![8, 9, 10], TalkStatus::Open),
        (vec![8, 10], TalkStatus::Open),
        (vec![8, 11], TalkStatus::Archived),
        (vec![8, 9, 11], TalkStatus::Archived),
    ] {
        let records: Vec<_> = kinds
            .iter()
            .enumerate()
            .map(|(i, k)| talk(*k, i as u32 + 1))
            .collect();
        let state = project(&records).unwrap();
        assert_eq!(state.talks[0].status, expected);
        if expected == TalkStatus::Archived {
            for kind in [8, 9, 10, 11] {
                let mut invalid = records.clone();
                invalid.push(talk(kind, invalid.len() as u32 + 1));
                assert_eq!(project(&invalid), Err(KinError::InvalidEvent));
            }
        }
    }
    for kind in [9, 10, 11] {
        assert_eq!(project(&[talk(kind, 1)]), Err(KinError::InvalidEvent));
    }
}

#[test]
fn duplicate_delivery_is_idempotent_and_conflicts_fail() {
    for record in [handoff(5, 1), talk(8, 1), item_record(1, 0x11, b"Milk", 1)] {
        let state = project(&[record.clone(), record.clone()]).unwrap();
        assert_eq!(
            state.items.len() + state.handoffs.len() + state.talks.len(),
            1
        );
        let mut conflict = record.clone();
        *conflict.last_mut().unwrap() = b'x';
        assert_eq!(
            project(&[record.clone(), conflict]),
            Err(KinError::InvalidEvent)
        );
    }
    // Entity namespaces are separate: one raw ID may name an Item, Handoff and Talk.
    let state = project(&[item_record(1, 0x11, b"Item", 1), handoff(5, 2), talk(8, 3)]).unwrap();
    assert_eq!(
        (state.items.len(), state.handoffs.len(), state.talks.len()),
        (1, 1, 1)
    );
}
