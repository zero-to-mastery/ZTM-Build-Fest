# ADR 0012 — Meals: Recipes, Dinners, Cooks and Ingredients to Shopping

Status: Accepted (#334, for the meals and groceries epic #333)

## Context

The household wants to plan the week's dinners from its own recipes, see who
is cooking, and put a dinner's ingredients on Shopping in one tap, reusing the
Staples it already keeps. The design review (#333) raised five problems to
settle before any interface:

- Re-adding a staple today (`handleReplenishStaple`) creates a new, unlinked
  Shopping item and never checks whether it is already on Shopping, so
  feedback such as "Already on Shopping" can't be truthful and repeated taps
  duplicate.
- A cook can't be a third target kind on the responsibility event (kind 41):
  v1.0 decoders reject an unknown target kind as malformed.
- Adding a dinner's ingredients is several writes; a failure part-way or a
  retry must never duplicate.
- A dinner needs an identity that merges when two adults plan the same
  evening offline.
- Everything lands in the household history, which is capped at 10,000
  events (`wire::MAX_EVENT_COUNT`), so Meals must be frugal with events.

Facts from the code: items carry a classification (today, need, shopping,
staple) and a status; playbooks (#33–#34) already model "a titled list saved
whole and archivable"; playbook instantiation already adds several items as an
idempotent batch whose ids are generated up front; replay orders events by
logical time and event id, so "last writer wins" is deterministic everywhere.

## Decision

### Recipes
- **`RecipeSaved` (kind 59)**: `recipe_id`, `name`, `ingredients` (ordered
  lines, each `{ text, staple_id? }`), `notes`. Saved whole on every edit, like
  `PlaybookSaved`; the latest save wins.
- **`RecipeArchived` (kind 60)**: hides a recipe; it can't be brought back
  (save it again as a new recipe), matching playbooks and notes.
- Ingredient text is free text: no quantity or unit parsing (cut in #333).
- An ingredient's `staple_id` links it to a Staple item. The link is a
  suggestion the person confirms: the interface preselects a staple only on an
  exact normalized text match and says so.
- Limits: at most **200** active recipes; **40** ingredients per recipe;
  name 1–80 characters (256 bytes); ingredient 1–120 characters (256 bytes);
  notes up to 2,000 characters (4,096 bytes), which can hold a URL (no
  separate link field). Text is trimmed and inner whitespace collapsed by
  Rust; empty lines are dropped by the editor before saving.

### Dinners
- **`DinnerSet` (kind 61)**: `date` (civil date), `recipe_id?`, `name`. Exactly
  one dinner per civil date; the latest event for a date wins. `name` is always
  stored: for a recipe it is a snapshot of the recipe's name when planned (so a
  dinner still reads correctly after its recipe is archived), and for a one-off
  ("Something else…") it is the only text. While the recipe is active the view
  shows the recipe's current name.
- **`DinnerCleared` (kind 62)**: `date`. Removes that date's dinner and its
  cook.
- **`DinnerCookSet` (kind 63)**: `date`, `member_id?` (absent means "No one
  yet"). A new kind, never a target of kind 41. Any current member can be the
  cook (Adult, Limited or Temporary: children cook too); the cook picker offers
  only current members, and a cook who later leaves shows as "A former
  household member". It only applies while that date has a dinner: replay
  ignores a cook set for a date with no dinner (one device cleared it while
  another chose a cook), so a dinner planned later starts with no one cooking.
  Setting a dinner keeps the cook already chosen for that date. Nothing is
  counted, ranked or compared.
- Merge: two devices planning the same date offline converge on the event that
  sorts last in replay (logical time, then device and event ID) — the same rule as every
  other latest-wins field. Catch-up doesn't list meal changes in this first
  slice; Tonight on Today and the week show the current plan instead.
- The week is a view, Monday to Sunday (matching weekly routines). The
  projection keeps dinners from 35 days before the projection date to 370 days
  after it; older dinners stay in the history but leave the view.

### Replay and commands
Like the fridge (ADR 0011), replay never fails on a decoded meals event: a
dinner naming a recipe the history lacks and an archive of an unknown recipe
change nothing, and an archived recipe stays archived. Caps and validity are
command rules (`MealsState::check_command`), so two devices that each saved
the 200th recipe offline still merge. A whole recipe is at most 4,352 bytes
after its ID, so it always fits one sync envelope (6,144 bytes of
ciphertext).

### "Already on Shopping"
- **Rust decides**, by normalized text: an item is on Shopping when it is
  classified Shopping, not completed and not archived, and its text equals the
  candidate's text after trimming, collapsing whitespace and Unicode
  lowercasing (`str::to_lowercase`; no other folding). No format change: items
  added by hand count too.
- The same rule answers the existing staple "Add to Shopping" button, which
  can now say "Already on Shopping" instead of duplicating (#338).

### Ingredients to Shopping
- **A planning query in Rust, then ordinary item events.** Rust's
  `meal_shopping_plan` takes a recipe (or a date's dinner) and returns, per
  ingredient line, one outcome:
  - **re-add staple** — linked to an active staple not already on Shopping:
    add a Shopping item with the staple's current text;
  - **add** — unlinked (or its staple archived) and not already on Shopping:
    add a Shopping item with the ingredient's text;
  - **already on Shopping** — nothing to add.
  Lines that normalize to the same text count once.
- JavaScript appends one `ItemAdded` (Shopping) per planned addition, with ids
  generated up front, as playbook instantiation does. This is an idempotent
  batch, not one atomic command: after a partial failure, **Retry** asks Rust
  for the plan again, and anything added before is now "already on Shopping",
  so nothing is ever added twice. Feedback is built from the plan's outcomes
  ("Added 4 · Re-added 2 Staples (Milk, Eggs) · Already on Shopping 1
  (Bread)"), and offline wording follows `itemActionFeedback`: saved on this
  device, never "the household has it".
- No week-level "Add this week's ingredients" in this epic: one dinner (or
  recipe) at a time keeps the feedback readable and the event count small.

### Budget
A typical week (seven dinners, a few cooks, one or two recipe edits, ten to
twenty ingredients added) is 20–40 events, about 1,500–2,000 a year, against
the household's 10,000-event cap shared with everything else. Meals adds no
events on its own (nothing timed or automatic), and recipes are saved whole
rather than line by line. If the cap becomes the limiting factor, history
checkpointing is the general answer, not a Meals-specific one.

## Alternatives considered

- **Store a staple id on the Shopping item** (an additive field on
  `ItemAdded`). Rejected: changing a frozen v1.0 payload needs a new kind
  anyway, it would not catch items typed by hand, and it would not make
  retries idempotent on its own.
- **One atomic Rust command that emits many events.** The ABI returns one
  event per command (`KCMT`); a multi-event result is a new ABI shape and a new
  store transaction path for one feature. The idempotent batch reuses the
  playbook path and is safe by construction.
- **Cook as responsibility target kind 3.** Rejected by the review: older
  decoders treat it as malformed.
- **Dinner identity by event id** (several dinners per date). Rejected: the
  owner wants one dinner per evening, and a date key makes offline conflicts
  resolve on their own.

## Consequences

- Five additive event kinds (59–63) in the household history, recorded in
  [V1.0-COMPATIBILITY](../V1.0-COMPATIBILITY.md). As with member names
  (v1.3.0), a device from before Meals that receives one pauses sync with an
  "unsupported" error, keeps its data, and resumes once it updates (the
  installed app normally updates when next opened). Nothing is written until
  someone uses Meals, so households that never plan a dinner are unaffected.
- The replenish-staple button gains an honest "Already on Shopping".
- Two people adding the same ingredient on two offline devices can still both
  add it (each device decides from what it has seen); after sync both items
  show, as two hand-typed items would today.
- `meal_shopping_plan`, recipe and dinner views live in Rust; JavaScript only
  renders and reports outcomes.
