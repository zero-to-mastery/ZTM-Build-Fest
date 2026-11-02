use crate::command::{create_event, execute, CommandContext, HouseholdCommand as C};
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::recurrence::CivilDate;
use crate::request::DecodedRequest;
use crate::state::{rebuild, ItemStatus, MAX_PINS};

/// Protocol-24 replay at a fixed instant and civil date for tests that do not
/// depend on time.
fn replay(
    events: &[crate::event::EventEnvelope],
) -> Result<crate::state::HouseholdState, crate::error::KinError> {
    crate::state::rebuild(
        events,
        0,
        crate::recurrence::CivilDate::from_encoded(20261003).unwrap(),
    )
}

fn context(n: u8) -> CommandContext {
    CommandContext {
        event_id: EventId([n; 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([3; 16]),
        timestamp: 1_760_000_000_000 + n as i64,
        logical_time: n as u64,
    }
}
fn request(events: Vec<EventEnvelope>) -> DecodedRequest {
    DecodedRequest {
        events,
        as_of: 1_760_000_000_000,
        summary_cursor: None,
        civil_date: CivilDate::from_encoded(20261009).unwrap(),
        target_household_id: None,
        identity_bindings: vec![],
    }
}
fn run(
    events: &mut Vec<EventEnvelope>,
    command: C,
    n: u8,
) -> Result<crate::command::CommandResult, KinError> {
    let result = execute(&command, context(n), request(events.clone()))?;
    events.push(result.event.clone());
    Ok(result)
}

#[test]
fn pin_target_is_stable_duplicate_add_and_remove_retry_are_idempotent() {
    let target = ItemId([8; 16]);
    let mut events = vec![];
    run(
        &mut events,
        C::AddItem {
            id: target,
            text: "Check filter".into(),
            classification: ItemClassification::Need,
        },
        1,
    )
    .unwrap();
    for n in [2, 3] {
        run(
            &mut events,
            C::Pin {
                target_kind: PinTargetKind::Item,
                target_id: target.0,
            },
            n,
        )
        .unwrap();
    }
    assert_eq!(replay(&events).unwrap().pins.len(), 1);
    for n in [4, 5] {
        run(
            &mut events,
            C::Unpin {
                target_kind: PinTargetKind::Item,
                target_id: target.0,
            },
            n,
        )
        .unwrap();
    }
    assert!(replay(&events).unwrap().pins.is_empty());
    assert_eq!(decode_event(&events[1].canonical_bytes).unwrap(), events[1]);
}

#[test]
fn pin_rejects_unknown_target_and_enforces_household_bound() {
    let mut events = vec![];
    assert!(run(
        &mut events,
        C::Pin {
            target_kind: PinTargetKind::Item,
            target_id: [99; 16]
        },
        1
    )
    .is_err());
    let mut sequence = 1u8;
    for n in 1..=MAX_PINS as u8 {
        let item = ItemId([n; 16]);
        run(
            &mut events,
            C::AddItem {
                id: item,
                text: format!("Item {n}"),
                classification: ItemClassification::Need,
            },
            sequence,
        )
        .unwrap();
        sequence += 1;
        run(
            &mut events,
            C::Pin {
                target_kind: PinTargetKind::Item,
                target_id: item.0,
            },
            sequence,
        )
        .unwrap();
        sequence += 1;
    }
    let last = ItemId([42; 16]);
    run(
        &mut events,
        C::AddItem {
            id: last,
            text: "Over limit".into(),
            classification: ItemClassification::Need,
        },
        sequence,
    )
    .unwrap();
    sequence += 1;
    assert_eq!(
        run(
            &mut events,
            C::Pin {
                target_kind: PinTargetKind::Item,
                target_id: last.0
            },
            sequence
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
    assert_eq!(replay(&events).unwrap().pins.len(), MAX_PINS);
}

#[test]
fn archived_targets_are_removed_from_quick_access_projection() {
    let target = ItemId([12; 16]);
    let mut events = vec![];
    run(
        &mut events,
        C::AddItem {
            id: target,
            text: "Seasonal task".into(),
            classification: ItemClassification::Need,
        },
        1,
    )
    .unwrap();
    run(
        &mut events,
        C::Pin {
            target_kind: PinTargetKind::Item,
            target_id: target.0,
        },
        2,
    )
    .unwrap();
    run(&mut events, C::ArchiveItem(target), 3).unwrap();
    let state = replay(&events).unwrap();
    assert!(state.pins.is_empty());
    assert_eq!(state.items[0].status, ItemStatus::Archived);
}

#[test]
fn distributed_concurrent_pin_and_unpin_converge_in_device_order() {
    let target = ItemId([13; 16]);
    let mut added = create_event(
        &C::AddItem {
            id: target,
            text: "Read meter".into(),
            classification: ItemClassification::Need,
        },
        context(1),
    )
    .unwrap();
    added.canonical_bytes = crate::codec::encode_event(&added).unwrap();
    let mut pin_context = context(2);
    pin_context.logical_time = 2;
    pin_context.device_id = DeviceId([4; 16]);
    let pin = create_event(
        &C::Pin {
            target_kind: PinTargetKind::Item,
            target_id: target.0,
        },
        pin_context,
    )
    .unwrap();
    let mut unpin_context = context(3);
    unpin_context.logical_time = 2;
    unpin_context.device_id = DeviceId([5; 16]);
    let unpin = create_event(
        &C::Unpin {
            target_kind: PinTargetKind::Item,
            target_id: target.0,
        },
        unpin_context,
    )
    .unwrap();
    let mut events = vec![added, pin, unpin];
    for event in &mut events {
        event.canonical_bytes = crate::codec::encode_event(event).unwrap();
    }
    let first = rebuild(
        &events,
        1_760_000_000_000,
        CivilDate::from_encoded(20261009).unwrap(),
    )
    .unwrap();
    events.reverse();
    let second = rebuild(
        &events,
        1_760_000_000_000,
        CivilDate::from_encoded(20261009).unwrap(),
    )
    .unwrap();
    assert_eq!(first, second);
    assert!(first.pins.is_empty());
}
