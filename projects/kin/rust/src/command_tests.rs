use crate::codec::{encode_event, metadata};
use crate::command::{
    create_event, decode_command, execute, CommandContext, HouseholdCommand as C,
};
use crate::error::KinError;
use crate::event::*;
use crate::protocol::{decode_event, DecodedRequest};
use crate::recurrence::{Cadence, CivilDate};
use crate::state::ItemStatus;

fn day() -> CivilDate {
    CivilDate::from_encoded(20261003).unwrap()
}
fn context(sequence: u8) -> CommandContext {
    CommandContext {
        event_id: EventId([sequence; 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([3; 16]),
        timestamp: 1234,
        logical_time: u64::from(sequence),
    }
}
fn request(events: Vec<EventEnvelope>) -> DecodedRequest {
    DecodedRequest {
        protocol_version: 7,
        events,
        as_of: Some(1234),
        summary_cursor: None,
        civil_date: Some(day()),
        target_household_id: None,
        identity_bindings: vec![],
    }
}
fn add() -> C {
    C::AddItem {
        id: ItemId([4; 16]),
        text: "Milk 🥛".to_owned(),
        classification: ItemClassification::Need,
    }
}

#[test]
fn commands_emit_canonical_events_and_project_full_lifecycle() {
    let mut events = vec![];
    for (index, command, expected) in [
        (1, add(), ItemStatus::Active),
        (2, C::CompleteItem(ItemId([4; 16])), ItemStatus::Completed),
        (3, C::ReopenItem(ItemId([4; 16])), ItemStatus::Active),
        (4, C::ArchiveItem(ItemId([4; 16])), ItemStatus::Archived),
    ] {
        let result = execute(&command, context(index), request(events.clone())).unwrap();
        assert_eq!(result.projection.items[0].status, expected);
        assert_eq!(
            metadata(&result.event.canonical_bytes).unwrap().event_id,
            context(index).event_id
        );
        assert_eq!(
            encode_event(&result.event).unwrap(),
            result.event.canonical_bytes
        );
        events.push(result.event);
    }
    assert!(execute(&C::ReopenItem(ItemId([4; 16])), context(5), request(events)).is_err());
}

#[test]
fn every_command_has_a_lossless_canonical_roundtrip() {
    let commands = [
        add(),
        C::CompleteItem(ItemId([4; 16])),
        C::ReopenItem(ItemId([4; 16])),
        C::ArchiveItem(ItemId([4; 16])),
        C::CaptureHandoff {
            id: HandoffId([4; 16]),
            text: "Context".into(),
        },
        C::AcknowledgeHandoff(HandoffId([4; 16])),
        C::ArchiveHandoff(HandoffId([4; 16])),
        C::CaptureTalk {
            id: TalkId([4; 16]),
            text: "Later".into(),
        },
        C::ResolveTalk(TalkId([4; 16])),
        C::ReopenTalk(TalkId([4; 16])),
        C::ArchiveTalk(TalkId([4; 16])),
        C::SetPulse {
            value: PulseValue::NeedQuiet,
            expires_at: 6000,
        },
        C::ClearPulse,
        C::CreateRoutine {
            id: RoutineId([4; 16]),
            text: "Water".into(),
            cadence: Cadence::Daily,
            created_on: day(),
        },
        C::CompleteOccurrence {
            id: RoutineId([4; 16]),
            key: day(),
        },
        C::ReopenOccurrence {
            id: RoutineId([4; 16]),
            key: day(),
        },
        C::ArchiveRoutine(RoutineId([4; 16])),
    ];
    for command in commands {
        let event = create_event(&command, context(1)).unwrap();
        let decoded = decode_event(&event.canonical_bytes, 8).unwrap();
        assert_eq!(event, decoded);
        assert_eq!(encode_event(&decoded).unwrap(), event.canonical_bytes);
        for end in 0..event.canonical_bytes.len() {
            assert!(metadata(&event.canonical_bytes[..end]).is_err());
        }
    }
}

#[test]
fn codec_preserves_legacy_schema_one_and_rejects_lossy_schema() {
    let mut event = create_event(&add(), context(1)).unwrap();
    event.event_version = 1;
    assert_eq!(encode_event(&event), Err(KinError::UnsupportedVersion));
    if let EventKind::ItemAdded { classification, .. } = &mut event.kind {
        *classification = ItemClassification::Today;
    }
    let bytes = encode_event(&event).unwrap();
    assert_eq!(&bytes[..4], &[1, 0, 1, 0]);
    assert_eq!(bytes.len(), 108 + "Milk 🥛".len());
    for protocol in 1..=8 {
        let decoded = decode_event(&bytes, protocol).unwrap();
        assert_eq!(encode_event(&decoded).unwrap(), bytes);
    }
    assert!(decode_event(&bytes, 9).is_err());
}

#[test]
fn stale_routine_intent_is_rejected_without_changing_replay_semantics() {
    let id = RoutineId([4; 16]);
    let create = C::CreateRoutine {
        id,
        text: "Water".into(),
        cadence: Cadence::Daily,
        created_on: day(),
    };
    let complete = C::CompleteOccurrence { id, key: day() };
    let first = execute(&create, context(1), request(vec![])).unwrap().event;
    let second = execute(&complete, context(2), request(vec![first.clone()]))
        .unwrap()
        .event;
    assert!(execute(
        &complete,
        context(3),
        request(vec![first.clone(), second.clone()])
    )
    .is_err());
    assert!(execute(
        &C::CompleteOccurrence {
            id,
            key: CivilDate::from_encoded(20261002).unwrap()
        },
        context(3),
        request(vec![first.clone(), second.clone()])
    )
    .is_err());
    assert!(execute(
        &C::ReopenOccurrence { id, key: day() },
        context(3),
        request(vec![first.clone(), second.clone()])
    )
    .is_ok());
    // Repeated historic completions remain valid idempotent facts in replay.
    let duplicate_fact = create_event(&complete, context(3)).unwrap();
    assert!(crate::core::project(&request(vec![first, second, duplicate_fact])).is_ok());
}

#[test]
fn command_rejects_unknown_references_identity_order_and_invalid_text() {
    assert!(execute(
        &C::CompleteItem(ItemId([4; 16])),
        context(1),
        request(vec![])
    )
    .is_err());
    let event = execute(&add(), context(1), request(vec![])).unwrap().event;
    let mut wrong = context(2);
    wrong.household_id = HouseholdId([8; 16]);
    assert!(execute(&add(), wrong, request(vec![event.clone()])).is_err());
    assert!(execute(&add(), context(1), request(vec![event])).is_err());
    for text in [" ".to_owned(), "".to_owned(), "x".repeat(4097)] {
        assert!(execute(
            &C::AddItem {
                id: ItemId([4; 16]),
                text,
                classification: ItemClassification::Need
            },
            context(1),
            request(vec![])
        )
        .is_err());
    }
    let mut invalid = context(1);
    invalid.timestamp = i64::MAX;
    assert!(execute(&add(), invalid, request(vec![])).is_err());
}

#[test]
fn command_transport_rejects_all_truncations_versions_and_unused_fields() {
    let mut packet = vec![0; 128];
    packet[..8].copy_from_slice(b"KCMD\x01\0\0\0");
    packet[8] = 13; // ClearPulse, all other command fields zero.
    for end in 0..packet.len() {
        assert!(decode_command(&packet[..end]).is_err());
    }
    assert!(decode_command(&packet).is_ok());
    for offset in [6, 7, 10, 11, 92, 108, 112, 113, 114, 115, 116, 124] {
        let mut bad = packet.clone();
        bad[offset] = 1;
        assert!(decode_command(&bad).is_err(), "offset {offset}");
    }
    packet[4] = 2;
    assert_eq!(decode_command(&packet), Err(KinError::UnsupportedVersion));
}

#[test]
fn batch_metadata_is_bounded_and_fails_atomically() {
    use crate::codec::{encode_metadata, encode_metadata_batch};
    let event = create_event(&add(), context(1)).unwrap();
    let mut request = Vec::new();
    request.extend_from_slice(b"KMDQ\x01\0\0\0");
    request.extend_from_slice(&2u32.to_le_bytes());
    for _ in 0..2 {
        request.extend_from_slice(&(event.canonical_bytes.len() as u32).to_le_bytes());
        request.extend_from_slice(&event.canonical_bytes);
    }
    let result = encode_metadata_batch(&request).unwrap();
    assert_eq!(result.len(), 12 + 92 * 2);
    assert_eq!(
        &result[12..104],
        encode_metadata(&event.canonical_bytes).unwrap()
    );
    for end in 0..request.len() {
        assert!(encode_metadata_batch(&request[..end]).is_err());
    }
    let mut trailing = request.clone();
    trailing.push(0);
    assert!(encode_metadata_batch(&trailing).is_err());
    request[8..12].copy_from_slice(&10001u32.to_le_bytes());
    assert_eq!(encode_metadata_batch(&request), Err(KinError::SizeLimit));
}
