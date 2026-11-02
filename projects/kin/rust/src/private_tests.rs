// A member's private log (#489, ADR 0019): private kinds 100–199, the
// placeholder PRIVATE_NOTE_SET, the private log apart from every other log,
// its replay and checkpoint, and the KPRV export. Wire records are written
// out by hand; they never come from the encoders.
use crate::codec::encode_event;
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::private::*;
use crate::request::{decode_context, decode_request};
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

fn note_payload(n: u8, text: &[u8]) -> Vec<u8> {
    let mut payload = [n; 16].to_vec();
    payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
    payload.extend_from_slice(text);
    payload
}

fn note_at(event: u32, logical_time: u64, actor: [u8; 16], n: u8, text: &[u8]) -> Vec<u8> {
    record_at(
        PRIVATE_NOTE_SET,
        event,
        logical_time,
        actor,
        &note_payload(n, text),
    )
}

fn note(event: u32, n: u8, text: &[u8]) -> Vec<u8> {
    note_at(event, u64::from(event), SAM, n, text)
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

fn context() -> crate::request::DecodedRequest {
    decode_context(&kine(&[], 0, TEST_DATE, None)).unwrap()
}

fn kprv(history: &mut History) -> Vec<u8> {
    crate::core::private_state(&kine(&[], 0, TEST_DATE, None), history).unwrap()
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

// --- Format ---------------------------------------------------------------

#[test]
fn the_note_test_vector_decodes_and_reencodes_byte_for_byte() {
    // docs/TEST-VECTORS.md "Private note (kind 100)".
    let record = note(1, 0x5a, b"Call Mum");
    let event = decode_event(&record).unwrap();
    assert_eq!(
        event.kind,
        EventKind::PrivateNoteSet {
            note_id: PrivateRecordId([0x5a; 16]),
            text: "Call Mum".to_owned(),
        }
    );
    assert!(event.kind.is_private());
    assert!(!event.kind.is_chat() && !event.kind.is_board());
    assert_eq!(encode_event(&event).unwrap(), record);
    assert_eq!(record.len(), 88 + 20 + 8);
    assert_eq!(&record[2..4], &[100, 0]);
    assert_eq!(&record[84..88], &[0x1c, 0, 0, 0]);
}

#[test]
fn private_payloads_decode_strictly() {
    let bad = |payload: &[u8]| decode_event(&record_at(PRIVATE_NOTE_SET, 1, 1, SAM, payload));
    // A zero note ID.
    assert_eq!(
        bad(&note_payload(0, b"x")).map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
    // A length that doesn't cover the text exactly.
    let mut long = note_payload(1, b"abc");
    long.push(b'd');
    assert_eq!(bad(&long).map(|_| ()), Err(KinError::MalformedProtocol));
    assert_eq!(bad(&[1; 19]).map(|_| ()), Err(KinError::MalformedProtocol));
    // Control characters other than a line break, invalid UTF-8, too long.
    assert_eq!(
        bad(&note_payload(1, b"a\tb")).map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
    assert_eq!(
        bad(&note_payload(1, &[0xff])).map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
    let too_long = vec![b'a'; MAX_PRIVATE_NOTE_BYTES + 1];
    assert_eq!(
        bad(&note_payload(1, &too_long)).map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
    // Line breaks, the longest note and an empty (removing) note are fine.
    assert!(bad(&note_payload(1, b"one\ntwo")).is_ok());
    assert!(bad(&note_payload(1, &vec![b'a'; MAX_PRIVATE_NOTE_BYTES])).is_ok());
    assert!(bad(&note_payload(1, b"")).is_ok());
    // A private kind this engine doesn't know yet is unsupported, not
    // mistaken for something else.
    // (101–104 are the journal's, journal_tests.rs; 110–118 "Just for me".)
    for code in [105, 150, LAST_PRIVATE_KIND] {
        assert!(is_private_code(code));
        assert_eq!(
            decode_event(&record_at(code, 1, 1, SAM, &note_payload(1, b"x"))).map(|_| ()),
            Err(KinError::UnsupportedVersion)
        );
    }
    assert!(!is_private_code(FIRST_PRIVATE_KIND - 1) && !is_private_code(LAST_PRIVATE_KIND + 1));
}

// --- Logs -----------------------------------------------------------------

#[test]
fn private_events_never_enter_another_log_or_a_household_request() {
    let private = note(1, 1, b"Mine");
    for mut log in [History::new(), History::chat(), History::board()] {
        assert_eq!(
            log.append(&batch(std::slice::from_ref(&private))),
            Err(KinError::InvalidEvent)
        );
        assert!(log.is_empty());
    }
    // So they never reach KINS: a household request refuses them too.
    assert_eq!(
        decode_request(&kine(std::slice::from_ref(&private), 0, TEST_DATE, None)).map(|_| ()),
        Err(KinError::InvalidEvent)
    );
    // And the private log refuses everything else.
    let mut log = History::private();
    assert_eq!(log.limit(), MAX_PRIVATE_EVENT_COUNT);
    assert_eq!(MAX_PRIVATE_EVENT_COUNT, 50_000);
    assert_eq!(
        log.append(&batch(&[item_record(1, 1, b"Milk", 2)])),
        Err(KinError::InvalidEvent)
    );
    assert!(log.is_empty());
    log.append(&batch(&[private])).unwrap();
    assert_eq!(log.len(), 1);
}

#[test]
fn a_household_replay_with_a_full_private_log_beside_it_is_unchanged() {
    let household = [item_record(1, 1, b"Milk", 2)];
    let alone = crate::core::replay(&kine(&household, 0, TEST_DATE, None)).unwrap();
    let mut private = History::private();
    private
        .append(&batch(&[note(1, 1, b"Mine"), note(2, 2, b"Also mine")]))
        .unwrap();
    assert!(kprv(&mut private).len() > 44);
    let beside = crate::core::replay(&kine(&household, 0, TEST_DATE, None)).unwrap();
    assert_eq!(alone, beside);
    // The household projection's finalized state has nowhere to carry them.
    let mut log = History::new();
    log.append(&batch(&household)).unwrap();
    assert_eq!(log.replay(&context()).unwrap().private().notes().count(), 0);
}

#[test]
fn the_private_log_is_capped_at_fifty_thousand_events() {
    let mut log = History::private();
    let records: Vec<Vec<u8>> = (1..=MAX_PRIVATE_EVENT_COUNT as u32)
        .map(|event| note(event, 1, b"x"))
        .collect();
    log.append(&batch(&records)).unwrap();
    assert_eq!(
        log.append(&batch(&[note(MAX_PRIVATE_EVENT_COUNT as u32 + 1, 1, b"y")])),
        Err(KinError::SizeLimit)
    );
    assert_eq!(log.len(), MAX_PRIVATE_EVENT_COUNT);
}

// --- Replay ---------------------------------------------------------------

#[test]
fn the_latest_note_in_replay_order_wins_and_empty_text_removes_it() {
    let mut log = History::private();
    // Stored out of replay order: event 3 (logical time 2) sorts before
    // event 2 (logical time 3).
    log.append(&batch(&[
        note_at(1, 1, SAM, 1, b"first"),
        note_at(2, 3, SAM, 1, b"latest"),
        note_at(3, 2, SAM, 1, b"middle"),
        note_at(4, 4, SAM, 2, b"gone soon"),
        note_at(5, 5, SAM, 2, b""),
    ]))
    .unwrap();
    let replay = log.replay(&context()).unwrap();
    let state = replay.private();
    assert_eq!(state.member(), Some(ActorId(SAM)));
    let notes: Vec<_> = state.notes().collect();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].0, &PrivateRecordId([1; 16]));
    assert_eq!(notes[0].1.text, "latest");
    assert_eq!(notes[0].1.logical_time, 3);
    assert_eq!(notes[0].1.device_id, DeviceId([0x11; 16]));
    assert!(state.note(&PrivateRecordId([2; 16])).is_none());
}

#[test]
fn one_private_log_holds_one_members_events() {
    let mut log = History::private();
    log.append(&batch(&[
        note_at(1, 1, SAM, 1, b"mine"),
        note_at(2, 2, ALEX, 2, b"not mine"),
    ]))
    .unwrap();
    assert_eq!(
        log.replay(&context()).map(|_| ()),
        Err(KinError::InvalidEvent)
    );
}

#[test]
fn replay_reuses_its_checkpoint_and_equals_a_fresh_replay() {
    let mut log = History::private();
    log.append(&batch(&[note(1, 1, b"a"), note(2, 2, b"b")]))
        .unwrap();
    let first = kprv(&mut log);
    log.append(&batch(&[note(3, 1, b"a again")])).unwrap();
    let incremental = kprv(&mut log);
    assert!(
        log.last_replay_reused(),
        "a strictly later event extends the checkpoint"
    );
    assert_ne!(first, incremental);
    let mut fresh = History::private();
    fresh
        .append(&batch(&[
            note(1, 1, b"a"),
            note(2, 2, b"b"),
            note(3, 1, b"a again"),
        ]))
        .unwrap();
    assert_eq!(kprv(&mut fresh), incremental);
    // Truncating below the checkpoint rebuilds it.
    log.truncate(2).unwrap();
    assert_eq!(kprv(&mut log), first);
    assert!(!log.last_replay_reused());
}

// --- KPRV -----------------------------------------------------------------

#[test]
fn kprv_lays_out_the_member_count_and_note_section() {
    let mut empty = History::private();
    let bytes = kprv(&mut empty);
    assert_eq!(&bytes[..4], b"KPRV");
    assert_eq!(&bytes[4..8], &[1, 0, 0, 0]);
    assert_eq!(&bytes[8..24], &[0; 16], "no member while empty");
    assert_eq!(u32_at(&bytes, 24), 0);
    assert_eq!(&bytes[28..32], &[1, 0, 0, 0], "one section, reserved zero");
    assert_eq!(&bytes[32..36], &[1, 0, 0, 0], "section 1, reserved zero");
    assert_eq!(u32_at(&bytes, 36), 4);
    assert_eq!(u32_at(&bytes, 40), 0);
    assert_eq!(bytes.len(), 44);

    let mut log = History::private();
    log.append(&batch(&[note(1, 2, b"two"), note(2, 1, b"one")]))
        .unwrap();
    let bytes = kprv(&mut log);
    assert_eq!(&bytes[8..24], &SAM);
    assert_eq!(u32_at(&bytes, 24), 2);
    let section = u32_at(&bytes, 36) as usize;
    assert_eq!(bytes.len(), 40 + section);
    assert_eq!(u32_at(&bytes, 40), 2);
    // Ascending ID order: note 1 first.
    let first = 44;
    assert_eq!(&bytes[first..first + 16], &[1; 16]);
    assert_eq!(&bytes[first + 16..first + 24], &2u64.to_le_bytes());
    assert_eq!(&bytes[first + 24..first + 40], &[0x11; 16]);
    assert_eq!(u32_at(&bytes, first + 40), 3);
    assert_eq!(&bytes[first + 44..first + 47], b"one");
    let second = first + 47;
    assert_eq!(&bytes[second..second + 16], &[2; 16]);
    assert_eq!(&bytes[second + 44..], b"two");
}
