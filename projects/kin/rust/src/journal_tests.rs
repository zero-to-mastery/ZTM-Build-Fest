// The journal (#496, #497, #501): kinds 101–104 in a member's private log,
// their strict payloads, replay, the KPRV journal section (101) and the
// private command path (`kin_private_execute`, private_command.rs). Wire records and commands
// are written out by hand; they never come from the encoders.
use crate::codec::encode_event;
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::journal::*;
use crate::private::{is_private_code, SECTION_JOURNAL, SECTION_NOTES};
use crate::private_command::execute;
use crate::request::decode_context;
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const SAM: [u8; 16] = [1; 16];
const ALEX: [u8; 16] = [2; 16];
const DEVICE: [u8; 16] = [0x11; 16];
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

/// A photo whose four 32-byte fields are `n`, `n + 1`, `n + 2`, `n + 3`.
fn photo(n: u8, kind: u8, size: u32) -> Vec<u8> {
    let mut bytes = vec![kind, 0, 0, 0];
    bytes.extend_from_slice(&size.to_le_bytes());
    for offset in 0..4 {
        bytes.extend_from_slice(&[n + offset; 32]);
    }
    bytes
}

fn content(entry: u8, date: u32, title: &[u8], body: &[u8], photos: &[Vec<u8>]) -> Vec<u8> {
    let mut payload = [entry; 16].to_vec();
    payload.extend_from_slice(&date.to_le_bytes());
    payload.extend_from_slice(&(title.len() as u16).to_le_bytes());
    payload.push(photos.len() as u8);
    payload.push(0);
    payload.extend_from_slice(&(body.len() as u32).to_le_bytes());
    payload.extend_from_slice(title);
    payload.extend_from_slice(body);
    for photo in photos {
        payload.extend_from_slice(photo);
    }
    payload
}

fn created(event: u32, entry: u8, date: u32, body: &[u8]) -> Vec<u8> {
    record_at(
        JOURNAL_ENTRY_CREATED,
        event,
        u64::from(event),
        SAM,
        &content(entry, date, b"", body, &[]),
    )
}

fn edited(event: u32, entry: u8, date: u32, title: &[u8], body: &[u8]) -> Vec<u8> {
    record_at(
        JOURNAL_ENTRY_EDITED,
        event,
        u64::from(event),
        SAM,
        &content(entry, date, title, body, &[]),
    )
}

fn by_id(kind: u16, event: u32, entry: u8) -> Vec<u8> {
    record_at(kind, event, u64::from(event), SAM, &[entry; 16])
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
    if !records.is_empty() {
        log.append(&batch(records)).unwrap();
    }
    log
}

fn context() -> crate::request::DecodedRequest {
    decode_context(&kine(&[], 0, TEST_DATE, None)).unwrap()
}

fn kprv(history: &mut History) -> Vec<u8> {
    crate::core::private_state(&kine(&[], 0, TEST_DATE, None), history).unwrap()
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap())
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

/// The KPRV journal section's bytes (after its 8-byte section header), or
/// None when KPRV has none.
fn find_journal_section(bytes: &[u8]) -> Option<&[u8]> {
    let count = u16_at(bytes, 28);
    let mut at = 32;
    let mut found = None;
    for _ in 0..count {
        let length = u32_at(bytes, at + 4) as usize;
        if u16_at(bytes, at) == SECTION_JOURNAL {
            found = Some(&bytes[at + 8..at + 8 + length]);
        }
        at += 8 + length;
    }
    assert_eq!(at, bytes.len());
    found
}

fn journal_section(bytes: &[u8]) -> &[u8] {
    find_journal_section(bytes).expect("a journal section")
}

/// The entry IDs (first byte) in a journal section, in order.
fn section_entries(section: &[u8]) -> Vec<u8> {
    let count = u32_at(section, 0) as usize;
    let mut at = 4;
    let mut ids = Vec::new();
    for _ in 0..count {
        ids.push(section[at]);
        let title = usize::from(u16_at(section, at + 52));
        let photos = usize::from(section[at + 54]);
        let body = u32_at(section, at + 56) as usize;
        at += KPRV_ENTRY_HEADER_BYTES + title + body + JOURNAL_PHOTO_BYTES * photos;
    }
    assert_eq!(at, section.len());
    ids
}

/// A private KCMD: the 128-byte header and `payload` as its text, then the
/// record-less KINE context, framed for `execute`.
fn command(kind: u16, event: u32, logical_time: u64, actor: [u8; 16], payload: &[u8]) -> Vec<u8> {
    let mut packet = vec![0u8; 128];
    packet[..4].copy_from_slice(b"KCMD");
    packet[4..6].copy_from_slice(&1u16.to_le_bytes());
    packet[8..10].copy_from_slice(&kind.to_le_bytes());
    packet[12..28].copy_from_slice(&numbered_id(event));
    packet[28..44].copy_from_slice(&HOUSEHOLD);
    packet[44..60].copy_from_slice(&actor);
    packet[60..76].copy_from_slice(&[actor[0] + 0x10; 16]);
    packet[76..84].copy_from_slice(&(BASE_TIME + i64::from(event)).to_le_bytes());
    packet[84..92].copy_from_slice(&logical_time.to_le_bytes());
    packet[124..128].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    packet.extend_from_slice(payload);
    let mut framed = (packet.len() as u32).to_le_bytes().to_vec();
    framed.extend_from_slice(&packet);
    framed.extend_from_slice(&kine(&[], 0, TEST_DATE, None));
    framed
}

/// Runs a command and returns the canonical event from its KCMT.
fn run(history: &mut History, framed: &[u8]) -> Result<Vec<u8>, KinError> {
    let result = execute(framed, history)?;
    assert_eq!(&result[..8], b"KCMT\x01\0\0\0");
    let event_length = u32_at(&result, 8) as usize;
    let metadata_length = u32_at(&result, 12) as usize;
    assert_eq!(u32_at(&result, 16), 0, "no projection");
    assert_eq!(result.len(), 20 + event_length + metadata_length);
    assert_eq!(&result[20 + event_length..24 + event_length], b"KMET");
    Ok(result[20..20 + event_length].to_vec())
}

// --- Format ---------------------------------------------------------------

#[test]
fn the_entry_test_vector_decodes_and_reencodes_byte_for_byte() {
    // docs/TEST-VECTORS.md 068: entry 0x5a × 16 on 2026-10-03, titled
    // "Park", body "Swings.\nThen cocoa.", one JPEG photo.
    let payload = content(
        0x5a,
        20261003,
        b"Park",
        b"Swings.\nThen cocoa.",
        &[photo(0x21, 1, 52_000)],
    );
    assert_eq!(payload.len(), 28 + 4 + 19 + 136);
    let record = record_at(JOURNAL_ENTRY_CREATED, 1, 1, SAM, &payload);
    let event = decode_event(&record).unwrap();
    let EventKind::Journal(JournalEvent::Created {
        entry_id,
        content: decoded,
    }) = &event.kind
    else {
        panic!("a journal entry");
    };
    assert_eq!(entry_id, &PrivateRecordId([0x5a; 16]));
    assert_eq!(decoded.date.encoded(), 20261003);
    assert_eq!(decoded.title, "Park");
    assert_eq!(decoded.body, "Swings.\nThen cocoa.");
    assert_eq!(decoded.photos.len(), 1);
    let first = &decoded.photos[0];
    assert_eq!((first.kind, first.size), (1, 52_000));
    assert_eq!(
        (first.blob, first.key, first.thumbnail, first.thumbnail_key),
        ([0x21; 32], [0x22; 32], [0x23; 32], [0x24; 32])
    );
    assert!(event.kind.is_private());
    assert!(!event.kind.is_chat() && !event.kind.is_board());
    assert_eq!(encode_event(&event).unwrap(), record);
    assert_eq!(&record[2..4], &[101, 0]);
    assert_eq!(&record[84..88], &187u32.to_le_bytes());
    assert_eq!(
        &record[88 + 16..88 + 28],
        &[0x8b, 0x28, 0x35, 0x01, 4, 0, 1, 0, 19, 0, 0, 0]
    );

    // Edit, delete and restore.
    let edit = record_at(
        JOURNAL_ENTRY_EDITED,
        2,
        2,
        SAM,
        &content(0x5a, 20261003, b"", b"Swings.", &[]),
    );
    assert!(matches!(
        decode_event(&edit).unwrap().kind,
        EventKind::Journal(JournalEvent::Edited { .. })
    ));
    assert_eq!(encode_event(&decode_event(&edit).unwrap()).unwrap(), edit);
    for kind in [JOURNAL_ENTRY_DELETED, JOURNAL_ENTRY_RESTORED] {
        let record = by_id(kind, 3, 0x5a);
        assert_eq!(record.len(), 88 + 16);
        assert_eq!(
            encode_event(&decode_event(&record).unwrap()).unwrap(),
            record
        );
    }
}

#[test]
fn journal_payloads_decode_strictly() {
    let bad =
        |kind: u16, payload: &[u8]| decode_event(&record_at(kind, 1, 1, SAM, payload)).map(|_| ());
    let malformed = Err(KinError::MalformedProtocol);
    let entry =
        |title: &[u8], body: &[u8], photos: &[Vec<u8>]| content(1, 20261003, title, body, photos);
    // Well formed: a title alone, a body alone, a photo alone, line feeds,
    // the longest title and body, ten photos.
    let ten: Vec<Vec<u8>> = (0..10).map(|n| photo(1 + n * 4, 1, 29)).collect();
    for good in [
        entry(b"Title only", b"", &[]),
        entry(b"", b"Body only", &[]),
        entry(b"", b"", &[photo(1, 3, MAX_JOURNAL_PHOTO_BYTES)]),
        entry(b"", b"one\n\ntwo", &[]),
        entry(
            &[b'a'; MAX_JOURNAL_TITLE_BYTES],
            &vec![b'b'; MAX_JOURNAL_BODY_BYTES],
            &ten,
        ),
    ] {
        assert_eq!(bad(JOURNAL_ENTRY_CREATED, &good), Ok(()));
        assert_eq!(bad(JOURNAL_ENTRY_EDITED, &good), Ok(()));
    }
    let mut zero_id = entry(b"", b"x", &[]);
    zero_id[..16].fill(0);
    let mut reserved = entry(b"", b"x", &[]);
    reserved[23] = 1;
    let mut short = entry(b"", b"xy", &[]);
    short.pop();
    let mut long = entry(b"", b"x", &[]);
    long.push(b'y');
    let mut photo_reserved = photo(1, 1, 100);
    photo_reserved[2] = 1;
    let eleven: Vec<Vec<u8>> = (0..11).map(|n| photo(1 + n * 4, 1, 29)).collect();
    let mut zero_key = photo(1, 1, 100);
    zero_key[40..72].fill(0);
    for wrong in [
        zero_id,
        reserved,
        short,
        long,
        content(1, 20260230, b"", b"x", &[]),
        content(1, 0, b"", b"x", &[]),
        entry(b"", b"", &[]),
        entry(&[b'a'; MAX_JOURNAL_TITLE_BYTES + 1], b"", &[]),
        entry(b" Park", b"", &[]),
        entry(b"Park\n", b"", &[]),
        entry(b"Pa\tk", b"", &[]),
        entry(b"", b"a\tb", &[]),
        entry(b"", b"a\rb", &[]),
        entry(b"", b"x\n", &[]),
        entry(b"", &vec![b'b'; MAX_JOURNAL_BODY_BYTES + 1], &[]),
        entry(b"", &[0xff], &[]),
        entry(b"", b"x", &eleven),
        entry(b"", b"x", &[photo(1, 0, 100)]),
        entry(b"", b"x", &[photo(1, 4, 100)]),
        entry(b"", b"x", &[photo(1, 1, 28)]),
        entry(b"", b"x", &[photo(1, 1, MAX_JOURNAL_PHOTO_BYTES + 1)]),
        entry(b"", b"x", &[photo_reserved]),
        entry(b"", b"x", &[zero_key]),
        // The same blob named twice: one photo's thumbnail is another's photo.
        entry(b"", b"x", &[photo(1, 1, 100), photo(3, 1, 100)]),
    ] {
        assert_eq!(bad(JOURNAL_ENTRY_CREATED, &wrong), malformed);
    }
    for kind in [JOURNAL_ENTRY_DELETED, JOURNAL_ENTRY_RESTORED] {
        assert_eq!(bad(kind, &[1; 15]), malformed);
        assert_eq!(bad(kind, &[1; 17]), malformed);
        assert_eq!(bad(kind, &[0; 16]), malformed);
    }
    // The journal's reserved kinds this engine doesn't know yet.
    for code in [105, 109] {
        assert!(is_journal_code(code) && is_private_code(code));
        assert_eq!(bad(code, &[1; 16]), Err(KinError::UnsupportedVersion));
    }
    assert!(!is_journal_code(100) && !is_journal_code(110));
}

#[test]
fn journal_events_stay_in_the_private_log() {
    let entry = created(1, 1, 20261003, b"Mine");
    for mut log in [History::new(), History::chat(), History::board()] {
        assert_eq!(
            log.append(&batch(std::slice::from_ref(&entry))),
            Err(KinError::InvalidEvent)
        );
    }
    assert_eq!(
        crate::request::decode_request(&kine(std::slice::from_ref(&entry), 0, TEST_DATE, None))
            .map(|_| ()),
        Err(KinError::InvalidEvent)
    );
    let mut private = log_of(&[entry]);
    assert_eq!(private.len(), 1);
    // A household replay beside it is unchanged and holds no journal.
    let household = [item_record(1, 1, b"Milk", 2)];
    let mut log = History::new();
    log.append(&batch(&household)).unwrap();
    assert_eq!(
        log.replay(&context())
            .unwrap()
            .private()
            .journal()
            .live_count(),
        0
    );
    assert_eq!(
        private
            .replay(&context())
            .unwrap()
            .private()
            .journal()
            .live_count(),
        1
    );
}

// --- Replay ---------------------------------------------------------------

#[test]
fn replay_creates_edits_deletes_and_restores_entries() {
    let mut log = log_of(&[
        created(1, 1, 20261001, b"first"),
        // A second creation for the same ID is ignored: the first wins.
        created(2, 1, 20261002, b"again"),
        created(3, 2, 20261002, b"second"),
        edited(4, 1, 20261003, b"Moved", b"first, edited"),
        by_id(JOURNAL_ENTRY_DELETED, 5, 2),
        // Events for an entry never created are ignored.
        edited(6, 9, 20261003, b"", b"nobody"),
        by_id(JOURNAL_ENTRY_RESTORED, 7, 9),
    ]);
    let replay = log.replay(&context()).unwrap();
    let journal = replay.private().journal();
    let first = journal.entry(&PrivateRecordId([1; 16])).unwrap();
    assert_eq!(first.content.title, "Moved");
    assert_eq!(first.content.body, "first, edited");
    assert_eq!(first.content.date.encoded(), 20261003);
    assert_eq!((first.created, first.updated), (1, 4));
    assert_eq!(first.device_id, DeviceId(DEVICE));
    assert!(journal.entry(&PrivateRecordId([2; 16])).unwrap().deleted);
    assert!(journal.entry(&PrivateRecordId([9; 16])).is_none());
    assert_eq!(journal.live_count(), 1);
    assert_eq!(
        journal.live_text_bytes(),
        "Moved".len() + "first, edited".len()
    );

    // An edit to a deleted entry changes it but keeps it deleted; a restore
    // brings it back with that content.
    let mut log = log_of(&[
        created(1, 2, 20261002, b"second"),
        by_id(JOURNAL_ENTRY_DELETED, 2, 2),
        edited(3, 2, 20261002, b"", b"rewritten"),
        // A second delete of a deleted entry changes nothing.
        by_id(JOURNAL_ENTRY_DELETED, 4, 2),
        by_id(JOURNAL_ENTRY_RESTORED, 5, 2),
    ]);
    let replay = log.replay(&context()).unwrap();
    let second = replay
        .private()
        .journal()
        .entry(&PrivateRecordId([2; 16]))
        .unwrap();
    assert!(!second.deleted);
    assert_eq!(second.content.body, "rewritten");
    assert_eq!(second.updated, 5);
}

#[test]
fn replay_order_decides_and_a_fresh_replay_matches_the_checkpoint() {
    // Stored out of replay order: the edit at logical time 3 is the latest.
    let records = [
        created(1, 1, 20261001, b"a"),
        record_at(
            JOURNAL_ENTRY_EDITED,
            2,
            3,
            SAM,
            &content(1, 20261001, b"", b"latest", &[]),
        ),
        record_at(
            JOURNAL_ENTRY_EDITED,
            3,
            2,
            SAM,
            &content(1, 20261001, b"", b"middle", &[]),
        ),
    ];
    let mut log = log_of(&records[..1]);
    let before = kprv(&mut log);
    log.append(&batch(&records[1..])).unwrap();
    let after = kprv(&mut log);
    assert_ne!(before, after);
    let mut fresh = log_of(&records);
    assert_eq!(kprv(&mut fresh), after);
    let replay = fresh.replay(&context()).unwrap();
    assert_eq!(
        replay
            .private()
            .journal()
            .entry(&PrivateRecordId([1; 16]))
            .unwrap()
            .content
            .body,
        "latest"
    );
    // Another member's journal event in the same log fails replay.
    let mut mixed = log_of(&[
        created(1, 1, 20261001, b"mine"),
        record_at(
            JOURNAL_ENTRY_CREATED,
            2,
            2,
            ALEX,
            &content(2, 20261001, b"", b"theirs", &[]),
        ),
    ]);
    assert_eq!(
        mixed.replay(&context()).map(|_| ()),
        Err(KinError::InvalidEvent)
    );
}

// --- KPRV -----------------------------------------------------------------

#[test]
fn kprv_lists_live_entries_newest_first_in_section_101() {
    // No journal section until the member writes an entry.
    let mut empty = History::private();
    let bytes = kprv(&mut empty);
    assert_eq!(u16_at(&bytes, 28), 1, "the notes section alone");
    assert_eq!(u16_at(&bytes, 32), SECTION_NOTES);
    assert!(find_journal_section(&bytes).is_none());
    // A deleted entry still keeps the (empty) section: there is a journal.
    let mut gone = log_of(&[
        created(1, 1, 20261001, b"x"),
        by_id(JOURNAL_ENTRY_DELETED, 2, 1),
    ]);
    assert_eq!(journal_section(&kprv(&mut gone)), &[0, 0, 0, 0]);

    let mut log = log_of(&[
        created(1, 1, 20261001, b"oldest day"),
        created(2, 2, 20261003, b"newest day, written first"),
        created(3, 3, 20261003, b"newest day, written later"),
        created(4, 4, 20261002, b"deleted"),
        by_id(JOURNAL_ENTRY_DELETED, 5, 4),
        record_at(
            JOURNAL_ENTRY_EDITED,
            6,
            6,
            SAM,
            &content(
                1,
                20261001,
                b"Park",
                b"oldest day",
                &[photo(0x21, 2, 4_000)],
            ),
        ),
    ]);
    let bytes = kprv(&mut log);
    assert_eq!(u32_at(&bytes, 24), 6, "every record counts");
    let section = journal_section(&bytes);
    // Date descending, then later-created first; the deleted entry is gone.
    assert_eq!(section_entries(section), vec![3, 2, 1]);
    // The oldest entry, last: its header and photo.
    let at = section.len() - (KPRV_ENTRY_HEADER_BYTES + 4 + 10 + JOURNAL_PHOTO_BYTES);
    assert_eq!(&section[at..at + 16], &[1; 16]);
    assert_eq!(&section[at + 16..at + 24], &1u64.to_le_bytes(), "created");
    assert_eq!(&section[at + 24..at + 32], &6u64.to_le_bytes(), "updated");
    assert_eq!(&section[at + 32..at + 48], &DEVICE);
    assert_eq!(u32_at(section, at + 48), 20261001);
    assert_eq!(u16_at(section, at + 52), 4);
    assert_eq!((section[at + 54], section[at + 55]), (1, 0));
    assert_eq!(u32_at(section, at + 56), 10);
    assert_eq!(&section[at + 60..at + 74], b"Parkoldest day");
    assert_eq!(&section[at + 74..], &photo(0x21, 2, 4_000)[..]);
}

// --- Commands -------------------------------------------------------------

#[test]
fn a_new_entry_command_makes_the_canonical_record() {
    let payload = content(
        0x5a,
        20261003,
        b"Park",
        b"Swings.",
        &[photo(0x21, 1, 52_000)],
    );
    let mut log = History::private();
    let event = run(
        &mut log,
        &command(JOURNAL_ENTRY_CREATED, 1, 1, SAM, &payload),
    )
    .unwrap();
    assert_eq!(event, record_at(JOURNAL_ENTRY_CREATED, 1, 1, SAM, &payload));
    assert!(log.is_empty(), "the log is not changed");
    // Once stored, edits, deletes and restores follow it.
    log.append(&batch(&[event])).unwrap();
    let edit = content(0x5a, 20261003, b"Park", b"Swings, then cocoa.", &[]);
    let event = run(&mut log, &command(JOURNAL_ENTRY_EDITED, 2, 2, SAM, &edit)).unwrap();
    log.append(&batch(&[event])).unwrap();
    let event = run(
        &mut log,
        &command(JOURNAL_ENTRY_DELETED, 3, 3, SAM, &[0x5a; 16]),
    )
    .unwrap();
    log.append(&batch(&[event])).unwrap();
    let event = run(
        &mut log,
        &command(JOURNAL_ENTRY_RESTORED, 4, 4, SAM, &[0x5a; 16]),
    )
    .unwrap();
    log.append(&batch(&[event])).unwrap();
    let replay = log.replay(&context()).unwrap();
    let entry = replay
        .private()
        .journal()
        .entry(&PrivateRecordId([0x5a; 16]))
        .unwrap();
    assert!(!entry.deleted);
    assert_eq!(entry.content.body, "Swings, then cocoa.");
}

#[test]
fn private_commands_follow_the_journal_rules() {
    let invalid = Err(KinError::InvalidEvent);
    let mut log = log_of(&[
        created(1, 1, 20261001, b"live"),
        created(2, 2, 20261001, b"gone"),
        by_id(JOURNAL_ENTRY_DELETED, 3, 2),
    ]);
    let try_run = |log: &mut History, kind: u16, payload: &[u8]| {
        run(log, &command(kind, 10, 10, SAM, payload)).map(|_| ())
    };
    // A new entry's ID must be unused, deleted or not.
    assert_eq!(
        try_run(
            &mut log,
            JOURNAL_ENTRY_CREATED,
            &content(1, 20261001, b"", b"x", &[])
        ),
        invalid
    );
    assert_eq!(
        try_run(
            &mut log,
            JOURNAL_ENTRY_CREATED,
            &content(2, 20261001, b"", b"x", &[])
        ),
        invalid
    );
    assert_eq!(
        try_run(
            &mut log,
            JOURNAL_ENTRY_CREATED,
            &content(3, 20261001, b"", b"x", &[])
        ),
        Ok(())
    );
    // An edit names a live entry and changes something.
    assert_eq!(
        try_run(
            &mut log,
            JOURNAL_ENTRY_EDITED,
            &content(1, 20261001, b"", b"live", &[])
        ),
        invalid
    );
    assert_eq!(
        try_run(
            &mut log,
            JOURNAL_ENTRY_EDITED,
            &content(2, 20261001, b"", b"x", &[])
        ),
        invalid
    );
    assert_eq!(
        try_run(
            &mut log,
            JOURNAL_ENTRY_EDITED,
            &content(9, 20261001, b"", b"x", &[])
        ),
        invalid
    );
    assert_eq!(
        try_run(
            &mut log,
            JOURNAL_ENTRY_EDITED,
            &content(1, 20261002, b"", b"live", &[])
        ),
        Ok(())
    );
    // A delete names a live entry; a restore a deleted one.
    assert_eq!(try_run(&mut log, JOURNAL_ENTRY_DELETED, &[2; 16]), invalid);
    assert_eq!(try_run(&mut log, JOURNAL_ENTRY_DELETED, &[9; 16]), invalid);
    assert_eq!(try_run(&mut log, JOURNAL_ENTRY_DELETED, &[1; 16]), Ok(()));
    assert_eq!(try_run(&mut log, JOURNAL_ENTRY_RESTORED, &[1; 16]), invalid);
    assert_eq!(try_run(&mut log, JOURNAL_ENTRY_RESTORED, &[2; 16]), Ok(()));
}

#[test]
fn private_commands_follow_the_log() {
    let invalid = Err(KinError::InvalidEvent);
    let new_entry = content(5, 20261001, b"", b"x", &[]);
    let mut log = log_of(&[created(1, 1, 20261001, b"live")]);
    // Strictly after every event held, and never reusing an event ID.
    assert_eq!(
        run(
            &mut log,
            &command(JOURNAL_ENTRY_CREATED, 9, 1, SAM, &new_entry)
        )
        .map(|_| ()),
        invalid
    );
    assert_eq!(
        run(
            &mut log,
            &command(JOURNAL_ENTRY_CREATED, 1, 9, SAM, &new_entry)
        )
        .map(|_| ()),
        invalid
    );
    // Only the log's own member.
    assert_eq!(
        run(
            &mut log,
            &command(JOURNAL_ENTRY_CREATED, 9, 9, ALEX, &new_entry)
        )
        .map(|_| ()),
        invalid
    );
    // Nothing outside the private range, nor a journal kind not defined yet.
    assert_eq!(
        run(&mut log, &command(1, 9, 9, SAM, b"x")).map(|_| ()),
        Err(KinError::UnsupportedVersion)
    );
    assert_eq!(
        run(&mut log, &command(105, 9, 9, SAM, &[1; 16])).map(|_| ()),
        Err(KinError::UnsupportedVersion)
    );
    // A malformed payload or header.
    assert_eq!(
        run(
            &mut log,
            &command(
                JOURNAL_ENTRY_CREATED,
                9,
                9,
                SAM,
                &content(5, 20261001, b"", b"", &[])
            )
        )
        .map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
    let mut framed = command(JOURNAL_ENTRY_CREATED, 9, 9, SAM, &new_entry);
    framed[4 + 100] = 1;
    assert_eq!(
        run(&mut log, &framed).map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
    // Another household's event, or a target household that isn't this one.
    let mut other = command(JOURNAL_ENTRY_CREATED, 9, 9, SAM, &new_entry);
    other[4 + 28..4 + 44].fill(0xbb);
    assert_eq!(run(&mut log, &other).map(|_| ()), invalid);
    // Only against the private log.
    for mut wrong in [History::new(), History::board()] {
        assert_eq!(
            run(
                &mut wrong,
                &command(JOURNAL_ENTRY_CREATED, 9, 9, SAM, &new_entry)
            )
            .map(|_| ()),
            invalid
        );
    }
    assert_eq!(
        run(
            &mut log,
            &command(JOURNAL_ENTRY_CREATED, 9, 9, SAM, &new_entry)
        )
        .map(|_| ()),
        Ok(())
    );
}

#[test]
fn live_entries_are_bounded() {
    let mut records: Vec<Vec<u8>> = (1..=MAX_JOURNAL_ENTRIES as u32)
        .map(|event| {
            let mut payload = content(1, 20261001, b"", b"x", &[]);
            payload[..4].copy_from_slice(&event.to_le_bytes());
            record_at(
                JOURNAL_ENTRY_CREATED,
                event,
                u64::from(event),
                SAM,
                &payload,
            )
        })
        .collect();
    let mut log = log_of(&records);
    let next = MAX_JOURNAL_ENTRIES as u32 + 1;
    let fresh = content(0xee, 20261001, b"", b"x", &[]);
    assert_eq!(
        run(
            &mut log,
            &command(JOURNAL_ENTRY_CREATED, next, u64::from(next), SAM, &fresh)
        )
        .map(|_| ()),
        Err(KinError::SizeLimit)
    );
    // Deleting one makes room, and restoring it would not fit again.
    let mut first = [0u8; 16];
    first[..4].copy_from_slice(&1u32.to_le_bytes());
    first[4..].fill(1);
    records.push(record_at(
        JOURNAL_ENTRY_DELETED,
        next,
        u64::from(next),
        SAM,
        &first,
    ));
    let mut log = log_of(&records);
    let after = next + 1;
    let event = run(
        &mut log,
        &command(JOURNAL_ENTRY_CREATED, after, u64::from(after), SAM, &fresh),
    )
    .unwrap();
    log.append(&batch(&[event])).unwrap();
    assert_eq!(
        run(
            &mut log,
            &command(
                JOURNAL_ENTRY_RESTORED,
                after + 1,
                u64::from(after + 1),
                SAM,
                &first
            )
        )
        .map(|_| ()),
        Err(KinError::SizeLimit)
    );
}

#[test]
fn live_text_is_bounded() {
    let body = vec![b'b'; MAX_JOURNAL_BODY_BYTES];
    let full = MAX_JOURNAL_TEXT_BYTES / MAX_JOURNAL_BODY_BYTES;
    let records: Vec<Vec<u8>> = (1..=full as u32)
        .map(|event| {
            let mut payload = content(1, 20261001, b"", &body, &[]);
            payload[..4].copy_from_slice(&event.to_le_bytes());
            record_at(
                JOURNAL_ENTRY_CREATED,
                event,
                u64::from(event),
                SAM,
                &payload,
            )
        })
        .collect();
    let mut log = log_of(&records);
    let next = full as u32 + 1;
    assert_eq!(
        run(
            &mut log,
            &command(
                JOURNAL_ENTRY_CREATED,
                next,
                u64::from(next),
                SAM,
                &content(0xee, 20261001, b"", &body, &[])
            )
        )
        .map(|_| ()),
        Err(KinError::SizeLimit)
    );
    // Something short still fits.
    assert_eq!(
        run(
            &mut log,
            &command(
                JOURNAL_ENTRY_CREATED,
                next,
                u64::from(next),
                SAM,
                &content(0xee, 20261001, b"", b"short", &[])
            )
        )
        .map(|_| ()),
        Ok(())
    );
}
