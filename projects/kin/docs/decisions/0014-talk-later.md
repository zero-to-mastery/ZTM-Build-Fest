# ADR 0014 — Talk later: topics inside Chat replace the Talk tab

Status: Accepted (#312, for the mobile Updates epic #309)

## Context

Updates has three tabs: Handoffs, Talk and Chat. Talk (household events
8–11: `TALK_ADDED`, `TALK_RESOLVED`, `TALK_REOPENED`, `TALK_ARCHIVED`) holds
short topics to come back to. Since Chat arrived (ADR 0008), a topic usually
starts as a message, and copying it into Talk is a chore. Epic #309 asks for
**Talk later** on any message, a **To talk about** list in Chat, and the Talk
tab gone.

Constraints from the design review:

- Chat text is encrypted under the chat key and lives in the chat log, apart
  from the household history (ADR 0008). A member without chat access
  (policy "none", #123) holds neither.
- With no chat access, Chat leaves Updates (`views.js`). Legacy Talk items
  must not disappear for those members.
- v1.0 formats are frozen: anything new is additive (V1.0-COMPATIBILITY).
- Rust owns domain rules (ADR 0002).

## Decision

### Where a flag lives: in the chat log

A Talk-later flag is a new additive **chat** event kind, **`CHAT_TOPIC_SET`
(kind 65)**: `message_id`, `state` (u8: 0 cleared, 1 open, 2 resolved).

- It is a chat event: encrypted under the chat key, kept in the chat log,
  carried in the chat relay stream, counted against chat limits. A member
  without chat access never receives it, so never sees which message, nor
  its text.
- **Who may set it:** any member who may post in Chat (the same check as a
  pin, #131). Members with read-only access can't.
- **Rules (Rust):** the message must exist in this history and not be
  deleted. Open from none or resolved ("Talk later", "Reopen"); resolved from
  open ("Resolved"); cleared from any state ("Remove from list"). A command
  that would change nothing is refused; replay is tolerant (the latest event
  in log order wins, and a flag on a message this history lacks or that was
  deleted changes nothing). At most 200 open or resolved topics are kept
  (`MAX_TOPICS`); a command past it is refused.
- **The record:** per message, the state, who flagged it first, and who last
  changed it. Deleting a message for everyone drops its topic.
- **Projection:** the chat page gains an optional topics section (request
  flag bit 5): a count, then per topic, newest first, the message id, state,
  who flagged it and a quote of the message (as pins do).

Older devices meet kind 65 like pins and polls before it: the device refuses
the event (`chat_event_refused`) and moves past it, keeping the rest of its
chat and the household history; it shows no topics until it updates.

### The list: To talk about

- **In Chat:** a **To talk about** list holds the chat topics and the legacy
  Talk items (events 8–11) together, open first, each resolvable and
  reopenable with its own events (a legacy item keeps using
  `resolve-talk`/`reopen-talk`/`archive-talk`). A flagged message stays in the
  conversation, visibly marked "To talk about". Choosing a chat topic jumps
  to its message.
  - ≥ 1180 px: a side column at the detail-panel width (390 px).
  - 720–1179 px and phones: a panel opened from the chat toolbar, whose
    button shows the open count in text ("To talk about, 3").
- **Adding without a message:** the list keeps "Add a topic", which writes
  the existing `TALK_ADDED` household event, so a topic needs no chat.
- **Without chat access:** Updates shows a standalone **To talk about**
  section on the Handoffs page with the legacy Talk items only (add, resolve,
  reopen, archive). Chat topics never appear there.
- **The Talk tab goes.** `#updates/talk` (and the `talk` alias) leads to the
  list: Chat with the list open, or the Handoffs section without chat
  access. Updates has two tabs: Handoffs and Chat.

## Consequences

- One new chat event kind (65), additive; V1.0-COMPATIBILITY, EVENTS and ABI
  record it; TEST-VECTORS gains vectors.
- Members without chat access lose nothing they had: legacy Talk stays
  available to them.
- A topic flagged in Chat is never visible to someone who can't read Chat,
  by construction rather than by hiding.

## Alternatives considered

- **Flags as household events.** Reachable by every member, but the event
  would carry a chat message id into the household history, readable by
  members without chat access, and the list would show topics whose text
  they can't read. Rejected.
- **Copy the message text into a Talk item.** Puts chat text into the
  household history, outside the chat key and beyond "delete for everyone".
  Rejected.
- **Keep the Talk tab beside Chat.** The epic's point is fewer places to
  look on a phone.
