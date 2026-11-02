// The family calendar (#656, ADR 0022 §1): kinds 71–74 — canonical
// payloads, replay, command rules, repeats, KCMD, KCAQ and KCAL. The byte
// vectors here are TEST-VECTORS 140–148.
use crate::calendar::*;
use crate::calendar_range::*;
use crate::calendar_recur::{for_each_start, is_occurrence};
use crate::codec::encode_event;
use crate::command::{decode_command, execute, CommandContext, HouseholdCommand as C};
use crate::core::calendar_range as calendar_range_export;
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::recurrence::{Cadence, CivilDate};
use crate::request::DecodedRequest;
use crate::state::{rebuild, HouseholdState};
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const ALEX: [u8; 16] = [1; 16];
const SAM: [u8; 16] = [2; 16];
const AS_OF: i64 = 1_791_475_200_100;

fn date(value: u32) -> CivilDate {
    CivilDate::from_encoded(value).unwrap()
}

fn at(value: u32, hour: u16, minute: u16) -> CalendarTime {
    CalendarTime::new(date(value), hour * 60 + minute).unwrap()
}

fn id(n: u32) -> CalendarEventId {
    CalendarEventId(numbered_id(n))
}

/// A one-off timed event in Europe/London.
fn timed(n: u32, title: &str, start: CalendarTime, end: CalendarTime) -> CalendarEvent {
    CalendarEvent {
        event_id: id(n),
        title: title.into(),
        place: String::new(),
        notes: String::new(),
        attendees: Vec::new(),
        countdown: false,
        source_uid: String::new(),
        timing: Timing::Timed {
            start,
            end,
            zone: "Europe/London".into(),
        },
        rule: None,
        link: None,
    }
}

fn all_day(n: u32, title: &str, start: u32, end: u32) -> CalendarEvent {
    CalendarEvent {
        timing: Timing::AllDay {
            start: date(start),
            end: date(end),
        },
        ..timed(n, title, at(start, 0, 0), at(start, 0, 0))
    }
}

fn rule(frequency: Frequency, interval: u16, by: MonthlyBy, weekdays: u8, end: RuleEnd) -> Rule {
    Rule {
        frequency,
        interval,
        by,
        weekdays,
        week_start: 0,
        end,
    }
}

fn repeating(mut event: CalendarEvent, rule: Rule) -> CalendarEvent {
    event.rule = Some(rule);
    event
}

fn starts(event: &CalendarEvent, low: u32, high: u32) -> Vec<u32> {
    let mut out = Vec::new();
    for_each_start(event, date(low), date(high), |found| {
        out.push(found.encoded());
        true
    });
    out
}

fn context(event: u32, logical_time: u64, actor: [u8; 16]) -> CommandContext {
    CommandContext {
        event_id: EventId(numbered_id(event)),
        household_id: HouseholdId(HOUSEHOLD),
        actor_id: ActorId(actor),
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

    fn run_as(&mut self, actor: [u8; 16], command: C) -> Result<(), KinError> {
        let n = self.next;
        let result = execute(
            &command,
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
        self.run_as(ALEX, C::Calendar(kind))
    }

    fn save(&mut self, event: &CalendarEvent) -> Result<(), KinError> {
        self.run(EventKind::CalendarEventSaved(Box::new(event.clone())))
    }

    fn cancel(&mut self, n: u32, occurrence: Option<CalendarTime>) -> Result<(), KinError> {
        self.run(EventKind::CalendarEventCancelled {
            event_id: id(n),
            occurrence,
        })
    }

    fn restore(&mut self, n: u32, occurrence: Option<CalendarTime>) -> Result<(), KinError> {
        self.run(EventKind::CalendarEventRestored {
            event_id: id(n),
            occurrence,
        })
    }

    fn state(&self) -> HouseholdState {
        rebuild(&self.events, AS_OF, date(TEST_DATE)).unwrap()
    }

    fn history(&self) -> History {
        let records: Vec<Vec<u8>> = self
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
        history
    }
}

/// "Swimming" every Tuesday and Thursday 17:30–18:15 in Europe/London from
/// 2026-10-06, Alex and Sam, place "Leisure centre", 10 times: written out
/// by hand (140).
fn swimming() -> CalendarEvent {
    CalendarEvent {
        place: "Leisure centre".into(),
        notes: "Bring goggles.\nTowels at the desk.".into(),
        attendees: vec![ActorId(ALEX), ActorId(SAM)],
        source_uid: "swim-1@example.com".into(),
        ..repeating(
            timed(7, "Swimming", at(20261006, 17, 30), at(20261006, 18, 15)),
            rule(
                Frequency::Weekly,
                1,
                MonthlyBy::None,
                0b0000_1010,
                RuleEnd::Count(10),
            ),
        )
    }
}

fn text(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(&(value.len() as u16).to_le_bytes());
    out.extend_from_slice(value.as_bytes());
}

fn swimming_bytes() -> Vec<u8> {
    let mut out = numbered_id(7).to_vec();
    out.extend_from_slice(&[0b0100, 2, 0, 0]);
    out.extend_from_slice(&20261006u32.to_le_bytes());
    out.extend_from_slice(&1050u16.to_le_bytes());
    out.extend_from_slice(&1095u16.to_le_bytes());
    out.extend_from_slice(&20261006u32.to_le_bytes());
    // Weekly, no by, Tue+Thu, week from Monday, every week, 10 times.
    out.extend_from_slice(&[2, 0, 0b0000_1010, 0, 1, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    out.extend_from_slice(&[0; 24]);
    out.extend_from_slice(&ALEX);
    out.extend_from_slice(&SAM);
    text(&mut out, "Swimming");
    text(&mut out, "Leisure centre");
    text(&mut out, "Bring goggles.\nTowels at the desk.");
    text(&mut out, "Europe/London");
    text(&mut out, "swim-1@example.com");
    out
}

// 140
#[test]
fn the_event_payload_is_canonical() {
    let event = swimming();
    let bytes = swimming_bytes();
    assert_eq!(encode_event_payload(&event).unwrap(), bytes);
    assert_eq!(decode_event_payload(&bytes).unwrap(), event);
    assert_eq!(
        decode_payload(CALENDAR_EVENT_SAVED, &bytes).unwrap(),
        EventKind::CalendarEventSaved(Box::new(event.clone()))
    );

    // An all-day countdown with a link: flags 1 | 2 | 8, minutes zero, no
    // zone.
    let mut trip = all_day(8, "Trip to Gran's", 20261224, 20261227);
    trip.countdown = true;
    trip.link = Some(SeriesLink {
        series_id: id(9),
        original: at(20261224, 0, 0),
    });
    let trip_bytes = encode_event_payload(&trip).unwrap();
    assert_eq!(&trip_bytes[16..20], &[0b1011, 0, 0, 0]);
    assert_eq!(&trip_bytes[24..28], &[0, 0, 0, 0]);
    assert_eq!(&trip_bytes[28..32], &20261227u32.to_le_bytes());
    assert_eq!(&trip_bytes[32..48], &[0; 16]);
    assert_eq!(&trip_bytes[48..64], &numbered_id(9));
    assert_eq!(&trip_bytes[64..68], &20261224u32.to_le_bytes());
    assert_eq!(&trip_bytes[68..72], &[0, 0, 0, 0]);
    assert_eq!(decode_event_payload(&trip_bytes).unwrap(), trip);

    // Every limit at its edge encodes.
    let mut largest = swimming();
    largest.title = "é".repeat(100);
    largest.place = "p".repeat(200);
    largest.notes = "n".repeat(2000);
    largest.attendees = (1..=16).map(|n| ActorId(numbered_id(n))).collect();
    largest.source_uid = "u".repeat(255);
    largest.timing = Timing::Timed {
        start: at(20261006, 0, 0),
        end: at(20271007, 23, 59),
        zone: format!("America/{}", "x".repeat(56)),
    };
    let largest_bytes = encode_event_payload(&largest).unwrap();
    assert_eq!(decode_event_payload(&largest_bytes).unwrap(), largest);

    let malformed = |event: &CalendarEvent, why: &str| {
        assert_eq!(
            encode_event_payload(event),
            Err(KinError::MalformedProtocol),
            "{why}"
        );
    };
    let change = |edit: &dyn Fn(&mut CalendarEvent)| {
        let mut event = swimming();
        edit(&mut event);
        event
    };
    malformed(
        &change(&|e| e.event_id = CalendarEventId([0; 16])),
        "zero ID",
    );
    for title in ["", " Swim", "Swim ", "a\tb", "a\nb"] {
        malformed(&change(&|e| e.title = title.into()), title);
    }
    malformed(&change(&|e| e.title = "x".repeat(201)), "title 201 bytes");
    malformed(&change(&|e| e.place = "x".repeat(201)), "place 201 bytes");
    malformed(&change(&|e| e.place = " Pool".into()), "place untrimmed");
    malformed(&change(&|e| e.notes = "x".repeat(2001)), "notes 2001 bytes");
    for notes in ["a\r\nb", "a \nb", "\na", "a\u{7}"] {
        malformed(&change(&|e| e.notes = notes.into()), notes);
    }
    malformed(
        &change(&|e| e.attendees = vec![ActorId(SAM), ActorId(ALEX)]),
        "attendees out of order",
    );
    malformed(
        &change(&|e| e.attendees = vec![ActorId(ALEX), ActorId(ALEX)]),
        "attendee twice",
    );
    malformed(
        &change(&|e| e.attendees = vec![ActorId([0; 16])]),
        "zero attendee",
    );
    malformed(
        &change(&|e| e.attendees = (1..=17).map(|n| ActorId(numbered_id(n))).collect()),
        "17 attendees",
    );
    malformed(
        &change(&|e| e.source_uid = "u".repeat(256)),
        "UID 256 bytes",
    );
    malformed(&change(&|e| e.source_uid = " u".into()), "UID untrimmed");
    for zone in [
        "Europe//London",
        "/Europe",
        "Europe/",
        "Europe London",
        "Zürich",
        &"x".repeat(65),
    ] {
        malformed(
            &change(&|e| {
                e.timing = Timing::Timed {
                    start: at(20261006, 9, 0),
                    end: at(20261006, 10, 0),
                    zone: zone.into(),
                }
            }),
            zone,
        );
    }
    malformed(
        &change(&|e| {
            e.timing = Timing::Timed {
                start: at(20261006, 9, 0),
                end: at(20261006, 8, 59),
                zone: String::new(),
            }
        }),
        "ends before it starts",
    );
    malformed(
        &change(&|e| {
            e.timing = Timing::Timed {
                start: at(20261006, 9, 0),
                end: at(20271008, 0, 0),
                zone: String::new(),
            }
        }),
        "367 days",
    );
    malformed(
        &all_day_with(|e| {
            e.timing = Timing::AllDay {
                start: date(20261006),
                end: date(20261005),
            }
        }),
        "all-day ends before it starts",
    );
    for bad in [
        rule(Frequency::Weekly, 1, MonthlyBy::None, 0, RuleEnd::Never),
        rule(Frequency::Weekly, 1, MonthlyBy::None, 0x80, RuleEnd::Never),
        rule(Frequency::Weekly, 0, MonthlyBy::None, 1, RuleEnd::Never),
        rule(Frequency::Weekly, 1001, MonthlyBy::None, 1, RuleEnd::Never),
        rule(Frequency::Daily, 1, MonthlyBy::None, 1, RuleEnd::Never),
        rule(
            Frequency::Daily,
            1,
            MonthlyBy::MonthDay(1),
            0,
            RuleEnd::Never,
        ),
        rule(Frequency::Monthly, 1, MonthlyBy::None, 0, RuleEnd::Never),
        rule(
            Frequency::Monthly,
            1,
            MonthlyBy::MonthDay(0),
            0,
            RuleEnd::Never,
        ),
        rule(
            Frequency::Monthly,
            1,
            MonthlyBy::MonthDay(32),
            0,
            RuleEnd::Never,
        ),
        rule(
            Frequency::Monthly,
            1,
            MonthlyBy::MonthDay(-2),
            0,
            RuleEnd::Never,
        ),
        rule(
            Frequency::Monthly,
            1,
            MonthlyBy::NthWeekday { nth: 6, weekday: 0 },
            0,
            RuleEnd::Never,
        ),
        rule(
            Frequency::Yearly,
            1,
            MonthlyBy::NthWeekday { nth: 1, weekday: 7 },
            0,
            RuleEnd::Never,
        ),
        rule(Frequency::Daily, 1, MonthlyBy::None, 0, RuleEnd::Count(0)),
        rule(
            Frequency::Daily,
            1,
            MonthlyBy::None,
            0,
            RuleEnd::Count(1001),
        ),
        rule(
            Frequency::Daily,
            1,
            MonthlyBy::None,
            0,
            RuleEnd::Until(date(20261005)),
        ),
    ] {
        malformed(&change(&|e| e.rule = Some(bad)), &format!("{bad:?}"));
    }
    malformed(
        &change(&|e| {
            e.link = Some(SeriesLink {
                series_id: id(7),
                original: at(20261006, 17, 30),
            })
        }),
        "linked to itself",
    );

    let decode_fails = |bytes: &[u8], why: &str| {
        assert_eq!(
            decode_event_payload(bytes),
            Err(KinError::MalformedProtocol),
            "{why}"
        );
    };
    let mutated = |at: usize, value: u8| {
        let mut copy = bytes.clone();
        copy[at] = value;
        copy
    };
    decode_fails(&mutated(16, 0x14), "unknown flag");
    decode_fails(&mutated(18, 1), "reserved");
    decode_fails(&mutated(17, 3), "attendee count disagrees");
    decode_fails(&mutated(32, 5), "unknown frequency");
    decode_fails(&mutated(33, 3), "unknown by");
    decode_fails(&mutated(47, 1), "rule reserved byte");
    decode_fails(&mutated(48, 1), "series bytes without a link");
    decode_fails(&mutated(16, 0b0101), "minutes on an all-day event");
    decode_fails(&mutated(16, 0), "rule bytes without the flag");
    decode_fails(&[bytes.clone(), vec![0]].concat(), "trailing byte");
    decode_fails(&bytes[..bytes.len() - 1], "truncated");
    decode_fails(&bytes[..71], "short fixed part");
    let mut both = bytes.clone();
    both[40] = 0x01;
    decode_fails(&both, "count and until");
    let mut bad_utf8 = bytes.clone();
    bad_utf8[72 + 32 + 2] = 0xff;
    decode_fails(&bad_utf8, "invalid UTF-8");
    assert!(decode_event_with(
        &encode_event_with(&change(&|e| e.event_id = CalendarEventId([0; 16])), true).unwrap(),
        true
    )
    .is_ok());
}

fn all_day_with(edit: impl Fn(&mut CalendarEvent)) -> CalendarEvent {
    let mut event = all_day(3, "Holiday", 20261006, 20261006);
    edit(&mut event);
    event
}

// 141
#[test]
fn cancel_restore_and_colour_payloads_are_canonical() {
    let cancel_one = EventKind::CalendarEventCancelled {
        event_id: id(7),
        occurrence: Some(at(20261008, 17, 30)),
    };
    let mut bytes = numbered_id(7).to_vec();
    bytes.extend_from_slice(&[1, 0, 0, 0]);
    bytes.extend_from_slice(&20261008u32.to_le_bytes());
    bytes.extend_from_slice(&1050u16.to_le_bytes());
    bytes.extend_from_slice(&[0, 0]);
    assert_eq!(encode_payload(&cancel_one).unwrap(), bytes);
    assert_eq!(decode_payload(72, &bytes).unwrap(), cancel_one);
    let restore_one = decode_payload(73, &bytes).unwrap();
    assert_eq!(
        restore_one,
        EventKind::CalendarEventRestored {
            event_id: id(7),
            occurrence: Some(at(20261008, 17, 30)),
        }
    );
    let all = EventKind::CalendarEventCancelled {
        event_id: id(7),
        occurrence: None,
    };
    let mut series = numbered_id(7).to_vec();
    series.extend_from_slice(&[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(encode_payload(&all).unwrap(), series);
    assert_eq!(decode_payload(72, &series).unwrap(), all);

    let colour = EventKind::MemberColourSet { colour: Some(11) };
    assert_eq!(encode_payload(&colour).unwrap(), vec![11, 0, 0, 0]);
    assert_eq!(decode_payload(74, &[11, 0, 0, 0]).unwrap(), colour);
    assert_eq!(
        decode_payload(74, &[255, 0, 0, 0]).unwrap(),
        EventKind::MemberColourSet { colour: None }
    );

    for (code, bad, why) in [
        (72u16, [&bytes[..27], &[]].concat(), "27 bytes"),
        (72, [&bytes[..], &[0]].concat(), "29 bytes"),
        (
            72,
            {
                let mut b = bytes.clone();
                b[16] = 3;
                b
            },
            "scope 3",
        ),
        (
            72,
            {
                let mut b = bytes.clone();
                b[16] = 0;
                b
            },
            "scope 0",
        ),
        (
            72,
            {
                let mut b = bytes.clone();
                b[17] = 1;
                b
            },
            "reserved",
        ),
        (
            72,
            {
                let mut b = bytes.clone();
                b[26] = 1;
                b
            },
            "time reserved",
        ),
        (
            72,
            {
                let mut b = bytes.clone();
                b[24..26].copy_from_slice(&1440u16.to_le_bytes());
                b
            },
            "minute 1440",
        ),
        (
            72,
            {
                let mut b = bytes.clone();
                b[20..24].copy_from_slice(&20260230u32.to_le_bytes());
                b
            },
            "no such date",
        ),
        (
            72,
            {
                let mut b = series.clone();
                b[20] = 1;
                b
            },
            "a date on the series",
        ),
        (
            72,
            {
                let mut b = bytes.clone();
                b[..16].fill(0);
                b
            },
            "zero event",
        ),
        (74, vec![12, 0, 0, 0], "colour 12"),
        (74, vec![254, 0, 0, 0], "colour 254"),
        (74, vec![1, 0, 1, 0], "colour reserved"),
        (74, vec![1, 0, 0], "3 bytes"),
        (75, vec![1, 0, 0, 0], "not a calendar kind"),
    ] {
        assert_eq!(
            decode_payload(code, &bad),
            Err(KinError::MalformedProtocol),
            "{why}"
        );
    }
}

// 142
#[test]
fn commands_check_events_cancels_restores_and_colours() {
    let mut home = Household::new();
    let swim = swimming();
    home.save(&swim).unwrap();
    assert_eq!(home.save(&swim), Err(KinError::InvalidEvent), "no change");
    let mut moved = swim.clone();
    moved.title = "Swimming lesson".into();
    home.save(&moved).unwrap();

    // Cancel one occurrence: it must be a real one, once.
    let thursday = at(20261008, 17, 30);
    for not_one in [
        at(20261007, 17, 30),
        at(20261008, 17, 31),
        at(20261110, 17, 30),
    ] {
        assert_eq!(
            home.cancel(7, Some(not_one)),
            Err(KinError::InvalidEvent),
            "{not_one:?}"
        );
    }
    assert_eq!(
        home.cancel(8, None),
        Err(KinError::InvalidEvent),
        "unknown event"
    );
    home.cancel(7, Some(thursday)).unwrap();
    assert_eq!(
        home.cancel(7, Some(thursday)),
        Err(KinError::InvalidEvent),
        "twice"
    );
    assert_eq!(
        home.restore(7, None),
        Err(KinError::InvalidEvent),
        "series not cancelled"
    );
    home.restore(7, Some(thursday)).unwrap();
    assert_eq!(
        home.restore(7, Some(thursday)),
        Err(KinError::InvalidEvent),
        "twice"
    );

    // A changed occurrence: cancel it and save a standalone linked event.
    home.cancel(7, Some(thursday)).unwrap();
    let mut late = timed(
        20,
        "Swimming (late)",
        at(20261008, 18, 30),
        at(20261008, 19, 15),
    );
    late.link = Some(SeriesLink {
        series_id: id(7),
        original: thursday,
    });
    home.save(&late).unwrap();
    let mut wrong = late.clone();
    wrong.event_id = id(21);
    wrong.link = Some(SeriesLink {
        series_id: id(7),
        original: at(20261009, 17, 30),
    });
    assert_eq!(
        home.save(&wrong),
        Err(KinError::InvalidEvent),
        "not an occurrence"
    );
    wrong.link = Some(SeriesLink {
        series_id: id(20),
        original: at(20261008, 18, 30),
    });
    assert_eq!(
        home.save(&wrong),
        Err(KinError::InvalidEvent),
        "series doesn't repeat"
    );
    wrong.link = Some(SeriesLink {
        series_id: id(99),
        original: thursday,
    });
    assert_eq!(
        home.save(&wrong),
        Err(KinError::InvalidEvent),
        "unknown series"
    );

    // Cancel the whole series: the linked event goes with it.
    home.cancel(7, None).unwrap();
    assert_eq!(home.cancel(7, None), Err(KinError::InvalidEvent), "twice");
    assert_eq!(
        home.cancel(7, Some(at(20261013, 17, 30))),
        Err(KinError::InvalidEvent),
        "an occurrence of a cancelled series"
    );
    assert_eq!(
        home.save(&moved),
        Err(KinError::InvalidEvent),
        "edit a cancelled series"
    );
    let mut late_edit = late.clone();
    late_edit.title = "Swim".into();
    assert_eq!(
        home.save(&late_edit),
        Err(KinError::InvalidEvent),
        "edit through a cancelled series"
    );
    assert_eq!(
        home.cancel(20, None),
        Err(KinError::InvalidEvent),
        "already hidden"
    );
    let state = home.state();
    assert!(state
        .calendar
        .hidden(state.calendar.event(&id(20)).unwrap()));
    home.restore(7, None).unwrap();
    assert!(!home.state().calendar.hidden(&late));

    // Colours: the actor's own, and a change.
    let colour = |colour| EventKind::MemberColourSet { colour };
    assert_eq!(
        home.run(colour(None)),
        Err(KinError::InvalidEvent),
        "no colour to clear"
    );
    home.run(colour(Some(3))).unwrap();
    assert_eq!(
        home.run(colour(Some(3))),
        Err(KinError::InvalidEvent),
        "same colour"
    );
    home.run_as(SAM, C::Calendar(colour(Some(3)))).unwrap();
    home.run(colour(Some(4))).unwrap();
    let state = home.state();
    assert_eq!(state.calendar.colours.get(&ActorId(ALEX)), Some(&4));
    assert_eq!(state.calendar.colours.get(&ActorId(SAM)), Some(&3));
    home.run(colour(None)).unwrap();
    assert_eq!(home.state().calendar.colours.get(&ActorId(ALEX)), None);

    // Attendees are member IDs as given: Rust doesn't know membership.
    let mut stranger = all_day(30, "Party", 20261010, 20261010);
    stranger.attendees = vec![ActorId(numbered_id(77))];
    home.save(&stranger).unwrap();

    // A command carrying another domain's kind is refused.
    assert_eq!(
        home.run(EventKind::SitterPageSet {
            intro: String::new(),
            entries: vec![]
        }),
        Err(KinError::InvalidEvent)
    );
}

#[test]
fn a_household_keeps_at_most_two_thousand_events() {
    let mut events = Vec::new();
    let mut template = execute(
        &C::Calendar(EventKind::CalendarEventSaved(Box::new(all_day(
            1, "One", 20261010, 20261010,
        )))),
        context(1, 1, ALEX),
        request(&[]),
    )
    .unwrap()
    .event;
    for n in 1..=(MAX_CALENDAR_EVENTS as u32 + 1) {
        template.event_id = EventId(numbered_id(10_000 + n));
        template.logical_time = u64::from(n);
        template.kind =
            EventKind::CalendarEventSaved(Box::new(all_day(n, "One", 20261010, 20261010)));
        template.canonical_bytes = Vec::new();
        let bytes = encode_event(&template).unwrap();
        events.push(decode_event(&bytes).unwrap());
    }
    let state = rebuild(&events, AS_OF, date(TEST_DATE)).unwrap();
    assert_eq!(
        state.calendar.events.len(),
        MAX_CALENDAR_EVENTS,
        "the 2,001st is a no-op"
    );
    assert!(state
        .calendar
        .event(&id(MAX_CALENDAR_EVENTS as u32 + 1))
        .is_none());
    // Commands refuse a new one, and still edit an old one.
    let full = &events[..MAX_CALENDAR_EVENTS];
    assert_eq!(
        execute(
            &C::Calendar(EventKind::CalendarEventSaved(Box::new(all_day(
                5000, "New", 20261010, 20261010
            )))),
            context(99_999, 3000, ALEX),
            request(full),
        )
        .map(|_| ()),
        Err(KinError::InvalidEvent)
    );
    assert!(execute(
        &C::Calendar(EventKind::CalendarEventSaved(Box::new(all_day(
            1, "Edited", 20261010, 20261010
        )))),
        context(99_999, 3000, ALEX),
        request(full),
    )
    .is_ok());
}

// 143
#[test]
fn repeats_follow_the_rfc_across_month_lengths_and_leap_years() {
    let base = |start: u32| all_day(1, "R", start, start);
    // Daily every 3 days, 5 times.
    let daily = repeating(
        base(20240227),
        rule(Frequency::Daily, 3, MonthlyBy::None, 0, RuleEnd::Count(5)),
    );
    assert_eq!(
        starts(&daily, 20240101, 20241231),
        [20240227, 20240301, 20240304, 20240307, 20240310]
    );
    // Weekly Mon/Wed/Fri until a date; the start (a Tuesday) is first.
    let weekly = repeating(
        base(20261006),
        rule(
            Frequency::Weekly,
            1,
            MonthlyBy::None,
            0b10101,
            RuleEnd::Until(date(20261014)),
        ),
    );
    assert_eq!(
        starts(&weekly, 20261001, 20261031),
        [20261006, 20261007, 20261009, 20261012, 20261014]
    );
    // Every other week on Sunday and Monday: weeks starting Sunday (WKST=SU)
    // keep each Sunday with the Monday after it.
    let mut fortnight = rule(
        Frequency::Weekly,
        2,
        MonthlyBy::None,
        0b100_0001,
        RuleEnd::Count(6),
    );
    fortnight.week_start = 6;
    let sunday_weeks = repeating(base(20261004), fortnight);
    assert_eq!(
        starts(&sunday_weeks, 20261001, 20261231),
        [20261004, 20261005, 20261018, 20261019, 20261101, 20261102]
    );
    fortnight.week_start = 0;
    let monday_weeks = repeating(base(20261004), fortnight);
    assert_eq!(
        starts(&monday_weeks, 20261001, 20261231),
        [20261004, 20261012, 20261018, 20261026, 20261101, 20261109],
        "weeks from Monday pair each Sunday with the Monday after next"
    );
    // Monthly on the 31st skips short months.
    let thirty_first = repeating(
        base(20260131),
        rule(
            Frequency::Monthly,
            1,
            MonthlyBy::MonthDay(31),
            0,
            RuleEnd::Never,
        ),
    );
    assert_eq!(
        starts(&thirty_first, 20260101, 20260831),
        [20260131, 20260331, 20260531, 20260731, 20260831]
    );
    // The last day of every month, through a leap February.
    let last = repeating(
        base(20240131),
        rule(
            Frequency::Monthly,
            1,
            MonthlyBy::MonthDay(-1),
            0,
            RuleEnd::Count(4),
        ),
    );
    assert_eq!(
        starts(&last, 20240101, 20241231),
        [20240131, 20240229, 20240331, 20240430]
    );
    // The second Tuesday; the last Friday; the fifth Monday only where there is one.
    let second_tuesday = repeating(
        base(20261013),
        rule(
            Frequency::Monthly,
            1,
            MonthlyBy::NthWeekday { nth: 2, weekday: 1 },
            0,
            RuleEnd::Count(3),
        ),
    );
    assert_eq!(
        starts(&second_tuesday, 20261001, 20271231),
        [20261013, 20261110, 20261208]
    );
    let last_friday = repeating(
        base(20261030),
        rule(
            Frequency::Monthly,
            1,
            MonthlyBy::NthWeekday {
                nth: -1,
                weekday: 4,
            },
            0,
            RuleEnd::Count(4),
        ),
    );
    assert_eq!(
        starts(&last_friday, 20261001, 20271231),
        [20261030, 20261127, 20261225, 20270129]
    );
    let fifth_monday = repeating(
        base(20261130),
        rule(
            Frequency::Monthly,
            1,
            MonthlyBy::NthWeekday { nth: 5, weekday: 0 },
            0,
            RuleEnd::Until(date(20270630)),
        ),
    );
    assert_eq!(
        starts(&fifth_monday, 20261101, 20271231),
        [20261130, 20270329, 20270531]
    );
    // Yearly on February 29 is every leap year; yearly on the fourth
    // Thursday of November is Thanksgiving.
    let leap = repeating(
        base(20240229),
        rule(
            Frequency::Yearly,
            1,
            MonthlyBy::MonthDay(29),
            0,
            RuleEnd::Count(3),
        ),
    );
    assert_eq!(
        starts(&leap, 20240101, 20401231),
        [20240229, 20280229, 20320229]
    );
    let thanksgiving = repeating(
        base(20261126),
        rule(
            Frequency::Yearly,
            1,
            MonthlyBy::NthWeekday { nth: 4, weekday: 3 },
            0,
            RuleEnd::Never,
        ),
    );
    assert_eq!(
        starts(&thanksgiving, 20261101, 20291231),
        [20261126, 20271125, 20281123, 20291122]
    );
    // A start the rule wouldn't choose is still first, and counts.
    let off_rule = repeating(
        base(20261007),
        rule(
            Frequency::Monthly,
            1,
            MonthlyBy::MonthDay(15),
            0,
            RuleEnd::Count(3),
        ),
    );
    assert_eq!(
        starts(&off_rule, 20261001, 20271231),
        [20261007, 20261015, 20261115]
    );
    // Without COUNT the walk starts at the window: a daily event from 1990
    // read in 2026, and the occurrence check.
    let old = repeating(
        base(19900101),
        rule(Frequency::Daily, 7, MonthlyBy::None, 0, RuleEnd::Never),
    );
    assert_eq!(starts(&old, 20261001, 20261014), [20261005, 20261012]);
    assert!(is_occurrence(&old, at(20261012, 0, 0)));
    assert!(!is_occurrence(&old, at(20261013, 0, 0)));
    assert!(
        !is_occurrence(&old, at(20261012, 9, 0)),
        "all-day starts at minute 0"
    );
    // Near the end of the calendar the walk stops cleanly.
    let end_of_time = repeating(
        base(99991201),
        rule(
            Frequency::Monthly,
            1,
            MonthlyBy::MonthDay(1),
            0,
            RuleEnd::Never,
        ),
    );
    assert_eq!(starts(&end_of_time, 99991101, 99991231), [99991201]);
    // Exhaustive cross-check of weekly rules against a day-by-day reading.
    for start in [20240226u32, 20240229, 20241229] {
        for mask in [1u8, 0b0010_0101, 0b111_1111, 0b100_0000] {
            for interval in [1u16, 2, 3] {
                for week_start in [0u8, 6] {
                    let mut r = rule(
                        Frequency::Weekly,
                        interval,
                        MonthlyBy::None,
                        mask,
                        RuleEnd::Never,
                    );
                    r.week_start = week_start;
                    let event = repeating(base(start), r);
                    let mut expected = vec![start];
                    let first = date(start);
                    let week_of = |d: CivilDate| {
                        (d.day_number() - (d.weekday() + 7 - u32::from(week_start)) % 7) / 7
                    };
                    let mut day = first.checked_add_days(1).unwrap();
                    while day <= date(20250630) {
                        if mask & (1 << day.weekday()) != 0
                            && (week_of(day) - week_of(first)) % u32::from(interval) == 0
                        {
                            expected.push(day.encoded());
                        }
                        day = day.checked_add_days(1).unwrap();
                    }
                    assert_eq!(
                        starts(&event, start, 20250630),
                        expected,
                        "{start} {mask:b} {interval} {week_start}"
                    );
                    // Any window agrees with the full walk.
                    let window: Vec<u32> = expected
                        .iter()
                        .copied()
                        .filter(|d| (20240901..=20241031).contains(d))
                        .collect();
                    assert_eq!(starts(&event, 20240901, 20241031), window);
                }
            }
        }
    }
}

// 144
#[test]
fn local_times_stay_put_across_daylight_saving_time() {
    // 09:00 every Sunday in Europe/London through the clocks going back
    // (2026-10-25) and forward (2027-03-28): still 09:00 local, minute 540.
    let mut home = Household::new();
    let mut church = timed(1, "Church", at(20261018, 9, 0), at(20261018, 10, 0));
    church.rule = Some(rule(
        Frequency::Weekly,
        1,
        MonthlyBy::None,
        0b100_0000,
        RuleEnd::Never,
    ));
    home.save(&church).unwrap();
    // 23:30 to 01:00 in America/New_York, across the US change (2026-11-01).
    let mut shift = timed(2, "Night shift", at(20261031, 23, 30), at(20261101, 1, 0));
    shift.timing = Timing::Timed {
        start: at(20261031, 23, 30),
        end: at(20261101, 1, 0),
        zone: "America/New_York".into(),
    };
    shift.rule = Some(rule(
        Frequency::Daily,
        1,
        MonthlyBy::None,
        0,
        RuleEnd::Count(3),
    ));
    home.save(&shift).unwrap();
    let state = home.state();
    let (found, truncated) = occurrences_in(&state.calendar, date(20261024), date(20270404), false);
    assert!(!truncated);
    let church_starts: Vec<CalendarTime> = found
        .iter()
        .filter(|o| o.event_id == id(1))
        .map(|o| o.start)
        .collect();
    assert_eq!(church_starts.len(), 24);
    assert!(church_starts.iter().all(|start| start.minute == 540));
    assert!(
        church_starts.contains(&at(20261025, 9, 0)) && church_starts.contains(&at(20270328, 9, 0))
    );
    let shifts: Vec<(CalendarTime, CalendarTime)> = found
        .iter()
        .filter(|o| o.event_id == id(2))
        .map(|o| (o.start, o.end))
        .collect();
    assert_eq!(
        shifts,
        [
            (at(20261031, 23, 30), at(20261101, 1, 0)),
            (at(20261101, 23, 30), at(20261102, 1, 0)),
            (at(20261102, 23, 30), at(20261103, 1, 0)),
        ]
    );
    // An occurrence that started the day before still shows on the first
    // day; one that ended exactly at midnight doesn't.
    let (first_day, _) = occurrences_in(&state.calendar, date(20261101), date(20261101), false);
    assert_eq!(first_day.iter().filter(|o| o.event_id == id(2)).count(), 2);
    let mut midnight = timed(3, "Late film", at(20261010, 22, 0), at(20261011, 0, 0));
    midnight.timing = Timing::Timed {
        start: at(20261010, 22, 0),
        end: at(20261011, 0, 0),
        zone: String::new(),
    };
    home.save(&midnight).unwrap();
    let state = home.state();
    let (eleventh, _) = occurrences_in(&state.calendar, date(20261011), date(20261011), false);
    assert!(eleventh.iter().all(|o| o.event_id != id(3)));
}

// 145
#[test]
fn replay_is_tolerant_and_the_latest_save_wins() {
    let mut home = Household::new();
    home.save(&swimming()).unwrap();
    let base = home.events.clone();
    let mut mine = swimming();
    mine.title = "Mine".into();
    let mut theirs = swimming();
    theirs.title = "Theirs".into();
    let first = execute(
        &C::Calendar(EventKind::CalendarEventSaved(Box::new(mine))),
        context(70, 20, ALEX),
        request(&base),
    )
    .unwrap()
    .event;
    let second = execute(
        &C::Calendar(EventKind::CalendarEventSaved(Box::new(theirs))),
        context(71, 21, SAM),
        request(&base),
    )
    .unwrap()
    .event;
    let state = rebuild(
        &[base.clone(), vec![first.clone(), second.clone()]].concat(),
        AS_OF,
        date(TEST_DATE),
    )
    .unwrap();
    assert_eq!(state.calendar.event(&id(7)).unwrap().title, "Theirs");

    // A cancel for an event this device hasn't seen is kept and applies
    // once the event arrives.
    let mut cancel = second.clone();
    cancel.event_id = EventId(numbered_id(80));
    cancel.logical_time = 22;
    cancel.kind = EventKind::CalendarEventCancelled {
        event_id: id(40),
        occurrence: Some(at(20261012, 0, 0)),
    };
    let mut arrive = cancel.clone();
    arrive.event_id = EventId(numbered_id(81));
    arrive.logical_time = 23;
    arrive.kind = EventKind::CalendarEventSaved(Box::new(repeating(
        all_day(40, "Bins", 20261005, 20261005),
        rule(Frequency::Weekly, 1, MonthlyBy::None, 1, RuleEnd::Never),
    )));
    let reencode = |event: EventEnvelope| decode_event(&encode_event(&event).unwrap()).unwrap();
    let events = [
        base,
        vec![first, second, reencode(cancel), reencode(arrive)],
    ]
    .concat();
    let state = rebuild(&events, AS_OF, date(TEST_DATE)).unwrap();
    assert!(state
        .calendar
        .occurrence_cancelled(&id(40), at(20261012, 0, 0)));
    let (found, _) = occurrences_in(&state.calendar, date(20261005), date(20261019), false);
    let bins: Vec<u32> = found
        .iter()
        .filter(|o| o.event_id == id(40))
        .map(|o| o.start.date.encoded())
        .collect();
    assert_eq!(bins, [20261005, 20261019]);
    let (with_cancelled, _) = occurrences_in(&state.calendar, date(20261005), date(20261019), true);
    let marked: Vec<bool> = with_cancelled
        .iter()
        .filter(|o| o.event_id == id(40))
        .map(|o| o.cancelled)
        .collect();
    assert_eq!(marked, [false, true, false]);
}

fn kcmd(code: u16, payload: &[u8]) -> Vec<u8> {
    let mut packet = vec![0u8; 128];
    packet[..4].copy_from_slice(b"KCMD");
    packet[4] = 1;
    packet[8..10].copy_from_slice(&code.to_le_bytes());
    packet[12..28].copy_from_slice(&numbered_id(500));
    packet[28..44].copy_from_slice(&HOUSEHOLD);
    packet[44..60].copy_from_slice(&ALEX);
    packet[60..76].copy_from_slice(&[0x11; 16]);
    packet[76..84].copy_from_slice(&1_791_475_200_000i64.to_le_bytes());
    packet[84..92].copy_from_slice(&1u64.to_le_bytes());
    packet[124..128].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    packet.extend_from_slice(payload);
    packet
}

// 146
#[test]
fn kcmd_carries_calendar_payloads_exactly() {
    let saved = EventKind::CalendarEventSaved(Box::new(swimming()));
    let packet = kcmd(71, &swimming_bytes());
    assert_eq!(decode_command(&packet).unwrap().0, C::Calendar(saved));
    for (code, payload) in [
        (
            72u16,
            encode_payload(&EventKind::CalendarEventCancelled {
                event_id: id(7),
                occurrence: None,
            })
            .unwrap(),
        ),
        (
            73,
            encode_payload(&EventKind::CalendarEventRestored {
                event_id: id(7),
                occurrence: Some(at(20261008, 17, 30)),
            })
            .unwrap(),
        ),
        (74, vec![5, 0, 0, 0]),
    ] {
        let (command, _) = decode_command(&kcmd(code, &payload)).unwrap();
        let C::Calendar(kind) = command else {
            panic!("{code}")
        };
        assert_eq!(crate::codec::kind_code(&kind), code);
    }
    // The largest event fits a KCMD.
    let mut largest = swimming();
    largest.title = "t".repeat(200);
    largest.place = "p".repeat(200);
    largest.notes = "n".repeat(2000);
    largest.attendees = (1..=16).map(|n| ActorId(numbered_id(n))).collect();
    largest.source_uid = "u".repeat(255);
    let big = kcmd(71, &encode_event_payload(&largest).unwrap());
    assert!(decode_command(&big).is_ok());
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
    assert!(decode_command(&kcmd(71, &[])).is_err(), "empty payload");
    assert!(
        decode_command(&kcmd(74, &[12, 0, 0, 0])).is_err(),
        "colour 12"
    );
}

/// A KCAQ query then the record-less KINE context.
fn kcaq(from: u32, to: u32, flags: u32) -> Vec<u8> {
    let mut query = b"KCAQ\x01\x00\x00\x00".to_vec();
    query.extend_from_slice(&from.to_le_bytes());
    query.extend_from_slice(&to.to_le_bytes());
    query.extend_from_slice(&flags.to_le_bytes());
    query.extend_from_slice(&kine(&[], AS_OF, TEST_DATE, None));
    query
}

// 147
#[test]
fn kin_calendar_range_speaks_kcal() {
    let mut home = Household::new();
    // Bins: all-day every Monday from 2026-10-05; the 12th cancelled.
    let bins = repeating(
        all_day(1, "Bins", 20261005, 20261005),
        rule(Frequency::Weekly, 1, MonthlyBy::None, 1, RuleEnd::Never),
    );
    home.save(&bins).unwrap();
    home.cancel(1, Some(at(20261012, 0, 0))).unwrap();
    // Dentist, 2026-10-06 10:00–10:30 Europe/London, Sam.
    let mut dentist = timed(2, "Dentist", at(20261006, 10, 0), at(20261006, 10, 30));
    dentist.attendees = vec![ActorId(SAM)];
    home.save(&dentist).unwrap();
    // A countdown far outside the range.
    let mut trip = all_day(3, "Trip", 20261224, 20261227);
    trip.countdown = true;
    home.save(&trip).unwrap();
    home.run(EventKind::MemberColourSet { colour: Some(2) })
        .unwrap();
    // An item planned on the 7th and a dinner on the 6th.
    home.run_as(
        ALEX,
        C::AddItem {
            id: ItemId(numbered_id(50)),
            text: "Pay rent".into(),
            classification: ItemClassification::Today,
        },
    )
    .unwrap();
    home.run_as(
        ALEX,
        C::SetItemPlanningDate {
            item_id: ItemId(numbered_id(50)),
            planning_date: Some(date(20261007)),
        },
    )
    .unwrap();
    home.run_as(
        ALEX,
        C::Meal(EventKind::DinnerSet {
            date: date(20261006),
            recipe_id: None,
            name: "Tacos".into(),
        }),
    )
    .unwrap();

    let mut history = home.history();
    let out = calendar_range_export(&kcaq(20261005, 20261011, 0), &mut history).unwrap();

    let mut expected = b"KCAL\x01\x00\x00\x00".to_vec();
    for value in [20261005u32, 20261011, TEST_DATE, 1 << 4] {
        expected.extend_from_slice(&value.to_le_bytes());
    }
    // 1 colour, 3 events, 2 occurrences, 1 item, 0 routines, 1 meal.
    for count in [1u32, 3, 2, 1, 0, 1] {
        expected.extend_from_slice(&count.to_le_bytes());
    }
    // The next countdown: event index 2, 2026-12-24 to 12-27, all-day + countdown.
    let occurrence =
        |out: &mut Vec<u8>, index: u32, start: CalendarTime, flags: u8, end: CalendarTime| {
            out.extend_from_slice(&index.to_le_bytes());
            out.extend_from_slice(&start.date.encoded().to_le_bytes());
            out.extend_from_slice(&start.minute.to_le_bytes());
            out.extend_from_slice(&[flags, 0]);
            out.extend_from_slice(&end.date.encoded().to_le_bytes());
            out.extend_from_slice(&end.minute.to_le_bytes());
            out.extend_from_slice(&[0, 0]);
        };
    occurrence(
        &mut expected,
        2,
        at(20261224, 0, 0),
        0b011,
        at(20261227, 0, 0),
    );
    expected.extend_from_slice(&ALEX);
    expected.extend_from_slice(&[2, 0, 0, 0]);
    // Events by ID: bins (one cancelled start), dentist, trip.
    for (event, cancelled) in [
        (&bins, vec![at(20261012, 0, 0)]),
        (&dentist, vec![]),
        (&trip, vec![]),
    ] {
        let payload = encode_event_payload(event).unwrap();
        expected.extend_from_slice(&[0, 0]);
        expected.extend_from_slice(&(cancelled.len() as u16).to_le_bytes());
        expected.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        for start in cancelled {
            expected.extend_from_slice(&start.date.encoded().to_le_bytes());
            expected.extend_from_slice(&start.minute.to_le_bytes());
            expected.extend_from_slice(&[0, 0]);
        }
        expected.extend_from_slice(&payload);
    }
    occurrence(
        &mut expected,
        0,
        at(20261005, 0, 0),
        0b001,
        at(20261005, 0, 0),
    );
    occurrence(
        &mut expected,
        1,
        at(20261006, 10, 0),
        0,
        at(20261006, 10, 30),
    );
    // The item.
    expected.extend_from_slice(&numbered_id(50));
    expected.extend_from_slice(&20261007u32.to_le_bytes());
    expected.extend_from_slice(&[0, 0, 0, 0]);
    expected.extend_from_slice(&[0; 16]);
    // The dinner.
    expected.extend_from_slice(&20261006u32.to_le_bytes());
    expected.extend_from_slice(&[4, 0, 0, 0]);
    expected.extend_from_slice(&[0; 32]);
    text(&mut expected, "Tacos");
    assert_eq!(out, expected);

    // With cancelled occurrences and every event.
    let all = calendar_range_export(&kcaq(20261012, 20261012, 3), &mut history).unwrap();
    assert_eq!(
        &all[28..36],
        &[3, 0, 0, 0, 1, 0, 0, 0],
        "3 events, 1 occurrence"
    );
    // An empty history.
    let empty =
        calendar_range_export(&kcaq(20261005, 20261011, 0), &mut History::default()).unwrap();
    let mut header = b"KCAL\x01\x00\x00\x00".to_vec();
    for value in [20261005u32, 20261011, TEST_DATE, 0, 0, 0, 0, 0, 0, 0] {
        header.extend_from_slice(&value.to_le_bytes());
    }
    header.extend_from_slice(&[0; 20]);
    assert_eq!(empty, header);
}

// 148
#[test]
fn queries_are_bounded() {
    let mut history = History::default();
    for (from, to, flags, error) in [
        (20261011u32, 20261005u32, 0u32, KinError::MalformedProtocol),
        (20260101, 20270205, 0, KinError::MalformedProtocol),
        (20261005, 20261005, 4, KinError::MalformedProtocol),
        (20260230, 20260301, 0, KinError::MalformedProtocol),
    ] {
        assert_eq!(
            calendar_range_export(&kcaq(from, to, flags), &mut history),
            Err(error),
            "{from} {to} {flags}"
        );
    }
    assert!(
        calendar_range_export(&kcaq(20260101, 20270204, 0), &mut history).is_ok(),
        "400 days"
    );
    let mut version = kcaq(20261005, 20261005, 0);
    version[4] = 2;
    assert_eq!(
        calendar_range_export(&version, &mut history),
        Err(KinError::UnsupportedVersion)
    );
    let mut magic = kcaq(20261005, 20261005, 0);
    magic[0] = b'X';
    assert_eq!(
        calendar_range_export(&magic, &mut history),
        Err(KinError::MalformedProtocol)
    );

    // 5,000 occurrences at most, the earliest kept: twenty events every day
    // for 400 days would be 8,000.
    let mut home = Household::new();
    for n in 1..=20 {
        let mut event = timed(n, "Daily", at(20260101, 7, n as u16), at(20260101, 8, 0));
        event.rule = Some(rule(
            Frequency::Daily,
            1,
            MonthlyBy::None,
            0,
            RuleEnd::Never,
        ));
        home.save(&event).unwrap();
    }
    let state = home.state();
    let (found, truncated) = occurrences_in(&state.calendar, date(20260101), date(20270204), false);
    assert!(truncated);
    assert_eq!(found.len(), MAX_RANGE_OCCURRENCES);
    assert_eq!(found[0].start, at(20260101, 7, 1));
    assert_eq!(
        found.last().unwrap().start,
        at(20260907, 7, 20),
        "250 days × 20"
    );
    assert!(found.windows(2).all(|pair| pair[0] < pair[1]));
    let range = calendar_range(
        &state,
        RangeQuery {
            from: date(20260101),
            to: date(20270204),
            all_events: false,
            include_cancelled: false,
        },
        date(TEST_DATE),
    );
    let bytes = encode_range(&state.calendar, &range).unwrap();
    assert_eq!(
        &bytes[20..24],
        &1u32.to_le_bytes(),
        "flag: occurrences left out"
    );
}

#[test]
fn the_range_merges_routines_and_next_countdowns() {
    let mut home = Household::new();
    home.run_as(
        ALEX,
        C::CreateRoutine {
            id: RoutineId(numbered_id(60)),
            text: "Water plants".into(),
            cadence: Cadence::Weekly,
            created_on: date(TEST_DATE),
        },
    )
    .unwrap();
    let mut birthday = all_day(5, "Sam's birthday", 20240301, 20240301);
    birthday.countdown = true;
    birthday.rule = Some(rule(
        Frequency::Yearly,
        1,
        MonthlyBy::MonthDay(1),
        0,
        RuleEnd::Never,
    ));
    home.save(&birthday).unwrap();
    let state = home.state();
    let range = calendar_range(
        &state,
        RangeQuery {
            from: date(20261003),
            to: date(20261019),
            all_events: false,
            include_cancelled: false,
        },
        date(TEST_DATE),
    );
    let opens: Vec<u32> = range.routines.iter().map(|r| r.opens.encoded()).collect();
    assert_eq!(opens, [20261003, 20261005, 20261012, 20261019]);
    assert!(range.routines[0].current && !range.routines[1].current);
    // Next March 1 from 2026-10-03.
    assert_eq!(range.next_countdown.unwrap().start, at(20270301, 0, 0));
    // Cancelling it moves the countdown a year on.
    home.cancel(5, Some(at(20270301, 0, 0))).unwrap();
    let state = home.state();
    assert_eq!(
        next_countdown(&state.calendar, date(TEST_DATE)),
        None,
        "the next is past 400 days"
    );
    assert_eq!(
        next_countdown(&state.calendar, date(20270302))
            .unwrap()
            .start,
        at(20280301, 0, 0)
    );
}

// #660: the range carries every meal slot, by date then slot, with the cook
// on dinners only.
#[test]
fn range_meals_include_every_slot() {
    use crate::meals::MealSlot as Planner;
    let mut home = Household::new();
    let meal = |date_value: u32, slot: Planner, name: &str| {
        C::Meal(EventKind::MealSet {
            date: date(date_value),
            slot,
            recipe_id: None,
            name: name.into(),
        })
    };
    home.run_as(ALEX, meal(20261007, Planner::Breakfast, "Porridge"))
        .unwrap();
    home.run_as(ALEX, meal(20261006, Planner::Snack, "Apples"))
        .unwrap();
    home.run_as(ALEX, meal(20261006, Planner::Lunch, "Soup"))
        .unwrap();
    home.run_as(
        ALEX,
        C::Meal(EventKind::DinnerSet {
            date: date(20261006),
            recipe_id: None,
            name: "Tacos".into(),
        }),
    )
    .unwrap();
    home.run_as(
        ALEX,
        C::Meal(EventKind::DinnerCookSet {
            date: date(20261006),
            member_id: Some(ActorId(SAM)),
        }),
    )
    .unwrap();
    // Outside the range.
    home.run_as(ALEX, meal(20261012, Planner::Lunch, "Later"))
        .unwrap();
    let state = home.state();
    let meals = meals_in(&state, date(20261005), date(20261011));
    assert_eq!(
        meals
            .iter()
            .map(|meal| (
                meal.date.encoded(),
                meal.slot,
                meal.name.as_str(),
                meal.cook
            ))
            .collect::<Vec<_>>(),
        vec![
            (20261006, MealSlot::Lunch, "Soup", None),
            (20261006, MealSlot::Snack, "Apples", None),
            (20261006, MealSlot::Dinner, "Tacos", Some(ActorId(SAM))),
            (20261007, MealSlot::Breakfast, "Porridge", None),
        ]
    );
}
