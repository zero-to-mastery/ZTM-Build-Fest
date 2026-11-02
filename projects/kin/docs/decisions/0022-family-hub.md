# ADR 0022 — The family hub: calendar, outside calendars, kitchen display, photo frame, chore chart, meal plans

Status: **Accepted** (#652, epic #651). Owner decisions on 2026-10-21:
outside calendars are both imported and, opt-in per calendar, synced by the
service; points and comparing are allowed for children, adults join only if
an admin allows it; weather is left to a future add-on (#688).

## Context

Families compare Kin with dedicated hubs such as Skylight: a shared calendar
coloured by person, an always-on screen in the kitchen, a photo frame, a chore
chart children enjoy, and meal planning. Kin already has dated items,
routines, taking turns, dinners and recipes, the fridge, This week, Simple
view and household feature switches ([ADR 0021](0021-kin-for-everyone.md)).
What's missing is a real calendar and the screen that brings it together.

Facts that shape the design:

- Rust has no time-zone database and Kin takes no dependencies. Browsers
  have one (`Intl`).
- Only the service knows who is a household admin; history events can be
  written by any member's device ([ADR 0021](0021-kin-for-everyone.md) §2).
- Household kinds are numbered to 70; private kinds are 100–199
  ([ADR 0019](0019-member-private-log.md)). Kinds 71–99 are free.
- PRODUCT-BOUNDARIES forbids points, streaks and scores. The owner now allows
  them for children.

## Decision

### 1. Calendar events in the household history

- **Kinds** (additive, household log):
  - `CALENDAR_EVENT_SAVED` (71): the whole event, replacing any earlier
    version.
  - `CALENDAR_EVENT_CANCELLED` (72): one occurrence (by its original start)
    or the whole series.
  - `CALENDAR_EVENT_RESTORED` (73): undoes a cancel.
  - `MEMBER_COLOUR_SET` (74): a member's colour, visible to the household
    like a member's name (kind 51).
- **An event** has an ID, a title (≤ 200 bytes), an optional place (≤ 200)
  and notes (≤ 2,000), attendees (member IDs, ≤ 16), a countdown flag, an
  optional source UID for imported events, and either:
  - **all-day:** a start civil date and an end civil date; or
  - **timed:** a start local date-time, an end local date-time, and an IANA
    time-zone name (≤ 64 bytes, validated as text only).
- **Repeats:** a subset of iCalendar RRULE: daily, weekly (on chosen
  weekdays), monthly (on a day of the month or the nth weekday), and yearly;
  with an interval, and an end by count or by date. Changing one occurrence
  is a cancel of that occurrence plus a standalone event linked to the
  series.
- **Time zones:** Rust expands repeats in **local civil time** for the
  event's own zone. The browser turns local times into instants with `Intl`
  when it draws them. So a 9:00 weekly event stays at 9:00 across daylight
  saving time, and Rust needs no zone rules. Two members in different zones
  see the same instant at their own local times.
- **Read export:** the occurrences between two civil dates, with the
  cancellations applied, merged with dated items, routines, meals and
  countdowns. This week and Today read from it.
- **Colours:** each member chooses one of 12 palette colours; there are
  defaults by join order. Colour is never the only signal: names show beside
  it.

### 2. Calendar in the app

- **This week grows into the Calendar.** It keeps Today marked in the
  navigation, with Day, Week and Month views. There is no sixth destination.
- **Today** shows today's events and the next countdown.
- **Feature switch:** "Calendar" (bit 14). This week (bit 5) stays as the
  Week view's switch.
- **Adding an event** is a few taps: title, when, who. Place, notes and
  repeats live in details. Cancel offers "this one" or "all"; Undo follows
  every change.

### 3. Outside calendars: import and opt-in sync (owner decision: both)

- **Import (always, private):** opening or sharing a `.ics` file parses it on
  the device (a native iCalendar parser in Rust) and saves the events once,
  as kind 71 with their source UID, so re-importing updates rather than
  duplicates them. The service never sees the file.
- **Sync (opt-in per calendar):**
  - A member pastes a calendar's private iCal link and chooses "Just me" or
    "Everyone in the household".
  - Before turning it on they see: "Your Kin server will download this
    calendar about every 30 minutes and can read it while it does."
  - **What the service stores:** the link, owner, audience, last-fetch status
    and an ETag. A downloaded feed is cached in memory for at most 30
    minutes. Nothing from the feed is written to the database.
  - **What devices do:** devices in the audience fetch the feed through an
    authenticated route, parse it locally, and keep the occurrences in local
    encrypted storage.
  - **Not in the history.** These events never enter the household history,
    so they don't grow it, and turning the subscription off removes them
    everywhere.
  - **Limits and safety:**
    - public HTTPS only, with every redirect re-checked;
    - no private, loopback or link-local addresses after DNS resolution;
    - at most 2 MB and a 15-second timeout per fetch;
    - 10 subscriptions per member and 30 per household;
    - the service backs off on errors.
  - PRIVACY and THREAT-MODEL say the service reads synced calendars and
    holds their links (anyone with a link can read that calendar).
  - **As built (#667, #668):** only Adults add calendars, for themselves or
    everyone; Limited and Temporary members see shared ones. Its owner or a
    household admin turns one off. The service downloads only when a device
    in the audience asks and its copy is 30 minutes old or more, so a
    calendar nobody opens isn't fetched; adding one downloads it once to
    check the link. Links must be `https:` on port 443 (`webcal:` becomes
    `https:`); 20 additions per member an hour; backoff from 5 minutes to 6
    hours. Rust's range read replays the household history, so synced
    events are expanded on the device by a port of its repeat walker
    (`web/calendar/feed-expand.js`) and reach the views as read-only
    occurrences through `web/calendar/external.js`.

### 4. Kitchen display mode

- **A device mode, not a new member kind.** An adult's device is switched
  into "Kitchen display". It stays signed in as that adult; leaving the mode
  needs that adult's password or passkey.
- **What it shows:**
  - today's events and countdowns, and a week strip;
  - each child's chore chart in their colour;
  - tonight's meals, the shopping list and the fridge;
  - the photo frame when idle.
  - Everything is touch-first, with targets of at least 64 px. Panels are
    defined as data (a list of panel kinds and their places), which is the
    seam a future add-on (#688) can use.
- **What it never shows:** that adult's private storage (journal, Just for me,
  reminders), Search, admin actions, Household settings, or Chat
  composition. It does show chat messages read-only if Chat is on.
- **Screen behaviour:**
  - stays awake (Screen Wake Lock) and dims on a night schedule;
  - re-acquires the wake lock when the page becomes visible again;
  - shows the last known state when offline.
- **Ticking off a child's chore on the display** records it on that adult's
  device. Points go to the chore's owner (the routine's turn or the item's
  responsibility), never to the device's adult.

### 5. Shared photo frame

- **Kinds:** `ALBUM_PHOTO_ADDED` (75): photo ID, attachment reference and
  optional caption ≤ 200 bytes. `ALBUM_PHOTO_REMOVED` (76).
- **Storage:** photos reuse household attachment blobs, encrypted as today.
  At most 500 photos per household.
- **Who can remove:** whoever added a photo, or an admin. The admin check is
  on the host append path, as with the sitter page, and THREAT-MODEL notes
  it.
- **Adding:** from the phone, the share sheet or a chat photo.
- **On the display:** a screensaver after a quiet period, crossfading (no
  motion with reduced motion), and touch returns.

### 6. Chore chart and points (owner decision)

- **Children (Limited members) are on the chart.** It shows each child's
  routines and items for today and the week, with pictures, in their colour.
- **Points:**
  - **Earning:** 1 point per completed chore by default, adjustable per
    routine (kind 77 `CHORE_POINTS_SET`, routine ID and points 0–10).
  - **Calculation:** totals are worked out from the history (completions by
    the chore's owner) per week and reset weekly. Children may see each
    other's totals.
  - **Rewards:** a parent may set a goal per child (kind 78
    `CHORE_REWARD_SET`: member, goal points, text ≤ 120 bytes, e.g. "20 =
    movie night").
- **Adults:**
  - **Admin switch:** they join only if a household admin allows it. That is
    a service setting changed with fresh confirmation, like feature switches.
  - **Personal choice:** even then, each adult opts in themselves (kind 79
    `CHORE_CHART_JOINED`, with joined true or false; Rust accepts it only
    from the member it names) and can leave at any time.
  - **No pressure on adults:** no adult-only leaderboard, no streaks, no
    reminders or notifications about points, and no history beyond the
    current week.
- **PRODUCT-BOUNDARIES** changes "no points, streaks, scores" to: "no points,
  streaks or scores for adults unless an admin allows and the adult opts in;
  the children's chore chart may show weekly points and compare children;
  never streaks or shaming."

### 7. Meal plans for every meal

- **Kinds:** `MEAL_SET` (80): a date, a slot (breakfast, lunch, snack) and a
  recipe or free text. `MEAL_CLEARED` (81). Dinner keeps its existing kinds
  61–63, so older dinners stay valid; the projection shows all four slots.
- **Favourites:** kind 82 `RECIPE_FAVOURITE_SET` (recipe ID, on or off).
- **Shopping:** "Add this week's ingredients to Shopping" covers every slot.

### 8. Version

The family hub ships as **v2.0.0**, a product milestone: a new Calendar with
Today and This week reworked, display mode and the chore chart. Every format
change is additive. Devices on v1.x pause household sync on the new kinds
("update Kin") and keep their data, as for every earlier additive kind.
VERSIONING records that this major version doesn't break v1.0 formats.

## Consequences

- New kinds 71–82, all additive, with V1.0-COMPATIBILITY rows and test
  vectors.
- Service: calendar subscription tables and routes, a fetcher with SSRF
  protections, and an admin service setting for adults on the chore chart.
- PRODUCT-BOUNDARIES, PRIVACY, THREAT-MODEL, UX and VERSIONING are updated by
  the stories that build each part.

## Alternatives considered

- **Instants only, in UTC.** Repeats would drift by an hour across daylight
  saving time. Rejected; local civil time plus a zone is how calendars work.
- **A time-zone database in Rust.** A large table to maintain, against the
  dependency rules. The browser's `Intl` already has it.
- **Writing synced calendars into the household history.** Every refresh
  would add events, and the history would grow forever. Rejected in favour
  of device-local caches.
- **A "Display" member kind.** It would be a new permission tier, which
  AGENTS.md says not to add. The display is a mode of an adult's device.
- **Weather now.** Deferred to add-ons (#688), per the owner.
