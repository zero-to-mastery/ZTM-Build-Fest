# ADR 0021 — Kin for everyone: easy mode, household features, and reports to the team

Status: **Accepted** (#604, epic #603). Owner decisions on 2026-10-21: reports
and feature requests are stored on the Kin service and forwarded to the
project's GitHub issues by the operator's server; only household admins may
suggest features.

## Context

The goal of epic #603 is that someone who rarely uses apps, such as a
grandmother, can be set up, understand Kin and use it every day without
help. Three needs follow:

- **A friendlier interface** than the full workspace, for adults. Simple view
  ([ADR 0013](0013-simple-view.md)) exists for children: an admin turns it on,
  it removes most of Kin, and the child can't turn it off. An older adult
  needs everything they use, just larger, clearer and with fewer choices on
  screen, and should be able to choose it themselves.
- **Household features that admins can switch off**, so a household that
  never uses the fridge or meals sees a simpler app.
- **A way to tell the team** about a problem or an idea from inside Kin,
  with enough detail to act and nothing private unless the person adds it.
  [DEBUGGING](../DEBUGGING.md) already says diagnostics must be previewed,
  consented to and never become analytics.

## Decision

### 1. Easy mode is a per-member presentation setting

- **Easy mode** changes how Kin looks and behaves, not what the person may
  do: base text at least 20 px, targets at least 56 px, a word on every icon,
  one primary action per region, no swipe-only or long-press-only actions,
  everyday actions never hidden in menus, a confirmation line with Undo after
  every action, plain words (a glossary backs Help), and navigation reduced
  to the destinations the household has switched on and the person uses.
- **Who turns it on:** the person, in their settings; or the family member
  who sets Kin up for them (#612), as a preference carried by the prepared
  invitation. It is not a lock: the person can turn it off.
- **Where it lives:** the person's synced settings (private log, settings
  kind 130, [ADR 0019](0019-member-private-log.md)) for members with an
  account, so it follows them; a device setting otherwise. "Use different
  settings on this device" applies, as for text size.
- **Simple view stays separate.** Simple view is an admin's restriction for a
  child; easy mode is a presentation an adult chooses. They can't both be on:
  Simple view wins, because it is the stricter layout.

### 2. Household features are a service setting changed by admins

- **Switchable features:** Chat, Fridge, Meals, Routines, Taking turns,
  This week, Talk later, Store sections, Shopping mode, Maintenance,
  Notes & reference, Sitter page, Journal, Just for me. Today, Lists (To do
  and Shopping), Updates (handoffs) and Household are always on. Each feature
  has a stable small number in a bit set; the list can grow additively.
- **Recorded on the service**, like "Who can chat" and "private storage for
  children and teens": a household column holding the set of switched-off
  features and a revision, changed only by a household admin with a fresh
  passkey (or password re-entry for an admin without one, as
  [ADR 0018](0018-account-key-vault.md) allows). The service, not the
  household history, is the authority, because only it knows who is an
  admin; a history event could be forged by any member's device.
- **Delivered** in `/api/sync/status` and kept on the device, so an offline
  device keeps the last known set. A household with no sync (one person)
  stores the set on the device.
- **Off means hidden, never deleted.** A switched-off feature leaves
  navigation, Today, This week, Search, Quick add, shortcuts, the share
  sheet and Help on every member's device. Its data stays in the history
  and comes back when switched on. The service keeps enforcing the access it
  already enforces (Chat and Fridge routes refuse when off, as for "No
  access"); for the rest it is a layout, not a lock, as THREAT-MODEL says of
  Simple view.
- Members see a calm one-time note when something they used disappears.

### 3. Reports and feature requests

**Channel (owner decision):** the device sends to the Kin service, which
stores the report and forwards it to the project's GitHub issues when the
operator configures `KIN_FEEDBACK_GITHUB_REPO` and `KIN_FEEDBACK_GITHUB_TOKEN`.
Without them, reports stay on the service for the operator's admin command.

**What a problem report contains:**
- What the person typed (optional): what happened, what they expected.
- Diagnostics, each shown in the preview and removable: Kin version and
  build, browser and version, OS and device type, screen size and text
  scale, installed app or tab, current page as a route name (never record
  IDs or text), easy mode and Simple view on or off, sync state and last
  sync time, storage use, service-worker version, online state, and the last
  50 entries of a **local diagnostic ring buffer**: error codes, component
  names and timings, never household text, names, usernames or IDs (the
  buffer's writer accepts only codes from a fixed list and numbers).
- Optional and off by default: a screenshot of the current screen, shown
  and croppable before sending, with a warning that it may show private
  things.

**Feature suggestions** (household admins only): what they'd like, why it
would help, the Kin version.

**Preview and consent:** the person sees exactly what will be sent, and
where it goes ("to the Kin team; a copy is posted to the project's issue
tracker"), before Send. Nothing is ever sent automatically. Offline reports
wait in an outbox and send later. A reference number is shown.

**On the service:**
- Stored in their own tables: kind, reference, household and member IDs (for
  rate limits and replies only), created time, the bounded body (16 KiB) and
  an optional screenshot (PNG or JPEG, at most 1 MiB, type and size checked).
- Rate limits: 5 reports and 3 suggestions per member per hour, 20 per
  address per day. Unsigned-in reports (from the lock screen or setup, where
  a person can't sign in) are allowed with tighter address limits and no
  member link.
- Retention: 180 days, then purged; purged at once with household deletion
  and with the member on removal.
- **Forwarding to GitHub** sends the title, the typed text, the diagnostics
  and the reference, labelled `from-app` and `bug` or `enhancement`. It never
  sends household or member IDs, usernames, or the screenshot (screenshots
  stay on the service for the operator). If the repository is public,
  forwarded reports are public; the preview says so, and the operator guide
  recommends a private repository for reports.
- **Status** (received, planned, done, won't do) is set with the admin command
  or follows the GitHub issue (closed as completed → done, closed as not
  planned → won't do) when forwarding is on, and is shown in the sender's
  "What I've sent".

### 4. Setting Kin up for someone (#612–#615)

A family member prepares Kin so that all the person has to do is open it
and choose a password.

- **Prepared invitation.** From People & devices, a household admin chooses
  "Set up Kin for someone": the person's name, who they are (Adult, Limited
  or Temporary, with the usual limits and a Temporary end), easy mode (on by
  default), the helper's name (their own, filled in) and an optional note.
  The service keeps it as a **prepared invitation** (server schema 27):
  single-use, lasting 1, 3 or 7 days (the service allows 1 to 7) so a sheet
  can be posted, surviving a restart, not ending the household's other
  invitations, at most three waiting at once.
- **What it carries.** The member kind and the easy-mode choice in the
  open; the names and the note in a **card** sealed on the admin's device
  (AES-GCM, `web/security/prepared-card.js`) under a fresh key carried only
  in the link's fragment beside the code (`/pair#code=…&k=…`). The service
  stores the card and can't read it. A code typed by hand works too, without
  the card: the person then types their name, and easy mode still applies.
- **Printable sheet.** "How to open Kin": the QR code (large), the link, the
  code to type, three numbered steps in plain words, "If you get stuck, call
  Mikey" and when it ends, with a print stylesheet that prints only the
  sheet. The code and key stay in the admin's open page only, so the sheet
  can be printed again until Kin closes or locks.
- **One-screen welcome.** Opening the link: "Hi Rose — your family set this
  up for you" (in easy mode already), then a password with Show password,
  plain guidance and the strength floor (#557), with a username chosen from
  her name that she can change; then the wait for approval in plain words
  naming the helper; then Today in easy mode with Help on the page. Every
  screen, and the failure card, says who to call. Her name is recorded as
  any member's (event 51) and easy mode is written to her synced settings.
- **Approval (decided).** The inviter's approval with fingerprint
  comparison stays exactly as for every invitation, and its claim waits up
  to a day for it. The in-person path is the same comparison on two screens
  side by side: the helper's device shows Rose's code and approves only when
  they match; Rose's device then asks "Do these match?" against the
  helper's. **Unattended pre-approval is not offered**: it can't be bound to
  Rose's device key before that key exists, and bound only to the code it
  would make the paper sheet a bearer credential for membership and the
  household's keys (THREAT-MODEL, "Prepared invitations").
- **Not in this slice.** Choosing per-person which features they'll see
  (the story's "features they'll see"): household features are a household
  setting (§2), and easy mode already trims navigation to what the person
  uses; a per-member set waits for a later story.

## Consequences

- A diagnostic ring buffer and error codes at existing error sites.
- New server columns and tables (additive schema bump), routes, admin
  commands and an optional GitHub client in the service (Node's `fetch`, no
  dependency).
- PRIVACY gains: what reports contain and where they go; THREAT-MODEL gains:
  a report's typed text and screenshot are readable by the operator and, for
  typed text, whoever can read the issue tracker; feature switches are a
  layout except for Chat and Fridge.
- DEBUGGING's planned "export diagnostics" is replaced by this.

## Alternatives considered

- **Feature switches in the household history.** Every device would agree
  through replay, but Rust can't tell admins apart, so any member's device
  could switch features. Rejected for the service setting.
- **Easy mode as an extension of Simple view.** Simple view removes
  capabilities and is set by an admin; reusing it for adults would either
  take things away from them or weaken it for children. Kept separate.
- **A prefilled email or GitHub link instead of the service.** Simpler, but
  needs an email app or a GitHub account, and loses the outbox, rate limits
  and status. Rejected by the owner.
- **Automatic crash reporting.** Hidden telemetry; contrary to PRIVACY and
  DEBUGGING. Rejected.
