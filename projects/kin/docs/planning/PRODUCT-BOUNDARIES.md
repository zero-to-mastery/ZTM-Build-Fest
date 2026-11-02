# Product Boundaries for the October Plan Through v0.40

These boundaries apply to the October daily targets and guide the undated v0.41–v0.45 follow-up proposals.

## Tired-parent test

Every feature should answer:

> Would a tired household member actually use this to remember, coordinate, hand off, or recover context?

## Prefer

- fast capture;
- areas and reference context;
- routines;
- shopping/replenishment;
- short notes;
- explicit responsibility without scoring;
- offline/local-first behavior;
- encrypted portability;
- understandable recovery/deletion;
- small-household membership;
- accessible installed-web UX.

## Avoid

- AI interpretation or recommendations;
- no points, streaks or scores for adults unless an admin allows and the adult opts in; the children's chore chart may show weekly points and compare children; never streaks or shaming ([ADR 0022](../decisions/0022-family-hub.md) §6, owner decision on #654). The chart has no adult-only leaderboard, no reminders or notifications about points and no history beyond the current week, and an adult can leave it at any time;
- rankings of household members outside the children's chore chart;
- hidden read receipts, location, presence, activity monitoring (push notifications record nothing about delivery or reading, and are coalesced so they stay calm: [PUSH](../PUSH.md)). Household chat's read receipts, typing indicators and "online now" are allowed only because they are visible, switchable by each member, reciprocal and never kept as history; there is no "last seen" ([ADR 0008](../decisions/0008-household-chat.md));
- a general messenger: chat is one room for one household's members, with nobody outside the household, no public rooms and no anonymous sharing;
- voice or video calling, ringing and incoming-call screens: not promised or built. The live channel keeps an empty, closed seam for short-lived messages and the decision record says how a later epic would use it without touching chat history ([ADR 0009](../decisions/0009-ephemeral-signaling-boundary.md)). Voice *messages* are recorded clips sent as attachments, not calls;
- generic project-management/workflow systems;
- public social features;
- architecture added mainly because it is technically interesting.
