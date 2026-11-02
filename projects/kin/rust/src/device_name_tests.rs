// Device names (#71): DEVICE_DESCRIBED (42) and DEVICE_NICKNAMED (43), their
// replay rules, the commands that create them and the KDEV table. Wire
// records are written out by hand; they never come from the encoders.
use crate::command::{decode_command, execute, CommandContext, HouseholdCommand as C};
use crate::core::{device_names, encode_device_names, replay, replay_history};
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::recurrence::CivilDate;
use crate::request::{decode_request, DecodedRequest};
use crate::state::{rebuild, DeviceNameState, HouseholdState};
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
/// Member 1 owns devices 0x11 and 0x12; member 2 owns device 0x21.
const MEMBER_1: [u8; 16] = [1; 16];
const MEMBER_2: [u8; 16] = [2; 16];

fn record(kind: u16, event: u32, actor: [u8; 16], device: u8, payload: &[u8]) -> Vec<u8> {
    let mut record = Vec::new();
    record.extend_from_slice(&1u16.to_le_bytes());
    record.extend_from_slice(&kind.to_le_bytes());
    record.extend_from_slice(&numbered_id(event));
    record.extend_from_slice(&HOUSEHOLD);
    record.extend_from_slice(&actor);
    record.extend_from_slice(&[device; 16]);
    record.extend_from_slice(&1_791_475_200_000i64.to_le_bytes());
    record.extend_from_slice(&u64::from(event).to_le_bytes());
    record.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    record.extend_from_slice(payload);
    record
}

fn described(event: u32, actor: [u8; 16], device: u8, name: &str) -> Vec<u8> {
    let mut payload = (name.len() as u32).to_le_bytes().to_vec();
    payload.extend_from_slice(name.as_bytes());
    record(42, event, actor, device, &payload)
}

fn nicknamed(event: u32, actor: [u8; 16], device: u8, target: u8, nickname: &str) -> Vec<u8> {
    let mut payload = [target; 16].to_vec();
    payload.extend_from_slice(&(nickname.len() as u32).to_le_bytes());
    payload.extend_from_slice(nickname.as_bytes());
    record(43, event, actor, device, &payload)
}

fn project(records: &[Vec<u8>]) -> Result<HouseholdState, KinError> {
    let request = decode_request(&kine(records, 0, TEST_DATE, None))?;
    rebuild(&request.events, request.as_of, request.civil_date)
}

fn device(id: u8, member: [u8; 16], auto_name: &str, nickname: Option<&str>) -> DeviceNameState {
    DeviceNameState {
        device_id: DeviceId([id; 16]),
        member_id: ActorId(member),
        auto_name: Some(auto_name.into()),
        nickname: nickname.map(Into::into),
    }
}

#[test]
fn a_description_and_nicknames_replay_last_writer_wins() {
    let records = [
        described(1, MEMBER_1, 0x12, "Firefox on Windows"),
        described(2, MEMBER_1, 0x11, "Chrome on iPhone"),
        described(3, MEMBER_2, 0x21, "Safari on Mac"),
        nicknamed(4, MEMBER_1, 0x11, 0x11, "Kitchen phone"),
        // Another device of the same member names it too; the later one wins.
        nicknamed(5, MEMBER_1, 0x12, 0x11, "Mikey’s phone 📱"),
        // A browser update re-describes it; the nickname stays.
        described(6, MEMBER_1, 0x11, "Chrome on iPhone 17"),
        nicknamed(7, MEMBER_2, 0x21, 0x21, "Desk"),
        nicknamed(8, MEMBER_2, 0x21, 0x21, ""),
    ];
    assert_eq!(
        project(&records).unwrap().devices,
        vec![
            device(
                0x11,
                MEMBER_1,
                "Chrome on iPhone 17",
                Some("Mikey’s phone 📱")
            ),
            device(0x12, MEMBER_1, "Firefox on Windows", None),
            device(0x21, MEMBER_2, "Safari on Mac", None),
        ]
    );
}

#[test]
fn conflicting_device_events_are_kept_and_change_nothing() {
    // Device names are cosmetic: no decoded device event fails replay.
    let base = described(1, MEMBER_1, 0x11, "Chrome on iPhone");
    for conflicting in [
        // Another member names it.
        nicknamed(2, MEMBER_2, 0x21, 0x11, "Mine now"),
        // Another member describes the same device.
        described(2, MEMBER_2, 0x11, "Chrome on Android"),
    ] {
        assert_eq!(
            project(&[base.clone(), conflicting]).unwrap().devices,
            vec![device(0x11, MEMBER_1, "Chrome on iPhone", None)]
        );
    }
}

#[test]
fn a_later_member_replays_nicknames_for_devices_described_before_they_joined() {
    // Member 2 joined after device 0x11 described itself, so member 2's
    // history starts with member 1 renaming it: the description is missing.
    let late = [
        nicknamed(5, MEMBER_1, 0x12, 0x11, "Kitchen tablet"),
        described(6, MEMBER_2, 0x21, "Safari on Mac"),
    ];
    let state = project(&late).unwrap();
    assert_eq!(
        state.devices,
        vec![
            DeviceNameState {
                device_id: DeviceId([0x11; 16]),
                member_id: ActorId(MEMBER_1),
                auto_name: None,
                nickname: Some("Kitchen tablet".into()),
            },
            device(0x21, MEMBER_2, "Safari on Mac", None),
        ]
    );
    // Clearing that nickname leaves no name, so the entry goes; a clear for
    // a device this history has never named changes nothing. Every KDEV
    // entry has a name.
    let mut cleared = late.to_vec();
    cleared.push(nicknamed(7, MEMBER_1, 0x12, 0x11, ""));
    cleared.push(nicknamed(8, MEMBER_1, 0x12, 0x13, ""));
    assert_eq!(
        project(&cleared).unwrap().devices,
        vec![device(0x21, MEMBER_2, "Safari on Mac", None)]
    );
    // The device describes itself again later: same member keeps the nickname.
    let mut same = late.to_vec();
    same.push(described(7, MEMBER_1, 0x11, "Chrome on iPad"));
    assert_eq!(
        project(&same).unwrap().devices[0],
        device(0x11, MEMBER_1, "Chrome on iPad", Some("Kitchen tablet"))
    );
    // A description by another member names its own device and wins.
    let mut other = late.to_vec();
    other.push(described(7, MEMBER_2, 0x11, "Firefox on Linux"));
    assert_eq!(
        project(&other).unwrap().devices[0],
        device(0x11, MEMBER_2, "Firefox on Linux", None)
    );
    // Its member can still rename it, and nobody else can.
    let mut events = decode_request(&kine(&late, 0, TEST_DATE, None))
        .unwrap()
        .events;
    assert!(run(
        &mut events,
        C::NicknameDevice {
            device_id: DeviceId([0x11; 16]),
            nickname: Some("Hall tablet".into())
        },
        context(7, MEMBER_1, 0x12, 7)
    )
    .is_ok());
    assert_eq!(
        run(
            &mut events,
            C::NicknameDevice {
                device_id: DeviceId([0x11; 16]),
                nickname: Some("Mine".into())
            },
            context(8, MEMBER_2, 0x21, 8)
        ),
        Err(KinError::InvalidEvent)
    );
}

#[test]
fn names_must_be_canonical_on_the_wire() {
    let long = "a".repeat(49);
    let long_nickname = "n".repeat(33);
    for name in [
        "",
        " Chrome",
        "Chrome ",
        "Chrome\non iPhone",
        "Chrome\u{202e}enohPi",
        "Chrome\u{200b}",
        "\u{feff}Chrome",
        long.as_str(),
    ] {
        assert_eq!(
            decode_event(&described(1, MEMBER_1, 0x11, name)),
            Err(KinError::MalformedProtocol),
            "{name:?}"
        );
    }
    for nickname in [" Desk", "Desk\t", "De\u{2066}sk", long_nickname.as_str()] {
        assert_eq!(
            decode_event(&nicknamed(1, MEMBER_1, 0x11, 0x11, nickname)),
            Err(KinError::MalformedProtocol),
            "{nickname:?}"
        );
    }
    // 48 characters of four bytes each is the longest automatic name.
    let widest = "🏠".repeat(48);
    assert!(decode_event(&described(1, MEMBER_1, 0x11, &widest)).is_ok());
    // Joiners stay allowed inside emoji sequences.
    assert!(decode_event(&nicknamed(1, MEMBER_1, 0x11, 0x11, "👩‍💻 desk")).is_ok());

    let mut zero_target = nicknamed(1, MEMBER_1, 0x11, 0x11, "Desk");
    zero_target[88..104].fill(0);
    let mut short_length = described(1, MEMBER_1, 0x11, "Chrome");
    short_length[88] -= 1;
    let mut invalid_utf8 = described(1, MEMBER_1, 0x11, "Chrome");
    invalid_utf8[92] = 0xff;
    let mut no_length = record(43, 1, MEMBER_1, 0x11, &[0x11; 16]);
    no_length.truncate(88 + 16);
    for bytes in [zero_target, short_length, invalid_utf8, no_length] {
        assert_eq!(decode_event(&bytes), Err(KinError::MalformedProtocol));
    }
}

#[test]
fn device_events_do_not_change_the_projection() {
    let items = [item_record(1, 0x31, b"Milk", 1)];
    let mut with_devices = items.to_vec();
    with_devices.push(described(2, [0xbb; 16], 0xcc, "Chrome on iPhone"));
    with_devices.push(nicknamed(3, [0xbb; 16], 0xcc, 0xcc, "Phone"));
    let without = replay(&kine(&items, 0, TEST_DATE, None)).unwrap();
    let mut with = replay(&kine(&with_devices, 0, TEST_DATE, None)).unwrap();
    // Only the summary's "through" event ID (header bytes 36..52) moves on to
    // the last event; device events are not summary entries and count for
    // nothing in the summary total.
    assert_eq!(with[36..52], numbered_id(3));
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

#[test]
fn commands_describe_and_name_devices_and_reject_no_ops() {
    let mut events = Vec::new();
    let describe = |name: &str| C::DescribeDevice {
        auto_name: name.into(),
    };
    let nickname = |target: u8, nickname: Option<&str>| C::NicknameDevice {
        device_id: DeviceId([target; 16]),
        nickname: nickname.map(Into::into),
    };
    // Nothing to name before the device describes itself.
    assert_eq!(
        run(
            &mut events,
            nickname(0x11, Some("Desk")),
            context(1, MEMBER_1, 0x11, 1)
        ),
        Err(KinError::InvalidEvent)
    );
    // Names are trimmed before they are recorded.
    run(
        &mut events,
        describe("  Chrome on iPhone "),
        context(1, MEMBER_1, 0x11, 1),
    )
    .unwrap();
    assert_eq!(
        events[0].kind,
        EventKind::DeviceDescribed {
            auto_name: "Chrome on iPhone".into()
        }
    );
    run(
        &mut events,
        describe("Safari on Mac"),
        context(2, MEMBER_2, 0x21, 2),
    )
    .unwrap();
    for (command, ctx) in [
        // The same name again changes nothing.
        (describe("Chrome on iPhone"), context(3, MEMBER_1, 0x11, 3)),
        // A device keeps its member.
        (describe("Chrome on Android"), context(3, MEMBER_2, 0x11, 3)),
        // Another member's device.
        (nickname(0x21, Some("Ha")), context(3, MEMBER_1, 0x11, 3)),
        // Clearing a nickname that is not set.
        (nickname(0x11, None), context(3, MEMBER_1, 0x11, 3)),
    ] {
        assert_eq!(run(&mut events, command, ctx), Err(KinError::InvalidEvent));
    }
    for (command, error) in [
        (describe(" "), KinError::InvalidEvent),
        (nickname(0x11, Some("a\u{202e}b")), KinError::InvalidEvent),
    ] {
        assert_eq!(
            run(&mut events, command, context(3, MEMBER_1, 0x11, 3)),
            Err(error)
        );
    }
    run(
        &mut events,
        nickname(0x11, Some(" Kitchen ")),
        context(3, MEMBER_1, 0x11, 3),
    )
    .unwrap();
    assert_eq!(
        run(
            &mut events,
            nickname(0x11, Some("Kitchen")),
            context(4, MEMBER_1, 0x11, 4)
        ),
        Err(KinError::InvalidEvent)
    );
    run(
        &mut events,
        describe("Chrome on iPhone 17"),
        context(4, MEMBER_1, 0x11, 4),
    )
    .unwrap();
    run(
        &mut events,
        nickname(0x11, None),
        context(5, MEMBER_1, 0x11, 5),
    )
    .unwrap();
    let state = rebuild(&events, 0, CivilDate::from_encoded(TEST_DATE).unwrap()).unwrap();
    assert_eq!(
        state.devices,
        vec![
            device(0x11, MEMBER_1, "Chrome on iPhone 17", None),
            device(0x21, MEMBER_2, "Safari on Mac", None),
        ]
    );
}

fn kcmd(kind: u16, id: [u8; 16], text: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0; 128];
    bytes[..4].copy_from_slice(b"KCMD");
    bytes[4..6].copy_from_slice(&1u16.to_le_bytes());
    bytes[8..10].copy_from_slice(&kind.to_le_bytes());
    bytes[84..92].copy_from_slice(&1u64.to_le_bytes());
    bytes[92..108].copy_from_slice(&id);
    bytes[124..128].copy_from_slice(&(text.len() as u32).to_le_bytes());
    bytes.extend_from_slice(text);
    bytes
}

#[test]
fn kcmd_carries_device_names() {
    assert_eq!(
        decode_command(&kcmd(42, [0; 16], b"Chrome on iPhone"))
            .unwrap()
            .0,
        C::DescribeDevice {
            auto_name: "Chrome on iPhone".into()
        }
    );
    assert_eq!(
        decode_command(&kcmd(43, [0x11; 16], b"Desk")).unwrap().0,
        C::NicknameDevice {
            device_id: DeviceId([0x11; 16]),
            nickname: Some("Desk".into())
        }
    );
    assert_eq!(
        decode_command(&kcmd(43, [0x11; 16], b"")).unwrap().0,
        C::NicknameDevice {
            device_id: DeviceId([0x11; 16]),
            nickname: None
        }
    );
    let too_long = vec![b'a'; crate::state::MAX_DEVICE_NAME_BYTES + 1];
    for bytes in [
        kcmd(42, [0x11; 16], b"Chrome"),
        kcmd(42, [0; 16], b""),
        kcmd(43, [0; 16], b"Desk"),
        kcmd(42, [0; 16], &too_long),
        kcmd(42, [0; 16], &[0xff]),
    ] {
        assert_eq!(
            decode_command(&bytes).unwrap_err(),
            KinError::MalformedProtocol
        );
    }
    let mut with_option = kcmd(42, [0; 16], b"Chrome");
    with_option[112] = 1;
    assert_eq!(
        decode_command(&with_option).unwrap_err(),
        KinError::MalformedProtocol
    );
    assert_eq!(
        decode_command(&kcmd(999, [0; 16], b"")).unwrap_err(),
        KinError::UnsupportedVersion
    );
}

#[test]
fn the_kdev_table_is_laid_out_as_documented() {
    let bytes = encode_device_names(&[
        device(0x11, MEMBER_1, "Chrome on iPhone", Some("Desk")),
        device(0x21, MEMBER_2, "Mac", None),
    ])
    .unwrap();
    let mut expected = b"KDEV".to_vec();
    expected.extend_from_slice(&[1, 0, 0, 0, 2, 0, 0, 0]);
    expected.extend_from_slice(&[0x11; 16]);
    expected.extend_from_slice(&MEMBER_1);
    expected.extend_from_slice(&[16, 0, 4, 0]);
    expected.extend_from_slice(b"Chrome on iPhoneDesk");
    expected.extend_from_slice(&[0x21; 16]);
    expected.extend_from_slice(&MEMBER_2);
    expected.extend_from_slice(&[3, 0, 0, 0]);
    expected.extend_from_slice(b"Mac");
    assert_eq!(bytes, expected);
    assert_eq!(encode_device_names(&[]).unwrap(), b"KDEV\x01\0\0\0\0\0\0\0");
    let nickname_only = encode_device_names(&[DeviceNameState {
        device_id: DeviceId([0x11; 16]),
        member_id: ActorId(MEMBER_1),
        auto_name: None,
        nickname: Some("Desk".into()),
    }])
    .unwrap();
    assert_eq!(nickname_only[44..48], [0, 0, 4, 0]);
    assert_eq!(&nickname_only[48..], b"Desk");
}

#[test]
fn held_history_names_devices_after_identity_bindings() {
    // A device described under its sync identity, and one whose description
    // was recorded under a placeholder tuple a binding maps to member 3,
    // device 0x31.
    let placeholder = [0x77; 16];
    let records = [
        described(1, MEMBER_1, 0x11, "Chrome on iPhone"),
        {
            let mut bytes = described(2, placeholder, 0x76, "Edge on Windows");
            bytes[20..36].copy_from_slice(&[0x75; 16]);
            bytes
        },
        nicknamed(3, [3; 16], 0x31, 0x31, "Office"),
    ];
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
    let mut expected = b"KDEV\x01\0\0\0\x02\0\0\0".to_vec();
    expected.extend_from_slice(&[0x11; 16]);
    expected.extend_from_slice(&MEMBER_1);
    expected.extend_from_slice(&[16, 0, 0, 0]);
    expected.extend_from_slice(b"Chrome on iPhone");
    expected.extend_from_slice(&[0x31; 16]);
    expected.extend_from_slice(&[3; 16]);
    expected.extend_from_slice(&[15, 0, 6, 0]);
    expected.extend_from_slice(b"Edge on WindowsOffice");
    assert_eq!(device_names(&context, &mut history).unwrap(), expected);
    // The projection from the same history ignores device names.
    assert!(replay_history(&context, &mut history).is_ok());
    // Like kin_project, the context must carry no records.
    let with_record = bound_kine(&records[..1], 0, TEST_DATE, None, Some(HOUSEHOLD), &[]);
    assert_eq!(
        device_names(&with_record, &mut history).unwrap_err(),
        KinError::MalformedProtocol
    );
}
