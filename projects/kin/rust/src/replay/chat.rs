//! Replay of household chat (#109).
//!
//! Chat events never fail replay once they have decoded: an event that
//! conflicts with what this history knows is kept and changes nothing, as
//! with device names. Commands enforce the rules when an event is created
//! (command.rs), so a well-behaved device never writes one of these; a
//! history may still hold them (another device's bug, or a member who joined
//! later and never received the message an edit refers to).
//!
//! - Blob references are content hashes under random keys, so honest
//!   devices never repeat one, and commands refuse a reference the log has
//!   seen (`ChatState::seen`). Replay doesn't rely on that: a modified
//!   client can copy any reference into an event dated as it likes, so a
//!   reused reference is applied like any other, and a page never retires a
//!   blob a visible message still shows (`ChatState::retired_blobs`). A copy
//!   can then only show the content as its author's own message; it can't
//!   hide or delete the original.
//! - A reply (#129) names the message it answers; replay stores the name and
//!   nothing else. The original need not be in this log, and a page looks it
//!   up when it is read.
//! - A post adds a message, unless a message with that ID exists (the first
//!   post wins; the second post's blob becomes a retirement candidate).
//! - Only the author edits, only a text message, and never a deleted one. An
//!   edit replaces the content blob; the old one becomes a candidate. An
//!   edit that can't apply to a message this log holds (another member's,
//!   an attachment's, or the author's after or concurrent with their own
//!   deletion) makes its new blob a candidate, so a deleted message's edited
//!   text doesn't survive. An edit to the blob a message already has
//!   changes nothing.
//! - The author deletes for everyone: terminal, and its current blob
//!   becomes a candidate. Deletion wins over an edit at the same logical time in either
//!   replay order, because replay order is total and a delete is terminal:
//!   whichever sorts first, the message ends deleted.
//! - An admin deleting someone else's message records a claim. Whether the
//!   claimant is an admin is the service's to say, so the claim takes effect
//!   when the host reads a page and names the admins (chat.rs).
//!
//! - A reaction (#127) turns one member's emoji on or off. The last write
//!   per (member, message, emoji) in replay order wins, so a member's devices
//!   converge. A reaction to a message this log lacks changes nothing; one
//!   to a deleted message is kept and left out of the page. A message holds
//!   at most `MAX_REACTION_GROUPS` different emoji; a further one changes
//!   nothing, in replay as in commands.
//! - A topic (#312, "Talk later") sets where a message stands on the "To
//!   talk about" list: the latest event in replay order wins, whatever the
//!   state before it. One for a message this log lacks or that its author
//!   deleted changes nothing, and the author's deletion drops the topic. A
//!   new topic past `MAX_TOPICS` changes nothing, in replay as in commands.
//!
//! Actors and devices are the event header's, after identity bindings.
use std::sync::Arc;

use super::*;
use crate::chat::{
    ChatMessage, ChatMessageStatus, ChatTopic, ChatTopicState, ReactionGroup, MAX_REACTION_GROUPS,
    MAX_TOPICS,
};
use crate::event::ChatContentKind;

pub(super) fn apply(r: &mut Replay, event: &EventEnvelope) -> Result<(), KinError> {
    if event.actor_id.0 == [0; 16] || event.device_id.0 == [0; 16] {
        return Err(KinError::InvalidEvent);
    }
    // Copy-on-write: a finalized state shares the chat until it changes.
    let chat = Arc::make_mut(&mut r.chat);
    match &event.kind {
        EventKind::ChatMessagePosted {
            message_id,
            content_kind,
            blob_ref,
            blob_key,
            reply_to,
            mentions,
        } => {
            chat.seen.insert(*blob_ref);
            if chat.positions.contains_key(message_id) {
                chat.retired.push(*blob_ref);
                return Ok(());
            }
            chat.positions.insert(*message_id, chat.messages.len());
            chat.messages.push(ChatMessage {
                message_id: *message_id,
                author: event.actor_id,
                device: event.device_id,
                posted_at: event.timestamp,
                edited_at: 0,
                status: ChatMessageStatus::Live,
                content_kind: *content_kind,
                blob_ref: *blob_ref,
                blob_key: *blob_key,
                reply_to: *reply_to,
                mentions: mentions.clone(),
            });
        }
        EventKind::ChatMessageEdited {
            message_id,
            blob_ref,
            blob_key,
            mentions,
        } => {
            chat.seen.insert(*blob_ref);
            let Some(&at) = chat.positions.get(message_id) else {
                return Ok(());
            };
            let message = &mut chat.messages[at];
            if message.blob_ref == *blob_ref {
                return Ok(());
            }
            // An edit every history that holds the message ignores (another
            // member's, an attachment's, or one that lost to the author's own
            // deletion) leaves its blob shown nowhere: retire it. An edit of
            // a message this history lacks is kept as is; where the message
            // is known, the edit may apply.
            if message.author != event.actor_id
                || message.content_kind != ChatContentKind::Text
                || message.status == ChatMessageStatus::Deleted
            {
                chat.retired.push(*blob_ref);
                return Ok(());
            }
            let old = std::mem::replace(&mut message.blob_ref, *blob_ref);
            message.blob_key = *blob_key;
            message.status = ChatMessageStatus::Edited;
            message.edited_at = event.timestamp;
            message.mentions = mentions.clone();
            chat.retired.push(old);
        }
        EventKind::ChatMessageDeleted {
            message_id,
            by_admin,
        } => {
            let Some(&at) = chat.positions.get(message_id) else {
                return Ok(());
            };
            let message = &mut chat.messages[at];
            if message.status == ChatMessageStatus::Deleted {
                return Ok(());
            }
            if message.author == event.actor_id {
                let old = std::mem::take(&mut message.blob_ref);
                message.blob_key = [0; 32];
                message.status = ChatMessageStatus::Deleted;
                chat.retired.push(old);
                chat.pins.retain(|pin| pin.message_id != *message_id);
                chat.topics.retain(|topic| topic.message_id != *message_id);
                // Deleting a poll deletes its votes too (#135).
                chat.polls.remove(message_id);
            } else if *by_admin {
                let claims = chat.admin_claims.entry(*message_id).or_default();
                if !claims.contains(&event.actor_id) {
                    claims.push(event.actor_id);
                }
            }
        }
        EventKind::ChatReactionSet {
            message_id,
            emoji,
            on,
        } => {
            // A reaction to a message this history lacks changes nothing,
            // like an edit of one. Reactions are per member (the header's
            // actor), so a member's devices converge: replay order is total
            // and the last write wins. Whether the message still shows them
            // is decided at page time (deleted messages drop theirs).
            if !chat.positions.contains_key(message_id) {
                return Ok(());
            }
            let groups = chat.reactions.entry(*message_id).or_default();
            let found = groups.iter().position(|group| group.emoji == *emoji);
            if *on {
                // The same cap commands apply: past it a new emoji changes
                // nothing, so a log can't grow one message without bound.
                if found.is_none() && groups.len() >= MAX_REACTION_GROUPS {
                    if groups.is_empty() {
                        chat.reactions.remove(message_id);
                    }
                    return Ok(());
                }
                match found {
                    Some(at) if groups[at].actors.contains(&event.actor_id) => {}
                    Some(at) => groups[at].actors.push(event.actor_id),
                    None => groups.push(ReactionGroup {
                        emoji: emoji.clone(),
                        actors: vec![event.actor_id],
                    }),
                }
            } else if let Some(at) = found {
                groups[at].actors.retain(|actor| *actor != event.actor_id);
                if groups[at].actors.is_empty() {
                    groups.remove(at);
                }
            }
            if groups.is_empty() {
                chat.reactions.remove(message_id);
            }
        }
        EventKind::ChatPinSet { message_id, on } => {
            // A pin of a message this history lacks, or of one already
            // pinned, changes nothing (the first pinner stays). Commands keep
            // the shown pins to `MAX_PINS`; replay only bounds the record.
            if *on {
                if chat
                    .get(message_id)
                    .is_some_and(|message| message.status != ChatMessageStatus::Deleted)
                    && !chat.is_pinned(message_id)
                    && chat.pins.len() < crate::chat::MAX_PIN_RECORDS
                {
                    chat.pins.push(crate::chat::ChatPin {
                        message_id: *message_id,
                        by: event.actor_id,
                    });
                }
            } else {
                chat.pins.retain(|pin| pin.message_id != *message_id);
            }
        }
        EventKind::ChatPollVote {
            message_id,
            options,
        } => {
            // A vote counts if the poll shows, is open and the choice fits
            // it; the member's last counted vote replaces earlier ones. A
            // vote for a message this history lacks changes nothing.
            let Some((spec, closed)) = chat.poll_of(message_id) else {
                return Ok(());
            };
            if closed || !spec.allows(*options) {
                return Ok(());
            }
            if *options == 0 {
                if let Some(poll) = chat.polls.get_mut(message_id) {
                    poll.votes.remove(&event.actor_id);
                }
            } else {
                let poll = chat.polls.entry(*message_id).or_default();
                if poll.votes.contains_key(&event.actor_id)
                    || poll.votes.len() < crate::chat::MAX_POLL_VOTERS
                {
                    poll.votes.insert(event.actor_id, *options);
                }
            }
        }
        EventKind::ChatPollClosed { message_id } => {
            // Only the poll's author closes it, and the first close stands.
            let Some((_, closed)) = chat.poll_of(message_id) else {
                return Ok(());
            };
            if !closed
                && chat
                    .get(message_id)
                    .is_some_and(|m| m.author == event.actor_id)
            {
                chat.polls.entry(*message_id).or_default().closed = true;
            }
        }
        EventKind::ChatTopicSet { message_id, state } => {
            if !chat
                .get(message_id)
                .is_some_and(|message| message.status != ChatMessageStatus::Deleted)
            {
                return Ok(());
            }
            let found = chat
                .topics
                .iter()
                .position(|topic| topic.message_id == *message_id);
            match (state, found) {
                (ChatTopicState::Cleared, Some(at)) => {
                    chat.topics.remove(at);
                }
                (ChatTopicState::Cleared, None) => {}
                (_, Some(at)) => {
                    if chat.topics[at].state != *state {
                        chat.topic_clock += 1;
                        let topic = &mut chat.topics[at];
                        topic.state = *state;
                        topic.changed_by = event.actor_id;
                        topic.changed = chat.topic_clock;
                    }
                }
                (_, None) => {
                    if chat.topics.len() < MAX_TOPICS {
                        chat.topic_clock += 1;
                        chat.topics.push(ChatTopic {
                            message_id: *message_id,
                            state: *state,
                            flagged_by: event.actor_id,
                            changed_by: event.actor_id,
                            changed: chat.topic_clock,
                        });
                    }
                }
            }
        }
        _ => return Err(KinError::Internal),
    }
    Ok(())
}
