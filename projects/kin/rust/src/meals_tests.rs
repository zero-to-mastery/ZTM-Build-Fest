// Meals (#333, ADR 0012): recipes, dinners and cooks (kinds 59–63), their
// canonical payloads, replay and merge rules, command checks, the Shopping
// plan and the KMLS / KMSP encodings.
use crate::codec::encode_event;
use crate::command::{decode_command, execute, CommandContext, HouseholdCommand as C};
use crate::core::meal_shopping_plan;
use crate::error::KinError;
use crate::event::*;
use crate::event_decode::decode_event;
use crate::history::History;
use crate::meals::*;
use crate::recurrence::CivilDate;
use crate::request::DecodedRequest;
use crate::state::{rebuild, HouseholdState, ItemStatus};
use crate::test_support::*;

const HOUSEHOLD: [u8; 16] = [0xaa; 16];
const ADULT: [u8; 16] = [1; 16];
const KID: [u8; 16] = [2; 16];

fn date(value: u32) -> CivilDate {
    CivilDate::from_encoded(value).unwrap()
}

fn context(event: u32, actor: [u8; 16], device: u8, logical_time: u64) -> CommandContext {
    CommandContext {
        event_id: EventId(numbered_id(event)),
        household_id: HouseholdId(HOUSEHOLD),
        actor_id: ActorId(actor),
        device_id: DeviceId([device; 16]),
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

/// A history built through commands, as a device would write it.
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
        self.run_on(command, 0x11)
    }

    fn run_on(&mut self, command: C, device: u8) -> Result<(), KinError> {
        let n = self.next;
        let result = execute(
            &command,
            context(1000 + n, ADULT, device, u64::from(n)),
            request(&self.events),
        )?;
        // Every event a command makes survives its wire form exactly.
        let bytes = encode_event(&result.event).unwrap();
        assert_eq!(decode_event(&bytes).unwrap(), result.event);
        self.events.push(result.event);
        self.next += 1;
        Ok(())
    }

    fn meal(&mut self, kind: EventKind) -> Result<(), KinError> {
        self.run(C::Meal(kind))
    }

    fn state(&self) -> HouseholdState {
        rebuild(&self.events, 1_791_475_200_100, date(TEST_DATE)).unwrap()
    }
}

fn ingredient(text: &str) -> Ingredient {
    Ingredient {
        text: text.into(),
        staple_id: None,
    }
}

fn linked(text: &str, staple: u32) -> Ingredient {
    Ingredient {
        text: text.into(),
        staple_id: Some(ItemId(numbered_id(staple))),
    }
}

fn recipe(id: u32, name: &str, ingredients: Vec<Ingredient>) -> EventKind {
    EventKind::RecipeSaved {
        recipe_id: RecipeId(numbered_id(id)),
        name: name.into(),
        ingredients,
        notes: String::new(),
    }
}

fn add_item(id: u32, text: &str, classification: ItemClassification) -> C {
    C::AddItem {
        id: ItemId(numbered_id(id)),
        text: text.into(),
        classification,
    }
}

fn dinner(on: u32, recipe: Option<u32>, name: &str) -> EventKind {
    EventKind::DinnerSet {
        date: date(on),
        recipe_id: recipe.map(|id| RecipeId(numbered_id(id))),
        name: name.into(),
    }
}

#[test]
fn every_meals_payload_round_trips_and_only_canonical_bytes_decode() {
    let kinds = [
        EventKind::RecipeSaved {
            recipe_id: RecipeId(numbered_id(7)),
            name: "Tacos".into(),
            ingredients: vec![linked("Tortillas", 3), ingredient("Salsa verde")],
            notes: "Serves 4\nhttps://example.org/tacos".into(),
        },
        recipe(8, "Soup", vec![]),
        EventKind::RecipeArchived {
            recipe_id: RecipeId(numbered_id(7)),
        },
        dinner(20261005, Some(7), "Tacos"),
        dinner(20261006, None, "Leftovers"),
        EventKind::DinnerCleared {
            date: date(20261006),
        },
        EventKind::DinnerCookSet {
            date: date(20261005),
            member_id: Some(ActorId(KID)),
        },
        EventKind::DinnerCookSet {
            date: date(20261005),
            member_id: None,
        },
    ];
    for kind in kinds {
        let code = crate::codec::kind_code(&kind);
        assert!(is_meals_code(code));
        let payload = encode_payload(&kind).unwrap();
        assert_eq!(decode_payload(code, &payload).unwrap(), kind);
        // Anything trailing, and any non-zero reserved flag byte, is refused.
        let mut longer = payload.clone();
        longer.push(0);
        assert!(decode_payload(code, &longer).is_err());
    }
    // Non-canonical text: padding, doubled spaces, a control character.
    for name in [" Tacos", "Taco  night", "Tacos\u{7}"] {
        let kind = recipe(9, name, vec![]);
        assert_eq!(encode_payload(&kind), Err(KinError::MalformedProtocol));
        let mut payload = numbered_id(9).to_vec();
        payload.extend_from_slice(&(name.len() as u16).to_le_bytes());
        payload.extend_from_slice(name.as_bytes());
        payload.extend_from_slice(&[0, 0, 0, 0]);
        assert!(decode_payload(RECIPE_SAVED, &payload).is_err(), "{name:?}");
    }
    // A zero ID or an invalid date.
    assert!(encode_payload(&recipe(0, "Soup", vec![])).is_err());
    assert!(decode_payload(DINNER_CLEARED, &20261332u32.to_le_bytes()).is_err());
    // A flag word must be 0 or 1 with three zero bytes.
    let mut cook = 20261005u32.to_le_bytes().to_vec();
    cook.extend_from_slice(&[0, 1, 0, 0]);
    assert!(decode_payload(DINNER_COOK_SET, &cook).is_err());
}

#[test]
fn recipe_limits_and_notes_keep_their_lines() {
    assert_eq!(normalize_notes("  one  \r\ntwo\n\n").unwrap(), "one\ntwo");
    assert_eq!(collapse("  red \t onions "), "red onions");
    assert_eq!(shopping_key("Red  ONIONS"), "red onions");
    let too_many: Vec<Ingredient> = (0..=MAX_RECIPE_INGREDIENTS)
        .map(|n| ingredient(&format!("Thing {n}")))
        .collect();
    assert!(normalize_recipe("Feast", &too_many, "").is_err());
    assert!(normalize_recipe(&"x".repeat(MAX_RECIPE_NAME_CHARS + 1), &[], "").is_err());
    assert!(normalize_recipe(
        "Soup",
        &[ingredient(&"y".repeat(MAX_INGREDIENT_CHARS + 1))],
        ""
    )
    .is_err());
    assert!(normalize_notes(&"z".repeat(MAX_RECIPE_NOTES_CHARS + 1)).is_err());
    // Within every field limit but over the whole-recipe budget: refused, so
    // one recipe always fits one sync envelope.
    let wide: Vec<Ingredient> = (0..MAX_RECIPE_INGREDIENTS)
        .map(|n| ingredient(&format!("{n:03} {}", "é".repeat(60))))
        .collect();
    let kind = EventKind::RecipeSaved {
        recipe_id: RecipeId(numbered_id(1)),
        name: "Big".into(),
        ingredients: wide,
        notes: "n".repeat(MAX_RECIPE_NOTES_CHARS),
    };
    assert_eq!(encode_payload(&kind), Err(KinError::SizeLimit));
}

#[test]
fn recipes_save_whole_archive_for_good_and_dinners_follow_the_latest_event() {
    let mut home = Household::new();
    home.meal(recipe(1, "Tacos", vec![ingredient("Tortillas")]))
        .unwrap();
    home.meal(recipe(
        1,
        "Fish tacos",
        vec![ingredient("Tortillas"), ingredient("Fish")],
    ))
    .unwrap();
    home.meal(dinner(20261005, Some(1), "Fish tacos")).unwrap();
    let state = home.state();
    assert_eq!(state.meals.recipes.len(), 1);
    assert_eq!(state.meals.recipes[0].ingredients.len(), 2);
    // A dinner must name the recipe as it is now, and must change something.
    assert_eq!(
        home.meal(dinner(20261006, Some(1), "Tacos")),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        home.meal(dinner(20261005, Some(1), "Fish tacos")),
        Err(KinError::InvalidEvent)
    );
    // A one-off replaces the recipe dinner for that date.
    home.meal(dinner(20261005, None, "Pizza night")).unwrap();
    assert_eq!(home.state().meals.dinners[&20261005].name, "Pizza night");
    // Archiving: once only, and it can't be saved or planned after.
    home.meal(dinner(20261007, Some(1), "Fish tacos")).unwrap();
    home.meal(EventKind::RecipeArchived {
        recipe_id: RecipeId(numbered_id(1)),
    })
    .unwrap();
    assert_eq!(
        home.meal(EventKind::RecipeArchived {
            recipe_id: RecipeId(numbered_id(1))
        }),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        home.meal(recipe(1, "Again", vec![])),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        home.meal(dinner(20261008, Some(1), "Fish tacos")),
        Err(KinError::InvalidEvent)
    );
    // The planned dinner keeps reading right from its snapshot.
    let state = home.state();
    assert_eq!(
        state.meals.dinner_name(&state.meals.dinners[&20261007]),
        "Fish tacos"
    );
}

#[test]
fn the_cook_needs_a_dinner_survives_replanning_and_goes_with_a_clear() {
    let mut home = Household::new();
    let cook = |member: Option<[u8; 16]>| EventKind::DinnerCookSet {
        date: date(20261005),
        member_id: member.map(ActorId),
    };
    assert_eq!(
        home.meal(cook(Some(KID))),
        Err(KinError::InvalidEvent),
        "no dinner yet"
    );
    home.meal(dinner(20261005, None, "Soup")).unwrap();
    home.meal(cook(Some(KID))).unwrap();
    assert_eq!(
        home.meal(cook(Some(KID))),
        Err(KinError::InvalidEvent),
        "no change"
    );
    home.meal(dinner(20261005, None, "Stew")).unwrap();
    assert_eq!(
        home.state().meals.cooks.get(&20261005),
        Some(&ActorId(KID)),
        "replanning keeps the cook"
    );
    home.meal(cook(None)).unwrap();
    assert!(home.state().meals.cooks.is_empty(), "No one yet");
    home.meal(cook(Some(ADULT))).unwrap();
    home.meal(EventKind::DinnerCleared {
        date: date(20261005),
    })
    .unwrap();
    let state = home.state();
    assert!(state.meals.dinners.is_empty() && state.meals.cooks.is_empty());
    assert_eq!(
        home.meal(EventKind::DinnerCleared {
            date: date(20261005)
        }),
        Err(KinError::InvalidEvent)
    );
}

#[test]
fn a_cook_chosen_offline_for_a_dinner_cleared_meanwhile_is_dropped() {
    // A plans soup; then, offline, A clears it while B chooses a cook.
    let planned = execute(
        &C::Meal(dinner(20261005, None, "Soup")),
        context(1, ADULT, 0x11, 1),
        request(&[]),
    )
    .unwrap()
    .event;
    let base = vec![planned];
    let cleared = execute(
        &C::Meal(EventKind::DinnerCleared {
            date: date(20261005),
        }),
        context(2, ADULT, 0x11, 5),
        request(&base),
    )
    .unwrap()
    .event;
    let cook = execute(
        &C::Meal(EventKind::DinnerCookSet {
            date: date(20261005),
            member_id: Some(ActorId(KID)),
        }),
        context(3, KID, 0x22, 6),
        request(&base),
    )
    .unwrap()
    .event;
    let mut events = base.clone();
    events.extend([cleared, cook]);
    let state = rebuild(&events, 1_791_475_200_100, date(TEST_DATE)).unwrap();
    assert!(state.meals.dinners.is_empty());
    assert!(
        state.meals.cooks.is_empty(),
        "the cook went with the cleared dinner"
    );
    // Planning that evening again starts with no one cooking.
    let replanned = execute(
        &C::Meal(dinner(20261005, None, "Pasta")),
        context(4, ADULT, 0x11, 7),
        request(&events),
    )
    .unwrap()
    .event;
    events.push(replanned);
    let state = rebuild(&events, 1_791_475_200_100, date(TEST_DATE)).unwrap();
    assert!(state.meals.cooks.is_empty());
}

#[test]
fn two_devices_planning_the_same_evening_offline_converge_on_the_last_event() {
    // Device A and device B each plan 5 October at the same logical time;
    // replay order (logical time, then event ID) decides, on both devices.
    let a = Household::new();
    let mut base = a.events.clone();
    let first = execute(
        &C::Meal(dinner(20261005, None, "Soup")),
        context(1, ADULT, 0x11, 5),
        request(&base),
    )
    .unwrap()
    .event;
    let second = execute(
        &C::Meal(dinner(20261005, None, "Curry")),
        context(2, KID, 0x22, 5),
        request(&base),
    )
    .unwrap()
    .event;
    for order in [
        [first.clone(), second.clone()],
        [second.clone(), first.clone()],
    ] {
        let mut events = base.clone();
        events.extend(order.iter().cloned());
        events.sort_by_key(|event| (event.logical_time, event.event_id));
        let state = rebuild(&events, 1_791_475_200_100, date(TEST_DATE)).unwrap();
        assert_eq!(state.meals.dinners[&20261005].name, "Curry");
    }
    base.push(first);
    assert_eq!(base.len(), 1);
}

#[test]
fn replay_never_fails_on_a_decoded_meals_event() {
    // A dinner naming a recipe this history lacks, an archive of an unknown
    // recipe and a save past the cap all replay; the first two change nothing.
    let mut events = Vec::new();
    let mut push = |n: u64, kind: EventKind| {
        events.push(EventEnvelope {
            event_id: EventId(numbered_id(n as u32)),
            household_id: HouseholdId(HOUSEHOLD),
            actor_id: ActorId(ADULT),
            device_id: DeviceId([0x11; 16]),
            timestamp: 1_791_475_200_000,
            logical_time: n,
            event_version: 1,
            kind,
            canonical_bytes: Vec::new(),
        });
    };
    push(1, dinner(20261005, Some(99), "Ghost"));
    push(
        2,
        EventKind::RecipeArchived {
            recipe_id: RecipeId(numbered_id(98)),
        },
    );
    for n in 0..=MAX_RECIPES as u64 {
        push(
            3 + n,
            recipe(1000 + n as u32, &format!("Recipe {n}"), vec![]),
        );
    }
    let events: Vec<EventEnvelope> = events
        .into_iter()
        .map(|mut event| {
            event.canonical_bytes = encode_event(&event).unwrap();
            event
        })
        .collect();
    let state = rebuild(&events, 1_791_475_200_100, date(TEST_DATE)).unwrap();
    assert!(state.meals.dinners.is_empty());
    assert_eq!(
        state.meals.active_recipe_count(),
        MAX_RECIPES + 1,
        "a merge past the cap keeps everyone's recipes"
    );
}

#[test]
fn a_new_recipe_past_the_cap_and_a_link_to_a_non_staple_are_refused() {
    let mut home = Household::new();
    home.run(add_item(1, "Milk", ItemClassification::Staple))
        .unwrap();
    home.run(add_item(2, "Bread", ItemClassification::Shopping))
        .unwrap();
    assert_eq!(
        home.meal(recipe(1, "Toast", vec![linked("Bread", 2)])),
        Err(KinError::InvalidEvent),
        "a Shopping item isn't a Staple"
    );
    assert_eq!(
        home.meal(recipe(1, "Toast", vec![linked("Bread", 77)])),
        Err(KinError::InvalidEvent),
        "unknown item"
    );
    home.meal(recipe(1, "Porridge", vec![linked("Milk", 1)]))
        .unwrap();
    // A link the recipe already had may stay after its staple is archived.
    home.run(C::ArchiveItem(ItemId(numbered_id(1)))).unwrap();
    home.meal(recipe(
        1,
        "Porridge with honey",
        vec![linked("Milk", 1), ingredient("Honey")],
    ))
    .unwrap();
    for n in 2..=MAX_RECIPES as u32 {
        home.meal(recipe(n, &format!("Recipe {n}"), vec![]))
            .unwrap();
    }
    assert_eq!(
        home.meal(recipe(5000, "One too many", vec![])),
        Err(KinError::InvalidEvent)
    );
    home.meal(EventKind::RecipeArchived {
        recipe_id: RecipeId(numbered_id(2)),
    })
    .unwrap();
    home.meal(recipe(5000, "Room again", vec![])).unwrap();
}

#[test]
fn the_shopping_plan_re_adds_staples_skips_what_is_listed_and_makes_retries_safe() {
    let mut home = Household::new();
    home.run(add_item(1, "Milk", ItemClassification::Staple))
        .unwrap();
    home.run(add_item(2, "Eggs (free range)", ItemClassification::Staple))
        .unwrap();
    home.run(add_item(3, "Butter", ItemClassification::Staple))
        .unwrap();
    home.run(add_item(4, "bread", ItemClassification::Shopping))
        .unwrap();
    home.run(add_item(5, "Tortillas", ItemClassification::Shopping))
        .unwrap();
    home.run(C::CompleteItem(ItemId(numbered_id(5)))).unwrap();
    home.meal(recipe(
        1,
        "Breakfast",
        vec![
            linked("Milk", 1),
            linked("Eggs", 2),
            ingredient("Bread"),
            ingredient("Tortillas"),
            ingredient("Jam"),
            ingredient("jam"),
            linked("Butter", 3),
        ],
    ))
    .unwrap();
    home.run(C::ArchiveItem(ItemId(numbered_id(3)))).unwrap();
    home.meal(dinner(20261005, Some(1), "Breakfast")).unwrap();
    let state = home.state();
    let plan = state
        .meals
        .shopping_plan(PlanSource::Dinner(date(20261005)), &state.items)
        .unwrap();
    let summary: Vec<(PlanOutcome, &str)> = plan
        .iter()
        .map(|line| (line.outcome, line.text.as_str()))
        .collect();
    assert_eq!(
        summary,
        vec![
            (PlanOutcome::ReaddStaple, "Milk"),
            // A linked staple adds under the staple's own (current) text.
            (PlanOutcome::ReaddStaple, "Eggs (free range)"),
            (PlanOutcome::AlreadyOnShopping, "Bread"),
            // Completed Shopping items don't count as listed.
            (PlanOutcome::Add, "Tortillas"),
            // Two lines with the same text count once.
            (PlanOutcome::Add, "Jam"),
            // An archived staple's line is added as a new item with its own text.
            (PlanOutcome::Add, "Butter"),
        ]
    );
    assert_eq!(plan[0].staple_id, Some(ItemId(numbered_id(1))));
    assert_eq!(plan[4].staple_id, None);

    // Doing the first two, then failing: the retry plans only the rest.
    home.run(add_item(10, "Milk", ItemClassification::Shopping))
        .unwrap();
    home.run(add_item(
        11,
        "Eggs (free range)",
        ItemClassification::Shopping,
    ))
    .unwrap();
    let state = home.state();
    let retry = state
        .meals
        .shopping_plan(PlanSource::Recipe(RecipeId(numbered_id(1))), &state.items)
        .unwrap();
    let added: Vec<&str> = retry
        .iter()
        .filter(|line| line.outcome != PlanOutcome::AlreadyOnShopping)
        .map(|line| line.text.as_str())
        .collect();
    assert_eq!(added, vec!["Tortillas", "Jam", "Butter"]);
    assert!(
        state
            .items
            .iter()
            .filter(|item| item.status == ItemStatus::Active && item.text == "Milk")
            .count()
            == 2,
        "the staple itself stays"
    );

    // A one-off dinner has no ingredients to plan; an archived recipe neither.
    home.meal(dinner(20261006, None, "Takeaway")).unwrap();
    let state = home.state();
    assert_eq!(
        state
            .meals
            .shopping_plan(PlanSource::Dinner(date(20261006)), &state.items),
        Err(KinError::InvalidEvent)
    );
}

#[test]
fn kmls_lists_active_recipes_and_dinners_in_the_window_with_staple_status() {
    let mut home = Household::new();
    home.run(add_item(1, "Milk", ItemClassification::Staple))
        .unwrap();
    home.run(add_item(2, "Rice", ItemClassification::Staple))
        .unwrap();
    home.meal(recipe(
        1,
        "Rice pudding",
        vec![linked("Milk", 1), linked("Rice", 2)],
    ))
    .unwrap();
    home.run(C::ArchiveItem(ItemId(numbered_id(2)))).unwrap();
    home.meal(recipe(2, "Old", vec![])).unwrap();
    home.meal(EventKind::RecipeArchived {
        recipe_id: RecipeId(numbered_id(2)),
    })
    .unwrap();
    // TEST_DATE is 2026-10-03: 35 days back is 2026-08-29.
    home.meal(dinner(20260828, None, "Too old")).unwrap();
    home.meal(dinner(20260829, None, "Oldest kept")).unwrap();
    home.meal(dinner(20261005, Some(1), "Rice pudding"))
        .unwrap();
    home.meal(EventKind::DinnerCookSet {
        date: date(20261005),
        member_id: Some(ActorId(KID)),
    })
    .unwrap();
    let state = home.state();
    let bytes = encode_meals(&state.meals, &state.items, date(TEST_DATE)).unwrap();
    assert_eq!(&bytes[..4], b"KMLS");
    assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), 1);
    assert_eq!(
        u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
        1,
        "one active recipe"
    );
    assert_eq!(
        u32::from_le_bytes(bytes[12..16].try_into().unwrap()),
        2,
        "two dinners in the window"
    );
    // Recipe: ID, name, count, then each ingredient's staple status.
    let mut at = 16;
    assert_eq!(bytes[at..at + 16], numbered_id(1));
    at += 16;
    let name_len = usize::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
    assert_eq!(&bytes[at + 2..at + 2 + name_len], b"Rice pudding");
    at += 2 + name_len;
    assert_eq!(bytes[at], 2);
    at += 4;
    assert_eq!(bytes[at], 1, "Milk: active staple");
    at += 20;
    let len = usize::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
    at += 2 + len;
    assert_eq!(bytes[at], 2, "Rice: archived staple");
    at += 20;
    let len = usize::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
    at += 2 + len;
    at += 2; // empty notes
             // Dinners, ascending: the oldest kept, then the 5th with a recipe and cook.
    assert_eq!(
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()),
        20260829
    );
    assert_eq!(bytes[at + 4], 0);
    at += 40;
    let len = usize::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
    assert_eq!(&bytes[at + 2..at + 2 + len], b"Oldest kept");
    at += 2 + len;
    assert_eq!(
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()),
        20261005
    );
    assert_eq!(bytes[at + 4], 0b11);
    assert_eq!(bytes[at + 24..at + 40], KID);
    at += 40;
    let len = usize::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
    assert_eq!(&bytes[at + 2..at + 2 + len], b"Rice pudding");
    assert_eq!(at + 2 + len, bytes.len());
}

#[test]
fn kcmd_carries_meals_payloads_and_the_plan_query_is_strict() {
    let kind = recipe(4, "Pasta", vec![ingredient("Penne")]);
    let payload = encode_payload(&kind).unwrap();
    let mut packet = vec![0u8; 128];
    packet[..4].copy_from_slice(b"KCMD");
    packet[4..6].copy_from_slice(&1u16.to_le_bytes());
    packet[8..10].copy_from_slice(&RECIPE_SAVED.to_le_bytes());
    packet[12..28].copy_from_slice(&numbered_id(1));
    packet[28..44].copy_from_slice(&HOUSEHOLD);
    packet[44..60].copy_from_slice(&ADULT);
    packet[60..76].copy_from_slice(&[0x11; 16]);
    packet[76..84].copy_from_slice(&1_791_475_200_000i64.to_le_bytes());
    packet[84..92].copy_from_slice(&1u64.to_le_bytes());
    packet[124..128].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    packet.extend_from_slice(&payload);
    let (command, _) = decode_command(&packet).unwrap();
    assert_eq!(command, C::Meal(kind));
    // The header's own ID, date, option and expiry must be zero for meals.
    let mut with_id = packet.clone();
    with_id[92] = 1;
    assert!(decode_command(&with_id).is_err());

    // KMPQ: a recipe query needs a recipe ID and no date; a date query no ID.
    let mut history = History::default();
    let query = |source: u8, recipe: [u8; 16], on: u32| {
        let mut bytes = b"KMPQ".to_vec();
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&[0, 0, source, 0, 0, 0]);
        bytes.extend_from_slice(&recipe);
        bytes.extend_from_slice(&on.to_le_bytes());
        bytes.extend_from_slice(&kine(&[], 0, TEST_DATE, None)[..]);
        bytes
    };
    assert_eq!(
        meal_shopping_plan(&query(1, [0; 16], 0), &mut history),
        Err(KinError::MalformedProtocol)
    );
    assert_eq!(
        meal_shopping_plan(&query(2, numbered_id(1), 20261005), &mut history),
        Err(KinError::MalformedProtocol)
    );
    assert_eq!(
        meal_shopping_plan(&query(3, [0; 16], 20261005), &mut history),
        Err(KinError::MalformedProtocol)
    );
    assert_eq!(
        meal_shopping_plan(&query(2, [0; 16], 20261005), &mut history),
        Err(KinError::InvalidEvent),
        "no dinner that day"
    );
}

// ---- Fuller meal plans (#679, ADR 0022 §7): kinds 80–82 -----------------

fn meal(on: u32, slot: MealSlot, recipe: Option<u32>, name: &str) -> EventKind {
    EventKind::MealSet {
        date: date(on),
        slot,
        recipe_id: recipe.map(|id| RecipeId(numbered_id(id))),
        name: name.into(),
    }
}

fn favourite(id: u32, on: bool) -> EventKind {
    EventKind::RecipeFavouriteSet {
        recipe_id: RecipeId(numbered_id(id)),
        favourite: on,
    }
}

#[test]
fn meal_plan_payloads_round_trip_and_only_canonical_bytes_decode() {
    let kinds = [
        meal(20261005, MealSlot::Breakfast, Some(7), "Porridge"),
        meal(20261005, MealSlot::Lunch, None, "Sandwiches"),
        meal(20261005, MealSlot::Snack, None, "Apples"),
        EventKind::MealCleared {
            date: date(20261005),
            slot: MealSlot::Snack,
        },
        favourite(7, true),
        favourite(7, false),
    ];
    for kind in kinds {
        let code = crate::codec::kind_code(&kind);
        assert!(is_meals_code(code) && (MEAL_SET..=RECIPE_FAVOURITE_SET).contains(&code));
        let payload = encode_payload(&kind).unwrap();
        assert_eq!(decode_payload(code, &payload).unwrap(), kind);
        let mut longer = payload.clone();
        longer.push(0);
        assert!(decode_payload(code, &longer).is_err());
    }
    // Byte layout of kind 80: date, slot word, recipe flag word and ID, name.
    let payload = encode_payload(&meal(20261005, MealSlot::Lunch, None, "Soup")).unwrap();
    assert_eq!(
        payload,
        [
            &20261005u32.to_le_bytes()[..],
            &[2, 0, 0, 0],
            &[0, 0, 0, 0],
            &4u16.to_le_bytes(),
            b"Soup"
        ]
        .concat()
    );
    // Dinner stays on kinds 61–63: never a slot of kinds 80–81.
    assert_eq!(
        encode_payload(&meal(20261005, MealSlot::Dinner, None, "Soup")),
        Err(KinError::MalformedProtocol)
    );
    for slot in [0u8, 3, 5] {
        let mut bytes = 20261005u32.to_le_bytes().to_vec();
        bytes.extend_from_slice(&[slot, 0, 0, 0]);
        assert!(decode_payload(MEAL_CLEARED, &bytes).is_err(), "slot {slot}");
    }
    // Reserved bytes, a favourite flag other than 0 or 1, a zero recipe.
    let mut cleared = 20261005u32.to_le_bytes().to_vec();
    cleared.extend_from_slice(&[1, 0, 1, 0]);
    assert!(decode_payload(MEAL_CLEARED, &cleared).is_err());
    let mut star = numbered_id(7).to_vec();
    star.extend_from_slice(&[2, 0, 0, 0]);
    assert!(decode_payload(RECIPE_FAVOURITE_SET, &star).is_err());
    assert!(encode_payload(&favourite(0, true)).is_err());
    // Non-canonical names are refused, as for a dinner.
    assert!(encode_payload(&meal(20261005, MealSlot::Lunch, None, " Soup")).is_err());
}

#[test]
fn breakfast_lunch_and_snacks_follow_the_dinner_rules_without_a_cook() {
    let mut home = Household::new();
    home.meal(recipe(1, "Porridge", vec![ingredient("Oats")]))
        .unwrap();
    home.meal(meal(20261005, MealSlot::Breakfast, Some(1), "Porridge"))
        .unwrap();
    home.meal(meal(20261005, MealSlot::Lunch, None, "Leftovers"))
        .unwrap();
    home.meal(dinner(20261005, None, "Curry")).unwrap();
    // The same meal again changes nothing; a recipe needs its current name.
    assert_eq!(
        home.meal(meal(20261005, MealSlot::Breakfast, Some(1), "Porridge")),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        home.meal(meal(20261006, MealSlot::Breakfast, Some(1), "Oats")),
        Err(KinError::InvalidEvent)
    );
    assert_eq!(
        home.meal(meal(20261006, MealSlot::Breakfast, Some(9), "Ghost")),
        Err(KinError::InvalidEvent),
        "unknown recipe"
    );
    // Clearing a lunch leaves the other meals and the dinner alone.
    assert_eq!(
        home.meal(EventKind::MealCleared {
            date: date(20261005),
            slot: MealSlot::Snack
        }),
        Err(KinError::InvalidEvent),
        "nothing planned"
    );
    home.meal(EventKind::MealCleared {
        date: date(20261005),
        slot: MealSlot::Lunch,
    })
    .unwrap();
    let state = home.state();
    assert_eq!(state.meals.slot_meals.len(), 1);
    assert_eq!(
        state
            .meals
            .meal(20261005, MealSlot::Breakfast)
            .unwrap()
            .name,
        "Porridge"
    );
    assert_eq!(
        state.meals.meal(20261005, MealSlot::Dinner).unwrap().name,
        "Curry"
    );
    // Clearing dinner (kind 62) leaves breakfast.
    home.meal(EventKind::DinnerCleared {
        date: date(20261005),
    })
    .unwrap();
    assert_eq!(home.state().meals.slot_meals.len(), 1);
    // An archived recipe keeps its planned meal's name and can't be planned.
    home.meal(EventKind::RecipeArchived {
        recipe_id: RecipeId(numbered_id(1)),
    })
    .unwrap();
    assert_eq!(
        home.meal(meal(20261007, MealSlot::Breakfast, Some(1), "Porridge")),
        Err(KinError::InvalidEvent)
    );
    let state = home.state();
    let kept = state.meals.meal(20261005, MealSlot::Breakfast).unwrap();
    assert_eq!(state.meals.dinner_name(kept), "Porridge");
}

#[test]
fn favourites_toggle_on_active_recipes_and_replay_never_fails() {
    let mut home = Household::new();
    home.meal(recipe(1, "Tacos", vec![])).unwrap();
    assert_eq!(
        home.meal(favourite(1, false)),
        Err(KinError::InvalidEvent),
        "not a favourite yet"
    );
    home.meal(favourite(1, true)).unwrap();
    assert_eq!(home.meal(favourite(1, true)), Err(KinError::InvalidEvent));
    assert!(home.state().meals.is_favourite(&RecipeId(numbered_id(1))));
    home.meal(favourite(1, false)).unwrap();
    assert!(home.state().meals.favourites.is_empty());
    assert_eq!(
        home.meal(favourite(2, true)),
        Err(KinError::InvalidEvent),
        "unknown recipe"
    );
    home.meal(favourite(1, true)).unwrap();
    home.meal(EventKind::RecipeArchived {
        recipe_id: RecipeId(numbered_id(1)),
    })
    .unwrap();
    assert_eq!(
        home.meal(favourite(1, false)),
        Err(KinError::InvalidEvent),
        "archived"
    );

    // Replay: a favourite or a meal naming a recipe the history lacks is
    // decoded and changes nothing.
    let events: Vec<EventEnvelope> = [
        favourite(9, true),
        meal(20261005, MealSlot::Snack, Some(9), "Ghost"),
    ]
    .into_iter()
    .enumerate()
    .map(|(n, kind)| {
        let mut event = EventEnvelope {
            event_id: EventId(numbered_id(n as u32 + 1)),
            household_id: HouseholdId(HOUSEHOLD),
            actor_id: ActorId(ADULT),
            device_id: DeviceId([0x11; 16]),
            timestamp: 1_791_475_200_000,
            logical_time: n as u64 + 1,
            event_version: 1,
            kind,
            canonical_bytes: Vec::new(),
        };
        event.canonical_bytes = encode_event(&event).unwrap();
        event
    })
    .collect();
    let state = rebuild(&events, 1_791_475_200_100, date(TEST_DATE)).unwrap();
    assert!(state.meals.favourites.is_empty() && state.meals.slot_meals.is_empty());
}

#[test]
fn two_devices_planning_the_same_lunch_offline_converge_on_the_last_event() {
    let first = execute(
        &C::Meal(meal(20261005, MealSlot::Lunch, None, "Soup")),
        context(1, ADULT, 0x11, 5),
        request(&[]),
    )
    .unwrap()
    .event;
    let second = execute(
        &C::Meal(meal(20261005, MealSlot::Lunch, None, "Salad")),
        context(2, KID, 0x22, 5),
        request(&[]),
    )
    .unwrap()
    .event;
    for order in [
        [first.clone(), second.clone()],
        [second.clone(), first.clone()],
    ] {
        let mut events = order.to_vec();
        events.sort_by_key(|event| (event.logical_time, event.event_id));
        let state = rebuild(&events, 1_791_475_200_100, date(TEST_DATE)).unwrap();
        assert_eq!(
            state.meals.meal(20261005, MealSlot::Lunch).unwrap().name,
            "Salad"
        );
    }
}

#[test]
fn the_week_plan_covers_every_slot_once_per_recipe_and_text() {
    let mut home = Household::new();
    home.run(add_item(1, "Milk", ItemClassification::Staple))
        .unwrap();
    home.run(add_item(2, "Bread", ItemClassification::Shopping))
        .unwrap();
    home.meal(recipe(
        1,
        "Porridge",
        vec![ingredient("Oats"), linked("Milk", 1)],
    ))
    .unwrap();
    home.meal(recipe(
        2,
        "Sandwiches",
        vec![ingredient("Bread"), ingredient("Cheese")],
    ))
    .unwrap();
    home.meal(recipe(
        3,
        "Mac and cheese",
        vec![ingredient("cheese"), ingredient("Pasta")],
    ))
    .unwrap();
    home.meal(recipe(4, "Fruit", vec![ingredient("Apples")]))
        .unwrap();
    // Monday 5 October to Sunday 11 October, plus one meal outside it.
    home.meal(meal(20261005, MealSlot::Breakfast, Some(1), "Porridge"))
        .unwrap();
    home.meal(meal(20261006, MealSlot::Breakfast, Some(1), "Porridge"))
        .unwrap();
    home.meal(meal(20261005, MealSlot::Lunch, Some(2), "Sandwiches"))
        .unwrap();
    home.meal(dinner(20261007, Some(3), "Mac and cheese"))
        .unwrap();
    home.meal(meal(20261008, MealSlot::Snack, None, "Biscuits"))
        .unwrap();
    home.meal(meal(20261012, MealSlot::Snack, Some(4), "Fruit"))
        .unwrap();
    let state = home.state();
    let plan = state
        .meals
        .shopping_plan(PlanSource::Week(date(20261005)), &state.items)
        .unwrap();
    let summary: Vec<(PlanOutcome, &str)> = plan
        .iter()
        .map(|line| (line.outcome, line.text.as_str()))
        .collect();
    assert_eq!(
        summary,
        vec![
            (PlanOutcome::Add, "Oats"),
            (PlanOutcome::ReaddStaple, "Milk"),
            (PlanOutcome::AlreadyOnShopping, "Bread"),
            // "cheese" from the dinner is the same text: counted once.
            (PlanOutcome::Add, "Cheese"),
            (PlanOutcome::Add, "Pasta"),
        ]
    );
    // One slot's meal, and a one-off meal has nothing to plan.
    let lunch = state
        .meals
        .shopping_plan(
            PlanSource::Meal(date(20261005), MealSlot::Lunch),
            &state.items,
        )
        .unwrap();
    assert_eq!(lunch.len(), 2);
    assert_eq!(
        state.meals.shopping_plan(
            PlanSource::Meal(date(20261008), MealSlot::Snack),
            &state.items
        ),
        Err(KinError::InvalidEvent)
    );
    // Dinner by slot is the same as by date.
    assert_eq!(
        state.meals.shopping_plan(
            PlanSource::Meal(date(20261007), MealSlot::Dinner),
            &state.items
        ),
        state
            .meals
            .shopping_plan(PlanSource::Dinner(date(20261007)), &state.items)
    );
    // A week with nothing to cook plans nothing, without an error.
    assert_eq!(
        state
            .meals
            .shopping_plan(PlanSource::Week(date(20261019)), &state.items),
        Ok(vec![])
    );
}

#[test]
fn kmls_v2_lists_every_slot_and_favourites_while_v1_keeps_dinners_only() {
    let mut home = Household::new();
    home.meal(recipe(1, "Porridge", vec![ingredient("Oats")]))
        .unwrap();
    home.meal(recipe(2, "Tacos", vec![])).unwrap();
    home.meal(favourite(2, true)).unwrap();
    home.meal(dinner(20261005, Some(2), "Tacos")).unwrap();
    home.meal(EventKind::DinnerCookSet {
        date: date(20261005),
        member_id: Some(ActorId(KID)),
    })
    .unwrap();
    home.meal(meal(20261005, MealSlot::Snack, None, "Apples"))
        .unwrap();
    home.meal(meal(20261005, MealSlot::Breakfast, Some(1), "Porridge"))
        .unwrap();
    home.meal(meal(20260828, MealSlot::Lunch, None, "Too old"))
        .unwrap();
    let state = home.state();

    // v1 is what it was: one dinner, no favourite flag.
    let v1 = encode_meals(&state.meals, &state.items, date(TEST_DATE)).unwrap();
    assert_eq!(u16::from_le_bytes([v1[4], v1[5]]), 1);
    assert_eq!(u32::from_le_bytes(v1[12..16].try_into().unwrap()), 1);

    let bytes = encode_meal_plans(&state.meals, &state.items, date(TEST_DATE)).unwrap();
    assert_eq!(&bytes[..4], b"KMLS");
    assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), 2);
    assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 2);
    assert_eq!(
        u32::from_le_bytes(bytes[12..16].try_into().unwrap()),
        3,
        "breakfast, dinner and snack in the window"
    );
    // Recipe 1: not a favourite; one ingredient; notes.
    let mut at = 16 + 16;
    let len = usize::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
    at += 2 + len;
    assert_eq!(bytes[at..at + 4], [1, 0, 0, 0]);
    at += 4 + 20;
    let len = usize::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
    at += 2 + len + 2;
    // Recipe 2: a favourite with no ingredients.
    assert_eq!(bytes[at..at + 16], numbered_id(2));
    at += 16;
    let len = usize::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
    at += 2 + len;
    assert_eq!(bytes[at..at + 4], [0, 1, 0, 0]);
    at += 4 + 2;
    // Meals by date then slot: breakfast (recipe), dinner (recipe, cook), snack.
    let mut slots = Vec::new();
    while at < bytes.len() {
        assert_eq!(
            u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()),
            20261005
        );
        slots.push((bytes[at + 4], bytes[at + 5]));
        if bytes[at + 4] == 3 {
            assert_eq!(bytes[at + 24..at + 40], KID);
        } else {
            assert_eq!(bytes[at + 24..at + 40], [0; 16]);
        }
        at += 40;
        let len = usize::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
        at += 2 + len;
    }
    assert_eq!(slots, vec![(1, 0b01), (3, 0b11), (4, 0b00)]);
    assert_eq!(at, bytes.len());
}

#[test]
fn kmpq_v2_plans_a_slot_or_a_week_and_v1_stays_strict() {
    let mut history = History::default();
    let query = |version: u16, source: u8, slot: u8, recipe: [u8; 16], on: u32| {
        let mut bytes = b"KMPQ".to_vec();
        bytes.extend_from_slice(&version.to_le_bytes());
        bytes.extend_from_slice(&[0, 0, source, slot, 0, 0]);
        bytes.extend_from_slice(&recipe);
        bytes.extend_from_slice(&on.to_le_bytes());
        bytes.extend_from_slice(&kine(&[], 0, TEST_DATE, None)[..]);
        bytes
    };
    // Sources 3 and 4 need version 2; v1 never takes a slot.
    assert_eq!(
        meal_shopping_plan(&query(1, 4, 0, [0; 16], 20261005), &mut history),
        Err(KinError::MalformedProtocol)
    );
    assert_eq!(
        meal_shopping_plan(&query(1, 2, 1, [0; 16], 20261005), &mut history),
        Err(KinError::MalformedProtocol)
    );
    assert_eq!(
        meal_shopping_plan(&query(3, 4, 0, [0; 16], 20261005), &mut history),
        Err(KinError::UnsupportedVersion)
    );
    // A slot must be 1–4 for source 3 and zero otherwise.
    for slot in [0, 5] {
        assert_eq!(
            meal_shopping_plan(&query(2, 3, slot, [0; 16], 20261005), &mut history),
            Err(KinError::MalformedProtocol)
        );
    }
    assert_eq!(
        meal_shopping_plan(&query(2, 4, 1, [0; 16], 20261005), &mut history),
        Err(KinError::MalformedProtocol)
    );
    assert_eq!(
        meal_shopping_plan(&query(2, 4, 0, [0; 16], 99991230), &mut history),
        Err(KinError::MalformedProtocol),
        "no seven days left"
    );
    assert_eq!(
        meal_shopping_plan(&query(2, 3, 2, [0; 16], 20261005), &mut history),
        Err(KinError::InvalidEvent),
        "no lunch that day"
    );
    // An empty week is an empty KMSP v1 plan.
    let plan = meal_shopping_plan(&query(2, 4, 0, [0; 16], 20261005), &mut history).unwrap();
    assert_eq!(plan, [&b"KMSP"[..], &[1, 0, 0, 0], &[0, 0, 0, 0]].concat());
    // A v2 recipe query reads as v1 did.
    assert_eq!(
        meal_shopping_plan(&query(2, 1, 0, numbered_id(1), 0), &mut history),
        Err(KinError::InvalidEvent)
    );
}

#[test]
fn kcmd_carries_the_meal_plan_kinds() {
    for kind in [
        meal(20261005, MealSlot::Snack, None, "Apples"),
        EventKind::MealCleared {
            date: date(20261005),
            slot: MealSlot::Breakfast,
        },
        favourite(4, true),
    ] {
        let code = crate::codec::kind_code(&kind);
        let payload = encode_payload(&kind).unwrap();
        let mut packet = vec![0u8; 128];
        packet[..4].copy_from_slice(b"KCMD");
        packet[4..6].copy_from_slice(&1u16.to_le_bytes());
        packet[8..10].copy_from_slice(&code.to_le_bytes());
        packet[12..28].copy_from_slice(&numbered_id(1));
        packet[28..44].copy_from_slice(&HOUSEHOLD);
        packet[44..60].copy_from_slice(&ADULT);
        packet[60..76].copy_from_slice(&[0x11; 16]);
        packet[76..84].copy_from_slice(&1_791_475_200_000i64.to_le_bytes());
        packet[84..92].copy_from_slice(&1u64.to_le_bytes());
        packet[124..128].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        packet.extend_from_slice(&payload);
        let (command, _) = decode_command(&packet).unwrap();
        assert_eq!(command, C::Meal(kind));
    }
}

fn hex(text: &str) -> Vec<u8> {
    let digits: String = text.split_whitespace().collect();
    (0..digits.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&digits[at..at + 2], 16).unwrap())
        .collect()
}

/// TEST-VECTORS 180–182 and 184–185, written out by hand.
#[test]
fn meal_plan_test_vectors() {
    // 180: lunch on 2026-10-05, one-off "Soup"; breakfast from recipe 7.
    assert_eq!(
        encode_payload(&meal(20261005, MealSlot::Lunch, None, "Soup")).unwrap(),
        hex("8d283501 02000000 00000000 0400 536f7570")
    );
    assert_eq!(
        encode_payload(&meal(20261005, MealSlot::Breakfast, Some(7), "Porridge")).unwrap(),
        hex("8d283501 01000000 01000000 07000000000000000000000000000000 0800 506f727269646765")
    );
    // 181: the snack on 2026-10-05 cleared.
    assert_eq!(
        encode_payload(&EventKind::MealCleared {
            date: date(20261005),
            slot: MealSlot::Snack
        })
        .unwrap(),
        hex("8d283501 04000000")
    );
    // 182: recipe 7 a favourite, then not.
    assert_eq!(
        encode_payload(&favourite(7, true)).unwrap(),
        hex("07000000000000000000000000000000 01000000")
    );
    assert_eq!(
        encode_payload(&favourite(7, false)).unwrap(),
        hex("07000000000000000000000000000000 00000000")
    );

    // 184: KMLS v2 with recipe 7 "Oats" (a favourite, no ingredients) and a
    // breakfast of it on 2026-10-05.
    let mut home = Household::new();
    home.meal(recipe(7, "Oats", vec![])).unwrap();
    home.meal(favourite(7, true)).unwrap();
    home.meal(meal(20261005, MealSlot::Breakfast, Some(7), "Oats"))
        .unwrap();
    let state = home.state();
    assert_eq!(
        encode_meal_plans(&state.meals, &state.items, date(TEST_DATE)).unwrap(),
        hex(concat!(
            "4b4d4c53 0200 0000 01000000 01000000",
            "07000000000000000000000000000000 0400 4f617473 00010000 0000",
            "8d283501 01 01 0000 07000000000000000000000000000000",
            "00000000000000000000000000000000 0400 4f617473"
        ))
    );
    // An empty history.
    let empty = Household::new().state();
    assert_eq!(
        encode_meal_plans(&empty.meals, &empty.items, date(TEST_DATE)).unwrap(),
        hex("4b4d4c53 0200 0000 00000000 00000000")
    );
}
