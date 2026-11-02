// Member preferred names (#218, #224): MEMBER_NAMED (51), its replay rules,
// the command that creates it and the KMNM table. Wire records are written out
// by hand; they never come from the encoders.
use crate::command::{decode_command, execute, CommandContext, HouseholdCommand as C};
use crate::core::{encode_member_names, member_names, replay};
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::recurrence::CivilDate;
use crate::request::{decode_request, DecodedRequest};
use crate::state::{rebuild, HouseholdState, MemberNameState};
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const MEMBER_1: [u8; 16] = [1; 16];
const MEMBER_2: [u8; 16] = [2; 16];

fn record(event: u32, actor: [u8; 16], device: u8, logical_time: u64, payload: &[u8]) -> Vec<u8> {
    let mut record = Vec::new();
    record.extend_from_slice(&1u16.to_le_bytes());
    record.extend_from_slice(&51u16.to_le_bytes());
    record.extend_from_slice(&numbered_id(event));
    record.extend_from_slice(&HOUSEHOLD);
    record.extend_from_slice(&actor);
    record.extend_from_slice(&[device; 16]);
    record.extend_from_slice(&1_791_475_200_000i64.to_le_bytes());
    record.extend_from_slice(&logical_time.to_le_bytes());
    record.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    record.extend_from_slice(payload);
    record
}

/// MEMBER_NAMED by `actor` from `device`; an empty name clears it.
fn named(event: u32, actor: [u8; 16], device: u8, name: &str) -> Vec<u8> {
    named_at(event, actor, device, u64::from(event), name)
}

fn named_at(event: u32, actor: [u8; 16], device: u8, logical_time: u64, name: &str) -> Vec<u8> {
    let mut payload = (name.len() as u32).to_le_bytes().to_vec();
    payload.extend_from_slice(name.as_bytes());
    record(event, actor, device, logical_time, &payload)
}

fn project(records: &[Vec<u8>]) -> Result<HouseholdState, KinError> {
    let request = decode_request(&kine(records, 0, TEST_DATE, None))?;
    rebuild(&request.events, request.as_of, request.civil_date)
}

fn member(id: [u8; 16], name: &str) -> MemberNameState {
    MemberNameState {
        member_id: ActorId(id),
        name: name.into(),
    }
}

#[test]
fn each_member_names_only_themselves_and_the_latest_name_wins() {
    let records = [
        named(1, MEMBER_2, 0x21, "Sam"),
        named(2, MEMBER_1, 0x11, "Michael"),
        // From another of member 1's devices: still member 1's own name.
        named(3, MEMBER_1, 0x12, "Mikey 🛠️"),
        named(4, MEMBER_2, 0x21, "Samantha"),
    ];
    assert_eq!(
        project(&records).unwrap().member_names,
        vec![member(MEMBER_1, "Mikey 🛠️"), member(MEMBER_2, "Samantha")],
        "member-ID order, latest name per member"
    );
}

#[test]
fn clearing_a_name_falls_back_and_leaves_other_members_alone() {
    let records = [
        named(1, MEMBER_1, 0x11, "Mikey"),
        named(2, MEMBER_2, 0x21, "Sam"),
        named(3, MEMBER_1, 0x11, ""),
    ];
    assert_eq!(
        project(&records).unwrap().member_names,
        vec![member(MEMBER_2, "Sam")]
    );
    // Clearing a name that was never set is kept and changes nothing.
    assert_eq!(
        project(&[named(1, MEMBER_1, 0x11, "")])
            .unwrap()
            .member_names,
        vec![]
    );
}

#[test]
fn devices_converge_whatever_order_names_arrive_in() {
    // Two devices of one member rename offline; the log orders them by
    // logical time, then device, then event ID, so arrival order is moot.
    let first = named_at(1, MEMBER_1, 0x11, 10, "Mike");
    let second = named_at(2, MEMBER_1, 0x12, 11, "Mikey");
    let tie_low = named_at(3, MEMBER_2, 0x21, 20, "Sam");
    let tie_high = named_at(4, MEMBER_2, 0x22, 20, "Samantha");
    let expected = vec![member(MEMBER_1, "Mikey"), member(MEMBER_2, "Samantha")];
    for order in [
        vec![
            first.clone(),
            second.clone(),
            tie_low.clone(),
            tie_high.clone(),
        ],
        vec![
            tie_high.clone(),
            second.clone(),
            tie_low.clone(),
            first.clone(),
        ],
        vec![
            second.clone(),
            tie_high.clone(),
            first.clone(),
            tie_low.clone(),
        ],
    ] {
        assert_eq!(project(&order).unwrap().member_names, expected);
    }
    // An exact duplicate (a resent event) is skipped.
    assert_eq!(
        project(&[first.clone(), second.clone(), first.clone()])
            .unwrap()
            .member_names,
        vec![member(MEMBER_1, "Mikey")]
    );
}

#[test]
fn names_must_be_canonical_on_the_wire() {
    let long = "m".repeat(33);
    for name in [
        " Mikey",
        "Mikey ",
        "Mi\nkey",
        "Mikey\u{202e}",
        "Mi\u{200b}key",
        "\u{feff}Mikey",
        "Mi\u{2066}key",
        long.as_str(),
    ] {
        assert_eq!(
            decode_event(&named(1, MEMBER_1, 0x11, name)),
            Err(KinError::MalformedProtocol),
            "{name:?}"
        );
    }
    // 32 characters of four bytes each is the longest name.
    assert!(decode_event(&named(1, MEMBER_1, 0x11, &"🏠".repeat(32))).is_ok());
    // Joiners stay allowed inside emoji sequences, and an empty name clears.
    assert!(decode_event(&named(1, MEMBER_1, 0x11, "👩‍💻 Sam")).is_ok());
    assert_eq!(
        decode_event(&named(1, MEMBER_1, 0x11, "")).unwrap().kind,
        EventKind::MemberNamed { name: None }
    );

    let mut short_length = named(1, MEMBER_1, 0x11, "Mikey");
    short_length[88] -= 1;
    let mut invalid_utf8 = named(1, MEMBER_1, 0x11, "Mikey");
    invalid_utf8[92] = 0xff;
    let no_length = record(1, MEMBER_1, 0x11, 1, &[]);
    for bytes in [short_length, invalid_utf8, no_length] {
        assert_eq!(decode_event(&bytes), Err(KinError::MalformedProtocol));
    }
}

#[test]
fn member_names_do_not_change_the_projection() {
    let items = [item_record(1, 0x31, b"Milk", 1)];
    let mut with_names = items.to_vec();
    with_names.push(named(2, [0xbb; 16], 0xcc, "Mikey"));
    let without = replay(&kine(&items, 0, TEST_DATE, None)).unwrap();
    let mut with = replay(&kine(&with_names, 0, TEST_DATE, None)).unwrap();
    // Only the summary's "through" event ID (header bytes 36..52) moves on;
    // a name is not a summary entry and changes nothing a member sees.
    assert_eq!(with[36..52], numbered_id(2));
    with[36..52].copy_from_slice(&numbered_id(1));
    assert_eq!(without, with);
}

fn context(event: u8, actor: [u8; 16], device: u8, logical_time: u64) -> CommandContext {
    CommandContext {
        event_id: EventId([event; 16]),
        household_id: HouseholdId(HOUSEHOLD),
        actor_id: ActorId(actor),
        device_id: DeviceId([device; 16]),
        timestamp: 1_791_475_200_000,
        logical_time,
    }
}

fn request(events: &[EventEnvelope]) -> DecodedRequest {
    DecodedRequest {
        events: events.to_vec(),
        as_of: 1_791_475_200_100,
        summary_cursor: None,
        civil_date: CivilDate::from_encoded(TEST_DATE).unwrap(),
        target_household_id: None,
        identity_bindings: vec![],
    }
}

fn run(events: &mut Vec<EventEnvelope>, command: C, ctx: CommandContext) -> Result<(), KinError> {
    let result = execute(&command, ctx, request(events))?;
    events.push(result.event);
    Ok(())
}

fn names(events: &[EventEnvelope]) -> Vec<MemberNameState> {
    rebuild(
        events,
        1_791_475_200_100,
        CivilDate::from_encoded(TEST_DATE).unwrap(),
    )
    .unwrap()
    .member_names
}

#[test]
fn commands_set_rename_and_clear_only_the_actors_own_name() {
    let mut events = Vec::new();
    let name = |value: &str| C::NameMember {
        name: Some(value.into()),
    };
    run(
        &mut events,
        name("  Mikey  "),
        context(1, MEMBER_1, 0x11, 1),
    )
    .unwrap();
    assert_eq!(
        events[0].kind,
        EventKind::MemberNamed {
            name: Some("Mikey".into())
        },
        "the command stores the trimmed, canonical name"
    );
    assert_eq!(
        events[0].actor_id,
        ActorId(MEMBER_1),
        "the name belongs to the actor"
    );
    run(&mut events, name("Sam"), context(2, MEMBER_2, 0x21, 2)).unwrap();
    assert_eq!(
        names(&events),
        vec![member(MEMBER_1, "Mikey"), member(MEMBER_2, "Sam")]
    );

    // No-ops record nothing: the same name again (even padded), or clearing
    // a name that is not set.
    for (command, ctx) in [
        (name("Mikey"), context(3, MEMBER_1, 0x12, 3)),
        (name(" Mikey "), context(3, MEMBER_1, 0x11, 3)),
        (C::NameMember { name: None }, context(3, [9; 16], 0x91, 3)),
    ] {
        assert_eq!(run(&mut events, command, ctx), Err(KinError::InvalidEvent));
    }
    // Names that aren't valid at all.
    for bad in ["", "   ", "Mi\u{202e}key", &"m".repeat(33), "Mi\u{7}key"] {
        assert_eq!(
            run(&mut events, name(bad), context(3, MEMBER_1, 0x11, 3)),
            Err(KinError::InvalidEvent),
            "{bad:?}"
        );
    }

    // Renaming from another device of the same member, then clearing.
    run(&mut events, name("Michael"), context(4, MEMBER_1, 0x12, 4)).unwrap();
    run(
        &mut events,
        C::NameMember { name: None },
        context(5, MEMBER_2, 0x21, 5),
    )
    .unwrap();
    assert_eq!(names(&events), vec![member(MEMBER_1, "Michael")]);
}

fn kcmd(kind: u16, id: [u8; 16], option: u8, text: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0; 128];
    bytes[..4].copy_from_slice(b"KCMD");
    bytes[4..6].copy_from_slice(&1u16.to_le_bytes());
    bytes[8..10].copy_from_slice(&kind.to_le_bytes());
    bytes[84..92].copy_from_slice(&1u64.to_le_bytes());
    bytes[92..108].copy_from_slice(&id);
    bytes[112] = option;
    bytes[124..128].copy_from_slice(&(text.len() as u32).to_le_bytes());
    bytes.extend_from_slice(text);
    bytes
}

#[test]
fn kcmd_action_51_carries_the_actors_own_name() {
    assert_eq!(
        decode_command(&kcmd(51, [0; 16], 0, "Mikey".as_bytes()))
            .unwrap()
            .0,
        C::NameMember {
            name: Some("Mikey".into())
        }
    );
    assert_eq!(
        decode_command(&kcmd(51, [0; 16], 0, b"")).unwrap().0,
        C::NameMember { name: None }
    );
    let too_long = vec![b'a'; crate::state::MAX_DEVICE_NAME_BYTES + 1];
    for bytes in [
        // There is no target: naming someone else is not expressible.
        kcmd(51, [0x22; 16], 0, b"Sam"),
        kcmd(51, [0; 16], 1, b"Mikey"),
        kcmd(51, [0; 16], 0, &too_long),
        kcmd(51, [0; 16], 0, &[0xff]),
    ] {
        assert_eq!(
            decode_command(&bytes).unwrap_err(),
            KinError::MalformedProtocol
        );
    }
}

#[test]
fn the_kmnm_table_is_laid_out_as_documented() {
    let bytes = encode_member_names(&[member(MEMBER_1, "Mikey"), member(MEMBER_2, "Sam")]).unwrap();
    let mut expected = b"KMNM".to_vec();
    expected.extend_from_slice(&[1, 0, 0, 0, 2, 0, 0, 0]);
    expected.extend_from_slice(&MEMBER_1);
    expected.extend_from_slice(&[5, 0]);
    expected.extend_from_slice(b"Mikey");
    expected.extend_from_slice(&MEMBER_2);
    expected.extend_from_slice(&[3, 0]);
    expected.extend_from_slice(b"Sam");
    assert_eq!(bytes, expected);
    assert_eq!(encode_member_names(&[]).unwrap(), b"KMNM\x01\0\0\0\0\0\0\0");
}

#[test]
fn held_history_names_members_after_identity_bindings() {
    // A name recorded under a placeholder tuple a binding maps to member 3.
    let placeholder = [0x77; 16];
    let records = [named(1, MEMBER_1, 0x11, "Mikey"), {
        let mut bytes = named(2, placeholder, 0x76, "Robin");
        bytes[20..36].copy_from_slice(&[0x75; 16]);
        bytes
    }];
    let binding = IdentityBinding {
        legacy_household_id: HouseholdId([0x75; 16]),
        legacy_actor_id: ActorId(placeholder),
        legacy_device_id: DeviceId([0x76; 16]),
        household_id: HouseholdId(HOUSEHOLD),
        actor_id: ActorId([3; 16]),
        device_id: DeviceId([0x31; 16]),
    };
    let context = bound_kine(&[], 0, TEST_DATE, None, Some(HOUSEHOLD), &[binding]);
    let mut history = History::new();
    let mut batch = (records.len() as u32).to_le_bytes().to_vec();
    for record in &records {
        batch.extend_from_slice(&(record.len() as u32).to_le_bytes());
    }
    for record in &records {
        batch.extend_from_slice(record);
    }
    history.append(&batch).unwrap();
    assert_eq!(
        member_names(&context, &mut history).unwrap(),
        encode_member_names(&[member(MEMBER_1, "Mikey"), member([3; 16], "Robin")]).unwrap()
    );
    // Like kin_device_names, the context must carry no records.
    let with_record = bound_kine(&records[..1], 0, TEST_DATE, None, Some(HOUSEHOLD), &[]);
    assert_eq!(
        member_names(&with_record, &mut history).unwrap_err(),
        KinError::MalformedProtocol
    );
}
