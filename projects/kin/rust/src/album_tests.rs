// The family album (#673, ADR 0022 §5): kinds 75–76 — canonical payloads,
// replay, command rules, KCMD and KALB. The byte vectors here are
// TEST-VECTORS 175–179.
use crate::album::*;
use crate::codec::encode_event;
use crate::command::{decode_command, execute, CommandContext, HouseholdCommand as C};
use crate::core::album;
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::recurrence::CivilDate;
use crate::request::DecodedRequest;
use crate::state::{rebuild, HouseholdState};
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const SAM: [u8; 16] = [1; 16];
const ALEX: [u8; 16] = [2; 16];
const AS_OF: i64 = 1_791_475_200_100;
const BASE_TIME: i64 = 1_791_475_200_000;

fn date(value: u32) -> CivilDate {
    CivilDate::from_encoded(value).unwrap()
}

/// An album attachment ID: the prefix `a1 b0`, then `n` (little-endian).
fn attachment(n: u32) -> [u8; 16] {
    let mut id = [0; 16];
    id[..2].copy_from_slice(&ALBUM_ATTACHMENT_PREFIX);
    id[2..6].copy_from_slice(&n.to_le_bytes());
    id
}

fn photo(n: u32) -> [u8; 16] {
    numbered_id(n)
}

fn added(photo_n: u32, attachment_n: u32, caption: &str) -> EventKind {
    EventKind::AlbumPhotoAdded {
        photo_id: photo(photo_n),
        attachment_id: attachment(attachment_n),
        caption: caption.into(),
    }
}

fn removed(photo_n: u32) -> EventKind {
    EventKind::AlbumPhotoRemoved {
        photo_id: photo(photo_n),
    }
}

fn context(event: u32, logical_time: u64, actor: [u8; 16]) -> CommandContext {
    CommandContext {
        event_id: EventId(numbered_id(event)),
        household_id: HouseholdId(HOUSEHOLD),
        actor_id: ActorId(actor),
        device_id: DeviceId([actor[0] | 0x10; 16]),
        timestamp: BASE_TIME + i64::from(event),
        logical_time,
    }
}

fn request(events: &[EventEnvelope]) -> DecodedRequest {
    DecodedRequest {
        events: events.to_vec(),
        as_of: AS_OF,
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

    fn run_as(&mut self, actor: [u8; 16], kind: EventKind) -> Result<(), KinError> {
        let n = self.next;
        let result = execute(
            &C::Album(kind),
            context(1000 + n, u64::from(n), actor),
            request(&self.events),
        )?;
        let bytes = encode_event(&result.event).unwrap();
        assert_eq!(decode_event(&bytes).unwrap(), result.event);
        self.events.push(result.event);
        self.next += 1;
        Ok(())
    }

    fn run(&mut self, kind: EventKind) -> Result<(), KinError> {
        self.run_as(SAM, kind)
    }

    fn state(&self) -> HouseholdState {
        rebuild(&self.events, AS_OF, date(TEST_DATE)).unwrap()
    }

    fn live(&self) -> Vec<[u8; 16]> {
        self.state()
            .album
            .photos
            .iter()
            .map(|entry| entry.photo_id)
            .collect()
    }
}

/// The bytes of a kind-75 payload, written out by hand.
fn added_bytes(photo_n: u32, attachment_n: u32, caption: &str) -> Vec<u8> {
    let mut out = photo(photo_n).to_vec();
    out.extend_from_slice(&attachment(attachment_n));
    out.extend_from_slice(&(caption.len() as u16).to_le_bytes());
    out.extend_from_slice(caption.as_bytes());
    out
}

// 175
#[test]
fn album_payloads_are_canonical() {
    let kind = added(1, 1, "Grandma's 80th");
    let bytes = added_bytes(1, 1, "Grandma's 80th");
    assert_eq!(&bytes[16..22], &[0xa1, 0xb0, 1, 0, 0, 0]);
    assert_eq!(bytes.len(), 16 + 16 + 2 + 14);
    assert_eq!(encode_payload(&kind).unwrap(), bytes);
    assert_eq!(decode_payload(ALBUM_PHOTO_ADDED, &bytes).unwrap(), kind);
    let bare = added_bytes(2, 2, "");
    assert_eq!(bare.len(), 34);
    assert_eq!(
        decode_payload(ALBUM_PHOTO_ADDED, &bare).unwrap(),
        added(2, 2, "")
    );
    let longest = "é".repeat(100);
    assert_eq!(longest.len(), 200);
    assert!(encode_payload(&added(3, 3, &longest)).is_ok(), "200 bytes");
    assert_eq!(
        decode_payload(ALBUM_PHOTO_REMOVED, &photo(1)).unwrap(),
        removed(1)
    );
    assert_eq!(encode_payload(&removed(1)).unwrap(), photo(1).to_vec());

    let malformed = |code: u16, bytes: &[u8], why: &str| {
        assert_eq!(
            decode_payload(code, bytes),
            Err(KinError::MalformedProtocol),
            "{why}"
        );
    };
    for caption in [
        " Hi",
        "Hi ",
        "\nHi",
        "a\nb",
        "a\tb",
        "a\u{7}b",
        " ",
        &"x".repeat(201),
    ] {
        malformed(ALBUM_PHOTO_ADDED, &added_bytes(1, 1, caption), caption);
    }
    let mut zero_photo = bytes.clone();
    zero_photo[..16].fill(0);
    malformed(ALBUM_PHOTO_ADDED, &zero_photo, "a zero photo ID");
    let mut other_attachment = bytes.clone();
    other_attachment[16] = 0xa2;
    malformed(ALBUM_PHOTO_ADDED, &other_attachment, "no album prefix");
    let mut bare_prefix = bytes.clone();
    bare_prefix[18..32].fill(0);
    malformed(ALBUM_PHOTO_ADDED, &bare_prefix, "the prefix alone");
    malformed(
        ALBUM_PHOTO_ADDED,
        &bytes[..bytes.len() - 1],
        "a short caption",
    );
    malformed(
        ALBUM_PHOTO_ADDED,
        &[bytes.clone(), vec![0]].concat(),
        "a trailing byte",
    );
    malformed(ALBUM_PHOTO_ADDED, &bytes[..33], "no caption length");
    let mut invalid = added_bytes(1, 1, "ab");
    invalid[34] = 0xff;
    malformed(ALBUM_PHOTO_ADDED, &invalid, "invalid UTF-8");
    malformed(ALBUM_PHOTO_REMOVED, &[0; 16], "a zero photo ID");
    malformed(ALBUM_PHOTO_REMOVED, &photo(1)[..15], "15 bytes");
    malformed(
        ALBUM_PHOTO_REMOVED,
        &[photo(1).to_vec(), vec![0]].concat(),
        "17 bytes",
    );
    malformed(74, &bytes, "another kind");
    assert_eq!(
        encode_payload(&added(1, 1, " Hi")),
        Err(KinError::MalformedProtocol)
    );
}

#[test]
fn album_records_round_trip_through_the_envelope() {
    let mut home = Household::new();
    home.run(added(1, 1, "Beach")).unwrap();
    home.run(removed(1)).unwrap();
    for event in &home.events {
        let bytes = encode_event(event).unwrap();
        assert_eq!(&bytes[..2], &1u16.to_le_bytes(), "schema 1");
        let decoded = decode_event(&bytes).unwrap();
        assert_eq!(decoded, *event);
        assert_eq!(encode_event(&decoded).unwrap(), bytes);
    }
    let bytes = encode_event(&home.events[0]).unwrap();
    assert_eq!(&bytes[2..4], &75u16.to_le_bytes());
    let bytes = encode_event(&home.events[1]).unwrap();
    assert_eq!(&bytes[2..4], &76u16.to_le_bytes());
    assert!(!home.events[0].kind.is_chat() && !home.events[0].kind.is_board());
    assert!(!home.events[0].kind.is_private());
}

// 176
#[test]
fn album_command_rules() {
    let mut home = Household::new();
    home.run(added(1, 1, "Beach")).unwrap();
    home.run_as(ALEX, added(2, 2, "")).unwrap();
    // The same photo ID, or an attachment a live photo uses, is refused.
    assert_eq!(home.run(added(1, 3, "")), Err(KinError::InvalidEvent));
    assert_eq!(home.run(added(3, 1, "")), Err(KinError::InvalidEvent));
    // Malformed captions never reach the album.
    assert_eq!(
        home.run(added(3, 3, " x")),
        Err(KinError::MalformedProtocol)
    );
    // Removing an unknown photo, or one already removed, is refused.
    assert_eq!(home.run(removed(9)), Err(KinError::InvalidEvent));
    home.run_as(ALEX, removed(1)).unwrap();
    assert_eq!(home.run(removed(1)), Err(KinError::InvalidEvent));
    // A removed photo's ID can't come back; its attachment can, under a new
    // photo ID (Undo).
    assert_eq!(home.run(added(1, 1, "Beach")), Err(KinError::InvalidEvent));
    home.run(added(4, 1, "Beach")).unwrap();
    assert_eq!(home.live(), vec![photo(2), photo(4)]);
    let state = home.state();
    let entry = state.album.photo(&photo(4)).unwrap();
    assert_eq!(entry.attachment_id, attachment(1));
    assert_eq!(entry.caption, "Beach");
    assert_eq!(entry.added_by, ActorId(SAM));
    let alex = state.album.photo(&photo(2)).unwrap();
    assert_eq!(alex.added_by, ActorId(ALEX));
    assert_eq!(alex.added_at, BASE_TIME + 1002);
    assert_eq!(state.album.removed.len(), 1);
    assert_eq!(state.album.removed[0].photo_id, photo(1));
    assert_eq!(state.album.removed[0].removed_at, BASE_TIME + 1003);
}

// 177
#[test]
fn the_album_holds_at_most_500_photos() {
    let mut home = Household::new();
    for n in 1..=MAX_ALBUM_PHOTOS as u32 {
        home.run(added(n, n, "")).unwrap();
    }
    assert_eq!(home.state().album.photos.len(), 500);
    assert_eq!(home.run(added(501, 501, "")), Err(KinError::InvalidEvent));
    home.run(removed(7)).unwrap();
    home.run(added(501, 501, "")).unwrap();
    assert_eq!(home.state().album.photos.len(), 500);

    // A 501st photo in history (two devices adding at once) fails replay.
    let base = home.events.clone();
    let one = execute(
        &C::Album(removed(8)),
        context(5000, 900, SAM),
        request(&base),
    )
    .unwrap()
    .event;
    let mut full = base.clone();
    full.push(one);
    let mine = execute(
        &C::Album(added(600, 600, "")),
        context(5001, 901, SAM),
        request(&full),
    )
    .unwrap()
    .event;
    let theirs = execute(
        &C::Album(added(601, 601, "")),
        context(5002, 902, ALEX),
        request(&full),
    )
    .unwrap()
    .event;
    let events = [full, vec![mine, theirs]].concat();
    assert_eq!(
        rebuild(&events, AS_OF, date(TEST_DATE)).map(|_| ()),
        Err(KinError::InvalidEvent)
    );
}

// 178
#[test]
fn replay_tolerates_a_second_removal_and_remembers_64() {
    let mut home = Household::new();
    home.run(added(1, 1, "")).unwrap();
    let base = home.events.clone();
    let mine = execute(&C::Album(removed(1)), context(80, 20, SAM), request(&base))
        .unwrap()
        .event;
    let theirs = execute(&C::Album(removed(1)), context(81, 21, ALEX), request(&base))
        .unwrap()
        .event;
    let events = [base, vec![mine, theirs]].concat();
    let state = rebuild(&events, AS_OF, date(TEST_DATE)).unwrap();
    assert!(state.album.photos.is_empty());
    assert_eq!(state.album.removed.len(), 1, "removed once");

    // A removal of a photo the album never had fails replay.
    let mut stray = home.events.clone();
    let mut other = Household::new();
    other.run(added(9, 9, "")).unwrap();
    other.run(removed(9)).unwrap();
    let mut removal = other.events[1].clone();
    removal.logical_time = 50;
    removal.event_id = EventId(numbered_id(77));
    stray.push(removal);
    assert_eq!(
        rebuild(&stray, AS_OF, date(TEST_DATE)).map(|_| ()),
        Err(KinError::InvalidEvent)
    );

    // Only the newest 64 removals are kept.
    let mut busy = Household::new();
    for n in 1..=70u32 {
        busy.run(added(n, n, "")).unwrap();
        busy.run(removed(n)).unwrap();
    }
    let state = busy.state();
    assert_eq!(state.album.removed.len(), ALBUM_RECENT_REMOVALS);
    assert_eq!(state.album.removed.front().unwrap().photo_id, photo(7));
    assert_eq!(state.album.removed.back().unwrap().photo_id, photo(70));
}

#[test]
fn replay_refuses_zero_actors_and_devices() {
    let mut home = Household::new();
    home.run(added(1, 1, "")).unwrap();
    for field in ["actor", "device"] {
        let mut event = home.events[0].clone();
        if field == "actor" {
            event.actor_id = ActorId([0; 16]);
        } else {
            event.device_id = DeviceId([0; 16]);
        }
        assert_eq!(
            rebuild(&[event], AS_OF, date(TEST_DATE)).map(|_| ()),
            Err(KinError::InvalidEvent),
            "{field}"
        );
    }
}

fn kcmd(kind: u16, payload: &[u8]) -> Vec<u8> {
    let mut packet = vec![0u8; 128];
    packet[..4].copy_from_slice(b"KCMD");
    packet[4] = 1;
    packet[8..10].copy_from_slice(&kind.to_le_bytes());
    packet[12..28].copy_from_slice(&numbered_id(500));
    packet[28..44].copy_from_slice(&HOUSEHOLD);
    packet[44..60].copy_from_slice(&SAM);
    packet[60..76].copy_from_slice(&[0x11; 16]);
    packet[76..84].copy_from_slice(&BASE_TIME.to_le_bytes());
    packet[84..92].copy_from_slice(&1u64.to_le_bytes());
    packet[124..128].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    packet.extend_from_slice(payload);
    packet
}

// 179 (KCMD)
#[test]
fn kcmd_carries_album_payloads_exactly() {
    let kind = added(1, 1, "Beach");
    let packet = kcmd(ALBUM_PHOTO_ADDED, &encode_payload(&kind).unwrap());
    assert_eq!(decode_command(&packet).unwrap().0, C::Album(kind));
    let packet = kcmd(ALBUM_PHOTO_REMOVED, &photo(1));
    assert_eq!(decode_command(&packet).unwrap().0, C::Album(removed(1)));
    for (offset, why) in [
        (92, "entity"),
        (108, "date"),
        (112, "option"),
        (116, "expiry"),
    ] {
        let mut bad = packet.clone();
        bad[offset] = 1;
        assert!(decode_command(&bad).is_err(), "the {why} field stays zero");
    }
    assert_eq!(
        decode_command(&kcmd(ALBUM_PHOTO_ADDED, &added_bytes(1, 1, " Beach"))).map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
    assert!(
        decode_command(&kcmd(ALBUM_PHOTO_REMOVED, &[])).is_err(),
        "an empty payload"
    );
}

// 179 (KALB)
#[test]
fn kin_album_speaks_kalb() {
    let mut home = Household::new();
    home.run(added(1, 1, "Beach")).unwrap();
    home.run_as(ALEX, added(2, 2, "")).unwrap();
    home.run(added(3, 3, "Zoo")).unwrap();
    home.run_as(ALEX, removed(1)).unwrap();
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
    let context = kine(&[], AS_OF, TEST_DATE, None);
    let out = album(&context, &mut history).unwrap();

    let mut expected = b"KALB\x01\x00\x00\x00".to_vec();
    expected.extend_from_slice(&2u32.to_le_bytes());
    expected.extend_from_slice(&1u32.to_le_bytes());
    for (n, actor, event, caption) in [(3u32, SAM, 1003i64, "Zoo"), (2, ALEX, 1002, "")] {
        expected.extend_from_slice(&photo(n));
        expected.extend_from_slice(&attachment(n));
        expected.extend_from_slice(&actor);
        expected.extend_from_slice(&(BASE_TIME + event).to_le_bytes());
        expected.extend_from_slice(&(caption.len() as u16).to_le_bytes());
        expected.extend_from_slice(caption.as_bytes());
    }
    expected.extend_from_slice(&photo(1));
    expected.extend_from_slice(&attachment(1));
    expected.extend_from_slice(&(BASE_TIME + 1004).to_le_bytes());
    assert_eq!(out, expected, "newest first, then the removal");

    let empty = album(&context, &mut History::default()).unwrap();
    assert_eq!(
        empty,
        b"KALB\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
    );
}
