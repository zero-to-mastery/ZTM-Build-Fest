//! Approved reader feedback as the site publishes it (ADR 0083).
//!
//! When a moderator approves a piece of passage feedback, Admin copies its
//! public part into `reader-feedback.json` in the content folder, beside the
//! posts. The file is versioned with the site, so a static build, a CI build
//! and a portable export never need the hosted service, and the author's
//! response to each note lives in the same file.
//!
//! The file holds only what may be public, because a site's repository can
//! be: the kind, the text and details the reader sent, the passage target and
//! the revision they saw, the day it was received and the day it was
//! approved, the reader's name only when they agreed to show it, and the
//! author's response. Never the reader's clock, a time of day, the channel, a
//! private name, a moderation reason or anything about a rejected or pending
//! submission.
//!
//! An approved suggested source or correction also carries the author's
//! decision on it (ADR 0119), copied from the private decision log when the
//! author records it or approves the note: the outcome, the author's
//! rationale, the revision note that says what changed and the evidence link
//! they recorded, never who decided and never the item another decision
//! pointed to. The file is then version 2; without a decision it is version 1,
//! byte for byte as before.
//!
//! A post publishes its approved feedback through [`project`], which reads
//! every note's provenance through the one public projection
//! ([`crate::feedback_provenance::FeedbackProvenance::public`]): the quoted
//! words appear only while the post still publishes them. Only the canonical
//! page shows the notes; portable copies and feeds carry a labelled link to
//! it instead (P6.2).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::correction_decision::{
    ClaimEvidenceRef, CorrectionDecision, DecisionContent, DecisionLog, DecisionOutcome,
    DeclineReason, Extent, RevisionLink,
};
use crate::date::DateTime;
use crate::escape::{attr, text};
use crate::feedback_provenance::{
    FeedbackChannel, FeedbackProvenance, PublicProvenance, ReaderAttribution, MAX_READER_NAME_CHARS,
};
use crate::model::Post;
use crate::passage_target::{
    normalize_passage_text, PassageDocument, PassageSelector, PassageTarget,
};
use crate::scholarly_feedback::{
    is_uuid, reader_text, FeedbackDetails, FeedbackKind, FeedbackSubmission, ScholarlyFeedback,
};

/// The file's name, in the content folder.
pub const READER_FEEDBACK_FILE: &str = "reader-feedback.json";
/// The version of the file format without any decision; a file holding a decision is version
/// [`READER_FEEDBACK_OUTCOMES_VERSION`].
pub const READER_FEEDBACK_VERSION: u64 = 1;
/// The version of a file that holds the author's decision on at least one note (ADR 0119). A
/// reader refuses a higher one.
pub const READER_FEEDBACK_OUTCOMES_VERSION: u64 = 2;
/// The id of the section of a post's canonical page that lists its notes.
pub const READER_FEEDBACK_ANCHOR: &str = "ob-reader-feedback";
/// The most notes the file holds.
pub const MAX_PUBLISHED_FEEDBACK: usize = 2_000;
/// The largest file accepted, before it is parsed.
pub const MAX_READER_FEEDBACK_BYTES: usize = 8 * 1024 * 1024;
/// The longest author response.
pub const MAX_RESPONSE_CHARS: usize = 4_000;

/// The author's public response to one note.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorResponse {
    pub text: String,
    /// `YYYY-MM-DD`, by the author's clock.
    pub date: String,
}

/// The author's decision on one published note, as the file stores it (ADR 0119): exactly what
/// [`crate::correction_decision::public_decision`] would publish, and no more. It holds nothing
/// about who decided, nothing the reader wrote and not the item another decision pointed to; the
/// private decision log keeps those.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublishedDecision {
    /// A [`DecisionOutcome`] id.
    pub outcome: String,
    /// `full` or `partial`, for an accepted outcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extent: Option<String>,
    /// A [`DeclineReason`] id, for a declined outcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decline_reason: Option<String>,
    /// The author's own words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    /// The post's `evidenceRevisions` item that says what changed, as written there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_note: Option<String>,
    /// The evidence link the author recorded on one of the post's claims.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_evidence: Option<ClaimEvidenceRef>,
    /// The day the author decided, `YYYY-MM-DD`.
    pub decided: String,
    /// How many earlier decisions this one superseded; they stay in the private log.
    pub superseded: u32,
}

impl PublishedDecision {
    /// The public part of a recorded decision.
    pub fn from_decision(decision: &CorrectionDecision) -> Self {
        let content = &decision.content;
        Self {
            outcome: content.outcome.id().to_string(),
            extent: content.extent.map(|extent| extent.id().to_string()),
            decline_reason: content.decline_reason.map(|reason| reason.id().to_string()),
            rationale: content.rationale.clone(),
            revision_note: content.revision_note.as_ref().map(|link| link.note.clone()),
            claim_evidence: content.claim_evidence.clone(),
            decided: decision.decided.clone(),
            superseded: decision.sequence - 1,
        }
    }

    /// The decision with its evidence link kept only while `claims` publishes it on the post
    /// `post` (a slug): a private claim or link id is never copied into the public file, and
    /// without the claims file nothing says it is published.
    #[must_use]
    pub fn with_published_evidence(
        mut self,
        claims: Option<&crate::claims::ClaimSet>,
        post: &str,
    ) -> Self {
        if let Some(evidence) = &self.claim_evidence {
            if !claims.is_some_and(|set| evidence.is_published_on(set, post)) {
                self.claim_evidence = None;
            }
        }
        self
    }

    /// Whether the decision a published note carries is the one in force: both absent, or the
    /// same outcome and words. An evidence link the file leaves out is not a difference, because
    /// the file only ever holds links the claims file published when it was written.
    pub fn agrees(published: Option<&Self>, in_force: Option<&Self>) -> bool {
        match (published, in_force) {
            (None, None) => true,
            (Some(published), Some(in_force)) => {
                let mut withheld = in_force.clone();
                withheld.claim_evidence = None;
                published == in_force
                    || (published.claim_evidence.is_none() && *published == withheld)
            }
            _ => false,
        }
    }

    /// The decision in force on an item whose text is at `item_revision`, if the log has one: a
    /// decision about an earlier text is not in force, so it is not published.
    pub fn in_force(log: &DecisionLog, item_revision: u32) -> Option<Self> {
        crate::correction_decision::decision_in_force(log, item_revision).map(Self::from_decision)
    }

    fn outcome(&self) -> Option<DecisionOutcome> {
        DecisionOutcome::from_id(&self.outcome)
    }

    /// The same rules the policy applied when it was recorded: which fields the outcome takes,
    /// their shapes and that the note is a note. `post` is the post the note belongs to and `item`
    /// the note's id.
    fn validate(&self, item: &str, post: &str) -> Result<(), String> {
        let outcome = self
            .outcome()
            .ok_or("`decision.outcome` is not an outcome this version knows")?;
        let extent = self
            .extent
            .as_deref()
            .map(|id| Extent::from_id(id).ok_or("`decision.extent` is not full or partial"))
            .transpose()?;
        let decline_reason = self
            .decline_reason
            .as_deref()
            .map(|id| {
                DeclineReason::from_id(id)
                    .ok_or("`decision.declineReason` is not a reason this version knows")
            })
            .transpose()?;
        if !is_day(&self.decided) {
            return Err("`decision.decided` must be a day written YYYY-MM-DD".into());
        }
        if self.superseded as usize >= crate::correction_decision::MAX_DECISIONS_PER_ITEM {
            return Err("`decision.superseded` is more decisions than an item holds".into());
        }
        // An already-addressed decision may rest on another item, which the file never names: the
        // item's own id stands in so the policy's rule about what it needs is kept.
        let content = DecisionContent {
            outcome,
            extent,
            decline_reason,
            rationale: self.rationale.clone(),
            revision_note: self.revision_note.clone().map(|note| RevisionLink {
                post: post.to_string(),
                note,
            }),
            // The public file leaves out an evidence link the claims file does not publish
            // (`with_published_evidence`), so an outcome that needs one is checked with a
            // placeholder that is never compared or written.
            claim_evidence: self.claim_evidence.clone().or_else(|| {
                (outcome == DecisionOutcome::AcceptedAsEvidence).then(|| ClaimEvidenceRef {
                    claim: self
                        .revision_note
                        .as_ref()
                        .and_then(|note| {
                            crate::claim_publication::revision_notes(std::slice::from_ref(note))
                                .ok()?
                                .pop()?
                                .claim
                        })
                        .unwrap_or_else(|| "withheld".into()),
                    link: "withheld".into(),
                })
            }),
            addressed_by: (outcome == DecisionOutcome::AlreadyAddressed).then(|| item.to_string()),
        };
        let checked = content
            .checked()
            .map_err(|error| format!("`decision`: {}", error.message))?;
        if checked.rationale != content.rationale
            || checked.revision_note != content.revision_note
            || checked.claim_evidence != content.claim_evidence
        {
            return Err("`decision` holds text that is not in its stored form".into());
        }
        Ok(())
    }
}

/// One approved note as the file stores it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedFeedback {
    /// The hosted item's id, so the same note is never published twice.
    pub id: String,
    /// The post's source path in the content folder, such as
    /// `posts/tides.md`; it survives a change of slug.
    pub post: String,
    /// The address the reader saw.
    pub work: String,
    pub kind: FeedbackKind,
    pub body: String,
    pub details: FeedbackDetails,
    /// The passage revision the reader saw.
    pub revision: String,
    pub target: PassageTarget,
    /// The day the site received it, `YYYY-MM-DD`.
    pub received: String,
    /// The day it was approved, `YYYY-MM-DD`.
    pub approved: String,
    /// The reader's name, present only when they agreed to show it.
    pub name: Option<String>,
    pub response: Option<AuthorResponse>,
    /// The author's decision in force on a suggested source or correction (ADR 0119).
    pub decision: Option<PublishedDecision>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireItem {
    id: String,
    post: String,
    work: String,
    kind: String,
    body: String,
    #[serde(default, skip_serializing_if = "is_empty_details")]
    details: FeedbackDetails,
    revision: String,
    target: Value,
    received: String,
    approved: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    response: Option<AuthorResponse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    decision: Option<PublishedDecision>,
}

fn is_empty_details(details: &FeedbackDetails) -> bool {
    *details == FeedbackDetails::default()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireFile {
    #[allow(dead_code)]
    version: u64,
    items: Vec<Value>,
}

/// A calendar day written `YYYY-MM-DD`.
pub fn is_day(value: &str) -> bool {
    value.len() == 10
        && value
            .bytes()
            .enumerate()
            .all(|(at, byte)| matches!(at, 4 | 7) == (byte == b'-'))
        && value.bytes().filter(u8::is_ascii_digit).count() == 8
        && !value.starts_with("0000")
        && DateTime::parse(value).is_some_and(|day| day.ymd() == value)
}

/// A post's source path in the content folder: a Markdown post, written
/// with `/`, with no empty, dot or parent segment.
pub fn is_post_source(value: &str) -> bool {
    (3..=500).contains(&value.len())
        && crate::classify_source(value) == Some(crate::SourceKind::Post)
        && !value.starts_with('/')
        && !value
            .chars()
            .any(|c| c == '\\' || c.is_control() || c == ':')
        && value
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// The author's response text: plain text of 1 to [`MAX_RESPONSE_CHARS`]
/// characters, trimmed, with the reader-text rules (ADR 0079).
pub fn response_text(value: &str) -> Option<String> {
    reader_text(value, MAX_RESPONSE_CHARS)
}

impl PublishedFeedback {
    /// The public part of an approved record, for the post at `post`. The
    /// reader's name is kept only with their agreement; their clock, the
    /// time of day and the channel are dropped.
    pub fn from_record(
        id: &str,
        post: &str,
        record: &ScholarlyFeedback,
        approved: DateTime,
    ) -> Result<Self, String> {
        let provenance = &record.provenance;
        let item = Self {
            id: id.to_ascii_lowercase(),
            post: post.to_string(),
            work: provenance.work.clone(),
            kind: record.kind,
            body: record.body.clone(),
            details: record.details.clone(),
            revision: provenance.revision.clone(),
            target: provenance.target.clone(),
            received: provenance.received_at.ymd(),
            approved: approved.ymd().max(provenance.received_at.ymd()),
            name: provenance.attribution.public_name().map(str::to_string),
            response: None,
            decision: None,
        };
        item.validate()?;
        Ok(item)
    }

    fn validate(&self) -> Result<(), String> {
        if !is_uuid(&self.id) || self.id != self.id.to_ascii_lowercase() {
            return Err("`id` must be a lowercase UUID".into());
        }
        if !is_post_source(&self.post) {
            return Err(
                "`post` must be a post's source path in the content folder, such as posts/tides.md"
                    .into(),
            );
        }
        let submission = json!({
            "version": 1,
            "kind": self.kind.id(),
            "work": self.work,
            "revision": self.revision,
            "target": self.target.to_value(),
            "body": self.body,
            "details": serde_json::to_value(&self.details).expect("details serialize"),
        });
        let checked =
            FeedbackSubmission::from_value(&submission).map_err(|error| error.message.clone())?;
        if checked.body != self.body || checked.details != self.details {
            return Err("holds text or a link that is not in its stored form".into());
        }
        if !is_day(&self.received) || !is_day(&self.approved) {
            return Err("`received` and `approved` must be days written YYYY-MM-DD".into());
        }
        if self.approved < self.received {
            return Err("`approved` is earlier than `received`".into());
        }
        if let Some(name) = &self.name {
            let count = name.chars().count();
            if count == 0
                || count > MAX_READER_NAME_CHARS
                || normalize_passage_text(name) != *name
                || name
                    .chars()
                    .any(|c| c.is_control() || crate::research_notes::bidi_override(c))
            {
                return Err(format!(
                    "`name` must be 1 to {MAX_READER_NAME_CHARS} characters of plain text"
                ));
            }
        }
        if let Some(decision) = &self.decision {
            if !crate::evidence_submission::is_evidence_kind(self.kind.participation_kind()) {
                return Err(
                    "`decision` is only for a suggested source or a suggested correction".into(),
                );
            }
            decision.validate(&self.id, &self.post)?;
        }
        if let Some(response) = &self.response {
            if response_text(&response.text).as_deref() != Some(response.text.as_str()) {
                return Err(format!(
                    "`response.text` must be 1 to {MAX_RESPONSE_CHARS} characters of plain text"
                ));
            }
            if !is_day(&response.date) {
                return Err("`response.date` must be a day written YYYY-MM-DD".into());
            }
        }
        Ok(())
    }

    fn from_value(value: &Value) -> Result<Self, String> {
        let wire: WireItem = serde_json::from_value(value.clone()).map_err(|_| {
            "has a field this version does not define, or a field of the wrong type".to_string()
        })?;
        let kind = FeedbackKind::from_id(&wire.kind)
            .ok_or_else(|| "`kind` is not a kind of feedback this version knows".to_string())?;
        let target = PassageTarget::from_value(&wire.target)
            .map_err(|error| format!("`target`: {}", error.message))?;
        let item = Self {
            id: wire.id,
            post: wire.post,
            work: wire.work,
            kind,
            body: wire.body,
            details: wire.details,
            revision: wire.revision,
            target,
            received: wire.received,
            approved: wire.approved,
            name: wire.name,
            response: wire.response,
            decision: wire.decision,
        };
        item.validate()?;
        Ok(item)
    }

    fn to_wire(&self) -> WireItem {
        WireItem {
            id: self.id.clone(),
            post: self.post.clone(),
            work: self.work.clone(),
            kind: self.kind.id().to_string(),
            body: self.body.clone(),
            details: self.details.clone(),
            revision: self.revision.clone(),
            target: self.target.to_value(),
            received: self.received.clone(),
            approved: self.approved.clone(),
            name: self.name.clone(),
            response: self.response.clone(),
            decision: self.decision.clone(),
        }
    }

    /// The same note carrying the author's decision in force, or none, after the rules a file
    /// is read with.
    pub fn with_decision(mut self, decision: Option<PublishedDecision>) -> Result<Self, String> {
        self.decision = decision;
        self.validate()?;
        Ok(self)
    }

    /// The provenance this note publishes, for the public projection. Only
    /// the received day and a consented name were kept, so those are all it
    /// can show.
    fn provenance(&self) -> FeedbackProvenance {
        FeedbackProvenance {
            work: self.work.clone(),
            revision: self.revision.clone(),
            target: self.target.clone(),
            seen_at: None,
            received_at: DateTime::parse(&self.received).expect("validated day"),
            channel: FeedbackChannel::Hosted,
            attribution: ReaderAttribution {
                name: self.name.clone(),
                publish_name: self.name.is_some(),
            },
        }
    }
}

/// Every approved note the site publishes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReaderFeedbackFile {
    pub items: Vec<PublishedFeedback>,
}

impl ReaderFeedbackFile {
    /// Read the file, refusing a newer version, an unknown field or any
    /// broken rule, naming the item. Nothing is repaired or dropped.
    pub fn from_json(text: &str) -> Result<Self, String> {
        if text.len() > MAX_READER_FEEDBACK_BYTES {
            return Err(format!("is larger than {MAX_READER_FEEDBACK_BYTES} bytes"));
        }
        let value: Value =
            serde_json::from_str(text).map_err(|_| "is not valid JSON".to_string())?;
        let version = match value.get("version").and_then(Value::as_u64) {
            Some(version @ (READER_FEEDBACK_VERSION | READER_FEEDBACK_OUTCOMES_VERSION)) => version,
            Some(version) if version > READER_FEEDBACK_OUTCOMES_VERSION => {
                return Err(format!(
                    "is version {version}, newer than the version {READER_FEEDBACK_OUTCOMES_VERSION} this open.blog reads"
                ))
            }
            _ => return Err("needs `version` 1 or 2".into()),
        };
        let wire: WireFile = serde_json::from_value(value)
            .map_err(|_| "needs only `version` and an `items` list".to_string())?;
        if wire.items.len() > MAX_PUBLISHED_FEEDBACK {
            return Err(format!(
                "has {} items; keep at most {MAX_PUBLISHED_FEEDBACK}",
                wire.items.len()
            ));
        }
        let mut items = Vec::with_capacity(wire.items.len());
        let mut ids = std::collections::BTreeSet::new();
        for (index, value) in wire.items.iter().enumerate() {
            let item = PublishedFeedback::from_value(value)
                .map_err(|error| format!("item {}: {error}", index + 1))?;
            if item.decision.is_some() && version < READER_FEEDBACK_OUTCOMES_VERSION {
                return Err(format!(
                    "item {}: a `decision` needs the file's `version` 2",
                    index + 1
                ));
            }
            if !ids.insert(item.id.clone()) {
                return Err(format!(
                    "item {}: repeats the id of an earlier item",
                    index + 1
                ));
            }
            items.push(item);
        }
        Ok(Self { items })
    }

    /// Canonical text: items sorted by post, day received and id, two-space
    /// indentation and a final line break, so a change shows as a small diff.
    pub fn to_json(&self) -> String {
        let mut items: Vec<&PublishedFeedback> = self.items.iter().collect();
        items.sort_by(|a, b| {
            (a.post.as_str(), a.received.as_str(), a.id.as_str()).cmp(&(
                b.post.as_str(),
                b.received.as_str(),
                b.id.as_str(),
            ))
        });
        // Version 2 only once a decision is published, so a site that records none writes the file
        // exactly as before.
        let version = if self.items.iter().any(|item| item.decision.is_some()) {
            READER_FEEDBACK_OUTCOMES_VERSION
        } else {
            READER_FEEDBACK_VERSION
        };
        let value = json!({
            "version": version,
            "items": items.iter().map(|item| item.to_wire()).collect::<Vec<_>>(),
        });
        let mut out = serde_json::to_string_pretty(&value).expect("reader feedback serializes");
        out.push('\n');
        out
    }

    pub fn get(&self, id: &str) -> Option<&PublishedFeedback> {
        self.items.iter().find(|item| item.id == id)
    }

    /// Add a note, or replace the public part of one already published while
    /// keeping the author's response.
    pub fn publish(&mut self, mut item: PublishedFeedback) -> Result<(), String> {
        if let Some(existing) = self
            .items
            .iter_mut()
            .find(|existing| existing.id == item.id)
        {
            item.response = existing.response.take();
            *existing = item;
            return Ok(());
        }
        if self.items.len() >= MAX_PUBLISHED_FEEDBACK {
            return Err(format!(
                "the site already publishes {MAX_PUBLISHED_FEEDBACK} notes"
            ));
        }
        self.items.push(item);
        Ok(())
    }

    /// Set or clear the author's decision on a published note; whether the note is published.
    /// Nothing else about the note changes.
    pub fn set_decision(&mut self, id: &str, decision: Option<PublishedDecision>) -> bool {
        match self.items.iter_mut().find(|item| item.id == id) {
            Some(item) => {
                item.decision = decision;
                true
            }
            None => false,
        }
    }

    /// Take a note off the site; whether it was there.
    pub fn unpublish(&mut self, id: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|item| item.id != id);
        self.items.len() != before
    }

    /// Set or clear the author's response to a published note.
    pub fn respond(
        &mut self,
        id: &str,
        response: Option<&str>,
        today: DateTime,
    ) -> Result<(), String> {
        let item = self
            .items
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| "That note is not published on the site.".to_string())?;
        item.response = match response.map(str::trim).filter(|text| !text.is_empty()) {
            None => None,
            Some(text) => Some(AuthorResponse {
                text: response_text(text).ok_or_else(|| {
                    format!("Write a response of at most {MAX_RESPONSE_CHARS} characters, without control characters.")
                })?,
                date: today.ymd(),
            }),
        };
        Ok(())
    }

    /// The notes about one post, in the order the post lists them.
    pub fn for_post(&self, source: &str) -> Vec<&PublishedFeedback> {
        let mut items: Vec<&PublishedFeedback> = self
            .items
            .iter()
            .filter(|item| item.post == source)
            .collect();
        items.sort_by(|a, b| (&a.received, &a.id).cmp(&(&b.received, &b.id)));
        items
    }
}

/// One note as a post's canonical page shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicFeedback {
    pub id: String,
    pub kind: FeedbackKind,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_text: Option<String>,
    /// Whether the note is about the whole post.
    pub whole_post: bool,
    pub provenance: PublicProvenance,
    /// The heading title of the section the passage is in, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<AuthorResponse>,
    /// How the author's decision, or the lack of one, stands (ADR 0119): only for a suggested
    /// source or correction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<PublicOutcome>,
}

/// The id of a published note's outcome when the author has not decided.
pub const UNRESOLVED: &str = "unresolved";

/// What a published suggested source or correction came to, as its post and its portable copies
/// say it (ADR 0119): the author's decision with the change it rests on read against the post as
/// it is published now, or, where the site shows them, that the author has not decided. It holds
/// only what the file holds and the post publishes; never who decided and never a count.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicOutcome {
    /// A [`DecisionOutcome`] id, or [`UNRESOLVED`].
    pub id: &'static str,
    /// The outcome's label: "Correction", "Declined by the author", "Unresolved" and so on.
    pub label: &'static str,
    /// `full` or `partial`, for an accepted outcome.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extent: Option<&'static str>,
    /// The author's ground for declining, in words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decline_reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    /// The day the author decided.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided: Option<String>,
    pub superseded: u32,
    /// The change the decision rests on: the post's own revision note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<PublicChange>,
    /// The evidence link the author recorded, while the post still publishes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<PublicEvidenceRef>,
    /// The author recorded evidence the post no longer publishes.
    pub evidence_withdrawn: bool,
}

/// The post's revision note a decision rests on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicChange {
    /// `YYYY-MM-DD`.
    pub date: String,
    /// The number of the claim the note is about, only while the post publishes that claim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim: Option<usize>,
    pub note: String,
    /// The fragment of the post's "Revision notes" heading, only while the post still
    /// publishes this note there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fragment: Option<String>,
}

/// A published evidence link the author recorded because of a note.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicEvidenceRef {
    /// The claim's number in the post's section ("Claim 2").
    pub claim: usize,
    /// "Supported by", "Contradicted by" or "Given context by", then the source.
    pub label: String,
    /// The fragment of the claim's heading on the post's page.
    pub fragment: String,
}

impl PublicOutcome {
    fn unresolved() -> Self {
        Self {
            id: UNRESOLVED,
            label: "Unresolved",
            extent: None,
            decline_reason: None,
            rationale: None,
            decided: None,
            superseded: 0,
            change: None,
            evidence: None,
            evidence_withdrawn: false,
        }
    }

    /// Whether the author decided.
    pub fn is_decided(&self) -> bool {
        self.id != UNRESOLVED
    }

    /// The outcome as a heading, without its day.
    pub fn heading(&self) -> String {
        if self.is_decided() {
            format!("Author’s decision: {}", self.label)
        } else {
            "Unresolved: not yet decided by the author".to_string()
        }
    }

    /// What the outcome says, in the author's voice and never a finding about the reader or the
    /// world.
    pub fn summary(&self) -> String {
        let extent = match self.extent {
            Some("partial") => " in part",
            Some(_) => " in full",
            None => "",
        };
        match self.id {
            "accepted-as-correction" => format!("The author accepted this as a correction{extent} and changed the post."),
            "accepted-as-clarification" => format!("The author accepted this as a clarification{extent}: the post was reworded or given context, which does not say it was in error."),
            "accepted-as-evidence" => format!("The author recorded the suggested source as evidence on a claim{extent}, without changing the claim’s words."),
            "declined" => match self.decline_reason {
                Some(reason) => format!("The author considered this and declined it. Reason: {reason}."),
                None => "The author considered this and declined it.".to_string(),
            },
            "already-addressed" => "The author says the post already addressed this.".to_string(),
            _ => "The author has published this note and has not decided what it means for the post. It is a reader’s suggestion, not a settled correction.".to_string(),
        }
    }
}

/// The outcome of one published note, read against the post as published now: `None` for any
/// kind that is not decided (a question or another reading), and for a suggestion the author has
/// not decided unless the site shows that (`unresolved`).
fn outcome_of(item: &PublishedFeedback, post: &Post, unresolved: bool) -> Option<PublicOutcome> {
    if !crate::evidence_submission::is_evidence_kind(item.kind.participation_kind()) {
        return None;
    }
    let Some(decision) = &item.decision else {
        return unresolved.then(PublicOutcome::unresolved);
    };
    let outcome = DecisionOutcome::from_id(&decision.outcome)?;
    let published = post.claim_evidence();
    let change = decision.revision_note.as_ref().and_then(|text| {
        let note = crate::claim_publication::revision_notes(std::slice::from_ref(text))
            .ok()?
            .pop()?;
        let claim = note.claim.as_deref().and_then(|id| {
            published?
                .claims
                .iter()
                .find(|claim| claim.id == id)
                .map(|claim| claim.number)
        });
        let fragment = published.and_then(|evidence| {
            evidence
                .revisions
                .iter()
                .any(|published| published.date == note.date && published.note == note.note)
                .then(|| evidence.revisions_fragment.clone())
                .flatten()
        });
        Some(PublicChange {
            date: note.date,
            claim,
            note: note.note,
            fragment,
        })
    });
    let evidence = decision.claim_evidence.as_ref().and_then(|wanted| {
        let evidence = published?;
        let claim = evidence
            .claims
            .iter()
            .find(|claim| claim.id == wanted.claim)?;
        let (relation, link) = [
            (crate::claims::Relation::Supports, &claim.supports),
            (crate::claims::Relation::Contradicts, &claim.contradicts),
            (
                crate::claims::Relation::Contextualizes,
                &claim.contextualizes,
            ),
        ]
        .into_iter()
        .find_map(|(relation, links)| {
            links
                .iter()
                .find(|link| link.id == wanted.link)
                .map(|link| (relation, link))
        })?;
        let source = evidence
            .sources
            .iter()
            .find(|source| source.reference.key == link.source)
            .map_or_else(
                || link.source.clone(),
                // The citation text ends its own sentence; the label is one clause of ours.
                |source| source.text.trim_end_matches('.').to_string(),
            );
        Some(PublicEvidenceRef {
            claim: claim.number,
            label: format!(
                "{} {source}",
                crate::evidence_submission::relation_words(relation)
            ),
            fragment: claim.url.split_once('#')?.1.to_string(),
        })
    });
    Some(PublicOutcome {
        id: outcome.id(),
        label: outcome.label(),
        extent: decision
            .extent
            .as_deref()
            .and_then(Extent::from_id)
            .map(Extent::id),
        decline_reason: decision
            .decline_reason
            .as_deref()
            .and_then(DeclineReason::from_id)
            .map(DeclineReason::label),
        rationale: decision.rationale.clone(),
        decided: Some(decision.decided.clone()),
        superseded: decision.superseded,
        evidence_withdrawn: (decision.claim_evidence.is_some()
            || outcome == DecisionOutcome::AcceptedAsEvidence)
            && evidence.is_none(),
        change,
        evidence,
    })
}

/// The public form of a post's approved notes, read against the post as it
/// is published now. A suggested source or correction the author has not decided is shown as
/// unresolved when `unresolved` (the site offers evidence submissions, ADR 0119); any
/// decision the file holds is always shown.
pub fn project(
    items: &[&PublishedFeedback],
    post: &Post,
    document: &PassageDocument,
    unresolved: bool,
) -> Vec<PublicFeedback> {
    let titles = crate::feedback_moderation::section_titles(post, document);
    items
        .iter()
        .map(|item| {
            let provenance = item.provenance();
            let public = provenance.public(document);
            let resolution = provenance.resolve(document);
            let section_title = match resolution.location() {
                Some(location) => location
                    .index
                    .and_then(|index| titles.get(index).cloned().flatten()),
                None => public.section.as_deref().and_then(|anchor| {
                    document
                        .sections
                        .iter()
                        .position(|section| section.anchor.as_deref() == Some(anchor))
                        .and_then(|index| titles.get(index).cloned().flatten())
                }),
            };
            PublicFeedback {
                id: item.id.clone(),
                kind: item.kind,
                body: item.body.clone(),
                source_url: item.details.source_url.clone(),
                suggested_text: item.details.suggested_text.clone(),
                whole_post: matches!(item.target.selector, PassageSelector::Work),
                provenance: public,
                section_title,
                response: item.response.clone(),
                outcome: outcome_of(item, post, unresolved),
            }
        })
        .collect()
}

/// Where a note is about, as plain words, for a copy that links nothing within the page.
pub fn place_words(item: &PublicFeedback) -> String {
    if item.whole_post {
        "the whole post".to_string()
    } else {
        match (&item.provenance.section, &item.section_title) {
            (Some(anchor), title) => format!(
                "“{}”{}",
                title.as_deref().unwrap_or(anchor),
                if item.provenance.stale {
                    ", since revised"
                } else {
                    ""
                }
            ),
            (None, _) if item.provenance.stale => "a passage since revised".to_string(),
            (None, _) => "the opening".to_string(),
        }
    }
}

/// The outcome of one note as static HTML. `page` is the address links to the post's own
/// headings start from: empty on the canonical page, where they are fragments, and the post's
/// canonical URL in a portable copy. Every value is escaped.
pub fn outcome_html(item: &PublicFeedback, outcome: &PublicOutcome, page: &str) -> String {
    let mut html = format!(
        "<div class=\"ob-reader-note-outcome\" data-outcome=\"{}\">\n<h4>{}",
        attr(outcome.id),
        text(&outcome.heading())
    );
    if let Some(decided) = &outcome.decided {
        html.push_str(&format!(
            " <time datetime=\"{0}\">{0}</time>",
            attr(decided)
        ));
    }
    html.push_str(&format!("</h4>\n<p>{}</p>\n", text(&outcome.summary())));
    html.push_str(&format!(
        "<p class=\"ob-reader-note-affected\">Affected revision: <code>{}</code>{}</p>\n",
        text(&item.provenance.revision),
        if item.provenance.stale {
            ". The passage has been revised since."
        } else {
            "."
        }
    ));
    if let Some(change) = &outcome.change {
        let words = change_words(change);
        let words = match &change.fragment {
            Some(fragment) => format!(
                "<a href=\"{}\">{}</a>",
                attr(&format!("{page}#{fragment}")),
                text(&words)
            ),
            None => text(&words),
        };
        html.push_str(&format!(
            "<p class=\"ob-reader-note-change\">What changed: {words}</p>\n"
        ));
    }
    if let Some(evidence) = &outcome.evidence {
        html.push_str(&format!(
            "<p class=\"ob-reader-note-evidence\">Evidence the author recorded: <a href=\"{}\">Claim {}</a>: {}.</p>\n",
            attr(&format!("{page}#{}", evidence.fragment)),
            evidence.claim,
            text(&evidence.label)
        ));
    } else if outcome.evidence_withdrawn {
        html.push_str("<p class=\"ob-reader-note-evidence\">The evidence the author recorded is not published on this page.</p>\n");
    }
    if let Some(rationale) = &outcome.rationale {
        html.push_str(&format!(
            "<div class=\"ob-reader-note-rationale\">\n<p>The author’s rationale:</p>\n{}\n</div>\n",
            paragraphs(rationale)
        ));
    }
    html.push_str("</div>\n");
    html
}

/// The change a decision rests on as one line of words: its day, the claim it is about while the
/// post publishes that claim, and what changed.
pub fn change_words(change: &PublicChange) -> String {
    match change.claim {
        Some(claim) => format!("{} (Claim {claim}): {}", change.date, change.note),
        None => format!("{}: {}", change.date, change.note),
    }
}

fn paragraphs(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .split("\n\n")
        .map(str::trim)
        .filter(|paragraph| !paragraph.is_empty())
        .map(|paragraph| {
            format!(
                "<p>{}</p>",
                paragraph
                    .split('\n')
                    .map(text)
                    .collect::<Vec<_>>()
                    .join("<br>\n")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The section of a post's canonical page that lists its approved notes:
/// static, semantic HTML that needs no script. Every value is escaped; a
/// suggested source is a plain link marked as reader-supplied. With
/// `reports`, the hosted endpoint while abuse reports are open (ADR 0107),
/// each note carries a progressive report form whose static text works
/// without it.
pub fn render_section(items: &[PublicFeedback], reports: Option<&str>) -> String {
    if items.is_empty() {
        return String::new();
    }
    let mut html = format!(
        "<section id=\"{READER_FEEDBACK_ANCHOR}\" class=\"ob-reader-feedback\" aria-labelledby=\"{READER_FEEDBACK_ANCHOR}-title\">\n<h2 id=\"{READER_FEEDBACK_ANCHOR}-title\">Reader questions and responses</h2>\n<p>Notes readers sent about this post that the author chose to publish, with the author’s responses. Publishing a note does not mean the author agrees with it.</p>\n<ol class=\"ob-reader-feedback-list\">\n"
    );
    for item in items {
        let id = format!("ob-reader-note-{}", attr(&item.id));
        let place = if item.whole_post {
            "about the whole post".to_string()
        } else {
            match (&item.provenance.section, &item.section_title) {
                (Some(anchor), title) => format!(
                    "about <a href=\"#{}\">{}</a>{}",
                    attr(anchor),
                    text(title.as_deref().unwrap_or(anchor)),
                    if item.provenance.stale {
                        ", since revised"
                    } else {
                        ""
                    }
                ),
                (None, _) if item.provenance.stale => "about a passage since revised".to_string(),
                (None, _) => "about the opening".to_string(),
            }
        };
        html.push_str(&format!(
            "<li><article class=\"ob-reader-note\" id=\"{id}\" aria-labelledby=\"{id}-title\">\n<h3 id=\"{id}-title\">{} {place}</h3>\n",
            text(item.kind.label())
        ));
        if let Some(quote) = &item.provenance.quote {
            html.push_str(&format!(
                "<blockquote class=\"ob-reader-note-quote\"><p>{}</p></blockquote>\n",
                text(quote)
            ));
        } else if item.provenance.stale {
            html.push_str("<p class=\"ob-reader-note-stale\">The post has changed since this note was sent, so the words it was about are not quoted here.</p>\n");
        }
        html.push_str(&paragraphs(&item.body));
        html.push('\n');
        if let Some(url) = &item.source_url {
            html.push_str(&format!(
                "<p class=\"ob-reader-note-source\">Source the reader suggested: <a href=\"{}\" rel=\"nofollow ugc noopener noreferrer\">{}</a></p>\n",
                attr(url),
                text(url)
            ));
        }
        if let Some(suggested) = &item.suggested_text {
            html.push_str(&format!(
                "<div class=\"ob-reader-note-suggestion\">\n<p>Wording the reader suggested:</p>\n<blockquote>{}</blockquote>\n</div>\n",
                paragraphs(suggested)
            ));
        }
        let from = match &item.provenance.name {
            Some(name) => format!("From {}", text(name)),
            None => "From a reader".to_string(),
        };
        html.push_str(&format!(
            "<p class=\"ob-reader-note-meta\">{from} · received <time datetime=\"{0}\">{0}</time> · about passage revision <code>{1}</code></p>\n",
            attr(&item.provenance.received),
            text(&item.provenance.revision)
        ));
        if let Some(outcome) = &item.outcome {
            html.push_str(&outcome_html(item, outcome, ""));
        }
        if let Some(response) = &item.response {
            html.push_str(&format!(
                "<div class=\"ob-reader-note-response\">\n<h4>The author’s response <time datetime=\"{0}\">{0}</time></h4>\n{1}\n</div>\n",
                attr(&response.date),
                paragraphs(&response.text)
            ));
        }
        if let Some(endpoint) = reports {
            html.push_str(&format!(
                "<ob-abuse-report endpoint=\"{}\" source=\"feedback\" item=\"{}\" subject=\"this note\"><p class=\"ob-abuse-report-static\">To report this note as abusive, write to the author.</p></ob-abuse-report>\n",
                attr(endpoint),
                attr(&item.id)
            ));
        }
        html.push_str("</article></li>\n");
    }
    html.push_str("</ol>\n</section>\n");
    html
}
