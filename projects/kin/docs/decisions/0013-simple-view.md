# ADR 0013 — Simple view: a calmer layout for a Limited member

Status: Accepted (#342, for the Simple view epic #341)

## Context

The owner wants a child or teen (a Limited member) to see a calm Kin: big
tap targets, pictures, only their own things for today, and Chat. Nothing is
counted: no streaks, points, rewards or scores. An Adult household admin
turns it on per Limited member; the child can't switch it off.

The design review (#341) raised problems to settle before any interface:

- Household events are end-to-end encrypted. The sync service checks only
  household, device, key epoch and sequence on push
  (`server/sync-service.mjs`); it cannot tell a child's "done" from an "add".
  THREAT-MODEL already says so for attachments.
- `householdStatus` comes from the network and is cleared on lock, so a child
  unlocking offline would get the full app if the flag lived only there.
- A hash URL reaches every page (`web/routes.js` `resolveRoute`), as do
  Search, the command palette, keyboard shortcuts, Quick add, `/pair` and
  search results.
- The chat policy is per member class; a per-member flag is new server
  state.
- A device belongs to one member, so a family tablet registered to an Adult
  shows the Adult's Kin.
- Routines have no steps (`RoutineState`); only items have steps, and steps
  can't be assigned.
- No per-item picture exists.

## Decision

### What it is: a layout, not a lock

Simple view is **a calmer layout an admin chooses**, not a permission tier.

- **The service enforces exactly two things:** who may change the flag (a
  household admin, with a fresh passkey, for a Limited member), and Chat
  access (the existing chat policy, #123), plus Fridge access (#323) as
  today.
- **Everything else is only hidden by the app.** A child's device still
  holds the household's key and could, with other software, write any
  household event; the service would accept it, because it can't read
  events. Docs and copy say so plainly: the admin switch says "A simpler
  layout for this person. It isn't a lock: Kin hides the rest, it can't
  prevent it."
- HOUSEHOLD-IDENTITY-DEFAULTS is amended: Kin still adds no child permission
  tier; Simple view is a per-member layout choice.

### The flag

- **Server:** a new `members.simple_view` column (0 or 1, default 0) in
  server schema 20, a durable migration with tests. Only Limited members can
  have it: the service refuses it for Adults and Temporary members and
  reports it only for a Limited member.
- **Changing it:** `POST /api/household/simple-view/options` then `/finish`,
  the household-admin passkey flow (`set-simple-view`), like changing a
  household admin. Non-admins and legacy households with no admin are
  refused.
- **Who sees it:** `GET /api/sync/status` gains `simpleView: true|false` for
  the session's own member; the household view lists `simpleView` per member
  for an admin's People & devices.
- **Offline:** the device caches its own last flag in the root-protected sync
  key store (`kin-crypto-keys`, a new `member_view` store keyed by household,
  database version 6). Unlock reads the cache before building the workspace,
  so an offline unlock opens the same view as last time. A change applies on
  the next status poll; turning it off on a child's device that never comes
  online again leaves Simple view on there. If the cache can't be read at
  unlock, Kin opens the full layout (it fails open: it is a layout, not a
  lock); the next poll applies the switch again.
- **Chat and the Fridge** are offered once their rooms are open on the
  device and access isn't "none"; offline before sync, Today stands alone.
- **Shared devices:** a device belongs to one member. A family tablet
  registered to an Adult shows the Adult's Kin. A child needs their own
  device (their own passkey and pairing); the docs say so.

### What Simple view shows

- **Routes:** `resolveRoute` gains an allowlist mode. Only Today,
  Updates → Chat (when the child's chat access isn't "none") and Household →
  Fridge (when board access isn't "none") resolve; every other hash, alias,
  `/pair` and search link goes to Today.
- **Not mounted:** in Simple view only its three pages are shown; the rest
  of the workspace is taken out of the document before anything shows, so
  no link, alias or focus path reaches it. The household panel alone stays,
  hidden, so a device whose member was removed still notices and locks.
  Turning a chat message into a record is off as well. The command palette, keyboard shortcuts, Quick add,
  Search, the compose bar, bulk selection and the detail panel and sheet
  are off. Kept: the household brand, sync status and Lock. Turning Simple
  view off reloads Kin into the full layout.
- **My things today** (Rust, one projection per member): active items
  assigned to the member (responsibility kind 41, target Item) whose planning
  date is today or earlier, or that have no planning date; plus routines
  assigned to the member (target Routine) with an open occurrence today.
  Completed and archived items, and anything once assigned to an expired or
  removed member, aren't listed. Item steps aren't shown.
- **Tonight's dinner** (Meals, ADR 0012) and the **Fridge** (ADR 0011), each
  as one card or destination.
- **Actions:** mark own things done, and Undo in the same place for the
  session; Chat per its policy. No adding, editing, assigning or settings.
- **Never:** celebrations, counts, streaks, totals, rankings.

### Pictures

- **Item emoji:** a new additive event kind, **`ITEM_EMOJI_SET` (kind 64)**:
  `item_id`, `emoji?` (absent clears). The emoji is one grapheme validated by
  the chat reaction rule (`chat::check_emoji`). Only an existing, unarchived
  item can take one; replay is tolerant like Meals. Older devices pause sync
  with "unsupported" and keep their data until they update. A
  V1.0-COMPATIBILITY row records it; TEST-VECTORS gains its vectors.
- **Picture rule:** the item's emoji if set; else its first image
  attachment, by attach order, that is still attached and downloaded on this
  device; else none. A photo not downloaded yet shows the emoji or nothing,
  never a broken image. Rust supplies the emoji and attachment order; the
  browser picks the first image it holds.
- Adults set or clear the emoji with `kin-emoji-picker` (Adult view only);
  it shows small beside the text there and large in Simple view, and never
  replaces the text.

## Consequences

- Server schema 20 and key store version 6 are additive. Event kind 64 is
  additive; v1.0 formats are unchanged.
- The admin's switch, the docs and THREAT-MODEL say what is enforced and
  what is hidden; nothing claims more.
- Picker labels use members' preferred names (v1.3.0), never "Household
  adult N" for a child.

## Alternatives considered

- **Server-enforced child actions.** Impossible without the service reading
  events, which end-to-end encryption rules out.
- **A device-wide "kid mode" on a shared tablet.** Rejected: whoever
  unlocks the device is the member; a mode on an Adult's device would be a
  costume over full access.
- **A per-class flag like the chat policy.** Rejected: families want it for
  a younger child, not their teen.
- **Steps on routines.** Out of scope; routines have no steps.
