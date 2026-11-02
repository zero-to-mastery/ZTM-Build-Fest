use crate::command::{create_event, execute, CommandContext, HouseholdCommand};
use crate::event::{ActorId, DeviceId, EventId, EventKind, HouseholdId, HouseholdMode};
use crate::event_decode::decode_event;
use crate::request::decode_request;
use crate::state::{rebuild, summarize_validated};

fn context(device: u8, logical_time: u64) -> CommandContext {
    let mut event_id = [0; 16];
    event_id[0] = device;
    event_id[1] = logical_time as u8;
    CommandContext {
        event_id: EventId(event_id),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([device; 16]),
        timestamp: 1_760_000_000_000,
        logical_time,
    }
}

fn request(records: &[Vec<u8>]) -> Vec<u8> {
    crate::test_support::kine(records, 1_760_000_000_000, 20261009, None)
}

fn mode_event(device: u8, sequence: u64, mode: HouseholdMode) -> crate::event::EventEnvelope {
    create_event(
        &HouseholdCommand::SetHouseholdMode(mode),
        context(device, sequence),
    )
    .unwrap()
}

#[test]
fn old_histories_default_to_normal_and_mode_changes_replay() {
    let old = decode_request(&request(&[])).unwrap();
    assert_eq!(
        rebuild(&old.events, old.as_of, old.civil_date)
            .unwrap()
            .mode,
        HouseholdMode::Normal
    );

    let vacation = mode_event(1, 1, HouseholdMode::Vacation);
    let rest = mode_event(1, 2, HouseholdMode::Rest);
    let events = [vacation, rest];
    for _ in 0..2 {
        let decoded = decode_request(&request(
            &events
                .iter()
                .map(|event| event.canonical_bytes.clone())
                .collect::<Vec<_>>(),
        ))
        .unwrap();
        assert_eq!(
            rebuild(&decoded.events, decoded.as_of, decoded.civil_date)
                .unwrap()
                .mode,
            HouseholdMode::Rest
        );
    }
}

#[test]
fn duplicate_replayed_mode_events_are_idempotent_and_conflicts_are_stable() {
    let first = mode_event(1, 1, HouseholdMode::Vacation);
    let duplicate = first.clone();
    let second = mode_event(2, 1, HouseholdMode::Guests);
    for records in [
        vec![first.clone(), duplicate],
        vec![first.clone(), second.clone()],
        vec![second, first.clone()],
    ] {
        let decoded = decode_request(&request(
            &records
                .iter()
                .map(|event| event.canonical_bytes.clone())
                .collect::<Vec<_>>(),
        ))
        .unwrap();
        let state = rebuild(&decoded.events, decoded.as_of, decoded.civil_date).unwrap();
        if records.len() == 2 && records[0].event_id == records[1].event_id {
            assert_eq!(state.mode, HouseholdMode::Vacation);
        } else {
            assert_eq!(state.mode, HouseholdMode::Guests);
        }
    }
}

#[test]
fn mode_commands_project_the_mode_and_reject_repeats() {
    let vacation = mode_event(1, 1, HouseholdMode::Vacation);
    assert!(matches!(
        decode_event(&vacation.canonical_bytes).unwrap().kind,
        EventKind::HouseholdModeChanged {
            mode: HouseholdMode::Vacation
        }
    ));

    let initial_request = decode_request(&request(&[])).unwrap();
    let result = execute(
        &HouseholdCommand::SetHouseholdMode(HouseholdMode::Vacation),
        context(1, 1),
        initial_request,
    )
    .unwrap();
    assert_eq!(result.projection.mode, HouseholdMode::Vacation);
    assert_eq!(&result.encoded_projection[..6], b"KINS\x18\0");
    assert_eq!(result.encoded_projection[68], HouseholdMode::Vacation as u8);
    assert_eq!(result.encoded_projection[69..72], [0; 3]);
    let summary = summarize_validated(
        std::slice::from_ref(&result.event),
        None,
        &result.projection,
    )
    .unwrap();
    assert_eq!(
        crate::state_encode::encode_state(&result.projection, &summary).unwrap(),
        result.encoded_projection
    );
    let repeated = execute(
        &HouseholdCommand::SetHouseholdMode(HouseholdMode::Vacation),
        context(1, 2),
        decode_request(&request(&[result.event.canonical_bytes])).unwrap(),
    );
    assert_eq!(repeated.unwrap_err(), crate::error::KinError::InvalidEvent);
}
