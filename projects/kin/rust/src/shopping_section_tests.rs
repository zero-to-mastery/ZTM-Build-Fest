// Store sections (#411, ADR 0015): the section list (kind 66) and an item's
// section (kind 67) — canonical payloads, replay, command rules, KCMD and
// KSHS. The byte vectors here are TEST-VECTORS 046–050.
use crate::codec::encode_event;
use crate::command::{decode_command, execute, CommandContext, HouseholdCommand as C};
use crate::core::shopping_sections;
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::recurrence::CivilDate;
use crate::request::DecodedRequest;
use crate::state::{rebuild, HouseholdState};
use crate::store_sections::*;
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const ADULT: [u8; 16] = [1; 16];

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

fn sid(n: u32) -> StoreSectionId {
    StoreSectionId(numbered_id(n))
}

fn section(n: u32, name: &str) -> StoreSection {
    StoreSection {
        section_id: sid(n),
        name: name.into(),
    }
}

fn list(sections: &[StoreSection]) -> EventKind {
    EventKind::ShoppingSectionsSet {
        sections: sections.to_vec(),
    }
}

fn item_section(item: u32, section: Option<u32>) -> EventKind {
    EventKind::ItemSectionSet {
        item_id: ItemId(numbered_id(item)),
        section_id: section.map(sid),
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

    fn sections(&mut self, sections: &[StoreSection]) -> Result<(), KinError> {
        self.run(C::StoreSection(list(sections)))
    }

    fn put(&mut self, item: u32, section: Option<u32>) -> Result<(), KinError> {
        self.run(C::StoreSection(item_section(item, section)))
    }

    fn add(&mut self, item: u32, text: &str) {
        self.run(C::AddItem {
            id: ItemId(numbered_id(item)),
            text: text.into(),
            classification: ItemClassification::Shopping,
        })
        .unwrap();
    }

    fn state(&self) -> HouseholdState {
        rebuild(&self.events, 1_791_475_200_100, date(TEST_DATE)).unwrap()
    }

    fn section_of(&self, item: u32) -> Option<StoreSectionId> {
        self.state()
            .store_sections
            .section_of(&ItemId(numbered_id(item)))
    }
}

/// The bytes of a kind-66 payload, written out by hand.
fn list_bytes(sections: &[(u32, &str)]) -> Vec<u8> {
    let mut out = (sections.len() as u16).to_le_bytes().to_vec();
    out.extend_from_slice(&[0, 0]);
    for (id, name) in sections {
        out.extend_from_slice(&numbered_id(*id));
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
    }
    out
}

// 046
#[test]
fn the_section_list_payload_is_canonical() {
    let kind = list(&[section(1, "Produce"), section(2, "Dairy")]);
    let bytes = list_bytes(&[(1, "Produce"), (2, "Dairy")]);
    assert_eq!(encode_payload(&kind).unwrap(), bytes);
    assert_eq!(decode_payload(SHOPPING_SECTIONS_SET, &bytes).unwrap(), kind);
    assert_eq!(&bytes[..4], &[2, 0, 0, 0]);
    let empty = list(&[]);
    assert_eq!(encode_payload(&empty).unwrap(), vec![0, 0, 0, 0]);
    assert_eq!(
        decode_payload(SHOPPING_SECTIONS_SET, &[0, 0, 0, 0]).unwrap(),
        empty
    );
    let full: Vec<StoreSection> = (1..=30).map(|n| section(n, &format!("S{n}"))).collect();
    assert!(encode_payload(&list(&full)).is_ok(), "30 sections");
    let forty = "é".repeat(20);
    assert_eq!(forty.len(), 40);
    assert!(encode_payload(&list(&[section(1, &forty)])).is_ok());

    let malformed = |bytes: &[u8], why: &str| {
        assert_eq!(
            decode_payload(SHOPPING_SECTIONS_SET, bytes),
            Err(KinError::MalformedProtocol),
            "{why}"
        );
    };
    let mut reserved = bytes.clone();
    reserved[2] = 1;
    malformed(&reserved, "reserved bytes");
    let mut extra = bytes.clone();
    extra.push(0);
    malformed(&extra, "trailing bytes");
    malformed(&bytes[..bytes.len() - 1], "truncated");
    let mut short_count = bytes.clone();
    short_count[0] = 1;
    malformed(&short_count, "count says one, two follow");
    let names: Vec<String> = (1..=31).map(|n| format!("S{n}")).collect();
    let many: Vec<(u32, &str)> = (1..=31).zip(names.iter().map(String::as_str)).collect();
    malformed(&list_bytes(&many), "31 sections");
    malformed(&list_bytes(&[(1, "Dairy"), (1, "Bakery")]), "duplicate ID");
    let mut zero = list_bytes(&[(1, "Dairy")]);
    zero[4..20].fill(0);
    malformed(&zero, "zero ID");
    for bad in [" Dairy", "Dairy ", "", " ", "a\u{7}b", &"x".repeat(41)] {
        malformed(&list_bytes(&[(1, bad)]), "name not canonical");
        assert_eq!(
            encode_payload(&list(&[section(1, bad)])),
            Err(KinError::MalformedProtocol),
            "{bad:?}"
        );
    }
    // Duplicate names (ignoring case) are a command rule, not a format rule:
    // replay accepts them.
    assert!(decode_payload(
        SHOPPING_SECTIONS_SET,
        &list_bytes(&[(1, "Dairy"), (2, "dairy")])
    )
    .is_ok());
}

// 047
#[test]
fn the_item_section_payload_is_two_ids() {
    let kind = item_section(7, Some(2));
    let mut bytes = numbered_id(7).to_vec();
    bytes.extend_from_slice(&numbered_id(2));
    assert_eq!(encode_payload(&kind).unwrap(), bytes);
    assert_eq!(decode_payload(ITEM_SECTION_SET, &bytes).unwrap(), kind);
    let mut cleared = numbered_id(7).to_vec();
    cleared.extend_from_slice(&[0; 16]);
    assert_eq!(
        decode_payload(ITEM_SECTION_SET, &cleared).unwrap(),
        item_section(7, None)
    );
    assert_eq!(encode_payload(&item_section(7, None)).unwrap(), cleared);
    for bad in [
        &bytes[..31],
        &[bytes.as_slice(), &[0]].concat()[..],
        &[0; 32][..],
    ] {
        assert_eq!(
            decode_payload(ITEM_SECTION_SET, bad),
            Err(KinError::MalformedProtocol)
        );
    }
    assert_eq!(
        encode_payload(&EventKind::ItemSectionSet {
            item_id: ItemId(numbered_id(7)),
            section_id: Some(StoreSectionId([0; 16])),
        }),
        Err(KinError::MalformedProtocol),
        "a zero section is spelled None"
    );
    assert_eq!(
        decode_payload(65, &bytes),
        Err(KinError::MalformedProtocol),
        "not a sections kind"
    );
}

// 048
#[test]
fn the_list_is_replaced_whole_and_its_rules_hold() {
    let mut home = Household::new();
    assert_eq!(home.sections(&[]), Err(KinError::InvalidEvent), "no change");
    home.sections(&[section(1, "Produce"), section(2, "Dairy")])
        .unwrap();
    assert_eq!(
        home.sections(&[section(1, "Produce"), section(2, "Dairy")]),
        Err(KinError::InvalidEvent),
        "the same list"
    );
    assert_eq!(
        home.sections(&[
            section(1, "Produce"),
            section(2, "Dairy"),
            section(3, "DAIRY")
        ]),
        Err(KinError::InvalidEvent),
        "names are unique ignoring case"
    );
    assert_eq!(
        home.sections(&[section(1, "Produce"), section(1, "Bakery")]),
        Err(KinError::MalformedProtocol),
        "IDs are unique"
    );
    assert_eq!(
        home.sections(&[section(1, " Produce ")]),
        Err(KinError::MalformedProtocol),
        "names arrive trimmed"
    );
    assert_eq!(
        home.sections(&[section(1, &"x".repeat(41))]),
        Err(KinError::MalformedProtocol),
        "41 bytes"
    );
    let many: Vec<StoreSection> = (1..=31).map(|n| section(n, &format!("S{n}"))).collect();
    assert_eq!(home.sections(&many), Err(KinError::MalformedProtocol));
    // Reordering and renaming are changes.
    home.sections(&[section(2, "Dairy"), section(1, "Produce")])
        .unwrap();
    home.sections(&[section(2, "Dairy & eggs"), section(1, "Produce")])
        .unwrap();
    assert_eq!(
        home.state().store_sections.sections,
        vec![section(2, "Dairy & eggs"), section(1, "Produce")]
    );
    home.sections(&[]).unwrap();
    assert!(home.state().store_sections.sections.is_empty());
}

// 049
#[test]
fn an_items_section_follows_the_rules_and_the_list() {
    let mut home = Household::new();
    home.add(1, "Milk");
    home.add(2, "Old item");
    home.sections(&[section(1, "Produce"), section(2, "Dairy")])
        .unwrap();
    assert_eq!(
        home.put(9, Some(2)),
        Err(KinError::InvalidEvent),
        "no such item"
    );
    assert_eq!(
        home.put(1, Some(5)),
        Err(KinError::InvalidEvent),
        "no such section"
    );
    assert_eq!(
        home.put(1, None),
        Err(KinError::InvalidEvent),
        "already none"
    );
    home.put(1, Some(2)).unwrap();
    assert_eq!(
        home.put(1, Some(2)),
        Err(KinError::InvalidEvent),
        "no change"
    );
    assert_eq!(home.section_of(1), Some(sid(2)));
    home.put(2, Some(1)).unwrap();
    home.run(C::ArchiveItem(ItemId(numbered_id(2)))).unwrap();
    assert_eq!(
        home.put(2, Some(2)),
        Err(KinError::InvalidEvent),
        "archived item"
    );
    assert_eq!(
        home.put(2, None),
        Err(KinError::InvalidEvent),
        "archived item, even to clear"
    );

    // Dairy leaves the list: Milk shows under none, and clearing it again
    // changes nothing.
    home.sections(&[section(1, "Produce")]).unwrap();
    assert_eq!(home.section_of(1), None);
    assert_eq!(home.put(1, None), Err(KinError::InvalidEvent));
    assert_eq!(home.put(1, Some(2)), Err(KinError::InvalidEvent));
    home.put(1, Some(1)).unwrap();
    assert_eq!(home.section_of(1), Some(sid(1)));
    home.put(1, None).unwrap();
    assert_eq!(home.section_of(1), None);
}

#[test]
fn replay_tolerates_sections_it_does_not_list() {
    // An item section that names a section never listed, or an item the
    // history lacks, replays and projects as none; when that ID is listed
    // later, the item shows in it.
    let mut home = Household::new();
    home.add(1, "Bread");
    home.sections(&[section(3, "Bakery")]).unwrap();
    home.put(1, Some(3)).unwrap();
    let mut events = home.events.clone();
    let mut stray = events.last().unwrap().clone();
    stray.kind = item_section(1, Some(8));
    stray.event_id = EventId(numbered_id(60));
    stray.logical_time = 50;
    events.push(stray.clone());
    let mut ghost = stray.clone();
    ghost.kind = item_section(99, Some(3));
    ghost.event_id = EventId(numbered_id(61));
    ghost.logical_time = 51;
    events.push(ghost);
    let state = rebuild(&events, 1_791_475_200_100, date(TEST_DATE)).unwrap();
    assert_eq!(
        state.store_sections.section_of(&ItemId(numbered_id(1))),
        None
    );
    let report = encode_sections(&state.store_sections, &state.items);
    assert_eq!(&report[report.len() - 4..], &0u32.to_le_bytes());

    let mut relist = stray;
    relist.kind = list(&[section(3, "Bakery"), section(8, "Frozen")]);
    relist.event_id = EventId(numbered_id(62));
    relist.logical_time = 52;
    events.push(relist);
    let state = rebuild(&events, 1_791_475_200_100, date(TEST_DATE)).unwrap();
    assert_eq!(
        state.store_sections.section_of(&ItemId(numbered_id(1))),
        Some(sid(8))
    );
}

#[test]
fn the_latest_list_in_replay_order_wins() {
    let mut home = Household::new();
    home.sections(&[section(1, "Produce")]).unwrap();
    // Two devices replace the list concurrently; the later one wins.
    let base = home.events.clone();
    let first = execute(
        &C::StoreSection(list(&[section(1, "Fruit")])),
        context(70, 5),
        request(&base),
    )
    .unwrap()
    .event;
    let second = execute(
        &C::StoreSection(list(&[section(1, "Produce"), section(2, "Dairy")])),
        context(71, 6),
        request(&base),
    )
    .unwrap()
    .event;
    let events = [base, vec![first, second]].concat();
    let state = rebuild(&events, 1_791_475_200_100, date(TEST_DATE)).unwrap();
    assert_eq!(
        state.store_sections.sections,
        vec![section(1, "Produce"), section(2, "Dairy")]
    );
}

fn kcmd(kind_code: u16, payload: &[u8]) -> Vec<u8> {
    let mut packet = vec![0u8; 128];
    packet[..4].copy_from_slice(b"KCMD");
    packet[4] = 1;
    packet[8..10].copy_from_slice(&kind_code.to_le_bytes());
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

#[test]
fn kcmd_carries_the_section_payloads_exactly() {
    let kind = list(&[section(1, "Produce"), section(2, "Dairy")]);
    let packet = kcmd(SHOPPING_SECTIONS_SET, &encode_payload(&kind).unwrap());
    assert_eq!(decode_command(&packet).unwrap().0, C::StoreSection(kind));
    let full: Vec<StoreSection> = (1..=30).map(|n| section(n, &format!("{n:0>40}"))).collect();
    let packet = kcmd(
        SHOPPING_SECTIONS_SET,
        &encode_payload(&list(&full)).unwrap(),
    );
    assert!(decode_command(&packet).is_ok(), "the largest list fits");

    let kind = item_section(4, Some(2));
    let packet = kcmd(ITEM_SECTION_SET, &encode_payload(&kind).unwrap());
    assert_eq!(decode_command(&packet).unwrap().0, C::StoreSection(kind));
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
    let mut untrimmed = kcmd(SHOPPING_SECTIONS_SET, &list_bytes(&[(1, " Dairy")]));
    assert_eq!(
        decode_command(&untrimmed).map(|_| ()),
        Err(KinError::MalformedProtocol)
    );
    untrimmed.truncate(128);
    assert!(decode_command(&untrimmed).is_err(), "an empty payload");
}

// 050
#[test]
fn kin_shopping_sections_speaks_kshs() {
    let mut home = Household::new();
    home.add(1, "Milk");
    home.add(2, "Apples");
    home.add(3, "Batteries");
    home.add(4, "Gone");
    home.sections(&[section(2, "Dairy"), section(1, "Produce")])
        .unwrap();
    home.put(1, Some(2)).unwrap();
    home.put(2, Some(1)).unwrap();
    home.put(4, Some(1)).unwrap();
    home.run(C::ArchiveItem(ItemId(numbered_id(4)))).unwrap();
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
    let out = shopping_sections(&context, &mut history).unwrap();

    let mut expected = b"KSHS\x01\x00\x00\x00".to_vec();
    expected.extend_from_slice(&2u32.to_le_bytes());
    expected.extend_from_slice(&numbered_id(2));
    expected.extend_from_slice(&[5, 0]);
    expected.extend_from_slice(b"Dairy");
    expected.extend_from_slice(&numbered_id(1));
    expected.extend_from_slice(&[7, 0]);
    expected.extend_from_slice(b"Produce");
    expected.extend_from_slice(&2u32.to_le_bytes());
    expected.extend_from_slice(&numbered_id(1));
    expected.extend_from_slice(&numbered_id(2));
    expected.extend_from_slice(&numbered_id(2));
    expected.extend_from_slice(&numbered_id(1));
    assert_eq!(out, expected, "items 1 and 2; not 3 (none) or 4 (archived)");

    let empty = shopping_sections(&context, &mut History::default()).unwrap();
    assert_eq!(
        empty,
        b"KSHS\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
    );
}
