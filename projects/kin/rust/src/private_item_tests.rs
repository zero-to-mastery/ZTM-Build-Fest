// "Just for me" (#510, #511, #514): private item kinds 110–118, their strict
// payloads, replay, KPRV section 11 and private commands
// (`kin_private_execute`). Wire records and KCMD packets are written out by
// hand; they never come from the encoders. docs/TEST-VECTORS.md 090–094.
use crate::codec::encode_event;
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::private_items::*;
use crate::recurrence::CivilDate;
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const SAM: [u8; 16] = [1; 16];
const ALEX: [u8; 16] = [2; 16];
const BASE_TIME: i64 = 1_791_475_200_000;

fn record_at(kind: u16, event: u32, logical_time: u64, actor: [u8; 16], payload: &[u8]) -> Vec<u8> {
    let mut record = Vec::new();
    record.extend_from_slice(&1u16.to_le_bytes());
    record.extend_from_slice(&kind.to_le_bytes());
    record.extend_from_slice(&numbered_id(event));
    record.extend_from_slice(&HOUSEHOLD);
    record.extend_from_slice(&actor);
    record.extend_from_slice(&[actor[0] + 0x10; 16]);
    record.extend_from_slice(&(BASE_TIME + i64::from(event)).to_le_bytes());
    record.extend_from_slice(&logical_time.to_le_bytes());
    record.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    record.extend_from_slice(payload);
    record
}

/// Event `n` at logical time `n`, by Sam.
fn record(kind: u16, event: u32, payload: &[u8]) -> Vec<u8> {
    record_at(kind, event, u64::from(event), SAM, payload)
}

fn with_text(id: u8, prefix: &[u8], text: &[u8]) -> Vec<u8> {
    let mut payload = [id; 16].to_vec();
    payload.extend_from_slice(prefix);
    payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
    payload.extend_from_slice(text);
    payload
}

fn added(id: u8, date: u32, text: &[u8]) -> Vec<u8> {
    with_text(id, &date.to_le_bytes(), text)
}

fn dated(id: u8, date: u32) -> Vec<u8> {
    let mut payload = [id; 16].to_vec();
    payload.extend_from_slice(&date.to_le_bytes());
    payload
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

fn log_of(records: &[Vec<u8>]) -> History {
    let mut log = History::private();
    log.append(&batch(records)).unwrap();
    log
}

fn context() -> crate::request::DecodedRequest {
    crate::request::decode_context(&kine(&[], 0, TEST_DATE, None)).unwrap()
}

fn kprv(history: &mut History) -> Vec<u8> {
    crate::core::private_state(&kine(&[], 0, TEST_DATE, None), history).unwrap()
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

fn date(value: u32) -> Option<CivilDate> {
    Some(CivilDate::from_encoded(value).unwrap())
}

fn decoded(record: &[u8]) -> Result<EventKind, KinError> {
    decode_event(record).map(|event| event.kind)
}

// --- Format ---------------------------------------------------------------

#[test]
fn the_added_test_vector_decodes_and_reencodes_byte_for_byte() {
    // docs/TEST-VECTORS.md 090.
    let record = record(PRIVATE_ITEM_ADDED, 1, &added(0x5b, 20261005, b"Dentist"));
    let event = decode_event(&record).unwrap();
    assert_eq!(
        event.kind,
        EventKind::PrivateItem(PrivateItemEvent::Added {
            item_id: PrivateRecordId([0x5b; 16]),
            text: "Dentist".to_owned(),
            date: date(20261005),
        })
    );
    assert!(event.kind.is_private() && !event.kind.is_chat() && !event.kind.is_board());
    assert_eq!(encode_event(&event).unwrap(), record);
    assert_eq!(&record[2..4], &[110, 0]);
    assert_eq!(&record[84..88], &[31, 0, 0, 0], "16 + 4 + 4 + 7");
    assert_eq!(&record[104..108], &20261005u32.to_le_bytes());
    assert_eq!(record.len(), 88 + 31);
}

#[test]
fn every_item_kind_round_trips() {
    let id = PrivateRecordId([7; 16]);
    let events = [
        PrivateItemEvent::Added {
            item_id: id,
            text: "Gift for Alex".to_owned(),
            date: None,
        },
        PrivateItemEvent::Edited {
            item_id: id,
            text: "Gift for Alex (book)".to_owned(),
        },
        PrivateItemEvent::Completed { item_id: id },
        PrivateItemEvent::Reopened { item_id: id },
        PrivateItemEvent::Dated {
            item_id: id,
            date: date(20261224),
        },
        PrivateItemEvent::Dated {
            item_id: id,
            date: None,
        },
        PrivateItemEvent::Deleted { item_id: id },
        PrivateItemEvent::Restored { item_id: id },
        PrivateItemEvent::NoteSet {
            item_id: id,
            note: "Second-hand is fine\nunder 20".to_owned(),
        },
        PrivateItemEvent::NoteSet {
            item_id: id,
            note: String::new(),
        },
        PrivateItemEvent::OnTodaySet { on: false },
        PrivateItemEvent::OnTodaySet { on: true },
    ];
    for (index, item_event) in events.into_iter().enumerate() {
        let code = item_event.code();
        assert!((110..=118).contains(&code));
        let payload = item_event.encode().unwrap();
        let record = record(code, index as u32 + 1, &payload);
        let event = decode_event(&record).unwrap();
        assert_eq!(event.kind, EventKind::PrivateItem(item_event));
        assert_eq!(encode_event(&event).unwrap(), record);
    }
}

#[test]
fn item_payloads_decode_strictly() {
    let bad = |kind: u16, payload: &[u8]| decoded(&record(kind, 1, payload)).map(|_| ());
    let malformed = Err(KinError::MalformedProtocol);
    // A zero ID, an invalid date, empty or control-character text.
    assert_eq!(bad(PRIVATE_ITEM_ADDED, &added(0, 0, b"x")), malformed);
    assert_eq!(
        bad(PRIVATE_ITEM_ADDED, &added(1, 20261332, b"x")),
        malformed
    );
    assert_eq!(bad(PRIVATE_ITEM_ADDED, &added(1, 0, b"")), malformed);
    assert_eq!(
        bad(PRIVATE_ITEM_ADDED, &added(1, 0, b"two\nlines")),
        malformed
    );
    assert_eq!(bad(PRIVATE_ITEM_ADDED, &added(1, 0, &[0xff])), malformed);
    assert_eq!(
        bad(PRIVATE_ITEM_ADDED, &added(1, 0, &vec![b'a'; 4097])),
        malformed
    );
    assert!(bad(PRIVATE_ITEM_ADDED, &added(1, 0, &vec![b'a'; 4096])).is_ok());
    // A length that doesn't cover the text exactly; trailing bytes.
    let mut long = added(1, 0, b"abc");
    long.push(b'd');
    assert_eq!(bad(PRIVATE_ITEM_ADDED, &long), malformed);
    assert_eq!(bad(PRIVATE_ITEM_COMPLETED, &[1; 17]), malformed);
    assert_eq!(bad(PRIVATE_ITEM_DELETED, &[1; 15]), malformed);
    assert_eq!(bad(PRIVATE_ITEM_DATED, &[1; 21]), malformed);
    // Notes: line feeds yes, tabs no, at most 2,048 bytes, empty clears.
    assert!(bad(PRIVATE_ITEM_NOTE_SET, &with_text(1, &[], b"a\nb")).is_ok());
    assert!(bad(PRIVATE_ITEM_NOTE_SET, &with_text(1, &[], b"")).is_ok());
    assert_eq!(
        bad(PRIVATE_ITEM_NOTE_SET, &with_text(1, &[], b"a\tb")),
        malformed
    );
    assert_eq!(
        bad(
            PRIVATE_ITEM_NOTE_SET,
            &with_text(1, &[], &vec![b'a'; MAX_PRIVATE_ITEM_NOTE_BYTES + 1])
        ),
        malformed
    );
    // The setting: 0 or 1, then zero bytes, and nothing else.
    assert!(bad(PRIVATE_ITEMS_ON_TODAY_SET, &[0, 0, 0, 0]).is_ok());
    assert_eq!(bad(PRIVATE_ITEMS_ON_TODAY_SET, &[2, 0, 0, 0]), malformed);
    assert_eq!(bad(PRIVATE_ITEMS_ON_TODAY_SET, &[1, 0, 1, 0]), malformed);
    assert_eq!(bad(PRIVATE_ITEMS_ON_TODAY_SET, &[1, 0, 0]), malformed);
    // 119 is reserved: unsupported, like any private kind not known yet.
    assert_eq!(bad(119, &[1; 16]), Err(KinError::UnsupportedVersion));
    // The encoders refuse what the decoder would.
    let zero = PrivateItemEvent::Completed {
        item_id: PrivateRecordId([0; 16]),
    };
    assert_eq!(zero.encode().map(|_| ()), malformed);
    let tab = PrivateItemEvent::Edited {
        item_id: PrivateRecordId([1; 16]),
        text: "a\tb".to_owned(),
    };
    assert_eq!(tab.encode().map(|_| ()), malformed);
}

// --- Logs -----------------------------------------------------------------

#[test]
fn private_items_never_enter_another_log_or_a_household_request() {
    let item = record(PRIVATE_ITEM_ADDED, 1, &added(1, 0, b"Mine"));
    for mut log in [History::new(), History::chat(), History::board()] {
        assert_eq!(
            log.append(&batch(std::slice::from_ref(&item))),
            Err(KinError::InvalidEvent)
        );
    }
    assert_eq!(
        crate::request::decode_request(&kine(std::slice::from_ref(&item), 0, TEST_DATE, None))
            .map(|_| ()),
        Err(KinError::InvalidEvent)
    );
    // Household replay beside a private list is unchanged.
    let household = [item_record(1, 1, b"Milk", 2)];
    let alone = crate::core::replay(&kine(&household, 0, TEST_DATE, None)).unwrap();
    let mut private = log_of(&[item]);
    assert!(kprv(&mut private).len() > 44);
    assert_eq!(
        crate::core::replay(&kine(&household, 0, TEST_DATE, None)).unwrap(),
        alone
    );
}

// --- Replay ---------------------------------------------------------------

#[test]
fn the_list_replays_every_change_and_ignores_what_cannot_apply() {
    // docs/TEST-VECTORS.md 091.
    let mut log = log_of(&[
        record(PRIVATE_ITEM_ADDED, 1, &added(1, 0, b"Call the dentist")),
        record(PRIVATE_ITEM_ADDED, 2, &added(2, 20261010, b"Gift for Alex")),
        record(
            PRIVATE_ITEM_EDITED,
            3,
            &with_text(1, &[], b"Call the dentist (Tue)"),
        ),
        record(PRIVATE_ITEM_DATED, 4, &dated(1, 20261003)),
        record(PRIVATE_ITEM_COMPLETED, 5, &[2; 16]),
        record(PRIVATE_ITEM_REOPENED, 6, &[2; 16]),
        record(PRIVATE_ITEM_COMPLETED, 7, &[2; 16]),
        record(PRIVATE_ITEM_NOTE_SET, 8, &with_text(2, &[], b"A book")),
        // A second add for the same ID, and changes to an ID the list
        // lacks, change nothing.
        record(PRIVATE_ITEM_ADDED, 9, &added(1, 0, b"Imposter")),
        record(PRIVATE_ITEM_COMPLETED, 10, &[9; 16]),
        record(PRIVATE_ITEM_ADDED, 11, &added(3, 0, b"Gone")),
        record(PRIVATE_ITEM_DELETED, 12, &[3; 16]),
        record(PRIVATE_ITEM_DELETED, 13, &[3; 16]),
    ]);
    let replay = log.replay(&context()).unwrap();
    let items = replay.private().items();
    assert_eq!(items.live_count(), 2);
    assert!(items.on_today());
    let one = items.get(&PrivateRecordId([1; 16])).unwrap();
    assert_eq!(one.text, "Call the dentist (Tue)");
    assert_eq!(one.date, date(20261003));
    assert!(!one.completed && one.note.is_empty());
    assert_eq!(one.added_at, BASE_TIME + 1);
    assert_eq!(one.changed_at, 4, "the ignored add didn't touch it");
    let two = items.get(&PrivateRecordId([2; 16])).unwrap();
    assert!(two.completed);
    assert_eq!(two.note, "A book");
    assert_eq!(two.date, date(20261010));
    assert!(items.get(&PrivateRecordId([9; 16])).is_none());
    assert!(
        items.get(&PrivateRecordId([3; 16])).unwrap().deleted,
        "a tombstone for Undo"
    );
    assert_eq!(items.live().count(), 2);

    // Restoring brings it back as it was; the setting turns off and on.
    log.append(&batch(&[
        record(PRIVATE_ITEM_RESTORED, 14, &[3; 16]),
        record(PRIVATE_ITEMS_ON_TODAY_SET, 15, &[0, 0, 0, 0]),
    ]))
    .unwrap();
    let items = log.replay(&context()).unwrap().private().items().clone();
    assert_eq!(items.live_count(), 3);
    assert_eq!(items.get(&PrivateRecordId([3; 16])).unwrap().text, "Gone");
    assert!(!items.on_today());
}

#[test]
fn a_private_list_holds_one_members_items() {
    let mut log = log_of(&[
        record(PRIVATE_ITEM_ADDED, 1, &added(1, 0, b"Mine")),
        record_at(PRIVATE_ITEM_ADDED, 2, 2, ALEX, &added(2, 0, b"Not mine")),
    ]);
    assert_eq!(
        log.replay(&context()).map(|_| ()),
        Err(KinError::InvalidEvent)
    );
}

#[test]
fn adds_and_restores_past_the_cap_change_nothing() {
    let mut records: Vec<Vec<u8>> = (1..=MAX_PRIVATE_ITEMS as u32)
        .map(|n| {
            let mut payload = numbered_id(n).to_vec();
            payload[15] = 0xee;
            payload.extend_from_slice(&0u32.to_le_bytes());
            payload.extend_from_slice(&1u32.to_le_bytes());
            payload.push(b'x');
            record(PRIVATE_ITEM_ADDED, n, &payload)
        })
        .collect();
    let next = MAX_PRIVATE_ITEMS as u32 + 1;
    // One more add is ignored; delete one, and a restore and an add compete
    // for the free place: the earlier in replay order wins.
    let mut first = numbered_id(1).to_vec();
    first[15] = 0xee;
    records.push(record(PRIVATE_ITEM_ADDED, next, &added(0x77, 0, b"over")));
    records.push(record(PRIVATE_ITEM_DELETED, next + 1, &first));
    records.push(record(
        PRIVATE_ITEM_ADDED,
        next + 2,
        &added(0x78, 0, b"takes the place"),
    ));
    records.push(record(PRIVATE_ITEM_RESTORED, next + 3, &first));
    let mut log = log_of(&records);
    let replay = log.replay(&context()).unwrap();
    let items = replay.private().items();
    assert_eq!(items.live_count(), MAX_PRIVATE_ITEMS);
    assert!(items.get(&PrivateRecordId([0x77; 16])).is_none());
    assert!(items.get(&PrivateRecordId([0x78; 16])).is_some());
    assert!(
        items
            .get(&PrivateRecordId(first.try_into().unwrap()))
            .unwrap()
            .deleted
    );
}

#[test]
fn replay_reuses_its_checkpoint_and_equals_a_fresh_replay() {
    let first = [
        record(PRIVATE_ITEM_ADDED, 1, &added(1, 0, b"a")),
        record(PRIVATE_ITEM_ADDED, 2, &added(2, 0, b"b")),
    ];
    let mut log = log_of(&first);
    let before = kprv(&mut log);
    let later = record(PRIVATE_ITEM_COMPLETED, 3, &[1; 16]);
    log.append(&batch(std::slice::from_ref(&later))).unwrap();
    let incremental = kprv(&mut log);
    assert!(log.last_replay_reused());
    assert_ne!(before, incremental);
    let mut fresh = log_of(&[first[0].clone(), first[1].clone(), later]);
    assert_eq!(kprv(&mut fresh), incremental);
}

// --- KPRV -----------------------------------------------------------------

#[test]
fn kprv_adds_section_eleven_once_there_is_an_item_or_a_setting() {
    // docs/TEST-VECTORS.md 092. No items: KPRV is exactly as before (067).
    assert_eq!(kprv(&mut History::private()).len(), 44);

    let mut log = log_of(&[
        record(PRIVATE_ITEM_ADDED, 1, &added(2, 20261003, b"two")),
        record(PRIVATE_ITEM_ADDED, 2, &added(1, 0, b"one")),
        record(PRIVATE_ITEM_NOTE_SET, 3, &with_text(1, &[], b"n")),
        record(PRIVATE_ITEM_COMPLETED, 4, &[2; 16]),
        record(PRIVATE_ITEM_ADDED, 5, &added(3, 0, b"deleted")),
        record(PRIVATE_ITEM_DELETED, 6, &[3; 16]),
    ]);
    let bytes = kprv(&mut log);
    assert_eq!(&bytes[8..24], &SAM);
    assert_eq!(u32_at(&bytes, 24), 6, "every record counts");
    assert_eq!(&bytes[28..32], &[2, 0, 0, 0], "two sections");
    // Section 1 (no notes), then section 11.
    assert_eq!(&bytes[32..36], &[1, 0, 0, 0]);
    assert_eq!(u32_at(&bytes, 36), 4);
    let at = 44;
    assert_eq!(&bytes[at..at + 4], &[11, 0, 0, 0]);
    let length = u32_at(&bytes, at + 4) as usize;
    assert_eq!(bytes.len(), at + 8 + length);
    let section = &bytes[at + 8..];
    assert_eq!(u32_at(section, 0), 0, "on Today by default");
    assert_eq!(u32_at(section, 4), 2, "the deleted item is left out");
    // Item 1 first (ascending ID).
    let one = &section[8..];
    assert_eq!(&one[..16], &[1; 16]);
    assert_eq!(&one[16..24], &(BASE_TIME + 2).to_le_bytes());
    assert_eq!(&one[24..32], &3u64.to_le_bytes());
    assert_eq!(u32_at(one, 32), 0);
    assert_eq!(&one[36..40], &[0, 0, 0, 0]);
    assert_eq!((u32_at(one, 40), u32_at(one, 44)), (3, 1));
    assert_eq!(&one[48..52], b"onen");
    let two = &one[52..];
    assert_eq!(&two[..16], &[2; 16]);
    assert_eq!(&two[24..32], &4u64.to_le_bytes());
    assert_eq!(u32_at(two, 32), 20261003);
    assert_eq!(&two[36..40], &[1, 0, 0, 0]);
    assert_eq!(&two[48..], b"two");

    // A setting alone shows the section, with its flag.
    let mut setting = log_of(&[record(PRIVATE_ITEMS_ON_TODAY_SET, 1, &[0, 0, 0, 0])]);
    let bytes = kprv(&mut setting);
    assert_eq!(&bytes[28..30], &[2, 0]);
    assert_eq!(
        &bytes[52..60],
        &[1, 0, 0, 0, 0, 0, 0, 0],
        "flag set, no items"
    );
    assert_eq!(bytes.len(), 60);
}

// --- Commands -------------------------------------------------------------

/// A KCMD packet with a private action carrying `payload`, by `actor` at
/// `logical_time` with event ID `event`, inside an execute request.
fn command(kind: u16, payload: &[u8], event: u32, logical_time: u64, actor: [u8; 16]) -> Vec<u8> {
    let mut packet = b"KCMD".to_vec();
    packet.extend_from_slice(&1u16.to_le_bytes());
    packet.extend_from_slice(&[0; 2]);
    packet.extend_from_slice(&kind.to_le_bytes());
    packet.extend_from_slice(&[0; 2]);
    packet.extend_from_slice(&numbered_id(event));
    packet.extend_from_slice(&HOUSEHOLD);
    packet.extend_from_slice(&actor);
    packet.extend_from_slice(&[actor[0] + 0x10; 16]);
    packet.extend_from_slice(&(BASE_TIME + i64::from(event)).to_le_bytes());
    packet.extend_from_slice(&logical_time.to_le_bytes());
    packet.extend_from_slice(&[0; 32]);
    packet.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    packet.extend_from_slice(payload);
    let mut bytes = (packet.len() as u32).to_le_bytes().to_vec();
    bytes.extend_from_slice(&packet);
    bytes.extend_from_slice(&kine(&[], 0, TEST_DATE, None));
    bytes
}

fn execute(log: &mut History, kind: u16, payload: &[u8], event: u32) -> Result<Vec<u8>, KinError> {
    crate::private_command::execute(&command(kind, payload, event, u64::from(event), SAM), log)
}

#[test]
fn a_private_command_returns_the_canonical_event_and_leaves_the_log_alone() {
    // docs/TEST-VECTORS.md 093.
    let mut log = History::private();
    let bytes = execute(
        &mut log,
        PRIVATE_ITEM_ADDED,
        &added(0x5b, 20261005, b"Dentist"),
        1,
    )
    .unwrap();
    assert_eq!(&bytes[..8], b"KCMT\x01\0\0\0");
    let event_length = u32_at(&bytes, 8) as usize;
    let metadata_length = u32_at(&bytes, 12) as usize;
    assert_eq!(u32_at(&bytes, 16), 0, "no projection");
    assert_eq!(bytes.len(), 20 + event_length + metadata_length);
    let expected = record(PRIVATE_ITEM_ADDED, 1, &added(0x5b, 20261005, b"Dentist"));
    assert_eq!(&bytes[20..20 + event_length], expected.as_slice());
    assert_eq!(&bytes[20 + event_length..20 + event_length + 4], b"KMET");
    assert!(log.is_empty());
    // Once stored, the next command builds on it.
    log.append(&batch(&[expected])).unwrap();
    assert!(execute(&mut log, PRIVATE_ITEM_COMPLETED, &[0x5b; 16], 2).is_ok());
    // The placeholder note goes through the same export.
    assert!(execute(
        &mut log,
        crate::private::PRIVATE_NOTE_SET,
        &with_text(9, &[], b"n"),
        2
    )
    .is_ok());
}

#[test]
fn private_commands_refuse_what_replay_would_ignore_or_that_changes_nothing() {
    let refused = Err(KinError::InvalidEvent);
    let mut log = log_of(&[
        record(PRIVATE_ITEM_ADDED, 1, &added(1, 20261003, b"Open")),
        record(PRIVATE_ITEM_ADDED, 2, &added(2, 0, b"Done")),
        record(PRIVATE_ITEM_COMPLETED, 3, &[2; 16]),
        record(PRIVATE_ITEM_ADDED, 4, &added(3, 0, b"Deleted")),
        record(PRIVATE_ITEM_DELETED, 5, &[3; 16]),
    ]);
    let run = |log: &mut History, kind, payload: &[u8]| execute(log, kind, payload, 6).map(|_| ());
    // A known ID, even a deleted one, can't be added again.
    assert_eq!(
        run(&mut log, PRIVATE_ITEM_ADDED, &added(1, 0, b"Again")),
        refused
    );
    assert_eq!(
        run(&mut log, PRIVATE_ITEM_ADDED, &added(3, 0, b"Again")),
        refused
    );
    // Untrimmed text and notes.
    assert_eq!(
        run(&mut log, PRIVATE_ITEM_ADDED, &added(4, 0, b" padded")),
        refused
    );
    assert_eq!(
        run(
            &mut log,
            PRIVATE_ITEM_NOTE_SET,
            &with_text(1, &[], b"note ")
        ),
        refused
    );
    // Changes that change nothing.
    assert_eq!(
        run(&mut log, PRIVATE_ITEM_EDITED, &with_text(1, &[], b"Open")),
        refused
    );
    assert_eq!(run(&mut log, PRIVATE_ITEM_COMPLETED, &[2; 16]), refused);
    assert_eq!(run(&mut log, PRIVATE_ITEM_REOPENED, &[1; 16]), refused);
    assert_eq!(
        run(&mut log, PRIVATE_ITEM_DATED, &dated(1, 20261003)),
        refused
    );
    assert_eq!(
        run(&mut log, PRIVATE_ITEM_NOTE_SET, &with_text(1, &[], b"")),
        refused
    );
    assert_eq!(
        run(&mut log, PRIVATE_ITEMS_ON_TODAY_SET, &[1, 0, 0, 0]),
        refused
    );
    // Unknown and deleted items take no changes; only a deleted one restores.
    assert_eq!(run(&mut log, PRIVATE_ITEM_COMPLETED, &[9; 16]), refused);
    assert_eq!(
        run(&mut log, PRIVATE_ITEM_EDITED, &with_text(3, &[], b"x")),
        refused
    );
    assert_eq!(run(&mut log, PRIVATE_ITEM_DELETED, &[3; 16]), refused);
    assert_eq!(run(&mut log, PRIVATE_ITEM_RESTORED, &[1; 16]), refused);
    // And what does change something goes through.
    for (kind, payload) in [
        (PRIVATE_ITEM_ADDED, added(4, 0, b"New")),
        (PRIVATE_ITEM_EDITED, with_text(1, &[], b"Open (edited)")),
        (PRIVATE_ITEM_COMPLETED, vec![1; 16]),
        (PRIVATE_ITEM_REOPENED, vec![2; 16]),
        (PRIVATE_ITEM_DATED, dated(1, 0)),
        (PRIVATE_ITEM_NOTE_SET, with_text(1, &[], b"a\nb")),
        (PRIVATE_ITEM_DELETED, vec![1; 16]),
        (PRIVATE_ITEM_RESTORED, vec![3; 16]),
        (PRIVATE_ITEMS_ON_TODAY_SET, vec![0, 0, 0, 0]),
    ] {
        assert!(run(&mut log, kind, &payload).is_ok(), "kind {kind}");
    }
}

#[test]
fn private_commands_check_order_author_household_and_the_log() {
    let refused = Err(KinError::InvalidEvent);
    let mut log = log_of(&[record(PRIVATE_ITEM_ADDED, 1, &added(1, 0, b"Mine"))]);
    let payload = added(2, 0, b"Next");
    let run = |log: &mut History, bytes: Vec<u8>| {
        crate::private_command::execute(&bytes, log).map(|_| ())
    };
    // Not after the log's latest logical time; an event ID it already has.
    assert_eq!(
        run(&mut log, command(PRIVATE_ITEM_ADDED, &payload, 2, 1, SAM)),
        refused
    );
    assert_eq!(
        run(&mut log, command(PRIVATE_ITEM_ADDED, &payload, 1, 2, SAM)),
        refused
    );
    // Another member.
    assert_eq!(
        run(&mut log, command(PRIVATE_ITEM_ADDED, &payload, 2, 2, ALEX)),
        refused
    );
    // Another household.
    let mut other = command(PRIVATE_ITEM_ADDED, &payload, 2, 2, SAM);
    other[4 + 28] = 0xab;
    assert_eq!(run(&mut log, other), refused);
    // Any other log.
    for mut wrong in [History::new(), History::chat(), History::board()] {
        assert_eq!(
            run(&mut wrong, command(PRIVATE_ITEM_ADDED, &payload, 2, 2, SAM)),
            refused
        );
    }
    // A household action, an entity ID or a date in the header, a short
    // payload length.
    assert_eq!(
        run(&mut log, command(1, &payload, 2, 2, SAM)),
        Err(KinError::UnsupportedVersion)
    );
    let mut entity = command(PRIVATE_ITEM_ADDED, &payload, 2, 2, SAM);
    entity[4 + 92] = 1;
    assert_eq!(run(&mut log, entity), Err(KinError::MalformedProtocol));
    let mut length = command(PRIVATE_ITEM_ADDED, &payload, 2, 2, SAM);
    length[4 + 124] -= 1;
    assert_eq!(run(&mut log, length), Err(KinError::MalformedProtocol));
    // A good one, finally.
    assert!(run(&mut log, command(PRIVATE_ITEM_ADDED, &payload, 2, 2, SAM)).is_ok());
}

#[test]
fn a_full_list_refuses_adds_and_restores() {
    // docs/TEST-VECTORS.md 094.
    let mut records: Vec<Vec<u8>> = (1..=MAX_PRIVATE_ITEMS as u32)
        .map(|n| {
            let mut payload = numbered_id(n).to_vec();
            payload[15] = 0xee;
            payload.extend_from_slice(&[0, 0, 0, 0, 1, 0, 0, 0, b'x']);
            record(PRIVATE_ITEM_ADDED, n, &payload)
        })
        .collect();
    let full = MAX_PRIVATE_ITEMS as u32;
    let mut log = log_of(&records);
    assert_eq!(
        execute(
            &mut log,
            PRIVATE_ITEM_ADDED,
            &added(0x77, 0, b"one more"),
            full + 1
        )
        .map(|_| ()),
        Err(KinError::InvalidEvent)
    );
    let mut first = numbered_id(1).to_vec();
    first[15] = 0xee;
    records.push(record(PRIVATE_ITEM_DELETED, full + 1, &first));
    let mut log = log_of(&records);
    assert!(execute(
        &mut log,
        PRIVATE_ITEM_ADDED,
        &added(0x77, 0, b"one more"),
        full + 2
    )
    .is_ok());
    assert!(execute(&mut log, PRIVATE_ITEM_RESTORED, &first, full + 2).is_ok());
}
