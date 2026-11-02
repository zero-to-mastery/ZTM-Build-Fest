// Simple view (#344, ADR 0013): the item emoji event (kind 64) — canonical
// payload, replay, commands, KIEM — and "my things today" with KMTQ / KMTD.
use crate::codec::encode_event;
use crate::command::{decode_command, execute, CommandContext, HouseholdCommand as C};
use crate::core::{item_emojis, my_things as my_things_export};
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::recurrence::{Cadence, CivilDate};
use crate::request::DecodedRequest;
use crate::simple::*;
use crate::state::{rebuild, HouseholdState};
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const ADULT: [u8; 16] = [1; 16];
const KID: [u8; 16] = [2; 16];

fn date(value: u32) -> CivilDate {
    CivilDate::from_encoded(value).unwrap()
}

fn context(event: u32, logical_time: u64) -> CommandContext {
    CommandContext {
        event_id: EventId(numbered_id(event)),
        household_id: HouseholdId(HOUSEHOLD),
        actor_id: ActorId(ADULT),
        device_id: DeviceId([0x11; 16]),
        timestamp: 1_791_475_200_000,
        logical_time,
    }
}

fn request(events: &[EventEnvelope]) -> DecodedRequest {
    DecodedRequest {
        events: events.to_vec(),
        as_of: 1_791_475_200_100,
        summary_cursor: None,
        civil_date: date(TEST_DATE),
        target_household_id: None,
        identity_bindings: vec![],
    }
}

struct Household {
    events: Vec<EventEnvelope>,
    next: u32,
}

impl Household {
    fn new() -> Self {
        Self {
            events: Vec::new(),
            next: 1,
        }
    }

    fn run(&mut self, command: C) -> Result<(), KinError> {
        let n = self.next;
        let result = execute(
            &command,
            context(1000 + n, u64::from(n)),
            request(&self.events),
        )?;
        let bytes = encode_event(&result.event).unwrap();
        assert_eq!(decode_event(&bytes).unwrap(), result.event);
        self.events.push(result.event);
        self.next += 1;
        Ok(())
    }

    fn emoji(&mut self, item: u32, emoji: Option<&str>) -> Result<(), KinError> {
        self.run(C::Picture(EventKind::ItemEmojiSet {
            item_id: ItemId(numbered_id(item)),
            emoji: emoji.map(str::to_owned),
        }))
    }

    fn add(&mut self, item: u32, text: &str, classification: ItemClassification) {
        self.run(C::AddItem {
            id: ItemId(numbered_id(item)),
            text: text.into(),
            classification,
        })
        .unwrap();
    }

    fn assign(&mut self, kind: ResponsibilityTargetKind, target: u32, member: [u8; 16]) {
        self.run(C::ChangeResponsibility {
            target_kind: kind,
            target_id: numbered_id(target),
            member_id: Some(ActorId(member)),
        })
        .unwrap();
    }

    fn state(&self) -> HouseholdState {
        rebuild(&self.events, 1_791_475_200_100, date(TEST_DATE)).unwrap()
    }
}

#[test]
fn the_emoji_payload_round_trips_and_only_canonical_bytes_decode() {
    for emoji in [Some("🧦"), Some("👩‍🍳"), Some("🇬🇧"), None] {
        let kind = EventKind::ItemEmojiSet {
            item_id: ItemId(numbered_id(7)),
            emoji: emoji.map(str::to_owned),
        };
        let bytes = encode_payload(&kind).unwrap();
        assert_eq!(decode_payload(ITEM_EMOJI_SET, &bytes).unwrap(), kind);
    }
    let set = encode_payload(&EventKind::ItemEmojiSet {
        item_id: ItemId(numbered_id(7)),
        emoji: Some("🧦".into()),
    })
    .unwrap();
    let mut flag = set.clone();
    flag[17] = 1;
    assert_eq!(
        decode_payload(ITEM_EMOJI_SET, &flag),
        Err(KinError::MalformedProtocol),
        "reserved flag bytes"
    );
    let mut extra = set.clone();
    extra.push(0);
    assert_eq!(
        decode_payload(ITEM_EMOJI_SET, &extra),
        Err(KinError::MalformedProtocol),
        "trailing bytes"
    );
    let mut cleared = vec![0; 16];
    cleared[0] = 1;
    cleared.extend_from_slice(&[0, 0, 0, 0, 1, 0]);
    assert_eq!(
        decode_payload(ITEM_EMOJI_SET, &cleared),
        Err(KinError::MalformedProtocol),
        "text after a clear"
    );
    for bad in ["a", "🧦🧦", "", "x🧦"] {
        let kind = EventKind::ItemEmojiSet {
            item_id: ItemId(numbered_id(7)),
            emoji: Some(bad.into()),
        };
        assert_eq!(
            encode_payload(&kind),
            Err(KinError::MalformedProtocol),
            "{bad:?} isn't one emoji"
        );
    }
    let zero = EventKind::ItemEmojiSet {
        item_id: ItemId([0; 16]),
        emoji: None,
    };
    assert_eq!(encode_payload(&zero), Err(KinError::MalformedProtocol));
}

#[test]
fn an_adult_sets_changes_and_clears_an_items_emoji_and_kiem_reports_it() {
    let mut home = Household::new();
    home.add(1, "Brush teeth", ItemClassification::Need);
    home.add(2, "Old chore", ItemClassification::Need);
    assert_eq!(
        home.emoji(9, Some("🧦")),
        Err(KinError::InvalidEvent),
        "no such item"
    );
    home.emoji(1, Some("🪥")).unwrap();
    assert_eq!(
        home.emoji(1, Some("🪥")),
        Err(KinError::InvalidEvent),
        "no change"
    );
    home.emoji(1, Some("🦷")).unwrap();
    home.emoji(2, Some("🧹")).unwrap();
    home.run(C::ArchiveItem(ItemId(numbered_id(2)))).unwrap();
    assert_eq!(
        home.emoji(2, Some("🧽")),
        Err(KinError::InvalidEvent),
        "archived"
    );
    let state = home.state();
    assert_eq!(state.pictures.emoji(&ItemId(numbered_id(1))), Some("🦷"));
    let report = encode_emojis(&state.pictures, &state.items);
    assert_eq!(
        &report[..12],
        b"KIEM\x01\x00\x00\x00\x01\x00\x00\x00",
        "only the unarchived item"
    );
    assert_eq!(&report[12..28], &numbered_id(1));
    assert_eq!(&report[28..30], &("🦷".len() as u16).to_le_bytes());
    home.emoji(1, None).unwrap();
    assert_eq!(
        home.emoji(1, None),
        Err(KinError::InvalidEvent),
        "already clear"
    );
    assert_eq!(home.state().pictures.emoji(&ItemId(numbered_id(1))), None);
}

#[test]
fn replay_keeps_an_emoji_for_an_item_it_lacks_and_never_fails() {
    // An emoji event that sorts before its item (or names one never seen)
    // changes nothing visible and doesn't fail replay.
    let mut home = Household::new();
    home.add(1, "Feed the cat", ItemClassification::Need);
    home.emoji(1, Some("🐈")).unwrap();
    let mut events = home.events.clone();
    let orphan = execute(
        &C::Picture(EventKind::ItemEmojiSet {
            item_id: ItemId(numbered_id(1)),
            emoji: Some("🐟".into()),
        }),
        context(50, 9),
        request(&events),
    )
    .unwrap()
    .event;
    let mut stray = orphan.clone();
    stray.kind = EventKind::ItemEmojiSet {
        item_id: ItemId(numbered_id(99)),
        emoji: Some("🐟".into()),
    };
    stray.event_id = EventId(numbered_id(51));
    stray.logical_time = 10;
    events.push(stray);
    let state = rebuild(&events, 1_791_475_200_100, date(TEST_DATE)).unwrap();
    assert_eq!(state.pictures.emoji(&ItemId(numbered_id(1))), Some("🐈"));
    assert_eq!(
        &encode_emojis(&state.pictures, &state.items)[8..12],
        &1u32.to_le_bytes(),
        "the stray isn't reported"
    );
}

#[test]
fn kcmd_carries_the_emoji_payload_exactly() {
    let kind = EventKind::ItemEmojiSet {
        item_id: ItemId(numbered_id(3)),
        emoji: Some("⚽".into()),
    };
    let payload = encode_payload(&kind).unwrap();
    let mut packet = vec![0u8; 128];
    packet[..4].copy_from_slice(b"KCMD");
    packet[4] = 1;
    packet[8..10].copy_from_slice(&ITEM_EMOJI_SET.to_le_bytes());
    packet[12..28].copy_from_slice(&numbered_id(500));
    packet[28..44].copy_from_slice(&HOUSEHOLD);
    packet[44..60].copy_from_slice(&ADULT);
    packet[60..76].copy_from_slice(&[0x11; 16]);
    packet[76..84].copy_from_slice(&1_791_475_200_000i64.to_le_bytes());
    packet[84..92].copy_from_slice(&1u64.to_le_bytes());
    packet[124..128].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    packet.extend_from_slice(&payload);
    let (command, _) = decode_command(&packet).unwrap();
    assert_eq!(command, C::Picture(kind));
    let mut with_id = packet.clone();
    with_id[92] = 1;
    assert!(
        decode_command(&with_id).is_err(),
        "the entity field stays zero"
    );
}

fn things(state: &HouseholdState, member: [u8; 16], on: u32) -> Vec<MyThing> {
    my_things(state, ActorId(member), date(on))
}

#[test]
fn my_things_today_are_my_open_items_due_by_today_and_my_routines_open_today() {
    let mut home = Household::new();
    home.add(1, "Pack school bag", ItemClassification::Need);
    home.add(2, "Tidy room", ItemClassification::Need);
    home.add(3, "Library book", ItemClassification::Need);
    home.add(4, "Next week's trip", ItemClassification::Need);
    home.add(5, "Someone else's", ItemClassification::Need);
    home.add(6, "Done already", ItemClassification::Need);
    home.add(7, "Gone", ItemClassification::Need);
    home.add(8, "Apples", ItemClassification::Staple);
    for item in [1, 2, 3, 4, 6, 7, 8] {
        home.assign(ResponsibilityTargetKind::Item, item, KID);
    }
    home.assign(ResponsibilityTargetKind::Item, 5, ADULT);
    let plan = |item: u32, on: u32| C::SetItemPlanningDate {
        item_id: ItemId(numbered_id(item)),
        planning_date: Some(date(on)),
    };
    home.run(plan(1, TEST_DATE)).unwrap();
    home.run(plan(3, 20261001)).unwrap();
    home.run(plan(4, 20261010)).unwrap();
    home.run(C::CompleteItem(ItemId(numbered_id(6)))).unwrap();
    home.run(C::ArchiveItem(ItemId(numbered_id(7)))).unwrap();
    home.run(C::CreateRoutine {
        id: RoutineId(numbered_id(20)),
        text: "Feed the fish".into(),
        cadence: Cadence::Daily,
        created_on: date(TEST_DATE),
    })
    .unwrap();
    home.run(C::CreateRoutine {
        id: RoutineId(numbered_id(21)),
        text: "Bins out".into(),
        cadence: Cadence::Weekly,
        created_on: date(TEST_DATE),
    })
    .unwrap();
    home.run(C::CreateRoutine {
        id: RoutineId(numbered_id(22)),
        text: "Not mine".into(),
        cadence: Cadence::Daily,
        created_on: date(TEST_DATE),
    })
    .unwrap();
    home.assign(ResponsibilityTargetKind::Routine, 20, KID);
    home.assign(ResponsibilityTargetKind::Routine, 21, KID);
    home.assign(ResponsibilityTargetKind::Routine, 22, ADULT);
    let state = home.state();
    let feed_key = state
        .routines
        .iter()
        .find(|r| r.routine_id.0 == numbered_id(20))
        .unwrap()
        .occurrence_key
        .unwrap();
    home.run(C::CompleteOccurrence {
        id: RoutineId(numbered_id(20)),
        key: feed_key,
    })
    .unwrap();
    let state = home.state();
    let bins_key = state
        .routines
        .iter()
        .find(|r| r.routine_id.0 == numbered_id(21))
        .unwrap()
        .occurrence_key
        .unwrap();
    assert_eq!(
        things(&state, KID, TEST_DATE),
        vec![
            MyThing::Item(ItemId(numbered_id(3))),
            MyThing::Item(ItemId(numbered_id(1))),
            MyThing::Item(ItemId(numbered_id(2))),
            MyThing::Routine { routine_id: numbered_id(21), occurrence: bins_key, done: false },
            MyThing::Routine { routine_id: numbered_id(20), occurrence: feed_key, done: true },
        ],
        "earlier and today's plans first, undated next; no future, completed, archived, Staple or other people's things",
    );
    assert_eq!(
        things(&state, ADULT, TEST_DATE).len(),
        2,
        "the adult's item and routine"
    );
    assert!(
        things(&state, [9; 16], TEST_DATE).is_empty(),
        "a member with nothing assigned"
    );

    // Reassigned away: gone. Paused by the household mode: routines go.
    home.run(C::ChangeResponsibility {
        target_kind: ResponsibilityTargetKind::Item,
        target_id: numbered_id(2),
        member_id: None,
    })
    .unwrap();
    home.run(C::SetHouseholdMode(HouseholdMode::Vacation))
        .unwrap();
    let state = home.state();
    assert_eq!(
        things(&state, KID, TEST_DATE),
        vec![
            MyThing::Item(ItemId(numbered_id(3))),
            MyThing::Item(ItemId(numbered_id(1)))
        ]
    );
}

#[test]
fn the_exports_speak_kmtq_kmtd_and_kiem() {
    let mut home = Household::new();
    home.add(1, "Pack school bag", ItemClassification::Need);
    home.assign(ResponsibilityTargetKind::Item, 1, KID);
    home.emoji(1, Some("🎒")).unwrap();
    // The instance history holds the records; the request is record-less.
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

    let mut query = b"KMTQ\x01\x00\x00\x00".to_vec();
    query.extend_from_slice(&KID);
    query.extend_from_slice(&context);
    let out = my_things_export(&query, &mut history).unwrap();
    assert_eq!(&out[..12], b"KMTD\x01\x00\x00\x00\x01\x00\x00\x00");
    assert_eq!(&out[12..16], &[1, 0, 0, 0]);
    assert_eq!(&out[16..32], &numbered_id(1));
    assert_eq!(&out[32..36], &[0, 0, 0, 0]);
    assert_eq!(out.len(), 36);

    let emojis = item_emojis(&context, &mut history).unwrap();
    assert_eq!(&emojis[..12], b"KIEM\x01\x00\x00\x00\x01\x00\x00\x00");

    let mut bad = query.clone();
    bad[4] = 2;
    assert_eq!(
        my_things_export(&bad, &mut history),
        Err(KinError::UnsupportedVersion)
    );
    let mut zero = query.clone();
    zero[8..24].fill(0);
    assert_eq!(
        my_things_export(&zero, &mut history),
        Err(KinError::MalformedProtocol)
    );
    assert_eq!(
        my_things_export(&query[..20], &mut history),
        Err(KinError::MalformedProtocol)
    );
}
