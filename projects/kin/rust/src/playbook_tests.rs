use crate::command::{execute, CommandContext, HouseholdCommand as C};
use crate::event::*;
use crate::event_decode::decode_event;
use crate::recurrence::CivilDate;
use crate::request::DecodedRequest;
use crate::state::{rebuild, MAX_PLAYBOOKS};

fn context(n: u8, device: u8) -> CommandContext {
    CommandContext {
        event_id: EventId([n.wrapping_add(device); 16]),
        household_id: HouseholdId([1; 16]),
        actor_id: ActorId([2; 16]),
        device_id: DeviceId([device; 16]),
        timestamp: 1_791_475_200_000 + n as i64,
        logical_time: n as u64,
    }
}
fn request(events: Vec<EventEnvelope>) -> DecodedRequest {
    DecodedRequest {
        events,
        as_of: 1_791_475_200_000,
        summary_cursor: None,
        civil_date: CivilDate::from_encoded(20261009).unwrap(),
        target_household_id: None,
        identity_bindings: vec![],
    }
}
fn add(events: &mut Vec<EventEnvelope>, command: C, n: u8) {
    let result = execute(&command, context(n, 3), request(events.clone())).unwrap();
    events.push(result.event);
}

#[test]
fn playbook_create_edit_archive_replay_and_event_roundtrip() {
    let id = PlaybookId([9; 16]);
    let mut events = vec![];
    add(
        &mut events,
        C::SavePlaybook {
            id,
            title: " Weekly reset ".into(),
            entries: vec![" Laundry ".into(), "Replace filter 🧰".into()],
        },
        1,
    );
    assert_eq!(decode_event(&events[0].canonical_bytes).unwrap(), events[0]);
    let first = rebuild(
        &events,
        1_791_475_200_001,
        CivilDate::from_encoded(20261009).unwrap(),
    )
    .unwrap();
    assert_eq!(first.playbooks[0].title, "Weekly reset");
    assert_eq!(first.playbooks[0].entries, ["Laundry", "Replace filter 🧰"]);
    add(
        &mut events,
        C::SavePlaybook {
            id,
            title: "Vacation prep".into(),
            entries: vec!["Lock doors".into()],
        },
        2,
    );
    let edited = rebuild(
        &events,
        1_791_475_200_002,
        CivilDate::from_encoded(20261009).unwrap(),
    )
    .unwrap();
    assert_eq!(edited.playbooks[0].title, "Vacation prep");
    assert_eq!(edited.playbooks[0].entries, ["Lock doors"]);
    add(&mut events, C::ArchivePlaybook(id), 3);
    let archived = rebuild(
        &events,
        1_791_475_200_003,
        CivilDate::from_encoded(20261009).unwrap(),
    )
    .unwrap();
    assert!(archived.playbooks[0].archived);
    assert!(execute(
        &C::SavePlaybook {
            id,
            title: "Resurrect".into(),
            entries: vec!["x".into()]
        },
        context(4, 3),
        request(events)
    )
    .is_err());
}

#[test]
fn playbooks_enforce_limits() {
    let legacy = crate::command::create_event(
        &C::AddItem {
            id: ItemId([7; 16]),
            text: "Old task".into(),
            classification: ItemClassification::Need,
        },
        context(1, 3),
    )
    .unwrap();
    let mut events = vec![legacy];
    add(
        &mut events,
        C::SavePlaybook {
            id: PlaybookId([8; 16]),
            title: "Travel".into(),
            entries: vec!["Passport".into()],
        },
        2,
    );
    let state = rebuild(
        &events,
        1_791_475_200_002,
        CivilDate::from_encoded(20261009).unwrap(),
    )
    .unwrap();
    assert_eq!(state.items[0].text, "Old task");
    assert_eq!(state.playbooks.len(), 1);
    let mut many = Vec::new();
    for n in 1..=MAX_PLAYBOOKS as u8 {
        add(
            &mut many,
            C::SavePlaybook {
                id: PlaybookId([n; 16]),
                title: format!("Template {n}"),
                entries: vec!["One step".into()],
            },
            n,
        );
    }
    assert!(execute(
        &C::SavePlaybook {
            id: PlaybookId([99; 16]),
            title: "Too many".into(),
            entries: vec!["Step".into()]
        },
        context(33, 3),
        request(many)
    )
    .is_err());
    assert!(execute(
        &C::SavePlaybook {
            id: PlaybookId([90; 16]),
            title: "Empty".into(),
            entries: vec![]
        },
        context(1, 3),
        request(vec![])
    )
    .is_err());
}

#[test]
fn same_logical_time_offline_edits_converge_in_stable_device_order() {
    let id = PlaybookId([6; 16]);
    let mut events = vec![crate::command::create_event(
        &C::SavePlaybook {
            id,
            title: "Original".into(),
            entries: vec!["A".into()],
        },
        context(1, 3),
    )
    .unwrap()];
    let left = crate::command::create_event(
        &C::SavePlaybook {
            id,
            title: "Left".into(),
            entries: vec!["L".into()],
        },
        context(2, 7),
    )
    .unwrap();
    let right = crate::command::create_event(
        &C::SavePlaybook {
            id,
            title: "Right".into(),
            entries: vec!["R".into()],
        },
        context(2, 8),
    )
    .unwrap();
    events.extend([left.clone(), right.clone()]);
    let forward = rebuild(
        &events,
        1_791_475_200_002,
        CivilDate::from_encoded(20261009).unwrap(),
    )
    .unwrap();
    events.swap(1, 2);
    let reverse = rebuild(
        &events,
        1_791_475_200_002,
        CivilDate::from_encoded(20261009).unwrap(),
    )
    .unwrap();
    assert_eq!(forward, reverse);
    assert_eq!(forward.playbooks[0].title, "Right");
}
