use crate::command::{execute, CommandContext, HouseholdCommand as C};
use crate::event::*;
use crate::event_decode::decode_event;
use crate::recurrence::{Cadence, CivilDate};
use crate::request::DecodedRequest;
use crate::state::{rebuild, MAX_MAINTENANCE_EVENTS_PER_RECORD};

fn date(value: u32) -> CivilDate {
    CivilDate::from_encoded(value).unwrap()
}
fn ctx(n: u8, device: u8) -> CommandContext {
    CommandContext {
        event_id: EventId([n.wrapping_add(device); 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([device; 16]),
        timestamp: 1_791_475_200_000 + i64::from(n),
        logical_time: u64::from(n),
    }
}
fn req(events: Vec<EventEnvelope>) -> DecodedRequest {
    DecodedRequest {
        events,
        as_of: 1_791_475_200_000,
        summary_cursor: None,
        civil_date: date(20261009),
        target_household_id: None,
        identity_bindings: vec![],
    }
}
fn add(events: &mut Vec<EventEnvelope>, command: C, n: u8) {
    let result = execute(&command, ctx(n, 3), req(events.clone())).unwrap();
    events.push(result.event);
}
fn reference() -> C {
    C::SaveReferenceRecord {
        id: ReferenceRecordId([4; 16]),
        title: "Furnace".into(),
        area_id: None,
        fields: vec![(ReferenceFieldId([5; 16]), "Model".into(), "A1".into())],
    }
}

#[test]
fn maintenance_history_create_edit_archive_and_legacy_replay() {
    let mut events = vec![];
    add(&mut events, reference(), 1);
    let maintenance = MaintenanceEventId([7; 16]);
    let first = C::SaveMaintenanceEvent {
        id: maintenance,
        record_id: ReferenceRecordId([4; 16]),
        performed_on: date(20260918),
        summary: " Filter changed ".into(),
        next_on: Some(date(20261218)),
        routine_id: None,
    };
    add(&mut events, first, 2);
    assert_eq!(decode_event(&events[1].canonical_bytes).unwrap(), events[1]);
    add(
        &mut events,
        C::SaveMaintenanceEvent {
            id: maintenance,
            record_id: ReferenceRecordId([4; 16]),
            performed_on: date(20260918),
            summary: "Filter changed".into(),
            next_on: Some(date(20270118)),
            routine_id: None,
        },
        3,
    );
    let replay = rebuild(&events, 1_791_475_200_004, date(20261009)).unwrap();
    assert_eq!(replay.maintenance_events[0].summary, "Filter changed");
    assert_eq!(replay.maintenance_events[0].next_on, Some(date(20270118)));
    add(&mut events, C::ArchiveMaintenanceEvent(maintenance), 4);
    assert!(
        rebuild(&events, 1_791_475_200_005, date(20261009))
            .unwrap()
            .maintenance_events[0]
            .archived
    );
}

#[test]
fn maintenance_links_and_limits_fail_closed_and_old_histories_stay_empty() {
    let mut events = vec![];
    add(&mut events, reference(), 1);
    let mut linked = vec![crate::command::create_event(
        &C::CreateRoutine {
            id: RoutineId([8; 16]),
            text: "Change furnace filter".into(),
            cadence: Cadence::Monthly,
            created_on: date(20260901),
        },
        ctx(2, 3),
    )
    .unwrap()];
    let mut complete = events.clone();
    complete.append(&mut linked);
    add(
        &mut complete,
        C::SaveMaintenanceEvent {
            id: MaintenanceEventId([9; 16]),
            record_id: ReferenceRecordId([4; 16]),
            performed_on: date(20260918),
            summary: "Changed filter".into(),
            next_on: None,
            routine_id: Some(RoutineId([8; 16])),
        },
        3,
    );
    assert_eq!(
        rebuild(&complete, 1_791_475_200_004, date(20261009))
            .unwrap()
            .maintenance_events[0]
            .routine_id,
        Some(RoutineId([8; 16]))
    );
    assert!(execute(
        &C::SaveMaintenanceEvent {
            id: MaintenanceEventId([10; 16]),
            record_id: ReferenceRecordId([4; 16]),
            performed_on: date(20260918),
            summary: "Changed filter".into(),
            next_on: None,
            routine_id: Some(RoutineId([99; 16]))
        },
        ctx(4, 3),
        req(events.clone())
    )
    .is_err());
    assert!(execute(
        &C::SaveMaintenanceEvent {
            id: MaintenanceEventId([10; 16]),
            record_id: ReferenceRecordId([4; 16]),
            performed_on: date(20260918),
            summary: "Changed filter".into(),
            next_on: Some(date(20260917)),
            routine_id: None
        },
        ctx(4, 3),
        req(events.clone())
    )
    .is_err());
    assert!(rebuild(&events, 1_791_475_200_002, date(20261009))
        .unwrap()
        .maintenance_events
        .is_empty());
    for n in 0..MAX_MAINTENANCE_EVENTS_PER_RECORD {
        add(
            &mut events,
            C::SaveMaintenanceEvent {
                id: MaintenanceEventId([n as u8 + 20; 16]),
                record_id: ReferenceRecordId([4; 16]),
                performed_on: date(20260918),
                summary: "Changed filter".into(),
                next_on: None,
                routine_id: None,
            },
            n as u8 + 10,
        );
    }
    assert!(execute(
        &C::SaveMaintenanceEvent {
            id: MaintenanceEventId([120; 16]),
            record_id: ReferenceRecordId([4; 16]),
            performed_on: date(20260918),
            summary: "Changed filter".into(),
            next_on: None,
            routine_id: None
        },
        ctx(100, 3),
        req(events)
    )
    .is_err());
}

#[test]
fn archived_reference_history_is_retained_and_concurrent_create_converges() {
    let base = [crate::command::create_event(&reference(), ctx(1, 3)).unwrap()];
    let record_id = ReferenceRecordId([4; 16]);
    let maintenance = crate::command::create_event(
        &C::SaveMaintenanceEvent {
            id: MaintenanceEventId([70; 16]),
            record_id,
            performed_on: date(20260918),
            summary: "Filter changed".into(),
            next_on: None,
            routine_id: None,
        },
        CommandContext {
            event_id: EventId([31; 16]),
            logical_time: 2,
            ..ctx(2, 4)
        },
    )
    .unwrap();
    let archive = crate::command::create_event(
        &C::ArchiveReferenceRecord(record_id),
        CommandContext {
            event_id: EventId([32; 16]),
            logical_time: 2,
            ..ctx(3, 3)
        },
    )
    .unwrap();
    let replay = rebuild(
        &[base[0].clone(), archive.clone(), maintenance.clone()],
        1_791_475_200_010,
        date(20261009),
    )
    .unwrap();
    assert!(replay.reference_records[0].archived);
    assert_eq!(replay.maintenance_events.len(), 1);
    assert!(execute(
        &C::SaveMaintenanceEvent {
            id: MaintenanceEventId([71; 16]),
            record_id,
            performed_on: date(20260918),
            summary: "Late edit".into(),
            next_on: None,
            routine_id: None
        },
        ctx(4, 3),
        req(vec![base[0].clone(), archive]),
    )
    .is_err());
}
