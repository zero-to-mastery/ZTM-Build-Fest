# Product

## Vision

Kin is a shared household operating layer that makes the important everyday context visible with as little effort as possible. It is intended to reduce friction caused by missed information, forgotten responsibilities, unspoken expectations, incomplete handoffs, and difficult conversations happening at the wrong time.

Kin coordinates. It does not judge. It does not promise to prevent conflict or repair relationships.

## Initial audience

The first intended setting is one household, initially two adults, coordinating everyday family life. The product should be useful to a tired parent holding a child: the guiding test is whether that person would actually use it. The desired interaction is close to “tap, type a few words, tap, done.”

The initial audience describes a starting point, not a limit on who can be part of a household in the future.

## Long-term product areas

These are product concepts, not implemented features or a promise that every concept will ship.

### Today

A compact view of what matters to the household today, such as a time-sensitive appointment or an evening reminder.

### Needs

Small things someone needs handled, remembered, or picked up. Kin should keep capture and completion lightweight rather than turn every need into a project.

### Handoff

Useful context one person needs to transfer to another, for example what a child has eaten or what needs restocking. A handoff should help the next person act without requiring a lengthy report.

### Talk

A place to capture something that matters but would be better discussed at another time. Capture should not force an immediate conversation or assign blame.

### Pulse

A lightweight indication of current capacity, such as “Good,” “Drained,” “Rough day,” or “Need quiet.” It is context, not a mood score, diagnosis, or invitation to interpret someone.

### Since You Last Looked

A compact, bounded summary of meaningful Item, Handoff, and Talk changes since this browser installation was explicitly marked caught up. Pulse is excluded. The cursor is local UI state, not a member read receipt; the summary has no actor attribution, per-entry timestamps, timeline, or history browser. It answers what changed without monitoring who looked.

## Product boundaries

Kin is not couples therapy, a marriage score, a chore competition, a relationship judge, a social network, a surveillance tool, an enterprise task manager, or a generic calendar clone. See [Principles](PRINCIPLES.md) for the non-goals and constraints that follow from this boundary.

## Current status

Kin implements the Today and Needs views, fixed lightweight classification, fast local capture, completion, reopening, and archival. Older v0.1.x items without classification remain visible in Today. Handoff adds short context capture, acknowledgement, recent context, and archival. Local actors are not verified people. Talk captures short topics with workflow-only resolution. Pulse adds fixed temporary current capacity, explicit expiry and clear. Since You Last Looked is implemented as a bounded protocol-v6 projection with schema-1 local cursor metadata; Routines remain future work.
