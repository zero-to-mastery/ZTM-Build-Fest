# Household Domain

**Status:** Current through v0.7.0 Routines; earlier version sections are historical contracts. See v0.7.0 below.

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

The initial product assumption is two adult members. This is a scope constraint, not a role/permission system. A household is created, active, and eventually may be closed or deleted through an explicit lifecycle; there is no implicit transfer of ownership when a device changes.

In v0.1.x, the household ID is a local placeholder created for the browser installation. It does not represent a remotely registered household and does not establish membership or authentication. Household creation, membership, closure, recovery, and deletion protocols remain future work.

## Member

A member is a person participating in a household, identified by an opaque, stable `member_id`. The member ID is distinct from every device ID and credential ID. Replacing or revoking a device does not create a new person or rewrite prior event authorship.

An event's `actor_id` identifies the member who initiated the action. In v0.1.x it is a temporary local actor ID, not a verified identity. Membership may later have invited, active, and removed states; authorization and transitions are specified in v0.0.5. Kin does not infer a member's identity, relationship, capacity, or intent from event activity.

## Device

A device is one browser/application installation with an opaque, stable `device_id`, associated with an owning member when identity is introduced. A device is not a member and should not be treated as a household member when replaced.

Conceptual authorization states are unregistered, trusted, and revoked. Only an authorized device may participate in future sync. Revocation blocks future authorization/sync but cannot erase plaintext or keys already copied to a device. v0.1.0 has only a local installation placeholder; trusted-device enrollment and revocation are not implemented.

## Credential

A credential is an authenticator associated with a member, such as a future passkey. It proves control of an authentication credential; it is not the member, household, device, or household encryption key. A credential may be used on or to authorize a device according to the identity protocol planned for v0.0.5.

## Item

An Item is a lightweight household need or reminder. It has a stable opaque `item_id`, user-entered text, an event-derived creation state, and a completion state. Its lifecycle is specified in [Lifecycles](LIFECYCLES.md).

Items are not project-management tasks. The initial model deliberately avoids priority, labels, project hierarchy, assignment requirements, and complex metadata. Adding, completing, reopening, and archiving are separate immutable events; an earlier event is not edited to change the item.

v0.2.0 includes adding an item as Today or Need, completion, reopening, and archival. A legacy v0.1.x add has no classification and normalizes to Today without changing its stored bytes. Archive is a terminal state/tombstone, not physical deletion of historical events. Priority, labels, assignment, and project metadata are not part of the Item model.

## Handoff

A Handoff is a short context transfer one household member wants another to know. Its conceptual lifecycle is created, unacknowledged, acknowledged, and archived. Acknowledgement means receipt, not agreement, approval, or evaluation. Handoffs are implemented in v0.3.0 as a separate typed entity; see [V0.3.0](V0.3.0.md). Repeated acknowledgement is a valid no-op. Creator and acknowledger may be the same local actor; no verified identity is inferred.

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

Pulse is the latest capacity per actor: enum Good/Okay/Drained/RoughDay/NeedQuiet, set_at, expires_at, active/expired status. No PulseId, arbitrary text, name or acknowledgement. Actor IDs remain unverified placeholders. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

The summary is a derived household projection over existing Item, Handoff and Talk events. It adds no domain entity or event kind. The catch-up cursor belongs to one browser installation's local UI context; it does not represent a member, device identity claim, acknowledgement, or read receipt. Pulse events advance the snapshot boundary but do not create summary entries. See [V0.6.0](V0.6.0.md).

## v0.7.0 Routines

Routines are immutable Daily/Weekly definitions with derived occurrences. Monday starts a week. Complete/reopen applies to the current occurrence; archive ends the definition. Editing means archive and create anew. No reminders, missed counts, assignments or history UI. See [V0.7.0](V0.7.0.md).
