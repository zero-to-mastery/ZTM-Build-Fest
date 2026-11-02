# Household Domain

## v0.17.0 Checklist Steps

An Item may contain up to 16 ordered Steps over its lifetime, including
archived Steps. Each Step has a stable household-unique `StepId`, trimmed
plain-text label, completion state, and terminal archive state. Labels contain
1–80 Unicode scalar values, at most 256 UTF-8 bytes, and no control characters.
Step order is creation/replay order; reordering, nesting, assignment, due dates,
and independent Step scheduling are not part of this capability.

Step completion is independent from parent Item completion. Completing every
Step never completes the Item. Step mutations require an active parent Item;
reopen a completed Item before changing its Steps. Archiving an Item preserves
its Step history. Archiving a Step hides it from the active checklist but does
not release its lifetime capacity or erase its events.

Concurrent equal-logical-time Step archive and Step completion/reopen events
from different devices resolve to the terminal archive. A same-time parent
Item archive suppresses Step mutations regardless of replay order. Later
non-concurrent mutation after either terminal archive is invalid.

**Status:** v0.17.0 Checklist Steps is implemented and validated; this section
records the delivered contract.

## v0.16.0 Notes

A Note is durable plain-text reference context with a stable `NoteId`, trimmed
required title, body, optional `AreaId`, terminal archived state, and event
provenance (`created_by/at`, `updated_by/at`). Notes are not tasks, chat,
comments, documents, reminders, or rich text. There are no folders, tags, or
second taxonomy. The lifetime household cap is 128 Notes; titles allow 1–80
Unicode scalar values and at most 256 UTF-8 bytes; bodies allow 0–4096 UTF-8
bytes. The bounds keep one canonical event below the existing 8 KiB encrypted
sync envelope after framing and base64 expansion. Titles reject controls; bodies
reject controls other than tab and line breaks. Archive is terminal.

An optional Area points to the stable existing Area ID. New assignments require
a known active Area. Existing association remains visible after that Area is
renamed or archived; replay preserves stale events authored before archival.

Concurrent equal-logical-time `NOTE_UPDATED` and `NOTE_ARCHIVED` events from
different devices resolve to the terminal archive. The update is ignored in
either device ordering, so the projected archived title/body remain the same
regardless of the replay input order. A later non-concurrent update after
archive remains invalid.

**Status:** Current through the v0.17.0 Checklist Steps capability; earlier version sections are historical contracts.

## Scope and relationships

Kin initially models one private household with two adult members. A household is not a device, account, or relationship score. Its durable identity groups household events and membership. Members are people; devices are installations authorized for a member; credentials authenticate a member or authorize a device. These identities must not be conflated.

```text
Household
├── Member
│   ├── Credential(s)
│   └── Device(s)
└── Event stream
    └── derived household state
```

The event stream records changes; current domain state is a projection of valid events, as specified in [Events](EVENTS.md) and [State](STATE.md).

## Household

A household is one private coordination space with a stable, opaque `household_id`. The ID remains stable when a member replaces a device. It is included in each event so data from different households cannot be silently mixed.

The initial product assumption was two adult members. Membership is now bounded by member class (Adult, Limited, Temporary), and one narrow server-recorded flag, household admin, marks the Adults who manage membership and shared settings. This is not a general role/permission system. A household is created, active, and eventually may be closed or deleted through an explicit lifecycle; there is no implicit transfer of ownership when a device changes.

In v0.1.x, the household ID is a local placeholder created for the browser installation. It does not represent a remotely registered household and does not establish membership or authentication. Household creation, membership, closure, recovery, and deletion protocols remain future work.

## Member

A member is a person participating in a household, identified by an opaque, stable `member_id`. The member ID is distinct from every device ID and credential ID. Replacing or revoking a device does not create a new person or rewrite prior event authorship.

An event's `actor_id` identifies the member who initiated the action. In v0.1.x it is a temporary local actor ID, not a verified identity. Membership may later have invited, active, and removed states; authorization and transitions are specified in v0.0.5. Kin does not infer a member's identity, relationship, capacity, or intent from event activity.

## Device

A device is one browser/application installation with an opaque, stable `device_id`, associated with an owning member when identity is introduced. A device is not a member and should not be treated as a household member when replaced.

Conceptual authorization states are unregistered, trusted, and revoked. Only an authorized device may participate in future sync. Revocation blocks future authorization/sync but cannot erase plaintext or keys already copied to a device. v0.1.0 has only a local installation placeholder; trusted-device enrollment and revocation are not implemented.

A device carried over from the old address is a trusted device record that arrived with a household move ([ADR 0026](decisions/0026-moving-a-household.md) §6). It keeps its keys and certificate, so the history it signed still verifies, but it has no token and can't sign in at the new address. A household admin revokes such devices together once everyone has re-joined; they are revoked, never deleted.

## Credential

A credential is an authenticator associated with a member, such as a future passkey. It proves control of an authentication credential; it is not the member, household, device, or household encryption key. A credential may be used on or to authorize a device according to the identity protocol planned for v0.0.5.

## Item

An Item is a lightweight household need or reminder. It has a stable opaque `item_id`, user-entered text, an event-derived creation state, and a completion state. Its lifecycle is specified in [Lifecycles](LIFECYCLES.md).

Items are not project-management tasks. The initial model deliberately avoids priority, labels, project hierarchy, assignment requirements, and complex metadata. Adding, completing, reopening, and archiving are separate immutable events; an earlier event is not edited to change the item.

v0.2.0 includes adding an item as Today or Need, completion, reopening, and archival. A legacy v0.1.x add has no classification and normalizes to Today without changing its stored bytes. Archive is a terminal state/tombstone, not physical deletion of historical events. Priority, labels, assignment, and project metadata are not part of the Item model.

## v0.19.0 Shared Shopping Lists

Shopping is a third classification of the existing Item entity. It uses the
same identity, completion, reopening, and archival lifecycle as Today and
Needs Items; it does not add quantity, price, purchase assignment, or
inventory state. See [V0.19.0](planning/releases/V0.19.0.md).

## v0.20.0 Staples & Replenishment

Staples are reusable Items on a dedicated list. A household member explicitly
adds a staple to Shopping when needed; the app does not infer stock, quantity,
or timing, and the staple remains active. The resulting Shopping Item is
independent and follows the regular Shopping lifecycle. See
[V0.20.0](planning/releases/V0.20.0.md).

## v0.21.0 Household Modes

Household mode is Normal, Vacation, Guests, or Rest. Normal is the default.
Explicit changes are shared canonical events; non-Normal modes pause routine
occurrences while leaving routine definitions and archival intact. Modes do
not infer location, presence, schedules, or member activity.

## v0.22.0 Lightweight Planning Dates

An Item may have one optional civil planning date. Today and Tomorrow are
convenience choices resolved in the member's local calendar when selected;
the stored date is thereafter fixed. Dates are not deadlines, reminders, or
calendar events, and Kin does not infer urgency or roll them forward.

## Meals (#333)

A **Recipe** is a household's own: a name, up to 40 ingredient lines (each
optionally linked to a Staple) and notes. Recipes are saved whole and
archived, never deleted. A **Dinner** is at most one per civil date: a recipe
(with its name copied) or "something else" by name, plus an optional **cook**
— any household member, chosen by people, never counted or ranked. Adding a
recipe's ingredients to Shopping makes ordinary Shopping Items: a linked
Staple is re-added, a line already on Shopping (same text, ignoring case and
spacing) is skipped, and the rest are added, so repeating it adds nothing
twice. Kin doesn't track quantities, pantry stock or nutrition. See
[ADR 0012](decisions/0012-meals.md) and [EVENTS](EVENTS.md#meals).

## Handoff

A Handoff is a short context transfer one household member wants another to know. Its conceptual lifecycle is created, unacknowledged, acknowledged, and archived. Acknowledgement means receipt, not agreement, approval, or evaluation. Handoffs are implemented in v0.3.0 as a separate typed entity; see [V0.3.0](planning/V0.3.0.md). Repeated acknowledgement is a valid no-op. Creator and acknowledger may be the same local actor; no verified identity is inferred.

## Talk

A Talk captures “This matters, but right now may not be the right moment.” It can be open, resolved, reopened, and eventually archived. It is a coordination reminder, not therapy, diagnosis, mediation, or a verdict. Kin must not add blame scores, sentiment scores, winner/loser logic, or automated interpretation. Talk is implemented; resolution makes no claim of agreement or objective solution.

## Pulse

A Pulse is lightweight, time-bounded context about current capacity, for example “Good,” “Okay,” “Drained,” “Rough day,” or “Need quiet.” It is not a mental-health diagnosis, relationship score, historical performance metric, or permanent characterization of a person. A Pulse has an explicit expiry or is cleared; time-dependent display is derived using an explicit evaluation time, not hidden wall-clock reads during replay. Pulse is implemented in v0.5.0.

## Routine

A Routine represents a recurring household need, with a recurrence definition and occurrences. It is intended to support lightweight household rhythms, not become a general calendar. Daily/Weekly recurrence is implemented in v0.7.0; see the frozen release contract below.

## Agreement

An Agreement, if introduced, represents an explicit understanding deliberately entered or revised by household members. Kin must not infer an agreement from messages, behavior, or completion history. Agreements require clear authorship, revision, and archival semantics and are not currently assigned a release milestone.

## Event

An Event is an immutable, identified fact describing a domain change. The v0.2.0 item subset is implemented with household, actor, and originating device placeholders, timestamp, event kind/version, and validated payload. The canonical naming, identity, ordering, replay, and error rules are in [Events](EVENTS.md). Other conceptual entities in this document remain unimplemented unless explicitly marked otherwise.

## v0.5.0 Pulse

Pulse is the latest capacity per actor: enum Good/Okay/Drained/RoughDay/NeedQuiet, set_at, expires_at, active/expired status. No PulseId, arbitrary text, name or acknowledgement. Actor IDs remain unverified placeholders. See [V0.5.0](planning/V0.5.0.md).

## v0.6.0 Since You Last Looked

The summary is a derived household projection over existing Item, Handoff and Talk events. It adds no domain entity or event kind. The catch-up cursor belongs to one browser installation's local UI context; it does not represent a member, device identity claim, acknowledgement, or read receipt. Pulse events advance the snapshot boundary but do not create summary entries. See [V0.6.0](planning/V0.6.0.md).

## v0.7.0 Routines

Routines are immutable Daily/Weekly definitions with derived occurrences. Monday starts a week. Complete/reopen applies to the current occurrence; archive ends the definition. Editing means archive and create anew. No reminders, missed counts, assignments or history UI. See [V0.7.0](planning/V0.7.0.md).

## v0.15.0 Areas

An Area is optional, flat place/context for supported household content. It has
a stable ID, user-controlled display name, and archived flag. Item assignment
is optional; there are no Area permissions, nested Areas, projects, or hard
deletion. See [v0.15.0](planning/releases/V0.15.0.md).
