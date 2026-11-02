use super::*;
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
use crate::event::{DeviceId, EventId};

fn id(byte: u8) -> [u8; 16] {
    [byte; 16]
}

fn event(event_number: u8, logical_time: u64, kind: EventKind) -> EventEnvelope {
    let event_id = EventId(id(event_number));
    let mut canonical_bytes = vec![event_number, logical_time as u8];
    match &kind {
        EventKind::RoutineCreated { .. }
        | EventKind::RoutineOccurrenceCompleted { .. }
        | EventKind::RoutineOccurrenceReopened { .. }
        | EventKind::RoutineArchived { .. } => {
            panic!("Routine tests use independent wire fixtures")
        }
        EventKind::PulseSet { value, expires_at } => {
            canonical_bytes.push(*value as u8);
            canonical_bytes.extend_from_slice(&expires_at.to_le_bytes());
        }
        EventKind::PulseCleared => canonical_bytes.push(13),
        EventKind::TalkAdded { talk_id, text } => {
            canonical_bytes.extend_from_slice(&talk_id.0);
            canonical_bytes.extend_from_slice(text.as_bytes());
        }
        EventKind::TalkResolved { talk_id }
        | EventKind::TalkReopened { talk_id }
        | EventKind::TalkArchived { talk_id } => {
            canonical_bytes.extend_from_slice(&talk_id.0);
        }
        EventKind::HandoffAdded { handoff_id, text } => {
            canonical_bytes.extend_from_slice(&handoff_id.0);
            canonical_bytes.extend_from_slice(text.as_bytes());
        }
        EventKind::HandoffAcknowledged { handoff_id }
        | EventKind::HandoffArchived { handoff_id } => {
            canonical_bytes.extend_from_slice(&handoff_id.0);
        }
        EventKind::ItemAdded { item_id, text, .. } => {
            canonical_bytes.extend_from_slice(&item_id.0);
            canonical_bytes.extend_from_slice(text.as_bytes());
        }
        EventKind::ItemCompleted { item_id }
        | EventKind::ItemReopened { item_id }
        | EventKind::ItemArchived { item_id } => {
            canonical_bytes.extend_from_slice(&item_id.0);
        }
        EventKind::ItemStepAdded {
            item_id,
            step_id,
            text,
        } => {
            canonical_bytes.extend_from_slice(&item_id.0);
            canonical_bytes.extend_from_slice(&step_id.0);
            canonical_bytes.extend_from_slice(text.as_bytes());
        }
        EventKind::ItemStepCompleted { item_id, step_id }
        | EventKind::ItemStepReopened { item_id, step_id }
        | EventKind::ItemStepArchived { item_id, step_id } => {
            canonical_bytes.extend_from_slice(&item_id.0);
            canonical_bytes.extend_from_slice(&step_id.0);
        }
        EventKind::HouseholdModeChanged { mode } => {
            canonical_bytes.push(*mode as u8);
        }
        EventKind::ItemPlanningDateChanged {
            item_id,
            planning_date,
        } => {
            canonical_bytes.extend_from_slice(&item_id.0);
            canonical_bytes
                .extend_from_slice(&planning_date.map_or(0, CivilDate::encoded).to_le_bytes());
        }
        EventKind::AreaCreated { .. }
        | EventKind::AreaRenamed { .. }
        | EventKind::AreaArchived { .. }
        | EventKind::ItemAreaChanged { .. }
        | EventKind::NoteCreated { .. }
        | EventKind::NoteUpdated { .. }
        | EventKind::NoteArchived { .. }
        | EventKind::PinAdded { .. }
        | EventKind::PinRemoved { .. }
        | EventKind::PlaybookSaved { .. }
        | EventKind::PlaybookArchived { .. }
        | EventKind::ReferenceRecordSaved { .. }
        | EventKind::ReferenceRecordArchived { .. }
        | EventKind::MaintenanceEventSaved { .. }
        | EventKind::MaintenanceEventArchived { .. }
        | EventKind::AttachmentBound { .. }
        | EventKind::AttachmentRemoved { .. }
        | EventKind::ResponsibilityChanged { .. }
        | EventKind::DeviceDescribed { .. }
        | EventKind::DeviceNicknamed { .. }
        | EventKind::MemberNamed { .. }
        | EventKind::ChatMessagePosted { .. }
        | EventKind::ChatMessageEdited { .. }
        | EventKind::ChatMessageDeleted { .. }
        | EventKind::ChatReactionSet { .. }
        | EventKind::ChatPinSet { .. }
        | EventKind::ChatPollVote { .. }
        | EventKind::ChatPollClosed { .. }
        | EventKind::ChatTopicSet { .. }
        | EventKind::BoardStrokeAdded { .. }
        | EventKind::BoardStrokeHidden { .. }
        | EventKind::BoardMagnetPlaced { .. }
        | EventKind::BoardMagnetMoved { .. }
        | EventKind::BoardMagnetHidden { .. }
        | EventKind::BoardCleared { .. }
        | EventKind::BoardClearUndone { .. }
        | EventKind::RecipeSaved { .. }
        | EventKind::RecipeArchived { .. }
        | EventKind::DinnerSet { .. }
        | EventKind::DinnerCleared { .. }
        | EventKind::DinnerCookSet { .. }
        | EventKind::MealSet { .. }
        | EventKind::MealCleared { .. }
        | EventKind::RecipeFavouriteSet { .. }
        | EventKind::ItemEmojiSet { .. }
        | EventKind::ShoppingSectionsSet { .. }
        | EventKind::ItemSectionSet { .. }
        | EventKind::RoutineRotationSet { .. }
        | EventKind::RoutineTurnSet { .. } => {
            panic!("Area tests use independent wire fixtures")
        }
        EventKind::SitterPageSet { .. }
        | EventKind::AlbumPhotoAdded { .. }
        | EventKind::AlbumPhotoRemoved { .. }
        | EventKind::CalendarEventSaved(_)
        | EventKind::CalendarEventCancelled { .. }
        | EventKind::CalendarEventRestored { .. }
        | EventKind::MemberColourSet { .. }
        | EventKind::ChorePointsSet { .. }
        | EventKind::ChoreRewardSet { .. }
        | EventKind::ChoreChartJoined { .. }
        | EventKind::PrivateNoteSet { .. }
        | EventKind::PrivateItem(_)
        | EventKind::ReminderSet { .. }
        | EventKind::ReminderCleared { .. }
        | EventKind::SettingSet { .. }
        | EventKind::Journal(_) => {
            panic!("Area tests use independent wire fixtures")
        }
    }
    EventEnvelope {
        event_id,
        household_id: HouseholdId(id(0xaa)),
        actor_id: ActorId(id(0xbb)),
        device_id: DeviceId(id(0xcc)),
        timestamp: 1_760_000_000_000 + i64::from(event_number),
        logical_time,
        event_version: 1,
        kind,
        canonical_bytes,
    }
}

fn added(event_number: u8, logical_time: u64, item_number: u8, text: &str) -> EventEnvelope {
    event(
        event_number,
        logical_time,
        EventKind::ItemAdded {
            item_id: ItemId(id(item_number)),
            text: text.to_owned(),
            classification: ItemClassification::Need,
        },
    )
}

#[test]
fn add_item_creates_active_item() {
    let state = replay(&[added(1, 1, 0x11, "Buy milk")]).unwrap();
    assert_eq!(state.items.len(), 1);
    assert_eq!(state.items[0].text, "Buy milk");
    assert_eq!(state.items[0].status, ItemStatus::Active);
    assert_eq!(state.items[0].last_changed_at, 1_760_000_000_001);
}

#[test]
fn multiple_items_keep_addition_order() {
    let events = [
        added(1, 1, 0x11, "Buy milk"),
        added(2, 2, 0x22, "Restock wipes"),
    ];
    let state = replay(&events).unwrap();
    assert_eq!(state.items.len(), 2);
    assert_eq!(state.items[0].text, "Buy milk");
    assert_eq!(state.items[1].text, "Restock wipes");
}

#[test]
fn planning_date_replay_is_deterministic_and_keeps_stale_offline_updates_valid() {
    let first_date = CivilDate::from_encoded(20261004).unwrap();
    let second_date = CivilDate::from_encoded(20261005).unwrap();
    let item_id = ItemId(id(0x11));
    let events = [
        added(1, 1, 0x11, "Buy milk"),
        event(
            2,
            2,
            EventKind::ItemPlanningDateChanged {
                item_id,
                planning_date: Some(first_date),
            },
        ),
        event(
            3,
            2,
            EventKind::ItemPlanningDateChanged {
                item_id,
                planning_date: Some(second_date),
            },
        ),
        event(4, 3, EventKind::ItemArchived { item_id }),
        event(
            5,
            4,
            EventKind::ItemPlanningDateChanged {
                item_id,
                planning_date: Some(first_date),
            },
        ),
    ];
    let forward = rebuild(&events, 0, first_date).unwrap();
    let reverse_events = events.into_iter().rev().collect::<Vec<_>>();
    let reverse = rebuild(&reverse_events, 0, first_date).unwrap();
    assert_eq!(forward, reverse);
    assert_eq!(forward.items[0].status, ItemStatus::Archived);
    assert_eq!(forward.items[0].planning_date, Some(first_date));
    assert_eq!(forward.items[0].last_changed_at, 1_760_000_000_005);
}

#[test]
fn effective_item_and_step_changes_advance_history_but_noops_do_not() {
    let item_id = ItemId(id(0x11));
    let step_id = StepId(id(0x22));
    let planning_date = CivilDate::from_encoded(20261004).unwrap();
    let events = [
        added(1, 1, 0x11, "Buy milk"),
        event(
            2,
            2,
            EventKind::ItemPlanningDateChanged {
                item_id,
                planning_date: Some(planning_date),
            },
        ),
        event(
            3,
            3,
            EventKind::ItemPlanningDateChanged {
                item_id,
                planning_date: Some(planning_date),
            },
        ),
        event(
            4,
            4,
            EventKind::ItemStepAdded {
                item_id,
                step_id,
                text: "Check the label".into(),
            },
        ),
        event(5, 5, EventKind::ItemStepCompleted { item_id, step_id }),
        event(6, 6, EventKind::ItemStepCompleted { item_id, step_id }),
        event(7, 7, EventKind::ItemStepReopened { item_id, step_id }),
        event(8, 8, EventKind::ItemStepArchived { item_id, step_id }),
        event(9, 9, EventKind::ItemCompleted { item_id }),
        event(10, 10, EventKind::ItemCompleted { item_id }),
        event(11, 11, EventKind::ItemReopened { item_id }),
        event(12, 12, EventKind::ItemArchived { item_id }),
    ];

    let after_create = replay(&events[..1]).unwrap();
    assert_eq!(after_create.items[0].last_changed_at, 1_760_000_000_001);
    let after_date_change = replay(&events[..2]).unwrap();
    assert_eq!(
        after_date_change.items[0].last_changed_at,
        1_760_000_000_002
    );
    let after_date_noop = replay(&events[..3]).unwrap();
    assert_eq!(after_date_noop.items[0].last_changed_at, 1_760_000_000_002);
    let after_step_change = replay(&events[..5]).unwrap();
    assert_eq!(
        after_step_change.items[0].last_changed_at,
        1_760_000_000_005
    );
    let after_step_noop = replay(&events[..6]).unwrap();
    assert_eq!(after_step_noop.items[0].last_changed_at, 1_760_000_000_005);
    let after_step_archive = replay(&events[..8]).unwrap();
    assert_eq!(
        after_step_archive.items[0].last_changed_at,
        1_760_000_000_008
    );
    let after_status_noop = replay(&events[..10]).unwrap();
    assert_eq!(
        after_status_noop.items[0].last_changed_at,
        1_760_000_000_009
    );
    let final_state = replay(&events).unwrap();
    assert_eq!(final_state.items[0].status, ItemStatus::Archived);
    assert_eq!(final_state.items[0].last_changed_at, 1_760_000_000_012);

    let mut equal_time_events = events[..3].to_vec();
    equal_time_events[1].logical_time = 2;
    equal_time_events[2].logical_time = 2;
    equal_time_events[2].kind = EventKind::ItemPlanningDateChanged {
        item_id,
        planning_date: Some(CivilDate::from_encoded(20261005).unwrap()),
    };
    let forward = rebuild(&equal_time_events, 0, planning_date).unwrap();
    equal_time_events.reverse();
    let reverse = rebuild(&equal_time_events, 0, planning_date).unwrap();
    assert_eq!(forward, reverse);
    assert_eq!(forward.items[0].last_changed_at, 1_760_000_000_003);
}

#[test]
fn completion_changes_only_derived_status() {
    let events = [
        added(1, 1, 0x11, "Buy milk"),
        event(
            2,
            2,
            EventKind::ItemCompleted {
                item_id: ItemId(id(0x11)),
            },
        ),
    ];
    let state = replay(&events).unwrap();
    assert_eq!(state.items[0].text, "Buy milk");
    assert_eq!(state.items[0].status, ItemStatus::Completed);
}

#[test]
fn unknown_completion_is_invalid() {
    let completion = event(
        1,
        1,
        EventKind::ItemCompleted {
            item_id: ItemId(id(0xff)),
        },
    );
    assert_eq!(replay(&[completion]), Err(KinError::InvalidEvent));
}

#[test]
fn identical_event_delivery_is_idempotent() {
    let added = added(1, 1, 0x11, "Buy milk");
    let state = replay(&[added.clone(), added]).unwrap();
    assert_eq!(state.items.len(), 1);
}

#[test]
fn event_id_reuse_with_different_bytes_fails() {
    let first = added(1, 1, 0x11, "Buy milk");
    let mut conflicting = added(2, 2, 0x22, "Restock wipes");
    conflicting.event_id = first.event_id;
    assert_eq!(replay(&[first, conflicting]), Err(KinError::InvalidEvent));
}

#[test]
fn duplicate_completion_is_a_valid_noop() {
    let events = [
        added(1, 1, 0x11, "Buy milk"),
        event(
            2,
            2,
            EventKind::ItemCompleted {
                item_id: ItemId(id(0x11)),
            },
        ),
        event(
            3,
            3,
            EventKind::ItemCompleted {
                item_id: ItemId(id(0x11)),
            },
        ),
    ];
    let state = replay(&events).unwrap();
    assert_eq!(state.items[0].status, ItemStatus::Completed);
}

#[test]
fn rebuild_is_deterministic() {
    let events = [
        added(1, 1, 0x11, "Buy milk"),
        event(
            2,
            2,
            EventKind::ItemCompleted {
                item_id: ItemId(id(0x11)),
            },
        ),
    ];
    let state_a = replay(&events).unwrap();
    let state_b = replay(&events).unwrap();
    let state_c = replay(&events).unwrap();
    assert_eq!(state_a, state_b);
    assert_eq!(state_b, state_c);
    assert_eq!(state_a, state_c);
}

#[test]
fn mixed_households_fail_as_a_whole() {
    let first = added(1, 1, 0x11, "Buy milk");
    let mut second = added(2, 2, 0x22, "Restock wipes");
    second.household_id = HouseholdId(id(0xdd));
    assert_eq!(replay(&[first, second]), Err(KinError::InvalidEvent));
}

#[test]
fn whitespace_only_items_are_invalid() {
    assert_eq!(
        replay(&[added(1, 1, 0x11, " \t\n")]),
        Err(KinError::InvalidEvent)
    );
}

#[test]
fn reopening_completed_and_active_items_is_valid() {
    let item_id = ItemId(id(0x11));
    let completed_then_reopened = [
        added(1, 1, 0x11, "Buy milk"),
        event(2, 2, EventKind::ItemCompleted { item_id }),
        event(3, 3, EventKind::ItemReopened { item_id }),
    ];
    let reopened_state = replay(&completed_then_reopened).unwrap();
    assert_eq!(reopened_state.items[0].status, ItemStatus::Active);

    let already_active = [
        added(1, 1, 0x11, "Buy milk"),
        event(2, 2, EventKind::ItemReopened { item_id }),
    ];
    let active_state = replay(&already_active).unwrap();
    assert_eq!(active_state.items[0].status, ItemStatus::Active);
}

#[test]
fn archiving_active_or_completed_items_is_terminal() {
    let item_id = ItemId(id(0x11));
    for prefix in [
        vec![added(1, 1, 0x11, "Buy milk")],
        vec![
            added(1, 1, 0x11, "Buy milk"),
            event(2, 2, EventKind::ItemCompleted { item_id }),
        ],
    ] {
        let mut archived_events = prefix.clone();
        archived_events.push(event(
            archived_events.len() as u8 + 1,
            archived_events.len() as u64 + 1,
            EventKind::ItemArchived { item_id },
        ));
        let archived_state = replay(&archived_events).unwrap();
        assert_eq!(archived_state.items[0].status, ItemStatus::Archived);

        for mutation in [
            EventKind::ItemCompleted { item_id },
            EventKind::ItemReopened { item_id },
            EventKind::ItemArchived { item_id },
        ] {
            let mut invalid_events = archived_events.clone();
            invalid_events.push(event(
                invalid_events.len() as u8 + 1,
                invalid_events.len() as u64 + 1,
                mutation,
            ));
            assert_eq!(replay(&invalid_events), Err(KinError::InvalidEvent));
        }
    }
}

#[test]
fn unknown_reopen_and_archive_references_are_invalid() {
    let item_id = ItemId(id(0xff));
    for kind in [
        EventKind::ItemReopened { item_id },
        EventKind::ItemArchived { item_id },
    ] {
        assert_eq!(replay(&[event(1, 1, kind)]), Err(KinError::InvalidEvent));
    }
}

#[test]
fn duplicate_item_identity_is_invalid() {
    let events = [
        added(1, 1, 0x11, "Buy milk"),
        added(2, 2, 0x11, "Restock wipes"),
    ];
    assert_eq!(replay(&events), Err(KinError::InvalidEvent));
}

#[test]
fn equal_logical_times_order_by_device_then_event_id_in_any_input_order() {
    let events = [
        added(2, 2, 0x22, "Restock wipes"),
        added(1, 2, 0x11, "Buy milk"),
    ];
    let reversed = [events[1].clone(), events[0].clone()];
    let texts = |state: HouseholdState| {
        state
            .items
            .into_iter()
            .map(|item| item.text)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        texts(replay(&events).unwrap()),
        ["Buy milk", "Restock wipes"]
    );
    assert_eq!(
        texts(replay(&reversed).unwrap()),
        ["Buy milk", "Restock wipes"]
    );
}

#[test]
fn archived_item_mutations_are_terminal_noops_and_replay_is_order_independent() {
    let item_id = ItemId(id(0x11));
    let mut archive = event(2, 2, EventKind::ItemArchived { item_id });
    archive.device_id = DeviceId(id(1));
    let mut add_other = added(3, 2, 0x22, "Buy milk");
    add_other.device_id = DeviceId(id(2));
    let mut stale_complete = event(4, 3, EventKind::ItemCompleted { item_id });
    stale_complete.device_id = DeviceId(id(2));
    let mut stale_reopen = event(5, 4, EventKind::ItemReopened { item_id });
    stale_reopen.device_id = DeviceId(id(2));
    let events = [
        added(1, 1, 0x11, "Bins"),
        archive,
        add_other,
        stale_complete,
        stale_reopen,
    ];
    let forward = rebuild(&events, 0, CivilDate::from_encoded(20261009).unwrap()).unwrap();
    let reverse = rebuild(
        &events.into_iter().rev().collect::<Vec<_>>(),
        0,
        CivilDate::from_encoded(20261009).unwrap(),
    )
    .unwrap();
    assert_eq!(forward, reverse);
    assert_eq!(forward.items[0].status, ItemStatus::Archived);
    assert_eq!(forward.items.len(), 2);
}

#[test]
fn logical_time_has_a_shared_ceiling_and_bounded_advance() {
    let mut above = added(1, MAX_LOGICAL_TIME + 1, 0x11, "Milk");
    assert_eq!(replay(&[above.clone()]), Err(KinError::InvalidEvent));
    above.logical_time = MAX_LOGICAL_TIME_ADVANCE + 1;
    assert_eq!(replay(&[above.clone()]), Err(KinError::InvalidEvent));
    above.logical_time = MAX_LOGICAL_TIME_ADVANCE;
    let mut next = added(2, MAX_LOGICAL_TIME_ADVANCE + 1, 0x22, "Bread");
    next.device_id = DeviceId(id(2));
    assert!(rebuild(
        &[above, next],
        0,
        CivilDate::from_encoded(20261009).unwrap()
    )
    .is_ok());
}
