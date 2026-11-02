//! Offline archive/completion conflicts converge on every device.
//!
//! For each pair, both logical-time orders and equal logical time, device A
//! (local terminal event, then the remote mutation), device B (the opposite
//! arrival), and a fresh replay of the merged history produce the same
//! projection. Replay accepts every event, which is what keeps
//! `event-store.js` from quarantining it (`InvalidEvent` is the only code
//! that loop quarantines).
use crate::codec::encode_event;
use crate::error::KinError;
use crate::event::*;
use crate::history::History;
use crate::recurrence::{Cadence, CivilDate};
use crate::request::{decode_context, decode_request};
use crate::state::{
    rebuild, CatchUpSummary, HandoffStatus, HouseholdState, ItemStatus, NoteStatus, TalkStatus,
};
use crate::state_encode::encode_state;
use crate::test_support::{kine, TEST_DATE};

const AS_OF: i64 = 1_700_000_000_000;

fn nid(value: u8) -> [u8; 16] {
    [value; 16]
}

fn date() -> CivilDate {
    CivilDate::from_encoded(TEST_DATE).unwrap()
}

fn record(seq: u8, device: u8, logical: u64, kind: EventKind) -> Vec<u8> {
    let version = if matches!(kind, EventKind::ItemAdded { .. }) {
        2
    } else {
        1
    };
    encode_event(&EventEnvelope {
        event_id: EventId(nid(seq)),
        household_id: HouseholdId(nid(1)),
        actor_id: ActorId(nid(2)),
        device_id: DeviceId(nid(device)),
        timestamp: AS_OF + i64::from(seq),
        logical_time: logical,
        event_version: version,
        kind,
        canonical_bytes: Vec::new(),
    })
    .unwrap()
}

fn batch(records: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = (records.len() as u32).to_le_bytes().to_vec();
    for record in records {
        bytes.extend_from_slice(&(record.len() as u32).to_le_bytes());
    }
    for record in records {
        bytes.extend_from_slice(record);
    }
    bytes
}

fn empty_summary() -> CatchUpSummary {
    CatchUpSummary {
        entries: Vec::new(),
        total_count: 0,
        through_event_id: None,
    }
}

fn project_records(records: &[Vec<u8>]) -> Result<(HouseholdState, Vec<u8>), KinError> {
    let request = kine(records, AS_OF, TEST_DATE, None);
    let decoded = decode_request(&request)?;
    let state = rebuild(&decoded.events, AS_OF, date())?;
    let bytes = encode_state(&state, &empty_summary())?;
    Ok((state, bytes))
}

/// Local batch, then the remote batch, using the held-history checkpoint.
fn project_incremental(
    local: &[Vec<u8>],
    remote: &[Vec<u8>],
) -> Result<(HouseholdState, Vec<u8>), KinError> {
    let context = decode_context(&kine(&[], AS_OF, TEST_DATE, None))?;
    let mut history = History::new();
    history.append(&batch(local))?;
    history.replay(&context)?;
    history.append(&batch(remote))?;
    let state = history.replay(&context)?.finalize(AS_OF, date())?;
    let bytes = encode_state(&state, &empty_summary())?;
    Ok((state, bytes))
}

fn converge(
    label: &str,
    setup: &[Vec<u8>],
    terminal: Vec<u8>,
    mutation: Vec<u8>,
) -> HouseholdState {
    let mut local_a = setup.to_vec();
    local_a.push(terminal.clone());
    let mut local_b = setup.to_vec();
    local_b.push(mutation.clone());
    let device_a = project_incremental(&local_a, std::slice::from_ref(&mutation))
        .unwrap_or_else(|error| panic!("{label}: device A quarantined {error:?}"));
    let device_b = project_incremental(&local_b, std::slice::from_ref(&terminal))
        .unwrap_or_else(|error| panic!("{label}: device B quarantined {error:?}"));
    let mut merged = setup.to_vec();
    merged.push(terminal);
    merged.push(mutation.clone());
    let fresh = project_records(&merged)
        .unwrap_or_else(|error| panic!("{label}: fresh rebuild failed {error:?}"));
    let last = merged.len() - 1;
    merged.swap(last - 1, last);
    let fresh_swapped = project_records(&merged)
        .unwrap_or_else(|error| panic!("{label}: swapped rebuild failed {error:?}"));
    assert_eq!(device_a.0, device_b.0, "{label}: devices differ");
    assert_eq!(device_a.0, fresh.0, "{label}: fresh rebuild differs");
    assert_eq!(
        device_a.0, fresh_swapped.0,
        "{label}: arrival order differs"
    );
    assert_eq!(device_a.1, device_b.1, "{label}: projection bytes differ");
    assert_eq!(device_a.1, fresh.1, "{label}: fresh bytes differ");
    assert_eq!(device_a.1, fresh_swapped.1, "{label}: swapped bytes differ");
    device_a.0
}

fn schedules() -> [(&'static str, u64, u64); 3] {
    [
        ("archive-then-change", 10, 20),
        ("change-then-archive", 20, 10),
        ("equal", 10, 10),
    ]
}

/// Equal logical time is also run with the device ids swapped, so replay
/// order of the two events is not what the outcome depends on.
fn device_pairs(terminal_time: u64, mutation_time: u64) -> Vec<(u8, u8)> {
    if terminal_time == mutation_time {
        vec![(0x11, 0x22), (0x22, 0x11)]
    } else {
        vec![(0x11, 0x22)]
    }
}

fn run_pair(
    name: &str,
    terminal_wins: bool,
    build: impl Fn(u8, u8, u64, u64) -> (Vec<Vec<u8>>, Vec<u8>, Vec<u8>),
    check: impl Fn(&str, &HouseholdState),
) {
    for (label, terminal_time, mutation_time) in schedules() {
        for (terminal_device, mutation_device) in device_pairs(terminal_time, mutation_time) {
            let (setup, terminal, mutation) = build(
                terminal_device,
                mutation_device,
                terminal_time,
                mutation_time,
            );
            let case =
                format!("{name}/{label}/devices-{terminal_device:02x}-{mutation_device:02x}");
            let state = converge(&case, &setup, terminal, mutation);
            let terminal_first = terminal_wins && terminal_time <= mutation_time;
            check(
                if terminal_first {
                    "terminal"
                } else {
                    "mutation"
                },
                &state,
            );
        }
    }
}

#[test]
fn archive_item_and_add_step_converge() {
    run_pair(
        "archive-item-add-step",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let item = ItemId(nid(0x30));
            let setup = vec![record(
                1,
                0x01,
                1,
                EventKind::ItemAdded {
                    item_id: item,
                    text: "Clean kitchen".into(),
                    classification: ItemClassification::Need,
                },
            )];
            let terminal = record(
                10,
                terminal_device,
                terminal_time,
                EventKind::ItemArchived { item_id: item },
            );
            let mutation = record(
                11,
                mutation_device,
                mutation_time,
                EventKind::ItemStepAdded {
                    item_id: item,
                    step_id: StepId(nid(0x31)),
                    text: "Wipe counters".into(),
                },
            );
            (setup, terminal, mutation)
        },
        |which, state| {
            assert_eq!(state.items[0].status, ItemStatus::Archived);
            assert_eq!(state.items[0].steps.is_empty(), which == "terminal");
        },
    );
}

#[test]
fn archive_item_and_step_edits_converge() {
    for (name, kind_of) in [("complete-step", true), ("remove-step", false)] {
        let complete = kind_of;
        run_pair(
            name,
            true,
            move |terminal_device, mutation_device, terminal_time, mutation_time| {
                let item = ItemId(nid(0x30));
                let step = StepId(nid(0x31));
                let setup = vec![
                    record(
                        1,
                        0x01,
                        1,
                        EventKind::ItemAdded {
                            item_id: item,
                            text: "Clean kitchen".into(),
                            classification: ItemClassification::Need,
                        },
                    ),
                    record(
                        2,
                        0x01,
                        2,
                        EventKind::ItemStepAdded {
                            item_id: item,
                            step_id: step,
                            text: "Wipe counters".into(),
                        },
                    ),
                ];
                let terminal = record(
                    10,
                    terminal_device,
                    terminal_time,
                    EventKind::ItemArchived { item_id: item },
                );
                let mutation = record(
                    11,
                    mutation_device,
                    mutation_time,
                    if complete {
                        EventKind::ItemStepCompleted {
                            item_id: item,
                            step_id: step,
                        }
                    } else {
                        EventKind::ItemStepArchived {
                            item_id: item,
                            step_id: step,
                        }
                    },
                );
                (setup, terminal, mutation)
            },
            move |which, state| {
                assert_eq!(state.items[0].status, ItemStatus::Archived);
                assert_eq!(state.items[0].steps.len(), 1);
                if complete {
                    assert_eq!(state.items[0].steps[0].completed, which == "mutation");
                    assert!(!state.items[0].steps[0].archived);
                } else {
                    assert_eq!(state.items[0].steps[0].archived, which == "mutation");
                }
            },
        );
    }
}

#[test]
fn complete_item_and_add_step_converge() {
    run_pair(
        "complete-item-add-step",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let item = ItemId(nid(0x30));
            let setup = vec![record(
                1,
                0x01,
                1,
                EventKind::ItemAdded {
                    item_id: item,
                    text: "Clean kitchen".into(),
                    classification: ItemClassification::Need,
                },
            )];
            let terminal = record(
                10,
                terminal_device,
                terminal_time,
                EventKind::ItemCompleted { item_id: item },
            );
            let mutation = record(
                11,
                mutation_device,
                mutation_time,
                EventKind::ItemStepAdded {
                    item_id: item,
                    step_id: StepId(nid(0x31)),
                    text: "Wipe counters".into(),
                },
            );
            (setup, terminal, mutation)
        },
        |which, state| {
            assert_eq!(state.items[0].status, ItemStatus::Completed);
            assert_eq!(state.items[0].steps.is_empty(), which == "terminal");
        },
    );
}

#[test]
fn archive_note_and_update_note_converge() {
    run_pair(
        "archive-note-update",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let note = NoteId(nid(0x40));
            let setup = vec![record(
                1,
                0x01,
                1,
                EventKind::NoteCreated {
                    note_id: note,
                    title: "Original".into(),
                    body: "Original body".into(),
                    area_id: None,
                },
            )];
            let terminal = record(
                10,
                terminal_device,
                terminal_time,
                EventKind::NoteArchived { note_id: note },
            );
            let mutation = record(
                11,
                mutation_device,
                mutation_time,
                EventKind::NoteUpdated {
                    note_id: note,
                    title: "Edited".into(),
                    body: "Edited body".into(),
                    area_id: None,
                },
            );
            (setup, terminal, mutation)
        },
        |which, state| {
            assert_eq!(state.notes[0].status, NoteStatus::Archived);
            assert_eq!(
                state.notes[0].title,
                if which == "terminal" {
                    "Original"
                } else {
                    "Edited"
                }
            );
        },
    );
}

#[test]
fn archive_area_and_create_note_keeps_an_unassigned_note() {
    run_pair(
        "archive-area-create-note",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let area = AreaId(nid(0x41));
            let setup = vec![record(
                1,
                0x01,
                1,
                EventKind::AreaCreated {
                    area_id: area,
                    name: "Kitchen".into(),
                },
            )];
            let terminal = record(
                10,
                terminal_device,
                terminal_time,
                EventKind::AreaArchived { area_id: area },
            );
            let mutation = record(
                11,
                mutation_device,
                mutation_time,
                EventKind::NoteCreated {
                    note_id: NoteId(nid(0x40)),
                    title: "Spare key".into(),
                    body: "On the hook".into(),
                    area_id: Some(area),
                },
            );
            (setup, terminal, mutation)
        },
        |which, state| {
            assert!(state.areas[0].archived);
            assert_eq!(state.notes.len(), 1);
            assert_eq!(state.notes[0].status, NoteStatus::Active);
            assert_eq!(state.notes[0].title, "Spare key");
            if which == "terminal" {
                assert_eq!(state.notes[0].area_id, None);
            } else {
                assert_eq!(state.notes[0].area_id, Some(AreaId(nid(0x41))));
            }
        },
    );
}

#[test]
fn archive_routine_and_complete_occurrence_converge() {
    run_pair(
        "archive-routine-complete",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let routine = RoutineId(nid(0x50));
            let setup = vec![record(
                1,
                0x01,
                1,
                EventKind::RoutineCreated {
                    routine_id: routine,
                    text: "Water plants".into(),
                    cadence: Cadence::Daily,
                    created_on: date(),
                },
            )];
            let terminal = record(
                10,
                terminal_device,
                terminal_time,
                EventKind::RoutineArchived {
                    routine_id: routine,
                },
            );
            let mutation = record(
                11,
                mutation_device,
                mutation_time,
                EventKind::RoutineOccurrenceCompleted {
                    routine_id: routine,
                    key: date(),
                },
            );
            (setup, terminal, mutation)
        },
        |_which, state| {
            assert!(state.routines[0].archived);
            assert!(!state.routines[0].completed);
        },
    );
}

#[test]
fn archive_talk_and_resolve_talk_converge() {
    run_pair(
        "archive-talk-resolve",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let talk = TalkId(nid(0x60));
            let setup = vec![record(
                1,
                0x01,
                1,
                EventKind::TalkAdded {
                    talk_id: talk,
                    text: "School pickup".into(),
                },
            )];
            let terminal = record(
                10,
                terminal_device,
                terminal_time,
                EventKind::TalkArchived { talk_id: talk },
            );
            let mutation = record(
                11,
                mutation_device,
                mutation_time,
                EventKind::TalkResolved { talk_id: talk },
            );
            (setup, terminal, mutation)
        },
        |_which, state| {
            assert_eq!(state.talks[0].status, TalkStatus::Archived);
        },
    );
}

#[test]
fn archive_playbook_and_save_playbook_converge() {
    run_pair(
        "archive-playbook-save",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let playbook = PlaybookId(nid(0x70));
            let setup = vec![record(
                1,
                0x01,
                1,
                EventKind::PlaybookSaved {
                    playbook_id: playbook,
                    title: "Original".into(),
                    entries: vec!["Lock doors".into()],
                },
            )];
            let terminal = record(
                10,
                terminal_device,
                terminal_time,
                EventKind::PlaybookArchived {
                    playbook_id: playbook,
                },
            );
            let mutation = record(
                11,
                mutation_device,
                mutation_time,
                EventKind::PlaybookSaved {
                    playbook_id: playbook,
                    title: "Edited".into(),
                    entries: vec!["Lock windows".into()],
                },
            );
            (setup, terminal, mutation)
        },
        |which, state| {
            assert!(state.playbooks[0].archived);
            assert_eq!(
                state.playbooks[0].title,
                if which == "terminal" {
                    "Original"
                } else {
                    "Edited"
                }
            );
        },
    );
}

#[test]
fn archive_reference_and_save_converge() {
    run_pair(
        "archive-reference-save",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let record_id = ReferenceRecordId(nid(0x80));
            let field = (ReferenceFieldId(nid(0x81)), "Code".into(), "1234".into());
            let setup = vec![record(
                1,
                0x01,
                1,
                EventKind::ReferenceRecordSaved {
                    record_id,
                    title: "Original".into(),
                    area_id: None,
                    fields: vec![field.clone()],
                },
            )];
            let terminal = record(
                10,
                terminal_device,
                terminal_time,
                EventKind::ReferenceRecordArchived { record_id },
            );
            let mutation = record(
                11,
                mutation_device,
                mutation_time,
                EventKind::ReferenceRecordSaved {
                    record_id,
                    title: "Edited".into(),
                    area_id: None,
                    fields: vec![(field.0, "Code".into(), "5678".into())],
                },
            );
            (setup, terminal, mutation)
        },
        |which, state| {
            assert!(state.reference_records[0].archived);
            assert_eq!(
                state.reference_records[0].title,
                if which == "terminal" {
                    "Original"
                } else {
                    "Edited"
                }
            );
        },
    );
}

#[test]
fn archive_reference_and_maintenance_save_converge() {
    for (label, terminal_time, mutation_time) in schedules() {
        for (terminal_device, mutation_device) in device_pairs(terminal_time, mutation_time) {
            let record_id = ReferenceRecordId(nid(0x80));
            let setup = vec![record(
                1,
                0x01,
                1,
                EventKind::ReferenceRecordSaved {
                    record_id,
                    title: "Furnace".into(),
                    area_id: None,
                    fields: vec![(ReferenceFieldId(nid(0x81)), "Filter".into(), "16x25".into())],
                },
            )];
            let terminal = record(
                10,
                terminal_device,
                terminal_time,
                EventKind::ReferenceRecordArchived { record_id },
            );
            let mutation = record(
                11,
                mutation_device,
                mutation_time,
                EventKind::MaintenanceEventSaved {
                    maintenance_id: MaintenanceEventId(nid(0x82)),
                    record_id,
                    performed_on: date(),
                    summary: "Changed filter".into(),
                    next_on: None,
                    routine_id: None,
                },
            );
            let case = format!(
                "archive-reference-maintenance/{label}/devices-{terminal_device:02x}-{mutation_device:02x}"
            );
            let state = converge(&case, &setup, terminal, mutation);
            assert!(state.reference_records[0].archived, "{case}");
            // Equal logical time still keeps the maintenance fact. A strictly
            // earlier archive makes the later save a recorded no-op.
            let kept = mutation_time <= terminal_time;
            assert_eq!(state.maintenance_events.len() == 1, kept, "{case}");
        }
    }
}

#[test]
fn archive_handoff_and_acknowledge_converge() {
    run_pair(
        "archive-handoff-acknowledge",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let handoff = HandoffId(nid(0x90));
            let setup = vec![record(
                1,
                0x01,
                1,
                EventKind::HandoffAdded {
                    handoff_id: handoff,
                    text: "Bins".into(),
                },
            )];
            let terminal = record(
                10,
                terminal_device,
                terminal_time,
                EventKind::HandoffArchived {
                    handoff_id: handoff,
                },
            );
            let mutation = record(
                11,
                mutation_device,
                mutation_time,
                EventKind::HandoffAcknowledged {
                    handoff_id: handoff,
                },
            );
            (setup, terminal, mutation)
        },
        |_which, state| {
            assert_eq!(state.handoffs[0].status, HandoffStatus::Archived);
        },
    );
}

#[test]
fn update_note_into_an_area_another_device_archived_keeps_the_edit() {
    run_pair(
        "update-note-into-archived-area",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let area = AreaId(nid(0x41));
            let note = NoteId(nid(0x40));
            let setup = vec![
                record(
                    1,
                    0x01,
                    1,
                    EventKind::AreaCreated {
                        area_id: area,
                        name: "Kitchen".into(),
                    },
                ),
                record(
                    2,
                    0x01,
                    2,
                    EventKind::NoteCreated {
                        note_id: note,
                        title: "Original".into(),
                        body: "Original body".into(),
                        area_id: None,
                    },
                ),
            ];
            let terminal = record(
                10,
                terminal_device,
                terminal_time,
                EventKind::AreaArchived { area_id: area },
            );
            let mutation = record(
                11,
                mutation_device,
                mutation_time,
                EventKind::NoteUpdated {
                    note_id: note,
                    title: "Edited".into(),
                    body: "Edited body".into(),
                    area_id: Some(area),
                },
            );
            (setup, terminal, mutation)
        },
        |which, state| {
            assert!(state.areas[0].archived);
            assert_eq!(state.notes[0].status, NoteStatus::Active);
            assert_eq!(state.notes[0].title, "Edited");
            assert_eq!(state.notes[0].body, "Edited body");
            if which == "terminal" {
                assert_eq!(state.notes[0].area_id, None);
            } else {
                assert_eq!(state.notes[0].area_id, Some(AreaId(nid(0x41))));
            }
        },
    );
}

#[test]
fn maintenance_linked_to_a_routine_another_device_archived_drops_the_link() {
    run_pair(
        "maintenance-on-archived-routine",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let routine = RoutineId(nid(0x50));
            let record_id = ReferenceRecordId(nid(0x80));
            let setup = vec![
                record(
                    1,
                    0x01,
                    1,
                    EventKind::RoutineCreated {
                        routine_id: routine,
                        text: "Change filter".into(),
                        cadence: Cadence::Daily,
                        created_on: date(),
                    },
                ),
                record(
                    2,
                    0x01,
                    2,
                    EventKind::ReferenceRecordSaved {
                        record_id,
                        title: "Furnace".into(),
                        area_id: None,
                        fields: vec![(
                            ReferenceFieldId(nid(0x81)),
                            "Filter".into(),
                            "16x25".into(),
                        )],
                    },
                ),
            ];
            let terminal = record(
                10,
                terminal_device,
                terminal_time,
                EventKind::RoutineArchived {
                    routine_id: routine,
                },
            );
            let mutation = record(
                11,
                mutation_device,
                mutation_time,
                EventKind::MaintenanceEventSaved {
                    maintenance_id: MaintenanceEventId(nid(0x82)),
                    record_id,
                    performed_on: date(),
                    summary: "Changed filter".into(),
                    next_on: None,
                    routine_id: Some(routine),
                },
            );
            (setup, terminal, mutation)
        },
        |which, state| {
            assert!(state.routines[0].archived);
            assert_eq!(state.maintenance_events.len(), 1);
            assert_eq!(state.maintenance_events[0].summary, "Changed filter");
            assert_eq!(
                state.maintenance_events[0].routine_id.is_none(),
                which == "terminal"
            );
        },
    );
}

#[test]
fn edit_of_a_maintenance_entry_another_device_archived_is_a_noop() {
    run_pair(
        "edit-archived-maintenance",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let record_id = ReferenceRecordId(nid(0x80));
            let maintenance = MaintenanceEventId(nid(0x82));
            let setup = vec![
                record(
                    1,
                    0x01,
                    1,
                    EventKind::ReferenceRecordSaved {
                        record_id,
                        title: "Furnace".into(),
                        area_id: None,
                        fields: vec![(
                            ReferenceFieldId(nid(0x81)),
                            "Filter".into(),
                            "16x25".into(),
                        )],
                    },
                ),
                record(
                    2,
                    0x01,
                    2,
                    EventKind::MaintenanceEventSaved {
                        maintenance_id: maintenance,
                        record_id,
                        performed_on: date(),
                        summary: "Changed filter".into(),
                        next_on: None,
                        routine_id: None,
                    },
                ),
            ];
            let terminal = record(
                10,
                terminal_device,
                terminal_time,
                EventKind::MaintenanceEventArchived {
                    maintenance_id: maintenance,
                },
            );
            let mutation = record(
                11,
                mutation_device,
                mutation_time,
                EventKind::MaintenanceEventSaved {
                    maintenance_id: maintenance,
                    record_id,
                    performed_on: date(),
                    summary: "Replaced filter".into(),
                    next_on: None,
                    routine_id: None,
                },
            );
            (setup, terminal, mutation)
        },
        |which, state| {
            assert_eq!(state.maintenance_events.len(), 1);
            assert!(state.maintenance_events[0].archived);
            assert_eq!(
                state.maintenance_events[0].summary,
                if which == "terminal" {
                    "Changed filter"
                } else {
                    "Replaced filter"
                }
            );
        },
    );
}

#[test]
fn two_devices_archiving_the_same_step_converge() {
    run_pair(
        "two-devices-archive-step",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let item = ItemId(nid(0x30));
            let step = StepId(nid(0x31));
            let setup = vec![
                record(
                    1,
                    0x01,
                    1,
                    EventKind::ItemAdded {
                        item_id: item,
                        text: "Clean kitchen".into(),
                        classification: ItemClassification::Need,
                    },
                ),
                record(
                    2,
                    0x01,
                    2,
                    EventKind::ItemStepAdded {
                        item_id: item,
                        step_id: step,
                        text: "Wipe counters".into(),
                    },
                ),
            ];
            (
                setup,
                record(
                    10,
                    terminal_device,
                    terminal_time,
                    EventKind::ItemStepArchived {
                        item_id: item,
                        step_id: step,
                    },
                ),
                record(
                    11,
                    mutation_device,
                    mutation_time,
                    EventKind::ItemStepArchived {
                        item_id: item,
                        step_id: step,
                    },
                ),
            )
        },
        |_which, state| {
            assert_eq!(state.items[0].status, ItemStatus::Active);
            assert!(state.items[0].steps[0].archived);
        },
    );
}

#[test]
fn two_devices_archiving_the_same_entity_converge() {
    run_pair(
        "two-devices-archive-item",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let item = ItemId(nid(0x30));
            (
                vec![record(
                    1,
                    0x01,
                    1,
                    EventKind::ItemAdded {
                        item_id: item,
                        text: "Clean kitchen".into(),
                        classification: ItemClassification::Need,
                    },
                )],
                record(
                    10,
                    terminal_device,
                    terminal_time,
                    EventKind::ItemArchived { item_id: item },
                ),
                record(
                    11,
                    mutation_device,
                    mutation_time,
                    EventKind::ItemArchived { item_id: item },
                ),
            )
        },
        |_which, state| assert_eq!(state.items[0].status, ItemStatus::Archived),
    );
    run_pair(
        "two-devices-archive-note",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let note = NoteId(nid(0x40));
            (
                vec![record(
                    1,
                    0x01,
                    1,
                    EventKind::NoteCreated {
                        note_id: note,
                        title: "Original".into(),
                        body: "Original body".into(),
                        area_id: None,
                    },
                )],
                record(
                    10,
                    terminal_device,
                    terminal_time,
                    EventKind::NoteArchived { note_id: note },
                ),
                record(
                    11,
                    mutation_device,
                    mutation_time,
                    EventKind::NoteArchived { note_id: note },
                ),
            )
        },
        |_which, state| assert_eq!(state.notes[0].status, NoteStatus::Archived),
    );
    run_pair(
        "two-devices-archive-routine",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let routine = RoutineId(nid(0x50));
            (
                vec![record(
                    1,
                    0x01,
                    1,
                    EventKind::RoutineCreated {
                        routine_id: routine,
                        text: "Water plants".into(),
                        cadence: Cadence::Daily,
                        created_on: date(),
                    },
                )],
                record(
                    10,
                    terminal_device,
                    terminal_time,
                    EventKind::RoutineArchived {
                        routine_id: routine,
                    },
                ),
                record(
                    11,
                    mutation_device,
                    mutation_time,
                    EventKind::RoutineArchived {
                        routine_id: routine,
                    },
                ),
            )
        },
        |_which, state| assert!(state.routines[0].archived),
    );
    run_pair(
        "two-devices-archive-talk",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let talk = TalkId(nid(0x60));
            (
                vec![record(
                    1,
                    0x01,
                    1,
                    EventKind::TalkAdded {
                        talk_id: talk,
                        text: "School pickup".into(),
                    },
                )],
                record(
                    10,
                    terminal_device,
                    terminal_time,
                    EventKind::TalkArchived { talk_id: talk },
                ),
                record(
                    11,
                    mutation_device,
                    mutation_time,
                    EventKind::TalkArchived { talk_id: talk },
                ),
            )
        },
        |_which, state| assert_eq!(state.talks[0].status, TalkStatus::Archived),
    );
    run_pair(
        "two-devices-archive-handoff",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let handoff = HandoffId(nid(0x90));
            (
                vec![record(
                    1,
                    0x01,
                    1,
                    EventKind::HandoffAdded {
                        handoff_id: handoff,
                        text: "Bins".into(),
                    },
                )],
                record(
                    10,
                    terminal_device,
                    terminal_time,
                    EventKind::HandoffArchived {
                        handoff_id: handoff,
                    },
                ),
                record(
                    11,
                    mutation_device,
                    mutation_time,
                    EventKind::HandoffArchived {
                        handoff_id: handoff,
                    },
                ),
            )
        },
        |_which, state| assert_eq!(state.handoffs[0].status, HandoffStatus::Archived),
    );
    run_pair(
        "two-devices-archive-maintenance",
        true,
        |terminal_device, mutation_device, terminal_time, mutation_time| {
            let record_id = ReferenceRecordId(nid(0x80));
            let maintenance = MaintenanceEventId(nid(0x82));
            let setup = vec![
                record(
                    1,
                    0x01,
                    1,
                    EventKind::ReferenceRecordSaved {
                        record_id,
                        title: "Furnace".into(),
                        area_id: None,
                        fields: vec![(
                            ReferenceFieldId(nid(0x81)),
                            "Filter".into(),
                            "16x25".into(),
                        )],
                    },
                ),
                record(
                    2,
                    0x01,
                    2,
                    EventKind::MaintenanceEventSaved {
                        maintenance_id: maintenance,
                        record_id,
                        performed_on: date(),
                        summary: "Changed filter".into(),
                        next_on: None,
                        routine_id: None,
                    },
                ),
            ];
            (
                setup,
                record(
                    10,
                    terminal_device,
                    terminal_time,
                    EventKind::MaintenanceEventArchived {
                        maintenance_id: maintenance,
                    },
                ),
                record(
                    11,
                    mutation_device,
                    mutation_time,
                    EventKind::MaintenanceEventArchived {
                        maintenance_id: maintenance,
                    },
                ),
            )
        },
        |_which, state| assert!(state.maintenance_events[0].archived),
    );
}

#[test]
fn same_device_second_archive_stays_invalid() {
    let device = 0x11;
    let item = ItemId(nid(0x30));
    let note = NoteId(nid(0x40));
    let routine = RoutineId(nid(0x50));
    let talk = TalkId(nid(0x60));
    let maintenance = MaintenanceEventId(nid(0x82));
    let record_id = ReferenceRecordId(nid(0x80));
    let item_for_step = ItemId(nid(0x32));
    let step = StepId(nid(0x33));
    let histories = [
        vec![
            record(
                1,
                device,
                1,
                EventKind::ItemAdded {
                    item_id: item,
                    text: "Clean kitchen".into(),
                    classification: ItemClassification::Need,
                },
            ),
            record(2, device, 2, EventKind::ItemArchived { item_id: item }),
            record(3, device, 3, EventKind::ItemArchived { item_id: item }),
        ],
        vec![
            record(
                1,
                device,
                1,
                EventKind::NoteCreated {
                    note_id: note,
                    title: "Original".into(),
                    body: String::new(),
                    area_id: None,
                },
            ),
            record(2, device, 2, EventKind::NoteArchived { note_id: note }),
            record(3, device, 3, EventKind::NoteArchived { note_id: note }),
        ],
        vec![
            record(
                1,
                device,
                1,
                EventKind::RoutineCreated {
                    routine_id: routine,
                    text: "Water plants".into(),
                    cadence: Cadence::Daily,
                    created_on: date(),
                },
            ),
            record(
                2,
                device,
                2,
                EventKind::RoutineArchived {
                    routine_id: routine,
                },
            ),
            record(
                3,
                device,
                3,
                EventKind::RoutineArchived {
                    routine_id: routine,
                },
            ),
        ],
        vec![
            record(
                1,
                device,
                1,
                EventKind::TalkAdded {
                    talk_id: talk,
                    text: "School pickup".into(),
                },
            ),
            record(2, device, 2, EventKind::TalkArchived { talk_id: talk }),
            record(3, device, 3, EventKind::TalkArchived { talk_id: talk }),
        ],
        vec![
            record(
                1,
                device,
                1,
                EventKind::ReferenceRecordSaved {
                    record_id,
                    title: "Furnace".into(),
                    area_id: None,
                    fields: vec![(ReferenceFieldId(nid(0x81)), "Filter".into(), "16x25".into())],
                },
            ),
            record(
                2,
                device,
                2,
                EventKind::MaintenanceEventSaved {
                    maintenance_id: maintenance,
                    record_id,
                    performed_on: date(),
                    summary: "Changed filter".into(),
                    next_on: None,
                    routine_id: None,
                },
            ),
            record(
                3,
                device,
                3,
                EventKind::MaintenanceEventArchived {
                    maintenance_id: maintenance,
                },
            ),
            record(
                4,
                device,
                4,
                EventKind::MaintenanceEventArchived {
                    maintenance_id: maintenance,
                },
            ),
        ],
        vec![
            record(
                1,
                device,
                1,
                EventKind::ItemAdded {
                    item_id: item_for_step,
                    text: "Clean kitchen".into(),
                    classification: ItemClassification::Need,
                },
            ),
            record(
                2,
                device,
                2,
                EventKind::ItemStepAdded {
                    item_id: item_for_step,
                    step_id: step,
                    text: "Wipe counters".into(),
                },
            ),
            record(
                3,
                device,
                3,
                EventKind::ItemStepArchived {
                    item_id: item_for_step,
                    step_id: step,
                },
            ),
            record(
                4,
                device,
                4,
                EventKind::ItemStepArchived {
                    item_id: item_for_step,
                    step_id: step,
                },
            ),
        ],
    ];
    for history in histories {
        assert!(project_records(&history).is_err());
    }
}

#[test]
fn same_device_mutations_after_its_own_archive_stay_invalid() {
    let item = ItemId(nid(0x30));
    let area = AreaId(nid(0x41));
    let note = NoteId(nid(0x40));
    let device = 0x11;
    let step_after_own_archive = vec![
        record(
            1,
            device,
            1,
            EventKind::ItemAdded {
                item_id: item,
                text: "Clean kitchen".into(),
                classification: ItemClassification::Need,
            },
        ),
        record(2, device, 2, EventKind::ItemArchived { item_id: item }),
        record(
            3,
            device,
            3,
            EventKind::ItemStepAdded {
                item_id: item,
                step_id: StepId(nid(0x31)),
                text: "Wipe counters".into(),
            },
        ),
    ];
    assert!(project_records(&step_after_own_archive).is_err());
    let note_in_own_archived_area = vec![
        record(
            1,
            device,
            1,
            EventKind::AreaCreated {
                area_id: area,
                name: "Kitchen".into(),
            },
        ),
        record(2, device, 2, EventKind::AreaArchived { area_id: area }),
        record(
            3,
            device,
            3,
            EventKind::NoteCreated {
                note_id: note,
                title: "Spare key".into(),
                body: String::new(),
                area_id: Some(area),
            },
        ),
    ];
    assert!(project_records(&note_in_own_archived_area).is_err());
    let move_into_own_archived_area = vec![
        record(
            1,
            device,
            1,
            EventKind::AreaCreated {
                area_id: area,
                name: "Kitchen".into(),
            },
        ),
        record(
            2,
            device,
            2,
            EventKind::NoteCreated {
                note_id: note,
                title: "Original".into(),
                body: "Original body".into(),
                area_id: None,
            },
        ),
        record(3, device, 3, EventKind::AreaArchived { area_id: area }),
        record(
            4,
            device,
            4,
            EventKind::NoteUpdated {
                note_id: note,
                title: "Edited".into(),
                body: "Edited body".into(),
                area_id: Some(area),
            },
        ),
    ];
    assert!(project_records(&move_into_own_archived_area).is_err());
    let record_id = ReferenceRecordId(nid(0x80));
    let maintenance = MaintenanceEventId(nid(0x82));
    let edit_own_archived_maintenance = vec![
        record(
            1,
            device,
            1,
            EventKind::ReferenceRecordSaved {
                record_id,
                title: "Furnace".into(),
                area_id: None,
                fields: vec![(ReferenceFieldId(nid(0x81)), "Filter".into(), "16x25".into())],
            },
        ),
        record(
            2,
            device,
            2,
            EventKind::MaintenanceEventSaved {
                maintenance_id: maintenance,
                record_id,
                performed_on: date(),
                summary: "Changed filter".into(),
                next_on: None,
                routine_id: None,
            },
        ),
        record(
            3,
            device,
            3,
            EventKind::MaintenanceEventArchived {
                maintenance_id: maintenance,
            },
        ),
        record(
            4,
            device,
            4,
            EventKind::MaintenanceEventSaved {
                maintenance_id: maintenance,
                record_id,
                performed_on: date(),
                summary: "Replaced filter".into(),
                next_on: None,
                routine_id: None,
            },
        ),
    ];
    assert!(project_records(&edit_own_archived_maintenance).is_err());
}
