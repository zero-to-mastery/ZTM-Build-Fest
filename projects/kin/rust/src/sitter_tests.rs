// The sitter page (#442, ADR 0017): kind 70 — canonical payload, replay,
// command rules, KCMD and KSIT. The byte vectors here are TEST-VECTORS
// 060–064.
use crate::codec::encode_event;
use crate::command::{decode_command, execute, CommandContext, HouseholdCommand as C};
use crate::core::sitter_page;
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::recurrence::{Cadence, CivilDate};
use crate::request::DecodedRequest;
use crate::sitter::*;
use crate::state::{rebuild, HouseholdState};
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const ADULT: [u8; 16] = [1; 16];
const AS_OF: i64 = 1_791_475_200_100;

use SitterEntryKind::{Note, ReferenceRecord, Routine};

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
        as_of: AS_OF,
        summary_cursor: None,
        civil_date: date(TEST_DATE),
        target_household_id: None,
        identity_bindings: vec![],
    }
}

fn entry(kind: SitterEntryKind, n: u32) -> SitterEntry {
    SitterEntry {
        kind,
        id: numbered_id(n),
    }
}

fn page(intro: &str, entries: &[SitterEntry]) -> EventKind {
    EventKind::SitterPageSet {
        intro: intro.into(),
        entries: entries.to_vec(),
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

    fn set(&mut self, intro: &str, entries: &[SitterEntry]) -> Result<(), KinError> {
        self.run(C::SitterPage(page(intro, entries)))
    }

    fn note(&mut self, n: u32, title: &str) {
        self.run(C::CreateNote {
            id: NoteId(numbered_id(n)),
            title: title.into(),
            body: "Body".into(),
            area_id: None,
        })
        .unwrap();
    }

    fn record(&mut self, n: u32, title: &str) {
        self.run(C::SaveReferenceRecord {
            id: ReferenceRecordId(numbered_id(n)),
            title: title.into(),
            area_id: None,
            fields: vec![(
                ReferenceFieldId(numbered_id(900 + n)),
                "Phone".into(),
                "+1 555 0100".into(),
            )],
        })
        .unwrap();
    }

    fn routine(&mut self, n: u32, text: &str) {
        self.run(C::CreateRoutine {
            id: RoutineId(numbered_id(n)),
            text: text.into(),
            cadence: Cadence::Daily,
            created_on: date(TEST_DATE),
        })
        .unwrap();
    }

    fn state(&self) -> HouseholdState {
        rebuild(&self.events, AS_OF, date(TEST_DATE)).unwrap()
    }

    fn shown(&self) -> Vec<SitterEntry> {
        let state = self.state();
        let shown = state
            .sitter_page
            .resolved(state.sitter_records())
            .copied()
            .collect();
        shown
    }
}

/// A household with note 1, reference record 2 and routine 3.
fn furnished() -> Household {
    let mut home = Household::new();
    home.note(1, "Bedtime");
    home.record(2, "Grandma");
    home.routine(3, "Feed the cat");
    home
}

/// The bytes of a kind-70 payload, written out by hand.
fn page_bytes(entries: &[(u8, u32)], intro: &str) -> Vec<u8> {
    let mut out = (entries.len() as u16).to_le_bytes().to_vec();
    out.extend_from_slice(&[0, 0]);
    for (kind, id) in entries {
        out.extend_from_slice(&[*kind, 0, 0, 0]);
        out.extend_from_slice(&numbered_id(*id));
    }
    out.extend_from_slice(&(intro.len() as u16).to_le_bytes());
    out.extend_from_slice(intro.as_bytes());
    out
}

// 060
#[test]
fn the_page_payload_is_canonical() {
    let kind = page(
        "Bed by 8.\nThanks!",
        &[entry(Note, 1), entry(ReferenceRecord, 2), entry(Routine, 3)],
    );
    let bytes = page_bytes(&[(1, 1), (2, 2), (3, 3)], "Bed by 8.\nThanks!");
    assert_eq!(encode_payload(&kind).unwrap(), bytes);
    assert_eq!(decode_payload(SITTER_PAGE_SET, &bytes).unwrap(), kind);
    assert_eq!(&bytes[..8], &[3, 0, 0, 0, 1, 0, 0, 0]);
    assert_eq!(bytes.len(), 4 + 3 * 20 + 2 + 17);
    let empty = page("", &[]);
    assert_eq!(encode_payload(&empty).unwrap(), vec![0; 6]);
    assert_eq!(decode_payload(SITTER_PAGE_SET, &[0; 6]).unwrap(), empty);
    let full: Vec<SitterEntry> = (1..=30).map(|n| entry(Note, n)).collect();
    assert!(encode_payload(&page("", &full)).is_ok(), "30 entries");
    let longest = "é".repeat(250);
    assert_eq!(longest.len(), 500);
    assert!(encode_payload(&page(&longest, &[])).is_ok(), "500 bytes");
    // The same ID under two kinds is two entries.
    assert!(encode_payload(&page("", &[entry(Note, 1), entry(Routine, 1)])).is_ok());

    let malformed = |bytes: &[u8], why: &str| {
        assert_eq!(
            decode_payload(SITTER_PAGE_SET, bytes),
            Err(KinError::MalformedProtocol),
            "{why}"
        );
    };
    let mut reserved = bytes.clone();
    reserved[2] = 1;
    malformed(&reserved, "reserved count bytes");
    let mut entry_reserved = bytes.clone();
    entry_reserved[5] = 1;
    malformed(&entry_reserved, "reserved entry bytes");
    for code in [0u8, 4, 0xff] {
        let mut unknown = bytes.clone();
        unknown[4] = code;
        malformed(&unknown, "unknown entry kind");
    }
    let mut extra = bytes.clone();
    extra.push(0);
    malformed(&extra, "trailing bytes");
    malformed(&bytes[..bytes.len() - 1], "truncated");
    malformed(&[0; 5], "no intro length");
    let mut short_count = bytes.clone();
    short_count[0] = 2;
    malformed(&short_count, "count says two, three follow");
    let many: Vec<(u8, u32)> = (1..=31).map(|n| (1, n)).collect();
    malformed(&page_bytes(&many, ""), "31 entries");
    malformed(&page_bytes(&[(1, 1), (1, 1)], ""), "the same entry twice");
    malformed(&page_bytes(&[(1, 0)], ""), "zero ID");
    for bad in [
        " Hi",
        "Hi ",
        "\nHi",
        "Hi\n",
        " ",
        "a\u{7}b",
        "a\r\nb",
        "a\tb",
        &"x".repeat(501),
    ] {
        malformed(&page_bytes(&[], bad), "intro not canonical");
        assert_eq!(
            encode_payload(&page(bad, &[])),
            Err(KinError::MalformedProtocol),
            "{bad:?}"
        );
    }
    let mut invalid_utf8 = page_bytes(&[], "ab");
    invalid_utf8[7] = 0xff;
    malformed(&invalid_utf8, "invalid UTF-8");
    assert_eq!(
        decode_payload(66, &bytes),
        Err(KinError::MalformedProtocol),
        "not the sitter kind"
    );
    assert_eq!(
        normalize_sitter_intro("  Hi\nthere \u{3000}").unwrap(),
        "Hi\nthere"
    );
}

// 061
#[test]
fn the_page_needs_live_records_and_a_change() {
    let mut home = furnished();
    assert_eq!(home.set("", &[]), Err(KinError::InvalidEvent), "no change");
    for missing in [entry(Note, 9), entry(ReferenceRecord, 9), entry(Routine, 9)] {
        assert_eq!(
            home.set("", &[missing]),
            Err(KinError::InvalidEvent),
            "{missing:?} does not exist"
        );
    }
    // The ID exists, but as another kind of record.
    assert_eq!(
        home.set("", &[entry(Routine, 1)]),
        Err(KinError::InvalidEvent),
        "note 1 is not a routine"
    );
    home.set(
        "Bed by 8.",
        &[entry(Note, 1), entry(ReferenceRecord, 2), entry(Routine, 3)],
    )
    .unwrap();
    assert_eq!(
        home.set(
            "Bed by 8.",
            &[entry(Note, 1), entry(ReferenceRecord, 2), entry(Routine, 3)]
        ),
        Err(KinError::InvalidEvent),
        "the same page"
    );
    assert_eq!(
        home.set("Bed by 8.", &[entry(Note, 1), entry(Note, 1)]),
        Err(KinError::MalformedProtocol),
        "an entry twice"
    );
    assert_eq!(
        home.set(" Bed by 8.", &[]),
        Err(KinError::MalformedProtocol),
        "the intro arrives trimmed"
    );
    let many: Vec<SitterEntry> = (1..=31).map(|n| entry(Note, n)).collect();
    assert_eq!(home.set("", &many), Err(KinError::MalformedProtocol));

    // Replace semantics: reordering, a new intro, dropping an entry.
    home.set(
        "Bed by 8.",
        &[entry(Routine, 3), entry(Note, 1), entry(ReferenceRecord, 2)],
    )
    .unwrap();
    home.set("Bed by 8:30.", &[entry(Routine, 3)]).unwrap();
    let state = home.state();
    assert_eq!(state.sitter_page.intro, "Bed by 8:30.");
    assert_eq!(state.sitter_page.entries, vec![entry(Routine, 3)]);

    // An archived record can't be added.
    home.run(C::ArchiveNote(NoteId(numbered_id(1)))).unwrap();
    assert_eq!(
        home.set("Bed by 8:30.", &[entry(Routine, 3), entry(Note, 1)]),
        Err(KinError::InvalidEvent),
        "archived note"
    );
    home.run(C::ArchiveReferenceRecord(ReferenceRecordId(numbered_id(2))))
        .unwrap();
    assert_eq!(
        home.set("", &[entry(ReferenceRecord, 2)]),
        Err(KinError::InvalidEvent),
        "archived reference record"
    );
    // Clearing the page is a change.
    home.set("", &[]).unwrap();
    assert_eq!(*home.state().sitter_page, SitterPageState::default());
}

// 062
#[test]
fn replay_skips_archived_and_unknown_entries() {
    let mut home = furnished();
    home.note(4, "Wi-Fi");
    home.set(
        "Hi!",
        &[
            entry(Note, 4),
            entry(Routine, 3),
            entry(Note, 1),
            entry(ReferenceRecord, 2),
        ],
    )
    .unwrap();
    home.run(C::ArchiveNote(NoteId(numbered_id(1)))).unwrap();
    home.run(C::ArchiveRoutine(RoutineId(numbered_id(3))))
        .unwrap();
    assert_eq!(
        home.shown(),
        vec![entry(Note, 4), entry(ReferenceRecord, 2)],
        "archived note 1 and routine 3 are skipped, the order kept"
    );
    // The event keeps them.
    assert_eq!(home.state().sitter_page.entries.len(), 4);

    // A page from another device naming records this history lacks replays,
    // and shows them once they arrive.
    let mut events = home.events.clone();
    let mut stray = events.last().unwrap().clone();
    stray.kind = page("", &[entry(Note, 50), entry(Note, 4)]);
    stray.event_id = EventId(numbered_id(60));
    stray.logical_time = 50;
    events.push(stray.clone());
    let state = rebuild(&events, AS_OF, date(TEST_DATE)).unwrap();
    let shown: Vec<SitterEntry> = state
        .sitter_page
        .resolved(state.sitter_records())
        .copied()
        .collect();
    assert_eq!(shown, vec![entry(Note, 4)]);

    let mut late = stray;
    late.kind = EventKind::NoteCreated {
        note_id: NoteId(numbered_id(50)),
        title: "Allergies".into(),
        body: "Peanuts".into(),
        area_id: None,
    };
    late.event_id = EventId(numbered_id(61));
    late.logical_time = 51;
    events.push(late);
    let state = rebuild(&events, AS_OF, date(TEST_DATE)).unwrap();
    let shown: Vec<SitterEntry> = state
        .sitter_page
        .resolved(state.sitter_records())
        .copied()
        .collect();
    assert_eq!(shown, vec![entry(Note, 50), entry(Note, 4)]);
}

#[test]
fn the_latest_page_in_replay_order_wins() {
    let mut home = furnished();
    home.set("First", &[entry(Note, 1)]).unwrap();
    let base = home.events.clone();
    let first = execute(
        &C::SitterPage(page("Mine", &[entry(Routine, 3)])),
        context(70, 20),
        request(&base),
    )
    .unwrap()
    .event;
    let second = execute(
        &C::SitterPage(page("Theirs", &[entry(ReferenceRecord, 2)])),
        context(71, 21),
        request(&base),
    )
    .unwrap()
    .event;
    let events = [base, vec![first, second]].concat();
    let state = rebuild(&events, AS_OF, date(TEST_DATE)).unwrap();
    assert_eq!(state.sitter_page.intro, "Theirs");
    assert_eq!(state.sitter_page.entries, vec![entry(ReferenceRecord, 2)]);
}

fn kcmd(payload: &[u8]) -> Vec<u8> {
    let mut packet = vec![0u8; 128];
    packet[..4].copy_from_slice(b"KCMD");
    packet[4] = 1;
    packet[8..10].copy_from_slice(&SITTER_PAGE_SET.to_le_bytes());
    packet[12..28].copy_from_slice(&numbered_id(500));
    packet[28..44].copy_from_slice(&HOUSEHOLD);
    packet[44..60].copy_from_slice(&ADULT);
    packet[60..76].copy_from_slice(&[0x11; 16]);
    packet[76..84].copy_from_slice(&1_791_475_200_000i64.to_le_bytes());
    packet[84..92].copy_from_slice(&1u64.to_le_bytes());
    packet[124..128].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    packet.extend_from_slice(payload);
    packet
}

// 063
#[test]
fn kcmd_carries_the_page_payload_exactly() {
    let kind = page("Hi", &[entry(Note, 1), entry(Routine, 3)]);
    let packet = kcmd(&encode_payload(&kind).unwrap());
    assert_eq!(decode_command(&packet).unwrap().0, C::SitterPage(kind));
    let full: Vec<SitterEntry> = (1..=30).map(|n| entry(Routine, n)).collect();
    let packet = kcmd(&encode_payload(&page(&"x".repeat(500), &full)).unwrap());
    assert!(decode_command(&packet).is_ok(), "the largest page fits");
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
    let mut untrimmed = kcmd(&page_bytes(&[], " Hi"));
    assert_eq!(
        decode_command(&untrimmed).map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
    untrimmed.truncate(128);
    assert!(decode_command(&untrimmed).is_err(), "an empty payload");
}

// 064
#[test]
fn kin_sitter_page_speaks_ksit() {
    let mut home = furnished();
    home.note(4, "Gone");
    home.set(
        "Hi",
        &[
            entry(Routine, 3),
            entry(Note, 4),
            entry(ReferenceRecord, 2),
            entry(Note, 1),
        ],
    )
    .unwrap();
    home.run(C::ArchiveNote(NoteId(numbered_id(4)))).unwrap();
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
    let out = sitter_page(&context, &mut history).unwrap();

    let mut expected = b"KSIT\x01\x00\x00\x00".to_vec();
    expected.extend_from_slice(&3u32.to_le_bytes());
    for (kind, id) in [(3u8, 3u32), (2, 2), (1, 1)] {
        expected.extend_from_slice(&[kind, 0, 0, 0]);
        expected.extend_from_slice(&numbered_id(id));
    }
    expected.extend_from_slice(&[2, 0]);
    expected.extend_from_slice(b"Hi");
    assert_eq!(out, expected, "routine 3, record 2, note 1; not note 4");

    let empty = sitter_page(&context, &mut History::default()).unwrap();
    assert_eq!(empty, b"KSIT\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00");
}
