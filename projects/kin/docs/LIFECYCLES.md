# Entity Lifecycles

**Status:** Current through v0.7.0 Routines; earlier version sections are historical contracts. See v0.7.0 below.

## Item

```text
                 ITEM_COMPLETED
active --------------------------------> completed
  ^                                         |
  |             ITEM_REOPENED              |
  +-----------------------------------------+
  |                                         |
  +--------------- ITEM_ARCHIVED -----------+
                    (tombstone)
completed -------- ITEM_ARCHIVED --------> archived
```

| Current state       | Event                          | Next state | Rule                                                                               |
| ------------------- | ------------------------------ | ---------- | ---------------------------------------------------------------------------------- |
| absent              | `ITEM_ADDED`                   | active     | Requires a new stable item ID and valid text.                                      |
| active              | `ITEM_COMPLETED`               | completed  | Valid transition.                                                                  |
| completed           | `ITEM_COMPLETED`               | completed  | Valid no-op for distinct event identity; exact duplicate delivery is deduplicated. |
| completed           | `ITEM_REOPENED`                | active     | Implemented in v0.2.0.                                                             |
| active              | `ITEM_REOPENED`                | active     | Valid no-op, matching repeated completion behavior; implemented in v0.2.0.         |
| active or completed | `ITEM_ARCHIVED`                | archived   | Terminal tombstone transition implemented in v0.2.0.                               |
| absent              | completion, reopen, or archive | error      | Referenced item does not exist.                                                    |
| archived            | any item mutation              | error      | Archived item is terminal unless a future explicit restore event is designed.      |

v0.2.0 implements the full Item matrix above. Reopen-on-active is a valid no-op; archive from active or completed is a terminal tombstone; every subsequent ordinary mutation of an archived item is invalid. Duplicate `ITEM_ADDED` with a different event ID but existing item ID is invalid.

## Handoff

```text
created
   |
   v
unacknowledged -- HANDOFF_ACKNOWLEDGED --> acknowledged
   |                                      |
   +--------------- HANDOFF_ARCHIVED -----+
                         |
                         v
                      archived
```

A handoff is created as unacknowledged. Acknowledgement is a receipt signal, not approval. Archival removes it from the active handoff view while preserving history. Unknown handoff references and transitions from archived are invalid. Handoff is implemented in v0.3.0. Repeated acknowledgement is a valid no-op; distinct addition of an existing Handoff ID fails. See [V0.3.0](V0.3.0.md) for the full matrix.

## Talk

```text
TALK_ADDED
    |
    v
   open -- TALK_RESOLVED --> resolved
    ^                         |
    +------- TALK_REOPENED ---+
    |                         |
    +-------- TALK_ARCHIVED --+
                  |
                  v
               archived
```

A Talk begins open. It can be resolved, reopened from resolved, or archived. Archive is terminal absent a future explicit restore operation. These are workflow states only; they do not determine who is right or whether a topic is objectively settled. Talk is implemented; repeated resolve/reopen are valid no-ops and unknown/archived mutations fail.

## Pulse

```text
PULSE_SET
    |
    v
  active -- expiry reached at explicit as_of --> expired
    |
    +-------------- PULSE_CLEARED -----------> cleared
```

Setting a Pulse creates time-bounded context with an explicit expiry. Expiry is a derived condition evaluated against an explicit `as_of` time, not a background event or a permanent member attribute. Clearing appends `PULSE_CLEARED`. A later `PULSE_SET` supersedes the current context through event order. Pulse is implemented in v0.5.0.

## Future entity lifecycles

Agreements, Household membership, credentials, and trusted devices need explicit transitions before their respective implementation milestones. They must not inherit Item transitions by analogy. Member invitation/removal and device revocation are planned for the v0.0.5 identity and pairing specifications.

## v0.5.0 Pulse

SET replaces its actor’s context; CLEAR removes it (absent clear is valid). Expiry derives from as_of >= expires_at, never an event. Latest expired records remain projected until replaced/cleared; no history UI. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

No household entity lifecycle or domain event is added. The summary describes existing Item, Handoff and Talk lifecycle events. The local installation cursor is view metadata, not a household lifecycle or acknowledgement event. See [V0.6.0](V0.6.0.md).

## v0.7.0 Routines

Create Routine → complete/reopen current occurrence → terminal archive. Repeated completion/reopen is a valid state no-op; distinct actions after archive are invalid. Exact duplicate event delivery is ignored before transition checks. Advancing time derives a new period without an event. See [V0.7.0](V0.7.0.md).
