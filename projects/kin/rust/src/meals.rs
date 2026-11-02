//! Meals (#333, ADR 0012): recipes, one dinner per civil date, who's cooking,
//! and the plan for putting a dinner's ingredients on Shopping. Fuller meal
//! plans (#679, ADR 0022 §7) add breakfast, lunch and a snack per date
//! (kinds 80–81) and favourite recipes (kind 82); dinner keeps kinds 61–63,
//! so dinners planned before them stay valid.
//!
//! Meals events live in the household history (kinds 59–63, 80–82). Like the fridge,
//! replay never fails on a decoded meals event, and commands enforce the rules
//! when an event is created:
//! - A recipe is saved whole; the latest save wins. An archived recipe stays
//!   archived: a later save of it changes nothing.
//! - A dinner is keyed by its civil date; the latest `DinnerSet` for a date
//!   wins, and `DinnerCleared` removes it with its cook.
//! - The cook is set per date apart from the dinner, so planning a dinner
//!   keeps the cook already chosen. It shows only while that date has a
//!   dinner.
//! - Events naming a recipe this history lacks change nothing. An honest
//!   author has always seen what it names, so its event sorts after it.
//! - Caps (recipes) are checked on commands only, so two devices that each
//!   saved the last allowed recipe offline still merge.
//!
//! - A breakfast, lunch or snack is keyed by its date and slot, with the same
//!   latest-wins rule as a dinner; it has no cook.
//! - A favourite is a flag on a recipe; the latest event for a recipe wins.
//!
//! Hosts read meals through `kin_meals` (KMLS v1, dinners only) and
//! `kin_meal_plans` (KMLS v2, every slot and favourites), and plan Shopping
//! additions through `kin_meal_shopping_plan` (KMPQ v1/v2 -> KMSP), below.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::error::KinError;
use crate::event::{ActorId, EventEnvelope, EventKind, ItemClassification, ItemId, RecipeId};
use crate::recurrence::CivilDate;
use crate::state::{ItemState, ItemStatus};
use crate::wire::{read_id, read_u16, read_u32};

pub const RECIPE_SAVED: u16 = 59;
pub const RECIPE_ARCHIVED: u16 = 60;
pub const DINNER_SET: u16 = 61;
pub const DINNER_CLEARED: u16 = 62;
pub const DINNER_COOK_SET: u16 = 63;
/// Fuller meal plans (#679, ADR 0022 §7).
pub const MEAL_SET: u16 = 80;
pub const MEAL_CLEARED: u16 = 81;
pub const RECIPE_FAVOURITE_SET: u16 = 82;

pub const MAX_RECIPES: usize = 200;
pub const MAX_RECIPE_INGREDIENTS: usize = 40;
pub const MAX_RECIPE_NAME_CHARS: usize = 80;
pub const MAX_RECIPE_NAME_BYTES: usize = 256;
pub const MAX_INGREDIENT_CHARS: usize = 120;
pub const MAX_INGREDIENT_BYTES: usize = 256;
pub const MAX_RECIPE_NOTES_CHARS: usize = 2_000;
pub const MAX_RECIPE_NOTES_BYTES: usize = 4_096;
/// A recipe's whole payload after its ID, so one event fits one sync
/// envelope (6,144 bytes of ciphertext) with room for the header.
pub const MAX_RECIPE_PAYLOAD_BYTES: usize = 4_352;
/// The meals view keeps dinners from this many days before the projection
/// date to `DINNERS_AHEAD` days after it.
pub const DINNERS_BEHIND: u32 = 35;
pub const DINNERS_AHEAD: u32 = 370;

pub const fn is_meals_code(code: u16) -> bool {
    matches!(code, RECIPE_SAVED..=DINNER_COOK_SET | MEAL_SET..=RECIPE_FAVOURITE_SET)
}

/// A meal of the day. The codes are the order the planner shows them in and
/// the slot byte of kinds 80–81, KMLS v2 and KMPQ v2. Dinner (3) is never on
/// kinds 80–81: dinners keep their own kinds 61–63.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum MealSlot {
    Breakfast = 1,
    Lunch = 2,
    Dinner = 3,
    Snack = 4,
}

impl MealSlot {
    pub const ALL: [MealSlot; 4] = [
        MealSlot::Breakfast,
        MealSlot::Lunch,
        MealSlot::Dinner,
        MealSlot::Snack,
    ];

    pub const fn code(self) -> u8 {
        self as u8
    }

    pub const fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(MealSlot::Breakfast),
            2 => Some(MealSlot::Lunch),
            3 => Some(MealSlot::Dinner),
            4 => Some(MealSlot::Snack),
            _ => None,
        }
    }

    /// The slots kinds 80–81 carry: every one but dinner.
    pub const fn is_event_slot(self) -> bool {
        !matches!(self, MealSlot::Dinner)
    }
}

/// One ingredient line: free text, optionally linked to a Staple item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Ingredient {
    pub text: String,
    pub staple_id: Option<ItemId>,
}

/// Collapses runs of whitespace to one space and trims: the canonical form
/// of a recipe name, an ingredient and a dinner's name.
pub fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The key "already on Shopping" compares: collapsed and lowercased.
pub fn shopping_key(text: &str) -> String {
    collapse(text).to_lowercase()
}

fn single_line(text: &str, max_chars: usize, max_bytes: usize) -> Result<String, KinError> {
    let text = collapse(text);
    if text.is_empty()
        || text.len() > max_bytes
        || text.chars().count() > max_chars
        || text.chars().any(char::is_control)
    {
        return Err(KinError::InvalidEvent);
    }
    Ok(text)
}

pub fn normalize_recipe_name(name: &str) -> Result<String, KinError> {
    single_line(name, MAX_RECIPE_NAME_CHARS, MAX_RECIPE_NAME_BYTES)
}

pub fn normalize_ingredient(text: &str) -> Result<String, KinError> {
    single_line(text, MAX_INGREDIENT_CHARS, MAX_INGREDIENT_BYTES)
}

/// Notes keep their lines: CRLF becomes LF, each line's trailing spaces go,
/// and the whole is trimmed. Empty notes are allowed.
pub fn normalize_notes(notes: &str) -> Result<String, KinError> {
    let unified = notes.replace("\r\n", "\n");
    let lines: Vec<&str> = unified.split('\n').map(str::trim_end).collect();
    let text = lines.join("\n").trim().to_owned();
    if text.len() > MAX_RECIPE_NOTES_BYTES
        || text.chars().count() > MAX_RECIPE_NOTES_CHARS
        || text.chars().any(|c| c.is_control() && c != '\n')
    {
        return Err(KinError::InvalidEvent);
    }
    Ok(text)
}

/// A recipe's name, ingredients and notes in canonical form.
pub fn normalize_recipe(
    name: &str,
    ingredients: &[Ingredient],
    notes: &str,
) -> Result<(String, Vec<Ingredient>, String), KinError> {
    if ingredients.len() > MAX_RECIPE_INGREDIENTS {
        return Err(KinError::InvalidEvent);
    }
    let name = normalize_recipe_name(name)?;
    let mut lines = Vec::with_capacity(ingredients.len());
    for ingredient in ingredients {
        if ingredient.staple_id.is_some_and(|id| id.0 == [0; 16]) {
            return Err(KinError::InvalidEvent);
        }
        lines.push(Ingredient {
            text: normalize_ingredient(&ingredient.text)?,
            staple_id: ingredient.staple_id,
        });
    }
    Ok((name, lines, normalize_notes(notes)?))
}

pub(crate) fn push_text(out: &mut Vec<u8>, text: &str) {
    out.extend_from_slice(&(text.len() as u16).to_le_bytes());
    out.extend_from_slice(text.as_bytes());
}

fn push_optional_id(out: &mut Vec<u8>, id: Option<[u8; 16]>) {
    match id {
        Some(id) => {
            out.extend_from_slice(&[1, 0, 0, 0]);
            out.extend_from_slice(&id);
        }
        None => out.extend_from_slice(&[0, 0, 0, 0]),
    }
}

/// The canonical payload of a meals event. Refuses anything not already in
/// canonical form, so every device encodes the same bytes.
pub fn encode_payload(kind: &EventKind) -> Result<Vec<u8>, KinError> {
    let malformed = || KinError::MalformedProtocol;
    let mut out = Vec::new();
    match kind {
        EventKind::RecipeSaved {
            recipe_id,
            name,
            ingredients,
            notes,
        } => {
            if recipe_id.0 == [0; 16] {
                return Err(malformed());
            }
            let (canonical_name, canonical_lines, canonical_notes) =
                normalize_recipe(name, ingredients, notes).map_err(|_| malformed())?;
            if canonical_name != *name
                || canonical_lines != *ingredients
                || canonical_notes != *notes
            {
                return Err(malformed());
            }
            out.extend_from_slice(&recipe_id.0);
            push_text(&mut out, name);
            out.push(ingredients.len() as u8);
            out.push(0);
            for ingredient in ingredients {
                push_optional_id(&mut out, ingredient.staple_id.map(|id| id.0));
                push_text(&mut out, &ingredient.text);
            }
            push_text(&mut out, notes);
            if out.len() - 16 > MAX_RECIPE_PAYLOAD_BYTES {
                return Err(KinError::SizeLimit);
            }
        }
        EventKind::RecipeArchived { recipe_id } => {
            if recipe_id.0 == [0; 16] {
                return Err(malformed());
            }
            out.extend_from_slice(&recipe_id.0);
        }
        EventKind::DinnerSet {
            date,
            recipe_id,
            name,
        } => {
            if recipe_id.is_some_and(|id| id.0 == [0; 16])
                || normalize_recipe_name(name).ok().as_deref() != Some(name.as_str())
            {
                return Err(malformed());
            }
            out.extend_from_slice(&date.encoded().to_le_bytes());
            push_optional_id(&mut out, recipe_id.map(|id| id.0));
            push_text(&mut out, name);
        }
        EventKind::DinnerCleared { date } => out.extend_from_slice(&date.encoded().to_le_bytes()),
        EventKind::DinnerCookSet { date, member_id } => {
            if member_id.is_some_and(|id| id.0 == [0; 16]) {
                return Err(malformed());
            }
            out.extend_from_slice(&date.encoded().to_le_bytes());
            push_optional_id(&mut out, member_id.map(|id| id.0));
        }
        EventKind::MealSet {
            date,
            slot,
            recipe_id,
            name,
        } => {
            if !slot.is_event_slot()
                || recipe_id.is_some_and(|id| id.0 == [0; 16])
                || normalize_recipe_name(name).ok().as_deref() != Some(name.as_str())
            {
                return Err(malformed());
            }
            out.extend_from_slice(&date.encoded().to_le_bytes());
            out.extend_from_slice(&[slot.code(), 0, 0, 0]);
            push_optional_id(&mut out, recipe_id.map(|id| id.0));
            push_text(&mut out, name);
        }
        EventKind::MealCleared { date, slot } => {
            if !slot.is_event_slot() {
                return Err(malformed());
            }
            out.extend_from_slice(&date.encoded().to_le_bytes());
            out.extend_from_slice(&[slot.code(), 0, 0, 0]);
        }
        EventKind::RecipeFavouriteSet {
            recipe_id,
            favourite,
        } => {
            if recipe_id.0 == [0; 16] {
                return Err(malformed());
            }
            out.extend_from_slice(&recipe_id.0);
            out.extend_from_slice(&[u8::from(*favourite), 0, 0, 0]);
        }
        _ => return Err(KinError::Internal),
    }
    Ok(out)
}

/// Reads a length-prefixed UTF-8 string at `at`, advancing it.
pub(crate) fn read_text(payload: &[u8], at: &mut usize) -> Result<String, KinError> {
    let length = usize::from(read_u16(payload, *at)?);
    let start = *at + 2;
    let end = start
        .checked_add(length)
        .ok_or(KinError::MalformedProtocol)?;
    let text = std::str::from_utf8(payload.get(start..end).ok_or(KinError::MalformedProtocol)?)
        .map_err(|_| KinError::MalformedProtocol)?
        .to_owned();
    *at = end;
    Ok(text)
}

/// Reads a flag word (1 or 0, then three zero bytes) and the ID it governs.
fn read_optional_id(payload: &[u8], at: &mut usize) -> Result<Option<[u8; 16]>, KinError> {
    let flag = payload
        .get(*at..*at + 4)
        .ok_or(KinError::MalformedProtocol)?;
    if flag[1..] != [0, 0, 0] {
        return Err(KinError::MalformedProtocol);
    }
    *at += 4;
    match flag[0] {
        0 => Ok(None),
        1 => {
            let id = read_id(payload, *at)?;
            if id == [0; 16] {
                return Err(KinError::MalformedProtocol);
            }
            *at += 16;
            Ok(Some(id))
        }
        _ => Err(KinError::MalformedProtocol),
    }
}

fn read_date(payload: &[u8]) -> Result<CivilDate, KinError> {
    CivilDate::from_encoded(read_u32(payload, 0)?)
}

/// Reads the slot word after a date (kinds 80–81): a slot other than dinner,
/// then three zero bytes.
fn read_slot(payload: &[u8]) -> Result<MealSlot, KinError> {
    let word = payload.get(4..8).ok_or(KinError::MalformedProtocol)?;
    match MealSlot::from_code(word[0]) {
        Some(slot) if slot.is_event_slot() && word[1..] == [0, 0, 0] => Ok(slot),
        _ => Err(KinError::MalformedProtocol),
    }
}

/// Decodes a meals payload strictly: canonical text, reserved bytes zero and
/// nothing left over. The result re-encodes to the same bytes.
pub fn decode_payload(code: u16, payload: &[u8]) -> Result<EventKind, KinError> {
    let kind = match code {
        RECIPE_SAVED => {
            if payload.len() < 21 || payload.len() > 16 + MAX_RECIPE_PAYLOAD_BYTES {
                return Err(KinError::MalformedProtocol);
            }
            let recipe_id = RecipeId(read_id(payload, 0)?);
            let mut at = 16;
            let name = read_text(payload, &mut at)?;
            let count = usize::from(*payload.get(at).ok_or(KinError::MalformedProtocol)?);
            if *payload.get(at + 1).ok_or(KinError::MalformedProtocol)? != 0 {
                return Err(KinError::MalformedProtocol);
            }
            at += 2;
            let mut ingredients = Vec::with_capacity(count);
            for _ in 0..count {
                let staple_id = read_optional_id(payload, &mut at)?.map(ItemId);
                let text = read_text(payload, &mut at)?;
                ingredients.push(Ingredient { text, staple_id });
            }
            let notes = read_text(payload, &mut at)?;
            if at != payload.len() {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::RecipeSaved {
                recipe_id,
                name,
                ingredients,
                notes,
            }
        }
        RECIPE_ARCHIVED if payload.len() == 16 => EventKind::RecipeArchived {
            recipe_id: RecipeId(read_id(payload, 0)?),
        },
        DINNER_SET => {
            let date = read_date(payload)?;
            let mut at = 4;
            let recipe_id = read_optional_id(payload, &mut at)?.map(RecipeId);
            let name = read_text(payload, &mut at)?;
            if at != payload.len() {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::DinnerSet {
                date,
                recipe_id,
                name,
            }
        }
        DINNER_CLEARED if payload.len() == 4 => EventKind::DinnerCleared {
            date: read_date(payload)?,
        },
        DINNER_COOK_SET => {
            let date = read_date(payload)?;
            let mut at = 4;
            let member_id = read_optional_id(payload, &mut at)?.map(ActorId);
            if at != payload.len() {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::DinnerCookSet { date, member_id }
        }
        MEAL_SET => {
            let date = read_date(payload)?;
            let slot = read_slot(payload)?;
            let mut at = 8;
            let recipe_id = read_optional_id(payload, &mut at)?.map(RecipeId);
            let name = read_text(payload, &mut at)?;
            if at != payload.len() {
                return Err(KinError::MalformedProtocol);
            }
            EventKind::MealSet {
                date,
                slot,
                recipe_id,
                name,
            }
        }
        MEAL_CLEARED if payload.len() == 8 => EventKind::MealCleared {
            date: read_date(payload)?,
            slot: read_slot(payload)?,
        },
        RECIPE_FAVOURITE_SET if payload.len() == 20 => EventKind::RecipeFavouriteSet {
            recipe_id: RecipeId(read_id(payload, 0)?),
            favourite: match payload[16..20] {
                [0, 0, 0, 0] => false,
                [1, 0, 0, 0] => true,
                _ => return Err(KinError::MalformedProtocol),
            },
        },
        _ => return Err(KinError::MalformedProtocol),
    };
    // Canonical form is checked by encoding it again.
    if encode_payload(&kind)? != payload {
        return Err(KinError::MalformedProtocol);
    }
    Ok(kind)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Recipe {
    pub recipe_id: RecipeId,
    pub name: String,
    pub ingredients: Vec<Ingredient>,
    pub notes: String,
    pub archived: bool,
}

/// A planned meal: a dinner (kinds 61–63) or a breakfast, lunch or snack
/// (kinds 80–81).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dinner {
    pub recipe_id: Option<RecipeId>,
    /// The name when planned: a recipe's name then, or the one-off text.
    pub name: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MealsState {
    /// Recipes in the order they were first saved.
    pub recipes: Vec<Recipe>,
    recipe_index: BTreeMap<RecipeId, usize>,
    pub dinners: BTreeMap<u32, Dinner>,
    pub cooks: BTreeMap<u32, ActorId>,
    /// Breakfast, lunch and snacks (#679), by date and slot.
    pub slot_meals: BTreeMap<(u32, MealSlot), Dinner>,
    /// Favourite recipes (#679). An archived recipe may stay listed here;
    /// the views only show active ones.
    pub favourites: BTreeSet<RecipeId>,
}

/// Where a Shopping plan's ingredients come from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlanSource {
    Recipe(RecipeId),
    Dinner(CivilDate),
    /// A date's meal in a slot (KMPQ v2); for dinner, the same as `Dinner`.
    Meal(CivilDate, MealSlot),
    /// Every meal with a recipe in the seven days from a date (KMPQ v2).
    Week(CivilDate),
}

/// What happens to one ingredient line (KMSP outcome codes).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlanOutcome {
    /// Add a Shopping item with the ingredient's text.
    Add = 1,
    /// Re-add a linked Staple: a Shopping item with the staple's text.
    ReaddStaple = 2,
    /// Something with the same text is already on Shopping.
    AlreadyOnShopping = 3,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanLine {
    pub outcome: PlanOutcome,
    /// What goes (or already is) on Shopping.
    pub text: String,
    pub staple_id: Option<ItemId>,
}

impl MealsState {
    pub fn recipe(&self, id: &RecipeId) -> Option<&Recipe> {
        self.recipe_index.get(id).map(|&index| &self.recipes[index])
    }

    pub fn active_recipe_count(&self) -> usize {
        self.recipes
            .iter()
            .filter(|recipe| !recipe.archived)
            .count()
    }

    /// A date's dinner and cook, as shown: an active recipe's current name,
    /// else the name snapshot.
    pub fn dinner_name(&self, dinner: &Dinner) -> String {
        dinner
            .recipe_id
            .and_then(|id| self.recipe(&id))
            .filter(|recipe| !recipe.archived)
            .map_or_else(|| dinner.name.clone(), |recipe| recipe.name.clone())
    }

    /// The meal planned for a date in a slot, dinner included.
    pub fn meal(&self, date: u32, slot: MealSlot) -> Option<&Dinner> {
        match slot {
            MealSlot::Dinner => self.dinners.get(&date),
            _ => self.slot_meals.get(&(date, slot)),
        }
    }

    pub fn is_favourite(&self, id: &RecipeId) -> bool {
        self.favourites.contains(id)
    }

    fn apply(&mut self, event: &EventEnvelope) {
        match &event.kind {
            EventKind::RecipeSaved {
                recipe_id,
                name,
                ingredients,
                notes,
            } => match self.recipe_index.get(recipe_id) {
                Some(&index) => {
                    let recipe = &mut self.recipes[index];
                    if !recipe.archived {
                        recipe.name.clone_from(name);
                        recipe.ingredients.clone_from(ingredients);
                        recipe.notes.clone_from(notes);
                    }
                }
                None => {
                    self.recipe_index.insert(*recipe_id, self.recipes.len());
                    self.recipes.push(Recipe {
                        recipe_id: *recipe_id,
                        name: name.clone(),
                        ingredients: ingredients.clone(),
                        notes: notes.clone(),
                        archived: false,
                    });
                }
            },
            EventKind::RecipeArchived { recipe_id } => {
                if let Some(&index) = self.recipe_index.get(recipe_id) {
                    self.recipes[index].archived = true;
                }
            }
            EventKind::DinnerSet {
                date,
                recipe_id,
                name,
            } => {
                if recipe_id.is_none_or(|id| self.recipe_index.contains_key(&id)) {
                    self.dinners.insert(
                        date.encoded(),
                        Dinner {
                            recipe_id: *recipe_id,
                            name: name.clone(),
                        },
                    );
                }
            }
            EventKind::DinnerCleared { date } => {
                self.dinners.remove(&date.encoded());
                self.cooks.remove(&date.encoded());
            }
            // A cook belongs to a planned dinner: one set for a date with
            // no dinner (another device cleared it meanwhile) is ignored, so
            // a dinner planned later never shows a cook nobody chose.
            EventKind::DinnerCookSet { date, member_id } => match member_id {
                Some(member) if self.dinners.contains_key(&date.encoded()) => {
                    self.cooks.insert(date.encoded(), *member);
                }
                Some(_) => {}
                None => {
                    self.cooks.remove(&date.encoded());
                }
            },
            // Like a dinner: a meal naming a recipe this history lacks
            // changes nothing.
            EventKind::MealSet {
                date,
                slot,
                recipe_id,
                name,
            } => {
                if recipe_id.is_none_or(|id| self.recipe_index.contains_key(&id)) {
                    self.slot_meals.insert(
                        (date.encoded(), *slot),
                        Dinner {
                            recipe_id: *recipe_id,
                            name: name.clone(),
                        },
                    );
                }
            }
            EventKind::MealCleared { date, slot } => {
                self.slot_meals.remove(&(date.encoded(), *slot));
            }
            EventKind::RecipeFavouriteSet {
                recipe_id,
                favourite,
            } if self.recipe_index.contains_key(recipe_id) => {
                if *favourite {
                    self.favourites.insert(*recipe_id);
                } else {
                    self.favourites.remove(recipe_id);
                }
            }
            _ => {}
        }
    }

    /// Whether `kind`, authored now, is a change these meals accept; `items`
    /// are the household's items (for staple links).
    pub fn check_command(&self, kind: &EventKind, items: &[ItemState]) -> Result<(), KinError> {
        let ok = match kind {
            EventKind::RecipeSaved {
                recipe_id,
                ingredients,
                ..
            } => {
                let allowed = match self.recipe(recipe_id) {
                    Some(recipe) => !recipe.archived,
                    None => self.active_recipe_count() < MAX_RECIPES,
                };
                // A new link must name an active Staple; a link the recipe
                // already had may stay after its staple was archived.
                let previous = self.recipe(recipe_id);
                allowed
                    && ingredients.iter().all(|ingredient| {
                        ingredient.staple_id.is_none_or(|id| {
                            active_staple(items, &id).is_some()
                                || previous.is_some_and(|recipe| {
                                    recipe
                                        .ingredients
                                        .iter()
                                        .any(|line| line.staple_id == Some(id))
                                })
                        })
                    })
            }
            EventKind::RecipeArchived { recipe_id } => self
                .recipe(recipe_id)
                .is_some_and(|recipe| !recipe.archived),
            EventKind::DinnerSet {
                date,
                recipe_id,
                name,
            } => {
                let recipe_ok = recipe_id.is_none_or(|id| {
                    self.recipe(&id)
                        .is_some_and(|recipe| !recipe.archived && recipe.name == *name)
                });
                let changed = self.dinners.get(&date.encoded())
                    != Some(&Dinner {
                        recipe_id: *recipe_id,
                        name: name.clone(),
                    });
                recipe_ok && changed
            }
            EventKind::DinnerCleared { date } => self.dinners.contains_key(&date.encoded()),
            EventKind::DinnerCookSet { date, member_id } => {
                self.dinners.contains_key(&date.encoded())
                    && self.cooks.get(&date.encoded()) != member_id.as_ref()
            }
            EventKind::MealSet {
                date,
                slot,
                recipe_id,
                name,
            } => {
                let recipe_ok = recipe_id.is_none_or(|id| {
                    self.recipe(&id)
                        .is_some_and(|recipe| !recipe.archived && recipe.name == *name)
                });
                let changed = self.slot_meals.get(&(date.encoded(), *slot))
                    != Some(&Dinner {
                        recipe_id: *recipe_id,
                        name: name.clone(),
                    });
                slot.is_event_slot() && recipe_ok && changed
            }
            EventKind::MealCleared { date, slot } => {
                self.slot_meals.contains_key(&(date.encoded(), *slot))
            }
            EventKind::RecipeFavouriteSet {
                recipe_id,
                favourite,
            } => {
                self.recipe(recipe_id)
                    .is_some_and(|recipe| !recipe.archived)
                    && self.is_favourite(recipe_id) != *favourite
            }
            _ => false,
        };
        if ok {
            Ok(())
        } else {
            Err(KinError::InvalidEvent)
        }
    }

    /// What adding a recipe's (or a date's meal's, or a week's) ingredients
    /// to Shopping does now, line by line (ADR 0012, ADR 0022 §7). Lines that
    /// come to the same text count once, across recipes too; what is already
    /// on Shopping is not added again, which is also what makes a retry safe.
    pub fn shopping_plan(
        &self,
        source: PlanSource,
        items: &[ItemState],
    ) -> Result<Vec<PlanLine>, KinError> {
        let planned_recipe = |date: CivilDate, slot: MealSlot| {
            self.meal(date.encoded(), slot)
                .and_then(|meal| meal.recipe_id)
                .and_then(|id| self.recipe(&id))
        };
        let recipes: Vec<&Recipe> = match source {
            PlanSource::Recipe(id) => vec![self
                .recipe(&id)
                .filter(|recipe| !recipe.archived)
                .ok_or(KinError::InvalidEvent)?],
            PlanSource::Dinner(date) => {
                vec![planned_recipe(date, MealSlot::Dinner).ok_or(KinError::InvalidEvent)?]
            }
            PlanSource::Meal(date, slot) => {
                vec![planned_recipe(date, slot).ok_or(KinError::InvalidEvent)?]
            }
            // The week: each day in order, its meals in slot order, each
            // recipe once. A week of one-offs (or of nothing) plans nothing.
            PlanSource::Week(start) => {
                let mut recipes: Vec<&Recipe> = Vec::new();
                for offset in 0..7 {
                    let date = start
                        .checked_add_days(offset)
                        .ok_or(KinError::MalformedProtocol)?;
                    for slot in MealSlot::ALL {
                        if let Some(recipe) = planned_recipe(date, slot) {
                            if !recipes
                                .iter()
                                .any(|seen| seen.recipe_id == recipe.recipe_id)
                            {
                                recipes.push(recipe);
                            }
                        }
                    }
                }
                recipes
            }
        };
        let mut on_shopping: Vec<String> = items
            .iter()
            .filter(|item| {
                item.classification == ItemClassification::Shopping
                    && item.status == ItemStatus::Active
            })
            .map(|item| shopping_key(&item.text))
            .collect();
        let mut planned: Vec<String> = Vec::new();
        let mut lines = Vec::new();
        for ingredient in recipes.iter().flat_map(|recipe| &recipe.ingredients) {
            let staple = ingredient
                .staple_id
                .and_then(|id| active_staple(items, &id));
            let text = staple.map_or_else(|| ingredient.text.clone(), |item| collapse(&item.text));
            let key = shopping_key(&text);
            if planned.contains(&key) {
                continue;
            }
            planned.push(key.clone());
            let outcome = if on_shopping.contains(&key) {
                PlanOutcome::AlreadyOnShopping
            } else if staple.is_some() {
                PlanOutcome::ReaddStaple
            } else {
                PlanOutcome::Add
            };
            if outcome != PlanOutcome::AlreadyOnShopping {
                on_shopping.push(key);
            }
            lines.push(PlanLine {
                outcome,
                text,
                staple_id: staple.map(|item| item.item_id),
            });
        }
        Ok(lines)
    }
}

/// The active Staple item with this ID, if there is one.
fn active_staple<'a>(items: &'a [ItemState], id: &ItemId) -> Option<&'a ItemState> {
    items.iter().find(|item| {
        item.item_id == *id
            && item.classification == ItemClassification::Staple
            && item.status != ItemStatus::Archived
    })
}

/// Replays one meals event into the shared state (copy-on-write).
pub fn apply(meals: &mut Arc<MealsState>, event: &EventEnvelope) -> Result<(), KinError> {
    if event.actor_id.0 == [0; 16] || event.device_id.0 == [0; 16] {
        return Err(KinError::InvalidEvent);
    }
    Arc::make_mut(meals).apply(event);
    Ok(())
}

/// Staple link state in KMLS: 0 none, 1 active staple, 2 archived or missing.
fn staple_status(items: &[ItemState], staple_id: Option<ItemId>) -> u8 {
    match staple_id {
        None => 0,
        Some(id) if active_staple(items, &id).is_some() => 1,
        Some(_) => 2,
    }
}

/// KMLS v1, meals as the host shows them:
/// "KMLS", version u16 = 1, reserved u16; recipe count u32 (active recipes,
/// in the order first saved), dinner count u32 (dates within the window,
/// ascending); then each recipe: ID [16], name (u16 length + UTF-8),
/// ingredient count u8, 3 reserved, each ingredient: staple status u8
/// (0 none, 1 active, 2 archived or missing), 3 reserved, staple ID [16]
/// (zero when none), text (u16 + UTF-8); notes (u16 + UTF-8); then each
/// dinner: date u32 (YYYYMMDD), flags u8 (bit 0 recipe, bit 1 cook), 3
/// reserved, recipe ID [16] (zero when none), cook member ID [16] (zero when
/// none), name as shown (u16 + UTF-8).
pub fn encode_meals(
    meals: &MealsState,
    items: &[ItemState],
    as_of: CivilDate,
) -> Result<Vec<u8>, KinError> {
    let today = as_of.day_number();
    let window = today.saturating_sub(DINNERS_BEHIND)..=today.saturating_add(DINNERS_AHEAD);
    let recipes: Vec<&Recipe> = meals
        .recipes
        .iter()
        .filter(|recipe| !recipe.archived)
        .collect();
    let dinners: Vec<(CivilDate, &Dinner)> = meals
        .dinners
        .iter()
        .filter_map(|(date, dinner)| {
            let date = CivilDate::from_encoded(*date).ok()?;
            window
                .contains(&date.day_number())
                .then_some((date, dinner))
        })
        .collect();
    let mut out = Vec::new();
    out.extend_from_slice(b"KMLS");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&(recipes.len() as u32).to_le_bytes());
    out.extend_from_slice(&(dinners.len() as u32).to_le_bytes());
    for recipe in recipes {
        out.extend_from_slice(&recipe.recipe_id.0);
        push_text(&mut out, &recipe.name);
        out.extend_from_slice(&[recipe.ingredients.len() as u8, 0, 0, 0]);
        for ingredient in &recipe.ingredients {
            out.extend_from_slice(&[staple_status(items, ingredient.staple_id), 0, 0, 0]);
            out.extend_from_slice(&ingredient.staple_id.map_or([0; 16], |id| id.0));
            push_text(&mut out, &ingredient.text);
        }
        push_text(&mut out, &recipe.notes);
    }
    for (date, dinner) in dinners {
        let cook = meals.cooks.get(&date.encoded());
        out.extend_from_slice(&date.encoded().to_le_bytes());
        out.extend_from_slice(&[
            u8::from(dinner.recipe_id.is_some()) | (u8::from(cook.is_some()) << 1),
            0,
            0,
            0,
        ]);
        out.extend_from_slice(&dinner.recipe_id.map_or([0; 16], |id| id.0));
        out.extend_from_slice(&cook.map_or([0; 16], |id| id.0));
        push_text(&mut out, &meals.dinner_name(dinner))
    }
    Ok(out)
}

/// KMLS v2, every meal of the day and favourites (#679, `kin_meal_plans`):
/// "KMLS", version u16 = 2, reserved u16; recipe count u32 (active recipes,
/// in the order first saved), meal count u32 (dates within the window, by
/// date then slot); then each recipe as in v1 except that the byte after
/// the ingredient count holds flags (bit 0 favourite) and two reserved
/// bytes follow it; then each meal: date u32 (YYYYMMDD), slot u8 (1
/// breakfast, 2 lunch, 3 dinner, 4 snack), flags u8 (bit 0 recipe, bit 1
/// cook; a cook only on dinner), 2 reserved, recipe ID [16] (zero when
/// none), cook member ID [16] (zero when none), name as shown (u16 + UTF-8).
/// KMLS v1 (`kin_meals`) is unchanged.
pub fn encode_meal_plans(
    meals: &MealsState,
    items: &[ItemState],
    as_of: CivilDate,
) -> Result<Vec<u8>, KinError> {
    let today = as_of.day_number();
    let window = today.saturating_sub(DINNERS_BEHIND)..=today.saturating_add(DINNERS_AHEAD);
    let in_window = |date: u32| {
        CivilDate::from_encoded(date)
            .ok()
            .is_some_and(|date| window.contains(&date.day_number()))
    };
    let recipes: Vec<&Recipe> = meals
        .recipes
        .iter()
        .filter(|recipe| !recipe.archived)
        .collect();
    // Both maps are sorted; merged here by (date, slot).
    let mut planned: Vec<(u32, MealSlot, &Dinner)> = meals
        .dinners
        .iter()
        .map(|(date, dinner)| (*date, MealSlot::Dinner, dinner))
        .chain(
            meals
                .slot_meals
                .iter()
                .map(|((date, slot), meal)| (*date, *slot, meal)),
        )
        .filter(|(date, _, _)| in_window(*date))
        .collect();
    planned.sort_by_key(|(date, slot, _)| (*date, *slot));
    let mut out = Vec::new();
    out.extend_from_slice(b"KMLS");
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&(recipes.len() as u32).to_le_bytes());
    out.extend_from_slice(&(planned.len() as u32).to_le_bytes());
    for recipe in recipes {
        out.extend_from_slice(&recipe.recipe_id.0);
        push_text(&mut out, &recipe.name);
        out.extend_from_slice(&[
            recipe.ingredients.len() as u8,
            u8::from(meals.is_favourite(&recipe.recipe_id)),
            0,
            0,
        ]);
        for ingredient in &recipe.ingredients {
            out.extend_from_slice(&[staple_status(items, ingredient.staple_id), 0, 0, 0]);
            out.extend_from_slice(&ingredient.staple_id.map_or([0; 16], |id| id.0));
            push_text(&mut out, &ingredient.text);
        }
        push_text(&mut out, &recipe.notes);
    }
    for (date, slot, meal) in planned {
        let cook = (slot == MealSlot::Dinner)
            .then(|| meals.cooks.get(&date))
            .flatten();
        out.extend_from_slice(&date.to_le_bytes());
        out.extend_from_slice(&[
            slot.code(),
            u8::from(meal.recipe_id.is_some()) | (u8::from(cook.is_some()) << 1),
            0,
            0,
        ]);
        out.extend_from_slice(&meal.recipe_id.map_or([0; 16], |id| id.0));
        out.extend_from_slice(&cook.map_or([0; 16], |id| id.0));
        push_text(&mut out, &meals.dinner_name(meal));
    }
    Ok(out)
}

/// KMSP v1, a Shopping plan: "KMSP", version u16 = 1, reserved u16, line
/// count u32; then each line: outcome u8 (1 add, 2 re-add staple, 3 already
/// on Shopping), 3 reserved, staple ID [16] (zero unless re-added), text
/// (u16 length + UTF-8).
pub fn encode_plan(lines: &[PlanLine]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"KMSP");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&(lines.len() as u32).to_le_bytes());
    for line in lines {
        out.extend_from_slice(&[line.outcome as u8, 0, 0, 0]);
        out.extend_from_slice(&line.staple_id.map_or([0; 16], |id| id.0));
        push_text(&mut out, &line.text);
    }
    out
}
