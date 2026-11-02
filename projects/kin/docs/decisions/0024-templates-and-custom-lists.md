# ADR 0024 — Templates, your own words, custom lists, inventory and bigger groups

Status: **Proposed (not planned yet)** (#650). The owner parked the idea on
2026-10-21 ("keep this idea on the back burner"). Nothing here is scheduled.
Section 4 (bigger groups) **needs an owner decision** before any work on it,
because it changes [PRODUCT-BOUNDARIES](../planning/PRODUCT-BOUNDARIES.md) and the
scope in [AGENTS.md](../../AGENTS.md). Related: ADR 0023 (add-ons), written
at the same time.

## Context

The owner wants the same Kin for a different kind of group:

> "the ability to change what things are called like so I could use a
> version for work that catered more to my coworkers like a call log, or a
> maybe a way to add parts to inventory instead of a fridge. The same
> concepts and core but let the admin customize the app more for their own
> needs."

Issue #650 splits this into four parts: templates and your own words,
custom lists with fields, inventory, and bigger groups. It also mentions
several spaces on one device, a CSV export of a custom list and a daily
summary.

Facts that shape the design:

- **Event-sourced, end-to-end encrypted, local-first.** Household state is
  replayed by Rust from the household history
  ([ADR 0001](0001-event-sourced-household-state.md),
  [ADR 0002](0002-rust-owns-domain-logic.md)). The service stores sealed
  envelopes and can't read them. New formats are additions under
  [V1.0-COMPATIBILITY](../V1.0-COMPATIBILITY.md).
- **Event kinds.** Household kinds are used up to 82 (`RECIPE_FAVOURITE_SET`,
  `rust/src/meals.rs`). Kinds 83–99 are free for household use. Private kinds
  are 100–199 in a member's own log
  ([ADR 0019](0019-member-private-log.md)).
- **Feature switches** are a bit set on the service
  ([ADR 0021](0021-kin-for-everyone.md) §2): `households.features_off`, bits
  0–17 in `web/features.js` and `HOUSEHOLD_FEATURE_BITS` in
  `server/pairing-service/shared.mjs`. A set bit means off, so a new bit is
  on by default for every household.
- **Only the service knows who is a household admin.** Rust can't tell
  members apart by role, so rules such as "only an admin may" are kept on
  the app's single command append path and noted in
  [THREAT-MODEL](../THREAT-MODEL.md) (the sitter page, album removal, the
  chore chart).
- **Labels are code today.** Page names are in `web/routes.js`
  (`PRIMARY_DESTINATIONS`, `SEGMENTS`, `PAGE_TITLES`), feature names in
  `web/features.js`, list names in `web/search.js`
  (`CLASSIFICATION_LABELS`), and plain-language explanations in
  `web/help/glossary.js`, which easy mode relies on.
- **The fridge is a drawing board**, not a store of things: strokes and
  magnets in kinds 52–58 (`rust/src/board.rs`,
  [ADR 0011](0011-family-fridge.md)). Shopping already has **Staples**
  (item classification 3: "something you buy again and again") and store
  sections ([ADR 0015](0015-store-sections.md)).
- **Membership is capped** in `server/identity-limits.mjs`: 12 active
  members, of whom at most 4 Adults and 8 Limited, and 16 trusted devices.
  The household key has at most 128 epochs over a household's life
  (`MAX_KEY_EPOCHS`, `server/sync-contract.mjs`); each member removal or
  device revocation uses one.
- **The camera is already used natively.** `<kin-qr-scanner>`
  (`web/components/kin-qr-scanner.js`) feeds downscaled grayscale frames to
  a QR decoder written from scratch in Rust (`rust/src/qr/decode.rs`).
- **Boundaries.** PRODUCT-BOUNDARIES prefers "small-household membership"
  and avoids "generic project-management/workflow systems". AGENTS.md says
  not to introduce teams, organization accounts or permission tiers beyond
  the household admin flag.

## Decision

### 1. Templates and your own words

#### 1.1 Where renamed words live: an event in the household history

- **Kind 83 `HOUSEHOLD_WORDS_SET`** holds the household's whole set of
  renamed words, replacing the previous set (like store sections, kind 66).
  - Payload: template u8 (0 none, 1 Family home, 2 Small team / shop,
    3 Roommates), count u8 (0–48), then per entry a word key u16 and a text
    (length u8, 1–40 UTF-8 bytes). At most 2,048 bytes.
  - An empty set means Kin's own words.
- **Why the history and not the service, unlike feature switches:**
  - The words say what the group is ("Call log", "Parts", "Crew"). In the
    history they are end-to-end encrypted; on the service they would be
    plaintext the operator can read. Feature switches are just numbers, so
    that cost didn't apply to them.
  - Offline devices and households without sync already get the words
    through replay, export and restore, with no new storage.
- **Who may change them:** household admins. As with the sitter page and
  album removal, the app enforces this on its command append path, because
  Rust can't tell admins apart. A modified client of another member could
  write a kind-83 event; the result is cosmetic, shows "Words changed by
  Sam on 3 Nov" under Household › Features, and an admin can set them again
  or choose "Use Kin's words".

#### 1.2 What can be renamed

Each renameable word has a stable key (u16) in a table in
`web/words.js`; the table only grows and a key is never reused. Rust
validates the bytes and keeps the latest set; it does not know what the
keys mean.

| Can be renamed | Examples of Kin's word → a household's word |
| --- | --- |
| The five destinations (`PRIMARY_DESTINATIONS`) | Household → Shop, Updates → Notes for the team |
| Page segments (`SEGMENTS`), except the fixed ones below | To do → Jobs, Shopping → Order list, Staples → Regulars, Areas & status → Locations |
| Feature names (`FEATURES[].label`) | Fridge → Whiteboard, Sitter page → Visitor page, Talk later → Bring up at the meeting |
| What member kinds are called | Adult → Team member, Limited → Trainee, Temporary → Visitor |
| Custom lists and inventory (sections 2 and 3) | Their names are part of their own events, not this set |

**Never renamed**, so safety prompts and Help stay unambiguous:

- People & devices, Privacy & recovery, Features, Help, Search, Lock, and
  the name Kin;
- security and account words: admin, password, passkey, backup key, backup
  code, recovery, encrypted, export, restore;
- error messages, confirmation dialogs about removing people or deleting
  data, and the printed setup sheet's security steps.

Renaming a member kind changes only its name. A "Trainee" is still a
Limited member with Limited's rights. Section 4 says why this matters for
work groups.

#### 1.3 How renamed words work with Help, search and plain language

- **Where the household's word shows:** navigation, page titles, segment
  tabs, Today's section headings, Quick add destinations, the Features page,
  search result tags and This week.
- **Help** keeps its topics keyed by route. A renamed topic is titled with
  both words, for example "Whiteboard (Kin calls this the Fridge)". Help's
  "Words on this page" lists the household's word with Kin's one-sentence
  explanation from `GLOSSARY`, so easy mode still never leaves a word
  unexplained.
- **Search** matches both the household's word and Kin's word, so typing
  "fridge" still finds the Whiteboard and its Help topic.
- **Plain language:** the editor checks words the same way for everyone and
  doesn't judge them. It shows a preview of the navigation with the new
  words before saving.

#### 1.4 Validation and limits

- 1–40 UTF-8 bytes after trimming; Unicode NFC; one line; no control
  characters; at least one letter or digit.
- At most 48 renamed words.
- No two destinations, and no two segments of one page, may end up with
  the same word (compared ignoring case).
- A word may not equal one of the never-renamed words above ("Privacy &
  recovery", "Help" and so on), so a renamed page can't pose as a safety
  page.
- Commands enforce all of this. Replay accepts any well-formed set and
  ignores entries with unknown keys, so a newer device's words don't break
  an older one's display.

#### 1.5 Templates

A template is a **starting point applied once**, not a mode. It is a static
table in `web/templates.js`. Applying one shows a preview, then does three
things, each of which the admin can change afterwards:

1. sets feature switches through the existing admin route (fresh passkey or
   password, [ADR 0021](0021-kin-for-everyone.md) §2);
2. writes one kind-83 event with the template's words and its number;
3. offers its suggested custom lists (section 2), each created only if
   ticked.

| | Family home | Small team / shop | Roommates |
| --- | --- | --- | --- |
| Words | Kin's own | Household → Shop; To do → Jobs; Shopping → Order list; Staples → Regulars; Areas & status → Locations; Fridge → Whiteboard; Sitter page → Visitor page; Adult → Team member; Limited → Trainee; Temporary → Visitor | Household → Home; Shopping → Shared shopping; Sitter page → Guest page; Temporary → Guest |
| Switched off | nothing | Meals, Chore chart, Family photos, Journal | Chore chart, Family photos |
| Switched on | as now | Custom lists, Inventory | Custom lists |
| Suggested lists | none | Call log, Deliveries | House bills |

The template number in kind 83 is only shown ("Started from Small team /
shop") and used to pick Help examples. Nothing else depends on it, and no
code branches on it.

### 2. Custom lists with fields

A custom list is a named list whose entries have a few typed fields. It
is for **records** (calls taken, deliveries, bills), not processes.

#### 2.1 Field types

| Type | Stored as | Limits |
| --- | --- | --- |
| Text | UTF-8 | 1–500 bytes; one line unless the field allows line breaks |
| Number | i64 plus the field's fixed decimal places (0–3) | No floats, so replay is exact on every device |
| Date | civil date u32 (YYYYMMDD), like item planning dates | No time of day and no time zone |
| Phone | text | 3–32 bytes of digits, spaces and `+ ( ) - .`; shown as a `tel:` link |
| Member | member ID (16 bytes) | Any current or past member; shown by name |
| Checkbox | u8 0 or 1 | |
| Choice | option ID u8 | 2–12 options per field, each 1–40 bytes |

No other types: no files, links, formulas, computed fields, lookups into
other lists, or times of day.

#### 2.2 The list's shape is an event

- **Kind 84 `CUSTOM_LIST_SAVED`**, saved whole on every change, like
  recipes (kind 59):
  - list ID, name (1–40 bytes), an optional emoji;
  - up to 12 fields, each with a field ID (u8), type, label (1–40 bytes),
    flags (required, line breaks allowed) and a Choice field's options;
  - three optional roles, each naming one field: **title** (a Text field,
    shown first), **Today date** (a Date field) and **done** (a Checkbox);
    plus **responsible** (a Member field);
  - at most 4,096 bytes, so one list fits one sync envelope.
- **Kind 85 `CUSTOM_LIST_ARCHIVED`**: list ID and archived u8 (1 archive,
  0 restore).
- **Changing the shape safely:**
  - a field ID and an option ID are never reused within a list;
  - removing a field hides its values; they stay in the history and come
    back if the field is restored;
  - a field's type can't change; add a new field instead;
  - labels and option names can change at any time.
- **Who may change a list's shape:** household admins, enforced on the
  command path as in 1.1. Anyone who can add To do items can add and edit
  entries.

#### 2.3 Entries are events

- **Kind 86 `CUSTOM_ENTRY_SET`**: entry ID, list ID, then the changed
  fields only (count u8, then per field its ID, type and value). The first
  event for an entry creates it. Setting fields one by one means two people
  editing different fields of the same entry offline both keep their
  change; for the same field, the later event in replay order wins, as for
  every other household edit. At most 2,048 bytes.
- **Kind 87 `CUSTOM_ENTRY_ARCHIVED`**: entry ID and archived u8 (1 archive,
  0 restore, used by Undo).
- Replay keeps values whose field ID and type match the list's current
  shape and ignores the rest for display, without dropping them.

#### 2.4 Where entries appear

- **Lists:** one new segment, "Our lists" (renameable), shows the
  household's custom lists; each opens as a page with its entries. A list
  can be pinned to Today with the existing `PIN_ADDED`.
- **Today:** an entry shows on Today when the list has a Today date, that
  date is today or earlier, and its done box is not ticked. Overdue entries
  say "Since Tue". With no Today date role, the list never appears on
  Today. Week view shows dated entries on their day.
- **Assignment:** the responsible field works like an item's
  responsibility. The entry shows on that person's Today under "Yours" and
  everyone sees who it is. There are no reminders to others, no scoring and
  no "overdue by person" view.
- **Reminders:** a member may set a private reminder on an entry. That adds
  target kind 3 (custom entry) to the private `REMINDER_SET` kind 120, an
  additive value.
- **Search:** Text, Phone and Choice values, the list name and field labels
  are searchable. Results say "Call log · Mrs Patel".
- **Household export:** the events are in the history, so the encrypted
  household export and restore already include them. CSV is in §5.2.

#### 2.5 Size limits

| Limit | Value | Enforced by |
| --- | --- | --- |
| Active custom lists per household | 10 | commands |
| Fields per list | 12 | commands and replay (larger events are invalid) |
| Options per Choice field | 12 | commands and replay |
| Open entries per list | 2,000 | commands |
| Open entries across all lists | 10,000 | commands |
| One list event / one entry event | 4,096 / 2,048 bytes | replay |

Commands are stricter than replay, as for recipes, so a household that
reached a limit on an older device still replays.

#### 2.6 Worked example: the call log

The Small team / shop template offers it; an admin can also make it from
"New list".

| Field | Type | Role |
| --- | --- | --- |
| Caller | Text | title |
| Phone | Phone | |
| Reason | Choice: Order, Quote, Problem, Other | |
| Notes | Text, line breaks allowed | |
| Taken by | Member (filled with the person adding it) | |
| Follow up on | Date | Today date |
| Who's calling back | Member | responsible |
| Called back | Checkbox | done |

Taking a call is one form: Caller, Phone, Reason, and optionally the rest.
The entry costs about 150–400 bytes. If Follow up on is Thursday and Who's
calling back is Dana, it shows on Dana's Today on Thursday until she ticks
Called back. Typing "Patel" in Search finds it. Exporting gives a CSV a
manager can open in a spreadsheet.

#### 2.7 Why this is not a generic workflow system

Custom lists hold records. They don't move work through steps. So Kin will
not add, now or as later "small" additions:

- statuses that move entries between columns, boards or stages (one done
  box, and Choice fields that trigger nothing);
- automations, rules, triggers, formulas, computed fields or links between
  lists;
- per-list permissions, approvals, sign-offs or forms for people outside
  the household;
- due-time timers, escalation, SLAs, reports, charts or per-person counts.

The caps (10 lists, 12 fields) keep it a household tool. A future request
for any item above needs its own ADR and an owner decision against
PRODUCT-BOUNDARIES. The tired-parent test still applies: a call log helps a
tired person remember and hand off; a pipeline doesn't.

### 3. Inventory

#### 3.1 Relationship to the fridge: a separate feature

The fridge is a drawing board. Relabelling it "Inventory" would give a
whiteboard, not counts. So Inventory is **its own feature** (its own
switch, events and page). "Instead of a fridge" is done by the Small team /
shop template: it switches the Fridge off (or renames it Whiteboard) and
switches Inventory on.

Inventory is also not a custom list with a Number field. A custom list keeps
the latest value of a field, so if two people each take one part offline,
one change is lost. Inventory records **changes** (+1, −1) that add up the
same on every device.

#### 3.2 What an inventory item has

- **Kind 88 `STOCK_ITEM_SAVED`**, saved whole:
  - item ID, name (1–80 bytes) and an optional unit ("boxes", 0–16 bytes);
  - **location:** an Area ID or none. Locations reuse Areas (kinds from
    v0.15), which the shop template renames "Locations", so Kin has one
    place concept, not two;
  - **reorder level** (i32, 0 means no alert) and **reorder amount** (i32,
    what a restock usually adds);
  - up to 4 barcodes (1–64 bytes each, digits and printable ASCII);
  - an optional store section (kind 66), used on Shopping.
- **Kind 89 `STOCK_ITEM_ARCHIVED`**: item ID and archived u8.
- **Kind 90 `STOCK_ADJUSTED`**: item ID, a change (i32, not zero, between
  −1,000,000 and 1,000,000), a reason u8 (1 used, 2 received, 3 bought from
  the shopping list, 4 correction) and an optional note (0–120 bytes).
- **Kind 91 `STOCK_COUNTED`**: item ID and a counted amount (i32, 0 or
  more). A stocktake.
- **The count** is worked out by replay: the last `STOCK_COUNTED` in replay
  order, plus every `STOCK_ADJUSTED` after it (0 before any count). Replay
  order is deterministic, so every device agrees. A count below 0 is shown
  as "Count looks wrong. Count it again." rather than refused, because two
  offline devices can each take the last one.
- **Counts are whole numbers.** Fractions are an open question.

#### 3.3 Using it

- **Plus and minus:** large − and + buttons on each item; a long press is
  never needed. "Used 3" and "Got 10" are a number field with − and +.
- **History:** an item's page lists its last 50 changes with who and when,
  from the history. There are no per-person totals and no "who used the
  most": showing who did each change is like "completed by" on an item,
  not monitoring.
- **Running low on Shopping:** an item at or below its reorder level appears
  on Shopping in a **Running low** group, worked out from the count. It is
  not a new event, so two offline devices never add it twice. Ticking it
  off records `STOCK_ADJUSTED` with reason 3 and the reorder amount (changed
  in place if needed). "Add to Shopping as an item" is also offered, using
  the existing "already on Shopping" rule from
  [ADR 0012](0012-meals.md).
- **Inventory lives under Lists** as a segment ("Inventory", renameable to
  "Stock" or "Pantry"). A family can use it for a pantry.

#### 3.4 Barcode scanning with the phone camera

- **The browser's `BarcodeDetector`** where it exists (Chrome and Edge on
  Android, which includes the Google Play app from
  [ADR 0020](0020-google-play-twa.md), and ChromeOS and macOS). Check
  support again when it's built: at the time of writing Firefox and Safari
  don't ship it. Formats: EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39 and
  QR.
- **The camera** follows `<kin-qr-scanner>`'s rules: on only after a tap,
  off on result, Cancel, a hidden page, a route change or lock; rear camera;
  frames never stored or sent; about five detections a second.
- **Fallback, always offered: "Type the code instead"** with a numeric
  keyboard. A USB or Bluetooth barcode scanner acts as a keyboard, so it
  works in this field too, which suits a shop counter.
- **Later fallback (phase 4):** a 1D decoder written from scratch in Rust
  (`rust/src/barcode/`, EAN-13/UPC-A and Code 128), fed by the same frame
  path as the QR decoder, for browsers without `BarcodeDetector`. No
  dependency either way.
- **After a scan:** a known code opens the item with − and +; an unknown
  code offers "New item with this code" or "Add this code to an item".
- **No product lookup.** Kin never sends a barcode to a product database;
  the code stays on the device and in the encrypted history.

#### 3.5 Limits

- 1,000 active inventory items per household (commands).
- History growth: one adjustment is about 40–160 bytes after encryption
  overhead, so 20 changes a day is roughly 1 MB a year. An adjustment is a
  household event like a ticked item, and it syncs the same way.

### 4. Bigger groups (above four Adults): needs an owner decision

A small work team may have more than four grown-ups. Today a household
allows 4 Adults, 8 Limited and 12 members in all, with 16 trusted devices
(`server/identity-limits.mjs`). Raising this conflicts with
PRODUCT-BOUNDARIES ("small-household membership") and AGENTS.md (no teams,
no organization accounts, no new permission tiers).

| Option | What changes | Costs |
| --- | --- | --- |
| **A. Keep the caps.** A work group uses Kin within 4 Adults and 12 members. | Nothing in code or boundaries. Templates rename member kinds only. | Staff beyond four would be Limited members, who have children's defaults (Simple view can be applied, private storage needs admin consent, the chore chart). That is wrong for adults, so in practice the cap is 4 grown-ups. |
| **B. Raise the Adult cap modestly**, for example to 8 Adults, 16 members and 24 devices. | Constants in `identity-limits.mjs` (server only) and their tests; PRODUCT-BOUNDARIES and AGENTS.md say "small groups up to 16"; THREAT-MODEL and IDENTITY updated. | **Key distribution:** each rotation seals the epoch key for every trusted device, so 24 instead of 16 packages (within `MAX_ROTATION_PACKAGES`, 64). **Epoch budget:** a household has 127 rotations for its whole life (`MAX_KEY_EPOCHS`, 128, also checked in the server schema and `web/sync/key-store.js`); a shop with staff turnover uses them faster, and raising that limit is a format change. **History:** more writers make a larger history, which every device replays and keeps decrypted in memory while unlocked. **Chat:** one room for 16 people is busier; no extra rooms. Push fan-out grows a little. |
| **C. Teams or organizations**: many groups, roles, larger caps. | New permission tiers, admin consoles, per-group keys. | Contrary to AGENTS.md and the product. A different product. |
| **D. Several spaces instead** (§5.1): keep each space small; a person belongs to home and to work. | Device storage and the lock screen (§5.1). No change to caps or boundaries. | Doesn't help a single team of more than four Adults. |

**Recommendation: A now, plus D when spaces are built.** Revisit B only
with a real group that has outgrown four Adults. If the owner chooses B, it
should be its own ADR that also decides the epoch budget, and it must not
add a permission tier: every grown-up is still an Adult, with the admin
flag as the only extra right.

### 5. Also in scope, briefly

#### 5.1 Several spaces on one device

- Today a device holds one household: one IndexedDB database named `kin`
  (`web/storage/event-store.js`) with one key database and one lock.
- **Proposed:** each further space gets its own databases (`kin:<household
  ID>` and its key store), its own device identity and its own lock. The
  lock screen gets a space picker, and the household's published
  home-screen name is shown so it's clear which space is open. Unlocking
  one space never unlocks another.
- The first household keeps the frozen `kin` database, so nothing existing
  moves.
- This needs its own ADR (storage, accounts per space, push per space) and
  is the last phase.

#### 5.2 CSV export of a custom list or inventory

- Made on the device from the read exports; the service is not involved.
- Adults only, from the list's menu: "Save as a spreadsheet file (CSV)".
- Before saving: "This file is not encrypted. Anyone who gets it can read
  it."
- **Format:** UTF-8 with a byte-order mark, CRLF line ends, RFC 4180
  quoting, a header row of field labels, then Added, Added by and Archived.
  Dates are YYYY-MM-DD, members are shown by name, checkboxes as Yes or No,
  choices by their option name.
- **Spreadsheet safety:** a cell starting with `=`, `+`, `-`, `@`, a tab or
  a carriage return gets a leading `'`, so a spreadsheet can't run it as a
  formula.
- Inventory exports name, location, count, unit, reorder level and barcodes.

#### 5.3 A daily summary

- **Per member, opt-in.** A synced setting in the private log (kind 130,
  new key `daily-summary`, value off or a time such as `0730`).
- It is a card at the top of Today the first time Kin is opened after that
  time: today's events, things due, what's yours (items, routine turns,
  custom entries), handoffs since yesterday and how many things are running
  low. It is built on the device from the existing reads.
- **No scheduled push or email.** The service can't read content, and
  [PUSH](../PUSH.md) collects no time zone. A content-free scheduled push
  would need new server state; it is an open question, not part of this
  decision.

### 6. Event kinds proposed

All additive, household log, schema 1, replay protocol unchanged. Numbers
are proposals: if ADR 0023 (add-ons) or other work ships first and takes
some of 83–99, these move up in the same order.

| Kind | Name | Section |
| --- | --- | --- |
| 83 | `HOUSEHOLD_WORDS_SET` | 1.1 |
| 84 | `CUSTOM_LIST_SAVED` | 2.2 |
| 85 | `CUSTOM_LIST_ARCHIVED` | 2.2 |
| 86 | `CUSTOM_ENTRY_SET` | 2.3 |
| 87 | `CUSTOM_ENTRY_ARCHIVED` | 2.3 |
| 88 | `STOCK_ITEM_SAVED` | 3.2 |
| 89 | `STOCK_ITEM_ARCHIVED` | 3.2 |
| 90 | `STOCK_ADJUSTED` | 3.2 |
| 91 | `STOCK_COUNTED` | 3.2 |

That leaves 92–99 free. Private additions: target kind 3 in
`REMINDER_SET` (120) and setting key `daily-summary` in `SETTING_SET` (130).
KCMD actions 83–91 follow the existing pattern.

### 7. Read exports

New WASM exports, each a versioned binary query and result like the others
in [ABI](../ABI.md); the four-letter tags are placeholders:

- `kin_household_words` → the current set (template, key, word);
- `kin_custom_lists` → active and archived lists with their shapes;
- `kin_custom_entries` → entries of one list, filtered by open, done or
  all, responsible member, and a date range, with an offset and a limit
  (at most 200 per page);
- `kin_custom_due` → entries for Today and Week view between two civil
  dates;
- `kin_inventory` → items with their current count, location and
  running-low flag;
- `kin_stock_history` → an item's last changes (at most 50 per page).

Search and the CSV export read through these. None of them is part of the
KINS projection snapshot.

### 8. Feature-switch bits

- **Bit 19: Custom lists. Bit 20: Inventory.** Bit 18 is Add-ons in
  ADR 0023. As with event kinds, they move up if other work takes these
  bits first.
- Your own words and templates are not a switch: they are part of
  Household › Features for admins.
- **Off by default.** Most families don't need these, and an empty page in
  every household's Lists would be clutter. Today a new bit means on, so:
  - the service's migration sets bits 19 and 20 in `features_off` for every
    household, and new households start with them set;
  - `/api/sync/status` gains `features.known`, the mask of bits this service
    knows. A device treats bits 19 and later that the service doesn't know
    as off. So an older server never makes these features appear by
    accident.

### 9. Server changes

- One additive schema step (the next free one: 30, or 31 if ADR 0023 ships first) with a
  forward migration: no new columns, only the `features_off` update above.
- `HOUSEHOLD_FEATURE_BITS` gains bits 19 and 20, and the status response
  gains `features.known`.
- Nothing else. Words, lists, entries and inventory are ordinary encrypted
  envelopes. Option B in section 4 would change `identity-limits.mjs`.

### 10. Compatibility

- New kinds 83–91 get V1.0-COMPATIBILITY rows and test vectors. As for every
  earlier additive kind, a device from before this addition that receives
  one pauses household sync with "unsupported" ("update Kin") and keeps its
  data.
- Consequence: the first time an admin applies a template or saves custom
  words, every device in the household has to update before it syncs again.
  The template preview says so.
- The household export and KARC package formats don't change; they already
  carry every event.
- An older server refuses a database with the new schema (fails closed), as
  for every schema step.
- Each phase ships as a v2.x minor release.

### 11. PRIVACY and THREAT-MODEL effects

**PRIVACY:**
- Words, lists, entries, inventory and barcodes are end-to-end encrypted
  like everything else in the history.
- The service learns that a household switched Custom lists or Inventory on
  (feature bits are plaintext). Which template was used stays inside the
  encrypted kind 83.
- Inventory adjustments are frequent small events, so the service sees more
  timing metadata.
- Camera frames never leave the device, and no barcode goes to a lookup
  service.
- A CSV file is plaintext outside Kin.
- A custom list can hold personal data about people outside the household
  (a caller's name and phone number). PRIVACY should say that the group
  using Kin is responsible for that data, and that deleting the household
  or archiving entries follows [RETENTION](../RETENTION.md) (archived
  entries stay in the history).

**THREAT-MODEL:**
- Renaming words, changing a list's shape and applying a template are
  admin-only on the app's command path, not in replay; the worst case from
  a modified client is cosmetic and visible.
- Never-renamed words keep safety pages and prompts recognisable.
- Inventory counts can be changed by any member's device: they are a
  convenience, not an audit ledger.
- The CSV export guards against formula injection.

### 12. Phased plan

| Phase | What | Depends on |
| --- | --- | --- |
| 0 | Owner decisions: section 4 and the open questions below | — |
| 1 | Your own words and templates: kind 83, `web/words.js`, `web/templates.js`, Help and search aliases, the Features page editor | — |
| 2 | Custom lists: kinds 84–87, bit 19 with `features.known` and the server schema step, Today, assignment, search, reminders target 3, CSV export | 1 (for template suggestions) |
| 3 | Inventory: kinds 88–91, bit 20, Running low on Shopping, `BarcodeDetector` scanning and typed fallback, CSV | 2 (shares the server step) |
| 4 | Native 1D barcode decoder in Rust for browsers without `BarcodeDetector` | 3 |
| 5 | Daily summary card | — |
| 6 | Several spaces on one device (its own ADR) | — |
| — | Bigger groups, only if the owner chooses B (its own ADR) | 0 |

Each phase updates EVENTS, ABI, V1.0-COMPATIBILITY, TEST-VECTORS, UX,
PRIVACY and THREAT-MODEL in the stories that build it.

## Consequences

- Nine new household kinds (83–91), two private additions, six read exports,
  two feature bits and one small server schema step, all additive.
- Labels move from scattered constants to one table of keys and default
  words, which also helps Help and search.
- PRODUCT-BOUNDARIES gains a line under Avoid: "custom lists hold records;
  no statuses, automations, formulas or per-list permissions (ADR 0024
  §2.7)". Its membership line changes only if the owner chooses B.
- Every device must update once the first template or custom word is saved.
- Kin can serve a small shop or a shared flat without becoming a team
  product.

## Alternatives considered

- **Renamed words as a service setting, like feature switches.** The service
  could enforce admin-only changes, but it would read words that describe
  the group, and households without sync would need a separate path.
  Rejected; the cosmetic risk of a forged rename is smaller than the privacy
  cost.
- **Renamed words per device.** No sync and no events, but members of one
  group would see different names for the same page. Rejected.
- **Rename everything, including security words.** Simplest rule, but a
  page renamed "Privacy & recovery" could mislead someone into a harmful
  action, and Help could no longer explain safety prompts. Rejected.
- **Templates as permanent modes** with code paths per mode. Three products
  to test instead of one. Rejected: a template is a preset applied once.
- **Inventory as a relabelled fridge.** The fridge stores drawings, not
  counts. Rejected.
- **Inventory as a custom list with a Number field.** Loses concurrent
  offline changes (latest value wins). Rejected for change events.
- **Extending Staples with counts.** Staples are shopping items with text
  only; locations, barcodes and reorder levels would overload them. Instead,
  inventory meets Shopping through the Running low group.
- **A barcode library or a product database.** Against the zero-dependency
  rule and PRIVACY. Rejected.
- **Custom lists saved whole on every entry edit.** Simpler events, but two
  offline edits to different fields of one entry would lose one. Rejected
  for per-field sets.
- **Low stock written to Shopping as an event automatically.** Two offline
  devices would both add it. Rejected for a derived group.
- **A rules engine or kanban board for custom lists.** That is the generic
  workflow system PRODUCT-BOUNDARIES avoids. Rejected.

## Open questions for the owner

1. **Bigger groups:** keep the caps (A, recommended), raise Adults to about
   8 (B), or wait for several spaces (D)? If B, what is the largest group
   Kin should serve?
2. **Off by default:** should Custom lists and Inventory start switched off
   for every household (proposed), or on like the Calendar was?
3. **Who changes a list's shape:** household admins only (proposed), or any
   Adult?
4. **Limited members as staff:** in a work template, is it acceptable that
   people beyond four Adults would be Limited members with children's
   defaults, or should the Small team template not offer that at all?
5. **Inventory amounts:** whole numbers only (proposed), or decimals for
   things like metres of cable or litres?
6. **One location per inventory item** (proposed), or counts per location
   (two shelves, a van)?
7. **Daily summary:** an in-app card only (proposed), or also a scheduled,
   content-free notification, which needs a time stored on the service?
8. **CSV export:** Adults only (proposed), or every member who can see the
   list?
9. **Several spaces:** is home plus work on one phone wanted soon enough to
   come before bigger groups?
