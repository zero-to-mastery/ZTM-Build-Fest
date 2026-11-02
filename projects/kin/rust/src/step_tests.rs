use crate::command::{create_event, execute, CommandContext, HouseholdCommand as C};
use crate::event::*;
use crate::event_decode::decode_event;
use crate::recurrence::CivilDate;
use crate::request::DecodedRequest;
use crate::state::{
    normalize_step_text, rebuild, HouseholdState, ItemStatus, MAX_STEPS_PER_ITEM,
    MAX_STEP_TEXT_BYTES, MAX_STEP_TEXT_CHARS,
};

fn date() -> CivilDate {
    CivilDate::from_encoded(20261008).unwrap()
}

fn context(sequence: u8, logical_time: u64, device: u8) -> CommandContext {
    CommandContext {
        event_id: EventId([sequence; 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([device; 16]),
        timestamp: 1_791_475_200_000 + i64::from(sequence),
        logical_time,
    }
}

fn request(events: Vec<EventEnvelope>) -> DecodedRequest {
    DecodedRequest {
        events,
        as_of: 1_791_475_200_000,
        summary_cursor: None,
        civil_date: date(),
        target_household_id: None,
        identity_bindings: vec![],
    }
}

fn apply(
    events: &[EventEnvelope],
    command: C,
    sequence: u8,
    logical_time: u64,
    device: u8,
) -> Result<crate::command::CommandResult, crate::error::KinError> {
    execute(
        &command,
        context(sequence, logical_time, device),
        request(events.to_vec()),
    )
}

fn item() -> EventEnvelope {
    create_event(
        &C::AddItem {
            id: ItemId([10; 16]),
            text: "Clean kitchen".into(),
            classification: ItemClassification::Need,
        },
        context(1, 1, 1),
    )
    .unwrap()
}

fn add_step(
    item_id: ItemId,
    step_id: StepId,
    text: &str,
    sequence: u8,
    logical_time: u64,
    device: u8,
) -> EventEnvelope {
    create_event(
        &C::AddItemStep {
            item_id,
            step_id,
            text: text.into(),
        },
        context(sequence, logical_time, device),
    )
    .unwrap()
}

#[test]
fn step_lifecycle_keeps_stable_identity_order_and_parent_independence() {
    let item = item();
    let first_id = StepId([20; 16]);
    let second_id = StepId([21; 16]);
    let first = apply(
        std::slice::from_ref(&item),
        C::AddItemStep {
            item_id: ItemId([10; 16]),
            step_id: first_id,
            text: "  Clear counters  ".into(),
        },
        2,
        2,
        1,
    )
    .unwrap()
    .event;
    let second = apply(
        &[item.clone(), first.clone()],
        C::AddItemStep {
            item_id: ItemId([10; 16]),
            step_id: second_id,
            text: "Wipe stove".into(),
        },
        3,
        3,
        1,
    )
    .unwrap()
    .event;
    let completed_first = apply(
        &[item.clone(), first.clone(), second.clone()],
        C::CompleteItemStep {
            item_id: ItemId([10; 16]),
            step_id: first_id,
        },
        4,
        4,
        1,
    )
    .unwrap()
    .event;
    let completed_second = apply(
        &[
            item.clone(),
            first.clone(),
            second.clone(),
            completed_first.clone(),
        ],
        C::CompleteItemStep {
            item_id: ItemId([10; 16]),
            step_id: second_id,
        },
        5,
        5,
        1,
    )
    .unwrap()
    .projection;
    assert_eq!(completed_second.items[0].status, ItemStatus::Active);
    assert_eq!(completed_second.items[0].steps[0].step_id, first_id);
    assert_eq!(completed_second.items[0].steps[0].text, "Clear counters");
    assert!(completed_second.items[0]
        .steps
        .iter()
        .all(|step| step.completed));

    let reopened = apply(
        &[
            item.clone(),
            first.clone(),
            second.clone(),
            completed_first.clone(),
        ],
        C::ReopenItemStep {
            item_id: ItemId([10; 16]),
            step_id: first_id,
        },
        6,
        6,
        1,
    )
    .unwrap()
    .event;
    let archived = apply(
        &[
            item.clone(),
            first.clone(),
            second.clone(),
            completed_first,
            reopened,
        ],
        C::ArchiveItemStep {
            item_id: ItemId([10; 16]),
            step_id: first_id,
        },
        7,
        7,
        1,
    )
    .unwrap()
    .projection;
    assert_eq!(archived.items[0].status, ItemStatus::Active);
    assert!(archived.items[0].steps[0].archived);
    assert!(!archived.items[0].steps[0].completed);
}

#[test]
fn invalid_item_step_commands_fail_before_returning_an_event() {
    let item = item();
    let events = vec![item.clone()];
    let invalid = [
        C::AddItemStep {
            item_id: ItemId([99; 16]),
            step_id: StepId([20; 16]),
            text: "Step".into(),
        },
        C::CompleteItemStep {
            item_id: ItemId([10; 16]),
            step_id: StepId([99; 16]),
        },
    ];
    for command in invalid {
        assert!(apply(&events, command, 2, 2, 1).is_err());
        assert_eq!(events.len(), 1);
    }

    let step_id = StepId([20; 16]);
    let step = add_step(ItemId([10; 16]), step_id, "Step", 2, 2, 1);
    let completed = apply(
        &[item.clone(), step.clone()],
        C::CompleteItem(ItemId([10; 16])),
        3,
        3,
        1,
    )
    .unwrap()
    .event;
    assert!(apply(
        &[item.clone(), step.clone(), completed.clone()],
        C::AddItemStep {
            item_id: ItemId([10; 16]),
            step_id: StepId([21; 16]),
            text: "Blocked".into(),
        },
        4,
        4,
        1,
    )
    .is_err());
    assert!(apply(
        &[item.clone(), step.clone(), completed],
        C::CompleteItemStep {
            item_id: ItemId([10; 16]),
            step_id,
        },
        5,
        5,
        1,
    )
    .is_err());

    let archived_item = apply(
        &[item.clone(), step.clone()],
        C::ArchiveItem(ItemId([10; 16])),
        3,
        3,
        1,
    )
    .unwrap()
    .event;
    assert!(apply(
        &[item, step, archived_item],
        C::ArchiveItemStep {
            item_id: ItemId([10; 16]),
            step_id,
        },
        4,
        4,
        1,
    )
    .is_err());
}

#[test]
fn step_limits_trimmed_text_and_lifetime_capacity_are_enforced() {
    assert_eq!(
        normalize_step_text(&"x".repeat(MAX_STEP_TEXT_CHARS))
            .unwrap()
            .len(),
        80
    );
    assert_eq!(
        normalize_step_text(&"😀".repeat(64)).unwrap().len(),
        MAX_STEP_TEXT_BYTES
    );
    for invalid in [
        " ".to_owned(),
        "x".repeat(MAX_STEP_TEXT_CHARS + 1),
        "😀".repeat(65),
        "line\nbreak".to_owned(),
    ] {
        assert!(normalize_step_text(&invalid).is_err());
    }

    let mut events = vec![item()];
    for index in 0..MAX_STEPS_PER_ITEM {
        events.push(
            apply(
                &events,
                C::AddItemStep {
                    item_id: ItemId([10; 16]),
                    step_id: StepId([(index + 20) as u8; 16]),
                    text: format!("Step {index}"),
                },
                (index + 2) as u8,
                (index + 2) as u64,
                1,
            )
            .unwrap()
            .event,
        );
    }
    let archived_step = apply(
        &events,
        C::ArchiveItemStep {
            item_id: ItemId([10; 16]),
            step_id: StepId([20; 16]),
        },
        18,
        18,
        1,
    )
    .unwrap()
    .event;
    events.push(archived_step);
    assert!(apply(
        &events,
        C::AddItemStep {
            item_id: ItemId([10; 16]),
            step_id: StepId([40; 16]),
            text: "Lifetime capacity stays used".into(),
        },
        19,
        19,
        1,
    )
    .is_err());
}

#[test]
fn equal_time_archives_win_independent_of_device_and_delivery_order() {
    let item = item();
    let step = add_step(ItemId([10; 16]), StepId([20; 16]), "Step", 2, 2, 1);
    let date = date();
    for (mutation_device, archive_device) in [(1, 2), (2, 1)] {
        let step_completion = create_event(
            &C::CompleteItemStep {
                item_id: ItemId([10; 16]),
                step_id: StepId([20; 16]),
            },
            context(3, 3, mutation_device),
        )
        .unwrap();
        let item_archive = create_event(
            &C::ArchiveItem(ItemId([10; 16])),
            context(4, 3, archive_device),
        )
        .unwrap();
        let first = rebuild(
            &[
                item.clone(),
                step.clone(),
                step_completion.clone(),
                item_archive.clone(),
            ],
            1_791_475_200_000,
            date,
        )
        .unwrap();
        let reversed = rebuild(
            &[item.clone(), step.clone(), item_archive, step_completion],
            1_791_475_200_000,
            date,
        )
        .unwrap();
        assert_eq!(first, reversed);
        assert_eq!(first.items[0].status, ItemStatus::Archived);
        assert!(!first.items[0].steps[0].completed);
    }

    for (mutation_device, archive_device) in [(1, 2), (2, 1)] {
        let completion = create_event(
            &C::CompleteItemStep {
                item_id: ItemId([10; 16]),
                step_id: StepId([20; 16]),
            },
            context(5, 3, mutation_device),
        )
        .unwrap();
        let step_archive = create_event(
            &C::ArchiveItemStep {
                item_id: ItemId([10; 16]),
                step_id: StepId([20; 16]),
            },
            context(6, 3, archive_device),
        )
        .unwrap();
        let state = rebuild(
            &[item.clone(), step.clone(), completion, step_archive],
            1_791_475_200_000,
            date,
        )
        .unwrap();
        assert!(state.items[0].steps[0].archived);
        assert!(!state.items[0].steps[0].completed);
    }
}

#[test]
fn suppressed_step_add_still_reserves_household_step_identity() {
    let first_item = item();
    let second_item = create_event(
        &C::AddItem {
            id: ItemId([11; 16]),
            text: "Wash dishes".into(),
            classification: ItemClassification::Need,
        },
        context(2, 2, 1),
    )
    .unwrap();
    let step_id = StepId([20; 16]);
    let suppressed_step = add_step(ItemId([10; 16]), step_id, "First step", 3, 3, 1);
    let item_archive = create_event(&C::ArchiveItem(ItemId([10; 16])), context(4, 3, 2)).unwrap();
    let duplicate_step = add_step(ItemId([11; 16]), step_id, "Duplicate step", 5, 4, 1);

    assert!(rebuild(
        &[
            first_item,
            second_item,
            suppressed_step,
            item_archive,
            duplicate_step,
        ],
        1_791_475_200_000,
        date(),
    )
    .is_err());
}

#[test]
fn step_events_roundtrip_and_malformed_payloads_fail_closed() {
    let event = add_step(ItemId([10; 16]), StepId([20; 16]), "Wipe stove", 2, 2, 1);
    assert_eq!(decode_event(&event.canonical_bytes).unwrap(), event);
    let mut malformed = event.canonical_bytes.clone();
    malformed[88 + 32..88 + 36].copy_from_slice(&0u32.to_le_bytes());
    assert_eq!(
        decode_event(&malformed),
        Err(crate::error::KinError::MalformedProtocol)
    );
    let without_steps = request(vec![item()]);
    let state: HouseholdState = crate::core::project(&without_steps).unwrap();
    assert!(state.items[0].steps.is_empty());
    assert!(crate::core::encode_projection(&without_steps, &state).is_ok());

    let history_with_step = request(vec![item(), event]);
    let state = crate::core::project(&history_with_step).unwrap();
    assert_eq!(state.items[0].steps.len(), 1);
    assert!(crate::core::encode_projection(&history_with_step, &state).is_ok());
}
