//! Private contribution revisions and mutual reveal.
//!
//! A contribution draft is owned by exactly one participant and changes only by appending an
//! immutable, numbered revision. A revision is identified by its contribution, number, author
//! binding, timestamp, and a digest of its exact content; that identity ([`RevisionStamp`])
//! carries no prose. Saving is optimistic: the caller names the revision it last saw.
//!
//! Drafts become visible to others only through a mutual reveal: an exchange among two or more
//! participants in which every member commits one exact revision of their own draft. Nothing is
//! visible until the last member commits, then every member can read every committed revision in
//! the same mutation, so a reveal that is interrupted or cancelled exposes nothing. A reveal
//! never approves, publishes, or credits anything and never touches the collaboration contract.
//!
//! Every refusal about another participant's draft is the same [`DraftError::Denied`], so a
//! caller cannot read or probe the content, revisions, or state of a draft or exchange.
//! Draft and exchange ids are unique across the whole set, so an attempt to create one over an
//! id that is already taken is refused; that collision (never any content) is the only thing a
//! participant can learn about an id they do not own.

use std::collections::HashSet;
use std::fmt;

use blake2::{Blake2s256, Digest};
use serde::{Deserialize, Serialize};

use crate::collaboration::{valid_id, MAX_CONTRIBUTIONS, MAX_MARKDOWN_BYTES, MAX_PARTICIPANTS};
use crate::date::DateTime;

pub const DRAFT_SET_VERSION: u8 = 1;
pub const MAX_REVISIONS_PER_DRAFT: usize = 200;
pub const MAX_EXCHANGES: usize = 100;
pub const MAX_DRAFT_SET_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DraftError {
    /// The requester may not do this, or the target does not exist for them.
    Denied,
    /// The requester owns the draft but saved against a revision that is no longer current.
    Stale,
    /// The input is malformed or exceeds a limit.
    Invalid,
    /// The draft already holds every revision it may, or saving would make the stored set larger
    /// than it can be read back. Nothing was saved.
    LimitReached,
}

impl fmt::Display for DraftError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Denied => "contribution draft access denied",
            Self::Stale => "contribution draft changed since it was read",
            Self::Invalid => "invalid contribution draft",
            Self::LimitReached => "contribution draft limit reached",
        })
    }
}

impl std::error::Error for DraftError {}

/// Exact, prose-free identity of one revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionStamp {
    pub contribution_id: String,
    pub number: u64,
    pub author_participant_id: String,
    pub saved_at: String,
    pub digest: String,
}

/// What a permitted reader receives: the stamp and the exact content of that revision.
#[derive(Clone, PartialEq, Eq)]
pub struct DraftView {
    pub stamp: RevisionStamp,
    pub markdown: String,
}

impl fmt::Debug for DraftView {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DraftView")
            .field("stamp", &self.stamp)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Revision {
    number: u64,
    saved_at: i64,
    digest: String,
    markdown: String,
}

impl fmt::Debug for Revision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Revision")
            .field("number", &self.number)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Draft {
    id: String,
    owner: String,
    #[serde(default)]
    withdrawn: bool,
    revisions: Vec<Revision>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Commitment {
    participant_id: String,
    contribution_id: String,
    revision: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ExchangeState {
    Pending,
    Revealed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Exchange {
    id: String,
    members: Vec<String>,
    state: ExchangeState,
    commitments: Vec<Commitment>,
}

/// Where a mutual reveal stands after a change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExchangeStatus {
    /// Waiting for this many more members to commit; nothing is visible yet.
    Pending { waiting_for: usize },
    /// Every member committed; each can read the others' committed revisions.
    Revealed,
}

/// How drafts may become visible to other participants. Chosen by a coordinator; the default
/// shares nothing, so a set that never configured a policy cannot reveal anything.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RevealPolicy {
    /// Every draft stays private to its author.
    #[default]
    Independent,
    /// Any two or more participants who mark a revision ready reveal to each other.
    Voluntary,
    /// Nothing is revealed until every active participant has marked a revision ready.
    AllReady,
}

/// One participant's standing offer to reveal one exact revision of their own draft. It is
/// private until the reveal commits and can be taken back at any time before.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Readiness {
    participant_id: String,
    contribution_id: String,
    revision: u64,
}

/// What marking a revision ready did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadyOutcome {
    /// Recorded; nothing is visible until this many more participants are ready.
    Waiting { waiting_for: usize },
    /// The policy's condition was met and every ready participant's revision was revealed to the
    /// others in the same mutation.
    Revealed,
}

/// One author's place in a comparison, in the order the caller supplied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComparisonSlot {
    /// The requester's own latest revision.
    Own(DraftView),
    /// Another participant's revision that was revealed to the requester.
    Revealed(DraftView),
    /// Nothing the requester may read. It is the same for a missing, unrevealed, withdrawn, or
    /// unknown draft; `ready` only says whether that participant offered a revision.
    Private { ready: bool },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DraftSet {
    version: u8,
    participants: Vec<String>,
    drafts: Vec<Draft>,
    exchanges: Vec<Exchange>,
    #[serde(default)]
    policy: RevealPolicy,
    #[serde(default)]
    ready: Vec<Readiness>,
}

fn digest(owner: &str, contribution_id: &str, number: u64, markdown: &str) -> String {
    let mut hasher = Blake2s256::new();
    hasher.update(b"openblog-draft-revision-v1\0");
    for part in [owner, contribution_id] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    hasher.update(number.to_be_bytes());
    hasher.update(markdown.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_markdown(markdown: &str) -> bool {
    markdown.len() <= MAX_MARKDOWN_BYTES && !markdown.contains('\0')
}

impl DraftSet {
    /// An empty set for the publication's participants.
    pub fn new(participants: &[&str]) -> Result<Self, DraftError> {
        let set = Self {
            version: DRAFT_SET_VERSION,
            participants: participants.iter().map(|id| (*id).to_owned()).collect(),
            drafts: Vec::new(),
            exchanges: Vec::new(),
            policy: RevealPolicy::Independent,
            ready: Vec::new(),
        };
        if set.is_valid() {
            Ok(set)
        } else {
            Err(DraftError::Invalid)
        }
    }

    pub fn from_json(source: &str) -> Result<Self, DraftError> {
        if source.len() > MAX_DRAFT_SET_BYTES {
            return Err(DraftError::Invalid);
        }
        let set: Self = serde_json::from_str(source).map_err(|_| DraftError::Invalid)?;
        if set.is_valid() {
            Ok(set)
        } else {
            Err(DraftError::Invalid)
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("draft set serializes")
    }

    /// Admit a participant who joined after the set was created. Idempotent; a draft set only
    /// grows its membership, so removing someone's sign-in never deletes or exposes their draft.
    pub fn admit(&mut self, participant: &str) -> Result<(), DraftError> {
        if self.is_member(participant) {
            return Ok(());
        }
        if !valid_id(participant)
            || self.participants.len() >= MAX_PARTICIPANTS
            || self
                .participants
                .iter()
                .any(|p| p.eq_ignore_ascii_case(participant))
        {
            return Err(DraftError::Invalid);
        }
        self.participants.push(participant.to_owned());
        Ok(())
    }

    fn is_member(&self, id: &str) -> bool {
        self.participants
            .iter()
            .any(|participant| participant == id)
    }

    fn draft(&self, id: &str) -> Option<&Draft> {
        self.drafts
            .iter()
            .find(|draft| draft.id.eq_ignore_ascii_case(id))
    }

    fn stamp(draft: &Draft, revision: &Revision) -> RevisionStamp {
        RevisionStamp {
            contribution_id: draft.id.clone(),
            number: revision.number,
            author_participant_id: draft.owner.clone(),
            saved_at: DateTime::from_unix(revision.saved_at).rfc3339(),
            digest: revision.digest.clone(),
        }
    }

    /// Append a revision to the requester's own draft. `expected_revision` is the number the
    /// requester last saw (0 to create). On any error the set is unchanged.
    pub fn save(
        &mut self,
        requester: &str,
        contribution_id: &str,
        expected_revision: u64,
        markdown: &str,
        now: i64,
    ) -> Result<RevisionStamp, DraftError> {
        if !self.is_member(requester) {
            return Err(DraftError::Denied);
        }
        // Ids are unique ignoring ASCII case, so look up the same way `is_valid` checks.
        let existing = self.draft(contribution_id).map(|draft| {
            (
                draft.id.clone(),
                draft.owner == requester,
                draft.withdrawn,
                draft.revisions.len() as u64,
            )
        });
        let current = existing
            .as_ref()
            .map_or(0, |(_, _, _, revisions)| *revisions);
        let contribution_id = match &existing {
            Some((id, ..)) => id.as_str(),
            None => contribution_id,
        };
        match &existing {
            // Another participant's (or a withdrawn) draft answers exactly like a missing id
            // would for a non-creating save; only creating over a taken id is refused.
            Some((_, false, _, _)) if expected_revision != 0 => return Err(DraftError::Stale),
            Some((_, false, _, _)) | Some((_, true, true, _)) => return Err(DraftError::Denied),
            Some(_) => {}
            None if !valid_id(contribution_id) || self.drafts.len() >= MAX_CONTRIBUTIONS => {
                return Err(DraftError::Invalid)
            }
            None => {}
        }
        if !valid_markdown(markdown) {
            return Err(DraftError::Invalid);
        }
        if current != expected_revision {
            return Err(DraftError::Stale);
        }
        if current as usize >= MAX_REVISIONS_PER_DRAFT {
            return Err(DraftError::LimitReached);
        }
        let number = current + 1;
        let revision = Revision {
            number,
            saved_at: now,
            digest: digest(requester, contribution_id, number, markdown),
            markdown: markdown.to_owned(),
        };
        if current == 0 {
            self.drafts.push(Draft {
                id: contribution_id.to_owned(),
                owner: requester.to_owned(),
                withdrawn: false,
                revisions: Vec::new(),
            });
        }
        let draft = self
            .drafts
            .iter_mut()
            .find(|draft| draft.id == contribution_id)
            .expect("draft exists");
        draft.revisions.push(revision);
        // The stored file, with its trailing newline, must always load again, so a save that
        // would outgrow the limit is undone and nothing changes.
        if self.to_json().len() >= MAX_DRAFT_SET_BYTES {
            let draft = self
                .drafts
                .iter_mut()
                .find(|draft| draft.id == contribution_id)
                .expect("draft exists");
            draft.revisions.pop();
            if current == 0 {
                self.drafts.pop();
            }
            return Err(DraftError::LimitReached);
        }
        let draft = self
            .drafts
            .iter()
            .find(|draft| draft.id == contribution_id)
            .expect("draft exists");
        Ok(Self::stamp(draft, draft.revisions.last().expect("pushed")))
    }

    /// Withdraw the requester's own draft from every other participant. Revisions stay for the
    /// owner; copies already read cannot be recalled. A withdrawn draft accepts no new revision
    /// or commitment, and withdrawing never changes the contract or any approval.
    pub fn withdraw(&mut self, requester: &str, contribution_id: &str) -> Result<(), DraftError> {
        let draft = self
            .drafts
            .iter_mut()
            .find(|draft| {
                draft.id.eq_ignore_ascii_case(contribution_id) && draft.owner == requester
            })
            .ok_or(DraftError::Denied)?;
        draft.withdrawn = true;
        let contribution_id = draft.id.clone();
        self.ready
            .retain(|r| !r.contribution_id.eq_ignore_ascii_case(&contribution_id));
        for exchange in &mut self.exchanges {
            if exchange.state == ExchangeState::Pending {
                exchange
                    .commitments
                    .retain(|c| c.contribution_id != contribution_id);
            }
        }
        Ok(())
    }

    /// Read a draft: the owner sees the latest revision; another participant sees only the exact
    /// revision committed to a completed exchange that lists them, or, under the voluntary policy,
    /// the exact revision the author currently offers while the reader also has a standing offer
    /// and both are in `active`. A withdrawn draft is never shown. Anything else is
    /// [`DraftError::Denied`].
    pub fn view(
        &self,
        requester: &str,
        contribution_id: &str,
        active: &[&str],
    ) -> Result<DraftView, DraftError> {
        if !self.is_member(requester) {
            return Err(DraftError::Denied);
        }
        let draft = self.draft(contribution_id).ok_or(DraftError::Denied)?;
        let number = if draft.owner == requester {
            draft.revisions.len() as u64
        } else if draft.withdrawn {
            return Err(DraftError::Denied);
        } else {
            let exchanged = self
                .exchanges
                .iter()
                .filter(|e| e.state == ExchangeState::Revealed)
                .filter(|e| e.members.iter().any(|m| m == requester))
                .flat_map(|e| &e.commitments)
                .filter(|c| c.contribution_id.eq_ignore_ascii_case(contribution_id))
                .map(|c| c.revision)
                .max();
            exchanged
                .max(self.offered_revision(requester, contribution_id, active))
                .ok_or(DraftError::Denied)?
        };
        let revision = draft
            .revisions
            .iter()
            .find(|revision| revision.number == number)
            .ok_or(DraftError::Denied)?;
        Ok(DraftView {
            stamp: Self::stamp(draft, revision),
            markdown: revision.markdown.clone(),
        })
    }

    /// The stamp of a draft's latest revision, or none for an unknown or withdrawn draft. It is
    /// prose-free and says nothing about who may read the revision.
    pub fn current_stamp(&self, contribution_id: &str) -> Option<RevisionStamp> {
        let draft = self
            .draft(contribution_id)
            .filter(|draft| !draft.withdrawn)?;
        draft
            .revisions
            .last()
            .map(|revision| Self::stamp(draft, revision))
    }

    /// The latest revision with its prose, or none for an unknown or withdrawn draft. This
    /// ignores who may read it, so it is crate-private: only the publish gate calls it, after
    /// every required approval has been checked against exactly these revisions (ADR 0022).
    pub(crate) fn latest_view(&self, contribution_id: &str) -> Option<DraftView> {
        let draft = self
            .draft(contribution_id)
            .filter(|draft| !draft.withdrawn)?;
        let revision = draft.revisions.last()?;
        Some(DraftView {
            stamp: Self::stamp(draft, revision),
            markdown: revision.markdown.clone(),
        })
    }

    /// The revision of `contribution_id` that the voluntary policy shows `requester`, derived
    /// from standing offers alone. Exchanges never feed it.
    fn offered_revision(
        &self,
        requester: &str,
        contribution_id: &str,
        active: &[&str],
    ) -> Option<u64> {
        let live = |id: &str| active.contains(&id) && self.is_member(id);
        if self.policy != RevealPolicy::Voluntary
            || !live(requester)
            || !self.ready.iter().any(|r| r.participant_id == requester)
        {
            return None;
        }
        self.ready
            .iter()
            .find(|r| {
                r.participant_id != requester
                    && r.contribution_id.eq_ignore_ascii_case(contribution_id)
                    && live(&r.participant_id)
            })
            .map(|r| r.revision)
    }

    /// Open a mutual reveal among two or more participants, the requester included.
    pub fn open_exchange(
        &mut self,
        requester: &str,
        exchange_id: &str,
        members: &[&str],
    ) -> Result<ExchangeStatus, DraftError> {
        if !self.is_member(requester) || !members.contains(&requester) {
            return Err(DraftError::Denied);
        }
        let unique: HashSet<&str> = members.iter().copied().collect();
        if members.len() < 2
            || unique.len() != members.len()
            || members.len() > MAX_PARTICIPANTS
            || !members.iter().all(|m| self.is_member(m))
            || !valid_id(exchange_id)
            || self.exchanges.iter().any(|e| e.id == exchange_id)
            || self.exchanges.len() >= MAX_EXCHANGES
        {
            return Err(DraftError::Invalid);
        }
        self.exchanges.push(Exchange {
            id: exchange_id.to_owned(),
            members: members.iter().map(|m| (*m).to_owned()).collect(),
            state: ExchangeState::Pending,
            commitments: Vec::new(),
        });
        Ok(ExchangeStatus::Pending {
            waiting_for: members.len(),
        })
    }

    /// Commit one exact revision of the requester's own draft to a pending exchange. Replaces
    /// an earlier commitment of the same member. The last commitment reveals for everyone at once.
    pub fn commit(
        &mut self,
        requester: &str,
        exchange_id: &str,
        contribution_id: &str,
        revision: u64,
    ) -> Result<ExchangeStatus, DraftError> {
        let canonical = self.draft(contribution_id).map(|d| d.id.clone());
        let contribution_id = canonical.as_deref().unwrap_or(contribution_id);
        let draft_ok = self.draft(contribution_id).is_some_and(|draft| {
            draft.owner == requester
                && !draft.withdrawn
                && revision >= 1
                && revision <= draft.revisions.len() as u64
        });
        let exchange = self
            .exchanges
            .iter_mut()
            .find(|e| e.id == exchange_id && e.members.iter().any(|m| m == requester))
            .ok_or(DraftError::Denied)?;
        if !draft_ok || exchange.state != ExchangeState::Pending {
            return Err(DraftError::Denied);
        }
        exchange
            .commitments
            .retain(|c| c.participant_id != requester);
        exchange.commitments.push(Commitment {
            participant_id: requester.to_owned(),
            contribution_id: contribution_id.to_owned(),
            revision,
        });
        if exchange.commitments.len() == exchange.members.len() {
            exchange.state = ExchangeState::Revealed;
            return Ok(ExchangeStatus::Revealed);
        }
        Ok(ExchangeStatus::Pending {
            waiting_for: exchange.members.len() - exchange.commitments.len(),
        })
    }

    /// Take back the requester's commitment from a pending exchange.
    pub fn retract(
        &mut self,
        requester: &str,
        exchange_id: &str,
    ) -> Result<ExchangeStatus, DraftError> {
        let exchange = self
            .exchanges
            .iter_mut()
            .find(|e| {
                e.id == exchange_id
                    && e.state == ExchangeState::Pending
                    && e.members.iter().any(|m| m == requester)
            })
            .ok_or(DraftError::Denied)?;
        exchange
            .commitments
            .retain(|c| c.participant_id != requester);
        Ok(ExchangeStatus::Pending {
            waiting_for: exchange.members.len() - exchange.commitments.len(),
        })
    }

    /// Cancel a pending exchange; any member may. A revealed exchange cannot be undone.
    pub fn cancel(&mut self, requester: &str, exchange_id: &str) -> Result<(), DraftError> {
        let exchange = self
            .exchanges
            .iter_mut()
            .find(|e| {
                e.id == exchange_id
                    && e.state == ExchangeState::Pending
                    && e.members.iter().any(|m| m == requester)
            })
            .ok_or(DraftError::Denied)?;
        exchange.state = ExchangeState::Cancelled;
        exchange.commitments.clear();
        Ok(())
    }

    pub fn policy(&self) -> RevealPolicy {
        self.policy
    }

    /// Change how drafts may be revealed. Existing offers are cleared, never carried into the new
    /// policy, so changing it cannot reveal prose nobody offered under it, and it never reveals
    /// anything itself. Authorization is the caller's job.
    pub fn set_policy(&mut self, policy: RevealPolicy) {
        if self.policy != policy {
            self.policy = policy;
            self.ready.clear();
        }
    }

    pub fn is_ready(&self, participant: &str) -> bool {
        self.ready.iter().any(|r| r.participant_id == participant)
    }

    /// Offer one exact revision of the requester's own draft for reveal. `active` lists the
    /// participants who currently hold access; a participant who lost it neither counts toward
    /// nor receives a reveal. Replaces an earlier offer. Under the all-ready policy, when every
    /// active participant has offered, all offers are committed as one revealed exchange. Under
    /// the voluntary policy the offer simply stands and visibility is derived by [`DraftSet::view`];
    /// the outcome is `Revealed` only when another active participant has a standing offer. On any
    /// error the set is unchanged.
    pub fn mark_ready(
        &mut self,
        requester: &str,
        revision: u64,
        active: &[&str],
    ) -> Result<ReadyOutcome, DraftError> {
        if !self.is_member(requester) || !active.contains(&requester) {
            return Err(DraftError::Denied);
        }
        if self.policy == RevealPolicy::Independent {
            return Err(DraftError::Invalid);
        }
        let contribution_id = self
            .drafts
            .iter()
            .find(|d| {
                d.owner == requester
                    && !d.withdrawn
                    && revision >= 1
                    && revision <= d.revisions.len() as u64
            })
            .map(|d| d.id.clone())
            .ok_or(DraftError::Denied)?;
        let mut next = self.clone();
        next.ready.retain(|r| r.participant_id != requester);
        next.ready.push(Readiness {
            participant_id: requester.to_owned(),
            contribution_id,
            revision,
        });
        if next.policy == RevealPolicy::Voluntary {
            // Nothing is stored beyond the offer: who sees what is derived when a draft is read.
            let others = next
                .ready
                .iter()
                .filter(|r| {
                    r.participant_id != requester
                        && active.contains(&r.participant_id.as_str())
                        && next.is_member(&r.participant_id)
                })
                .count();
            if !next.is_valid() {
                return Err(DraftError::Invalid);
            }
            *self = next;
            return Ok(if others > 0 {
                ReadyOutcome::Revealed
            } else {
                ReadyOutcome::Waiting { waiting_for: 1 }
            });
        }
        let group: Vec<Readiness> = next
            .ready
            .iter()
            .filter(|r| active.contains(&r.participant_id.as_str()))
            .cloned()
            .collect();
        let needed = active.iter().filter(|a| self.is_member(a)).count().max(2);
        let waiting_for = needed.saturating_sub(group.len());
        if waiting_for > 0 {
            *self = next;
            return Ok(ReadyOutcome::Waiting { waiting_for });
        }
        if next.exchanges.len() >= MAX_EXCHANGES {
            return Err(DraftError::LimitReached);
        }
        let mut number = next.exchanges.len() + 1;
        while next
            .exchanges
            .iter()
            .any(|e| e.id == format!("reveal-{number}"))
        {
            number += 1;
        }
        next.exchanges.push(Exchange {
            id: format!("reveal-{number}"),
            members: group.iter().map(|r| r.participant_id.clone()).collect(),
            state: ExchangeState::Revealed,
            commitments: group
                .iter()
                .map(|r| Commitment {
                    participant_id: r.participant_id.clone(),
                    contribution_id: r.contribution_id.clone(),
                    revision: r.revision,
                })
                .collect(),
        });
        next.ready
            .retain(|r| !group.iter().any(|g| g.participant_id == r.participant_id));
        if !next.is_valid() {
            return Err(DraftError::Invalid);
        }
        *self = next;
        Ok(ReadyOutcome::Revealed)
    }

    /// Take back the requester's offer. Idempotent, and a no-op once the reveal has committed:
    /// a reveal cannot be undone.
    pub fn unready(&mut self, requester: &str) -> Result<(), DraftError> {
        if !self.is_member(requester) {
            return Err(DraftError::Denied);
        }
        self.ready.retain(|r| r.participant_id != requester);
        Ok(())
    }

    /// The requester's side-by-side view: one slot per participant in `order`, each either the
    /// requester's own latest revision, a revision revealed to the requester, or a placeholder.
    /// Slots are decided by [`DraftSet::view`] alone, so a comparison never shows more than
    /// reading each draft would.
    pub fn compare(
        &self,
        requester: &str,
        order: &[&str],
        active: &[&str],
    ) -> Result<Vec<ComparisonSlot>, DraftError> {
        if !self.is_member(requester) {
            return Err(DraftError::Denied);
        }
        Ok(order
            .iter()
            .map(|participant| {
                let readable = self
                    .drafts
                    .iter()
                    .filter(|d| d.owner == *participant)
                    .find_map(|d| self.view(requester, &d.id, active).ok());
                match readable {
                    Some(view) if *participant == requester => ComparisonSlot::Own(view),
                    Some(view) => ComparisonSlot::Revealed(view),
                    None => ComparisonSlot::Private {
                        ready: self.is_ready(participant),
                    },
                }
            })
            .collect())
    }

    fn is_valid(&self) -> bool {
        if self.version != DRAFT_SET_VERSION
            || self.participants.is_empty()
            || self.participants.len() > MAX_PARTICIPANTS
            || self.drafts.len() > MAX_CONTRIBUTIONS
            || self.exchanges.len() > MAX_EXCHANGES
        {
            return false;
        }
        let mut seen = HashSet::new();
        if !self
            .participants
            .iter()
            .all(|p| valid_id(p) && seen.insert(p.to_ascii_lowercase()))
        {
            return false;
        }
        let mut ids = HashSet::new();
        for draft in &self.drafts {
            if !valid_id(&draft.id)
                || !ids.insert(draft.id.to_ascii_lowercase())
                || !self.is_member(&draft.owner)
                || draft.revisions.is_empty()
                || draft.revisions.len() > MAX_REVISIONS_PER_DRAFT
            {
                return false;
            }
            for (index, revision) in draft.revisions.iter().enumerate() {
                let number = index as u64 + 1;
                if revision.number != number
                    || !valid_markdown(&revision.markdown)
                    || revision.digest
                        != digest(&draft.owner, &draft.id, number, &revision.markdown)
                {
                    return false;
                }
            }
        }
        let mut offered = HashSet::new();
        for offer in &self.ready {
            let owned = self.draft(&offer.contribution_id).is_some_and(|d| {
                d.owner == offer.participant_id
                    && !d.withdrawn
                    && offer.revision >= 1
                    && offer.revision <= d.revisions.len() as u64
            });
            if !owned
                || self.policy == RevealPolicy::Independent
                || !offered.insert(offer.participant_id.as_str())
            {
                return false;
            }
        }
        let mut exchange_ids = HashSet::new();
        for exchange in &self.exchanges {
            let members: HashSet<&str> = exchange.members.iter().map(String::as_str).collect();
            let mut committed = HashSet::new();
            if !valid_id(&exchange.id)
                || !exchange_ids.insert(exchange.id.as_str())
                || exchange.members.len() < 2
                || members.len() != exchange.members.len()
                || !members.iter().all(|m| self.is_member(m))
            {
                return false;
            }
            for c in &exchange.commitments {
                let owned = self.draft(&c.contribution_id).is_some_and(|d| {
                    d.owner == c.participant_id
                        && c.revision >= 1
                        && c.revision <= d.revisions.len() as u64
                });
                if !owned
                    || !members.contains(c.participant_id.as_str())
                    || !committed.insert(c.participant_id.as_str())
                {
                    return false;
                }
            }
            let complete = exchange.commitments.len() == exchange.members.len();
            let consistent = match exchange.state {
                ExchangeState::Pending => !complete,
                ExchangeState::Revealed => complete,
                ExchangeState::Cancelled => exchange.commitments.is_empty(),
            };
            if !consistent {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_800_000_000;

    fn set(ids: &[&str]) -> DraftSet {
        DraftSet::new(ids).unwrap()
    }

    #[test]
    fn saving_stops_before_the_set_outgrows_what_can_be_loaded() {
        let mut draft_set = set(&["mikey"]);
        let heavy = "\u{1}".repeat(MAX_MARKDOWN_BYTES);
        let mut saved = 0;
        let outcome = loop {
            match draft_set.save("mikey", "mikey", saved, &heavy, T) {
                Ok(_) => saved += 1,
                Err(error) => break error,
            }
        };
        assert_eq!(outcome, DraftError::LimitReached);
        assert!(saved > 1 && (saved as usize) < MAX_REVISIONS_PER_DRAFT);
        let text = draft_set.to_json();
        assert!(text.len() < MAX_DRAFT_SET_BYTES);
        assert_eq!(DraftSet::from_json(&text).unwrap(), draft_set);
    }

    #[test]
    fn the_revision_limit_has_its_own_outcome() {
        let mut draft_set = set(&["mikey"]);
        for number in 0..MAX_REVISIONS_PER_DRAFT as u64 {
            draft_set.save("mikey", "mikey", number, "a", T).unwrap();
        }
        assert_eq!(
            draft_set.save("mikey", "mikey", MAX_REVISIONS_PER_DRAFT as u64, "a", T),
            Err(DraftError::LimitReached)
        );
    }

    #[test]
    fn solo_owner_saves_reads_and_conflicts_on_stale() {
        let mut s = set(&["ada"]);
        let one = s.save("ada", "c1", 0, "first", T).unwrap();
        assert_eq!((one.number, one.author_participant_id.as_str()), (1, "ada"));
        assert_eq!(s.save("ada", "c1", 0, "again", T), Err(DraftError::Stale));
        let two = s.save("ada", "c1", 1, "second", T + 1).unwrap();
        assert_ne!(one.digest, two.digest);
        let view = s.view("ada", "c1", &ALL).unwrap();
        assert_eq!((view.stamp.number, view.markdown.as_str()), (2, "second"));
        assert_eq!(s.save("ada", "c1", 5, "x", T), Err(DraftError::Stale));
        assert_eq!(
            s.open_exchange("ada", "e1", &["ada"]),
            Err(DraftError::Invalid)
        );
    }

    #[test]
    fn stamp_has_no_prose_and_debug_hides_it() {
        let mut s = set(&["ada"]);
        let stamp = s.save("ada", "c1", 0, "secret prose", T).unwrap();
        assert!(!serde_json::to_string(&stamp).unwrap().contains("secret"));
        assert!(!format!("{:?}", s.view("ada", "c1", &ALL).unwrap()).contains("secret"));
        assert!(!format!("{s:?}").contains("secret"));
        assert_eq!(stamp.saved_at, DateTime::from_unix(T).rfc3339());
    }

    #[test]
    fn case_variant_ids_cannot_collide_and_the_set_reloads() {
        let mut s = set(&["ada", "bo"]);
        s.save("ada", "c1", 0, "mine", T).unwrap();
        assert_eq!(s.save("bo", "C1", 0, "x", T), Err(DraftError::Denied));
        assert_eq!(s.save("ada", "C1", 1, "again", T).unwrap().number, 2);
        let reloaded = DraftSet::from_json(&s.to_json()).unwrap();
        assert_eq!(reloaded.view("ada", "c1", &ALL).unwrap().stamp.number, 2);
    }

    #[test]
    fn foreign_and_missing_ids_answer_alike_for_non_creating_saves() {
        let mut s = set(&["ada", "bo"]);
        s.save("ada", "c1", 0, "private", T).unwrap();
        let before = s.to_json();
        assert_eq!(
            s.save("bo", "c1", 9, "x", T),
            s.save("bo", "nope", 9, "x", T)
        );
        assert_eq!(
            s.save("bo", "c1", 1, "x", T),
            s.save("bo", "nope", 1, "x", T)
        );
        assert_eq!(s.to_json(), before);
    }

    #[test]
    fn digest_binds_author_and_content() {
        let mut s = set(&["ada", "bo"]);
        let a = s.save("ada", "c1", 0, "same", T).unwrap();
        let b = s.save("bo", "c2", 0, "same", T).unwrap();
        assert_ne!(a.digest, b.digest);
    }

    #[test]
    fn others_never_see_unrevealed_and_errors_are_uniform() {
        let mut s = set(&["ada", "bo"]);
        s.save("ada", "c1", 0, "private", T).unwrap();
        let missing = s.view("bo", "nope", &ALL).unwrap_err();
        assert_eq!(s.view("bo", "c1", &ALL), Err(missing));
        assert_eq!(s.view("mallory", "c1", &ALL), Err(DraftError::Denied));
        assert_eq!(s.save("bo", "c1", 0, "hijack", T), Err(DraftError::Denied));
        assert_eq!(s.save("bo", "c1", 9, "probe", T), Err(DraftError::Stale));
        assert_eq!(s.save("mallory", "c9", 0, "x", T), Err(DraftError::Denied));
        assert_eq!(s.withdraw("bo", "c1"), Err(DraftError::Denied));
    }

    #[test]
    fn pair_reveal_is_all_or_nothing_and_binds_exact_revision() {
        let mut s = set(&["ada", "bo"]);
        s.save("ada", "a", 0, "ada v1", T).unwrap();
        s.save("bo", "b", 0, "bo v1", T).unwrap();
        s.open_exchange("ada", "e1", &["ada", "bo"]).unwrap();
        assert_eq!(
            s.commit("ada", "e1", "a", 1).unwrap(),
            ExchangeStatus::Pending { waiting_for: 1 }
        );
        assert_eq!(s.view("bo", "a", &ALL), Err(DraftError::Denied));
        assert_eq!(s.view("ada", "b", &ALL), Err(DraftError::Denied));
        assert_eq!(
            s.commit("bo", "e1", "b", 1).unwrap(),
            ExchangeStatus::Revealed
        );
        assert_eq!(s.view("bo", "a", &ALL).unwrap().markdown, "ada v1");
        assert_eq!(s.view("ada", "b", &ALL).unwrap().markdown, "bo v1");
        // Later edits stay private: the recipient still sees the committed revision.
        s.save("ada", "a", 1, "ada v2", T + 5).unwrap();
        assert_eq!(s.view("bo", "a", &ALL).unwrap().markdown, "ada v1");
        assert_eq!(s.view("ada", "a", &ALL).unwrap().markdown, "ada v2");
        assert_eq!(s.commit("ada", "e1", "a", 2), Err(DraftError::Denied));
    }

    #[test]
    fn reveal_excludes_non_members() {
        let mut s = set(&["ada", "bo", "cy"]);
        s.save("ada", "a", 0, "A", T).unwrap();
        s.save("bo", "b", 0, "B", T).unwrap();
        s.open_exchange("ada", "e1", &["ada", "bo"]).unwrap();
        s.commit("ada", "e1", "a", 1).unwrap();
        s.commit("bo", "e1", "b", 1).unwrap();
        assert_eq!(s.view("cy", "a", &ALL), Err(DraftError::Denied));
        assert_eq!(s.commit("cy", "e1", "a", 1), Err(DraftError::Denied));
        assert_eq!(
            s.open_exchange("cy", "e2", &["ada", "bo"]),
            Err(DraftError::Denied)
        );
    }

    #[test]
    fn group_of_three_waits_for_everyone() {
        let mut s = set(&["ada", "bo", "cy"]);
        for (who, id) in [("ada", "a"), ("bo", "b"), ("cy", "c")] {
            s.save(who, id, 0, id, T).unwrap();
        }
        s.open_exchange("cy", "g", &["ada", "bo", "cy"]).unwrap();
        s.commit("ada", "g", "a", 1).unwrap();
        s.commit("bo", "g", "b", 1).unwrap();
        assert_eq!(s.view("ada", "b", &ALL), Err(DraftError::Denied));
        assert_eq!(
            s.commit("cy", "g", "c", 1).unwrap(),
            ExchangeStatus::Revealed
        );
        assert_eq!(s.view("ada", "c", &ALL).unwrap().markdown, "c");
        assert_eq!(s.view("cy", "a", &ALL).unwrap().markdown, "a");
    }

    #[test]
    fn interrupted_reveal_exposes_nothing() {
        let mut s = set(&["ada", "bo"]);
        s.save("ada", "a", 0, "A", T).unwrap();
        s.open_exchange("ada", "e1", &["ada", "bo"]).unwrap();
        s.commit("ada", "e1", "a", 1).unwrap();
        // Persisted mid-reveal and reloaded: still pending, still private.
        let mut s = DraftSet::from_json(&s.to_json()).unwrap();
        assert_eq!(s.view("bo", "a", &ALL), Err(DraftError::Denied));
        assert_eq!(
            s.retract("ada", "e1").unwrap(),
            ExchangeStatus::Pending { waiting_for: 2 }
        );
        s.commit("ada", "e1", "a", 1).unwrap();
        s.cancel("bo", "e1").unwrap();
        assert_eq!(s.view("bo", "a", &ALL), Err(DraftError::Denied));
        assert_eq!(s.commit("ada", "e1", "a", 1), Err(DraftError::Denied));
    }

    #[test]
    fn withdrawal_hides_from_others_and_clears_pending_commitments() {
        let mut s = set(&["ada", "bo"]);
        s.save("ada", "a", 0, "A", T).unwrap();
        s.save("bo", "b", 0, "B", T).unwrap();
        s.open_exchange("ada", "e1", &["ada", "bo"]).unwrap();
        s.commit("ada", "e1", "a", 1).unwrap();
        s.withdraw("ada", "a").unwrap();
        assert_eq!(
            s.commit("bo", "e1", "b", 1).unwrap(),
            ExchangeStatus::Pending { waiting_for: 1 }
        );
        assert_eq!(s.commit("ada", "e1", "a", 1), Err(DraftError::Denied));

        s.open_exchange("bo", "e2", &["ada", "bo"]).unwrap();
        s.commit("bo", "e2", "b", 1).unwrap();
        s.save("ada", "a2", 0, "A2", T).unwrap();
        s.commit("ada", "e2", "a2", 1).unwrap();
        assert_eq!(s.view("ada", "b", &ALL).unwrap().markdown, "B");
        s.withdraw("bo", "b").unwrap();
        assert_eq!(s.view("ada", "b", &ALL), Err(DraftError::Denied));
        assert_eq!(s.view("bo", "b", &ALL).unwrap().markdown, "B");
        assert_eq!(s.save("bo", "b", 1, "B2", T), Err(DraftError::Denied));
    }

    #[test]
    fn failed_operations_leave_the_set_unchanged() {
        let mut s = set(&["ada", "bo"]);
        s.save("ada", "a", 0, "A", T).unwrap();
        let before = s.clone();
        assert!(s.save("ada", "a", 0, "x", T).is_err());
        assert!(s.save("ada", "a", 1, "nul\0", T).is_err());
        assert!(s.save("ada", "Bad Id", 0, "x", T).is_err());
        let big = "x".repeat(MAX_MARKDOWN_BYTES + 1);
        assert!(s.save("ada", "big", 0, &big, T).is_err());
        assert!(s.open_exchange("ada", "e", &["ada", "ada"]).is_err());
        assert!(s.open_exchange("ada", "e", &["ada", "ghost"]).is_err());
        assert!(s.commit("ada", "nope", "a", 1).is_err());
        assert_eq!(s, before);
    }

    #[test]
    fn untrusted_json_fails_closed() {
        let mut s = set(&["ada", "bo"]);
        s.save("ada", "a", 0, "A", T).unwrap();
        let good = s.to_json();
        assert!(DraftSet::from_json(&good).is_ok());
        assert!(DraftSet::from_json(&good.replace("\"A\"", "\"tampered\"")).is_err());
        let ghost = good.replace("\"owner\":\"ada\"", "\"owner\":\"ghost\"");
        assert!(DraftSet::from_json(&ghost).is_err());
        let v2 = good.replace("\"version\":1", "\"version\":2");
        assert!(DraftSet::from_json(&v2).is_err());
        assert!(DraftSet::from_json("{\"extra\":1}").is_err());
        assert!(DraftSet::from_json("nope").is_err());
        let revealed = good.replace(
            "\"exchanges\":[]",
            "\"exchanges\":[{\"id\":\"e\",\"members\":[\"ada\",\"bo\"],\"state\":\"revealed\",\"commitments\":[]}]",
        );
        assert!(DraftSet::from_json(&revealed).is_err());
    }

    #[test]
    fn reveal_changes_no_contract_approval() {
        use crate::collaboration::CollaborationContract;
        let source = r#"{"version":1,"revision":1,"participants":[{"id":"ada","displayName":"Ada"},{"id":"bo","displayName":"Bo"}],"contributions":[],"reveals":[],"layout":[],"approvals":[]}"#;
        let contract = CollaborationContract::from_json(source).unwrap();
        let mut s = set(&["ada", "bo"]);
        s.save("ada", "a", 0, "A", T).unwrap();
        s.save("bo", "b", 0, "B", T).unwrap();
        s.open_exchange("ada", "e", &["ada", "bo"]).unwrap();
        s.commit("ada", "e", "a", 1).unwrap();
        s.commit("bo", "e", "b", 1).unwrap();
        // The draft set holds no approval state and cannot reach the contract.
        assert!(contract.approvals.is_empty());
    }

    #[test]
    fn a_later_participant_can_be_admitted_without_touching_existing_drafts() {
        let mut s = set(&["ada"]);
        s.save("ada", "ada", 0, "mine", T).unwrap();
        assert_eq!(s.save("bo", "bo", 0, "x", T), Err(DraftError::Denied));
        s.admit("bo").unwrap();
        s.admit("bo").unwrap();
        assert_eq!(s.admit("not valid!"), Err(DraftError::Invalid));
        s.save("bo", "bo", 0, "theirs", T).unwrap();
        assert_eq!(s.view("ada", "ada", &ALL).unwrap().markdown, "mine");
        assert_eq!(s.view("ada", "bo", &ALL), Err(DraftError::Denied));
        assert!(DraftSet::from_json(&s.to_json()).is_ok());
    }

    fn ready_set(policy: RevealPolicy) -> DraftSet {
        let mut s = set(&["ada", "bo", "cy"]);
        s.set_policy(policy);
        for (who, text) in [("ada", "ADA-1"), ("bo", "BO-1"), ("cy", "CY-1")] {
            s.save(who, who, 0, text, T).unwrap();
        }
        s
    }

    const ALL: [&str; 3] = ["ada", "bo", "cy"];

    #[test]
    fn independent_policy_never_reveals_and_refuses_readiness() {
        let mut s = ready_set(RevealPolicy::Independent);
        let before = s.to_json();
        assert_eq!(s.mark_ready("ada", 1, &ALL), Err(DraftError::Invalid));
        assert_eq!(s.to_json(), before);
        assert_eq!(s.view("bo", "ada", &ALL), Err(DraftError::Denied));
    }

    const ALL4: [&str; 4] = ["ada", "bo", "cy", "di"];

    fn four(policy: RevealPolicy) -> DraftSet {
        let mut s = ready_set(policy);
        s.admit("di").unwrap();
        s.save("di", "di", 0, "DI-1", T).unwrap();
        s
    }

    fn sees(s: &DraftSet, viewer: &str, author: &str, active: &[&str]) -> Option<String> {
        s.view(viewer, author, active).ok().map(|v| v.markdown)
    }

    #[test]
    fn voluntary_reveals_when_two_offer_and_a_late_joiner_sees_and_is_seen() {
        let mut s = ready_set(RevealPolicy::Voluntary);
        assert_eq!(
            s.mark_ready("ada", 1, &ALL),
            Ok(ReadyOutcome::Waiting { waiting_for: 1 })
        );
        assert_eq!(s.view("bo", "ada", &ALL), Err(DraftError::Denied));
        assert_eq!(s.mark_ready("bo", 1, &ALL), Ok(ReadyOutcome::Revealed));
        assert_eq!(sees(&s, "bo", "ada", &ALL).as_deref(), Some("ADA-1"));
        assert_eq!(sees(&s, "ada", "bo", &ALL).as_deref(), Some("BO-1"));
        // Not ready yet: sees nothing and is seen by no one.
        assert_eq!(s.view("cy", "ada", &ALL), Err(DraftError::Denied));
        assert_eq!(s.view("ada", "cy", &ALL), Err(DraftError::Denied));
        // The late joiner sees earlier offers, and earlier members see the late joiner.
        assert_eq!(s.mark_ready("cy", 1, &ALL), Ok(ReadyOutcome::Revealed));
        assert_eq!(sees(&s, "cy", "ada", &ALL).as_deref(), Some("ADA-1"));
        assert_eq!(sees(&s, "cy", "bo", &ALL).as_deref(), Some("BO-1"));
        assert_eq!(sees(&s, "ada", "cy", &ALL).as_deref(), Some("CY-1"));
        assert_eq!(sees(&s, "bo", "cy", &ALL).as_deref(), Some("CY-1"));
        // Nothing is stored beyond the offers.
        assert!(s.exchanges.is_empty());
        assert!(DraftSet::from_json(&s.to_json()).is_ok());
    }

    #[test]
    fn retracting_readiness_ends_visibility_both_ways() {
        let mut s = ready_set(RevealPolicy::Voluntary);
        s.mark_ready("ada", 1, &ALL).unwrap();
        s.mark_ready("bo", 1, &ALL).unwrap();
        s.unready("bo").unwrap();
        assert_eq!(s.view("bo", "ada", &ALL), Err(DraftError::Denied));
        assert_eq!(s.view("ada", "bo", &ALL), Err(DraftError::Denied));
    }

    #[test]
    fn a_late_joiner_who_is_not_active_or_is_withdrawn_stays_out() {
        let mut s = ready_set(RevealPolicy::Voluntary);
        s.mark_ready("ada", 1, &ALL).unwrap();
        s.mark_ready("bo", 1, &ALL).unwrap();
        assert_eq!(
            s.mark_ready("cy", 1, &["ada", "bo"]),
            Err(DraftError::Denied)
        );
        s.withdraw("cy", "cy").unwrap();
        assert_eq!(s.mark_ready("cy", 1, &ALL), Err(DraftError::Denied));
        assert_eq!(s.view("ada", "cy", &ALL), Err(DraftError::Denied));
        assert_eq!(s.view("cy", "ada", &ALL), Err(DraftError::Denied));
    }

    #[test]
    fn a_removed_member_is_excluded_both_ways_and_rejoins_when_restored() {
        let mut s = ready_set(RevealPolicy::Voluntary);
        s.mark_ready("ada", 1, &ALL).unwrap();
        s.mark_ready("bo", 1, &ALL).unwrap();
        let without_bo = ["ada", "cy"];
        assert_eq!(
            s.mark_ready("cy", 1, &without_bo),
            Ok(ReadyOutcome::Revealed)
        );
        assert_eq!(s.view("bo", "ada", &without_bo), Err(DraftError::Denied));
        assert_eq!(s.view("bo", "cy", &without_bo), Err(DraftError::Denied));
        assert_eq!(s.view("ada", "bo", &without_bo), Err(DraftError::Denied));
        assert_eq!(s.view("cy", "bo", &without_bo), Err(DraftError::Denied));
        assert_eq!(sees(&s, "cy", "ada", &without_bo).as_deref(), Some("ADA-1"));
        // Restored with the offer still standing, bo is back in the one author set.
        assert_eq!(sees(&s, "bo", "ada", &ALL).as_deref(), Some("ADA-1"));
        assert_eq!(sees(&s, "bo", "cy", &ALL).as_deref(), Some("CY-1"));
        assert_eq!(sees(&s, "cy", "bo", &ALL).as_deref(), Some("BO-1"));
        assert!(DraftSet::from_json(&s.to_json()).is_ok());
    }

    #[test]
    fn a_withdrawn_member_is_excluded_both_ways() {
        let mut s = ready_set(RevealPolicy::Voluntary);
        s.mark_ready("ada", 1, &ALL).unwrap();
        s.mark_ready("bo", 1, &ALL).unwrap();
        s.withdraw("bo", "bo").unwrap();
        assert_eq!(s.mark_ready("cy", 1, &ALL), Ok(ReadyOutcome::Revealed));
        assert_eq!(s.view("bo", "cy", &ALL), Err(DraftError::Denied));
        assert_eq!(s.view("bo", "ada", &ALL), Err(DraftError::Denied));
        assert_eq!(s.view("cy", "bo", &ALL), Err(DraftError::Denied));
        assert_eq!(sees(&s, "cy", "ada", &ALL).as_deref(), Some("ADA-1"));
        assert_eq!(sees(&s, "ada", "cy", &ALL).as_deref(), Some("CY-1"));
        s.save("cy", "cy", 1, "CY-2", T + 1).unwrap();
        s.mark_ready("cy", 2, &ALL).unwrap();
        assert_eq!(s.view("bo", "cy", &ALL), Err(DraftError::Denied));
        assert!(DraftSet::from_json(&s.to_json()).is_ok());
    }

    #[test]
    fn a_newcomer_alone_with_only_inactive_offers_waits() {
        let mut s = ready_set(RevealPolicy::Voluntary);
        s.mark_ready("ada", 1, &ALL).unwrap();
        s.mark_ready("bo", 1, &ALL).unwrap();
        assert_eq!(
            s.mark_ready("cy", 1, &["cy"]),
            Ok(ReadyOutcome::Waiting { waiting_for: 1 })
        );
        assert_eq!(s.view("cy", "ada", &["cy"]), Err(DraftError::Denied));
        assert_eq!(s.view("cy", "bo", &["cy"]), Err(DraftError::Denied));
    }

    #[test]
    fn edits_after_offering_stay_private_until_marked_ready_again() {
        let mut s = ready_set(RevealPolicy::Voluntary);
        s.mark_ready("ada", 1, &ALL).unwrap();
        s.mark_ready("bo", 1, &ALL).unwrap();
        s.mark_ready("cy", 1, &ALL).unwrap();
        s.save("cy", "cy", 1, "CY-2", T + 1).unwrap();
        assert_eq!(sees(&s, "ada", "cy", &ALL).as_deref(), Some("CY-1"));
        assert_eq!(sees(&s, "cy", "cy", &ALL).as_deref(), Some("CY-2"));
        // Marking the newer revision ready moves the shared revision forward.
        assert_eq!(s.mark_ready("cy", 2, &ALL), Ok(ReadyOutcome::Revealed));
        assert_eq!(sees(&s, "ada", "cy", &ALL).as_deref(), Some("CY-2"));
        // Offering an older revision again shows exactly that revision: only the offer is shared.
        s.mark_ready("cy", 1, &ALL).unwrap();
        assert_eq!(sees(&s, "ada", "cy", &ALL).as_deref(), Some("CY-1"));
    }

    #[test]
    fn a_policy_change_does_not_reveal_to_a_participant_who_is_not_ready() {
        let mut s = ready_set(RevealPolicy::Voluntary);
        s.mark_ready("ada", 1, &ALL).unwrap();
        s.mark_ready("bo", 1, &ALL).unwrap();
        s.set_policy(RevealPolicy::AllReady);
        s.set_policy(RevealPolicy::Voluntary);
        assert_eq!(s.view("cy", "ada", &ALL), Err(DraftError::Denied));
        assert_eq!(s.view("bo", "ada", &ALL), Err(DraftError::Denied));
        assert!(!s.is_ready("cy"));
    }

    #[test]
    fn v0_21_0_data_loads_with_its_old_meaning_and_never_feeds_voluntary_visibility() {
        let mut s = four(RevealPolicy::Voluntary);
        // The v0.21.0 shape: two separate revealed groups.
        for (id, pair) in [("reveal-1", ["ada", "bo"]), ("reveal-2", ["cy", "di"])] {
            s.exchanges.push(Exchange {
                id: id.into(),
                members: pair.iter().map(|w| (*w).into()).collect(),
                state: ExchangeState::Revealed,
                commitments: pair
                    .iter()
                    .map(|w| Commitment {
                        participant_id: (*w).into(),
                        contribution_id: (*w).into(),
                        revision: 1,
                    })
                    .collect(),
            });
        }
        let mut s = DraftSet::from_json(&s.to_json()).unwrap();
        assert_eq!(sees(&s, "ada", "bo", &ALL4).as_deref(), Some("BO-1"));
        assert_eq!(sees(&s, "di", "cy", &ALL4).as_deref(), Some("CY-1"));
        assert_eq!(s.view("ada", "cy", &ALL4), Err(DraftError::Denied));
        // Offers do not join the old groups, and the groups do not join the offers.
        s.save("ada", "ada", 1, "ADA-2", T + 1).unwrap();
        s.mark_ready("ada", 2, &ALL4).unwrap();
        assert_eq!(s.mark_ready("cy", 1, &ALL4), Ok(ReadyOutcome::Revealed));
        assert_eq!(sees(&s, "cy", "ada", &ALL4).as_deref(), Some("ADA-2"));
        assert_eq!(s.view("cy", "bo", &ALL4), Err(DraftError::Denied));
        assert_eq!(s.view("di", "ada", &ALL4), Err(DraftError::Denied));
        assert_eq!(s.exchanges.len(), 2);
        assert!(DraftSet::from_json(&s.to_json()).is_ok());
    }

    #[test]
    fn p1_restored_member_rejoins_and_sees_only_what_is_currently_offered() {
        let mut s = four(RevealPolicy::Voluntary);
        s.mark_ready("ada", 1, &ALL4).unwrap();
        s.mark_ready("bo", 1, &ALL4).unwrap();
        // bo removed; ada shares revision 2, cy joins.
        s.save("ada", "ada", 1, "ADA-2", T + 1).unwrap();
        let without_bo = ["ada", "cy", "di"];
        s.mark_ready("ada", 2, &without_bo).unwrap();
        assert_eq!(
            s.mark_ready("cy", 1, &without_bo),
            Ok(ReadyOutcome::Revealed)
        );
        assert_eq!(s.view("bo", "cy", &without_bo), Err(DraftError::Denied));
        assert_eq!(s.view("cy", "bo", &without_bo), Err(DraftError::Denied));
        let mut s = DraftSet::from_json(&s.to_json()).unwrap();
        // bo is restored and an unrelated participant marks ready; bo does nothing.
        assert_eq!(s.mark_ready("di", 1, &ALL4), Ok(ReadyOutcome::Revealed));
        assert_eq!(sees(&s, "bo", "cy", &ALL4).as_deref(), Some("CY-1"));
        assert_eq!(sees(&s, "bo", "di", &ALL4).as_deref(), Some("DI-1"));
        // Only the currently offered revision, never the earlier one bo saw.
        assert_eq!(sees(&s, "bo", "ada", &ALL4).as_deref(), Some("ADA-2"));
        assert_eq!(sees(&s, "cy", "bo", &ALL4).as_deref(), Some("BO-1"));
    }

    #[test]
    fn p2_all_ready_reveal_is_not_handed_to_a_lone_voluntary_newcomer() {
        let mut s = ready_set(RevealPolicy::AllReady);
        for who in ALL {
            s.mark_ready(who, 1, &ALL).unwrap();
        }
        s.admit("di").unwrap();
        s.save("di", "di", 0, "DI-1", T).unwrap();
        s.set_policy(RevealPolicy::Voluntary);
        assert_eq!(s.view("di", "ada", &ALL4), Err(DraftError::Denied));
        assert_eq!(
            s.mark_ready("di", 1, &ALL4),
            Ok(ReadyOutcome::Waiting { waiting_for: 1 })
        );
        assert_eq!(s.view("di", "ada", &ALL4), Err(DraftError::Denied));
        // The all-ready group keeps its meaning among its own members.
        assert_eq!(sees(&s, "ada", "bo", &ALL4).as_deref(), Some("BO-1"));
    }

    #[test]
    fn p3_explicit_pair_exchange_does_not_leak_to_a_lone_voluntary_reader() {
        let mut s = four(RevealPolicy::Voluntary);
        s.open_exchange("ada", "x", &["ada", "bo"]).unwrap();
        s.commit("ada", "x", "ada", 1).unwrap();
        s.commit("bo", "x", "bo", 1).unwrap();
        assert_eq!(
            s.mark_ready("cy", 1, &ALL4),
            Ok(ReadyOutcome::Waiting { waiting_for: 1 })
        );
        assert_eq!(s.view("cy", "ada", &ALL4), Err(DraftError::Denied));
        // The pair never feeds visibility: a real offer from di shows di, not the pair.
        s.mark_ready("di", 1, &ALL4).unwrap();
        assert_eq!(sees(&s, "cy", "di", &ALL4).as_deref(), Some("DI-1"));
        assert_eq!(s.view("cy", "ada", &ALL4), Err(DraftError::Denied));
        assert_eq!(sees(&s, "bo", "ada", &ALL4).as_deref(), Some("ADA-1"));
    }

    #[test]
    fn p4_an_offer_on_another_contribution_never_exposes_unready_revisions() {
        let mut s = four(RevealPolicy::Voluntary);
        s.mark_ready("ada", 1, &ALL4).unwrap();
        s.mark_ready("bo", 1, &ALL4).unwrap();
        // ada keeps a second draft with 3 revisions and offers revision 3 of it.
        s.save("ada", "ada-b", 0, "B1", T).unwrap();
        s.save("ada", "ada-b", 1, "B2", T).unwrap();
        s.save("ada", "ada-b", 2, "B3", T).unwrap();
        let active = ["ada", "cy", "di"];
        s.mark_ready("ada", 3, &active).unwrap();
        // ada then edits her main draft privately.
        s.save("ada", "ada", 1, "ADA-2 private", T + 1).unwrap();
        s.save("ada", "ada", 2, "ADA-3 private", T + 2).unwrap();
        assert_eq!(s.mark_ready("cy", 1, &active), Ok(ReadyOutcome::Revealed));
        assert_eq!(s.view("cy", "ada", &active), Err(DraftError::Denied));
        assert_eq!(sees(&s, "cy", "ada-b", &active).as_deref(), Some("B3"));
        let compared = s.compare("cy", &["ada", "bo", "cy"], &active).unwrap();
        assert!(!format!("{compared:?}").contains("private"));
    }

    #[test]
    fn all_ready_keeps_one_group_for_the_whole_publication() {
        let mut s = ready_set(RevealPolicy::AllReady);
        s.mark_ready("ada", 1, &ALL).unwrap();
        s.mark_ready("bo", 1, &ALL).unwrap();
        assert_eq!(s.view("ada", "bo", &ALL), Err(DraftError::Denied));
        s.mark_ready("cy", 1, &ALL).unwrap();
        assert_eq!(s.exchanges.len(), 1);
        assert_eq!(s.exchanges[0].members.len(), 3);
    }

    #[test]
    fn all_ready_waits_for_every_active_participant() {
        let mut s = ready_set(RevealPolicy::AllReady);
        s.mark_ready("ada", 1, &ALL).unwrap();
        assert_eq!(
            s.mark_ready("bo", 1, &ALL),
            Ok(ReadyOutcome::Waiting { waiting_for: 1 })
        );
        assert_eq!(s.view("ada", "bo", &ALL), Err(DraftError::Denied));
        assert_eq!(s.mark_ready("cy", 1, &ALL), Ok(ReadyOutcome::Revealed));
        for (viewer, author) in [("ada", "cy"), ("bo", "ada"), ("cy", "bo")] {
            assert!(s.view(viewer, author, &ALL).is_ok());
        }
    }

    #[test]
    fn readiness_is_reversible_until_the_reveal_commits() {
        let mut s = ready_set(RevealPolicy::AllReady);
        s.mark_ready("ada", 1, &ALL).unwrap();
        s.mark_ready("bo", 1, &ALL).unwrap();
        s.unready("bo").unwrap();
        s.unready("bo").unwrap();
        assert_eq!(
            s.mark_ready("cy", 1, &ALL),
            Ok(ReadyOutcome::Waiting { waiting_for: 1 })
        );
        assert_eq!(s.view("ada", "cy", &ALL), Err(DraftError::Denied));
        s.mark_ready("bo", 1, &ALL).unwrap();
        // After the commit, taking back changes nothing.
        s.unready("ada").unwrap();
        assert!(s.view("cy", "ada", &ALL).is_ok());
    }

    #[test]
    fn the_offer_names_one_exact_revision_and_later_edits_stay_private() {
        let mut s = ready_set(RevealPolicy::Voluntary);
        s.save("ada", "ada", 1, "ADA-2 later", T + 1).unwrap();
        assert_eq!(s.mark_ready("ada", 9, &ALL), Err(DraftError::Denied));
        assert_eq!(s.mark_ready("ada", 0, &ALL), Err(DraftError::Denied));
        s.mark_ready("ada", 1, &ALL).unwrap();
        s.save("ada", "ada", 2, "ADA-3 even later", T + 2).unwrap();
        s.mark_ready("bo", 1, &ALL).unwrap();
        assert_eq!(s.view("bo", "ada", &ALL).unwrap().markdown, "ADA-1");
    }

    #[test]
    fn a_policy_change_never_reveals_and_clears_old_offers() {
        let mut s = ready_set(RevealPolicy::Voluntary);
        s.mark_ready("ada", 1, &ALL).unwrap();
        s.set_policy(RevealPolicy::AllReady);
        s.set_policy(RevealPolicy::Voluntary);
        // The old offer from before the change is gone, so one new offer reveals nothing.
        assert_eq!(
            s.mark_ready("bo", 1, &ALL),
            Ok(ReadyOutcome::Waiting { waiting_for: 1 })
        );
        assert_eq!(s.view("bo", "ada", &ALL), Err(DraftError::Denied));
        s.set_policy(RevealPolicy::Independent);
        assert!(s
            .compare("bo", &ALL, &ALL)
            .unwrap()
            .iter()
            .all(|slot| !matches!(slot, ComparisonSlot::Revealed(_))));
        assert!(DraftSet::from_json(&s.to_json()).is_ok());
    }

    #[test]
    fn a_removed_participant_neither_blocks_nor_receives_an_all_ready_reveal() {
        let mut s = ready_set(RevealPolicy::AllReady);
        let active = ["ada", "bo"];
        s.mark_ready("ada", 1, &active).unwrap();
        assert_eq!(s.mark_ready("cy", 1, &active), Err(DraftError::Denied));
        assert_eq!(s.mark_ready("bo", 1, &active), Ok(ReadyOutcome::Revealed));
        assert_eq!(s.view("cy", "ada", &ALL), Err(DraftError::Denied));
        assert_eq!(s.view("cy", "bo", &ALL), Err(DraftError::Denied));
        assert_eq!(s.view("ada", "cy", &ALL), Err(DraftError::Denied));
    }

    #[test]
    fn withdrawing_takes_back_the_offer() {
        let mut s = ready_set(RevealPolicy::Voluntary);
        s.mark_ready("ada", 1, &ALL).unwrap();
        s.withdraw("ada", "ada").unwrap();
        assert_eq!(
            s.mark_ready("bo", 1, &ALL),
            Ok(ReadyOutcome::Waiting { waiting_for: 1 })
        );
        assert_eq!(s.view("bo", "ada", &ALL), Err(DraftError::Denied));
        assert_eq!(s.mark_ready("ada", 1, &ALL), Err(DraftError::Denied));
    }

    #[test]
    fn comparison_keeps_order_labels_and_placeholders_for_unrevealed_drafts() {
        let mut s = ready_set(RevealPolicy::Voluntary);
        let order = ["cy", "ada", "bo", "ghost"];
        let slots = s.compare("bo", &order, &ALL).unwrap();
        assert!(matches!(
            &slots[0],
            ComparisonSlot::Private { ready: false }
        ));
        assert!(matches!(
            &slots[1],
            ComparisonSlot::Private { ready: false }
        ));
        assert!(matches!(&slots[2], ComparisonSlot::Own(v) if v.markdown == "BO-1"));
        assert_eq!(slots[3], slots[0]);
        s.mark_ready("ada", 1, &ALL).unwrap();
        let slots = s.compare("bo", &order, &ALL).unwrap();
        assert!(matches!(&slots[1], ComparisonSlot::Private { ready: true }));
        assert!(!format!("{slots:?}").contains("ADA-1"));
        s.mark_ready("bo", 1, &ALL).unwrap();
        let slots = s.compare("bo", &order, &ALL).unwrap();
        assert!(matches!(
            &slots[0],
            ComparisonSlot::Private { ready: false }
        ));
        assert!(matches!(&slots[1], ComparisonSlot::Revealed(v) if v.markdown == "ADA-1"));
        assert!(matches!(&slots[2], ComparisonSlot::Own(_)));
        // The third participant still sees only placeholders for the others.
        let outside = s.compare("cy", &order, &ALL).unwrap();
        assert!(matches!(&outside[1], ComparisonSlot::Private { .. }));
        assert!(matches!(&outside[2], ComparisonSlot::Private { .. }));
        assert_eq!(s.compare("mallory", &order, &ALL), Err(DraftError::Denied));
    }

    #[test]
    fn untrusted_readiness_in_stored_json_fails_closed() {
        let mut s = ready_set(RevealPolicy::Voluntary);
        s.mark_ready("ada", 1, &ALL).unwrap();
        let good = s.to_json();
        assert!(DraftSet::from_json(&good).is_ok());
        for bad in [
            good.replace(r#""revision":1}]"#, r#""revision":7}]"#),
            good.replace(
                r#""participantId":"ada","contributionId":"ada""#,
                r#""participantId":"bo","contributionId":"ada""#,
            ),
            good.replace(r#""policy":"voluntary""#, r#""policy":"independent""#),
            good.replace(r#""policy":"voluntary""#, r#""policy":"everyone""#),
        ] {
            assert_ne!(bad, good);
            assert!(DraftSet::from_json(&bad).is_err());
        }
    }
}
