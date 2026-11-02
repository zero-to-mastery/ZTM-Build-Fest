// iCalendar import (#666): realistic Google, Apple and Outlook exports,
// RRULE mapping, time zones, bounds and malformed input. TEST-VECTORS
// 150–155.
use crate::calendar::*;
use crate::error::KinError;
use crate::event::{CalendarEventId, EventKind};
use crate::ical::*;
use crate::recurrence::CivilDate;

fn date(value: u32) -> CivilDate {
    CivilDate::from_encoded(value).unwrap()
}

fn at(value: u32, hour: u16, minute: u16) -> CalendarTime {
    CalendarTime::new(date(value), hour * 60 + minute).unwrap()
}

fn crlf(text: &str) -> Vec<u8> {
    text.replace('\n', "\r\n").into_bytes()
}

fn timed(start: CalendarTime, end: CalendarTime, zone: &str) -> Timing {
    Timing::Timed {
        start,
        end,
        zone: zone.into(),
    }
}

fn event(title: &str, timing: Timing) -> CalendarEvent {
    CalendarEvent {
        event_id: CalendarEventId([0; 16]),
        title: title.into(),
        place: String::new(),
        notes: String::new(),
        attendees: Vec::new(),
        countdown: false,
        source_uid: String::new(),
        timing,
        rule: None,
        link: None,
    }
}

fn rule(frequency: Frequency, by: MonthlyBy, weekdays: u8, week_start: u8, end: RuleEnd) -> Rule {
    Rule {
        frequency,
        interval: 1,
        by,
        weekdays,
        week_start,
        end,
    }
}

/// A Google Calendar export (CRLF, folded lines, a VTIMEZONE, a VALARM, an
/// override and a cancelled occurrence).
const GOOGLE: &str = "BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:Family
X-WR-TIMEZONE:Europe/London
BEGIN:VTIMEZONE
TZID:Europe/London
X-LIC-LOCATION:Europe/London
BEGIN:DAYLIGHT
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
TZNAME:BST
DTSTART:19700329T010000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
TZNAME:GMT
DTSTART:19701025T020000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=Europe/London:20261006T173000
DTEND;TZID=Europe/London:20261006T181500
RRULE:FREQ=WEEKLY;WKST=SU;COUNT=10;BYDAY=TU,TH
EXDATE;TZID=Europe/London:20261013T173000
DTSTAMP:20261001T120000Z
UID:5f1k2abc@google.com
CREATED:20260901T090000Z
DESCRIPTION:Bring goggles.\\nTowels at the desk. Lessons run for ten weeks
  and the pool closes at 19:00.
LAST-MODIFIED:20260901T090000Z
LOCATION:Leisure Centre\\, High Street
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Swimming
TRANSP:OPAQUE
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:This is an event reminder
TRIGGER:-P0DT0H30M0S
END:VALARM
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/London:20261015T183000
DTEND;TZID=Europe/London:20261015T191500
DTSTAMP:20261001T120000Z
UID:5f1k2abc@google.com
RECURRENCE-ID;TZID=Europe/London:20261015T173000
SUMMARY:Swimming (late)
SEQUENCE:1
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/London:20261020T173000
DTEND;TZID=Europe/London:20261020T181500
UID:5f1k2abc@google.com
RECURRENCE-ID;TZID=Europe/London:20261020T173000
STATUS:CANCELLED
SUMMARY:Swimming
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261224
DTEND;VALUE=DATE:20261228
DTSTAMP:20261001T120000Z
UID:trip@google.com
SUMMARY:Trip to Gran's
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20240301
DTEND;VALUE=DATE:20240302
RRULE:FREQ=YEARLY
UID:bday@google.com
SUMMARY:Sam's birthday
END:VEVENT
BEGIN:VEVENT
DTSTART:20261009T140000Z
DTEND:20261009T150000Z
UID:call@google.com
SUMMARY:Call with the bank
END:VEVENT
END:VCALENDAR
";

// 150
#[test]
fn a_google_export_imports() {
    let calendar = parse(&crlf(GOOGLE)).unwrap();
    assert_eq!(calendar.name, "Family");
    assert_eq!(calendar.skipped, 0);
    assert!(!calendar.truncated);
    assert_eq!(
        calendar.events.len(),
        5,
        "the cancelled override folds into the series"
    );

    let swim = &calendar.events[0];
    let mut expected = event(
        "Swimming",
        timed(at(20261006, 17, 30), at(20261006, 18, 15), "Europe/London"),
    );
    expected.place = "Leisure Centre, High Street".into();
    expected.notes =
        "Bring goggles.\nTowels at the desk. Lessons run for ten weeks and the pool closes at 19:00."
            .into();
    expected.source_uid = "5f1k2abc@google.com".into();
    expected.rule = Some(rule(
        Frequency::Weekly,
        MonthlyBy::None,
        0b0000_1010,
        6,
        RuleEnd::Count(10),
    ));
    assert_eq!(
        *swim,
        ImportedEvent {
            flags: 0,
            master: None,
            original: None,
            exdates: vec![at(20261013, 17, 30), at(20261020, 17, 30)],
            event: expected,
        }
    );

    let late = &calendar.events[1];
    assert_eq!(late.flags, FLAG_OVERRIDE);
    assert_eq!(late.master, Some(0));
    assert_eq!(late.original, Some(at(20261015, 17, 30)));
    assert_eq!(late.event.title, "Swimming (late)");
    assert_eq!(late.event.source_uid, "5f1k2abc@google.com");
    assert_eq!(late.event.start(), at(20261015, 18, 30));

    let trip = &calendar.events[2];
    assert_eq!(
        trip.event.timing,
        Timing::AllDay {
            start: date(20261224),
            end: date(20261227)
        },
        "DTEND is exclusive"
    );
    let birthday = &calendar.events[3];
    assert_eq!(
        birthday.event.rule,
        Some(rule(
            Frequency::Yearly,
            MonthlyBy::MonthDay(1),
            0,
            0,
            RuleEnd::Never
        ))
    );
    let call = &calendar.events[4];
    assert_eq!(
        call.event.timing,
        timed(at(20261009, 14, 0), at(20261009, 15, 0), "UTC")
    );
}

/// An Apple Calendar export (LF line endings, Apple's own properties, a
/// floating time with a DURATION).
const APPLE: &str = "BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//macOS 15.0//EN
CALSCALE:GREGORIAN
X-WR-CALNAME:Home
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:STANDARD
DTSTART:20071104T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZNAME:EST
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
CREATED:20260901T120000Z
UID:8C3E5A1B-2F44-4C1E-9D0A-6B7E1F2A3C4D
DTEND;TZID=America/New_York:20261102T090000
TRANSP:OPAQUE
X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC
SUMMARY:Piano lesson
LAST-MODIFIED:20260901T120000Z
DTSTAMP:20260901T120000Z
DTSTART;TZID=America/New_York:20261102T083000
SEQUENCE:0
RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=1MO
X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=70;X-TITLE=\"Music School: Room 2\":geo:40.7,-74.0
LOCATION:Music School\\n12 Main St
END:VEVENT
BEGIN:VEVENT
UID:4B1D9F70-THANKS
DTSTART;VALUE=DATE:20261126
DTEND;VALUE=DATE:20261127
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH
SUMMARY:Thanksgiving
END:VEVENT
BEGIN:VEVENT
UID:parkrun-apple
DTSTART:20261010T070000
DURATION:PT45M
SUMMARY:Park run
END:VEVENT
BEGIN:VEVENT
UID:mozilla-style
DTSTART;TZID=/mozilla.org/20050126_1/Europe/Paris:20261011T100000
DTEND;TZID=/mozilla.org/20050126_1/Europe/Paris:20261011T113000
SUMMARY:Brunch
END:VEVENT
END:VCALENDAR
";

// 151
#[test]
fn an_apple_export_imports() {
    let calendar = parse(APPLE.as_bytes()).unwrap();
    assert_eq!(calendar.name, "Home");
    assert_eq!(calendar.events.len(), 4);
    let piano = &calendar.events[0].event;
    assert_eq!(piano.title, "Piano lesson");
    assert_eq!(piano.place, "Music School 12 Main St", "one line");
    assert_eq!(
        piano.timing,
        timed(at(20261102, 8, 30), at(20261102, 9, 0), "America/New_York")
    );
    assert_eq!(
        piano.rule,
        Some(rule(
            Frequency::Monthly,
            MonthlyBy::NthWeekday { nth: 1, weekday: 0 },
            0,
            0,
            RuleEnd::Never
        ))
    );
    let thanksgiving = &calendar.events[1].event;
    assert_eq!(
        thanksgiving.rule,
        Some(rule(
            Frequency::Yearly,
            MonthlyBy::NthWeekday { nth: 4, weekday: 3 },
            0,
            0,
            RuleEnd::Never
        ))
    );
    let park = &calendar.events[2];
    assert_eq!(park.flags, 0, "floating is not an unknown zone");
    assert_eq!(
        park.event.timing,
        timed(at(20261010, 7, 0), at(20261010, 7, 45), "")
    );
    assert_eq!(
        calendar.events[3].event.timing,
        timed(at(20261011, 10, 0), at(20261011, 11, 30), "Europe/Paris")
    );
}

/// An Outlook export (quoted Windows zone names, BYSETPOS, a custom zone,
/// UNTIL as a UTC time, a LANGUAGE parameter).
const OUTLOOK: &str = "BEGIN:VCALENDAR
PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN
VERSION:2.0
METHOD:PUBLISH
X-MS-OLK-FORCEINSPECTOROPEN:TRUE
BEGIN:VTIMEZONE
TZID:Eastern Standard Time
BEGIN:STANDARD
DTSTART:16011104T020000
RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
CLASS:PUBLIC
CREATED:20260901T120000Z
DESCRIPTION:Quarterly check-in\\n\\n
DTEND;TZID=\"Eastern Standard Time\":20261013T110000
DTSTAMP:20260901T120000Z
DTSTART;TZID=\"Eastern Standard Time\":20261013T100000
LAST-MODIFIED:20260901T120000Z
LOCATION:Microsoft Teams Meeting
PRIORITY:5
RRULE:FREQ=MONTHLY;COUNT=6;BYDAY=TU;BYSETPOS=2
SEQUENCE:0
SUMMARY;LANGUAGE=en-us:School board
TRANSP:OPAQUE
UID:040000008200E00074C5B7101A82E00800000000A0B1C2D3E4F5
X-MICROSOFT-CDO-BUSYSTATUS:BUSY
EXDATE;TZID=\"Eastern Standard Time\":20261110T100000
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=\"Customized Time Zone\":20261020T150000
DTEND;TZID=\"Customized Time Zone\":20261020T160000
SUMMARY:Call with Ana
UID:outlook-2
END:VEVENT
BEGIN:VEVENT
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261030T120000Z
DTSTART;TZID=W. Europe Standard Time:20261019T080000
DTEND;TZID=W. Europe Standard Time:20261019T083000
SUMMARY:School run
UID:outlook-3
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=\"(UTC-08:00) Pacific Time (US & Canada)\":20261021T090000
DTEND;TZID=\"(UTC-08:00) Pacific Time (US & Canada)\":20261021T093000
SUMMARY:Stand-up
UID:outlook-4
END:VEVENT
END:VCALENDAR
";

// 152
#[test]
fn an_outlook_export_imports() {
    let calendar = parse(&crlf(OUTLOOK)).unwrap();
    assert_eq!(calendar.name, "");
    assert_eq!(calendar.events.len(), 4);
    let board = &calendar.events[0];
    assert_eq!(board.event.title, "School board");
    assert_eq!(board.event.notes, "Quarterly check-in");
    assert_eq!(
        board.event.timing,
        timed(at(20261013, 10, 0), at(20261013, 11, 0), "America/New_York")
    );
    assert_eq!(
        board.event.rule,
        Some(rule(
            Frequency::Monthly,
            MonthlyBy::NthWeekday { nth: 2, weekday: 1 },
            0,
            0,
            RuleEnd::Count(6)
        ))
    );
    assert_eq!(board.exdates, vec![at(20261110, 10, 0)]);
    let ana = &calendar.events[1];
    assert_eq!(ana.flags, FLAG_ZONE_UNKNOWN);
    assert_eq!(ana.event.zone(), "");
    let run = &calendar.events[2].event;
    assert_eq!(run.zone(), "Europe/Berlin");
    assert_eq!(
        run.rule,
        Some(rule(
            Frequency::Weekly,
            MonthlyBy::None,
            0b1_1111,
            0,
            RuleEnd::Until(date(20261030))
        ))
    );
    assert_eq!(calendar.events[3].event.zone(), "America/Los_Angeles");
}

// 153
#[test]
fn rules_map_onto_kins_subset_or_are_flagged() {
    let start = date(20261013); // a Tuesday
    let map = |text: &str| map_rule(text, start);
    assert_eq!(
        map("FREQ=DAILY;INTERVAL=2;UNTIL=20261101"),
        Some(Rule {
            interval: 2,
            ..rule(
                Frequency::Daily,
                MonthlyBy::None,
                0,
                0,
                RuleEnd::Until(date(20261101))
            )
        })
    );
    assert_eq!(
        map("FREQ=DAILY;BYDAY=MO,WE"),
        Some(rule(
            Frequency::Weekly,
            MonthlyBy::None,
            0b101,
            0,
            RuleEnd::Never
        )),
        "daily on weekdays is weekly"
    );
    assert_eq!(
        map("FREQ=WEEKLY"),
        Some(rule(
            Frequency::Weekly,
            MonthlyBy::None,
            0b10,
            0,
            RuleEnd::Never
        )),
        "the start's weekday"
    );
    assert_eq!(
        map("FREQ=MONTHLY;BYMONTHDAY=-1"),
        Some(rule(
            Frequency::Monthly,
            MonthlyBy::MonthDay(-1),
            0,
            0,
            RuleEnd::Never
        ))
    );
    assert_eq!(
        map("FREQ=MONTHLY"),
        Some(rule(
            Frequency::Monthly,
            MonthlyBy::MonthDay(13),
            0,
            0,
            RuleEnd::Never
        ))
    );
    assert_eq!(
        map("freq=monthly;byday=-1fr"),
        Some(rule(
            Frequency::Monthly,
            MonthlyBy::NthWeekday {
                nth: -1,
                weekday: 4
            },
            0,
            0,
            RuleEnd::Never
        )),
        "case-insensitive"
    );
    assert_eq!(
        map("FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=13"),
        Some(rule(
            Frequency::Yearly,
            MonthlyBy::MonthDay(13),
            0,
            0,
            RuleEnd::Never
        ))
    );
    assert_eq!(
        map("FREQ=WEEKLY;UNTIL=20200101T000000Z"),
        Some(rule(
            Frequency::Weekly,
            MonthlyBy::None,
            0b10,
            0,
            RuleEnd::Until(start)
        )),
        "an UNTIL before the start keeps the start"
    );
    for unsupported in [
        "FREQ=HOURLY",
        "FREQ=WEEKLY;BYDAY=1MO",
        "FREQ=DAILY;INTERVAL=2;BYDAY=MO",
        "FREQ=MONTHLY;BYMONTHDAY=1,15",
        "FREQ=MONTHLY;BYDAY=MO,TU",
        "FREQ=MONTHLY;BYDAY=6MO",
        "FREQ=YEARLY;BYMONTH=3",
        "FREQ=YEARLY;BYYEARDAY=100",
        "FREQ=DAILY;BYHOUR=9",
        "FREQ=DAILY;COUNT=1001",
        "FREQ=DAILY;COUNT=0",
        "FREQ=DAILY;COUNT=5;UNTIL=20261101",
        "FREQ=DAILY;INTERVAL=0",
        "FREQ=DAILY;FREQ=WEEKLY",
        "FREQ=WEEKLY;WKST=XX",
        "INTERVAL=2",
        "FREQ=DAILY;X-NAME=1",
        "FREQ",
        "",
    ] {
        assert_eq!(map(unsupported), None, "{unsupported}");
    }
    // An unsupported rule imports the first occurrence only, flagged.
    let text = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART:20261013T090000\nRRULE:FREQ=DAILY;BYHOUR=9,17\nSUMMARY:Pills\nEND:VEVENT\nEND:VCALENDAR\n";
    let calendar = parse(text.as_bytes()).unwrap();
    assert_eq!(calendar.events[0].flags, FLAG_RULE_UNSUPPORTED);
    assert_eq!(calendar.events[0].event.rule, None);

    // Zones.
    for (tzid, zone) in [
        ("Europe/London", Some("Europe/London")),
        (
            "\"America/Argentina/Buenos_Aires\"",
            Some("America/Argentina/Buenos_Aires"),
        ),
        (
            "/citadel.org/20190914_1/America/New_York",
            Some("America/New_York"),
        ),
        ("utc", Some("UTC")),
        ("GMT", Some("UTC")),
        ("Etc/GMT+12", Some("Etc/GMT+12")),
        ("eastern standard time", Some("America/New_York")),
        ("Tokyo Standard Time", Some("Asia/Tokyo")),
        (
            "(UTC+01:00) Brussels, Copenhagen, Madrid, Paris",
            Some("Europe/Paris"),
        ),
        ("Customized Time Zone", None),
        ("Mars/Olympus", None),
        ("", None),
    ] {
        assert_eq!(map_zone(tzid).as_deref(), zone, "{tzid}");
    }
}

/// A deterministic byte generator for the fuzz-style tests.
struct Noise(u64);

impl Noise {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// Every event a parse returns re-encodes as a valid kind-71 payload.
fn check(bytes: &[u8]) -> ImportedCalendar {
    let calendar = parse(bytes).unwrap();
    for imported in &calendar.events {
        let payload = encode_event_with(&imported.event, true).unwrap();
        assert_eq!(decode_event_with(&payload, true).unwrap(), imported.event);
        assert!(imported.exdates.windows(2).all(|pair| pair[0] < pair[1]));
        if let Some(master) = imported.master {
            assert!((master as usize) < calendar.events.len());
        }
    }
    assert!(parse_request(bytes).is_ok());
    calendar
}

// 154
#[test]
fn malformed_input_never_breaks_the_parse() {
    // Every truncation and many byte flips of the three samples.
    for sample in [crlf(GOOGLE), APPLE.as_bytes().to_vec(), crlf(OUTLOOK)] {
        for end in 0..sample.len() {
            check(&sample[..end]);
        }
        let mut noise = Noise(0x9e37_79b9_7f4a_7c15);
        for _ in 0..2_000 {
            let mut copy = sample.clone();
            for _ in 0..1 + noise.next() % 4 {
                let at = (noise.next() as usize) % copy.len();
                copy[at] = match noise.next() % 6 {
                    0 => b':',
                    1 => b';',
                    2 => b'\n',
                    3 => b'"',
                    4 => b'\\',
                    _ => noise.next() as u8,
                };
            }
            check(&copy);
        }
    }
    // Random bytes.
    let mut noise = Noise(42);
    for length in [0usize, 1, 7, 64, 1000, 20_000] {
        let bytes: Vec<u8> = (0..length).map(|_| noise.next() as u8).collect();
        check(&bytes);
    }
    // Specific shapes.
    let unterminated = check(b"BEGIN:VEVENT\nDTSTART:20261010\nSUMMARY:Open");
    assert_eq!(
        unterminated.events.len(),
        1,
        "an unterminated event still counts"
    );
    let no_start = check(b"BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:When?\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20261340\nEND:VEVENT\nEND:VCALENDAR\n");
    assert_eq!((no_start.events.len(), no_start.skipped), (0, 2));
    let mut deep = String::from("BEGIN:VCALENDAR\n");
    for _ in 0..40 {
        deep.push_str("BEGIN:X-NEST\n");
    }
    deep.push_str("BEGIN:VEVENT\nDTSTART:20261010\nEND:VEVENT\n");
    for _ in 0..40 {
        deep.push_str("END:X-NEST\n");
    }
    deep.push_str("BEGIN:VEVENT\nDTSTART:20261011\nUID:ok\nEND:VEVENT\nEND:VCALENDAR\n");
    let deep = check(deep.as_bytes());
    assert_eq!(deep.events.len(), 1, "an event nested too deep is skipped");
    assert_eq!(deep.events[0].event.start().date, date(20261011));
    let odd_lines = check(
        b"BEGIN:VEVENT\nno colon here\n:empty name\nDTSTART;TZID=\"unclosed:20261010T100000\nDTSTART;X=\"a;b:c\":20261010T100000\nSUMMARY:\\\\a\\;b\\,c\\Nd\\\nEND:VEVENT\nEND:NOTHING\n",
    );
    assert_eq!(odd_lines.events[0].event.title, "\\a;b,c d");
    assert_eq!(odd_lines.events[0].event.start(), at(20261010, 10, 0));
    let invalid_utf8 = check(b"BEGIN:VEVENT\nDTSTART:20261010\nSUMMARY:Caf\xe9\nEND:VEVENT\n");
    assert_eq!(invalid_utf8.events[0].event.title, "Caf\u{fffd}");
    let bom = check(b"\xef\xbb\xbfBEGIN:VCALENDAR\nX-WR-CALNAME:Kids\nEND:VCALENDAR\n");
    assert_eq!(bom.name, "Kids");
    // Text past Kin's limits is shortened at a character boundary.
    let long = format!(
        "BEGIN:VEVENT\nDTSTART:20261010\nSUMMARY:{}\nDESCRIPTION:{}\nUID:{}\nEND:VEVENT\n",
        "é".repeat(150),
        "x\\n".repeat(1500),
        "u".repeat(300)
    );
    let long = check(long.as_bytes());
    let imported = &long.events[0];
    assert_eq!(imported.flags, FLAG_TEXT_SHORTENED);
    assert_eq!(imported.event.title, "é".repeat(100));
    assert!(imported.event.notes.len() <= MAX_CALENDAR_NOTES_BYTES);
    assert_eq!(imported.event.source_uid.len(), 255);
    // A year-long all-day event and a negative duration.
    let spans = check(b"BEGIN:VEVENT\nDTSTART;VALUE=DATE:20260101\nDTEND;VALUE=DATE:20280101\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20261010T100000Z\nDURATION:-PT1H\nEND:VEVENT\n");
    assert_eq!(spans.events[0].flags, FLAG_SPAN_SHORTENED | FLAG_NO_TITLE);
    assert_eq!(spans.events[0].event.span_days(), MAX_SPAN_DAYS);
    assert_eq!(spans.events[0].event.title, UNTITLED);
    assert_eq!(
        spans.events[1].event.timing,
        timed(at(20261010, 10, 0), at(20261010, 10, 0), "UTC")
    );
    // Repeated UIDs: the first series wins, the rest are skipped.
    let twice = check(b"BEGIN:VEVENT\nUID:a\nDTSTART:20261010\nSUMMARY:One\nEND:VEVENT\nBEGIN:VEVENT\nUID:a\nDTSTART:20261011\nSUMMARY:Two\nEND:VEVENT\n");
    assert_eq!((twice.events.len(), twice.skipped), (1, 1));
    // An override without its series stands alone; EXDATEs that name no
    // occurrence are dropped.
    let orphan = check(b"BEGIN:VEVENT\nUID:gone\nRECURRENCE-ID:20261010T100000Z\nDTSTART:20261010T110000Z\nEND:VEVENT\nBEGIN:VEVENT\nUID:s\nDTSTART:20261010T100000Z\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE:20261011T100000Z,20261020T100000Z,garbage\nEND:VEVENT\n");
    assert_eq!(orphan.events[0].flags, FLAG_OVERRIDE | FLAG_NO_TITLE);
    assert_eq!(orphan.events[0].master, None);
    assert_eq!(orphan.events[1].exdates, vec![at(20261011, 10, 0)]);
    assert_eq!(orphan.events[1].flags, FLAG_NO_TITLE | FLAG_EXDATES_DROPPED);
}

#[test]
fn the_parse_is_bounded() {
    assert_eq!(
        parse(&vec![b' '; MAX_ICAL_BYTES + 1]),
        Err(KinError::SizeLimit)
    );
    assert!(parse(&vec![b'\n'; MAX_ICAL_BYTES]).is_ok());
    let mut many = String::from("BEGIN:VCALENDAR\n");
    for n in 0..=MAX_ICAL_EVENTS {
        many.push_str(&format!(
            "BEGIN:VEVENT\nUID:{n}\nDTSTART:20261010\nEND:VEVENT\n"
        ));
    }
    many.push_str("END:VCALENDAR\n");
    let calendar = parse(many.as_bytes()).unwrap();
    assert_eq!(calendar.events.len(), MAX_ICAL_EVENTS);
    assert!(calendar.truncated);
    assert_eq!(calendar.skipped, 1);
}

// 155
#[test]
fn kin_ical_parse_speaks_kics() {
    let text = "BEGIN:VCALENDAR\r\nX-WR-CALNAME:Kids\r\nBEGIN:VEVENT\r\nUID:bins\r\nDTSTART;VALUE=DATE:20261005\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\nEXDATE;VALUE=DATE:20261012\r\nSUMMARY:Bins\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:bins\r\nRECURRENCE-ID;VALUE=DATE:20261019\r\nDTSTART;VALUE=DATE:20261020\r\nSUMMARY:Bins (Tuesday)\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let out = parse_request(text.as_bytes()).unwrap();
    let mut bins = event(
        "Bins",
        Timing::AllDay {
            start: date(20261005),
            end: date(20261005),
        },
    );
    bins.source_uid = "bins".into();
    bins.rule = Some(rule(
        Frequency::Weekly,
        MonthlyBy::None,
        1,
        0,
        RuleEnd::Never,
    ));
    let mut moved = event(
        "Bins (Tuesday)",
        Timing::AllDay {
            start: date(20261020),
            end: date(20261020),
        },
    );
    moved.source_uid = "bins".into();

    let mut expected = b"KICS\x01\x00\x00\x00".to_vec();
    expected.extend_from_slice(&2u32.to_le_bytes());
    expected.extend_from_slice(&0u32.to_le_bytes());
    expected.extend_from_slice(&0u32.to_le_bytes());
    expected.extend_from_slice(&[4, 0]);
    expected.extend_from_slice(b"Kids");
    let first = encode_event_with(&bins, true).unwrap();
    expected.extend_from_slice(&0u32.to_le_bytes());
    expected.extend_from_slice(&u32::MAX.to_le_bytes());
    expected.extend_from_slice(&[0; 8]);
    expected.extend_from_slice(&[1, 0, 0, 0]);
    expected.extend_from_slice(&(first.len() as u32).to_le_bytes());
    expected.extend_from_slice(&20261012u32.to_le_bytes());
    expected.extend_from_slice(&[0; 4]);
    expected.extend_from_slice(&first);
    let second = encode_event_with(&moved, true).unwrap();
    expected.extend_from_slice(&FLAG_OVERRIDE.to_le_bytes());
    expected.extend_from_slice(&0u32.to_le_bytes());
    expected.extend_from_slice(&20261019u32.to_le_bytes());
    expected.extend_from_slice(&[0; 4]);
    expected.extend_from_slice(&[0, 0, 0, 0]);
    expected.extend_from_slice(&(second.len() as u32).to_le_bytes());
    expected.extend_from_slice(&second);
    assert_eq!(out, expected);
    assert_eq!(&first[..16], &[0; 16], "the host gives the ID");

    // A payload from the parse, given an ID, is a valid kind-71 event.
    let mut with_id = first.clone();
    with_id[..16].copy_from_slice(&[7; 16]);
    assert!(matches!(
        decode_payload(CALENDAR_EVENT_SAVED, &with_id),
        Ok(EventKind::CalendarEventSaved(_))
    ));
    assert_eq!(
        decode_event_payload(&first),
        Err(KinError::MalformedProtocol)
    );
    let empty = parse_request(b"\n").unwrap();
    assert_eq!(
        empty,
        b"KICS\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
    );
}
