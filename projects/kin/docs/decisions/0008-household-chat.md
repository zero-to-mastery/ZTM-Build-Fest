# ADR 0008 — Household Chat, Visible Receipts and Presence

Status: Accepted (owner decision, #105, for the household chat epic #104)

## Context

Kin's boundaries kept chat out of scope. The roadmap said "No chat
replacement", the Talk contract ([V0.4.0](../planning/V0.4.0.md)) excluded chat,
replies and threads, and [PRODUCT-BOUNDARIES](../planning/PRODUCT-BOUNDARIES.md)
listed hidden read receipts, presence and activity monitoring under "Avoid".
The owner decided to add one household chat room beside Talk's short topics
to come back to, with read receipts, typing and "online now" in scope
because they are visible and switchable, not hidden.

## Decision

- **One chat room per household.** It sits beside Talk under Updates → Chat.
  Talk stays as it is. Kin does not become a general messenger: there are no
  conversations with people outside the household, no public rooms and no
  anonymous sharing.
- **Read receipts, typing indicators and "online now" are in scope because
  they are visible and switchable.** Every member can turn off sending their
  own, and the UI explains plainly what others can see. They are reciprocal
  (a member who stops sending them also stops seeing them) and never kept as
  history: there is no "last seen" and no record of when anyone read or was
  online. The receipts story defines what a device keeps to show a "seen"
  mark. Location and background activity monitoring stay out of scope.
- **Everyone can chat by default**, including Limited (children and teens)
  and Temporary (babysitters, caregivers, guests) members. The household
  admin can restrict either kind.
- **A household admin can delete any message for everyone**, shown to all as
  "Removed by an admin".
- **In scope for the epic.** From epic #104: text and emoji, photos and
  files, search, editing, and deleting for yourself or for everyone. Resolved
  by the owner in #105: reactions, "online now", replies, mentions, pinned
  messages, turning a message into a task, handoff or note, unread markers
  and badges, voice messages, quick polls, and chat in encrypted export and
  restore. Each has its own story under #104.
- **Deletion actually deletes content.** Message text and attachments live in
  content blobs with their own per-message keys, outside the immutable event
  log; deleting or editing a message deletes the old blob on the relay and on
  every device. The log keeps the message event (who sent it, when, and that
  it was edited or deleted) but not its content.
- **Who deletes a blob on the service** (recorded in #110). The service
  deletes a message's content blob for the member who uploaded it, from any
  of their devices, or for a household admin. #110 said "the same device";
  tying it to the member lets an author who sent from a phone delete from a
  laptop, and a revoked device can't authenticate anyway.
- **Chat has its own log** (recorded in #109). Chat events are canonical
  events like any other, but they are kept in a chat log apart from the
  household history: a household's history is capped at 10,000 events and a
  busy chat would fill it, chat events are encrypted under the chat key that
  only members allowed to chat hold, and chat never enters the household
  projection. The chat log has its own cap (250,000 events), its own replay
  checkpoint, and each log refuses the other's events.
- **Chat events travel in their own relay stream** (recorded in #111). They
  use the household relay's envelopes and rules but their own cursor,
  per-device sequence, logical clock bound and quota, so chat never counts
  against household limits and the service can enforce who may chat (#123)
  without reading anything. Until the chat key exists (#123), chat events
  are encrypted under the household key epoch; the chat key story moves
  them to it.
- **Delete for me** (recorded in #117/#119) is a per-member record on the
  service, sealed to that member's own devices for each revision (ECDH to
  each device's agreement key) instead of a member-wide key: it hides the
  message on all their devices, and nobody else can tell.
- **Decided (#130): push stays generic.** A mention does not change the push
  notification. Saying "You were mentioned" would tell the service who was
  mentioned (not the text), so the mention marker (an "@" on the Chat count)
  appears only on the device, from decrypted state.

## Alternatives Considered

- **Keep chat out and lean on Talk.** Kin's reasoning: Talk is for topics to
  come back to, not conversation, so conversation would stay in other
  messengers, away from household context.
- **Chat without receipts, typing or presence.** Simpler and more private.
  Making each one visible, switchable and reciprocal keeps the "no covert
  monitoring" principle while including them.
- **Messages inside events.** With an immutable, fully replicated log,
  "delete for everyone" could only hide text. Content blobs make deletion
  real.

## Consequences

- PRODUCT-BOUNDARIES, ROADMAP, PRINCIPLES and THREAT-MODEL change to match
  (this ADR is their reason).
- The service learns more routing metadata than before: when devices are
  connected (whether or not a member shares "online now"), which device sent
  each event, and the size and timing of messages and blobs. It still never
  sees message text, file names or contents, who read what, or who is typing
  beyond that routing.
- Admin removal is visible to everyone, never silent.
- Nothing can recall what someone already saw, screenshotted, downloaded or
  exported.
