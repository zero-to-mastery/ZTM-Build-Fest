use crate::command::{execute, CommandContext, HouseholdCommand as C};
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::request::DecodedRequest;
use crate::state::{MAX_AREAS, MAX_AREA_NAME_BYTES, MAX_AREA_NAME_CHARS};

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

fn request(events: Vec<EventEnvelope>) -> DecodedRequest {
    DecodedRequest {
        events,
        as_of: 1_760_000_000_000,
        summary_cursor: None,
        civil_date: crate::recurrence::CivilDate::from_encoded(20261004).unwrap(),
        target_household_id: None,
        identity_bindings: Vec::new(),
    }
}

fn context(n: u8, logical_time: u64) -> CommandContext {
    CommandContext {
        event_id: EventId([n; 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([3; 16]),
        timestamp: 1_760_000_000_000 + i64::from(n),
        logical_time,
    }
}

fn context_for_device(n: u8, device: u8, logical_time: u64) -> CommandContext {
    CommandContext {
        event_id: EventId([n; 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([device; 16]),
        timestamp: 1_760_000_000_000 + i64::from(n),
        logical_time,
    }
}

fn run(events: &mut Vec<EventEnvelope>, command: C, n: u8) -> Result<EventEnvelope, KinError> {
    let result = execute(
        &command,
        context(n, events.len() as u64 + 1),
        request(events.clone()),
    )?;
    events.push(result.event.clone());
    Ok(result.event)
}

#[test]
fn assigned_items_keep_area_identity_through_rename_and_archive() {
    let mut events = Vec::new();
    let area_id = AreaId([10; 16]);
    run(
        &mut events,
        C::CreateArea {
            id: area_id,
            name: "  Kitchen  ".into(),
        },
        1,
    )
    .unwrap();
    let item_id = ItemId([11; 16]);
    run(
        &mut events,
        C::AddItem {
            id: item_id,
            text: "Wipe counter".into(),
            classification: ItemClassification::Need,
        },
        2,
    )
    .unwrap();
    run(
        &mut events,
        C::ChangeItemArea {
            item_id,
            area_id: Some(area_id),
        },
        3,
    )
    .unwrap();
    run(
        &mut events,
        C::RenameArea {
            id: area_id,
            name: "Cooking area".into(),
        },
        4,
    )
    .unwrap();
    run(&mut events, C::ArchiveArea(area_id), 5).unwrap();
    let state = replay(&events).unwrap();
    assert_eq!(state.areas[0].name, "Cooking area");
    assert!(state.areas[0].archived);
    assert_eq!(state.items[0].area_id, Some(area_id));
}

#[test]
fn item_history_changes_only_when_area_assignment_changes() {
    let mut events = Vec::new();
    let area_id = AreaId([20; 16]);
    let item_id = ItemId([21; 16]);
    run(
        &mut events,
        C::CreateArea {
            id: area_id,
            name: "Kitchen".into(),
        },
        1,
    )
    .unwrap();
    run(
        &mut events,
        C::AddItem {
            id: item_id,
            text: "Wipe counter".into(),
            classification: ItemClassification::Need,
        },
        2,
    )
    .unwrap();
    run(
        &mut events,
        C::ChangeItemArea {
            item_id,
            area_id: Some(area_id),
        },
        3,
    )
    .unwrap();
    let changed = replay(&events).unwrap();
    assert_eq!(changed.items[0].last_changed_at, 1_760_000_000_003);

    run(
        &mut events,
        C::ChangeItemArea {
            item_id,
            area_id: Some(area_id),
        },
        4,
    )
    .unwrap();
    let unchanged = replay(&events).unwrap();
    assert_eq!(unchanged.items[0].last_changed_at, 1_760_000_000_003);
}

#[test]
fn unassigned_pre_area_history_needs_no_synthetic_area() {
    let request = request(Vec::new());
    assert!(request.events.is_empty());
    assert!(replay(&[]).unwrap().areas.is_empty());
}

#[test]
fn projections_with_and_without_areas_encode() {
    let empty = replay(&[]).unwrap();
    let summary = crate::state::CatchUpSummary {
        entries: Vec::new(),
        total_count: 0,
        through_event_id: None,
    };
    assert!(crate::state_encode::encode_state(&empty, &summary).is_ok());

    let area = EventEnvelope {
        event_id: EventId([31; 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([3; 16]),
        timestamp: 1_760_000_000_031,
        logical_time: 1,
        event_version: 1,
        kind: EventKind::AreaCreated {
            area_id: AreaId([32; 16]),
            name: "Home".into(),
        },
        canonical_bytes: Vec::new(),
    };
    let state = replay(&[area]).unwrap();
    assert_eq!(state.areas.len(), 1);
    assert!(crate::state_encode::encode_state(&state, &summary).is_ok());
}

#[test]
fn replay_rejects_malformed_area_names_and_zero_area_identity() {
    for (area_id, name) in [
        (AreaId([41; 16]), "\u{0000}Kitchen"),
        (AreaId([41; 16]), "   "),
        (AreaId([41; 16]), &"x".repeat(MAX_AREA_NAME_BYTES + 1)),
        (AreaId([0; 16]), "Home"),
    ] {
        let event = EventEnvelope {
            event_id: EventId([42; 16]),
            household_id: HouseholdId([1; 16]),
            actor_id: ActorId([2; 16]),
            device_id: DeviceId([3; 16]),
            timestamp: 1_760_000_000_042,
            logical_time: 1,
            event_version: 1,
            kind: EventKind::AreaCreated {
                area_id,
                name: name.to_owned(),
            },
            canonical_bytes: Vec::new(),
        };
        assert_eq!(replay(&[event]), Err(KinError::InvalidEvent));
    }
}

#[test]
fn invalid_area_references_archived_assignment_and_archiving_rules_are_explicit() {
    let mut events = Vec::new();
    let area_id = AreaId([12; 16]);
    let item_id = ItemId([13; 16]);
    run(
        &mut events,
        C::CreateArea {
            id: area_id,
            name: "Home".into(),
        },
        1,
    )
    .unwrap();
    run(
        &mut events,
        C::AddItem {
            id: item_id,
            text: "Mail".into(),
            classification: ItemClassification::Need,
        },
        2,
    )
    .unwrap();
    run(&mut events, C::ArchiveArea(area_id), 3).unwrap();
    assert_eq!(
        execute(
            &C::ChangeItemArea {
                item_id,
                area_id: Some(area_id)
            },
            context(4, 4),
            request(events.clone())
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
    assert_eq!(
        execute(
            &C::ChangeItemArea {
                item_id,
                area_id: Some(AreaId([99; 16]))
            },
            context(5, 4),
            request(events.clone())
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
    assert_eq!(
        execute(
            &C::ArchiveArea(area_id),
            context(6, 4),
            request(events.clone())
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
    let stale = crate::codec::encode_event(&EventEnvelope {
        event_id: EventId([7; 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([4; 16]),
        timestamp: 1_760_000_000_007,
        logical_time: 4,
        event_version: 1,
        kind: EventKind::ItemAreaChanged {
            item_id,
            area_id: Some(area_id),
        },
        canonical_bytes: Vec::new(),
    })
    .unwrap();
    let stale_event = decode_event(&stale).unwrap();
    events.push(stale_event);
    assert_eq!(replay(&events).unwrap().items[0].area_id, Some(area_id));
}

#[test]
fn names_are_trimmed_bounded_and_duplicate_commands_reject_without_merging() {
    assert_eq!(
        crate::state::normalize_area_name("  Garden  ").unwrap(),
        "Garden"
    );
    assert_eq!(
        crate::state::normalize_area_name("  "),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        crate::state::normalize_area_name(&"x".repeat(MAX_AREA_NAME_BYTES + 1)),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        crate::state::normalize_area_name(&"x".repeat(MAX_AREA_NAME_CHARS + 1)),
        Err(KinError::InvalidEvent)
    );
    let mut events = Vec::new();
    run(
        &mut events,
        C::CreateArea {
            id: AreaId([20; 16]),
            name: "Garden".into(),
        },
        1,
    )
    .unwrap();
    assert_eq!(
        execute(
            &C::CreateArea {
                id: AreaId([21; 16]),
                name: " garden ".into()
            },
            context(2, 2),
            request(events.clone())
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
    let duplicate = events[0].clone();
    let replay = replay(&[duplicate.clone(), duplicate]).unwrap();
    assert_eq!(replay.areas.len(), 1);
}

#[test]
fn independently_created_same_name_areas_keep_distinct_stable_ids_on_replay() {
    let first = EventEnvelope {
        event_id: EventId([51; 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([3; 16]),
        timestamp: 1_760_000_000_051,
        logical_time: 1,
        event_version: 1,
        kind: EventKind::AreaCreated {
            area_id: AreaId([52; 16]),
            name: "Garden".into(),
        },
        canonical_bytes: Vec::new(),
    };
    let second = EventEnvelope {
        event_id: EventId([53; 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([4; 16]),
        timestamp: 1_760_000_000_053,
        logical_time: 1,
        event_version: 1,
        kind: EventKind::AreaCreated {
            area_id: AreaId([54; 16]),
            name: " Garden ".into(),
        },
        canonical_bytes: Vec::new(),
    };
    let state = crate::state::rebuild(
        &[first, second],
        1_760_000_000_100,
        crate::recurrence::CivilDate::from_encoded(20261004).unwrap(),
    )
    .unwrap();
    assert_eq!(state.areas.len(), 2);
    assert_ne!(state.areas[0].area_id, state.areas[1].area_id);
    assert_eq!(state.areas[0].name, "Garden");
    assert_eq!(state.areas[1].name, "Garden");
}

#[test]
fn area_creation_has_a_fixed_household_limit() {
    let mut events = Vec::new();
    for index in 0..MAX_AREAS {
        let byte = index as u8 + 1;
        run(
            &mut events,
            C::CreateArea {
                id: AreaId([byte; 16]),
                name: format!("Area {byte}"),
            },
            byte,
        )
        .unwrap();
    }
    let error = execute(
        &C::CreateArea {
            id: AreaId([200; 16]),
            name: "One more".into(),
        },
        context(201, MAX_AREAS as u64 + 1),
        request(events),
    )
    .unwrap_err();
    assert_eq!(error, KinError::InvalidEvent);
}

#[test]
fn offline_rename_assignment_archive_and_duplicate_delivery_converge() {
    let area_id = AreaId([61; 16]);
    let item_id = ItemId([62; 16]);
    let base = vec![
        execute(
            &C::CreateArea {
                id: area_id,
                name: "Home".into(),
            },
            context_for_device(1, 3, 1),
            request(Vec::new()),
        )
        .unwrap()
        .event,
        execute(
            &C::AddItem {
                id: item_id,
                text: "Replace bulb".into(),
                classification: ItemClassification::Need,
            },
            context_for_device(2, 3, 2),
            request(Vec::new()),
        )
        .unwrap()
        .event,
    ];

    // Both devices start from the same base. Rename and assignment happen
    // offline at the same logical time and must commute after deterministic
    // ordering regardless of delivery order.
    let rename = execute(
        &C::RenameArea {
            id: area_id,
            name: "Inside".into(),
        },
        context_for_device(3, 3, 3),
        request(base.clone()),
    )
    .unwrap()
    .event;
    let assignment = execute(
        &C::ChangeItemArea {
            item_id,
            area_id: Some(area_id),
        },
        context_for_device(4, 4, 3),
        request(base.clone()),
    )
    .unwrap()
    .event;
    let mut merged = base.clone();
    merged.extend([rename.clone(), assignment.clone()]);
    let reverse = [
        base[0].clone(),
        base[1].clone(),
        assignment.clone(),
        rename.clone(),
    ];
    let converged = crate::state::rebuild(
        &merged,
        1_760_000_000_100,
        crate::recurrence::CivilDate::from_encoded(20261004).unwrap(),
    )
    .unwrap();
    assert_eq!(
        converged,
        crate::state::rebuild(
            &reverse,
            1_760_000_000_100,
            crate::recurrence::CivilDate::from_encoded(20261004).unwrap(),
        )
        .unwrap()
    );
    assert_eq!(converged.areas[0].name, "Inside");
    assert_eq!(converged.items[0].area_id, Some(area_id));

    let device_b_area = execute(
        &C::CreateArea {
            id: AreaId([63; 16]),
            name: "Car".into(),
        },
        context_for_device(7, 4, 1),
        request(Vec::new()),
    )
    .unwrap()
    .event;
    let two_area_orders = [
        vec![base[0].clone(), base[1].clone(), device_b_area.clone()],
        vec![device_b_area, base[1].clone(), base[0].clone()],
    ];
    let states = two_area_orders
        .iter()
        .map(|events| {
            crate::state::rebuild(
                events,
                1_760_000_000_100,
                crate::recurrence::CivilDate::from_encoded(20261004).unwrap(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(states[0], states[1]);
    assert_eq!(states[0].areas.len(), 2);

    // A stale device's assignment event was authored from its pre-archive
    // history. The archive sorts before it on the shared logical clock, but
    // historical context remains attached and replay is arrival-order safe.
    let archive = execute(
        &C::ArchiveArea(area_id),
        context_for_device(5, 3, 3),
        request(base.clone()),
    )
    .unwrap()
    .event;
    let mut archived_merge = base.clone();
    archived_merge.push(archive);
    archived_merge.extend([assignment.clone(), assignment.clone()]); // retry / duplicate delivery
    let archived_state = crate::state::rebuild(
        &archived_merge,
        1_760_000_000_100,
        crate::recurrence::CivilDate::from_encoded(20261004).unwrap(),
    )
    .unwrap();
    assert!(archived_state.areas[0].archived);
    assert_eq!(archived_state.items[0].area_id, Some(area_id));
    assert_eq!(
        execute(
            &C::ChangeItemArea {
                item_id,
                area_id: Some(area_id),
            },
            context_for_device(6, 4, 5),
            request(archived_merge),
        )
        .unwrap_err(),
        KinError::InvalidEvent
    );
}
