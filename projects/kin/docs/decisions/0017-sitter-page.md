# ADR 0017 — A page for the sitter

Status: Accepted (owner decision, #442, for the sitter-page epic #441)

## Context

Temporary members (babysitters, carers, guests) join with an expiry. Today
they land in the whole of Kin. What a sitter needs is short and specific:
emergency contacts, the children's routines, house notes, the Wi-Fi.
Families keep this on paper or in a message thread that goes stale.

Constraints:

- A Temporary member's device holds the household key while access lasts, so
  anything in household history is readable to it with other software. As
  with Simple view (ADR 0013), Kin can choose what to *show*, not what the
  device *could* read; the docs must say so.
- Access ends with the existing Temporary expiry; nothing new is enforced by
  the service.
- v1.0 formats are frozen; new events are additive.

## Decision

### What it is: a page built from existing records

- **`SITTER_PAGE_SET` (kind 70)** (one additive household event kind): an optional short intro (0–500 bytes) and an ordered
  list of up to 30 entries, each `{ kind: note | reference-record | routine,
  id }`. Setting it replaces the previous page. Entries pointing at archived
  or unknown records are skipped in the projection.
- **Who may change it:** any Adult member (owner decision; not Limited or
  Temporary).
- **What shows:** the entries' current content (a note's title and body, a
  reference record's fields, a routine's text and today's state), so editing
  a note updates the page; nothing is copied.
- **Contacts:** a reference record field whose value is a phone number is
  shown as a `tel:` link on the sitter page.

### How a Temporary member sees it

- A Temporary member's Kin opens on **For you** (the sitter page) instead of
  Today, with the household's other destinations still available as the
  Temporary policy allows today. It is a landing page and a layout, not a
  lock; the copy says what the family chose to show.
- Offline: the page is a projection of local history, so it works offline
  after the first sync, like everything else.
- When access expires, the existing flow removes the member's access and
  local household data; nothing extra is needed.
- Adults see **Household › For the sitter** to build the page, with a
  preview as the sitter sees it.

### Older devices

As for other additive household kinds: an older engine pauses household sync
with "update Kin" and keeps its data until it updates (V1.0-COMPATIBILITY).

## Consequences

- One event kind, a projection of resolved entries, an editor and a view.
- THREAT-MODEL gains a line: the sitter page is a layout over data the
  Temporary member's device already holds while access lasts.

## Alternatives considered

- **A share link** (a URL with the page). Rejected: it leaves the household
  and Kin's encryption, and can't be revoked by expiry.
- **A special note type.** A copy of contacts and routines that goes stale;
  the page should show the live records.
- **Restricting what Temporary members can decrypt.** Would need a separate
  key epoch per audience, a much larger change; out of scope.
