use crate::event::*;
use crate::state::{self, NoteStatus};

fn id(value: u8) -> [u8; 16] {
    [value; 16]
}
fn event(sequence: u8, kind: EventKind) -> EventEnvelope {
    EventEnvelope {
        event_id: EventId(id(sequence)),
        household_id: HouseholdId(id(200)),
        actor_id: ActorId(id(sequence)),
        device_id: DeviceId(id(201)),
        timestamp: 1_760_000_000_000 + i64::from(sequence),
        logical_time: u64::from(sequence),
        event_version: 1,
        kind,
        canonical_bytes: vec![sequence],
    }
}

#[test]
fn note_lifecycle_preserves_identity_provenance_and_terminal_archive() {
    let note = NoteId(id(8));
    let history = vec![
        event(
            1,
            EventKind::NoteCreated {
                note_id: note,
                title: "  Wi-Fi  ".into(),
                body: "Router is in the hall.\nGuest network: kin-guest".into(),
                area_id: None,
            },
        ),
        event(
            2,
            EventKind::NoteUpdated {
                note_id: note,
                title: "Wi-Fi".into(),
                body: "Router is in the hall.".into(),
                area_id: None,
            },
        ),
        event(3, EventKind::NoteArchived { note_id: note }),
    ];
    let projection = state::rebuild(
        &history,
        0,
        crate::recurrence::CivilDate::from_encoded(20261003).unwrap(),
    )
    .unwrap();
    assert_eq!(projection.notes.len(), 1);
    assert_eq!(projection.notes[0].note_id, note);
    assert_eq!(projection.notes[0].title, "Wi-Fi");
    assert_eq!(projection.notes[0].created_by, ActorId(id(1)));
    assert_eq!(projection.notes[0].updated_by, ActorId(id(2)));
    assert_eq!(projection.notes[0].status, NoteStatus::Archived);
    assert_eq!(
        state::rebuild(
            &[],
            0,
            crate::recurrence::CivilDate::from_encoded(20261003).unwrap()
        )
        .unwrap()
        .notes,
        Vec::new()
    );
}

#[test]
fn note_validation_and_unknown_or_archived_lifecycle_fail_closed() {
    assert!(state::normalize_note("\t", "body").is_err());
    assert!(state::normalize_note(&"é".repeat(129), "").is_err());
    assert!(state::normalize_note("Title", &"x".repeat(state::MAX_NOTE_BODY_BYTES + 1)).is_err());
    assert!(state::normalize_note("Title", "unsafe\u{0000}").is_err());
    let note = NoteId(id(8));
    let history = vec![
        event(
            1,
            EventKind::NoteCreated {
                note_id: note,
                title: "Title".into(),
                body: String::new(),
                area_id: None,
            },
        ),
        event(2, EventKind::NoteArchived { note_id: note }),
        event(
            3,
            EventKind::NoteUpdated {
                note_id: note,
                title: "After".into(),
                body: String::new(),
                area_id: None,
            },
        ),
    ];
    assert!(state::rebuild(
        &history,
        0,
        crate::recurrence::CivilDate::from_encoded(20261003).unwrap()
    )
    .is_err());
    assert!(state::rebuild(
        &[event(1, EventKind::NoteArchived { note_id: note })],
        0,
        crate::recurrence::CivilDate::from_encoded(20261003).unwrap()
    )
    .is_err());
}

#[test]
fn concurrent_note_update_and_archive_converge_with_archive_winning_in_both_device_orders() {
    fn replay(update_device: u8, archive_device: u8) -> state::HouseholdState {
        let note_id = NoteId(id(8));
        let mut created = event(
            1,
            EventKind::NoteCreated {
                note_id,
                title: "Original".into(),
                body: "Original body".into(),
                area_id: None,
            },
        );
        created.device_id = DeviceId(id(1));
        let mut updated = event(
            2,
            EventKind::NoteUpdated {
                note_id,
                title: "Concurrent edit".into(),
                body: "Must not replace the archived reference".into(),
                area_id: None,
            },
        );
        updated.logical_time = 2;
        updated.device_id = DeviceId(id(update_device));
        let mut archived = event(3, EventKind::NoteArchived { note_id });
        archived.logical_time = 2;
        archived.device_id = DeviceId(id(archive_device));
        state::rebuild(
            &[created, updated, archived],
            0,
            crate::recurrence::CivilDate::from_encoded(20261005).unwrap(),
        )
        .unwrap()
    }

    let update_first = replay(10, 20);
    let archive_first = replay(20, 10);
    assert_eq!(update_first, archive_first);
    assert_eq!(update_first.notes[0].title, "Original");
    assert_eq!(update_first.notes[0].body, "Original body");
    assert_eq!(update_first.notes[0].status, NoteStatus::Archived);
}

#[test]
fn concurrent_note_archives_converge_and_same_device_rearchives_are_rejected() {
    fn replay(first_device: u8, second_device: u8, reverse_input: bool) -> state::HouseholdState {
        let note_id = NoteId(id(8));
        let mut created = event(
            1,
            EventKind::NoteCreated {
                note_id,
                title: "Reference".into(),
                body: "Keep this detail".into(),
                area_id: None,
            },
        );
        created.device_id = DeviceId(id(1));

        let mut first_archive = event(2, EventKind::NoteArchived { note_id });
        first_archive.logical_time = 2;
        first_archive.device_id = DeviceId(id(first_device));
        let mut second_archive = event(3, EventKind::NoteArchived { note_id });
        second_archive.logical_time = 2;
        second_archive.device_id = DeviceId(id(second_device));

        let history = if reverse_input {
            vec![created, second_archive, first_archive]
        } else {
            vec![created, first_archive, second_archive]
        };
        state::rebuild(
            &history,
            0,
            crate::recurrence::CivilDate::from_encoded(20261005).unwrap(),
        )
        .unwrap()
    }

    let forward = replay(10, 20, false);
    let reverse = replay(20, 10, true);
    assert_eq!(forward, reverse);
    assert_eq!(forward.notes[0].status, NoteStatus::Archived);
    assert_eq!(forward.notes[0].body, "Keep this detail");

    let note_id = NoteId(id(8));
    let mut created = event(
        1,
        EventKind::NoteCreated {
            note_id,
            title: "Reference".into(),
            body: String::new(),
            area_id: None,
        },
    );
    created.device_id = DeviceId(id(1));
    let mut archived = event(2, EventKind::NoteArchived { note_id });
    archived.logical_time = 2;
    archived.device_id = DeviceId(id(10));
    let mut later_archive = event(3, EventKind::NoteArchived { note_id });
    later_archive.logical_time = 3;
    later_archive.device_id = DeviceId(id(20));
    let later = state::rebuild(
        &[created.clone(), archived.clone(), later_archive],
        0,
        crate::recurrence::CivilDate::from_encoded(20261005).unwrap(),
    )
    .unwrap();
    assert_eq!(later.notes[0].status, NoteStatus::Archived);

    archived.device_id = DeviceId(id(10));
    let mut same_device_archive = event(3, EventKind::NoteArchived { note_id });
    same_device_archive.logical_time = 2;
    same_device_archive.device_id = DeviceId(id(10));
    assert!(state::rebuild(
        &[created, archived, same_device_archive],
        0,
        crate::recurrence::CivilDate::from_encoded(20261005).unwrap(),
    )
    .is_err());
}

#[test]
fn note_event_roundtrips_through_the_codec() {
    let source = event(
        1,
        EventKind::NoteCreated {
            note_id: NoteId(id(8)),
            title: "House details".into(),
            body: "A plain text note".into(),
            area_id: None,
        },
    );
    let bytes = crate::codec::encode_event(&source).unwrap();
    assert_eq!(
        crate::event_decode::decode_event(&bytes).unwrap().kind,
        source.kind
    );
}

#[test]
fn note_area_links_require_known_active_areas_and_survive_archive() {
    let area_id = AreaId(id(7));
    let note_id = NoteId(id(8));
    let history = vec![
        event(
            1,
            EventKind::AreaCreated {
                area_id,
                name: "Home".into(),
            },
        ),
        event(
            2,
            EventKind::NoteCreated {
                note_id,
                title: "Reference".into(),
                body: String::new(),
                area_id: Some(area_id),
            },
        ),
        event(3, EventKind::AreaArchived { area_id }),
        event(
            4,
            EventKind::NoteUpdated {
                note_id,
                title: "Reference".into(),
                body: "Kept for history".into(),
                area_id: Some(area_id),
            },
        ),
    ];
    let projection = state::rebuild(
        &history,
        0,
        crate::recurrence::CivilDate::from_encoded(20261003).unwrap(),
    )
    .unwrap();
    assert_eq!(projection.notes[0].area_id, Some(area_id));
    assert!(projection.areas[0].archived);

    let missing = vec![event(
        1,
        EventKind::NoteCreated {
            note_id,
            title: "Reference".into(),
            body: String::new(),
            area_id: Some(area_id),
        },
    )];
    assert!(state::rebuild(
        &missing,
        0,
        crate::recurrence::CivilDate::from_encoded(20261003).unwrap()
    )
    .is_err());
    let archived_first = vec![
        event(
            1,
            EventKind::AreaCreated {
                area_id,
                name: "Home".into(),
            },
        ),
        event(2, EventKind::AreaArchived { area_id }),
        event(
            3,
            EventKind::NoteCreated {
                note_id,
                title: "Reference".into(),
                body: String::new(),
                area_id: Some(area_id),
            },
        ),
    ];
    assert!(state::rebuild(
        &archived_first,
        0,
        crate::recurrence::CivilDate::from_encoded(20261003).unwrap()
    )
    .is_err());
}

#[test]
fn note_command_projects_only_valid_commands_without_mutating_input_history() {
    let request = crate::request::DecodedRequest {
        events: Vec::new(),
        as_of: 0,
        summary_cursor: None,
        civil_date: crate::recurrence::CivilDate::from_encoded(20261005).unwrap(),
        target_household_id: None,
        identity_bindings: Vec::new(),
    };
    let context = crate::command::CommandContext {
        event_id: EventId(id(1)),
        household_id: HouseholdId(id(200)),
        actor_id: ActorId(id(2)),
        device_id: DeviceId(id(201)),
        timestamp: 1_760_000_000_001,
        logical_time: 1,
    };
    let invalid = crate::command::HouseholdCommand::CreateNote {
        id: NoteId(id(8)),
        title: "  ".into(),
        body: String::new(),
        area_id: None,
    };
    assert!(crate::command::execute(&invalid, context, request.clone()).is_err());
    assert!(request.events.is_empty());
    let valid = crate::command::HouseholdCommand::CreateNote {
        id: NoteId(id(8)),
        title: " Wi-Fi ".into(),
        body: "Router".into(),
        area_id: None,
    };
    let result = crate::command::execute(&valid, context, request).unwrap();
    assert_eq!(result.projection.notes[0].title, "Wi-Fi");
    assert_eq!(crate::codec::kind_code(&result.event.kind), 22);
}
