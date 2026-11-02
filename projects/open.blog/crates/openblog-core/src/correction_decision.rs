//! The author's correction decision about an evidence submission (ADR 0117).
//!
//! A reader's suggested source or suggested correction
//! ([`crate::evidence_submission`]) is never a correction. Only the author's
//! decision can make one, and the decision is a separate thing from
//! moderation: moderation decides whether the reader's note may be shown
//! (ADRs 0083 and 0102), the decision records what the author concluded about
//! the work. It does both of these and nothing else:
//!
//! - it names one [`DecisionOutcome`]: accepted as a correction, accepted as
//!   a clarification, accepted as evidence, declined with a reason, or
//!   already addressed;
//! - it links the outcome to the feedback item, to the post's public
//!   revision note (`evidenceRevisions`, ADR 0075) and, where relevant, to
//!   the A4 claim evidence link the author recorded.
//!
//! A decision never edits a post, a citation, a claim or the Source
//! Library: the author makes those changes separately and the decision
//! points at them. It never changes the reader's record or provenance, and
//! a later decision is appended after the earlier ones, never written over
//! them ([`DecisionLog`]). Nothing in it judges truth beyond the author's own
//! decision, and nothing counts, ranks or votes: two readers sending the same
//! suggestion are two items with two decisions, never a score.
//!
//! The policy is pure. Callers build [`DecisionFacts`] from the stored item's
//! moderation facts ([`ItemFacts`], RD12's) and the passage check, resolve
//! who is deciding with [`crate::moderation::SharedWorks::actor`] as for
//! every moderation action, and store the returned [`CorrectionDecision`]
//! appended to the item's log, with its [`audit_event`], in one write. Every
//! error means nothing changed.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::claim_publication::{revision_notes, RevisionNote};
use crate::claims::ClaimSet;
use crate::date::DateTime;
use crate::evidence_submission::{is_evidence_kind, EvidenceOffer, PublishedReferences};
use crate::feedback_moderation::{stale_reason_id, PassageCheck};
use crate::feedback_publication::{is_day, is_post_source};
use crate::knowledge_atlas::valid_id;
use crate::moderation::{
    may_decide, Actor, ActorRole, AuditAction, AuditEvent, ItemFacts, ModerationState,
};
use crate::passage_target::{is_passage_revision, StaleReason};
use crate::scholarly_feedback::{is_uuid, reader_text, FeedbackKind};

/// The version of the decision and decision-log formats.
pub const CORRECTION_DECISION_VERSION: u64 = 1;
/// The longest rationale an author may give.
pub const MAX_RATIONALE_CHARS: usize = 2_000;
/// The most decisions one item's log holds.
pub const MAX_DECISIONS_PER_ITEM: usize = 100;
/// The longest Admin account name the private record keeps.
pub const MAX_ACCOUNT_CHARS: usize = 64;

/// What the author concluded. The id is stored; only
/// [`DecisionOutcome::AcceptedAsCorrection`] ever labels anything a
/// correction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DecisionOutcome {
    /// The work was in error and the author changed it.
    AcceptedAsCorrection,
    /// The work was not in error but was unclear or incomplete, and the
    /// author reworded it or added context.
    AcceptedAsClarification,
    /// The author recorded the offered source as evidence on a claim (A4),
    /// supporting, contradicting or giving context, without changing the
    /// claim's words.
    AcceptedAsEvidence,
    /// The author considered it and made no change, for a stated reason.
    Declined,
    /// The work already reflected it: an earlier revision, or another
    /// reader's item the author had already accepted.
    AlreadyAddressed,
}

impl DecisionOutcome {
    pub const ALL: [DecisionOutcome; 5] = [
        DecisionOutcome::AcceptedAsCorrection,
        DecisionOutcome::AcceptedAsClarification,
        DecisionOutcome::AcceptedAsEvidence,
        DecisionOutcome::Declined,
        DecisionOutcome::AlreadyAddressed,
    ];

    pub fn id(self) -> &'static str {
        match self {
            DecisionOutcome::AcceptedAsCorrection => "accepted-as-correction",
            DecisionOutcome::AcceptedAsClarification => "accepted-as-clarification",
            DecisionOutcome::AcceptedAsEvidence => "accepted-as-evidence",
            DecisionOutcome::Declined => "declined",
            DecisionOutcome::AlreadyAddressed => "already-addressed",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|outcome| outcome.id() == id)
    }

    /// A label for readers and editors. It names the author's decision,
    /// never a finding about the reader or the world.
    pub fn label(self) -> &'static str {
        match self {
            DecisionOutcome::AcceptedAsCorrection => "Correction",
            DecisionOutcome::AcceptedAsClarification => "Clarification",
            DecisionOutcome::AcceptedAsEvidence => "Added as evidence",
            DecisionOutcome::Declined => "Declined by the author",
            DecisionOutcome::AlreadyAddressed => "Already addressed",
        }
    }

    /// Whether this outcome makes the item a correction. Only the author's
    /// decision to accept it as one does.
    pub fn is_correction(self) -> bool {
        self == DecisionOutcome::AcceptedAsCorrection
    }

    /// Whether the author changed the work, or its evidence, because of it.
    pub fn is_accepted(self) -> bool {
        matches!(
            self,
            DecisionOutcome::AcceptedAsCorrection
                | DecisionOutcome::AcceptedAsClarification
                | DecisionOutcome::AcceptedAsEvidence
        )
    }
}

/// How much of a suggestion an accepted outcome applied.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Extent {
    Full,
    /// Part of it; the rationale says which part and why not the rest.
    Partial,
}

impl Extent {
    pub const ALL: [Extent; 2] = [Extent::Full, Extent::Partial];

    pub fn id(self) -> &'static str {
        match self {
            Extent::Full => "full",
            Extent::Partial => "partial",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|extent| extent.id() == id)
    }
}

/// The author's ground for declining. Each is the author's own position;
/// none says the reader, their source or their claim is wrong. Moderation
/// grounds (spam, abuse, personal data, duplicates) are not decision
/// reasons: those are moderation, which never labels the work.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DeclineReason {
    /// The author considered it and keeps the passage as written.
    MaintainsReading,
    /// It concerns something the passage does not say or claim.
    OutsideScope,
    /// The author could not consult the offered source.
    SourceUnavailable,
    /// Another ground, given in the rationale.
    Other,
}

impl DeclineReason {
    pub const ALL: [DeclineReason; 4] = [
        DeclineReason::MaintainsReading,
        DeclineReason::OutsideScope,
        DeclineReason::SourceUnavailable,
        DeclineReason::Other,
    ];

    pub fn id(self) -> &'static str {
        match self {
            DeclineReason::MaintainsReading => "maintains-reading",
            DeclineReason::OutsideScope => "outside-scope",
            DeclineReason::SourceUnavailable => "source-unavailable",
            DeclineReason::Other => "other",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|reason| reason.id() == id)
    }

    pub fn label(self) -> &'static str {
        match self {
            DeclineReason::MaintainsReading => "The author keeps the passage as written",
            DeclineReason::OutsideScope => "Outside what the passage says",
            DeclineReason::SourceUnavailable => "The author could not consult the source",
            DeclineReason::Other => "Another reason, given by the author",
        }
    }
}

/// Whether a recorded decision's role is one that may decide: the site
/// Admin or a coordinator (ADR 0117), the roles [`may_decide`] grants.
fn deciding_role(role: ActorRole) -> bool {
    matches!(role, ActorRole::SiteAdmin | ActorRole::Coordinator)
}

/// The post's public revision note the decision rests on: the post's source
/// path and one `evidenceRevisions` item exactly as the author wrote it in
/// the front matter (ADR 0075).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RevisionLink {
    /// The post's source path, such as `posts/tides.md`.
    pub post: String,
    /// The `evidenceRevisions` item, `YYYY-MM-DD[ claim-id]: what changed`.
    pub note: String,
}

impl RevisionLink {
    /// The note as the build reads it, or why it is not one.
    pub fn parsed(&self) -> Result<RevisionNote, String> {
        if !is_post_source(&self.post) {
            return Err(
                "`revisionNote.post` must be a post's source path, such as posts/tides.md".into(),
            );
        }
        let mut notes = revision_notes(std::slice::from_ref(&self.note))?;
        Ok(notes.remove(0))
    }

    /// Whether the post's `evidenceRevisions` hold this note. A decision
    /// whose note the author has since removed still records what it named.
    pub fn found_in(&self, items: &[String]) -> bool {
        let note = self.note.trim();
        items.iter().any(|item| item.trim() == note)
    }
}

/// The A4 evidence link the author recorded because of the submission.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimEvidenceRef {
    pub claim: String,
    pub link: String,
}

impl ClaimEvidenceRef {
    /// Check, in the author's private claims file, that the link exists, is
    /// on the claim, and that the post publishes both: the claims file is
    /// private, and a decision is public, so a decision never names an id
    /// the projection withholds (approved claim, approved link).
    pub fn check(&self, set: &ClaimSet) -> Result<(), DecisionError> {
        match set.link(&self.link) {
            Some(link) if link.claim == self.claim && set.claim(&self.claim).is_some() => {
                if set.is_projected(link) {
                    Ok(())
                } else {
                    Err(DecisionError::new(
                        DecisionErrorCode::ClaimEvidenceNotPublished,
                        "`claimEvidence` must name an evidence link and claim that are approved and published; approve them first",
                    ))
                }
            }
            _ => Err(DecisionError::new(
                DecisionErrorCode::UnknownClaimEvidence,
                "`claimEvidence` must name an evidence link in the claims file and the claim it is on",
            )),
        }
    }

    /// Whether the link is published on the post whose slug is `post` now:
    /// both are approved and the claim is that post's. Checked again when a
    /// decision is copied into a public file.
    pub fn is_published_on(&self, set: &ClaimSet, post: &str) -> bool {
        set.link(&self.link).is_some_and(|link| {
            link.claim == self.claim
                && set.is_projected(link)
                && set
                    .claim(&self.claim)
                    .is_some_and(|claim| claim.post == post)
        })
    }
}

/// What the author decides: the outcome and what it rests on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecisionContent {
    pub outcome: DecisionOutcome,
    /// Accepted outcomes only.
    pub extent: Option<Extent>,
    /// Declined only.
    pub decline_reason: Option<DeclineReason>,
    /// The author's own words, public with the outcome. Needed to decline
    /// and to accept in part.
    pub rationale: Option<String>,
    /// Needed for every accepted outcome; an already-addressed outcome
    /// names it or another item.
    pub revision_note: Option<RevisionLink>,
    /// Needed to accept as evidence; optional for the other accepted
    /// outcomes and already addressed.
    pub claim_evidence: Option<ClaimEvidenceRef>,
    /// Already addressed only: another item the author accepted earlier.
    pub addressed_by: Option<String>,
}

impl DecisionContent {
    pub fn new(outcome: DecisionOutcome) -> Self {
        Self {
            outcome,
            extent: None,
            decline_reason: None,
            rationale: None,
            revision_note: None,
            claim_evidence: None,
            addressed_by: None,
        }
    }

    /// Check which fields the outcome needs and allows, and their shapes,
    /// returning the content in stored form (trimmed text, lowercase ids).
    /// The order is fixed: extent, reason, rationale, revision note, claim
    /// evidence, the item it was addressed by.
    pub fn checked(&self) -> Result<Self, DecisionError> {
        use DecisionErrorCode as Code;
        let outcome = self.outcome;
        let accepted = outcome.is_accepted();
        let id = outcome.id();
        match (accepted, self.extent) {
            (true, None) => {
                return Err(DecisionError::new(
                    Code::ExtentRequired,
                    format!("{id} needs `extent`: full or partial"),
                ))
            }
            (false, Some(_)) => {
                return Err(DecisionError::new(
                    Code::ExtentNotAllowed,
                    format!("{id} has no `extent`"),
                ))
            }
            _ => {}
        }
        let declined = outcome == DecisionOutcome::Declined;
        match (declined, self.decline_reason) {
            (true, None) => {
                return Err(DecisionError::new(
                    Code::ReasonRequired,
                    "declined needs `declineReason`",
                ))
            }
            (false, Some(_)) => {
                return Err(DecisionError::new(
                    Code::ReasonNotAllowed,
                    format!("{id} has no `declineReason`"),
                ))
            }
            _ => {}
        }
        let rationale = self
            .rationale
            .as_deref()
            .map(|text| {
                reader_text(text, MAX_RATIONALE_CHARS).ok_or_else(|| {
                    DecisionError::new(
                        Code::InvalidRationale,
                        format!("`rationale` must be 1 to {MAX_RATIONALE_CHARS} characters of plain text"),
                    )
                })
            })
            .transpose()?;
        if rationale.is_none() && (declined || self.extent == Some(Extent::Partial)) {
            return Err(DecisionError::new(
                Code::RationaleRequired,
                "declining, or accepting in part, needs the author's `rationale`",
            ));
        }
        let addressing = outcome == DecisionOutcome::AlreadyAddressed;
        if declined && self.revision_note.is_some() {
            return Err(DecisionError::new(
                Code::RevisionNoteNotAllowed,
                "declined changes nothing, so it names no `revisionNote`",
            ));
        }
        if accepted && self.revision_note.is_none() {
            return Err(DecisionError::new(
                Code::RevisionNoteRequired,
                format!("{id} needs the post's `revisionNote` saying what changed"),
            ));
        }
        let revision_note = match &self.revision_note {
            Some(link) => {
                let parsed = link.parsed().map_err(|message| {
                    DecisionError::new(
                        Code::InvalidRevisionNote,
                        format!("`revisionNote`: {message}"),
                    )
                })?;
                Some((
                    RevisionLink {
                        post: link.post.clone(),
                        note: link.note.trim().to_string(),
                    },
                    parsed,
                ))
            }
            None => None,
        };
        if declined && self.claim_evidence.is_some() {
            return Err(DecisionError::new(
                Code::ClaimEvidenceNotAllowed,
                "declined records no `claimEvidence`; recording the source is accepted-as-evidence",
            ));
        }
        if outcome == DecisionOutcome::AcceptedAsEvidence && self.claim_evidence.is_none() {
            return Err(DecisionError::new(
                Code::ClaimEvidenceRequired,
                "accepted-as-evidence needs the `claimEvidence` link the author recorded",
            ));
        }
        if let Some(evidence) = &self.claim_evidence {
            if !valid_id(&evidence.claim) || !valid_id(&evidence.link) {
                return Err(DecisionError::new(
                    Code::InvalidClaimEvidence,
                    "`claimEvidence` needs a claim id and an evidence link id: lowercase slugs",
                ));
            }
            let named = revision_note
                .as_ref()
                .and_then(|(_, note)| note.claim.as_deref());
            if named.is_some_and(|claim| claim != evidence.claim) {
                return Err(DecisionError::new(
                    Code::ClaimMismatch,
                    "`revisionNote` names a different claim from `claimEvidence`",
                ));
            }
        }
        if !addressing && self.addressed_by.is_some() {
            return Err(DecisionError::new(
                Code::AddressedByNotAllowed,
                format!("{id} has no `addressedBy`"),
            ));
        }
        let addressed_by = match &self.addressed_by {
            Some(item) if is_uuid(item) => Some(item.to_ascii_lowercase()),
            Some(_) => {
                return Err(DecisionError::new(
                    Code::InvalidItem,
                    "`addressedBy` must be a feedback item id: a UUID",
                ))
            }
            None => None,
        };
        if addressing && revision_note.is_none() && addressed_by.is_none() {
            return Err(DecisionError::new(
                Code::AddressingRequired,
                "already-addressed needs the `revisionNote` or the `addressedBy` item that addressed it",
            ));
        }
        Ok(Self {
            outcome,
            extent: self.extent,
            decline_reason: self.decline_reason,
            rationale,
            revision_note: revision_note.map(|(link, _)| link),
            claim_evidence: self.claim_evidence.clone(),
            addressed_by,
        })
    }

    /// The day of the revision note, when there is one.
    fn note_day(&self) -> Option<String> {
        self.revision_note
            .as_ref()
            .and_then(|link| link.parsed().ok())
            .map(|note| note.date)
    }
}

/// The passage check the author confirmed when deciding, kept so a decision
/// on a passage that has since changed says so.
pub fn passage_check_id(check: PassageCheck) -> String {
    match check {
        PassageCheck::Stale(reason) => format!("stale:{}", stale_reason_id(reason)),
        other => other.id().to_string(),
    }
}

/// Read a passage check written by [`passage_check_id`], such as `current`
/// or `stale:quoteNotFound`.
pub fn passage_check_from_id(id: &str) -> Option<PassageCheck> {
    match id {
        "current" => Some(PassageCheck::Current),
        "reanchored" => Some(PassageCheck::Reanchored),
        "unknown-work" => Some(PassageCheck::UnknownWork),
        _ => {
            let reason = id.strip_prefix("stale:")?;
            [
                StaleReason::QuoteNotFound,
                StaleReason::ContextChanged,
                StaleReason::Ambiguous,
                StaleReason::SectionRemoved,
                StaleReason::SectionChanged,
                StaleReason::Unverified,
            ]
            .into_iter()
            .find(|candidate| stale_reason_id(*candidate) == reason)
            .map(PassageCheck::Stale)
        }
    }
}

/// Who decided, for the private record only: never public.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decider {
    /// The role [`crate::moderation::SharedWorks::actor`] resolved on the
    /// item's work: the site Admin or a coordinator.
    pub role: ActorRole,
    /// The Admin account, or `@moderation-token` for the hosted token.
    pub account: Option<String>,
}

fn valid_account(account: &str) -> bool {
    (1..=MAX_ACCOUNT_CHARS).contains(&account.chars().count())
        && account.chars().all(|c| c.is_ascii_graphic())
}

/// One recorded decision. Its content is public with the outcome while the
/// item it is about is public; who decided is private.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CorrectionDecision {
    /// The feedback item's id (the hosted UUID).
    pub item: String,
    /// Its place in the item's log, from 1. A later decision supersedes an
    /// earlier one without removing it.
    pub sequence: u32,
    pub content: DecisionContent,
    /// The revision of the item's text it decides (raised only when a
    /// clarification replaces the text, RD12); 1 for B5 items.
    pub item_revision: u32,
    /// The post's passage revision when the author decided, unless no post
    /// had the item's address. The reader's own revision stays in the item's
    /// provenance, untouched.
    pub passage_revision: Option<String>,
    /// What the author confirmed about the reader's passage when deciding.
    pub passage_check: PassageCheck,
    /// `YYYY-MM-DD`, by the author's clock.
    pub decided: String,
    pub decided_by: Decider,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireDecision {
    #[allow(dead_code)]
    version: u64,
    item: String,
    sequence: u32,
    outcome: String,
    #[serde(default)]
    extent: Option<String>,
    #[serde(default)]
    decline_reason: Option<String>,
    #[serde(default)]
    rationale: Option<String>,
    #[serde(default)]
    revision_note: Option<RevisionLink>,
    #[serde(default)]
    claim_evidence: Option<ClaimEvidenceRef>,
    #[serde(default)]
    addressed_by: Option<String>,
    item_revision: u32,
    #[serde(default)]
    passage_revision: Option<String>,
    passage_check: String,
    decided: String,
    decided_by: WireDecider,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireDecider {
    role: String,
    #[serde(default)]
    account: Option<String>,
}

impl CorrectionDecision {
    /// Whether the decision labels the item a correction.
    pub fn is_correction(&self) -> bool {
        self.content.outcome.is_correction()
    }

    /// The stored JSON, with fixed keys.
    pub fn to_value(&self) -> Value {
        let content = &self.content;
        let mut object = Map::new();
        object.insert("version".into(), CORRECTION_DECISION_VERSION.into());
        object.insert("item".into(), self.item.clone().into());
        object.insert("sequence".into(), self.sequence.into());
        object.insert("outcome".into(), content.outcome.id().into());
        if let Some(extent) = content.extent {
            object.insert("extent".into(), extent.id().into());
        }
        if let Some(reason) = content.decline_reason {
            object.insert("declineReason".into(), reason.id().into());
        }
        if let Some(rationale) = &content.rationale {
            object.insert("rationale".into(), rationale.clone().into());
        }
        if let Some(link) = &content.revision_note {
            object.insert(
                "revisionNote".into(),
                serde_json::to_value(link).expect("a revision link serializes"),
            );
        }
        if let Some(evidence) = &content.claim_evidence {
            object.insert(
                "claimEvidence".into(),
                serde_json::to_value(evidence).expect("a claim evidence link serializes"),
            );
        }
        if let Some(item) = &content.addressed_by {
            object.insert("addressedBy".into(), item.clone().into());
        }
        object.insert("itemRevision".into(), self.item_revision.into());
        if let Some(revision) = &self.passage_revision {
            object.insert("passageRevision".into(), revision.clone().into());
        }
        object.insert(
            "passageCheck".into(),
            passage_check_id(self.passage_check).into(),
        );
        object.insert("decided".into(), self.decided.clone().into());
        let mut decider = Map::new();
        decider.insert("role".into(), self.decided_by.role.id().into());
        if let Some(account) = &self.decided_by.account {
            decider.insert("account".into(), account.clone().into());
        }
        object.insert("decidedBy".into(), Value::Object(decider));
        Value::Object(object)
    }

    pub fn to_json(&self) -> String {
        self.to_value().to_string()
    }

    /// Read a stored decision, checking every rule that does not need the
    /// item: stored data is not trusted more than a request.
    pub fn from_value(value: &Value) -> Result<Self, DecisionError> {
        use DecisionErrorCode as Code;
        match value.get("version").and_then(Value::as_u64) {
            Some(CORRECTION_DECISION_VERSION) => {}
            Some(version) if version > CORRECTION_DECISION_VERSION => {
                return Err(DecisionError::new(
                    Code::UnsupportedVersion,
                    format!("this correction decision is version {version}, newer than the version {CORRECTION_DECISION_VERSION} this open.blog reads"),
                ))
            }
            _ => return Err(DecisionError::new(Code::Malformed, "a correction decision needs `version` 1")),
        }
        let wire: WireDecision = serde_json::from_value(value.clone()).map_err(|_| {
            DecisionError::new(
                Code::Malformed,
                "a correction decision has a field this version does not define, or a field of the wrong type",
            )
        })?;
        let malformed = |what: &str| DecisionError::new(Code::Malformed, what);
        if !is_uuid(&wire.item) || wire.item != wire.item.to_ascii_lowercase() {
            return Err(DecisionError::new(
                Code::InvalidItem,
                "`item` must be a lowercase UUID",
            ));
        }
        if wire.sequence == 0 || wire.item_revision == 0 {
            return Err(malformed("`sequence` and `itemRevision` start at 1"));
        }
        let outcome = DecisionOutcome::from_id(&wire.outcome)
            .ok_or_else(|| malformed("`outcome` is not a decision this version knows"))?;
        let extent = wire
            .extent
            .map(|id| {
                Extent::from_id(&id).ok_or_else(|| malformed("`extent` must be full or partial"))
            })
            .transpose()?;
        let decline_reason = wire
            .decline_reason
            .map(|id| {
                DeclineReason::from_id(&id)
                    .ok_or_else(|| malformed("`declineReason` is not a reason this version knows"))
            })
            .transpose()?;
        let content = DecisionContent {
            outcome,
            extent,
            decline_reason,
            rationale: wire.rationale,
            revision_note: wire.revision_note,
            claim_evidence: wire.claim_evidence,
            addressed_by: wire.addressed_by,
        };
        let checked = content.checked()?;
        if checked != content {
            return Err(malformed(
                "a correction decision holds text or an id that is not in its stored form",
            ));
        }
        let passage_check = passage_check_from_id(&wire.passage_check)
            .ok_or_else(|| malformed("`passageCheck` is not a passage check this version knows"))?;
        match (&wire.passage_revision, passage_check) {
            (None, PassageCheck::UnknownWork) => {}
            (Some(revision), check)
                if check != PassageCheck::UnknownWork && is_passage_revision(revision) => {}
            _ => {
                return Err(malformed(
                    "`passageRevision` is the post's passage revision, absent only when no post had the item's address",
                ))
            }
        }
        if !is_day(&wire.decided) {
            return Err(DecisionError::new(
                Code::InvalidDay,
                "`decided` must be a day written YYYY-MM-DD",
            ));
        }
        if checked.note_day().is_some_and(|day| day > wire.decided) {
            return Err(DecisionError::new(
                Code::RevisionNoteAfterDecision,
                "`revisionNote` is dated after the decision",
            ));
        }
        if checked.addressed_by.as_deref() == Some(wire.item.as_str()) {
            return Err(DecisionError::new(
                Code::SelfReference,
                "an item cannot be addressed by itself",
            ));
        }
        let role = ActorRole::from_id(&wire.decided_by.role)
            .filter(|role| deciding_role(*role))
            .ok_or_else(|| {
                DecisionError::new(
                    Code::Denied,
                    "a correction decision is recorded only by the site Admin or a coordinator",
                )
            })?;
        if wire
            .decided_by
            .account
            .as_deref()
            .is_some_and(|account| !valid_account(account))
        {
            return Err(malformed(
                "`decidedBy.account` must be an Admin account name",
            ));
        }
        Ok(Self {
            item: wire.item,
            sequence: wire.sequence,
            content: checked,
            item_revision: wire.item_revision,
            passage_revision: wire.passage_revision,
            passage_check,
            decided: wire.decided,
            decided_by: Decider {
                role,
                account: wire.decided_by.account,
            },
        })
    }

    pub fn from_json(text: &str) -> Result<Self, DecisionError> {
        let value: Value = serde_json::from_str(text).map_err(|_| {
            DecisionError::new(
                DecisionErrorCode::Malformed,
                "a correction decision is not valid JSON",
            )
        })?;
        Self::from_value(&value)
    }
}

/// Every decision ever recorded about one item, oldest first. Append-only:
/// a later decision supersedes the earlier ones and keeps them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecisionLog {
    item: String,
    decisions: Vec<CorrectionDecision>,
}

impl DecisionLog {
    /// The empty log of an item nobody has decided yet.
    pub fn new(item: &str) -> Self {
        Self {
            item: item.to_ascii_lowercase(),
            decisions: Vec::new(),
        }
    }

    pub fn item(&self) -> &str {
        &self.item
    }

    /// Every decision, oldest first.
    pub fn history(&self) -> &[CorrectionDecision] {
        &self.decisions
    }

    /// The decision in force: the latest.
    pub fn current(&self) -> Option<&CorrectionDecision> {
        self.decisions.last()
    }

    /// How many decisions the log holds: the number a new decision's request
    /// names as the ones it saw.
    pub fn len(&self) -> u32 {
        self.decisions.len() as u32
    }

    pub fn is_empty(&self) -> bool {
        self.decisions.is_empty()
    }

    /// Append a decision [`decide`] returned for this log. Refused, changing
    /// nothing, if it is for another item or does not follow the last one.
    pub fn append(&mut self, decision: CorrectionDecision) -> Result<(), DecisionError> {
        if decision.item != self.item || decision.sequence != self.len() + 1 {
            return Err(DecisionError::new(
                DecisionErrorCode::Stale,
                "the decision was made against another state of this item's decisions",
            ));
        }
        if self.decisions.len() >= MAX_DECISIONS_PER_ITEM {
            return Err(DecisionError::new(
                DecisionErrorCode::TooManyDecisions,
                format!("an item keeps at most {MAX_DECISIONS_PER_ITEM} decisions"),
            ));
        }
        if self
            .current()
            .is_some_and(|last| last.decided > decision.decided)
        {
            return Err(DecisionError::new(
                DecisionErrorCode::InvalidDay,
                "a decision cannot be dated before the decision it supersedes",
            ));
        }
        self.decisions.push(decision);
        Ok(())
    }

    /// `{version, item, decisions}`.
    pub fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("version".into(), CORRECTION_DECISION_VERSION.into());
        object.insert("item".into(), self.item.clone().into());
        object.insert(
            "decisions".into(),
            Value::Array(
                self.decisions
                    .iter()
                    .map(CorrectionDecision::to_value)
                    .collect(),
            ),
        );
        Value::Object(object)
    }

    /// Read a stored log: every decision checked, for this item, numbered
    /// from 1 without gaps and in date order.
    pub fn from_value(value: &Value) -> Result<Self, DecisionError> {
        let malformed = |what: &str| DecisionError::new(DecisionErrorCode::Malformed, what);
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct WireLog {
            version: u64,
            item: String,
            decisions: Vec<Value>,
        }
        let wire: WireLog = serde_json::from_value(value.clone()).map_err(|_| {
            malformed("a decision log is `{version, item, decisions}` and nothing else")
        })?;
        if wire.version != CORRECTION_DECISION_VERSION {
            return Err(DecisionError::new(
                if wire.version > CORRECTION_DECISION_VERSION {
                    DecisionErrorCode::UnsupportedVersion
                } else {
                    DecisionErrorCode::Malformed
                },
                "a decision log needs `version` 1",
            ));
        }
        if !is_uuid(&wire.item) || wire.item != wire.item.to_ascii_lowercase() {
            return Err(DecisionError::new(
                DecisionErrorCode::InvalidItem,
                "`item` must be a lowercase UUID",
            ));
        }
        let mut log = Self::new(&wire.item);
        for (index, decision) in wire.decisions.iter().enumerate() {
            let decision =
                CorrectionDecision::from_value(decision).map_err(|error| DecisionError {
                    code: error.code,
                    message: format!("decision {}: {}", index + 1, error.message),
                })?;
            log.append(decision).map_err(|error| DecisionError {
                code: error.code,
                message: format!("decision {}: {}", index + 1, error.message),
            })?;
        }
        Ok(log)
    }
}

/// The server's facts about the item being decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecisionFacts<'a> {
    /// The stored item's moderation facts, as the participation policy reads
    /// them (its kind, work, state, version, text revision and the revision
    /// a clarification asked about). A decision changes none of them.
    pub item: ItemFacts<'a>,
    /// The day the site received it, from its provenance.
    pub received: &'a str,
    /// The source path of the post that has the item's address now, when one
    /// does.
    pub post: Option<&'a str>,
    /// The passage check against that post as published now.
    pub check: PassageCheck,
    /// That post's passage revision now.
    pub passage_revision: Option<&'a str>,
}

/// A request to record a decision.
#[derive(Clone, Debug)]
pub struct DecisionRequest<'a> {
    /// Who is deciding on the item's work, resolved by the server with
    /// [`crate::moderation::SharedWorks::actor`] from the session or token,
    /// never from the request.
    pub actor: Actor<'a>,
    /// How many decisions on the item the author saw; anything else is stale.
    pub expected_decisions: u32,
    pub content: DecisionContent,
    /// The passage check the author read and confirmed; needed whenever the
    /// passage is not current.
    pub confirmed_check: Option<PassageCheck>,
    /// `YYYY-MM-DD`, by the author's clock.
    pub decided: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DecisionErrorCode {
    Malformed,
    UnsupportedVersion,
    /// The actor may not decide.
    Denied,
    /// A question or another interpretation: only evidence submissions are
    /// decided.
    NotDecidable,
    /// Rejected, removed or withdrawn.
    ItemClosed,
    /// The text is waiting for the submitter's clarification.
    AwaitingClarification,
    /// The request saw another number of decisions than the log holds.
    Stale,
    /// The passage is not current and the author did not confirm this check.
    CheckNotConfirmed,
    ExtentRequired,
    ExtentNotAllowed,
    ReasonRequired,
    ReasonNotAllowed,
    RationaleRequired,
    InvalidRationale,
    RevisionNoteRequired,
    RevisionNoteNotAllowed,
    InvalidRevisionNote,
    /// The note names another post than the one with the item's address.
    RevisionNoteElsewhere,
    /// An accepted outcome whose note predates the submission: that is
    /// already addressed, not accepted because of it.
    RevisionNoteBeforeSubmission,
    RevisionNoteAfterDecision,
    ClaimEvidenceRequired,
    ClaimEvidenceNotAllowed,
    InvalidClaimEvidence,
    UnknownClaimEvidence,
    /// The claim or link exists but is private (not approved), so a public decision cannot name it.
    ClaimEvidenceNotPublished,
    ClaimMismatch,
    AddressingRequired,
    AddressedByNotAllowed,
    InvalidItem,
    SelfReference,
    /// `addressedBy` names an item whose decision in force is not accepted.
    NotAddressed,
    InvalidDay,
    InvalidAccount,
    TooManyDecisions,
}

/// Why a decision was refused. Messages name fields and never repeat the
/// reader's or the author's text; nothing changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecisionError {
    pub code: DecisionErrorCode,
    pub message: String,
}

impl DecisionError {
    fn new(code: DecisionErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for DecisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DecisionError {}

/// The earliest day an author's decision or revision note may carry. The
/// author writes local days and the receipt day is UTC, so a same-day
/// correction west of UTC is dated the day before the UTC receipt day: UTC
/// offsets span at most one calendar day either side, so one day before is
/// the widest gap. `None` when the receipt day is not a day (nothing to
/// compare against).
fn earliest_local_day(received: &str) -> Option<String> {
    if !is_day(received) {
        return None;
    }
    let received = crate::date::DateTime::parse(received)?;
    Some(crate::date::DateTime::from_unix(received.unix() - 86_400).ymd())
}

/// Decide one item. Checks run in a fixed order, the grant first so an actor
/// who may not decide learns nothing about the item: grant, kind, state,
/// clarification, the decisions seen, the passage check, the content, then
/// what the content must agree with (the post, the days, the item it was
/// addressed by). `addressed` is the log of the item `addressedBy` names and
/// that item's current text revision, so only a decision still in force can
/// address another item. Days are the author's local days: the earliest
/// accepted is the day before the UTC receipt day (see [`earliest_local_day`]).
pub fn decide(
    facts: &DecisionFacts<'_>,
    log: &DecisionLog,
    addressed: Option<(&DecisionLog, u32)>,
    request: &DecisionRequest<'_>,
) -> Result<CorrectionDecision, DecisionError> {
    use DecisionErrorCode as Code;
    let item = &facts.item;
    if !may_decide(&request.actor, item) {
        return Err(DecisionError::new(
            Code::Denied,
            "only the site Admin or a coordinator of this work records correction decisions",
        ));
    }
    if !is_evidence_kind(item.kind) {
        return Err(DecisionError::new(
            Code::NotDecidable,
            format!(
                "a {} is answered, not decided: only suggested sources and corrections take a correction decision",
                item.kind.id()
            ),
        ));
    }
    match item.state {
        ModerationState::Pending | ModerationState::Approved => {}
        ModerationState::Clarification => {
            return Err(DecisionError::new(
                Code::AwaitingClarification,
                "the submitter was asked to clarify; decide once they answer",
            ))
        }
        ModerationState::Rejected | ModerationState::Removed | ModerationState::Withdrawn => {
            return Err(DecisionError::new(
                Code::ItemClosed,
                "a rejected, removed or withdrawn item takes no new decision",
            ))
        }
    }
    if item.current_revision_asked() {
        return Err(DecisionError::new(
            Code::AwaitingClarification,
            "this text is the one the submitter was asked to clarify",
        ));
    }
    if log.item() != item.id.to_ascii_lowercase() || request.expected_decisions != log.len() {
        return Err(DecisionError::new(
            Code::Stale,
            "someone recorded a decision on this item since you loaded it; reload and decide again",
        ));
    }
    if facts.check != PassageCheck::Current && request.confirmed_check != Some(facts.check) {
        return Err(DecisionError::new(
            Code::CheckNotConfirmed,
            "the reader's passage has changed or cannot be checked; confirm the passage check you read",
        ));
    }
    let content = request.content.checked()?;
    // An item whose post is unknown can link no post's note: there is nothing to
    // say the note is about the same post.
    if let Some(link) = &content.revision_note {
        if facts.post != Some(link.post.as_str()) {
            return Err(DecisionError::new(
                Code::RevisionNoteElsewhere,
                "`revisionNote` names another post than the one this item is about",
            ));
        }
    }
    if !is_day(request.decided) {
        return Err(DecisionError::new(
            Code::InvalidDay,
            "`decided` must be a day written YYYY-MM-DD",
        ));
    }
    let earliest = earliest_local_day(facts.received);
    if earliest
        .as_deref()
        .is_some_and(|earliest| request.decided < earliest)
    {
        return Err(DecisionError::new(
            Code::InvalidDay,
            "a decision cannot be dated before the item was received",
        ));
    }
    if log
        .current()
        .is_some_and(|last| last.decided.as_str() > request.decided)
    {
        return Err(DecisionError::new(
            Code::InvalidDay,
            "a decision cannot be dated before the decision it supersedes",
        ));
    }
    if let Some(day) = content.note_day() {
        if day.as_str() > request.decided {
            return Err(DecisionError::new(
                Code::RevisionNoteAfterDecision,
                "`revisionNote` is dated after the decision",
            ));
        }
        if content.outcome.is_accepted()
            && earliest
                .as_deref()
                .is_some_and(|earliest| day.as_str() < earliest)
        {
            return Err(DecisionError::new(
                Code::RevisionNoteBeforeSubmission,
                "the revision note predates the submission: record it as already-addressed",
            ));
        }
    }
    if let Some(item) = &content.addressed_by {
        if item == log.item() {
            return Err(DecisionError::new(
                Code::SelfReference,
                "an item cannot be addressed by itself",
            ));
        }
        let accepted = addressed
            .filter(|(other, _)| other.item() == item)
            .and_then(|(other, revision)| decision_in_force(other, revision))
            .is_some_and(|decision| decision.content.outcome.is_accepted());
        if !accepted {
            return Err(DecisionError::new(
                Code::NotAddressed,
                "`addressedBy` must name an item whose decision in force accepted it",
            ));
        }
    }
    let account = request.actor.account();
    if account.is_some_and(|account| !valid_account(account)) {
        return Err(DecisionError::new(
            Code::InvalidAccount,
            "the deciding account must be an Admin account name",
        ));
    }
    let passage_revision = match facts.check {
        PassageCheck::UnknownWork => None,
        _ => facts
            .passage_revision
            .filter(|revision| is_passage_revision(revision))
            .map(str::to_string),
    };
    if facts.check != PassageCheck::UnknownWork && passage_revision.is_none() {
        return Err(DecisionError::new(
            Code::Malformed,
            "a checked passage needs the post's passage revision",
        ));
    }
    Ok(CorrectionDecision {
        item: log.item().to_string(),
        sequence: log.len() + 1,
        content,
        item_revision: item.revision,
        passage_revision,
        passage_check: facts.check,
        decided: request.decided.to_string(),
        decided_by: Decider {
            role: request.actor.role(),
            account: account.map(str::to_string),
        },
    })
}

/// The audit event for a recorded decision (RD12's trail, ADR 0104): the
/// item's kind, the `decide` action, its unchanged state as both `from` and
/// `to`, the decider's role and account, no reason, and the item's revision
/// and version, which a decision does not raise. Like every audit event it
/// holds nothing anyone wrote, so it outlives a purge of the item's text.
pub fn audit_event(
    item: &ItemFacts<'_>,
    decision: &CorrectionDecision,
    at: DateTime,
) -> AuditEvent {
    AuditEvent {
        item: item.id.to_string(),
        kind: item.kind,
        action: AuditAction::Decide,
        from: Some(item.state),
        to: item.state,
        actor: decision.decided_by.role,
        actor_id: decision.decided_by.account.clone(),
        reason: None,
        at,
        revision: decision.item_revision,
        version: item.version,
        related: None,
    }
}

/// How an item stands, as readers and editors tell it apart: a question, a
/// proposed source, a challenged citation or a possible error until the
/// author decides, then the author's outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Standing {
    /// A reader's question. Answered by an author response, never decided.
    Question,
    /// Another reading offered beside the author's. Never decided.
    AlternativeInterpretation,
    /// A suggested source, not decided.
    ProposedSource,
    /// A suggestion that questions a published evidence link or cited
    /// source, not decided.
    ChallengedCitation,
    /// A suggested correction, not decided: a possible error, never a
    /// correction.
    PossibleError,
    /// The author's decision in force.
    Decided(DecisionOutcome),
}

impl Standing {
    pub fn id(self) -> &'static str {
        match self {
            Standing::Question => "question",
            Standing::AlternativeInterpretation => "alternative-interpretation",
            Standing::ProposedSource => "proposed-source",
            Standing::ChallengedCitation => "challenged-citation",
            Standing::PossibleError => "possible-error",
            Standing::Decided(outcome) => outcome.id(),
        }
    }

    /// A label. Before a decision it names the reader's intent (B5's labels,
    /// ADR 0079), never a verdict.
    pub fn label(self) -> &'static str {
        match self {
            Standing::Question => "Question",
            Standing::AlternativeInterpretation => "Another interpretation",
            Standing::ProposedSource => "Suggested source",
            Standing::ChallengedCitation => "Questioned citation",
            Standing::PossibleError => "Suggested correction",
            Standing::Decided(outcome) => outcome.label(),
        }
    }

    pub fn is_decided(self) -> bool {
        matches!(self, Standing::Decided(_))
    }

    /// Whether the item is a correction: only after the author accepts it as
    /// one.
    pub fn is_correction(self) -> bool {
        matches!(self, Standing::Decided(outcome) if outcome.is_correction())
    }
}

/// The decision in force for an item whose text is at `item_revision`: the
/// latest, unless it decided an earlier revision of the text (a
/// clarification has replaced it since), which leaves the item undecided.
pub fn decision_in_force(log: &DecisionLog, item_revision: u32) -> Option<&CorrectionDecision> {
    log.current()
        .filter(|decision| decision.item_revision == item_revision)
}

/// How an item stands. It depends only on the reader's kind and evidence
/// block and the author's decision in force: never on how many readers sent
/// the same thing, on moderation or on anything automatic.
pub fn standing(
    kind: FeedbackKind,
    offer: Option<&EvidenceOffer>,
    log: &DecisionLog,
    item_revision: u32,
) -> Standing {
    if let Some(decision) = decision_in_force(log, item_revision) {
        if is_evidence_kind(kind.participation_kind()) {
            return Standing::Decided(decision.content.outcome);
        }
    }
    match kind {
        FeedbackKind::Question => Standing::Question,
        FeedbackKind::AlternativeInterpretation => Standing::AlternativeInterpretation,
        _ if offer.is_some_and(EvidenceOffer::challenges_citation) => Standing::ChallengedCitation,
        FeedbackKind::SourceSuggestion => Standing::ProposedSource,
        FeedbackKind::CorrectionSuggestion => Standing::PossibleError,
    }
}

/// The public form of an item's decision in force: the outcome, the
/// author's rationale and the change it rests on. Never who decided, never
/// anything about the reader; their words and name are the item's own public
/// form, under their own consent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicDecision {
    pub outcome: &'static str,
    pub label: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extent: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decline_reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    /// The post's revision note, its claim kept only while the claim is
    /// published (as ADR 0075 publishes it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_note: Option<RevisionNote>,
    /// Only while both the claim and the link are published.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_evidence: Option<ClaimEvidenceRef>,
    /// The day decided.
    pub decided: String,
    /// How many earlier decisions this one superseded; they stay recorded.
    pub superseded: u32,
}

/// The public decision of an item, or `None`. Only an item whose own public
/// form is shown (approved, at its current revision, its kind shown on the
/// post) shows its decision: a pending, rejected, removed or withdrawn
/// item's decision is never linked to it in public. A post's revision note
/// is public on its own either way and says nothing about the reader.
pub fn public_decision(
    log: &DecisionLog,
    item_public: bool,
    item_revision: u32,
    published: &PublishedReferences,
) -> Option<PublicDecision> {
    if !item_public {
        return None;
    }
    let decision = decision_in_force(log, item_revision)?;
    let content = &decision.content;
    let revision_note = content
        .revision_note
        .as_ref()
        .and_then(|link| link.parsed().ok())
        .map(|mut note| {
            if note
                .claim
                .as_deref()
                .is_some_and(|claim| !published.has_claim(claim))
            {
                note.claim = None;
            }
            note
        });
    let claim_evidence = content
        .claim_evidence
        .as_ref()
        .filter(|evidence| published.has_link(&evidence.claim, &evidence.link));
    Some(PublicDecision {
        outcome: content.outcome.id(),
        label: content.outcome.label(),
        extent: content.extent.map(Extent::id),
        decline_reason: content.decline_reason.map(DeclineReason::id),
        rationale: content.rationale.clone(),
        revision_note,
        claim_evidence: claim_evidence.cloned(),
        decided: decision.decided.clone(),
        superseded: decision.sequence - 1,
    })
}
