// Taking turns on routines (#429, ADR 0016): the rotation (kind 68) and turn
// (kind 69) events — canonical payloads, replay, the turn passing on
// completion and coming back on Undo, command rules, the owner it drives,
// "my things today", KCMD and KRRS. The byte vectors here are TEST-VECTORS
// 051–055.
use crate::codec::encode_event;
use crate::command::{decode_command, execute, CommandContext, HouseholdCommand as C};
use crate::core::routine_rotations;
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::recurrence::{Cadence, CivilDate};
use crate::request::DecodedRequest;
use crate::rotations::*;
use crate::simple::{my_things, MyThing};
use crate::state::{rebuild, HouseholdState};
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const ALEX: [u8; 16] = [1; 16];
const SAM: [u8; 16] = [2; 16];
const JO: [u8; 16] = [3; 16];
const DEVICE: [u8; 16] = [0x11; 16];
const OTHER_DEVICE: [u8; 16] = [0x22; 16];
/// The test routine, "Bins out", daily from TEST_DATE.
const BINS: u32 = 20;

fn date(value: u32) -> CivilDate {
    CivilDate::from_encoded(value).unwrap()
}

fn routine(n: u32) -> RoutineId {
    RoutineId(numbered_id(n))
}

fn context(event: u32, logical_time: u64, device: [u8; 16]) -> CommandContext {
    CommandContext {
        event_id: EventId(numbered_id(event)),
        household_id: HouseholdId(HOUSEHOLD),
        actor_id: ActorId(ALEX),
        device_id: DeviceId(device),
        timestamp: 1_791_475_200_000,
        logical_time,
    }
}

fn request(events: &[EventEnvelope], today: u32) -> DecodedRequest {
    DecodedRequest {
        events: events.to_vec(),
        as_of: 1_791_475_200_100,
        summary_cursor: None,
        civil_date: date(today),
        target_household_id: None,
        identity_bindings: vec![],
    }
}

fn rotation(routine_n: u32, members: &[[u8; 16]], current: u8) -> EventKind {
    EventKind::RoutineRotationSet {
        routine_id: routine(routine_n),
        members: members.iter().copied().map(ActorId).collect(),
        current,
    }
}

fn turn(routine_n: u32, member: [u8; 16]) -> EventKind {
    EventKind::RoutineTurnSet {
        routine_id: routine(routine_n),
        member_id: ActorId(member),
    }
}

/// A rotation as (members, current, next).
type Shown = (Vec<[u8; 16]>, [u8; 16], [u8; 16]);

struct Household {
    events: Vec<EventEnvelope>,
    next: u32,
    today: u32,
}

impl Household {
    /// A household with the daily routine "Bins out".
    fn new() -> Self {
        let mut home = Self {
            events: Vec::new(),
            next: 1,
            today: TEST_DATE,
        };
        home.create(BINS, "Bins out");
        home
    }

    fn create(&mut self, n: u32, text: &str) {
        self.run(C::CreateRoutine {
            id: routine(n),
            text: text.into(),
            cadence: Cadence::Daily,
            created_on: date(self.today),
        })
        .unwrap();
    }

    fn run(&mut self, command: C) -> Result<(), KinError> {
        let n = self.next;
        let result = execute(
            &command,
            context(1000 + n, u64::from(n), DEVICE),
            request(&self.events, self.today),
        )?;
        let bytes = encode_event(&result.event).unwrap();
        assert_eq!(decode_event(&bytes).unwrap(), result.event);
        self.events.push(result.event);
        self.next += 1;
        Ok(())
    }

    fn rotate(&mut self, members: &[[u8; 16]], current: u8) -> Result<(), KinError> {
        self.run(C::Rotation(rotation(BINS, members, current)))
    }

    fn turn(&mut self, member: [u8; 16]) -> Result<(), KinError> {
        self.run(C::Rotation(turn(BINS, member)))
    }

    fn complete(&mut self, on: u32) -> Result<(), KinError> {
        self.today = on;
        self.run(C::CompleteOccurrence {
            id: routine(BINS),
            key: date(on),
        })
    }

    fn reopen(&mut self, on: u32) -> Result<(), KinError> {
        self.today = on;
        self.run(C::ReopenOccurrence {
            id: routine(BINS),
            key: date(on),
        })
    }

    fn assign(&mut self, member: Option<[u8; 16]>) -> Result<(), KinError> {
        self.run(C::ChangeResponsibility {
            target_kind: ResponsibilityTargetKind::Routine,
            target_id: numbered_id(BINS),
            member_id: member.map(ActorId),
        })
    }

    fn state(&self) -> HouseholdState {
        rebuild(&self.events, 1_791_475_200_100, date(self.today)).unwrap()
    }

    /// (members, current, next) of the routine's rotation.
    fn rotation(&self) -> Option<Shown> {
        let state = self.state();
        state.rotations.rotation(&routine(BINS)).map(|rotation| {
            (
                rotation.members.iter().map(|member| member.0).collect(),
                rotation.current_member().0,
                rotation.next_member().0,
            )
        })
    }

    fn current(&self) -> Option<[u8; 16]> {
        self.rotation().map(|(_, current, _)| current)
    }

    /// The routine's owner as the KINS responsibilities section shows it.
    fn owner(&self) -> Option<[u8; 16]> {
        owner_of(&self.state())
    }
}

fn owner_of(state: &HouseholdState) -> Option<[u8; 16]> {
    state
        .responsibilities
        .iter()
        .find(|entry| {
            entry.target_kind == ResponsibilityTargetKind::Routine
                && entry.target_id == numbered_id(BINS)
        })
        .and_then(|entry| entry.member_id)
        .map(|member| member.0)
}

/// The bytes of a kind-68 payload, written out by hand.
fn rotation_bytes(routine_n: u32, members: &[[u8; 16]], current: u8) -> Vec<u8> {
    let mut out = numbered_id(routine_n).to_vec();
    out.extend_from_slice(&[members.len() as u8, current, 0, 0]);
    for member in members {
        out.extend_from_slice(member);
    }
    out
}

// 051
#[test]
fn the_rotation_payload_is_canonical() {
    let kind = rotation(BINS, &[ALEX, SAM, JO], 1);
    let bytes = rotation_bytes(BINS, &[ALEX, SAM, JO], 1);
    assert_eq!(bytes.len(), 20 + 48);
    assert_eq!(&bytes[16..20], &[3, 1, 0, 0]);
    assert_eq!(encode_payload(&kind).unwrap(), bytes);
    assert_eq!(decode_payload(ROUTINE_ROTATION_SET, &bytes).unwrap(), kind);
    let ended = rotation_bytes(BINS, &[], 0);
    assert_eq!(ended.len(), 20);
    assert_eq!(
        decode_payload(ROUTINE_ROTATION_SET, &ended).unwrap(),
        rotation(BINS, &[], 0)
    );
    let twelve: Vec<[u8; 16]> = (1..=12).map(|n| [n; 16]).collect();
    assert!(decode_payload(ROUTINE_ROTATION_SET, &rotation_bytes(BINS, &twelve, 11)).is_ok());

    let malformed = |bytes: &[u8], why: &str| {
        assert_eq!(
            decode_payload(ROUTINE_ROTATION_SET, bytes),
            Err(KinError::MalformedProtocol),
            "{why}"
        );
    };
    malformed(&rotation_bytes(BINS, &[ALEX], 0), "one member");
    let thirteen: Vec<[u8; 16]> = (1..=13).map(|n| [n; 16]).collect();
    malformed(&rotation_bytes(BINS, &thirteen, 0), "13 members");
    malformed(&rotation_bytes(BINS, &[ALEX, SAM, ALEX], 0), "a repeat");
    malformed(&rotation_bytes(BINS, &[ALEX, [0; 16]], 0), "a zero member");
    malformed(
        &rotation_bytes(BINS, &[ALEX, SAM], 2),
        "index past the list",
    );
    malformed(&rotation_bytes(BINS, &[], 1), "an index with no list");
    let mut zero_routine = bytes.clone();
    zero_routine[..16].fill(0);
    malformed(&zero_routine, "a zero routine");
    let mut reserved = bytes.clone();
    reserved[19] = 1;
    malformed(&reserved, "reserved bytes");
    let mut extra = bytes.clone();
    extra.push(0);
    malformed(&extra, "trailing bytes");
    malformed(&bytes[..bytes.len() - 1], "truncated");
    malformed(&bytes[..17], "a cut header");
    let mut short_count = bytes.clone();
    short_count[16] = 2;
    malformed(&short_count, "count says two, three follow");
    assert_eq!(
        encode_payload(&rotation(BINS, &[ALEX], 0)),
        Err(KinError::MalformedProtocol)
    );
}

// 052
#[test]
fn the_turn_payload_is_two_ids() {
    let kind = turn(BINS, SAM);
    let mut bytes = numbered_id(BINS).to_vec();
    bytes.extend_from_slice(&SAM);
    assert_eq!(encode_payload(&kind).unwrap(), bytes);
    assert_eq!(decode_payload(ROUTINE_TURN_SET, &bytes).unwrap(), kind);
    let mut zero_member = bytes.clone();
    zero_member[16..].fill(0);
    let mut zero_routine = bytes.clone();
    zero_routine[..16].fill(0);
    for bad in [
        &bytes[..31],
        &[bytes.as_slice(), &[0]].concat()[..],
        &zero_member[..],
        &zero_routine[..],
    ] {
        assert_eq!(
            decode_payload(ROUTINE_TURN_SET, bad),
            Err(KinError::MalformedProtocol)
        );
    }
    assert_eq!(
        decode_payload(67, &bytes),
        Err(KinError::MalformedProtocol),
        "not a rotation kind"
    );
}

// 053
#[test]
fn a_rotation_is_set_replaced_and_ended_by_its_rules() {
    let mut home = Household::new();
    assert_eq!(
        home.rotate(&[], 0),
        Err(KinError::InvalidEvent),
        "nothing to end"
    );
    assert_eq!(
        home.run(C::Rotation(rotation(99, &[ALEX, SAM], 0))),
        Err(KinError::InvalidEvent),
        "no such routine"
    );
    assert_eq!(
        home.rotate(&[ALEX, SAM, ALEX], 0),
        Err(KinError::MalformedProtocol),
        "members are distinct"
    );
    assert_eq!(home.rotate(&[ALEX], 0), Err(KinError::MalformedProtocol));
    assert_eq!(
        home.rotate(&[ALEX, SAM], 2),
        Err(KinError::MalformedProtocol)
    );

    home.rotate(&[ALEX, SAM, JO], 1).unwrap();
    assert_eq!(home.rotation(), Some((vec![ALEX, SAM, JO], SAM, JO)));
    assert_eq!(home.owner(), Some(SAM), "the owner is whoever's turn it is");
    assert_eq!(
        home.rotate(&[ALEX, SAM, JO], 1),
        Err(KinError::InvalidEvent),
        "the same rotation"
    );
    // Reordering, or a different turn, is a change.
    home.rotate(&[JO, SAM, ALEX], 1).unwrap();
    home.rotate(&[JO, SAM, ALEX], 2).unwrap();
    assert_eq!(home.rotation(), Some((vec![JO, SAM, ALEX], ALEX, JO)));
    assert_eq!(home.owner(), Some(ALEX));

    // While it rotates, the owner is the turn's, not anyone's to set.
    assert_eq!(home.assign(Some(SAM)), Err(KinError::InvalidEvent));
    assert_eq!(home.assign(None), Err(KinError::InvalidEvent));

    // Ending it leaves the last current member as an ordinary owner.
    home.rotate(&[], 0).unwrap();
    assert_eq!(home.rotation(), None);
    assert_eq!(home.owner(), Some(ALEX));
    home.assign(Some(SAM)).unwrap();
    assert_eq!(home.owner(), Some(SAM));

    // An archived routine takes no rotation.
    home.rotate(&[ALEX, SAM], 0).unwrap();
    home.run(C::ArchiveRoutine(routine(BINS))).unwrap();
    assert_eq!(home.rotate(&[], 0), Err(KinError::InvalidEvent));
    assert_eq!(home.turn(SAM), Err(KinError::InvalidEvent));
}

// 054
#[test]
fn the_turn_passes_on_completion_and_comes_back_on_undo() {
    let mut home = Household::new();
    home.rotate(&[ALEX, SAM, JO], 0).unwrap();
    home.complete(TEST_DATE).unwrap();
    assert_eq!(home.current(), Some(SAM));
    assert_eq!(home.owner(), Some(SAM));
    // Undo: reopening the occurrence that passed the turn brings it back.
    home.reopen(TEST_DATE).unwrap();
    assert_eq!(home.current(), Some(ALEX));
    assert_eq!(home.owner(), Some(ALEX));
    home.complete(TEST_DATE).unwrap();
    home.complete(20261004).unwrap();
    home.complete(20261005).unwrap();
    assert_eq!(home.current(), Some(ALEX), "around the list and back");
    // Reopening an earlier occurrence, not the one that passed the turn,
    // changes nothing.
    home.reopen(20261004).unwrap();
    assert_eq!(home.current(), Some(ALEX));
    // The occurrence that passed it can still undo it.
    home.reopen(20261005).unwrap();
    assert_eq!(home.current(), Some(JO));
    // Completing the 4th again passes it on; its Undo brings it back.
    home.complete(20261004).unwrap();
    assert_eq!(home.current(), Some(ALEX));
    home.reopen(20261004).unwrap();
    assert_eq!(home.current(), Some(JO));

    // A skipped day keeps the same person's turn.
    home.today = 20261010;
    assert_eq!(home.current(), Some(JO));
    // A manual turn forgets the pass, so Undo keeps the manual choice.
    home.complete(20261010).unwrap();
    assert_eq!(home.current(), Some(ALEX));
    home.turn(JO).unwrap();
    home.reopen(20261010).unwrap();
    assert_eq!(home.current(), Some(JO));
    // Completing a routine that doesn't rotate moves nothing.
    home.create(21, "Feed the fish");
    home.run(C::CompleteOccurrence {
        id: routine(21),
        key: date(20261010),
    })
    .unwrap();
    assert_eq!(home.current(), Some(JO));
    assert!(home.state().rotations.rotation(&routine(21)).is_none());
}

#[test]
fn turns_are_skipped_and_swapped_among_the_listed() {
    let mut home = Household::new();
    assert_eq!(home.turn(SAM), Err(KinError::InvalidEvent), "no rotation");
    home.rotate(&[ALEX, SAM, JO], 0).unwrap();
    assert_eq!(
        home.turn(ALEX),
        Err(KinError::InvalidEvent),
        "already their turn"
    );
    assert_eq!(
        home.turn([9; 16]),
        Err(KinError::InvalidEvent),
        "not in the rotation"
    );
    // Skip to next.
    home.turn(SAM).unwrap();
    assert_eq!(home.rotation(), Some((vec![ALEX, SAM, JO], SAM, JO)));
    assert_eq!(home.owner(), Some(SAM));
    // Swap with Jo.
    home.turn(JO).unwrap();
    assert_eq!(home.rotation(), Some((vec![ALEX, SAM, JO], JO, ALEX)));
    home.complete(TEST_DATE).unwrap();
    assert_eq!(home.current(), Some(ALEX));
}

#[test]
fn a_duplicate_completion_passes_the_turn_once() {
    let mut home = Household::new();
    home.rotate(&[ALEX, SAM, JO], 0).unwrap();
    let base = home.events.clone();
    // Two devices complete the same occurrence offline.
    let complete = C::CompleteOccurrence {
        id: routine(BINS),
        key: date(TEST_DATE),
    };
    let first = execute(&complete, context(70, 5, DEVICE), request(&base, TEST_DATE))
        .unwrap()
        .event;
    let second = execute(
        &complete,
        context(71, 5, OTHER_DEVICE),
        request(&base, TEST_DATE),
    )
    .unwrap()
    .event;
    let events = [base.clone(), vec![first.clone(), second.clone()]].concat();
    let state = rebuild(&events, 1_791_475_200_100, date(TEST_DATE)).unwrap();
    let current = |state: &HouseholdState| {
        state
            .rotations
            .rotation(&routine(BINS))
            .unwrap()
            .current_member()
            .0
    };
    assert_eq!(current(&state), SAM, "moved once, not twice");
    // Either arrival order gives the same household.
    let swapped = [base, vec![second, first]].concat();
    assert_eq!(
        rebuild(&swapped, 1_791_475_200_100, date(TEST_DATE)).unwrap(),
        state
    );
}

#[test]
fn racing_turns_lists_and_owners_replay_the_same_everywhere() {
    let mut home = Household::new();
    home.rotate(&[ALEX, SAM, JO], 0).unwrap();
    let base = home.events.clone();
    // One device skips to Jo while another completes the occurrence and a
    // third drops Jo from the list, all at logical time 5.
    let skip = execute(
        &C::Rotation(turn(BINS, JO)),
        context(70, 5, [0x33; 16]),
        request(&base, TEST_DATE),
    )
    .unwrap()
    .event;
    let done = execute(
        &C::CompleteOccurrence {
            id: routine(BINS),
            key: date(TEST_DATE),
        },
        context(71, 5, DEVICE),
        request(&base, TEST_DATE),
    )
    .unwrap()
    .event;
    let shorter = execute(
        &C::Rotation(rotation(BINS, &[ALEX, SAM], 0)),
        context(72, 5, OTHER_DEVICE),
        request(&base, TEST_DATE),
    )
    .unwrap()
    .event;
    let one = [
        base.clone(),
        vec![skip.clone(), done.clone(), shorter.clone()],
    ]
    .concat();
    let other = [base.clone(), vec![shorter, done, skip]].concat();
    let state = rebuild(&one, 1_791_475_200_100, date(TEST_DATE)).unwrap();
    assert_eq!(
        rebuild(&other, 1_791_475_200_100, date(TEST_DATE)).unwrap(),
        state
    );
    // Replay order is device order: the completion (0x11) passes Alex's
    // turn to Sam, the new list (0x22) restarts at Alex, and the skip to Jo
    // (0x33) names someone no longer listed, so it changes nothing.
    let rotation = state.rotations.rotation(&routine(BINS)).unwrap();
    assert_eq!(rotation.current_member(), ActorId(ALEX));
    assert_eq!(rotation.members, vec![ActorId(ALEX), ActorId(SAM)]);
    assert_eq!(owner_of(&state), Some(ALEX));

    // An owner change racing with the rotation (authored before it was
    // seen, sorting after it) is recorded with no effect.
    let assign = execute(
        &C::ChangeResponsibility {
            target_kind: ResponsibilityTargetKind::Routine,
            target_id: numbered_id(BINS),
            member_id: Some(ActorId(JO)),
        },
        context(73, 2, OTHER_DEVICE),
        request(&base[..1], TEST_DATE),
    )
    .unwrap()
    .event;
    let events = [base, vec![assign]].concat();
    let state = rebuild(&events, 1_791_475_200_100, date(TEST_DATE)).unwrap();
    assert_eq!(owner_of(&state), Some(ALEX));
}

#[test]
fn a_rotation_racing_with_archive_changes_nothing() {
    let mut home = Household::new();
    let base = home.events.clone();
    home.run(C::ArchiveRoutine(routine(BINS))).unwrap();
    let rotate = execute(
        &C::Rotation(rotation(BINS, &[ALEX, SAM], 1)),
        context(70, 2, OTHER_DEVICE),
        request(&base, TEST_DATE),
    )
    .unwrap()
    .event;
    let events = [home.events.clone(), vec![rotate]].concat();
    let state = rebuild(&events, 1_791_475_200_100, date(TEST_DATE)).unwrap();
    assert!(state.rotations.rotations.is_empty());
    assert_eq!(owner_of(&state), None);
}

#[test]
fn my_things_follow_the_turn() {
    let mut home = Household::new();
    home.rotate(&[SAM, JO], 0).unwrap();
    let things = |home: &Household, member: [u8; 16]| {
        my_things(&home.state(), ActorId(member), date(home.today))
    };
    assert_eq!(
        things(&home, SAM),
        vec![MyThing::Routine {
            routine_id: numbered_id(BINS),
            occurrence: date(TEST_DATE),
            done: false
        }]
    );
    assert!(things(&home, JO).is_empty());
    home.complete(TEST_DATE).unwrap();
    // Sam did today's; tomorrow is Jo's.
    assert!(things(&home, SAM).is_empty());
    assert_eq!(things(&home, JO).len(), 1);
    home.today = 20261004;
    assert_eq!(
        things(&home, JO),
        vec![MyThing::Routine {
            routine_id: numbered_id(BINS),
            occurrence: date(20261004),
            done: false
        }]
    );
    home.reopen(TEST_DATE).unwrap();
    assert_eq!(things(&home, SAM).len(), 1, "Undo gives it back to Sam");
}

#[test]
fn kcmd_carries_the_rotation_payloads_exactly() {
    let packet = |kind_code: u16, payload: &[u8]| {
        let mut packet = vec![0u8; 128];
        packet[..4].copy_from_slice(b"KCMD");
        packet[4] = 1;
        packet[8..10].copy_from_slice(&kind_code.to_le_bytes());
        packet[12..28].copy_from_slice(&numbered_id(500));
        packet[28..44].copy_from_slice(&HOUSEHOLD);
        packet[44..60].copy_from_slice(&ALEX);
        packet[60..76].copy_from_slice(&DEVICE);
        packet[76..84].copy_from_slice(&1_791_475_200_000i64.to_le_bytes());
        packet[84..92].copy_from_slice(&1u64.to_le_bytes());
        packet[124..128].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        packet.extend_from_slice(payload);
        packet
    };
    let twelve: Vec<[u8; 16]> = (1..=12).map(|n| [n; 16]).collect();
    let kind = rotation(BINS, &twelve, 3);
    let set = packet(ROUTINE_ROTATION_SET, &rotation_bytes(BINS, &twelve, 3));
    assert_eq!(decode_command(&set).unwrap().0, C::Rotation(kind));
    let kind = turn(BINS, SAM);
    let put = packet(ROUTINE_TURN_SET, &encode_payload(&kind).unwrap());
    assert_eq!(decode_command(&put).unwrap().0, C::Rotation(kind));
    for (offset, why) in [
        (92, "entity"),
        (108, "date"),
        (112, "option"),
        (116, "expiry"),
    ] {
        let mut bad = put.clone();
        bad[offset] = 1;
        assert!(decode_command(&bad).is_err(), "the {why} field stays zero");
    }
    assert_eq!(
        decode_command(&packet(
            ROUTINE_ROTATION_SET,
            &rotation_bytes(BINS, &[SAM], 0)
        ))
        .map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
    assert!(decode_command(&packet(ROUTINE_TURN_SET, &[])).is_err());
}

// 055
#[test]
fn kin_routine_rotations_speaks_krrs() {
    let mut home = Household::new();
    home.create(21, "Feed the fish");
    home.create(22, "Old chore");
    home.create(23, "Dishes");
    home.rotate(&[SAM, ALEX, JO], 2).unwrap();
    home.run(C::Rotation(rotation(22, &[ALEX, SAM], 0)))
        .unwrap();
    home.run(C::ArchiveRoutine(routine(22))).unwrap();
    home.run(C::Rotation(rotation(23, &[ALEX, SAM], 0)))
        .unwrap();
    home.run(C::Rotation(rotation(23, &[], 0))).unwrap();
    let records: Vec<Vec<u8>> = home
        .events
        .iter()
        .map(|event| encode_event(event).unwrap())
        .collect();
    let mut batch = (records.len() as u32).to_le_bytes().to_vec();
    for record in &records {
        batch.extend_from_slice(&(record.len() as u32).to_le_bytes());
    }
    for record in &records {
        batch.extend_from_slice(record);
    }
    let mut history = History::default();
    history.append(&batch).unwrap();
    let context = kine(&[], 1_791_475_200_100, TEST_DATE, None);
    let out = routine_rotations(&context, &mut history).unwrap();

    let mut expected = b"KRRS\x01\x00\x00\x00".to_vec();
    expected.extend_from_slice(&1u32.to_le_bytes());
    expected.extend_from_slice(&numbered_id(BINS));
    expected.extend_from_slice(&[3, 2, 0, 0]);
    expected.extend_from_slice(&SAM);
    expected.extend_from_slice(&ALEX);
    expected.extend_from_slice(&JO);
    assert_eq!(
        out, expected,
        "only Bins out: 21 never rotated, 22 is archived, 23 ended"
    );

    let empty = routine_rotations(&context, &mut History::default()).unwrap();
    assert_eq!(empty, b"KRRS\x01\x00\x00\x00\x00\x00\x00\x00");
}
