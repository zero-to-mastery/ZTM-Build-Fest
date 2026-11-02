// "This week" (#417): the KWKQ / KWKD projection of items, routine
// occurrences, dinners and maintenance over seven civil days.
use crate::codec::encode_event;
use crate::command::{execute, CommandContext, HouseholdCommand as C};
use crate::error::KinError;
use crate::event::*;
use crate::history::History;
use crate::recurrence::{Cadence, CivilDate};
use crate::request::DecodedRequest;
use crate::state::{rebuild, HouseholdState};
use crate::test_support::*;
use crate::week::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const ADULT: [u8; 16] = [1; 16];
const KID: [u8; 16] = [2; 16];
const AS_OF: i64 = 1_791_475_200_100;

fn date(value: u32) -> CivilDate {
    CivilDate::from_encoded(value).unwrap()
}

fn request(events: &[EventEnvelope], civil_date: u32) -> DecodedRequest {
    DecodedRequest {
        events: events.to_vec(),
        as_of: AS_OF,
        summary_cursor: None,
        civil_date: date(civil_date),
        target_household_id: None,
        identity_bindings: vec![],
    }
}

/// A household whose commands run at a chosen civil date.
struct Household {
    events: Vec<EventEnvelope>,
    next: u32,
    today: u32,
}

impl Household {
    fn new(today: u32) -> Self {
        Self {
            events: Vec::new(),
            next: 1,
            today,
        }
    }

    fn run(&mut self, command: C) {
        let n = self.next;
        let context = CommandContext {
            event_id: EventId(numbered_id(5000 + n)),
            household_id: HouseholdId(HOUSEHOLD),
            actor_id: ActorId(ADULT),
            device_id: DeviceId([0x11; 16]),
            timestamp: 1_791_475_200_000,
            logical_time: u64::from(n),
        };
        let result = execute(&command, context, request(&self.events, self.today))
            .unwrap_or_else(|error| panic!("{command:?}: {error:?}"));
        self.events.push(result.event);
        self.next += 1;
    }

    fn item(&mut self, id: u32, text: &str, classification: ItemClassification, on: Option<u32>) {
        self.run(C::AddItem {
            id: ItemId(numbered_id(id)),
            text: text.into(),
            classification,
        });
        if let Some(on) = on {
            self.run(C::SetItemPlanningDate {
                item_id: ItemId(numbered_id(id)),
                planning_date: Some(date(on)),
            });
        }
    }

    fn routine(&mut self, id: u32, text: &str, cadence: Cadence) {
        self.run(C::CreateRoutine {
            id: RoutineId(numbered_id(id)),
            text: text.into(),
            cadence,
            created_on: date(self.today),
        });
    }

    fn assign(&mut self, kind: ResponsibilityTargetKind, target: u32, member: [u8; 16]) {
        self.run(C::ChangeResponsibility {
            target_kind: kind,
            target_id: numbered_id(target),
            member_id: Some(ActorId(member)),
        });
    }

    fn state_on(&self, civil_date: u32) -> HouseholdState {
        rebuild(&self.events, AS_OF, date(civil_date)).unwrap()
    }

    fn week(&self, civil_date: u32, start: u32) -> Week {
        week(&self.state_on(civil_date), date(start)).unwrap()
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

fn dates(week: &Week) -> Vec<u32> {
    week.days.iter().map(|day| day.date.encoded()).collect()
}

/// Per day, the routines as (ID number byte, occurrence key).
fn occurrences(week: &Week, id: u32) -> Vec<(u32, u32)> {
    week.days
        .iter()
        .flat_map(|day| {
            day.routines
                .iter()
                .filter(|routine| routine.routine_id == numbered_id(id))
                .map(|routine| (day.date.encoded(), routine.occurrence.encoded()))
        })
        .collect()
}

#[test]
fn seven_days_cross_month_and_year_boundaries() {
    let home = Household::new(20261229);
    let week = home.week(20261229, 20261229);
    assert_eq!(
        dates(&week),
        [20261229, 20261230, 20261231, 20270101, 20270102, 20270103, 20270104]
    );
    let leap = home.week(20261229, 20280226);
    assert_eq!(
        dates(&leap),
        [20280226, 20280227, 20280228, 20280229, 20280301, 20280302, 20280303]
    );
    assert!(week.days.iter().all(|day| day.items.is_empty()
        && day.routines.is_empty()
        && day.meals.is_empty()
        && day.maintenance.is_empty()
        && day.omitted == 0));
    // The last full week before 9999-12-31 is fine; one more day is not.
    let state = home.state_on(20261229);
    assert!(week_fn(&state, 99991225).is_ok());
    assert_eq!(week_fn(&state, 99991226), Err(KinError::MalformedProtocol));
}

fn week_fn(state: &HouseholdState, start: u32) -> Result<Week, KinError> {
    week(state, date(start))
}

#[test]
fn items_by_planning_date_without_overdue_undated_or_closed_ones() {
    let mut home = Household::new(20261005);
    home.item(1, "Overdue", ItemClassification::Need, Some(20261004));
    home.item(2, "Zoo tickets", ItemClassification::Today, Some(20261005));
    home.item(3, "Apples", ItemClassification::Shopping, Some(20261005));
    home.item(4, "Last day", ItemClassification::Need, Some(20261011));
    home.item(5, "Next week", ItemClassification::Need, Some(20261012));
    home.item(6, "Undated", ItemClassification::Need, None);
    home.item(7, "Done", ItemClassification::Need, Some(20261006));
    home.run(C::CompleteItem(ItemId(numbered_id(7))));
    home.item(8, "Gone", ItemClassification::Need, Some(20261006));
    home.run(C::ArchiveItem(ItemId(numbered_id(8))));
    home.assign(ResponsibilityTargetKind::Item, 2, KID);
    home.assign(ResponsibilityTargetKind::Item, 3, ADULT);
    home.run(C::ChangeResponsibility {
        target_kind: ResponsibilityTargetKind::Item,
        target_id: numbered_id(3),
        member_id: None,
    });

    let week = home.week(20261005, 20261005);
    assert_eq!(
        week.days[0].items,
        vec![
            WeekItem {
                item_id: ItemId(numbered_id(3)),
                classification: ItemClassification::Shopping,
                owner: None,
            },
            WeekItem {
                item_id: ItemId(numbered_id(2)),
                classification: ItemClassification::Today,
                owner: Some(ActorId(KID)),
            },
        ],
        "by text; the latest responsibility wins"
    );
    assert!(week.days[1].items.is_empty(), "completed and archived");
    assert_eq!(
        week.days[6]
            .items
            .iter()
            .map(|item| item.item_id)
            .collect::<Vec<_>>(),
        vec![ItemId(numbered_id(4))]
    );
    let total: usize = week.days.iter().map(|day| day.items.len()).sum();
    assert_eq!(total, 3, "no overdue, undated or next-week items");

    // Reopened, a completed item is back.
    home.run(C::ReopenItem(ItemId(numbered_id(7))));
    assert_eq!(home.week(20261005, 20261005).days[1].items.len(), 1);
}

#[test]
fn daily_and_weekdays_routines_across_a_weekend() {
    // 2026-10-02 is a Friday.
    let mut home = Household::new(20261002);
    home.routine(10, "Feed cat", Cadence::Daily);
    home.routine(11, "School run", Cadence::Weekdays);
    let week = home.week(20261002, 20261002);
    assert_eq!(
        occurrences(&week, 10),
        (0..7)
            .map(|offset| {
                let day = date(20261002).checked_add_days(offset).unwrap().encoded();
                (day, day)
            })
            .collect::<Vec<_>>()
    );
    assert_eq!(
        occurrences(&week, 11),
        vec![
            (20261002, 20261002),
            (20261005, 20261005),
            (20261006, 20261006),
            (20261007, 20261007),
            (20261008, 20261008),
        ],
        "no Saturday or Sunday occurrence"
    );
    // Starting on the Saturday: nothing until Monday.
    let weekend = home.week(20261002, 20261003);
    assert_eq!(occurrences(&weekend, 11)[0], (20261005, 20261005));
    assert_eq!(occurrences(&weekend, 11).len(), 5);
}

#[test]
fn weekly_biweekly_and_monthly_occurrences_open_on_their_period_start() {
    // Created Wednesday 2026-12-23.
    let mut home = Household::new(20261223);
    home.routine(20, "Bins", Cadence::Weekly);
    home.routine(21, "Sheets", Cadence::Biweekly);
    home.routine(22, "Budget", Cadence::Monthly);

    // Week from Tuesday 2026-12-29: the open occurrences show on the start
    // date, and each new one on the day it opens.
    let week = home.week(20261229, 20261229);
    assert_eq!(
        occurrences(&week, 20),
        vec![(20261229, 20261228), (20270104, 20270104)]
    );
    assert_eq!(occurrences(&week, 21), vec![(20261229, 20261223)]);
    assert_eq!(
        occurrences(&week, 22),
        vec![(20261229, 20261201), (20270101, 20270101)],
        "a new month across the year boundary"
    );
    // Biweekly: the next period opens two weeks after creation.
    let later = home.week(20261229, 20270103);
    assert_eq!(
        occurrences(&later, 21),
        vec![(20270103, 20261223), (20270106, 20270106)]
    );
    // Before the routine exists it has no occurrence; it shows from creation.
    let before = home.week(20261229, 20261220);
    assert_eq!(occurrences(&before, 20), vec![(20261223, 20261221)]);
    assert_eq!(occurrences(&before, 22), vec![(20261223, 20261201)]);
}

#[test]
fn completion_is_reported_for_the_current_occurrence_only() {
    let mut home = Household::new(20261005);
    home.routine(10, "Feed cat", Cadence::Daily);
    home.routine(20, "Bins", Cadence::Weekly);
    home.assign(ResponsibilityTargetKind::Routine, 20, KID);
    home.run(C::CompleteOccurrence {
        id: RoutineId(numbered_id(10)),
        key: date(20261005),
    });
    home.run(C::CompleteOccurrence {
        id: RoutineId(numbered_id(20)),
        key: date(20261005),
    });
    let week = home.week(20261005, 20261005);
    let feed: Vec<&WeekRoutine> = week
        .days
        .iter()
        .flat_map(|day| &day.routines)
        .filter(|routine| routine.routine_id == numbered_id(10))
        .collect();
    assert_eq!(feed.len(), 7);
    assert!(feed[0].current && feed[0].done);
    assert!(feed[1..]
        .iter()
        .all(|routine| !routine.current && !routine.done));
    let bins = &week.days[0].routines;
    assert_eq!(bins.len(), 2);
    assert_eq!(
        bins[0],
        WeekRoutine {
            routine_id: numbered_id(20),
            occurrence: date(20261005),
            cadence: Cadence::Weekly,
            current: true,
            done: true,
            owner: Some(ActorId(KID)),
        },
        "routines sort by text"
    );
    // Viewed a day later the daily occurrence of the 5th is past and not in
    // a week from the 6th; the weekly one is still the open one.
    let tomorrow = home.week(20261006, 20261006);
    assert!(!tomorrow.days[0].routines.iter().any(
        |routine| routine.occurrence == date(20261005) && routine.routine_id == numbered_id(10)
    ));
    assert!(tomorrow.days[0]
        .routines
        .iter()
        .any(|routine| routine.routine_id == numbered_id(20) && routine.done));
    // Reopened: not done.
    home.run(C::ReopenOccurrence {
        id: RoutineId(numbered_id(20)),
        key: date(20261005),
    });
    assert!(!home.week(20261005, 20261005).days[0].routines[0].done);
}

#[test]
fn archived_routines_and_paused_modes_produce_no_occurrences() {
    let mut home = Household::new(20261005);
    home.routine(10, "Feed cat", Cadence::Daily);
    home.routine(11, "Water plants", Cadence::Daily);
    home.run(C::ArchiveRoutine(RoutineId(numbered_id(11))));
    let week = home.week(20261005, 20261005);
    assert!(!week.routines_paused);
    assert_eq!(occurrences(&week, 10).len(), 7);
    assert!(occurrences(&week, 11).is_empty());

    home.item(1, "Still planned", ItemClassification::Need, Some(20261006));
    for mode in [
        HouseholdMode::Vacation,
        HouseholdMode::Guests,
        HouseholdMode::Rest,
    ] {
        home.run(C::SetHouseholdMode(mode));
        let paused = home.week(20261005, 20261005);
        assert!(paused.routines_paused, "{mode:?}");
        assert!(
            paused.days.iter().all(|day| day.routines.is_empty()),
            "{mode:?}"
        );
        assert_eq!(paused.days[1].items.len(), 1, "items are not paused");
    }
    home.run(C::SetHouseholdMode(HouseholdMode::Normal));
    assert_eq!(occurrences(&home.week(20261005, 20261005), 10).len(), 7);
}

fn dinner(on: u32, recipe: Option<u32>, name: &str) -> C {
    C::Meal(EventKind::DinnerSet {
        date: date(on),
        recipe_id: recipe.map(|id| RecipeId(numbered_id(id))),
        name: name.into(),
    })
}

#[test]
fn dinners_show_on_their_day_with_the_cook() {
    let mut home = Household::new(20261005);
    home.run(C::Meal(EventKind::RecipeSaved {
        recipe_id: RecipeId(numbered_id(40)),
        name: "Tacos".into(),
        ingredients: vec![],
        notes: String::new(),
    }));
    home.run(dinner(20261004, None, "Before the week"));
    home.run(dinner(20261005, Some(40), "Tacos"));
    home.run(dinner(20261007, None, "Leftovers"));
    home.run(dinner(20261009, None, "Pizza"));
    home.run(C::Meal(EventKind::DinnerCleared {
        date: date(20261009),
    }));
    home.run(C::Meal(EventKind::DinnerCookSet {
        date: date(20261005),
        member_id: Some(ActorId(KID)),
    }));
    home.run(C::Meal(EventKind::RecipeSaved {
        recipe_id: RecipeId(numbered_id(40)),
        name: "Fish tacos".into(),
        ingredients: vec![],
        notes: String::new(),
    }));
    let week = home.week(20261005, 20261005);
    assert_eq!(
        week.days[0].meals,
        vec![WeekMeal {
            recipe_id: Some(numbered_id(40)),
            cook: Some(ActorId(KID)),
            name: "Fish tacos".into(),
        }],
        "the recipe's current name"
    );
    assert_eq!(
        week.days[2].meals,
        vec![WeekMeal {
            recipe_id: None,
            cook: None,
            name: "Leftovers".into(),
        }]
    );
    let planned: Vec<u32> = week
        .days
        .iter()
        .filter(|day| !day.meals.is_empty())
        .map(|day| day.date.encoded())
        .collect();
    assert_eq!(
        planned,
        vec![20261005, 20261007],
        "cleared and earlier dinners"
    );
}

fn reference(id: u32, title: &str) -> C {
    C::SaveReferenceRecord {
        id: ReferenceRecordId(numbered_id(id)),
        title: title.into(),
        area_id: None,
        fields: vec![(
            ReferenceFieldId(numbered_id(id + 1000)),
            "Model".into(),
            "A1".into(),
        )],
    }
}

fn maintenance(id: u32, record: u32, summary: &str, next_on: Option<u32>) -> C {
    C::SaveMaintenanceEvent {
        id: MaintenanceEventId(numbered_id(id)),
        record_id: ReferenceRecordId(numbered_id(record)),
        performed_on: date(20260901),
        summary: summary.into(),
        next_on: next_on.map(date),
        routine_id: None,
    }
}

#[test]
fn maintenance_shows_on_its_next_date() {
    let mut home = Household::new(20261005);
    home.run(reference(50, "Furnace"));
    home.run(reference(51, "Old car"));
    home.run(maintenance(60, 50, "Filter", Some(20261007)));
    home.run(maintenance(61, 50, "Annual service", Some(20261007)));
    home.run(maintenance(62, 50, "No next date", None));
    home.run(maintenance(63, 50, "Archived", Some(20261007)));
    home.run(C::ArchiveMaintenanceEvent(MaintenanceEventId(numbered_id(
        63,
    ))));
    home.run(maintenance(64, 51, "Record archived", Some(20261007)));
    home.run(C::ArchiveReferenceRecord(ReferenceRecordId(numbered_id(
        51,
    ))));
    home.run(maintenance(65, 50, "Overdue", Some(20261004)));
    home.run(maintenance(66, 50, "Next week", Some(20261012)));
    let week = home.week(20261005, 20261005);
    assert_eq!(
        week.days[2].maintenance,
        vec![
            WeekMaintenance {
                maintenance_id: numbered_id(61),
                record_id: numbered_id(50),
                performed_on: date(20260901),
            },
            WeekMaintenance {
                maintenance_id: numbered_id(60),
                record_id: numbered_id(50),
                performed_on: date(20260901),
            },
        ],
        "by summary"
    );
    let total: usize = week.days.iter().map(|day| day.maintenance.len()).sum();
    assert_eq!(total, 2);
}

#[test]
fn caps_bound_each_day_and_count_what_they_drop() {
    let mut home = Household::new(20261005);
    let extra = 6;
    for n in 0..(MAX_WEEK_ITEMS_PER_DAY as u32 + extra) {
        home.item(
            100 + n,
            &format!("Item {n:03}"),
            ItemClassification::Need,
            Some(20261006),
        );
    }
    let week = home.week(20261005, 20261005);
    let day = &week.days[1];
    assert_eq!(day.items.len(), MAX_WEEK_ITEMS_PER_DAY);
    assert_eq!(day.omitted, extra);
    assert_eq!(
        day.items[0].item_id,
        ItemId(numbered_id(100)),
        "the first by text stay"
    );
    assert_eq!(
        day.items[MAX_WEEK_ITEMS_PER_DAY - 1].item_id,
        ItemId(numbered_id(100 + MAX_WEEK_ITEMS_PER_DAY as u32 - 1))
    );
    let bytes = encode_week(&week);
    // Header 16, day 0 header 12, then day 1's header.
    assert_eq!(&bytes[28..32], &20261006u32.to_le_bytes());
    assert_eq!(
        &bytes[32..34],
        &(MAX_WEEK_ITEMS_PER_DAY as u16).to_le_bytes()
    );
    assert_eq!(&bytes[38..40], &(extra as u16).to_le_bytes());
}

#[test]
fn the_same_log_and_date_give_the_same_bytes() {
    let mut home = Household::new(20261005);
    home.item(1, "B", ItemClassification::Need, Some(20261006));
    home.item(2, "A", ItemClassification::Need, Some(20261006));
    home.routine(10, "Feed cat", Cadence::Daily);
    let first = encode_week(&home.week(20261005, 20261005));
    let mut reversed = Household::new(20261005);
    reversed.item(2, "A", ItemClassification::Need, Some(20261006));
    reversed.item(1, "B", ItemClassification::Need, Some(20261006));
    reversed.routine(10, "Feed cat", Cadence::Daily);
    assert_eq!(encode_week(&reversed.week(20261005, 20261005)), first);
}

#[test]
fn the_export_speaks_kwkq_and_kwkd() {
    let mut home = Household::new(20261005);
    home.item(1, "Dentist", ItemClassification::Today, Some(20261005));
    home.assign(ResponsibilityTargetKind::Item, 1, KID);
    home.routine(10, "Bins", Cadence::Weekly);
    home.run(C::CompleteOccurrence {
        id: RoutineId(numbered_id(10)),
        key: date(20261005),
    });
    home.run(dinner(20261006, None, "Soup"));
    home.run(reference(50, "Furnace"));
    home.run(maintenance(60, 50, "Filter", Some(20261011)));
    let mut history = home.history();
    let context = kine(&[], AS_OF, 20261005, None);
    let mut query = b"KWKQ\x01\x00\x00\x00".to_vec();
    query.extend_from_slice(&20261005u32.to_le_bytes());
    query.extend_from_slice(&[0; 4]);
    query.extend_from_slice(&context);
    let out = week_export(&query, &mut history).unwrap();

    let mut expected = b"KWKD\x01\x00\x00\x00".to_vec();
    expected.extend_from_slice(&20261005u32.to_le_bytes());
    expected.extend_from_slice(&[7, 0, 0, 0]);
    // Day 1: one item, one routine.
    expected.extend_from_slice(&20261005u32.to_le_bytes());
    expected.extend_from_slice(&[1, 0, 1, 0, 0, 0, 0, 0]);
    expected.extend_from_slice(&numbered_id(1));
    expected.extend_from_slice(&[0, 1, 0, 0]);
    expected.extend_from_slice(&KID);
    expected.extend_from_slice(&numbered_id(10));
    expected.extend_from_slice(&20261005u32.to_le_bytes());
    expected.extend_from_slice(&[1, 0b110, 0, 0]);
    expected.extend_from_slice(&[0; 16]);
    // Day 2: the dinner.
    expected.extend_from_slice(&20261006u32.to_le_bytes());
    expected.extend_from_slice(&[0, 0, 0, 0, 1, 0, 0, 0]);
    expected.extend_from_slice(&[0; 4]);
    expected.extend_from_slice(&[0; 32]);
    expected.extend_from_slice(&[4, 0]);
    expected.extend_from_slice(b"Soup");
    // Days 3-6: empty.
    for day in [20261007u32, 20261008, 20261009, 20261010] {
        expected.extend_from_slice(&day.to_le_bytes());
        expected.extend_from_slice(&[0; 8]);
    }
    // Day 7: the maintenance entry.
    expected.extend_from_slice(&20261011u32.to_le_bytes());
    expected.extend_from_slice(&[0, 0, 0, 0, 0, 1, 0, 0]);
    expected.extend_from_slice(&numbered_id(60));
    expected.extend_from_slice(&numbered_id(50));
    expected.extend_from_slice(&20260901u32.to_le_bytes());
    assert_eq!(out, expected);

    // A paused household sets the header flag.
    home.run(C::SetHouseholdMode(HouseholdMode::Rest));
    let mut paused_history = home.history();
    let paused = week_export(&query, &mut paused_history).unwrap();
    assert_eq!(paused[13], 1);

    let mut bad = query.clone();
    bad[4] = 2;
    assert_eq!(
        week_export(&bad, &mut history),
        Err(KinError::UnsupportedVersion)
    );
    for (offset, value) in [(0, b'X'), (6, 1), (12, 1), (15, 1)] {
        let mut bad = query.clone();
        bad[offset] = value;
        assert_eq!(
            week_export(&bad, &mut history),
            Err(KinError::MalformedProtocol),
            "byte {offset}"
        );
    }
    for start in [0u32, 20261301, 20260230, 99991226] {
        let mut bad = query.clone();
        bad[8..12].copy_from_slice(&start.to_le_bytes());
        assert_eq!(
            week_export(&bad, &mut history),
            Err(KinError::MalformedProtocol),
            "{start}"
        );
    }
    assert_eq!(
        week_export(&query[..15], &mut history),
        Err(KinError::MalformedProtocol)
    );
}
