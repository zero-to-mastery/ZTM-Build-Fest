# Kin UX

> **Status:** Draft for `v0.14.x` UX/UI consolidation  
> **Directional horizon:** `v0.45.x` Build Fest release candidate  
> **Audience:** anyone designing, building, reviewing, or testing Kin's interface  
> **Related docs:** `ROADMAP.md` · `ARCHITECTURE.md` · `ACCESSIBILITY.md` · `PRIVACY.md` · `TESTING.md` · current version planning contracts

This document defines how Kin should **feel, behave, communicate state, and grow**.

It is both:

1. the UX contract for the product that exists now; and
2. a directional design system that allows Kin to grow toward the planned `0.45.x` feature set without repeatedly redesigning the app shell.

The visual direction is warm, calm, compact, household-oriented, and deliberately unlike workplace project-management software.

The product should feel like something that belongs in a kitchen, hallway, couch, grocery aisle, or tired parent's hand—not a sprint board.

---

# 0. How to read this document

UX decisions have one of four statuses.

| Status | Meaning |
|---|---|
| **Current** | Reflects an existing product capability or established behavioral contract. |
| **Adopted** | A design decision for `0.14.x` and later. New UI should follow it. |
| **Directional** | Intended destination for later `0.x` releases, especially toward `0.45.x`. Do not implement merely because it appears here. |
| **Open** | A meaningful decision still requires evaluation. |

A visual prototype may show **Directional** functionality that has not shipped.

Never treat prototype data, controls, navigation destinations, or copy as evidence that a capability exists.

Version planning contracts and implementation remain authoritative for shipped capabilities.

---

# 1. Product purpose

Kin helps a household **remember, coordinate, hand off, and recover context without requiring everyone to become a project manager**.

The primary product experience is not "task management."

It is:

> **What matters now, what changed, and what do we need from each other?**

Kin should reduce household mental load.

It should not create a new administrative burden.

## 1.1 Product characteristics

### Current

Kin's architecture now includes concepts such as:

- household membership;
- passkey-backed identity;
- trusted devices;
- pairing;
- encrypted synchronization;
- offline/local state;
- backup and restore;
- deletion lifecycle;
- recovery and household continuity.

The interface must represent these honestly without forcing users to understand their implementation.

### Adopted

Kin should remain:

- local-first;
- private by design;
- usable offline where practical;
- accessible;
- calm;
- understandable without technical knowledge;
- useful for simple household coordination before advanced organization is configured.

### Directional

The same shell should eventually accommodate:

- areas;
- household notes;
- richer routines;
- shopping and replenishment;
- planning dates;
- household modes;
- useful history;
- search;
- playbooks;
- reminders;
- reference records;
- maintenance;
- encrypted attachments;
- explicit responsibility;
- broader household membership;
- backup/restore and migration.

Those additions must not turn the primary interface into a dashboard of modules.

---

# 2. Who we design for

Kin users may behave very differently even inside the same household.

| Archetype | Wants | Quits when |
|---|---|---|
| **The doer** | "What needs doing right now?" | Setup and organization become homework. |
| **The planner** | Confidence that important things are captured | Others stop using the system. |
| **The quick capturer** | Somewhere to put a thought immediately | Capture requires categorization. |
| **The returning partner** | "What changed while I was gone?" | Changes are hidden in activity logs. |
| **The tired household member** | One obvious next action | Screens require reading and decision-making. |
| **The cautious user** | Confidence about privacy, devices, recovery, and deletion | Security behavior feels magical or vague. |

## Adopted principle

> **Design for the doer; serve the planner.**

If the least enthusiastic household member cannot use Kin in seconds, Kin becomes another responsibility assigned to the planner.

---

# 3. Core UX principles

## 3.1 The ten-second loop — Adopted

The core habit is:

```text
open
  ↓
see what matters / what changed
  ↓
add, claim, acknowledge, or complete one thing
  ↓
leave
```

The ordinary daily interaction should take roughly ten seconds and work one-handed.

Adding something should normally require:

- one field;
- one submit action.

Organization happens afterward.

---

## 3.2 Calm, never nagging — Adopted

No:

- streaks;
- guilt;
- "you're behind";
- red notification-count pressure;
- achievement systems;
- productivity scores;
- artificial urgency.

Unfinished household work is normal.

Use:

> "3 things still open."

Not:

> "You have 3 overdue tasks!"

---

## 3.3 Never a scoreboard — Adopted

Kin must not provide ammunition for household resentment.

Do not introduce:

- leaderboards;
- contribution percentages;
- per-person grades;
- completion rankings;
- "Sam did 72% of chores";
- productivity comparisons.

Attribution may be useful:

> "Sam finished Take bins out."

Evaluation is not:

> "Sam completed more this week."

If load is shown, it must be factual, calm, optional, and framed as household context rather than performance.

---

## 3.4 Honest about state — Adopted

At any moment, the user should be able to answer:

- Is this saved?
- Is it only on this device?
- Has it synced?
- Am I offline?
- Is this device still trusted?
- Did something change?
- Do I need to take action?

Security and sync state should use human meaning rather than architecture vocabulary.

Prefer:

> Up to date

> Waiting to sync

> Offline — changes are safe here

> This device is no longer trusted

> Recovery needed

Avoid exposing:

> epoch mismatch

> cursor failure

> provisioning grant expired

unless shown in diagnostic/admin details.

---

## 3.5 Never silently lose household context — Adopted

Errors should follow:

> **what happened → what is safe → what to do next**

Example:

> Couldn't save to this browser. What you typed is still here. Try again.

Destructive actions must either:

- be reversible;
- have an explicit recovery window;
- or clearly explain that they are irreversible.

---

## 3.6 Private by design, visibly — Adopted

Privacy cannot exist only in documentation.

Kin should periodically and appropriately communicate:

- household content is encrypted where that guarantee actually applies;
- trusted devices share household data;
- the service may coordinate sync without understanding household content;
- some metadata may still exist;
- recovery has limits.

Never claim:

> "The service knows nothing."

unless that is literally true.

Prefer specific claims.

---

## 3.7 Familiar over clever — Adopted

Prefer:

- lists;
- check controls;
- plain buttons;
- bottom navigation;
- forms;
- cards;
- familiar disclosure patterns.

Avoid gesture-only interfaces and experimental navigation.

Kin's novelty should come from **how little effort household coordination requires**, not unusual controls.

---

## 3.8 Optional complexity stays out of the daily loop — Adopted

Advanced features should live behind context, search, or `More`.

The Today screen should not gradually accumulate:

```text
tasks
shopping
maintenance
notes
devices
backup
recovery
history
settings
attachments
members
```

all at once.

Advanced capability belongs in the product without dominating the product.

---

# 4. Visual direction

The supplied concept prototype establishes the visual direction.

## Adopted visual character

Kin should feel:

- warm;
- domestic;
- quiet;
- tactile;
- readable;
- spacious enough to breathe;
- compact enough for one-handed use.

The design should avoid the visual vocabulary of business software.

## 4.1 Palette

Use semantic tokens rather than named colors.

Suggested roles:

```css
--bg
--surface
--surface-secondary
--ink
--ink-muted
--line
--accent
--accent-ink
--accent-soft
--warm
--warm-soft
--danger
--danger-soft
```

### Accent

A muted green/teal family fits Kin well:

- trustworthy;
- calm;
- domestic;
- distinct without feeling corporate.

### Warm attention

Warm terracotta/orange may signal:

- catch-up information;
- gentle attention;
- temporary household state.

It must not automatically mean error.

### Danger

Reserve danger styling for actual destructive consequences:

- delete household;
- revoke trusted device;
- remove member;
- irreversible action.

---

## 4.2 Surfaces

Prefer:

- warm neutral page background;
- white/off-white cards in light mode;
- quiet charcoal/brown surfaces in dark mode;
- thin borders;
- little or no dramatic shadow.

Avoid:

- excessive glass effects;
- floating dashboards;
- gradients everywhere;
- neon status colors.

---

## 4.3 Shape

Suggested system:

```text
controls        10–12px radius
list rows       12–14px
cards           14–20px
status pills    fully rounded
```

Rounded shapes should feel approachable but not toy-like.

---

## 4.4 Typography

Use the system font stack.

Prioritize:

- fast loading;
- OS familiarity;
- accessibility;
- zero font dependency.

Suggested scale:

```text
12  metadata
14  supporting copy
16  body / controls
18–20 section heading
26–30 page heading
```

Use weight sparingly.

Hierarchy should come from spacing and size before boldness.

---

# 5. Information architecture

The existing concept correctly limits primary navigation to five destinations.

That constraint remains.

However, Kin's roadmap grows substantially before `0.45.x`, so five permanent feature-specific tabs such as:

```text
Today
Needs
Handoff
Talk
Pulse
```

will not scale indefinitely.

## 5.1 Target navigation model — Adopted (household workspace candidate)

The primary navigation is now:

```text
Today
Lists      (To do · Shopping · Staples)
Routines   (Routines · Reusable checklists)
Updates    (Handoffs · Talk)
Household  (Overview · Notes & reference · Areas & status · People & devices · Privacy & recovery)
```

"Updates" is the presentation label for the former Handoff destination and
"Household" for the former More page; `#handoff`, `#more`, `#lists` and
`#search` keep working as aliases (see [WORKSPACE-UX](WORKSPACE-UX.md) §2).
The original directional wording follows for history:

```text
Today
Lists
Routines
Handoff
More
```

This preserves five stable destinations while giving future product capability somewhere coherent to live.

### Today

The daily loop.

Contains:

- catch-up;
- today's work;
- immediate next items;
- quick capture;
- important near-term context.

### Lists

Things the household needs.

Contains or links to:

- Needs;
- shopping;
- staples/replenishment;
- unassigned household items.

### Routines

Recurring household work.

Contains:

- recurring tasks;
- paused routines;
- household-mode effects;
- schedule context.

### Handoff

Intentional interpersonal context.

Contains two modes:

```text
Handoffs
Talk
```

This preserves the distinction between:

- a message that requires acknowledgment;
- ordinary household conversation.

Talk does not require its own permanent navigation slot.

### More

Everything useful that should not compete with the ten-second loop.

Examples over time:

- Areas;
- Notes;
- History;
- Search;
- Reference records;
- Maintenance;
- People & devices;
- Backup & restore;
- Export;
- Recovery;
- Settings.

"More" is not a junk drawer.

It is the home for infrequent capabilities.

### Household features — Adopted (#623, ADR 0021)

A household that never uses the fridge or meals shouldn't have to look past
them. **Household › Features** lists the parts of Kin that can be switched
off, each with one plain sentence: Chat, Fridge, Meals, Routines, Taking
turns, This week, Talk later, Store sections, Shopping mode, Maintenance,
Notes & reference, Sitter page, Journal, Just for me and Family photos
(#673). Today, Lists (To do and Shopping), Updates (handoffs) and Household
are always on, and the page says so.

- **Who:** a household admin turns switches on or off and taps **Save
  features**; Kin then asks them to confirm it's them (their passkey, or
  their password if they have no passkey yet). Everyone else sees the same
  list read-only, each feature marked On or Off, with "Ask a household admin
  if you'd like something turned on or off." A household that doesn't sync
  (one person) saves on the device without a prompt.
- **Off means hidden, never deleted.** A switched-off feature leaves the
  navigation (Routines leaves the bottom bar), its page's segment links and
  the Household overview, Today (tonight's dinner, routines, the fridge
  link, private items), This week's rows, Search results, Quick add's
  repeat choice, the share sheet, chat message actions (Talk later, Save as
  a note) and the command palette; Help (#620) asks the same hook. Everything stays in the household's
  history and is back the moment it's switched on.
- **Links and shortcuts** into a switched-off feature (a bookmark, a
  home-screen shortcut, an old link) open Today with one calm line: "This
  week is turned off in your household, so Kin opened Today."
- **Members are told once.** When something a member's device was showing
  disappears, Today shows "Your household turned off Meals. Nothing was
  deleted; a household admin can turn it back on under Household ›
  Features." with an OK button. It doesn't come back until something else
  is switched off. The admin who made the change sees "Features saved."
  instead.
- **Simple view** keeps its own short list (Today, Chat, the Fridge); Chat
  and the Fridge leave it too when switched off.
- **Easy mode and Help** (#616, #620) ask the same question of every
  destination (`ctx.features.routeAvailable(route)`, web/features.js), so a
  new surface hides switched-off features without knowing which they are.

---

## 5.2 `0.14.x` transition

`0.14.x` does **not** need to implement every target destination.

The goal is to shape the app shell so future destinations can arrive without another complete redesign.

Preserve existing user paths during transition where practical.

---

# 6. Vocabulary

## Item — Adopted

Anything the household may need to:

- do;
- buy;
- decide;
- remember.

Capture should not require deciding which subtype it is.

---

## Today — Adopted

A view over household work that matters now.

It is not a separate data model.

---

## Need — Adopted as a view/property

Something the household requires that may not yet have:

- a date;
- an owner.

Needs belong under the broader Lists concept over time.

---

## Handoff — Adopted

Context deliberately passed to another household member with optional explicit acknowledgment.

Example:

> Pickup is 3:10 Thursday. Spare key is in the blue bowl.

Acknowledgment is a deliberate interaction.

It is not passive read tracking.

---

## Talk — Adopted

Lightweight household conversation.

It remains separate from task state and handoff acknowledgment.

Directional placement: inside Handoff rather than as a permanent top-level destination.

---

## Routine — Directional/current according to release state

Recurring household responsibility.

Routines should support real life rather than productivity culture.

Skipping a routine is not failure.

---

## Area — Directional

A lightweight context such as:

```text
Home
Family
Pets
Errands
Car
Garden
```

Areas are not projects.

No nested hierarchy is required.

---

## Note — Directional

Short household reference context.

A note is not:

- chat;
- a task;
- a document editor.

---

## Household mode — Directional

Temporary context that modifies visibility or recurrence.

Examples:

- Vacation;
- Guests;
- Illness/rest.

Modes should not become an automation engine.

---

# 7. Core flows

## 7.1 Today

### Trigger

Open Kin.

### Path

```text
open
↓
optional Catch up
↓
Today
↓
complete/add/claim
↓
leave
```

### Rules

- primary content appears before administrative state;
- completed work remains visually understandable;
- quick add is immediately available;
- current owner and useful timing are visible but secondary;
- no scoring.

---

## 7.2 Catch up

Rename the conceptual experience from the longer:

> Since you last looked

to a shorter visible heading such as:

> Catch up

The accessible or supporting copy may still explain:

> Since you last looked

Show only meaningful changes.

Examples:

- Sam completed something;
- Sam left a handoff;
- a household setting materially changed;
- backup/recovery requires attention.

Do not show:

- app opens;
- page views;
- passive presence;
- every trivial edit.

Catch-up must not become surveillance.

---

## 7.3 Quick capture

Default:

```text
[text field] [Add]
```

Only text is required.

Capture is context-sensitive (Adopted, v0.41.0, revised by the household
workspace candidate): the Today capture asks *what* the item is (Task or
Shopping item), *when* it matters (Today by default, Tomorrow, a date, or no
date) and whether to pin it; it creates an ordinary `need` or `shopping`
record and sets the planning date explicitly, never a new classification.
To do, Shopping, and Staples each carry a single-field capture fixed to that
list, so adding eggs from Shopping creates a Shopping item. The confirmation
names the destination and an inline result says "Saved on this device." or
"Saved here. Waiting to sync."; a failure says "Couldn't save. Your text is
still here." with Try again beside the field.

Later editing may add:

- date;
- owner;
- area;
- kind;
- checklist;
- recurrence.

Capture comes before organization.

---

## 7.4 Claim

Claiming should be:

- one action;
- reversible;
- visibly attributed.

Do not silently assign things to another person.

---

## 7.5 Handoff

Flow:

```text
write context
↓
send
↓
recipient sees it
↓
recipient optionally presses Got it
↓
sender sees Acknowledged
```

"Got it" is the deliberate read-receipt exception.

No passive read receipt exists.

---

## 7.6 Talk

Talk is intentionally lightweight.

It should not evolve into:

- Slack;
- threaded chat;
- presence indicators;
- typing indicators;
- read receipts;
- reactions ecosystem.

Its purpose is simply to keep quick household conversation near household context when useful.

Household chat is separate and sits beside Talk under Updates → Chat ([ADR 0008](decisions/0008-household-chat.md)); this list still holds for Talk.

---

# 8. Security, sync, and continuity UX

Kin now has enough security architecture that this requires its own UX contract.

## 8.1 Passkeys

Explain passkeys through action, not architecture.

Prefer:

> Use your passkey to continue.

Not:

> Perform WebAuthn assertion.

### Passkey-first unlock — Adopted (v0.41.0)

Once a device holds a passkey that can unlock Kin, the lock screen reads
"Welcome back" with `Unlock with passkey` as the only primary action and
`Use backup key` as a secondary control that reveals the backup-key form. The
backup key is a backup, never the everyday login. Offline, the passkey still
unlocks (#551, below): the screen says "You're offline. Your passkey still
unlocks Kin on this device; Kin signs you in again once you're connected." and
keeps the backup key one tap away as usual. First run is a welcome, a "Save your backup key for this device"
step, then create/join choices; passkey unlock is offered as soon as the
device holds a household credential (§8.1, "Calmer unlock"). Security settings
state whether passkey unlock is on.

### A gentle first run: your name and a password — Adopted (#557, #559)

The owner's principle for accounts ([ADR 0018](decisions/0018-account-key-vault.md)):
don't overwhelm people at the start. A new device opens on **at most three
screens before Today**, with no keys and no security choices:

1. **Welcome to Kin.** `Start a new household` (primary), `I have an
   invitation`, or `Sign in` ("You already use Kin, on another device or one
   you lost"; below). Nothing to type. A quiet `Set up with a passkey instead`
   leads to the earlier setup (backup key, then passkey create or join),
   which is also where adding a device you already use and signing in with
   your phone live.
2. **Start your household** — `Your name` (`autocomplete="name"`) and an
   optional `Household name`; or **Join your household** — `Your name` and
   the `Invitation code`. An invitation link opens straight on this screen
   with the code filled in, so a joiner sees two screens. A wrong or used
   code is said here, before a password is chosen. "Step 1 of 2".
3. **Choose how you'll sign in** — `Username` (`autocomplete="username"`) and
   `Password` (`autocomplete="new-password"`), so password managers save a
   new account. Plain guidance: "Use at least 10 characters. A few unrelated
   words works well." One short line states the trade-off: "Kin can't reset
   this password. Until you add a passkey or another device, a forgotten
   password means this household can't be opened." `Create household` or
   `Join household`. "Step 2 of 2".

Each screen checks its answers when sent and says what to fix beside the
field (`aria-invalid`, `aria-describedby`); nothing typed is lost, the
password included, and the first field with a problem takes focus. A taken
username is checked before anything is created. Then Kin derives the
password's keys (a second or so on a phone, "Setting up your household on
this device…"), makes this device's encrypted storage and opens **Today**
right away. Meanwhile Today's card reads "Setting up your household…"; the
household is created with the service, sync turns on, and the names typed on
screen 2 are recorded once sync is ready (the member's name as Set my name
does, the household's name as an admin's shared setting). If that fails
(offline, a username taken meanwhile, a code that ended), the card says so
in one line with what to change and `Try again`; Kin stays usable on this
device meanwhile. A joiner lands on People & devices, waiting for approval
exactly as before (compare the device keys), and after approval finishes
with `Finish joining`, without typing the password again unless the page was
reloaded meanwhile, then lands on Today.

### Sign in on a new device — Adopted (#568, #569)

For a member on a new phone or a wiped browser, from `Sign in` on the
welcome screen; two screens, then Today, with no other device needed:

1. **Sign in to your household** — `Username` (`autocomplete="username"`)
   and `Password` (`autocomplete="current-password"`), so a password manager
   offers the saved login. `Sign in` and `Back`; below, a quiet `Sign in with
   a passkey` for members who added one. A wrong username or password says
   "That username and password didn't match. Check them and try again." in
   the alert line and keeps the form. A member whose account signs in with a
   passkey is told so; a member who requires both sees **Confirm with your
   passkey** next (`Use my passkey`).
2. **Which device is this?** "Signed in as <username>." A radio group (a
   fieldset with the question as its legend): **Add this as a new device**
   (chosen), then one **This replaces <device name>** per trusted device of
   theirs, with the date it was added; one carried over by a move adds
   "· From the old address", as People & devices does, and can still be
   chosen (#780). Choosing a replacement shows, and ties
   to that choice with `aria-describedby`, the warning "The device you choose
   is signed out for good: it can't open your household again, even if it
   turns up. Choose this only for a device that's lost, broken or wiped."
   `Continue` / `Cancel`. At the household's device limit, adding says to
   choose a device to replace instead.

Then this device's storage is made with the same password (it unlocks this
device every day, offline, as after the first run) and Today opens; the card
reads "Setting up this device…" while the device registers and installs the
household's keys, and the household's items arrive with the first sync. A
failure says so on the card with `Try again`. After a passkey-only sign-in,
a backup key for this device is shown once (with "I've saved this key
somewhere safe") before Today, since there is no password to protect it with.

**Daily unlock.** The lock screen of a device set up this way reads "Unlock
Kin", "Enter your password to open your household on this device.", with
the username shown and offered to password managers (an off-screen
`autocomplete="username"` field) and one `Password` field
(`autocomplete="current-password"`) with `Unlock`. It works offline, and
signs the device in when online. A wrong password says "That password didn't
work. Check it and try again." and keeps the form, focused on the field. A
passkey, once added, is offered beside it. `Forgot your password?` explains
plainly that Kin can't reset it and what still works.

**Confirming important actions.** Where a passkey member confirms with their
passkey (approving a device or a member, admin changes, removing someone,
deleting the household), a member who has no passkey yet sees a small dialog,
"Confirm it's you" — "Enter your Kin password to continue." `Confirm` /
`Cancel` (Cancel reads as "cancelled", nothing changes). Messages say
"Confirm … with your password" for them.

**Later, calmly.** No passkey or backup code is asked for at sign-up. The
passkey offer card (#577) stays for devices set up with a passkey. A
password member is offered the passkey and the backup code at calm moments
(below). Security settings show a **Password** section instead of the
backup-key one.

### A passkey and a backup code for an account — Adopted (#560, #571)

The owner's principle holds: each is one optional card at a quiet moment,
never a wall of steps, and everything is also under Security.

**On Today, one card at a time** (the onboarding card; `data-account-offer`):

- **"Sign in with your face or fingerprint?"** — after the first useful
  action (the household has something in it), where passkeys work and while
  online: "Add a passkey and your face, fingerprint or screen lock signs you
  in, on this device and on a new one. It also keeps your account safer:
  your password alone no longer opens it on a new device." `Add a passkey` /
  `Not now`.
- **"Save a backup code?"** — after the member's first week: "A backup code
  gets you back into Kin if you ever lose your password or passkey. Print it
  or write it down; it takes a minute." `Make a backup code` / `Not now`.

`Not now` hides the card on this device for good (it's remembered in browser
storage, like the passkey suggestion, #579); the same step stays under
Security. The action opens Security with that step already open.

**Security → Passkey** (account members): the status line (`On — your
passkey signs you in on a new device by itself.`, `On — signing in on a new
device asks for your password and your passkey.`, `Off — you sign in with
your password.`, or `Your passkey doesn't open your account on a new device
yet.` with `Set up my passkey`), one line on whether it also unlocks this
device (`Unlock this device with my passkey` when it doesn't), the
**Require password and passkey** checkbox (off by default, with a line
explaining the difference), and always: "If you lose your passkey (a lost
phone, a reset password manager), your backup code gets you back in. …"
Every change opens a small inline form under the section: `Your password`
(`autocomplete="current-password"`, labelled, described by the alert line),
then the device's passkey prompt. Cancel closes it; nothing changes until the
service confirms, and the status line then says what changed.

**Security → Password**: what unlocks this device, a line about what Kin
can't do (reset it) and what can (the backup code), and `Change password`:
current password, new password (with the guidance line) and the new password
again (`autocomplete="new-password"`); with require-both on, the passkey is
asked for too. A note says other devices keep their old password until they
next sign in (they ask for the new one at their next online unlock).

**Security → Backup code**: whether there is one (and when it was made),
what it's for, and `Make a backup code` (`Make a new backup code` when one
exists). Making one shows the code in 8 groups of 7 in a large monospaced
card (read by screen readers group by group), with `Print` (a print view
with only the card, `@media print`) and `Copy`; then "I've printed this code
or saved it somewhere safe" and `Your password`, and `Turn on this code`.
The code is only turned on after both, so an abandoned screen never leaves
the member without a working code; a new code replaces the old one at that
moment, and the screen says so.

**Signing in on a new device**: `Sign in with a passkey` needs the username
first (it says so beside the field). `Use my backup code` ("Lost your
password or passkey?") asks for the username and the code (dashes, spaces,
case and look-alike letters don't matter; a typo is named before anything is
sent), then "Which device is this?", then **Choose a new password**, which
is required. After a passkey-alone sign-in, a member with a backup code isn't
shown a backup key for the device; the lock screen offers the passkey (online
and offline) and, under "Can't use your passkey?", **Start over on this
browser** (below).

**Exports** from a member with a backup code open with it: the success line
says "It opens with your account backup code" (or "… or this device's backup
key K-XXXX"), and the restore screen's single field takes either.

**Security → Passkey → your passkeys** (#592 follow-up): each passkey is
listed ("Your passkey", or "Passkey 1", "Passkey 2", with "(unlocks this
device)" where it does) with `Remove this passkey` (`Remove passkey 2`). It
opens the same inline form: one line on what removing it means ("Your
passkey will stop signing you in. Your password signs you in on a new device
again, until you add another passkey." for the last one; "This passkey will
stop signing you in. Your password and your other passkeys keep working."
otherwise), whether it also stops unlocking this device (and that the
password then unlocks it; Kin then locks, as removing any unlock path from a
device does, and says so before), `Your password`, `Remove passkey` /
`Cancel`. Status: "Passkey removed. It no longer signs you in."

**Start over on this browser** (#592 follow-up): on the lock screen of a
device whose only way in is its passkey, under "Can't use your passkey?": one
sentence on why ("This device has no backup key of its own: your account is
its way back. …") and the button, described by it. A confirmation says
plainly what goes ("Kin removes everything it keeps in this browser: this
device's copy of your household, its keys and anything it hasn't synced yet.
Your household stays on your other devices and in your account.") and what
to do next ("sign in again and choose “This replaces” this device"). Then
Kin opens straight on **Sign in to your household**. Nobody is sent to the
browser's settings to clear site data.

**A password changed on another device** (#560 follow-up): the password lock
screen, online, after the previous password: "Your password was changed on
another device. Enter your new password to open Kin here; this device then
unlocks with it from now on." `New password` (`autocomplete="current-password"`,
username offered to password managers) / `Unlock`, and `Cancel` (locks again).
A wrong one: "That isn't your new password. Check it and try again." If the
new password is typed first: "That's your new password, and it signed you
in. This device still opens with your previous password: enter it once more,
and Kin switches this device to the new one." with the field labelled
`Previous password`. Afterwards: "Your new password unlocks Kin on this
device from now on." Offline, nothing is asked: the previous password works
until the device is online.

### Moving to an account — Adopted (#574, #575, #576)

For members who set Kin up with a passkey and a backup key before accounts.
Never forced, one calm offer:

- **On Today** (after the next unlock, online, `data-account-offer="account-migrate"`):
  **"Sign in on your other devices?"** — "Choose a username and password so
  you can sign in on your other devices. Your passkey and backup key keep
  working; nothing else changes." `Set up` / `Not now`. `Not now` puts it
  away for a week on this device (back once, never nagging). On another
  old-style device of a member who already moved: **"Use your account on
  this device?"** — "Your account is set up on another device. Enter your
  password here once, and this device uses it too." `Use my account here` /
  `Not now`.
- **Security → Your account** (first, for those members): the status ("You
  unlock Kin with your passkey and this device's backup key.", or "Your
  account (<username>) is set up, but not on this device yet."), one line on
  what it gives, and `Choose a username and password` (`Use my account
  here`). The inline form: `Username` (`autocomplete="username"`, with the
  username guidance), `Password` and `Password again`
  (`autocomplete="new-password"`, with the password guidance), and "Kin can't
  reset this password. Next, confirm with your passkey." `Set up my account`
  / `Cancel`. Problems are said in the alert line before anything is sent
  (two different passwords, a weak one, a taken username). Progress reads
  "Confirming with your passkey…", "Making your account's key vault…",
  "Getting your account ready for new devices…", "Letting your password
  unlock this device…"; then "Your account is ready. On another device, sign
  in with your username and your passkey. Your password unlocks this device
  too." The section is replaced by the account's Passkey, Password and
  Backup code sections.
- **The lock screen** then asks for the password (`Unlock`), offers `Unlock
  with passkey`, and keeps `Use backup key` one tap away.
- **Backup key for this device** (#576): once the member has a backup code,
  the section says "You no longer need this device's backup key: your
  account backup code is your way back in now. The key still unlocks this
  device, and still opens the exports made with it, so keep it until you
  don't need those." and no longer offers `Replace backup key` or the key
  guidance.

### Your private things — Adopted (#493, #494, #495)

Under **Security → Backup and move**, after the household export, where the
member's private storage is open: **Your private things** — "Your journal,
your Just for me list, and the reminders and settings that follow you.
Household exports never include them. Save your own copy: only you can open
it, on your devices or with your account backup code." `Save my private
things` / `Restore my private things`.

- **Save** downloads `kin-private-<date>.kinp` and says what went in: "Saved
  12 private changes and 3 journal photos. It opens on your devices, or with
  your account backup code." Without a backup code: "It opens on your
  devices. Make a backup code to be able to open it without them." Photos
  that didn't fit: "2 journal photos didn't fit in the file and aren't
  included; they stay in your account."
- **Restore** shows one file field (`accept=".kinp"`), describes the file
  once chosen ("Saved on <date>: 12 private changes and 3 journal photos."),
  and asks for `Account backup code` only when this device can't open the
  file ("Only needed if this device doesn't hold the key the file was saved
  with."). Results: "Restored 12 private changes; 3 were already here." or
  "Everything in this file is already here. Nothing was duplicated." Another
  member's file: "This file holds someone else's private things, or another
  household's. Kin restores private things only for the member who saved
  them."

### Calmer unlock until accounts arrive — Adopted (#563)

A tester unlocked with the recovery key every time, and a synced password
manager offered that key on other devices, where it can't work: each device
has its own local root and its own key. Until one account works on every
device (#546), three changes make the passkey the everyday way in and the key
plainly this device's backup:

- **Backup key for this device.** Every screen calls it the *backup key*
  (`Save your backup key for this device`, `Use backup key`, `Unlock with
  backup key`, `Replace backup key`, the `Backup key for this device`
  settings section and its `Backup key guidance`). Where it is introduced
  (setup, the unlock field, settings) the copy adds "Each device has its own".
  Only words changed: wrapper types, manifest and event fields, the stored
  format, element IDs and code names still say *recovery*.
- **Passkey unlock as setup's next step (#577).** Once the person has said
  they saved the key and the device can reach the identity service (it is
  signed in to a household and online, which enrolment needs), Today shows
  one card: "Unlock with your face, fingerprint or screen lock next time?"
  with `Turn on` (the ordinary PRF enrolment) and `Not now`. It never blocks:
  `Not now` goes on, and a failed enrolment says plainly what happened, points
  to More → Security and goes on. On a new device setup comes before the
  household, so the card appears as soon as create or join finishes, in the
  same session. Nothing is shown where the browser can't use passkeys or the
  device is offline.
- **The password-manager entry names the device (#579).** New entries are
  named "Kin backup key — Chrome on Android (K-7F3A)": the device's automatic
  name (§8.1, first-run fixes) and the key's label. A nickname is not used,
  because the name is remembered in this browser's storage and nicknames are
  encrypted household data. The unlock form asks for the same entry, and a
  line under the field says "Use the saved entry ending K-7F3A." (both the new
  and the older format end with the label). Entries saved earlier keep
  working: when the device has no remembered name for the current label, the
  form asks for the older "Kin recovery key K-7F3A".
- **A one-time suggestion (#579).** After an unlock with the backup key while
  passkey unlock is off and possible, Today suggests "Skip the backup key next
  time?" with `Turn on passkey unlock` and `Not now`. `Not now` is remembered
  on this device, so it isn't suggested again.

### First-run friction fixes — Adopted (v1.0 reality check, #163)

Testers on real phones found three setup snags:

- **No retyping the recovery key.** The setup step shows the key with Copy
  key and asks the person to tick "I've saved this key somewhere safe". It no
  longer asks them to paste it back. The form carries off-screen
  `username`/`new-password` fields so the browser can offer to save it as a
  password named for the key's label ("Kin recovery key K-7F3A"; one shared
  name would let a second device's key overwrite the first; since #563 the
  name is "Kin backup key — <device> (K-7F3A)", see "Calmer unlock"). The recovery
  unlock form asks for `current-password` under the current key's name, so a
  saved key can autofill; key replacement offers the new key under its own
  label. The copy says not to count on the browser's offer: copying the key
  is the main path. The setup step shows only the key and its controls (with
  Back), not the welcome text above it, and focus starts on its heading.
- **Install help on iPhone and iPad.** No iOS browser offers an install
  prompt, and the Home Screen app keeps its own storage, separate from the
  browser it was added from. So the welcome screen in an iOS browser shows
  Home Screen steps for that browser *before* setup (Safari, including the
  iOS 26 ••• menu and its "Open as Web App" switch; Chrome on iOS 16.4+;
  other browsers, falling back to Safari). An app's built-in browser
  (Instagram, the Google app…) can't add to the Home Screen, so it's told to
  open the page in Safari. More has the same steps under Install Kin. Inside
  the installed app, nothing is shown.
- **Automatic device name.** Create and join name the device from the
  browser and platform ("Chrome on iPhone"; just "iPhone" in the installed
  app) and say so in one line. Nobody types a name; a nickname comes later
  (§8.2).

---

## 8.2 Trusted devices

A trusted device means Kin recognizes that device as authorized household access.

It is not synonymous with:

- a passkey;
- a browser session;
- a household member.

Where trust matters, explain the consequence.

Example:

> Removing this device stops it from syncing new household changes.

Trusted devices (v1.1, #71):

- Devices are grouped by member: "Your devices" first, then one group per
  other member. Each group is a labelled list.
- Each row leads with the device's name: its nickname, else its automatic
  name, else "New device · " and the first four characters of its sync code
  when it hasn't synced a name yet. After the name come the automatic name (when
  a nickname hides it), "This device" for the device in your hand, and
  Trusted or Revoked.
- Your own devices have **Rename**, which opens an inline Nickname field
  (at most 32 characters) with Save nickname, Cancel and, when one is set,
  Remove nickname. Escape cancels and returns focus to Rename. Rename's
  accessible name includes the device ("Rename Kitchen tablet").
- Other members' devices can't be renamed. Revoke and the other controls
  name the device by the same displayed name.
- The page says why names are safe to set: only household members can see a
  nickname.

---

## 8.3 Sessions

Session expiry should normally feel like:

> Your session ended. Use your passkey to continue.

Not:

> Authentication token expired.

---

## 8.4 Pairing

People & devices starts with two explicit actions before any scanner or code:

- **Invite another person** explains that Kin creates a separate household member
  identity with role-based access.
- **Add my device** explains that this remains the same person and member ID on
  another phone or computer, and that a member is not notified of their own
  changes on another device.

The chosen outcome remains visible during QR and manual entry. A generic
“Pair” action must not make the member/device result implicit. The complete
onboarding and platform checks are in
[Member and Device Identity Acceptance](IDENTITY-PAIRING-ACCEPTANCE.md).

Pairing should make the sequence understandable:

```text
invitation
↓
identity/passkey
↓
approval
↓
trusted access
```

Knowing the invitation code does not mean the person has joined.

UI wording must preserve that distinction.

---

## 8.5 Recovery

Recovery screens must state:

- what is being recovered;
- what authority is required;
- which old devices/credentials stop working;
- whether history is preserved;
- when recovery is impossible.

Prefer an honest:

> This encrypted history cannot be recovered.

over insecure magical recovery.

---

## 8.6 Deletion

Deletion language must distinguish:

- requested;
- pending;
- finalized.

If a recovery window exists, show it plainly.

If deletion is final, say so.

Old backups and stale devices must not be presented as legitimate ways to bypass deletion.

---

## 8.8 Notifications on this device (v1.1, #85)

Copy for every state, the Home Screen requirement on iPhone and iPad, and the
one-line promise are in [PUSH](PUSH.md#what-a-member-sees). Native buttons and
a native select, 48px targets, a polite status after each change, alert
semantics on errors, and focus returning to the section's first control.

## 8.7 Home screen name and icon (v1.1, #78)

In Identity & defaults, admins only (the section isn't in the DOM for anyone
else):

- **Toggle:** "Show our name and icon on home screens", off by default.
  Turning it on opens the form; nothing is published until Save.
- **Fields:** Short name (prefilled from the household name, up to 12
  characters, "Shown under the icon"), Description (optional, up to 200).
- **Icon:** "First letter of the household name" (default) or "Upload an
  image", with a preview of the icon and of the round crop some Android
  launchers use, labelled for screen readers. Save and Stop showing are
  disabled while a save is in flight, and while an uploaded image can't be
  used.
- **Before the first publish:** "Your household name and icon will be stored
  by the Kin service without encryption so devices can show them on the home
  screen. Everything else stays encrypted." Save stays disabled until "I
  understand the name and icon are not encrypted" is checked.
- **Platforms:** "Computers and Android phones pick up changes on their own,
  usually within a day. On iPhone and iPad, remove Kin from the Home Screen
  and add it again to see a change."
- **Save home screen** reports in a polite status ("Saved. Installed apps show
  it the next time they check for changes."). Errors use alert semantics. A
  conflict reloads the latest and says another admin changed it.
- **Stop showing** (or unchecking the toggle) asks for confirmation, deletes
  the service's copy and returns focus to the toggle.
- After a household rename, the status says home screens still show the old
  name until Save.

## 8.9 QR codes and signing in with a phone (v1.1, #93)

**Invitation QR (#97).** Shown on a waiting invitation, labelled "QR code for
this invitation. Scan it with the joining device's camera.", beside the typed
code, Copy code and Share invitation. The QR code goes once the invitation is
claimed (the code, Copy and Share stay while the claim awaits approval). An
expired or revoked invitation shows "This invitation ended: it expired." /
"…: it was revoked.", with no QR code and no code. On the join screen, "Scan invitation" opens the
scanner in place; a scanned invitation fills the field ("Code filled in from
the invitation. Check it, then continue."), and any other Kin code says
"That Kin code isn't an invitation. Scan the invitation's code, or type it."

**Scanner (#96).** The camera starts only on "Scan a code" and stops on a
result, Cancel, leaving the view or locking. Every state says what to do next
(starting, looking, blocked, no camera, insecure, lost, reader failed), and
"Type the code instead" is always offered.

**Computer: Sign in with your phone (#100).** A choice on the signed-out
screen ("You're already signed in to Kin on a phone. Scan this computer's code
with it, then type the 6-digit code it shows.") and a button on `/pair`.

- Waiting: "On your phone, open Kin → People & devices → Add a computer →
  Scan.", the QR code, "This code changes in 01:52" (updated silently) and
  Cancel. The code replaces itself four times, then "The sign-in code
  expired. Nothing was signed in." with "Show a new code".
- Approved: "Your phone approved this computer. Type the 6-digit code shown on
  your phone.", a "6-digit code" field and "Sign in", "The code works for
  01:40", Cancel. A wrong code, from the service: "That code didn't match. 2
  tries left. Check the code on your phone and type it again." Three: "That code was wrong too many times,
  so the sign-in request ended. Nothing was signed in."
- Ended (cancelled on the phone, expired, refused): "This sign-in request
  ended. Nothing was signed in." with "Show a new code" and Back, and "Sign in
  as someone else" when the computer offered a device it already had.
- A sign-in link opened in the browser of a device that's signed in, rather
  than scanned in Kin: "That was a computer's sign-in code. To approve it, choose Add a computer below
  and scan it there."

**Phone: Add a computer (#101).** In People & devices, for Adults whose device
has its sync key.

- Scan: "On the computer, open Kin and choose Sign in with your phone. Then
  scan the code it shows." An invitation code or anything else is explained;
  "Type the code instead" says a computer needs its QR code.
- Review: "Approve this computer?", the computer's automatic name, "It will be
  signed in as you…" (new, or already one of your devices), the warning
  **"Only approve a computer that's in front of you."**, "Approve with
  passkey" and Cancel. A dismissed passkey leaves the review open: "…The
  computer was not approved."
- Code: "Type this code on the computer", the code in large selectable text,
  "Only type it on “Chrome on Windows”, the one in front of you.", "The code
  works for 01:58", Cancel.
- Done: "The computer is signed in" and Done. Ended: what happened, "Scan
  again" and Done.

---

## 8.10 The family fridge (#317)

Household → Fridge (and **Draw on the fridge** beside Today's date) opens a
shared board, decided in [ADR 0011](decisions/0011-family-fridge.md).

- **One door, every screen.** A fixed 3:4 portrait door scales to fit: on a
  phone the width decides, on a short wide screen the height does, never past
  720 px wide. There is no pan or zoom on the door; the page around it scrolls
  and zooms as usual. Only the door sets `touch-action: none`.
- **Tools** are ordinary named buttons, each at least 44 px: eight colours
  (Black, Red, Orange, Yellow, Green, Blue, Purple, Brown), three widths
  (Thin, Medium, Thick), Eraser, Undo and Redo. Colours are palette indices,
  remapped for dark mode; under forced colours every stroke is drawn in the
  system text colour.
- **Input.** Finger, pen or mouse. While a pen is down, touches are ignored
  (a resting palm draws nothing); a second finger turns a finger stroke into a
  gesture and nothing is drawn. Strokes are saved on pen-up.
- **Eraser and undo.** The eraser removes whole strokes. Undo and Redo cover
  this device's own drawing and erasing in this visit; a stroke someone else
  erased or restored meanwhile is left alone.
- **What it says.** A polite line under the door summarizes the fridge ("3
  drawings by Sam, Alex and you"), and adds "Waiting to send." while changes
  haven't reached the household. A full fridge says so: "The fridge is full.
  Erase something or clear it to draw more." Nothing counts, ranks or
  notifies anyone.
- **Magnets** (#322) are named buttons over the door: an emoji, one of twelve
  Kin-drawn magnets or a short note, put up through a dialog (a bottom sheet on
  phones) in one of nine named places. Arrow keys move one 1% (Shift 10%),
  "Move to" picks a place, dragging works too, and Delete or "Take it down"
  removes it; undo puts it back. Nothing needs dragging.
- **Clearing** asks first, with "Keep it" focused, and anyone can bring back
  the latest clear.
- **Who can use it** (#323): Adults always draw; the household admin sets
  Limited and Temporary members to Draw, Look only (the fridge shows without
  its tools) or No access (Household → Identity & appearance → Who can use the
  fridge, with a passkey).
- **Kitchen-screen mode** (#324). A tablet on the counter is its own context.
  At 960 px or wider, in landscape, with a coarse pointer (and in full screen
  in landscape on any device), the heading, tools, summary and a lock note form
  a rail on the left and the door takes the screen's height beside it; the
  colours sit in a 4 × 2 grid of 44 px swatches. Portrait tablets and phones
  keep the stacked layout. **Full screen** (where the browser allows it) shows
  the fridge alone, and **Leave full screen** or Esc returns. Kitchen-screen
  mode never changes automatic lock: the rail says "Kin still locks after 15
  minutes without use, as it does everywhere. Drawing counts as use.", or, with
  automatic lock off, that anyone at this screen can open the rest of Kin and
  that it can be turned on in Security. Locking (by time, by Lock or from
  another tab) leaves full screen and shows the unlock screen.
- Drawing is a path-based gesture and has no keyboard equivalent.
- **Without sync** (#372) the fridge has nowhere to save a drawing, so it
  shows no tools and the line under the board says it's shared through
  household sync, with a link to Household → People & devices.

## 8.11 Meals (#333)

Lists → Meals plans the week's dinners, decided in
[ADR 0012](decisions/0012-meals.md).

- **The week** is seven day rows, Monday to Sunday, headed "This week · 19–25
  Oct" (or "Week of …"), with Previous week, This week and Next week. Each row
  says the day, the dinner or "Nothing planned", "Cooking: You" (or a name, or
  "No one yet") and one **Plan** / **Change** button, at least 44 px, whose
  accessible name names the day ("Change dinner for Monday 19 Oct"). Tonight's
  row is marked **Tonight**.
- **Planning** opens a dialog (a bottom sheet on phones) with **Find a
  recipe** focused, recent recipes first; **Something else…** takes any short
  name ("Leftovers"); **Who's cooking** lists You first, then members by
  preferred name. Anyone may cook; nothing is counted. **Clear this dinner**
  and **Done**; Esc or Done returns focus to the day's button.
- **Recipes** are a name, "Ingredients (one per line)" and optional notes. An
  ingredient that exactly matches an active Staple is linked to it and the
  editor says "Matched to Staple “Milk”."; each line's Staple select changes or
  removes the link. A line typed twice is kept once. A problem is shown beside
  its field and focus goes there.
- **Add ingredients to Shopping** (per recipe, and per planned day with a
  recipe) adds what's missing, re-adds linked Staples, skips what's already on
  Shopping, and says so: "Added 2 · Re-added 1 Staple (Milk) · Already on
  Shopping 1 (Bread)", with **Open Shopping**. Adding twice never duplicates.
  If saving stops part-way, Kin says how many were added and **Try again**
  adds only what's missing.
- **Tonight on Today** is one quiet line: "Tacos · Sam is cooking", or
  "Nothing planned for tonight." with **Plan dinner**. It never nags.
- **Layout.** Phones: one column, recipes below the week. When the Meals view
  is 560 px or wider (tablets), the days sit in two columns. At 1180 px and
  up the recipes sit beside a single list of days, and each recipe offers
  **Put on** a day of the week shown, without a dialog; with the detail panel
  open beside the list, Meals falls back to one list. Long names wrap and the
  page never scrolls sideways, from 320 × 568 to desktop and at 200% zoom.
- Dark mode uses the app's tokens; under forced colours tonight's row keeps a
  system-coloured border. Planning works offline and is saved on the device;
  with sync on, the status says it will sync when connected.

### Every meal of the day (#679)

Fuller meal plans, decided in [ADR 0022](decisions/0022-family-hub.md) §7.
They change the week above as follows.

- **Each day card has a row per meal:** Breakfast, Lunch, Dinner and Snack,
  in that order. Each row has its label ("Tonight" for today's dinner), what's
  planned or "Nothing planned", and one **Plan** / **Change** button named
  for the meal and day ("Plan breakfast for Monday 19 Oct"). Dinner keeps its
  cook line. A row whose meal has a recipe offers **Add ingredients to
  Shopping**. Today's card is marked **Today**.
- **Show** is a row of checkboxes (Breakfast, Lunch, Dinner, Snack) that
  folds meals away. Dinner always shows. On a phone, a meal nobody planned
  this week starts folded, so the cards stay short. Ticking a box keeps the
  choice on this device (`kin.meal-slots`).
- **Planning breakfast, lunch or a snack** uses the same dialog, titled
  "Breakfast for Monday 19 Oct", without **Who's cooking**. Picking a recipe
  or **Use this** saves it and closes the dialog. **Clear this breakfast**
  removes it. Favourites come first in the dialog's list, marked with a star
  and named "(favourite)" for screen readers.
- **Same as last week** fills each empty meal of the week shown with the
  meal planned seven days earlier: a recipe still listed is planned as
  itself, and one archived since is planned by name. Meals already planned
  are left alone and cooks aren't copied. The status says "Copied 5 meals
  from last week." When nothing is left to copy, it says so. If saving stops
  part-way, **Try again** copies only what's missing.
- **Add this week's ingredients to Shopping** puts every meal's recipe for
  the week shown on Shopping in one go. A recipe planned twice counts once,
  and so does an ingredient two recipes share. It reports the same way as one
  recipe, and adding twice never duplicates. A week without recipes says
  there's nothing to add.
- **Favourites.** Each recipe has a star button (☆ / ★, `aria-pressed`, named
  "Favourite: Tacos"). In easy mode it shows the word "Favourite" too.
  **Favourites** (a toggle beside **Add a recipe**, shown once a recipe is a
  favourite) lists only favourites.
- **Today** keeps Tonight's line and lists today's other meals under it
  ("Breakfast: Porridge", "Lunch: Sandwiches"). **This week** lists every
  meal on its day, in order ("Breakfast: …", "Dinner: …").
- **Layout** is unchanged: one card per day in one or two columns. Every
  control is at least 44 px (56 px in easy mode) and nothing scrolls
  sideways from 320 px up.

## 8.12 Simple view (#341)

A calmer layout a household admin turns on for a Limited member, decided in
[ADR 0013](decisions/0013-simple-view.md). It is a layout, not a lock: the
service enforces only the switch and Chat and Fridge access.

- **The switch.** In People & devices, an admin sees **Turn on Simple view
  for …** on each active Limited member's row, confirmed with their passkey;
  the row then says "Simple view on". The copy says it hides the rest of Kin
  and can't prevent it. The child can't turn it off. Their device switches
  on its next sync, and an offline unlock keeps it. Turning it off reloads
  their Kin into the full layout. A device belongs to one member: a child
  needs their own device.
- **What shows.** Today, Chat and the Fridge; the rest of the workspace is
  out of the document (the household panel stays, hidden, so a removed
  device still locks). Every other address, alias, `/pair` and search link
  opens Today. No Quick add, Search, command palette, keyboard shortcuts,
  bulk selection, item details, or turning a chat message into a record;
  the brand, sync status and Lock stay. Chat and the Fridge appear once
  they're open on the device. The navigation is a
  bottom bar on phones and a side list wider, with Chat or the Fridge left
  out when the child has no access; with neither, there is no bar.
- **Today.** "Tonight: Tacos" when a dinner is planned, then one large card
  per thing: the child's own items planned for today or earlier (or not
  dated) and their routines open today. Each card shows the picture (the
  item's emoji, else its first downloaded photo) beside the words, never
  instead of them, and a full-width **Done** at least 56 px tall named
  "Done: …". Done becomes **Undo** in the same place for the session, and the
  polite status says "Marked “…” done." (with "It will sync when you're
  connected." offline). With nothing to do: "Nothing for you today." No
  counts, streaks, totals or celebrations.
- **Layout.** Phones: one card per row, a 96 px picture, 1.25rem text,
  stacked above the words on narrow screens. 720 px and up: a grid of cards
  (`minmax(18rem, 1fr)`) with a 128 px picture above the words. Sizes are in
  rem so text zoom grows them; nothing has a fixed height or moves.
- **Pictures for adults.** An Adult picks an item's picture in its details
  (Picture: type or pick one emoji, **Save picture**, **Remove picture**). It
  shows small beside the item's text in lists and large on a child's Simple
  view.

## 8.13 Just for me (#510)

A member's own private to-dos and short notes, on all their devices, that
the household never sees ([ADR 0019](decisions/0019-member-private-log.md)).
They live in the member's private log; nothing about them enters a
household record.

- **Where.** Lists › **Just for me** (`#lists/mine`), after Meals. The
  heading is followed by a lock and **Only you can see this.**, then one line:
  "Private to-dos and short notes, on all your devices. Your household never
  sees them."
- **When it isn't available.** One calm sentence instead of the list.
  Without an account vault key on the device: "Just for me needs your Kin
  account on this device, so your private things can follow you to your other
  devices. Set up your account." (linking to Privacy & recovery). When the
  household turned private storage off for a child or teen, or for a
  Temporary member: "Your household has turned off private things for you,
  so Just for me isn't available."
- **Capture.** One field, **Add something just for you**, and an optional
  **Date**; Enter or **Add** saves it and leaves the field focused and empty.
  The member's first private thing creates their member key; nothing else is
  asked.
- **The list.** Open things first (dated soonest first, then undated in the
  order added); a checkbox completes and reopens; done things go under
  **Completed (n)**. Each item's **More** holds its wording, its date, a short
  note (up to 2,048 bytes, line breaks kept) and **Share with the
  household…** and **Delete**. Deleting says "Deleted “…”." with **Undo**,
  which takes focus and stays until the next change (it never times out);
  Undo brings the item back with its note and date.
- **My Today and This week (#514).** A setting at the foot of the list, on by
  default and kept in the private log so it follows the member: **Show my
  dated private things on my Today and This week**. With it on, dated
  private items join Today's Earlier plans, Today, Coming up and Completed,
  and This week's days (open ones from before the week on its first day),
  each with a **Private** tag and a lock, and named "Private: …" for
  assistive technology. They complete and reopen there; Today's counts
  include them. Never in Simple view (a shared kitchen screen), never on
  anyone else's device, never in household search, the sitter page,
  calendar exports or household exports.
- **Share with the household… (#517).** Not offered for done items. A
  dialog names who will see it ("“…” will move to To do, where Alex and Sam
  will see it.", or everyone in the household, including anyone who joins
  later, when no one else is there yet) and says it leaves Just for me and
  its note stays private. **Keep it private** has the focus; **Share with the
  household** adds it to To do with its date and then removes it from Just
  for me. If the second step fails, the alert says it's already in To do and
  that trying again won't add it twice.
- **Make private (#517).** In a household item's details, under History,
  only for something this member added: **Make private** copies it into Just
  for me (with its date, and done if it was done) and archives the household
  item; the household sees it archived, as with Archive. The status line says
  so and the toast offers **Undo**, which brings the household item back
  (as an archive's Undo does) and removes the private copy. There is no
  Redo. A failure after the copy says so, and trying again copies nothing
  twice.

## 8.14 Reminders and settings on all my devices (#520)

A member's reminders and personal settings follow them to every device they
use, in their private storage ([ADR 0019](decisions/0019-member-private-log.md)):
no other member, admin or the service can read them.

- **Reminders.** "Remind me" on an item or a routine is unchanged: date,
  time, three shortcuts, a readable preview, **Set reminder**. With private
  storage on, the group is headed "Reminder" (not "Reminder on this
  device"), the preview reads "Reminds Tue, Oct 20, 9:00 AM." and the note
  under it "On your devices that allow notifications, while Kin is open."
  Setting it says "Reminder set. It goes off on your devices that allow
  notifications while Kin is open."; where this browser blocks
  notifications, "Reminder set for your other devices. Notifications are
  blocked in this browser's settings." It goes off at the same instant on
  each of the member's devices that allows notifications and is open. A
  reminder set in another time zone also says the time where it was set:
  "Reminds Tue, Oct 20, 3:00 PM (9:00 AM in America/New_York, where it was
  set)." Clicking or closing the notification on one device clears it on
  all of them (their notifications close on the next sync); **Cancel
  reminder** cancels it everywhere ("Reminder canceled on all your
  devices."); completing or archiving the item, finishing or archiving the
  routine, or changing the item's date or the routine's schedule ends it
  everywhere, as it already did on one device. A reminder that came due
  more than ten minutes before a device opened Kin stays quiet there.
- **Settings that follow you.** Theme (light, dark, system or the
  household's; the color, unless it comes from this device's own background
  picture, which stays here), text size, reduced motion, whether reminders
  show as notifications, the count on the app icon, and easy mode (§41,
  setting 8). Household →
  Identity & appearance gains **Text, motion and reminders**: Text size
  (Standard, Large, Larger), **Reduce motion in Kin** (Kin also follows the
  device's own setting), **Show my reminders as notifications**, and, where
  private storage is on, **Use different settings on this device** ("For a
  shared screen such as a kitchen tablet: changes here stay here, and
  changes on your other devices don't arrive."). Reminders follow the member
  either way. When two devices change the same setting, the later change
  wins; different settings never overwrite each other. Simple view is not a
  personal setting: it stays the household admin's choice for the member
  ([§8.12](#812-simple-view-341)), so a kitchen tablet keeps its own layout.
  "Show my dated private things on my Today and This week" is Just for me's
  own setting ([§8.13](#813-just-for-me-510)), which already follows the
  member; setting key 7 stays reserved for it.
- **One line says where they live:** "Your theme, the app icon count and
  these choices follow you to your other devices, and so do your
  reminders."; "This device keeps its own settings. Your reminders still
  follow you."; "Your household has turned off private storage for you, so
  your reminders and these choices stay on this device."; or, for a member
  set up the old way (passkey and backup key, no account), "Your reminders
  and these choices stay on this device. Set up an account to have them on
  all your devices." Without private storage everything works exactly as
  before, on this device.
- **The first device** to open with private storage brings what it has: a
  reminder set on it before (they lived only in that tab) moves into the
  member's private storage once, without duplicates, and settings it changed
  from the defaults become the member's where nothing synced yet. A device
  opening later takes the member's settings. The member key is made on the
  first private change; a device that was already open picks it up on its
  next sync.
- **Text size** scales the whole page as browser zoom does (Large 112.5%,
  Larger 125%): lines reflow, nothing scrolls sideways, and it composes with
  the browser's own zoom up to 200%. Text size and reduced motion are kept
  on the device unencrypted (they say nothing about the household), so the
  lock screen opens at the same size.

## 8.15 Your journal (#496)

A private place to write about the household's days, built on each member's
private storage ([ADR 0019](decisions/0019-member-private-log.md)). Only the
member's own devices can read it; no other member, household admins
included, and not the service.

- **Where.** Household's overview has a **Just for you** group with
  **Journal**; the page (`#journal`) marks Household in the navigation and is
  not a sixth destination. It isn't in Simple view. A pill under the heading
  says **Only you can see this**.
- **Before it opens.** The journal needs the member's Kin account on the
  device (password sign-up keeps the vault key there, #557). Without it, one
  calm sentence says so and links to **Set up your account** (People &
  devices). Temporary members are told it isn't available to guests; a child
  or teen whose household turned private storage off is told that. The first
  save makes the member key.
- **Write.** **New entry** opens an editor: the date (today by default), an
  optional title, the body (plain text, line breaks kept) and photos. Focus
  goes to the body. The draft is kept as it is typed while Kin is unlocked,
  so closing the editor (Close or Escape) or leaving the page keeps it, and
  **New entry** becomes **Continue your draft**; **Discard draft** drops it.
  Like every Kin draft, locking discards it. One draft at a time. Saving
  moves focus to the saved entry; Close returns focus to the button that
  opened the editor.
- **The list.** Newest first under date headings ("Saturday, 3 October
  2026"); each entry shows its title, body and thumbnails, with **Edit** and
  **Delete**. The empty journal explains its privacy in one sentence.
- **Delete and Undo.** Delete offers **Undo** in a bar at the top of the
  journal, with focus on it; it stays until the next action or until
  dismissed (never timed). Undo puts the entry back and focuses it.
- **Photos.** **Add photos** takes JPEG, PNG or WebP up to 4 MB each, ten an
  entry, with the household attachment wording when one can't be added.
  Photos are drawn again (no location or camera details) with a thumbnail.
  Removing a photo in the editor offers Undo. A thumbnail opens the photo in
  the same viewer as household photos, with Save file. A photo still
  uploading from another of the member's devices says "Photo on its way".
- **Find.** **Search your journal** matches every word in titles and bodies,
  ignoring case and accents, on this device only; it never reaches
  household Search. **Jump to a month** focuses that month's first day.
  **On this day** lists entries from the same day in earlier years ("1 year
  ago"), on the journal page only, never as a notification, and steps aside
  while searching.
- **Send things to it.** The share sheet into Kin offers **Add to my
  journal**, which opens a new entry with the shared text and photos; the
  sheet says that only you see what goes to the journal. The **New journal
  entry** home-screen shortcut opens the editor after unlock.
- **Never.** No streaks, prompts to write, word counts, moods or reminders
  to journal (PRODUCT-BOUNDARIES). Entries never appear in household
  search, Today, chat, catch-up or household exports.

## 8.16 The family calendar (#660, ADR 0022 §1–2)

This week grew into the **Calendar**. It is reached from Today (the This
week link, `#week`) and keeps **Today** marked in the navigation: there is
no sixth destination.

- **Three views** as the page's tabs: **Week** (`#week`, the default),
  **Day** (`#week/day`) and **Month** (`#week/month`). A toolbar names the
  period ("This week", "Week of Monday 12 October", "Tuesday 6 October",
  "October 2026") with **‹ Previous**, **Today** and **Next ›**, and
  **Add event**.
  - **Week** is This week's list: seven days from today ("today first"),
    each starting with its events, then meals, planned items (tick, Move
    to…, Details), routines and maintenance. Weeks step by seven days.
  - **Day** has an **All day** box (all-day events, meals, planned items and
    routines) above the day hour by hour (from 7:00 to 21:00, or wider to
    fit). Overlapping events sit side by side. An empty hour is a button
    that adds an event there; a line marks the time now.
  - **Month** is a grid of six weeks. Each day shows up to three events
    with their colours (on a phone, colours and a count), "+2 more", and
    how many other things fall on it. Pressing a day opens it in Day.
  - A **row of the seven days** sits above Week and Day: each says its date,
    "today" and how many events it has. In Week it brings that day into
    view; in Day it shows it.
- **Keyboard.** In the row of days and the month grid, one day is in the
  tab order. The arrow keys move between days (up and down by a week in
  the grid), Home and End go to the start and end of the week, Page Up and
  Page Down to the previous or next week (month in Month), Enter opens a
  month day.
- **Screen readers** hear each event as "title, date, time, for whom, at
  where", plus "Repeats", "Cancelled", "your time; set in Europe/London" or
  the outside calendar's name when they apply. Month days are read as
  "Tuesday 6 October, today, 3 events, …".
- **Times.** An event keeps its own zone; Kin shows it in the viewer's own
  time (`Intl`), so 9:00 in London is 4:00 for someone in New York. Times
  set without a zone (some imported ones) are shown as written. All-day
  events are dates and never move.
- **Colours by person.** Every event shows a small bar in each attendee's
  colour **and their names** ("You and Sam"); an event for nobody in
  particular is "Everyone", with a striped neutral bar. Colour is never the
  only signal. **My calendar colour** (Household › Identity & appearance)
  offers twelve named colours and **Kin's choice** (a default by join
  order); everyone's colours are listed beneath. Each colour has a light-
  and a dark-theme value with at least 3:1 against Kin's surfaces; in
  forced colours they become outlined system colours.
- **Adding** is a few taps: **What**, **Day**, **All day** or **Starts** and
  **Ends**, and **Who** (you are ticked; nobody means everyone). **More
  details** holds **Last day** (several days), **Where**, **Notes**,
  **Repeat** and **Count down to this on Today**.
- **Repeat** follows the engine's subset: every N days, weeks (on chosen
  weekdays), months (on day 13, the second Tuesday, the last Tuesday or the
  last day, as the start date allows) or years; ending never, after a number
  of times or on a date. A line says it in words ("Every week on Monday and
  Wednesday, 10 times").
- **Changing** a repeating event asks **Change: Just this one / All of
  them**. "Just this one" cancels that occurrence and saves a linked event
  for it; "All of them" moves the series by as many days as the occurrence
  moved. **Cancel…** asks **Just this one** or **All of them** (a one-off
  event: **Cancel it**). Every change offers **Undo** (and then Redo).
- **Changed elsewhere.** If someone changed the event on another device
  while the editor was open, nothing is saved; the editor says so and offers
  **Show the latest** or **Keep my changes**. A change the household refused
  meanwhile (cancelled elsewhere) is said plainly, and the calendar shows
  what is there now.
- **Today** shows **Today's events** (all-day first, then by time) under
  Tonight, and the next countdown: "12 days until Trip", "1 day until
  Trip", "Trip is today". With nothing on, "Nothing on the calendar today."
  and **Open the calendar**.
- **Importing a calendar file.** **Import a calendar file…** under the
  calendar, or sharing an `.ics` file to Kin (**Add to the calendar** in the
  share sheet), opens a dialog: choose the file, see "12 events from Kids:
  10 new, 2 changed." (and what is left out or simplified) before anything
  is saved, then **Import 12 events**. The file is read on this device.
  Importing the same file again updates the events by their source UID and
  never doubles them ("12 already in Kin"); an imported event the household
  had cancelled comes back. One Undo takes back the whole import.
- **Outside calendars** synced by the service (#668) show read-only in
  every view and on Today (`web/calendar/external.js`): dashed, with their
  source label ("From Google"), never editable here. Their settings
  (Identity & appearance) leave with the Calendar switch.
- **Easy mode** shows the Day view as a list ("All day", "At set times")
  instead of hours, with bigger text and day buttons; Month waits in the
  tabs until it is used. **Help** has a topic for each view, for the event
  editor and for importing.
- **Feature switches.** **Calendar** (bit 14) owns Day, Month, events,
  Today's events and countdown, the colour setting and importing. **This
  week** (bit 5) owns the Week view. With only the Calendar on, `#week`
  opens Day; with only This week on, Week is This week as before.
- **Reuse.** `<kin-calendar>` (with `views="day week"`, `compact` and
  `readonly`) and `<kin-calendar-today>` only draw what they are given and
  ask for the rest with events, so the kitchen display (#669) can embed
  them.

# 9. States every relevant screen must handle

| State | User-facing behavior |
|---|---|
| **Loading** | Skeleton/layout remains stable. |
| **Empty** | One sentence + one obvious action. |
| **Saved locally** | Quiet confirmation if useful. |
| **Waiting to sync** | Work remains usable. |
| **Up to date** | Calm status, not constant celebration. |
| **Offline** | "Offline — changes are safe here." |
| **Conflict** | Explain both valid changes and recovery action. |
| **Device revoked** | Clear terminal security state. |
| **Session ended** | Offer passkey reauthentication. |
| **Recovery needed** | Explain what is required. |
| **Recovery impossible** | Explain the boundary honestly. |
| **Deletion pending** | Show consequence and cancellation boundary. |
| **Household deleted** | Terminal state; stale data cannot silently resurrect. |
| **Storage unavailable/full** | Say what remains safe and next action. |
| **WASM failure** | Explain + retry. |

System-state previews should exist in development/styleguide tooling so designers and agents can inspect these states deliberately.

---

# 10. Household-specific safety

## 10.1 No surveillance

Never add by default:

- last seen;
- online now;
- location;
- passive read receipts;
- app usage reports;
- exact activity timelines;
- "Sam opened this at 8:42";
- completion-performance analytics.

Exception: household chat's read receipts, typing and "online now" are visible, switchable per member, reciprocal and never kept as history ([ADR 0008](decisions/0008-household-chat.md)). "Last seen" and location stay out.

---

## 10.2 Explicit responsibility is allowed; judgment is not

Showing:

> Alex

on an assigned household item is useful.

Showing:

> Alex completed 43% this month

is not aligned with Kin.

---

## 10.3 Tension-safe design

Assume some screens will be viewed during a disagreement.

Use factual language.

Do not editorialize.

Bad:

> Sam has been doing more lately.

Better:

> 4 things are still unassigned.

Often the best choice is to show no comparison at all.

---

# 11. Accessibility

**Target:** WCAG 2.2 AA.

Accessibility is part of feature completion.

## Requirements

### Keyboard

Everything is operable by keyboard.

Visible focus remains obvious.

---

### Touch

Minimum target:

```text
44 × 44 CSS px
```

Prefer:

```text
48 × 48
```

for common daily actions.

---

### Reflow

No loss of function at:

- 320 CSS px;
- 200% zoom.

---

### Contrast

Meet WCAG requirements in:

- light;
- dark;
- forced-colors.

---

### State

Never communicate meaning only through:

- color;
- position;
- animation.

Checked state needs a visible mark.

---

### Motion

Honor:

```css
prefers-reduced-motion
```

Motion cannot be required to understand state.

---

### Focus management

After dynamic updates, focus stays where the user expects.

Dialogs restore focus to their trigger.

---

### Live status

Important dynamic outcomes should use appropriate live-region behavior.

Examples:

- saved;
- completed;
- sync state changed;
- recovery succeeded;
- destructive action failed.

Do not announce every background synchronization event.

---

### Authentication

Do not require users to memorize/transcribe complex credentials.

Pairing and recovery should use platform-supported identity mechanisms and short intentional transfer mechanisms.

---

# 12. Design system

Kin should remain dependency-light.

The design system should primarily be:

- semantic HTML;
- CSS custom properties;
- reusable Web Components where appropriate;
- native browser APIs.

## Required tokens

```css
--bg
--surface
--surface-secondary
--ink
--ink-muted
--line
--accent
--accent-ink
--accent-soft
--warm
--warm-soft
--danger
--danger-soft
```

Also define reusable:

```css
--space-1
--space-2
--space-3
--space-4

--radius-control
--radius-card

--tap-target
--content-width
```

---

## Core components

### `kin-item-row`

Contains:

- explicit complete control;
- title;
- optional metadata;
- optional owner;
- contextual actions.

The entire row should not become one giant ambiguous click target.

---

### `kin-quick-add`

One-field capture.

Enter submits.

After successful add, focus may remain for rapid capture.

---

### `kin-status-chip`

Used for:

- sync;
- local/offline state;
- device/security state where appropriate.

Always contains text.

Never just a dot.

---

### `kin-banner`

Used for:

- Catch up;
- temporary notices;
- security/recovery attention.

Dismissible where appropriate.

---

### `kin-bottom-nav`

Five destinations maximum.

Stable ordering.

Text + icon.

Uses `aria-current="page"`.

---

### `kin-confirm-dialog`

Only where consequence requires explicit confirmation.

Use for:

- deletion;
- revocation;
- member removal;
- irreversible restore actions.

Not every ordinary edit.

---

### `kin-empty-state`

One short explanation.

One primary next action.

---

# 13. Responsive layout

## Mobile — Adopted

Primary target.

Single column.

One-handed.

Bottom navigation.

---

## Wide screens — Adopted (household workspace candidate)

Kin is still not a desktop dashboard. Wide screens get:

```text
left navigation  |  readable content column (≤ 720px)  |  detail column only while an item is open
```

There are no permanent information rails, widgets or statistics. The detail
column is conditional; closing the item removes it. See UX-D4 and
[WORKSPACE-UX](WORKSPACE-UX.md) §4.

---

# 14. Content and voice

Kin should sound like a thoughtful housemate.

## Voice

- short;
- warm;
- plain;
- specific;
- nonjudgmental.

No fake enthusiasm.

No corporate product language.

---

## Examples

Instead of:

> Sync conflict detected.

Use:

> You and Sam both changed this.

Instead of:

> Authentication required.

Use:

> Use your passkey to continue.

Instead of:

> Device unauthorized.

Use:

> This device is no longer trusted.

Instead of:

> Task overdue.

Use:

> Still open from earlier.

Instead of:

> Data restoration failure.

Use:

> The backup couldn't be restored. Your current household is unchanged.

---

# 15. Privacy and trust in UI

The product must make its trust boundaries understandable.

## Show

- sync state;
- trusted-device state where relevant;
- backup/recovery status;
- deletion consequences;
- what action is required.

## Do not expose casually

- key epochs;
- cryptographic primitives;
- token IDs;
- internal sequence numbers;
- storage internals.

Those may exist in diagnostics, not ordinary household UX.

---

# 16. Growth toward v0.45.x

The app shell created in `0.14.x` should survive the roadmap.

Future capabilities should fit roughly as follows:

| Capability | Likely home |
|---|---|
| Checklists | Today / item detail |
| Richer routine schedules | Routines |
| Shopping | Lists |
| Staples/replenishment | Lists |
| Household modes | Today + Routines |
| Planning dates | Today / item detail |
| Calendar interoperability | More / contextual settings |
| Useful history | More / entity details |
| Search | Global shell / More |
| Pins/quick access | Today |
| Playbooks | Routines / More |
| Local reminders | Contextual settings |
| PWA/install | Browser/platform |
| Reference records | More |
| Maintenance | More |
| Attachments | Entity detail |
| Responsibility | Item/Routine detail |
| More household members | People & devices |
| Limited/guest members | People & devices |
| Export/restore/migration | More / continuity |
| Backup/disaster readiness | More / continuity |

A feature should not earn a permanent navigation destination merely because it exists.

---

# 17. v0.14.x design consolidation scope

`0.14.x` should establish the shell, not implement the entire roadmap.

## Pass 1 — Structure

Focus on:

- global shell;
- navigation;
- spacing;
- typography;
- tokens;
- cards/list rows;
- primary Today experience;
- preserving existing functionality.

No large visual flourishes.

---

## Pass 2 — States and responsive behavior

Focus on:

- loading;
- empty;
- offline;
- sync;
- recovery;
- revocation;
- deletion;
- narrow screen;
- keyboard;
- zoom;
- forced colors;
- dark mode;
- reduced motion.

---

## Pass 3 — Polish and prototype alignment

Focus on:

- warm visual character;
- wording;
- hierarchy;
- focus management;
- visual consistency;
- design-system cleanup;
- removal of obsolete styles;
- docs;
- prototype comparison.

Then stop for human design critique.

Do not immediately continue redesigning based solely on agent preference.

---

# 18. Open design decisions

## UX-D1 — Final `0.14.x` navigation transition

**Directional choice:** Today / Lists / Routines / Handoff / More.

**Open:** whether `0.14.x` adopts the full destination set immediately or transitions while preserving existing routes.

---

## UX-D2 — Talk placement

**Leaning:** preserve Talk functionality but place it as a mode inside Handoff rather than permanent navigation.

Reason:

- both are interpersonal household context;
- Talk does not justify consuming 20% of permanent navigation as Kin grows.

---

## UX-D3 — Pulse

The existing prototype's Pulse expresses a valuable desire:

> "How is the household doing?"

But numeric shared-load comparison risks conflicting with Kin's no-scorekeeping principle.

**Directional choice:** retire Pulse as a permanent tab.

Useful pieces can move elsewhere:

- sync/privacy → More / trust;
- open household needs → Today or Lists;
- descriptive household state → Today;
- history → More.

Do not ship comparative partner completion bars.

---

## UX-D4 — Desktop layout

**Adopted (household workspace candidate):** persistent left navigation with
a readable content column and a *conditional* detail column.

From 720px the five primary destinations sit in a left rail beside a content
column of at most 720px; the header carries Search, a truthful sync chip and
Lock. From 1180px, opening an item adds a detail column beside the list; at
720–1179px the detail replaces the list with a Back control; below 720px it
is a full-height sheet. The column exists only while an item is selected,
and one `<kin-item-detail>` element is re-homed between the three
presentations so drafts survive resizing. Mobile keeps the five-item bottom
navigation with five equal tracks. The contract is
[WORKSPACE-UX](WORKSPACE-UX.md).

---

## UX-D5 — Household name

**Directional:** allow household identity in the shell eventually.

Until then:

```text
Kin
Alex + Sam
```

or similar calm context is sufficient.

---

# 19. UX validation

Kin does not need behavioral analytics to validate the product.

## Telling the Kin team (ADR 0021 §3, #630, #627)

**Report a problem** is one tap from Household (beside Search), the keyboard
help, Help (which fires `kin:report-problem`), every error message (a
"Report a problem" button beside it), after an error nothing handled (one
calm status line with the same button, at most once a minute), and the lock
screen and setup, where a person may be stuck and can't sign in.

1. **Write** (optional): "What happened" and "What you expected". A
   checkbox, off by default, adds a picture of this screen; turning it on
   shows the picture at once with a warning that it can show private things,
   and four "Trim from…" sliders crop it (5% steps, keyboard operable).
2. **Check what will be sent**: where it goes in one sentence (to the Kin
   team; and, when the operator forwards reports, that a copy without the
   picture goes to the project's issue tracker, "which anyone on the
   internet can read" unless it is private), what was typed, each device
   detail as a row with its own Remove button (focus moves to the next
   row's Remove, and the removal is announced), the recent error codes
   behind "Show them", and the picture with "Remove the picture". "Put back
   removed details" undoes removals.
3. **Send**. "Sent" with the reference number (`KR-XXXX-XXXX-XXXX`), or,
   offline, "Saved to send": the report waits on the device and goes when
   Kin can reach the service. Nothing is ever sent without Send.

**Suggest something** (household admins) is in Household › Features,
under "Ideas for Kin": what they'd like (needed) and why it would help, a preview with only the
Kin version, Send, and a `KS-` reference.

**What I've sent** (Household, and after sending) lists what is still
waiting on this device, with "Send now" and "Remove", and what the member
sent with its status: Received, Planned, Done or Won't do. Reports sent
without signing in aren't listed.

The dialog is a native modal (a bottom sheet under 480 px) with a focused
heading, labelled fields, 48 px targets and no sideways scrolling at 320 px.
Locking closes it and drops the draft and the picture.

## Outside calendars (ADR 0022 §3, #665, #668)

Household › Identity & appearance › **Outside calendars**, below Text,
motion and reminders.

- **Lead:** "Show a Google, Apple or Outlook calendar beside your family's.
  Its events appear read-only, marked with where they came from, and stay
  out of your household's history."
- **A household that doesn't sync** sees one line saying calendars sync
  through the household's Kin server, and that importing a file still works.
  Offline, the calendars the device kept are listed with a line saying so.
- **Adding (Adults):** "Private calendar link" (`https://` or `webcal://`)
  with where to find it in Google, Apple iCloud and Outlook; "Who sees it":
  **Just me** (default) or **Everyone in the household**; **Continue**. A
  link Kin can't sync is caught before anything is sent, with the reason
  under the field (`aria-invalid`, focused). Continue opens "Before you turn
  it on", focused, with the ADR's words, "Your Kin server will download this
  calendar about every 30 minutes and can read it while it does.", who will
  see it, and that the link must stay private; **Turn on sync** or
  **Cancel**. The service downloads the calendar once before saving it, so
  a link that doesn't work is refused at once with the calendar server's
  reason in plain words.
- **Limited and Temporary members** see the shared calendars and a line
  that adults can add theirs.
- **The list:** each calendar by its own name and source ("Swim club
  (Google)"), who sees it and who added it ("Everyone in the household ·
  Added by you"), and "Updated 12 minutes ago. Next: Swim practice, Mon 2
  Nov." or, in the danger colour, why it couldn't be updated, with when it
  last was (the last good copy keeps showing). **Turn off** (its owner or a
  household admin) asks first, saying for whom the events disappear.
- **In the calendar:** occurrences come through `web/calendar/external.js`
  with a "From Google" label and no editing; the Calendar's views (#660)
  draw them in their own style beside the household's events.
- Results are announced in a polite status line; 48 px targets; no
  sideways scrolling at 320 px; forced colours keep the borders.

## Test with real people

Prefer paired household testing.

Useful tasks:

1. Open Kin and explain what matters today.
2. Add something while pretending to walk out the door.
3. Claim something unassigned.
4. Complete something.
5. Leave a handoff.
6. Acknowledge it on another device.
7. Explain current sync state.
8. Recover after going offline.
9. Explain the difference between passkey, trusted device, and current session in their own words.
10. Find backup/recovery without guidance.

## Important questions

- Did either person feel monitored?
- Did either person feel scored?
- Was any security step surprising?
- Did "trusted device" make sense?
- Did users know what was safe during failure?
- Could they add something in seconds?
- Did they understand Handoff versus Talk?
- Did the navigation feel household-oriented rather than app-oriented?

---

# 20. UI review checklist

For any significant UI PR:

### Daily use

- [ ] Ten-second loop remains intact.
- [ ] Capture does not require categorization.
- [ ] No unnecessary confirmation step.
- [ ] Primary action is obvious.

### Accessibility

- [ ] Keyboard works.
- [ ] Visible focus.
- [ ] Focus remains logical after rerender.
- [ ] Screen-reader status tested.
- [ ] 320px works.
- [ ] 200% zoom works.
- [ ] Forced colors works.
- [ ] Dark mode works.
- [ ] Reduced motion respected.
- [ ] Touch targets are at least 44px.

### State

- [ ] Empty.
- [ ] Loading.
- [ ] Offline.
- [ ] Pending sync.
- [ ] Error.
- [ ] Revoked device where relevant.
- [ ] Recovery state where relevant.
- [ ] Destructive state where relevant.

### Household safety

- [ ] No scoring.
- [ ] No surveillance.
- [ ] No passive read receipts (chat's visible, switchable receipts follow [ADR 0008](decisions/0008-household-chat.md)).
- [ ] No judgmental copy.
- [ ] Attribution is factual.

### Privacy

- [ ] Claims are specific and true.
- [ ] No new tracker or analytics dependency.
- [ ] No unnecessary third-party request.
- [ ] Sensitive architecture terminology stays out of ordinary UI.

### Architecture

- [ ] Uses existing Rust/WASM/domain contracts.
- [ ] Does not duplicate canonical state in UI-only logic.
- [ ] Native platform capabilities considered before dependencies.

---

# 21. Final design principle

Kin should progressively become more capable without progressively becoming more complicated to use.

The product should feel like:

> **a quiet shared place that remembers what the household needs**

not:

> **software for managing the people you live with.**

That distinction is the design boundary.

# 22. v0.15.x Household Areas implementation notes

Areas answer “Where or what part of household life does this belong?” They are
optional context for supported household content. Use household language such
as “Areas help keep household things together.” Do not present Areas as
projects, folders, permissions, workspaces, or a required taxonomy.

Quick capture remains title/text → add. Area choice is never part of the
capture form. Area management is reached from More and offers a short create
form plus direct rename/archive actions. Existing assignment context stays
visible when its Area is archived; archived Areas are not offered for new
assignments. “No area” remains an ordinary choice, and an assignment can be
cleared without changing the Item.

The initial contextual assignment control appears beneath Item text as a
secondary native select. Keep it labeled “Area for [item text]”, keyboard
operable, at least 48px tall, and reflowing at 320px and 200% zoom. Names are
plain text. Conflicting offline duplicate names remain separate stable Areas
and receive a short ID suffix in selection/management labels until renamed.

# 23. Chat unread marker and badges (#133)

- Where the member left off is a private read position, kept apart from read
  receipts: it works with receipts off and is shown to no one.
- Opening Chat scrolls to a "New messages" divider above the first unread
  message, with "Jump to latest" to skip to the end. The divider stays while
  the member reads and is placed again the next time they return.
- **Updates → Chat** shows the unread count (`99+` past 99) with the
  accessible name "N unread". Reading on one device clears it on the member's
  other devices once they sync. When any unread message mentions the member
  (or everyone), the count starts with "@" and the name becomes "N unread,
  includes mentions of you".
- **Mentions (#130).** Typing "@" in the message box opens a list (a
  combobox: Up/Down, Enter or Tab, Escape; tap to choose) of the members who
  can read chat, plus @everyone. The text stays plain "@Name"; the sent event
  records who was meant. Mentions show in bold underline, a message that
  mentions you has a mark on its row, and search can show only messages that
  mention you. Limitation: a mention is highlighted by its current label, so
  a member renamed later no longer matches the old "@Name" text, which then
  shows as plain text. Push notifications stay generic ([ADR 0008](decisions/0008-household-chat.md)).
- The installed app's icon shows this count only if the member turns on
  "Count on the app icon" (§40, #476); it is off by default.
- **Decision: the home-screen badge clears when Kin locks.** The badge is only
  a number, but a number on a locked app still tells anyone who sees the
  screen that the household is active. Locking stops the chat room, which
  clears the count and the badge; unlocking brings both back from the saved
  position. Messages that arrive while locked are counted at the next unlock.
  Since #476, closing Kin (rather than locking it) leaves the last count on
  the icon for a member who turned the count on; see §40.

# 24. Pinned chat messages (#131)

- **Pin** and **Unpin** are in a message's actions for anyone who can post.
  Up to 10 messages are pinned per household; pinning an 11th says "You can
  pin up to 10 messages. Unpin one first." and sends nothing.
- A **Pinned messages** region sits above the conversation when anything is
  pinned. Its bar is one button showing the latest pin; pressing it opens the
  list of all pins (newest first), each with who pinned it, a button that
  goes to the message (loading the stretch around it if needed) and **Unpin**.
  Escape closes the list. The bar and list are plain buttons in the tab
  order.
- Deleting a pinned message for everyone (or an admin removing it) takes it
  off the list. "Delete for me" only hides it from this member's list.

# 25. Online now (#128)

- A green dot and "Online now" mark members who have Kin unlocked and visible
  on any device: a line at the top of Chat ("Online now: Sam, Alex") and a dot
  after an author's name on their messages (with "online now" for screen
  readers). The line is plain text, not announced on every change.
- Nothing says when someone was last here, and nothing is kept: a member is
  online for at most 70 seconds after their last heartbeat, a hidden or locked
  device says "away" at once where it can (not when the page is closed or Kin
  locks: the keys go first, so the others see it run out within 70 seconds),
  and a reload starts empty.
- **Settings → Chat → Show when I'm online** (on by default) syncs to all of
  a member's devices. Turning it off stops sending and also hides everyone
  else's status, and the copy says so. Members with no chat access neither
  send nor see it; read-only members can do both.

# 26. Turn a message into a task, handoff or note (#132)

- A message's ⋯ menu offers **Add to Shopping**, **Add to To do**, **Make a
  handoff** and **Save as a note** to any member who can read the chat
  (read-only members too: the records are the household's, not the chat's).
  Each opens one dialog with the message's text, editable. Items and handoffs
  take it as one line; a note takes the message's first line as its title and
  all of it as the body.
- The dialog says everyone in the household will see the result, including
  members who can't read the chat when there are any, and that it is a copy.
- A photo or file on the message is offered as an unchecked box per file
  (items and notes only; handoffs take text). Chosen files are re-encrypted as
  ordinary household attachments of the new record; unchosen files are not
  copied. A file that fails is named after the record is saved.
- Saving goes through the same commands as typing the record in. Nothing about
  the message (its id, author or time) is stored with it, so deleting the
  message or the record never touches the other. The dialog then says
  "Added to Shopping." with **Open it** (items) and a link to the list.

# 27. Quick polls (#135)

- The composer has a **Poll** button for members who can post. It opens a
  dialog with a question, two to ten options (add and remove buttons, each
  option a labelled text field) and a "Allow choosing more than one answer"
  checkbox.
- A poll is a message. Its options are a native `fieldset` of radio buttons
  (or checkboxes for multiple choice) with a legend of the question. Choosing
  votes at once; a member can change or clear their vote while it is open.
- Results are text, not only bars: each option shows its count and who voted
  for it by name, so nothing depends on colour. Your own vote, clearing and closing are announced politely.
- The poll's author has **Close poll**; a closed poll shows "Closed" and its
  final result, and its options are disabled.
- Read-only members see the results and cannot vote. Deleting a poll for
  everyone removes the question, options and votes. Replying to a poll shows its
  question.

# 28. Chat in export and restore (#136)

- Under **Backup and move**, a device that can read chat shows a checkbox,
  **Include chat (messages, photos, files, voice)**, checked by default. Under
  it, a polite status line gives the size before anything is made: how many
  chat events and photos or files, and about how many megabytes. The box is
  absent when there is no chat yet or the device has no chat access.
- Messages deleted for everyone are only deleted placeholders in the export,
  and the line says so; "delete for me" lists are the exporter's own.
- If the archive's size limit leaves older photos and files out, the message
  after the export says how many were left out and that they stay in Kin.
- Restore checks the whole file first. The summary names the chat it holds
  (events, photos, files). After restoring, the message says the chat will
  appear once the device is approved. If only the chat could not be saved, the
  household is still restored and the message says to restore the same export
  again to finish the chat.
- The checkbox is a native control with its label and the size line as its
  description; the progress bar covers household and chat events together.

# 29. Voice messages (#134)

- The composer has a **Voice** button. The first tap asks the browser for the
  microphone; Kin asks for nothing at page load. If it is refused, missing or
  in use, a plain message says which, with a Close button; if the browser
  can't record in a format Kin can send, the message says so.
- Recording shows a running time and **Stop** and **Discard** buttons, and
  stops by itself at five minutes (announced). The microphone is released the
  moment recording stops, is discarded, or the page is hidden or locked.
  Hiding the page keeps what was said for review; locking drops it.
- After stopping, the recording can be played back with the browser's native
  audio controls, then **Send voice message** or **Discard**. A failed send
  keeps the recording.
- In the log a voice message is a group named "Voice message from Sam, 0:42"
  with a Play/Pause button, a waveform that is also a native slider (arrow
  keys move through the message; the slider reads "0:21 of 0:42"), the time,
  and a 1×/1.5×/2× speed button. Nothing is downloaded or decrypted until it
  is played. If it can't be played the message says so beside it.
- There is no transcription and no automatic captioning; the waveform is drawn
  by the engine from the recording on the sender's device. A voice message is
  an ordinary attachment: it is sealed, kept, expires, exports and is deleted
  exactly like any other file.

# 30. Attaching in chat: paste, drop, camera, progress, retry (#115, #116)

- **Paste.** Pasting a picture or file into the message box adds it to the
  files to send. When files can't be added (read-only, editing, recording,
  sending) the message box says so. A dropped folder is refused by name as
  empty. Pasted text, including text that also carries a picture (as a
  spreadsheet does), pastes as text.
- **Drop.** On a desktop, dragging files over the chat outlines the composer
  and dropping adds them. When the member can't post, is editing or
  recording, or is already sending, no outline shows and the drop is
  refused with a message (the browser never opens the file in the tab).
- **Camera.** On a phone or tablet (a touch screen as the main pointer) a
  **Camera** button beside Attach opens the device's camera for one photo. It
  is not shown on a desktop.
- **Every addition is announced** ("2 files added.") and limited like the
  Attach button: up to ten files, 25 MB each.
- **Progress and Cancel.** While Send prepares the files, each listed file
  shows a native progress bar named "Preparing <name>", and **Cancel sending**
  stops it. Cancelling leaves the files and the caption where they were and
  says so.
- **Retry.** If sending fails, the caption and files stay, the message says
  so, and a **Retry** button beside Send tries again with the same draft.
  Removing the last file hides it.


# 31. Approachable first use and clearer feedback (#261)

These slices of #261 were built from the epic's written direction **before**
the usability sessions it calls for (#262). They are hypotheses to test, not
validated results; #262 and #269 stay open until real household members have
tried them.

- **Welcome and capture question (#263, #265).** The "Welcome home" card and
  the "What would you like to remember?" question come from the
  `kin-ui-overhaul` track (#276, #273).
- **Where it goes (#265).** A line under the Today field says where the item
  goes before Add, such as "Adds to Shopping, planned for today." It is read
  with the field.
- **Truthful save feedback (#267).** With sync on, a capture says "Saved here.
  Waiting to sync." and keeps saying so. It changes to "Saved and sent to your
  household." only after a sync cycle ends with nothing unaccepted left in this
  device's outbox, and the status region announces it once. It never says
  anyone has received or read it. Without sync it says "Saved on this device."
- **Plain destinations (#266).** Lists, Routines, Updates and Household each
  have one plain sentence under their heading; Updates drops Chat from it when
  the household's chat policy leaves a member without Chat. Names, order and
  routes of the five destinations are unchanged.
- **Joining (#264).** While waiting for approval, the joining device says who
  checks the key and approves next. Opening a code link without choosing a path
  first explains what happens and that a code never creates a new household.
- **Named, truthful action feedback (#267).** Completing, reopening or
  archiving says which item changed ("Marked “Milk” done.", long names
  shortened) and, with sync, "Waiting to sync." or "It will sync when you're
  connected." Once the relay has accepted everything waiting, the status says
  "Sent to your household." once. A lock replaces the line, so no item name
  survives it. The empty Shopping list says how to add to it.
- **Consistent identity forms (#268).** Path statements, next steps and the
  name and nickname forms share spacing, 48 px targets and theme tokens; long
  names and device labels wrap rather than widening a 320 px screen.

# 32. Chat on a phone: fits the screen, one-row composer, message actions (#310, #311)

- **Fits the screen.** On the Chat page the message list is the only thing
  that scrolls. `web/chat/chat-layout.js` sizes the chat to the visible area
  below its top (the visual viewport, so the on-screen keyboard counts),
  above the phone's bottom bar and leaving room for anything below it. Chat
  opens at the newest message (or the first unread); **Jump to latest**
  shows once you scroll up more than half a screen. Below 720px the page
  title and description collapse; while you type on a touch screen the bottom
  bar steps aside. On a short screen (a phone held sideways, a short window)
  the header, page title and Updates tabs step aside on the Chat page (the
  title stays for screen readers). Toasts sit above the composer.
- **One-row composer (#311).** [+] [message] [emoji] [Send]. **+** holds
  photo, file, camera and poll; Escape closes it and returns to +. While the
  box is empty, Send gives way to **Voice**. The box grows to at most
  min(7.5 lines, 30% of the screen).
- **Message actions (#311).** Every message has one sheet of actions: quick
  reactions first, then Copy, Reply, the records it can become, Pin, Edit,
  Delete, and Delete for me, as permitted.
  - On a touch screen: no action column; messages take up to 85% of the
    width, with a 44px **⋯** in the time line (or at the end of a grouped
    message). A long press (500 ms) or ⋯ opens a bottom sheet, at most 480px
    wide on a tablet. A swipe down, the backdrop or Escape closes it, and
    focus returns to the message's ⋯. Copy replaces native text selection.
  - With a mouse (720px and wider): ⋯ and 🙂 show on hover and keyboard
    focus. ⋯ or a right-click opens the sheet by the ⋯, flipping above it
    near the bottom of the screen so it never clips.
  - It is a modal dialog: focus moves to the first action and stays in the
    sheet until it closes.

# 33. Talk later and two Updates tabs (#312, #313, ADR 0014)

- **Talk later.** A message's actions include **Talk later**; the message
  then shows "🗨 To talk about" in the conversation and goes on Chat's **To
  talk about** list. From there or the message's actions it can be marked
  **talked about** (still listed, "✓ Talked about") or talked about again,
  and the list can **Remove** it. Choosing a topic goes to its message.
  Read-only members see the list but can't change it; Simple view has none.
- **The list.** Open topics first, each with its message's author and first
  line and who marked it. The older Talk topics (household events 8–11) sit
  below in the same panel, with Add a topic, Resolve, Reopen and Archive as
  before. At 1180px and wider the list is a side column (390px); elsewhere
  the chat toolbar's **To talk about** button opens it, with the open count
  in words ("To talk about · 2 open"); Escape closes it.
- **Without chat access** the older topics have their own **To talk about**
  section under Handoffs; chat topics never appear there.
- **Updates** has two tabs, Handoffs and Chat. `#talk`, `#handoff/talk` and
  `#updates/talk` open Chat with the list (or the Handoffs section without
  chat access); Simple view sends them to Today.

# 34. Sharing into Kin and home-screen shortcuts (#389)

- **Share into Kin.** The installed app is a share target: in another app's
  share sheet, choose Kin. After unlock, **Add to Kin** shows what was shared
  (its first line, link and file names) and offers **Add to To do**, **Add to
  Shopping**, **Save as a note**, **Make a handoff** and, when chat is open to
  you, **Send in Chat**. Each opens the same dialog used to turn a chat message
  into a record (prefilled and editable; photos and PDFs offered as
  attachments), or puts the text and files in Chat's composer. Nothing is
  saved until you confirm; Cancel says "Nothing was added."
- **Privacy.** The service worker answers the share itself, so the shared
  content never reaches the server; it waits in the worker's memory under a
  random id until the page takes it, once (five minutes at most), and in the
  page's memory until unlock. Nothing is written to storage or the cache. A
  share that reaches the server (no service worker yet) is discarded unread
  and the app simply opens. Simple view doesn't take shares.
- **Shortcuts** (#472). A long press on the home-screen icon (right-click on
  a desktop dock or taskbar) offers **Add to shopping**, **Add a task**,
  **This week**, **Shopping**, **Chat** and **Today**, each with its own icon
  (a bag with a plus, a ticked box, a calendar, a bag, a speech bubble, a
  sun). Launchers show as many as they have room for, in that order.
  - **Add to shopping** and **Add a task** open Shopping or To do with Quick
    add open on that list ("Adds to Shopping." / "Adds to To do.") and focus
    in the title field: type, Enter, done. The action is taken out of the
    address as Kin starts (`#kin-action=…`, which never reaches the server),
    so Back or a refresh doesn't repeat it; an unknown or stale action does
    nothing.
  - **This week**, **Shopping**, **Chat** and **Today** are ordinary pages
    (`#week`, `#lists/shopping`, `#updates/chat`, `#today`).
  - **The lock always comes first.** A shortcut never skips unlocking: a
    locked Kin shows the unlock screen, holds the shortcut in memory, and
    lands on it after unlock, focus in the title field for the Add
    shortcuts and at the start of the page for the others. A shortcut used
    while Kin is already open and unlocked lands at once.
  - **Simple view** has no Quick add, so an Add shortcut opens Today (focus
    on its heading) and says "Adding things isn't available in Simple view,
    so Kin opened Today."; page shortcuts open Today, or Chat where it's
    open to the member. A **Temporary member** lands where the shortcut
    says, not on For you; the Today shortcut still takes them to For you.
- Support: Android and desktop Chrome/Edge support share targets and
  shortcuts for installed apps; Safari on iOS doesn't offer installed web apps
  in the share sheet yet, and iPhone home-screen apps have no shortcuts, so
  the long press shows nothing extra there. The icons are PNGs (Android
  ignores SVG-only shortcut icons) and are cached with the app, so shortcuts
  open offline too.

# 35. Shopping mode (#403)

- **Start shopping** on Lists › Shopping opens the list for use in the shop:
  full screen, one large native checkbox per item (rows at least 56px, text
  19px), what's left in words ("3 things to buy"), and **Done shopping**.
- Ticking an item completes it with the ordinary command (the toast offers
  Undo) and moves it to **In the basket**; unticking it there reopens it.
  Everything works offline and syncs later.
- **Keep the screen on while shopping** (on where the browser supports the
  Screen Wake Lock API; remembered per device) stops the phone sleeping
  between aisles. The lock is released on Done, Escape, lock, or when the
  page is hidden, and asked for again when it comes back.
- **Store sections** (#411, [ADR 0015](decisions/0015-store-sections.md)):
  **Sections** in shopping mode opens a small editor to name the parts of
  the shop and put them in the order you walk it (move up/down, remove, add;
  duplicate names are refused). Each item then has a **Section** control on
  its row, and the list groups by section in that order with **Other** last.
  A Staple's section goes with it when it is replenished. With no sections,
  the list looks as before.

# 36. Bring a list into Kin (#452)

- **Paste a list.** Pasting two or more lines into a capture field (Today,
  To do, Shopping) opens **Bring a list into Kin** instead of squashing the
  lines into one item. Bullets, numbers and checkboxes are removed; a ticked
  box (`[x]`, ☑, ✓) comes in as done.
- **Import a file.** Lists › List actions › **Import a list…** takes pasted
  text or a CSV/text file exported from another app or a spreadsheet. A CSV's
  columns are guessed from common headers (Title, List, Due date, Completed)
  and can be changed. A list column mentioning shopping or groceries goes to
  Shopping; dates are read only in unambiguous year-first forms (2026-11-02).
- **Preview.** Every row has a checkbox. Repeats within the import and items
  already open in Kin start unticked and say why. The summary says how many
  will be added; **Add N items** saves exactly the ticked rows.
- **Saving.** Each row is an ordinary capture (add, planned date, complete)
  with an id fixed when the import starts: a failure partway says how many
  were added and Try again (or Add again) resumes without duplicates. At most
  200 rows per import; files are read on the device and never uploaded.

# 37. This week (#416)

- **Where.** Today's heading links to **This week** (`#week`), a page of its
  own that keeps Today marked in the navigation; no sixth destination.
- **What.** Seven days from today, each a headed section ("Today",
  "Tomorrow", then the weekday and date): items planned for that day,
  routine occurrences (shown on the day each occurrence opens), the planned
  dinner and maintenance due. Overdue items stay on Today. Rust supplies the
  days and what falls on them (`kin_week`, [ABI](ABI.md)); the page only
  names them. Days with nothing say "Nothing planned."
- **Actions.** Items complete and reopen with a checkbox (Undo applies),
  **Move to…** another day of the week or "No date", and **Details** opens
  the item. Routines complete for the current period only; later occurrences
  show without a checkbox. Household modes other than Normal pause routines
  for the whole week, as on Today.

# 38. For the sitter (#441, [ADR 0017](decisions/0017-sitter-page.md))

- **Where.** Household → **For the sitter** (`#household/sitter`) is where an
  Adult builds the page; **For you** (`#foryou`) is the page itself, a page of
  its own that keeps Today marked in the navigation. A Temporary member lands
  on For you once per unlock (not in Simple view); everyone else reaches it
  from the editor's "See it as the sitter does".
- **The editor.** A short welcome (up to 500 characters), then "On the page":
  the chosen notes, reference records and routines in order, each with ↑, ↓
  and Remove (named for screen readers, focus kept on the moved control).
  Below, a checkbox per existing note, reference record and routine, grouped
  by kind; at most 30 things. "Save the sitter page" saves the whole page.
  Only Adults (and a household that doesn't sync) can change it; others see
  "Only Adults can change the sitter page."
- **The page.** The welcome, then a card per entry, live: a note's title and
  text, a reference record's fields (a value that looks like a phone number
  is a tap-to-call link, "Call Mum: +44 …", at least 44 px tall), a routine's
  cadence and whether it's done for now. Archived records drop out. An Adult
  previewing it sees a note that it is a layout, not a lock: while a
  Temporary member's access lasts, their device can read the household.
- **Empty.** "The family hasn't added anything here yet."

# 39. Taking turns on routines (#428, [ADR 0016](decisions/0016-routine-rotations.md))

- **Start.** Each routine under Routines has **Take turns…** when the
  household has two or more people. It opens a list of the household's
  members: tick them in the order they take turns (2–12); "Turn order" shows
  the order, each with ↑ to move earlier. **Start taking turns** saves; the
  first person takes the next turn.
- **Whose turn.** A rotating routine shows "Your turn · Sam next" (or
  "Sam's turn · You next") and "Taking turns: You → Sam → Jo" in place of the
  owner buttons: whoever's turn it is owns the routine, so This week, Simple
  view and "my things" follow it. Today's routine rows add "Your turn" or
  "Sam's turn" to their line.
- **Passing on.** The turn passes when the routine is done for its period
  (the owner's decision, "when it's done"), not by the calendar; Undo gives
  it back. **Skip to next** gives it to the next person; **Give this turn
  to…** (with three or more) to anyone listed. **Change who takes turns**
  reopens the list starting from whose turn it is; **Stop taking turns**
  leaves the last person as the ordinary owner.
- **People leaving.** Someone removed, or whose access ended, is passed
  over; if it was their turn, the next person's turn is recorded so every
  device agrees. With fewer than two people left, the routine says taking
  turns is paused.
- **No scores.** Kin never counts turns per person or shows who did more.

# 40. Count on the app icon (#476)

- **Where.** Household → People & devices, right under "Notifications on
  this device": **Count on the app icon**, a choice for this device only
  (kept in this browser's local storage as `kin.app-badge`, like the
  auto-lock time). **Off** (the default), **Unread messages**, or **Unread
  messages and my things today**. Choosing says what the icon now shows in a
  status line. The section isn't shown where the browser has no Badging API
  (for example Firefox, or Safari outside a home-screen app).
- **The number.** Unread messages are Chat's own unread count (§23). "My
  things today" adds the items planned for today and the routines due today
  ("every day", "every weekday", still open) that the member is responsible
  for, including a routine whose turn is theirs; unassigned things and
  other people's don't count, and routines don't count while the household
  is paused. The count is worked out on the device from decrypted state and
  updates on every change: sync, reading, completing, adding.
- **Never content.** Only a number, never what the messages or things are.
  The hint says so, and that anyone who can see the screen can see it.
- **Lock and sign-out clear it.** Locking (the Lock button, auto-lock,
  another tab locking) and signing out clear the icon. Closing Kin leaves
  the last count on the icon: that is what the member asked for. Nothing
  updates it while Kin is closed or locked (no background decryption), so it
  can be out of date until Kin is next unlocked. Turning the setting Off
  clears the icon at once.
- **Not a nag.** Off by default, no prompt to turn it on, and no counting
  of anyone else's things (PRODUCT-BOUNDARIES).

# 41. Easy mode and Help on every screen (#616, #620)

For someone who rarely uses apps: bigger, clearer and calmer, with a short
explanation on every screen ([ADR 0021](decisions/0021-kin-for-everyone.md)
section 1; accessibility details in
[ACCESSIBILITY](ACCESSIBILITY.md#easy-mode-and-help-on-every-screen-616-620-adr-0021)).

## Easy mode (#617)

- **Where.** Household → Identity & appearance → Text, motion and reminders
  starts with **Easy mode: bigger text and buttons, fewer things on screen**
  ("Every button gets a word, and after each change a line at the bottom
  lets you undo it. Places you haven't used for two weeks are tucked away;
  the Household page still lists everything."). Choosing says "Easy mode is
  on." It is not a lock: the person turns it off the same way.
- **Offered once.** In this browser's first week, Today shows one calm card,
  after the day's list: "Would bigger text help?" with **Turn on easy mode**
  and **No thanks**. Either puts it away for good (§ First-week tips below).
- **Follows the member.** It is setting 8 `easy-mode` (on, off) of the
  synced settings (§8.14): on every device of a member with private storage,
  last change wins, and "Use different settings on this device" keeps a
  shared tablet its own. Without private storage it stays on the device.
  Like text size it is kept on the device unencrypted (`kin.easy-mode`), so
  the lock screen opens the same way. A family member who sets Kin up for
  someone (#612, § 42) turns it on for them from the invitation.
- **What changes.** The whole page scales by 125% (with Large 137.5%,
  Larger 150%): base text 20 px, buttons, tabs and navigation links at
  least 56 px, more space between things. The tick on a row says
  **Complete** (or **Reopen**); on phones Search and Lock show their words
  and the header scrolls away instead of staying on top; the Undo line is
  larger and its close button says **Dismiss**; the focus ring is thicker
  and darker. Rows keep **Complete** and **Details**; **Add photo** moves to
  Details. Everyday actions (add, complete, undo) are never in a menu, and
  nothing needs a swipe or a long press.
- **Confirmation with Undo.** After each change the existing undo line
  (§ undo) says what happened, with **Undo**, until the next action or until
  dismissed; it never times out.
- **Fewer places.** The navigation keeps Today, Lists, Updates and
  Household; Lists keeps To do and Shopping; Updates keeps Handoffs and
  Chat; Household keeps its overview. Anything else the person opened in
  the last two weeks stays, and so does the page on screen. Nothing is
  removed: the Household overview links every Household page and, in easy
  mode, Routines; Search finds everything. Only route names are remembered
  for this (`kin.easy-recent`, on the device). Household features an admin
  switches off (ADR 0021 section 2) stay out, as in the regular layout.
- **Simple view wins.** When an admin has turned Simple view on for a
  member, easy mode doesn't apply; the setting comes back if Simple view
  goes.
- **Plain words (#618).** The page lines and the Household overview use
  plain words ("Things to do, your shopping list, and staples: things you
  buy again and again."; "Locking Kin, ways to sign in, and keeping a safe
  copy of everything."). Kin's own words — sync, archive, passkey, backup
  key, household, admin, handoff, routine, staple and others — each have
  one plain sentence in the glossary (`web/help/glossary.js`); Help lists
  the ones its screen uses under **Words on this page**: its fixed words
  and, since #639, the words the page shows at that moment (outside the
  household's own records). A unit test fails if a screen's fixed words use
  a listed term that its Help doesn't explain, or if the tips or the setting
  use one at all; the easy-mode sweep (§ 42) checks every page as shown.
- **Every control is big enough.** In easy mode every button, menu, field
  and disclosure is at least the tap size (60 px after the zoom), whatever a
  component sets in the regular layout.

## Help on every screen (#621, #622)

- **Where.** A **Help** button (a question mark and the word) beside every
  page's heading — Simple view's pages too — and in Quick add, item details
  and Shopping mode. It looks the same in the regular layout and in easy
  mode.
- **The panel.** "Help: To do", then what the screen is for in a sentence or
  two, **What you can do** (two or three steps), **Who sees it** ("Everyone
  in your household."; "Only you. Nobody else in your household can see
  it."), **Words on this page**, and **Still stuck?**, then **Close**. The
  topic follows the page and tab on screen; each route and tab in
  `web/routes.js` has one (a unit test checks), and so do the three
  dialogs.
- **Show me** beside a step, when its control is on screen, closes Help and
  points at the control: it scrolls there, opens a closed section around it,
  outlines it for a few seconds and puts the focus on it.
- **Still stuck?** **Message a household admin** opens Chat with an admin's
  name ready ("@Sam ") when Chat is on, or Handoffs with the note field
  ready where Chat is off, and says what to do next. **Report a problem**
  asks for the report dialog (#630) with `kin:report-problem`; it shows when
  that dialog is there (or, without it, when a listener answers a probe
  that has `detail.probe: true` with `preventDefault()`). In Simple view without Chat
  there is no admin button, because Simple view has no Handoffs.

## First-week tips (#617, #622)

During the first seven days after this browser first opened Kin unlocked,
Today shows at most one tip, after the day's list: first the easy mode
offer (unless easy mode is already on), then "Help is on every page — Not
sure what something does? Press Help at the top of any page for a short
explanation." with **Show me** (it points at the Help button) and **Got
it**. A tip that was dismissed or used never comes back, and only one is
dealt with per unlock, so they never queue up. None in Simple view. Kept on
the device: when Kin was first opened (`kin.first-seen`) and the tips done
(`kin.tips-done`), nothing about the household.

# 42. Set up Kin for someone (#612–#615)

A family member gets Kin ready for someone who rarely uses apps — a
grandmother, say — so all she does is open it and choose a password
([ADR 0021](decisions/0021-kin-for-everyone.md) §4; security in
[PAIRING](PAIRING.md#set-up-kin-for-someone-612615) and
[THREAT-MODEL](THREAT-MODEL.md#prepared-invitations-a-printed-sheet-is-an-invitation-613-adr-0021-4)).

## The helper's side (#613, #614)

- **Where.** Household → People & devices, for household admins: **Set up
  Kin for someone** ("prepare it with their name and easy mode, and print a
  sheet that shows them how to open it. They only choose a password.").
- **The form.** **Their name** ("Kin greets them by it, and your household
  sees it."); **Who they are**: A grown-up in the household, A child or
  teenager, A babysitter, carer or guest, for a while (then **Their access
  ends**); **Start in easy mode** (ticked); **Your name** (filled in: "Shown
  to them as the person to call if they get stuck."); **A note for them
  (optional)**; **The invitation works for** 1 day, 3 days or 7 days ("Long
  enough to post the sheet. It works once."); **Make the invitation**.
  Problems are said on their field in plain words.
- **Ready.** "Rose's invitation is ready — Give Rose the setup sheet, or send
  the link. It works once, until Tuesday 28 October." with the QR code, the
  code, **Print the setup sheet**, **Share the link** and **Cancel this
  invitation**.
- **The sheet** ("How to open Kin", one page, large type): "For Rose, from
  Mikey", a large QR code, three numbered steps — (1) open the camera, point
  it at the square code and tap the link; (2) Kin says hello and asks for a
  password: write it down and keep it safe; (3) wait for Mikey to say yes,
  then Kin opens — the link for someone without a camera, the address and
  code to type, Mikey's note, **If you get stuck, call Mikey.** and "This
  sheet works once, until …. Keep it private: anyone with it can ask to
  join." **Print** prints only the sheet (print stylesheet); **Back**
  returns to the invitation.
- **Later.** People & devices lists **Invitations you set up** ("For Rose,
  until …" → **Open**; "Rose is asking to join" → **Check and say yes**).
  Kin doesn't keep the code, so once Kin has closed or locked the sheet
  can't be printed again: cancel and set it up again.
- **Saying yes.** "Rose is joining — Safari on iPhone is waiting for you to
  say yes." "If you're with Rose, look at both screens: their screen shows a
  code. Say yes only if it matches this one." (or call and ask her to read
  it). Tick **The codes match on both screens**, then **Yes, let Rose in**
  with your passkey or password. Then: "Rose is in — One last step on
  Rose's screen: it asks whether its code matches this one. Show them, or
  read it to them." with your code, and **Done**.

## Her side (#615)

1. **Hello.** Opening the link or scanning the QR code shows one screen,
   already in easy mode: "**Hi Rose — your family set this up for you**",
   "Mikey made Kin ready for you. Kin is where your family keeps lists,
   plans and messages. All you need to do is choose a password.", Mikey's
   note, **Continue**, and "If you get stuck, call Mikey."
2. **Password.** "Choose a password": her username, chosen from her name
   (`rose.4821`, which she can change), and a password with **Show
   password** (a toggle), "Use at least 10 characters. A few unrelated words
   works well. Write it down and keep it somewhere safe.", the strength floor
   (#557) and the one-line trade-off, **Continue** and **Back**.
3. **Waiting.** "Almost there, Rose — Waiting for Mikey to say yes." with
   her device's code: "Mikey will check that the code below matches the one
   on their screen. If you're not together, they may call and ask you to
   read it." "You can leave this screen open. Kin goes on by itself once
   they say yes."
4. **Do these match?** "Mikey said yes — Last step: does this code match
   the one on Mikey's screen?" with Mikey's code, **Yes, they match — open
   Kin** and **No, they're different** ("Don't go on. Call Mikey and tell
   them the codes are different.").
5. **Today** in easy mode, with Help beside the heading; her name is set and
   easy mode is in her synced settings.

Every screen, and the card shown if sending the request fails, ends with
"If you get stuck, call Mikey." A code typed by hand (without the link)
opens the usual join screen, which asks for her name; easy mode still turns
on.

## The easy-mode sweep (#639)

A browser regression (`scripts/easy-sweep-regression.mjs`) walks every page
and tab in easy mode at 320 px and on a desktop, with Fridge, Meals and
Journal switched off, and fails on: a page without Help, a control under
56 px, a glossary word on screen that Help doesn't explain, a switched-off
feature still shown or linked, or sideways scrolling.

# 43. Family photos (#673, [ADR 0022](decisions/0022-family-hub.md) §5)

- **Where.** Household → **Family photos** (`#household/photos`), also on the
  Household overview ("Photos for the whole family, and a slideshow.") and,
  in easy mode, always in the Household tabs. The feature switch "Family
  photos" (bit 16) hides it, the share-sheet destination and the chat action.
- **The page.** "Family photos", a line saying who sees them and that they
  are encrypted, "N photos (up to 500)", then **Add photos** and
  **Slideshow**, then a grid of square thumbnails, newest first, each a
  button named "Open “caption”, added by Sam" with the caption under it.
  Empty: "No family photos yet. Add some from this phone or computer, share
  photos into Kin from another app, or add one from Chat."
- **Adding.** Add photos opens the system picker (several at once; a
  temporary input, removed after). A dialog lists each chosen photo with a
  small preview and "Caption (optional)" (up to 200 characters), then
  **Add N photos**. It says "Adding photo 2 of 5…" while it works. Photos
  are made screen-sized (at most 2048 px, about 600 KB) before they are
  encrypted. Full at 500: Add photos is disabled and says why.
- **From elsewhere.** A photo shared into Kin offers **Add to family photos**
  on the share sheet; a photo in Chat has **Add to the family photos** in its
  actions. Both open Family photos with the same dialog.
- **The viewer.** Pressing a photo opens it large with its caption as the
  title, "Added by Sam · 21 October 2026", **Previous**, **Next** (also the
  arrow keys) and, for whoever added it or a household admin, **Remove**.
  Removing closes the viewer, focus goes to the photo now in its place, and
  the undo line offers **Undo** ("Photo removed."); Undo brings the photo
  back (within an hour, while its image is still kept).
- **Slideshow.** Fills the screen with `<kin-photo-frame>`: each photo for 8
  seconds with its caption and "Added by Sam" over a dark gradient,
  crossfading over 1.2 s; with reduced motion the photo changes in place.
  **Pause**/**Play** and **Close** stay on screen; any other tap or key
  closes it, and focus returns to Slideshow. It pauses while the page is
  hidden. The kitchen display (#651) will host the same element as its
  screensaver.

## The chore chart (#676, #677, #678)

[ADR 0022](decisions/0022-family-hub.md) §6 and the owner's decision on #654:
children may have points, totals and see each other's progress; adults are
not on the chart unless a household admin allows it and they join
themselves. Nothing new to maintain: the chart is built from routines,
taking turns and items with a responsibility.

- **Where.** "Chore chart" beside "This week" at the top of Today
  (`#chores`, which keeps Today marked; no new destination). In Simple view a
  child's Today has a big **My chore chart** link and the chart has **Back
  to Today**. Household › Features has a **Chore chart** switch (bit 15); off,
  the link, the page, the points on Routines and the admin setting go.
- **A card per person** (`<kin-chore-chart>`, a self-contained element the
  kitchen display will reuse with `size="display"`): a header in the
  person's colour (the one they chose, event kind 74, else the default by
  join order, from a 12-colour palette each with white text at 4.5:1) with
  their name — colour is never the only signal — their points this week
  ("3 points this week") or reward progress ("12 of 20 for Movie night",
  with a progress bar, then "Movie night reached!"). Then **Today**: each
  job with a big native tick box (44 px, 56 px in easy mode, 64 px on the
  display), the item's picture (its emoji or first photo), its name and its
  points; "All done for today!" when everything is ticked. **The rest of the
  week** is a disclosure, by day, "✓ Done" or "Not done", read-only.
- **Ticking** uses the ordinary complete and reopen commands, so Undo,
  rotations and sync behave as everywhere else. Points go to the chore's
  owner — whose turn it was, or the item's responsibility — never to whoever
  ticked it, so a parent can tick off a child's chore. Unticking takes the
  points back. Points start again every Monday; there is no history beyond
  this week.
- **Parents set it up.** Each routine on Routines has **Chore chart points**
  (0–10, 1 by default) for Adults. On each child's card an Adult has **Set a
  reward** / **Change reward**: points to reach this week and a short reward
  ("Movie night"), and **Remove reward**.
- **Adults.** A household admin turns on **Adults can join the chore chart**
  under Household › Features (fresh passkey or password); everyone else sees
  it read-only. Then each Adult sees **Join the chore chart** on the chart
  ("for fun… you can leave at any time") and, once on it, **Leave the chore
  chart**. No adult-only leaderboard, no streaks, and no reminders or
  notifications about points.
- **Help** on the chart says what it is, how to tick, set a reward and join;
  easy mode makes the tick boxes and names bigger still.
- `scripts/chore-chart-regression.mjs` checks the flow in the browser.

## The kitchen display (#669: #670, #671, #672, #699, #700)

[ADR 0022](decisions/0022-family-hub.md) §4: a **device mode of an Adult's
device**, not a new member kind. A tablet on the kitchen wall that always
shows today, the week, chores, dinner and the shopping list, and that anyone
can tap.

- **Turning it on.** Household › Overview has **Kitchen display** for
  Adults (Limited and Temporary members see that only an adult's device can
  be one): what it shows, what it never shows, that Kin doesn't lock by
  itself while it is a display and that leaving needs the adult's password
  or passkey; **Dim the screen at night** From/Until (21:00–06:30 by
  default; the same time twice means never); **Show family photos after this
  many quiet minutes** (1–30, 5 by default); and **Use this device as a
  kitchen display**. The choice is this device's (local storage, for this
  household's vault only), so it comes back after a lock and unlock. A
  household feature switch, **Kitchen display** (bit 17), hides the section;
  switched off while a device is a display, that device locks.
- **The shell.** Like Simple view's separate shell, the workspace is
  replaced by `<kin-kitchen-display>`: no header, navigation, Quick add,
  Search, palette, shortcuts, item details or shares, and every address
  opens the display. At the top: the time (large), the date (the page's
  heading), an offline line ("Offline. Showing what this display last
  knew."), **Help** and **Leave display mode**.
- **Panels are data** (`web/display/panels.js`: `id`, `component`, `region`,
  `featureId`, `size`, `label`), the seam for future add-ons (#688). Each
  panel stacks in its region; a switched-off feature takes its panel away
  (and Chat or the Fridge without access); an empty region collapses:
  - **week** — the week strip and agenda (`<kin-calendar views="day week"
    compact readonly>`, synced calendars included); a day opens the Day view;
  - **now** — today's events and countdown (`<kin-calendar-today>`),
    today's meals (`<kin-tonight>`, without its link) and the newest four
    chat messages, read-only (`<kin-display-chat>`; it never marks them
    read);
  - **chores** — each child's card in their colour (`<kin-chore-chart
    size="display">`); ticking records it on this device with the points to
    the chore's owner. **Set a reward** / **Change reward** on each child's
    card (#699) is for the Adult whose device it is, touch-first: the goal is
    chosen with 64 px **−** and **+** buttons and one-tap goals (5, 10, 20,
    30, 50), never typed; the reward's name is a big text box (focus stays
    on a button when the editor opens, so the keyboard doesn't cover the
    chart until someone taps the box); **Save reward**, **Remove reward**
    and **Cancel**. It is the chore chart's own path (`kin:chore-reward` →
    kind 78 `CHORE_REWARD_SET`), and once saved the toast offers **Undo**,
    which sets the previous reward back (or removes a new one) and is refused
    if the reward changed since. **Saving or removing a reward, and Undo or
    Redo of one, first asks for the adult's passkey or password** (#705):
    the same dialog and on-device check as leaving (below), titled "Change a
    reward" — "Only the adult this device belongs to can change a child's
    reward. Confirm with …" — with **Don't change it**. It asks at the
    moment of saving, not when the editor opens; a device set up before
    accounts asks for the backup key. A wrong secret is refused calmly and
    the dialog stays; **Don't change it** (or Escape) closes it, writes
    nothing, says "The reward wasn't changed." and puts the focus back on the
    child's reward button; a cancelled Undo stays on the toast. Ticking
    chores, shopping and the fridge never ask. The phone's chart is
    unchanged: no question there. No Join here;
  - **lists** — the shopping list (`<kin-display-shopping>`): one big box to
    add, big rows to tick off;
  - **board** — the fridge (#700): the household's own `<kin-fridge>` with
    its room and access rules (look only hides the tools; no access or the
    Fridge feature off takes the panel away), given `size="display"` and a
    wall-tablet layout: 64 px tools in a rail beside the 3:4 door (above it
    below 720 px), the door as large as the panel allows, magnets at least
    64 px and notes on them in larger type, and the note magnets repeated
    under the door as large yellow slips with who put them up. No full
    screen (the display is already), no hover-only titles, and a magnet's
    menu is nine big place buttons laid out like the door, plus **Take it
    down** and **Done**, instead of a drop-down.
- **Layout.** Landscape (10"+ tablet sideways): the week across the top,
  then today, the chart and the lists in three columns, the fridge below.
  Portrait: the week, then today beside the lists, the chart, the fridge.
  The display takes the whole screen (not the full layout's Today grid or
  content width). Below 720 px everything stacks. Text from 18 px (the time from 40 px, the
  fridge's notes from 26 px) for reading at 2–3 m; every control, Undo's
  included, at least 64 px. Dark mode follows the
  appearance; reduced motion, "more contrast" and forced colours are
  honoured.
- **Screen.** Screen Wake Lock keeps it on, asked for again when the page
  shows. After the quiet minutes the **screensaver** shows: Family photos in
  `<kin-photo-frame>` when the household has photos and the feature on,
  otherwise a calm clock; a touch brings the panels back, and that touch
  lands on the screensaver, never on a panel beneath. In the night hours the
  screen **dims** (a dark cover, "Good night. Touch the screen to wake it.");
  a touch wakes it until the next quiet spell. Offline it keeps showing the
  last known state.
- **Leaving.** **Leave display mode** opens a dialog: "Only the adult this
  device belongs to can leave. Confirm with your passkey or your password"
  (or, on a device set up before accounts, the backup key), with **Use my
  passkey**, **Use my password** and **Stay in display mode**. The secret is
  checked on the device; a wrong one says so and keeps the dialog; the right
  one turns display mode off and Kin reloads into the full layout (still
  unlocked, #351). Its buttons and box are 64 px targets. A child's reward
  asks through the same dialog (#705, above; `display/leave.js` `askAdult`).
- **What it never offers** is unchanged by #699: a child's reward is the only
  setting on the display, the same one an Adult has on the phone's chart,
  and on the display it needs the adult's secret (#705); Household settings,
  admin actions and private storage stay out.
- **Help** on the display says what it is, how to tick, set a reward and
  wake it, and how to leave; "Message an admin" and "Report a problem" aren't offered there.
- `scripts/kitchen-display-regression.mjs` checks the flow in the browser at
  tablet sizes; [KITCHEN-DISPLAY-CHECKLIST](KITCHEN-DISPLAY-CHECKLIST.md) is
  the owner's check on a real wall tablet.

## The home server's control panel (#718: #719, #720)

[ADR 0025](decisions/0025-kin-at-home.md) §10–§11: the person who runs Kin at
home sets it up and checks on it in a browser, never a terminal. It is the
server's own page, `/control/` (`web/control/`), built from Kin's tokens,
buttons and focus rings (`/styles/app.css`) plus `web/control/control.css`;
details in [HOME-SERVER](HOME-SERVER.md#setting-it-up-the-control-panel).

- **Who it is for.** Not household members: the person with the computer,
  and household admins. Members never see it; the app doesn't link to it.
- **Getting in.** On the computer itself, "Enter the setup code" (first run)
  or "Open the control panel": one box for the 10-character code Kin
  printed, which accepts lower case and a missing hyphen, explains in one
  sentence why it is asked ("keeps other programs on this computer out"),
  says how many tries are left after a wrong one, and offers **Print a new
  code**. Through the household's address, a signed-out person is sent to
  sign in, and a member who isn't an admin is told it is for admins.
- **Setup, one step at a time.** A numbered step list (the current step
  marked for screen readers), one heading and one main action per step, and
  focus on the new step's heading when it changes:
  1. **Choose this home server's name.** Two big choices, "A free name" and
     "Our own domain", each with a one-line example. The free name's box
     shows the zone after it, so people type one word. The relay's answer
     appears as they type ("Available.", "Taken: …") in a polite live region.
     It says plainly that the name is chosen once.
  2. **Agree to Let's Encrypt's terms.** What Let's Encrypt is, a link to
     its Subscriber Agreement (opens in a new tab, and says so), one
     checkbox, **Agree and continue**. Kin's own words, not the browser's,
     if the box isn't ticked.
  3. **Add these DNS records** (own domain only). A table of type, name and
     value with a **Copy** button per value, a note about CNAME and ECH, and
     **Check the records**, whose result lists each record as in place or
     what to fix, in plain words.
  4. **Connect.** One button; it says Kin restarts once and the page waits.
  5. **Connecting / Getting the certificate.** Relay, name and certificate,
     each marked done, working or a problem, with the problem explained and
     **Try again now** for a certificate error. The page updates itself
     every two seconds and says "Kin is restarting…" while Kin is away.
  6. **Kin is ready.** The address, and a button to open it there to create
     the household; it says why not here (passkeys and saved data belong to
     that address).
  Every step but the last has **Choose another name**.
- **Status.** One headline ("Everything is working.", "Phones can't reach
  this home server right now.", "The certificate runs out soon.", or a red
  one when a certificate this server didn't make appears), then cards:
  Connection, Name, Certificate, Backups, Storage, Households and devices
  ("Counts only. The control panel never shows what households keep in
  Kin."), Version and updates. Every state and error code is a sentence
  (`web/control/explain.js`), with what to do where there is something to
  do. Backups and updates say they aren't part of this version yet (#721,
  #722 fill those cards). It refreshes every 30 seconds while visible
  without moving the focus.
- **Settings.** For now one: **New households**, how many households this
  server allows (1–10), with why someone would raise it. Saving asks for a
  fresh confirmation: on the computer a code Kin prints ("Confirmation
  code", with Confirm and Cancel), through the household's address the
  admin's passkey or password, in the same dialog as Kin's other admin
  changes. A limit set on the computer (`KIN_MAX_HOUSEHOLDS`) is shown, not
  offered.
- **Accessibility.** One `h1`, a heading per step and card, labels on every
  field, `role="status"` for progress and availability and `role="alert"`
  for errors, `aria-invalid` on a wrong code, 48 px controls, visible focus,
  320 px reflow (the records table scrolls inside its own region), dark
  mode, forced colours and reduced motion. `scripts/control-panel-regression.mjs`
  checks labels, names, targets and reflow on every screen at 320 and
  1024 px.
