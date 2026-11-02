//! Third Perspectives: a reader's own reflection on a published work
//! (ADRs 0109 to 0114).
//!
//! A Third Perspective is another reading of a shared reflection or a post,
//! offered by a reader. It is never one of the authors' perspectives, never a
//! vote for one of them, and never public until the reader agreed to publish
//! it and a moderator approved exactly the text and the consent the reader
//! gave. It is one participation kind (`third-perspective`) in the one
//! participation and moderation policy (#211), not another comment system.
//!
//! Three things are kept apart, each its own type:
//!
//! - [`LocalReflection`]: the reader's private draft. It has no id, no
//!   provenance and no consent, and nothing here sends or stores it.
//! - [`SubmittedCopy`]: what the site received, with the reader's consent
//!   history and moderation provenance. Private to moderation.
//! - [`ApprovedResponse`]: the one public projection of an approved copy, for
//!   the canonical page only.
//!
//! Featuring an approved response in a community section is an editor's
//! choice that needs the reader's separate feature consent for that approved
//! revision. It lives in [`crate::community_feature`] (ADR 0176), which
//! replaced the earlier `FeatureSelection` and `FeaturedPublication` types
//! this module had no caller for.
//!
//! The policy is pure. Callers bring the moderation facts (see
//! [`ModerationFacts`]) and the published work, and apply what a decision
//! returns in one write.
//!
//! B5's passage targets and feedback provenance and RD12's participation
//! kinds and moderation facts are used directly; ADR 0112 records how each
//! shape this module first carried maps onto them. A hosted copy is one
//! `openblog_feedback` row ([`SubmittedCopy::stored_details`],
//! [`HostedPerspective`], ADR 0113).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::date::DateTime;
use crate::feedback_provenance::{ProvenanceError, ProvenanceErrorCode};
use crate::moderation::ItemFacts;
use crate::participation::{ParticipationKind, ParticipationMode};
use crate::passage_target::{PassageSelector, PassageTarget, Resolution, TargetErrorCode};

pub use crate::feedback_provenance::{
    is_work_path, FeedbackChannel as Channel, FeedbackProvenance as Provenance, ReaderAttribution,
    FEEDBACK_PROVENANCE_VERSION as PROVENANCE_VERSION, MAX_READER_NAME_CHARS, MAX_WORK_PATH_CHARS,
};
pub use crate::moderation::ModerationState;
pub use crate::passage_target::{
    is_passage_revision, MAX_ANCHOR_CHARS, PASSAGE_TARGET_VERSION as TARGET_VERSION,
};

/// The participation kind, RD12's `third-perspective`.
pub const KIND: ParticipationKind = ParticipationKind::ThirdPerspective;
/// The version of the submission and record formats; a reader refuses a
/// higher one.
pub const THIRD_PERSPECTIVE_VERSION: u64 = 1;
/// The longest reflection, as for comments and passage feedback.
pub const MAX_BODY_CHARS: usize = 4_000;
/// The longest moderator id an approval records.
pub const MAX_MODERATOR_CHARS: usize = 64;
/// The most consent records one copy keeps. The last slot is kept for a
/// revocation and [`NARROWING_RESERVE`] more for narrowing, so a change that
/// widens or only renames is refused before then.
pub const MAX_CONSENT_RECORDS: usize = 50;
/// Slots kept for narrowing (hiding the name, declining clarification,
/// declining a feature): a reader can do each of those at most once more
/// after every widening change is closed.
pub const NARROWING_RESERVE: usize = 3;
/// The most a copy's `details` (category, intake and consent records) may
/// serialize to: B5's 16 KiB bound on feedback `details`.
pub const MAX_DETAILS_BYTES: usize = 16 * 1024;
/// Bytes kept free below both serialized bounds for the narrowing and
/// revocation records, each well under 256 bytes.
const CONSENT_RESERVE_BYTES: usize = (NARROWING_RESERVE + 1) * 256;
/// The largest serialized submission or record accepted, before parsing.
pub const MAX_JSON_BYTES: usize = 32 * 1024;

// ---------------------------------------------------------------------------
// Errors

/// Why a submission or record was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    TooLarge,
    Malformed,
    UnsupportedVersion,
    WrongKind,
    InvalidWork,
    InvalidRevision,
    InvalidTarget,
    /// A quotation target: a Third Perspective is about the work or a section.
    TargetNotAllowed,
    UnknownCategory,
    InvalidBody,
    InvalidTime,
    SeenAfterReceived,
    InvalidName,
    ConsentWithoutName,
    /// The reader did not agree to publish.
    PublicationConsentRequired,
    InvalidIntake,
    InvalidConsentHistory,
}

/// A refused submission or record. The message names the field and never
/// repeats what the reader wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThirdPerspectiveError {
    pub code: ErrorCode,
    pub message: String,
}

impl ThirdPerspectiveError {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ThirdPerspectiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ThirdPerspectiveError {}

/// Why a consent change, a clarification or an approval was refused.
/// Nothing changed; messages name no text, identity or stored value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleError {
    /// Withdrawn, or publication consent already revoked.
    Closed,
    /// Retention already purged the text.
    ContentPurged,
    /// The copy and the moderation facts name different text revisions.
    OutOfStep,
    /// Approval applies only to a pending copy.
    NotPending,
    /// A clarification answers only an open clarification request.
    NotInClarification,
    /// The reader has not agreed to publish (or revoked it).
    PublicationNotConsented,
    /// The moderator saw another text revision.
    StaleRevision,
    /// The moderator saw another consent record.
    StaleConsent,
    /// A decision must name the moderator who made it.
    AnonymousModerator,
    /// Showing a name, or another name, after a moderator decided.
    WideningAfterDecision,
    /// No approved or undecided revision for feature consent to cover.
    FeatureNotAvailable,
    /// The change is the consent already in effect.
    Unchanged,
    ConsentLimit,
    /// A manual copy has no submitter who can answer a clarification.
    ClarificationUnavailable,
    InvalidTime,
    InvalidName,
    ConsentWithoutName,
    InvalidBody,
}

impl LifecycleError {
    pub fn code(self) -> &'static str {
        match self {
            LifecycleError::Closed => "closed",
            LifecycleError::ContentPurged => "contentPurged",
            LifecycleError::OutOfStep => "outOfStep",
            LifecycleError::NotPending => "notPending",
            LifecycleError::NotInClarification => "notInClarification",
            LifecycleError::PublicationNotConsented => "publicationNotConsented",
            LifecycleError::StaleRevision => "staleRevision",
            LifecycleError::StaleConsent => "staleConsent",
            LifecycleError::AnonymousModerator => "anonymousModerator",
            LifecycleError::WideningAfterDecision => "wideningAfterDecision",
            LifecycleError::FeatureNotAvailable => "featureNotAvailable",
            LifecycleError::Unchanged => "unchanged",
            LifecycleError::ConsentLimit => "consentLimit",
            LifecycleError::ClarificationUnavailable => "clarificationUnavailable",
            LifecycleError::InvalidTime => "invalidTime",
            LifecycleError::InvalidName => "invalidName",
            LifecycleError::ConsentWithoutName => "consentWithoutName",
            LifecycleError::InvalidBody => "invalidBody",
        }
    }
}

impl std::fmt::Display for LifecycleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            LifecycleError::Closed => "this reflection was withdrawn",
            LifecycleError::ContentPurged => "this reflection's text is no longer kept",
            LifecycleError::OutOfStep => "the reflection changed; reload it and try again",
            LifecycleError::NotPending => "only a pending reflection can be approved",
            LifecycleError::NotInClarification => "no clarification was requested",
            LifecycleError::PublicationNotConsented => {
                "the reader has not agreed to publish this reflection"
            }
            LifecycleError::StaleRevision => "the reflection's text changed; review it again",
            LifecycleError::StaleConsent => {
                "the reader changed their consent; review it again"
            }
            LifecycleError::AnonymousModerator => "a moderation decision must name its moderator",
            LifecycleError::WideningAfterDecision => {
                "a name can be added or changed only before a moderator decides; withdraw and submit again"
            }
            LifecycleError::FeatureNotAvailable => {
                "there is no approved text to agree to feature"
            }
            LifecycleError::Unchanged => "this is already the consent in effect",
            LifecycleError::ConsentLimit => "this reflection's consent cannot change again",
            LifecycleError::ClarificationUnavailable => {
                "a reflection entered by hand cannot be clarified; remove it or enter a new one"
            }
            LifecycleError::InvalidTime => "the time is earlier than the last change",
            LifecycleError::InvalidName => "the name must be 1 to 80 characters of plain text",
            LifecycleError::ConsentWithoutName => "showing a name needs a name",
            LifecycleError::InvalidBody => {
                "the reflection must be 1 to 4000 characters of plain text"
            }
        })
    }
}

impl std::error::Error for LifecycleError {}

// ---------------------------------------------------------------------------
// Response categories

/// An optional prompt a reader may pick to frame their reflection. A category
/// describes what kind of thought it is, never how good it is or which
/// author it sides with: there is no score, rating, agreement or "correct"
/// category, and a reflection without one is complete.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ResponseCategory {
    AnotherReading,
    Connection,
    Experience,
    Question,
    Application,
}

impl ResponseCategory {
    pub const ALL: [ResponseCategory; 5] = [
        ResponseCategory::AnotherReading,
        ResponseCategory::Connection,
        ResponseCategory::Experience,
        ResponseCategory::Question,
        ResponseCategory::Application,
    ];

    pub fn id(self) -> &'static str {
        match self {
            ResponseCategory::AnotherReading => "another-reading",
            ResponseCategory::Connection => "connection",
            ResponseCategory::Experience => "experience",
            ResponseCategory::Question => "question",
            ResponseCategory::Application => "application",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|category| category.id() == id)
    }

    pub fn label(self) -> &'static str {
        match self {
            ResponseCategory::AnotherReading => "Another reading",
            ResponseCategory::Connection => "A connection",
            ResponseCategory::Experience => "From experience",
            ResponseCategory::Question => "A question",
            ResponseCategory::Application => "Putting it to use",
        }
    }

    /// The prompt a form shows beside the category.
    pub fn prompt(self) -> &'static str {
        match self {
            ResponseCategory::AnotherReading => "How do you read this, in your own way?",
            ResponseCategory::Connection => {
                "What does this bring to mind: another work, idea or source?"
            }
            ResponseCategory::Experience => "What in your own experience speaks to this?",
            ResponseCategory::Question => "What question does this leave you with?",
            ResponseCategory::Application => "How might you apply or try this?",
        }
    }
}

// ---------------------------------------------------------------------------
// Target (B5's passage target, restricted to the work or a section)

/// What a Third Perspective is about: the whole work, usually, or one
/// section. A checked B5 passage target (ADR 0076), written exactly as one:
/// `{"version":1,"kind":"work"}` or
/// `{"version":1,"kind":"section","section":"methods","digest":"…"}`. A
/// quotation target is refused: quoting a passage is passage feedback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PerspectiveTarget(PassageTarget);

fn is_digest(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn forbidden_in_line(character: char) -> bool {
    character.is_control() || crate::research_notes::bidi_override(character)
}

fn quote_refused() -> ThirdPerspectiveError {
    ThirdPerspectiveError::new(
        ErrorCode::TargetNotAllowed,
        "a Third Perspective is about the whole work or a section, not a quotation",
    )
}

fn target_error(error: crate::passage_target::TargetError) -> ThirdPerspectiveError {
    let code = match error.code {
        TargetErrorCode::UnsupportedVersion => ErrorCode::UnsupportedVersion,
        _ => ErrorCode::InvalidTarget,
    };
    ThirdPerspectiveError::new(code, format!("`target`: {}", error.message))
}

impl TryFrom<PassageTarget> for PerspectiveTarget {
    type Error = ThirdPerspectiveError;

    /// Accept a work or section target; refuse a quotation.
    fn try_from(target: PassageTarget) -> Result<Self, Self::Error> {
        if matches!(target.selector, PassageSelector::Quote(_)) {
            return Err(quote_refused());
        }
        target.validate().map_err(target_error)?;
        attributed_check(&target)?;
        Ok(Self(target))
    }
}

/// The reserved `ob-by-` anchor space (ADR 0126) is the author sections of a
/// shared reflection and nothing else: a target in it must be written exactly
/// as an attributed target is, with its digest, wherever it is read.
fn attributed_check(target: &PassageTarget) -> Result<(), ThirdPerspectiveError> {
    crate::attributed_perspective::AttributedTarget::from_passage(target)
        .map(|_| ())
        .map_err(|error| {
            ThirdPerspectiveError::new(ErrorCode::InvalidTarget, format!("`target`: {error}"))
        })
}

impl From<PerspectiveTarget> for PassageTarget {
    fn from(target: PerspectiveTarget) -> Self {
        target.0
    }
}

impl PerspectiveTarget {
    /// The whole work. It stays current while the work is published.
    pub fn work() -> Self {
        Self(PassageTarget {
            section: None,
            selector: PassageSelector::Work,
        })
    }

    /// One section: its heading id (`None` for the text before the first
    /// heading) and, when known, the digest of its text. Unchecked until
    /// [`PerspectiveTarget::validate`].
    pub fn section(section: Option<String>, digest: Option<String>) -> Self {
        Self(PassageTarget {
            section,
            selector: PassageSelector::Section { digest },
        })
    }

    /// Whether it is about the whole work.
    pub fn is_work(&self) -> bool {
        matches!(self.0.selector, PassageSelector::Work)
    }

    /// The section's heading id, for a section target.
    pub fn section_id(&self) -> Option<&str> {
        self.0.section.as_deref()
    }

    /// The B5 passage target.
    pub fn passage_target(&self) -> &PassageTarget {
        &self.0
    }

    /// Check B5's anchor and digest rules.
    pub fn validate(&self) -> Result<(), ThirdPerspectiveError> {
        self.0.validate().map_err(target_error)?;
        attributed_check(&self.0)
    }

    /// Read a target from its JSON value: B5's reader plus the refusal of a
    /// quotation, which is refused by its kind before its fields are read.
    /// Nothing is repaired.
    pub fn from_value(value: &Value) -> Result<Self, ThirdPerspectiveError> {
        let current = value
            .get("version")
            .and_then(Value::as_u64)
            .is_some_and(|version| version == TARGET_VERSION);
        if current && value.get("kind").and_then(Value::as_str) == Some("quote") {
            return Err(quote_refused());
        }
        PassageTarget::from_value(value)
            .map_err(target_error)
            .and_then(Self::try_from)
    }

    /// The JSON value.
    pub fn to_value(&self) -> Value {
        self.0.to_value()
    }

    /// Canonical JSON text.
    pub fn to_json(&self) -> String {
        self.0.to_json()
    }
}

/// Where a target stands in the work as published now, from B5's
/// [`Resolution`] of it from the revision the reader saw. A work target is
/// always current.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TargetStatus {
    /// The section is there with the text the reader saw (perhaps moved or
    /// renamed): its heading id now.
    Current { section: Option<String> },
    /// The section the reader wrote about is gone or has changed.
    Stale {
        /// Whether a section with the old heading id still exists.
        section_present: bool,
    },
}

impl From<&Resolution> for TargetStatus {
    fn from(resolution: &Resolution) -> Self {
        match resolution {
            Resolution::Current(location) | Resolution::Reanchored(location) => {
                TargetStatus::Current {
                    section: location.section.clone(),
                }
            }
            Resolution::Stale(stale) => TargetStatus::Stale {
                section_present: stale.section_present,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Reader identity and provenance (B5's types)

/// Whitespace collapsed, an empty name dropped (B5's normalization).
fn normalized_attribution(attribution: ReaderAttribution) -> ReaderAttribution {
    ReaderAttribution {
        name: attribution
            .name
            .map(|name| collapse_whitespace(&name))
            .filter(|name| !name.is_empty()),
        publish_name: attribution.publish_name,
    }
}

/// B5's name rules.
fn check_attribution(attribution: &ReaderAttribution) -> Result<(), ErrorCode> {
    match &attribution.name {
        Some(name) => {
            let count = name.chars().count();
            if count == 0
                || count > MAX_READER_NAME_CHARS
                || name.chars().any(forbidden_in_line)
                || collapse_whitespace(name) != *name
            {
                Err(ErrorCode::InvalidName)
            } else {
                Ok(())
            }
        }
        None if attribution.publish_name => Err(ErrorCode::ConsentWithoutName),
        None => Ok(()),
    }
}

fn validate_attribution(
    attribution: &ReaderAttribution,
    field: &str,
) -> Result<(), ThirdPerspectiveError> {
    check_attribution(attribution).map_err(|code| match code {
        ErrorCode::ConsentWithoutName => ThirdPerspectiveError::new(
            code,
            format!("`{field}.publishName` needs a name to publish"),
        ),
        _ => ThirdPerspectiveError::new(
            code,
            format!("`{field}.name` must be 1 to {MAX_READER_NAME_CHARS} characters of plain text"),
        ),
    })
}

fn provenance_error(error: ProvenanceError) -> ThirdPerspectiveError {
    let code = match error.code {
        ProvenanceErrorCode::TooLarge => ErrorCode::TooLarge,
        ProvenanceErrorCode::Malformed => ErrorCode::Malformed,
        ProvenanceErrorCode::UnsupportedVersion => ErrorCode::UnsupportedVersion,
        ProvenanceErrorCode::InvalidWork => ErrorCode::InvalidWork,
        ProvenanceErrorCode::InvalidRevision => ErrorCode::InvalidRevision,
        ProvenanceErrorCode::InvalidTarget => ErrorCode::InvalidTarget,
        ProvenanceErrorCode::InvalidTime => ErrorCode::InvalidTime,
        ProvenanceErrorCode::SeenAfterReceived => ErrorCode::SeenAfterReceived,
        ProvenanceErrorCode::InvalidName => ErrorCode::InvalidName,
        ProvenanceErrorCode::ConsentWithoutName => ErrorCode::ConsentWithoutName,
    };
    ThirdPerspectiveError::new(code, error.message)
}

/// A canonical UTC time in years 0001 to 9999 (B5's rule).
fn parse_time(field: &str, value: &str) -> Result<DateTime, ThirdPerspectiveError> {
    crate::feedback_provenance::parse_canonical_time(value).ok_or_else(|| {
        ThirdPerspectiveError::new(
            ErrorCode::InvalidTime,
            format!("`{field}` must be a UTC time written like 2026-10-26T10:00:00Z"),
        )
    })
}

/// Check B5's provenance rules and this kind's target restriction.
fn validate_provenance(provenance: &Provenance) -> Result<(), ThirdPerspectiveError> {
    provenance.validate().map_err(provenance_error)?;
    PerspectiveTarget::try_from(provenance.target.clone())?;
    Ok(())
}

/// Read B5's provenance object, refusing a quotation target by its kind
/// first, as [`PerspectiveTarget::from_value`] does.
fn provenance_from_value(value: &Value) -> Result<Provenance, ThirdPerspectiveError> {
    let malformed = |what: &str| ThirdPerspectiveError::new(ErrorCode::Malformed, what);
    match value.get("version").and_then(Value::as_u64) {
        Some(PROVENANCE_VERSION) => {}
        Some(version) if version > PROVENANCE_VERSION => {
            return Err(ThirdPerspectiveError::new(
                ErrorCode::UnsupportedVersion,
                format!("`provenance` is version {version}, newer than the version {PROVENANCE_VERSION} this open.blog reads"),
            ))
        }
        _ => return Err(malformed("`provenance` needs `version` 1")),
    }
    if let Some(target) = value.get("target") {
        PerspectiveTarget::from_value(target)?;
    }
    let provenance = Provenance::from_json(&value.to_string()).map_err(provenance_error)?;
    validate_provenance(&provenance)?;
    Ok(provenance)
}

/// The provenance as the JSON value a record embeds: B5's record.
fn provenance_value(provenance: &Provenance) -> Value {
    serde_json::from_str(&provenance.to_json()).expect("B5's provenance is JSON")
}

/// Who can act for the submitter, kept for moderation even when the reader
/// chose to be anonymous. Anonymous display is never anonymous provenance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Intake {
    /// A hosted submission: the digest (64 lowercase hex digits) of the
    /// private receipt the reader holds. The receipt itself is never stored.
    Hosted { receipt_digest: String },
    /// A manual entry: the Admin user who entered the reader's message.
    Manual { entered_by: String },
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireIntake {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    receipt_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    entered_by: Option<String>,
}

impl Intake {
    pub fn channel(&self) -> Channel {
        match self {
            Intake::Hosted { .. } => Channel::Hosted,
            Intake::Manual { .. } => Channel::Manual,
        }
    }

    fn validate(&self) -> Result<(), ThirdPerspectiveError> {
        let valid = match self {
            Intake::Hosted { receipt_digest } => is_digest(receipt_digest, 64),
            Intake::Manual { entered_by } => crate::collaboration::valid_admin_username(entered_by),
        };
        if valid {
            Ok(())
        } else {
            Err(ThirdPerspectiveError::new(
                ErrorCode::InvalidIntake,
                "`intake` needs a receipt digest of 64 hexadecimal digits for a hosted copy, or the Admin user who entered a manual one",
            ))
        }
    }

    fn wire(&self) -> WireIntake {
        match self {
            Intake::Hosted { receipt_digest } => WireIntake {
                receipt_digest: Some(receipt_digest.clone()),
                entered_by: None,
            },
            Intake::Manual { entered_by } => WireIntake {
                receipt_digest: None,
                entered_by: Some(entered_by.clone()),
            },
        }
    }

    fn from_wire(wire: WireIntake) -> Result<Self, ThirdPerspectiveError> {
        match (wire.receipt_digest, wire.entered_by) {
            (Some(receipt_digest), None) => Ok(Intake::Hosted { receipt_digest }),
            (None, Some(entered_by)) => Ok(Intake::Manual { entered_by }),
            _ => Err(ThirdPerspectiveError::new(
                ErrorCode::InvalidIntake,
                "`intake` names exactly one of `receiptDigest` and `enteredBy`",
            )),
        }
    }
}

// ---------------------------------------------------------------------------
// Consent

/// One immutable record of what the reader agreed to. Records are numbered
/// from 1; the last is in effect. Narrowing takes effect at once, a name can
/// be added only before a moderator decides, and revoking publication is a
/// withdrawal and final.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubmissionConsent {
    pub number: u32,
    pub given_at: DateTime,
    /// Agreement to publish the reflection on the canonical page once a
    /// moderator approves it. `false` only on the last record: revoked.
    pub publish: bool,
    /// The name and whether to show it with the reflection.
    pub attribution: ReaderAttribution,
    /// Agreement to be asked to clarify (RD12's clarification consent).
    pub clarification: bool,
    /// The text revision the reader agreed an editor may feature; a feature
    /// of any other revision is not covered.
    pub feature_revision: Option<u32>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireConsent {
    number: u32,
    given_at: String,
    publish: bool,
    #[serde(default)]
    attribution: WireAttribution,
    clarification: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    feature_revision: Option<u32>,
}

/// A consent record's attribution as stored. The name is written only when
/// it differs from the record before (or, for record 1, the provenance's);
/// an empty string clears it.
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireAttribution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default)]
    publish_name: bool,
}

impl SubmissionConsent {
    /// Whether this record shows the reader's name differently from
    /// `before`: a name shown where none was, or another name shown.
    fn widens_name(&self, before: &SubmissionConsent) -> bool {
        self.attribution.publish_name
            && (!before.attribution.publish_name
                || self.attribution.name != before.attribution.name)
    }

    /// Whether this record only takes something back from `before`: the
    /// same name (shown or hidden, never newly shown), no new clarification
    /// consent and no new feature consent.
    fn narrows(&self, before: &SubmissionConsent) -> bool {
        !self.widens_name(before)
            && self.attribution.name == before.attribution.name
            && (!self.clarification || before.clarification)
            && (self.feature_revision.is_none() || self.feature_revision == before.feature_revision)
    }

    fn same_terms(&self, other: &SubmissionConsent) -> bool {
        self.publish == other.publish
            && self.attribution == other.attribution
            && self.clarification == other.clarification
            && self.feature_revision == other.feature_revision
    }
}

/// The consent a reader gives with a submission.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ConsentChoices {
    /// Must be true: a Third Perspective is offered for publication.
    pub publish: bool,
    pub clarification: bool,
    /// Agreement that an editor may feature the text as submitted.
    pub feature: bool,
}

/// A reader's change to their consent, proven by the server (their receipt
/// or an Admin user's entry of their message).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsentChange {
    pub publish: bool,
    pub attribution: ReaderAttribution,
    pub clarification: bool,
    /// What the change does to the reader's feature consent. Only an explicit
    /// [`FeatureChange::Agree`] for the revision the reader saw binds it; any
    /// other change carries it forward unchanged (ADR 0177).
    pub feature: FeatureChange,
}

/// A reader's choice about feature consent in one consent change. It is
/// deliberately not a flag: a change to something else (such as being asked
/// to clarify) must never renew an agreement for text the reader has not
/// seen, so "leave it as it is" and "agree to this text" are different
/// choices.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeatureChange {
    /// Carry the feature consent in effect forward exactly as it is, bound
    /// to whatever revision it was bound to.
    Keep,
    /// Agree that an editor may feature `revision_seen`, which must be the
    /// revision the reader is looking at: the approved one once approved, the
    /// current one before a decision.
    Agree { revision_seen: u32 },
    /// Take the agreement back.
    Decline,
}

/// What a recorded consent change asks of moderation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsentOutcome {
    /// Recorded; the public projection follows it at once.
    Recorded,
    /// Publication revoked on a hosted copy: apply RD12's `withdraw` by
    /// `Actor::Submitter` in the same write. Its text is purged at once.
    Withdraw,
    /// Publication revoked on a manual copy, which has no submitter RD12
    /// would accept: apply a site Admin's `Remove` in the same write, then
    /// purge the text at once. The consent change is still recorded.
    RemoveAndPurge,
}

// ---------------------------------------------------------------------------
// Moderation facts (RD12's)

/// The server-side moderation facts of one copy: the fields of RD12's
/// [`ItemFacts`] this module reads, plus the consent record an approval bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModerationFacts {
    pub state: ModerationState,
    /// The text revision, raised only when a clarification replaces it.
    pub revision: u32,
    /// The revision an approval covers, set only while approved.
    pub approved_revision: Option<u32>,
    /// The consent record an approval covers, set only while approved.
    pub approved_consent: Option<u32>,
    /// The revision a moderator last asked the reader to clarify (RD12's
    /// `clarification_asked`). While it is the current revision the text is
    /// never public.
    pub clarification_asked: Option<u32>,
    /// Whether the text, name and consent are still stored.
    pub content_retained: bool,
}

impl ModerationFacts {
    /// RD12's facts of the stored item, with the consent record its approval
    /// bound (stored with the approval, set only while approved).
    pub fn from_item(item: &ItemFacts<'_>, approved_consent: Option<u32>) -> Self {
        Self {
            state: item.state,
            revision: item.revision,
            approved_revision: item.approved_revision,
            approved_consent: approved_consent.filter(|_| item.state == ModerationState::Approved),
            clarification_asked: item.clarification_asked,
            content_retained: item.content_retained,
        }
    }
}

/// Where a reflection is in its lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Stage {
    /// A private draft on the reader's device. The site holds nothing.
    Local,
    /// Received and waiting for a moderator. Private.
    Submitted,
    /// A moderator asked the reader to clarify. Private.
    Clarification,
    /// Approved: public while its kind is shown and the consent holds.
    Approved,
    /// Declined, or expired unmoderated. Private.
    Rejected,
    /// Taken down after approval. Private.
    Removed,
    /// Taken back by the reader. Private and final.
    Withdrawn,
    /// Text, name and consent purged; only the audit trail remains.
    Deleted,
}

impl Stage {
    pub fn id(self) -> &'static str {
        match self {
            Stage::Local => "local",
            Stage::Submitted => "submitted",
            Stage::Clarification => "clarification",
            Stage::Approved => "approved",
            Stage::Rejected => "rejected",
            Stage::Removed => "removed",
            Stage::Withdrawn => "withdrawn",
            Stage::Deleted => "deleted",
        }
    }

    /// The stage of a stored copy. Purged text is deleted whatever its state.
    pub fn of(facts: &ModerationFacts) -> Self {
        if !facts.content_retained {
            return Stage::Deleted;
        }
        match facts.state {
            ModerationState::Pending => Stage::Submitted,
            ModerationState::Clarification => Stage::Clarification,
            ModerationState::Approved => Stage::Approved,
            ModerationState::Rejected => Stage::Rejected,
            ModerationState::Removed => Stage::Removed,
            ModerationState::Withdrawn => Stage::Withdrawn,
        }
    }
}

/// A moderator's approval request, naming what they reviewed.
#[derive(Clone, Copy, Debug)]
pub struct ApprovalRequest<'a> {
    /// The moderator's account (RD12's audit `actorId`). Never empty.
    pub moderator: &'a str,
    pub seen_revision: u32,
    pub seen_consent: u32,
    pub at: DateTime,
}

/// What an approval binds: one text revision under one consent record,
/// decided by a named moderator. Store `revision` and `consent` with RD12's
/// approve transition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalBinding {
    pub revision: u32,
    pub consent: u32,
    pub approved_by: String,
    pub approved_at: DateTime,
}

/// The published work a reflection is shown with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedWork {
    pub path: String,
    /// Its passage revision now.
    pub revision: String,
    /// Every name its work credits show: each author and any group.
    pub credited: Vec<String>,
}

// ---------------------------------------------------------------------------
// Text

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn forbidden_in_body(character: char) -> bool {
    (character.is_control() && !matches!(character, '\t' | '\n'))
        || crate::research_notes::bidi_override(character)
}

/// A reflection as stored: line breaks as `\n`, trimmed, 1 to
/// [`MAX_BODY_CHARS`] characters of plain text. It is never read as
/// Markdown or HTML.
pub(crate) fn normalize_body(value: &str) -> Option<String> {
    let text = value.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim();
    let count = text.chars().count();
    ((1..=MAX_BODY_CHARS).contains(&count) && !text.chars().any(forbidden_in_body))
        .then(|| text.to_string())
}

fn body_error() -> ThirdPerspectiveError {
    ThirdPerspectiveError::new(
        ErrorCode::InvalidBody,
        format!("`body` must be 1 to {MAX_BODY_CHARS} characters of plain text"),
    )
}

fn read_category(id: Option<&str>) -> Result<Option<ResponseCategory>, ThirdPerspectiveError> {
    id.map(|id| {
        ResponseCategory::from_id(id).ok_or_else(|| {
            ThirdPerspectiveError::new(
                ErrorCode::UnknownCategory,
                "`category` must be one of the response categories, or left out",
            )
        })
    })
    .transpose()
}

fn read_kind(kind: &str) -> Result<(), ThirdPerspectiveError> {
    if kind == KIND.id() {
        Ok(())
    } else {
        Err(ThirdPerspectiveError::new(
            ErrorCode::WrongKind,
            format!("`kind` must be `{KIND}`"),
        ))
    }
}

fn read_json(text: &str, what: &str) -> Result<Value, ThirdPerspectiveError> {
    if text.len() > MAX_JSON_BYTES {
        return Err(ThirdPerspectiveError::new(
            ErrorCode::TooLarge,
            format!("a {what} is larger than {MAX_JSON_BYTES} bytes"),
        ));
    }
    let value: Value = serde_json::from_str(text).map_err(|_| {
        ThirdPerspectiveError::new(ErrorCode::Malformed, format!("a {what} is not valid JSON"))
    })?;
    match value.get("version").and_then(Value::as_u64) {
        Some(THIRD_PERSPECTIVE_VERSION) => Ok(value),
        Some(version) if version > THIRD_PERSPECTIVE_VERSION => Err(ThirdPerspectiveError::new(
            ErrorCode::UnsupportedVersion,
            format!("this {what} is version {version}, newer than the version {THIRD_PERSPECTIVE_VERSION} this open.blog reads"),
        )),
        _ => Err(ThirdPerspectiveError::new(
            ErrorCode::Malformed,
            format!("a {what} needs `version` 1"),
        )),
    }
}

fn wire_error(what: &str) -> ThirdPerspectiveError {
    ThirdPerspectiveError::new(
        ErrorCode::Malformed,
        format!("a {what} has a field this version does not define, or a field of the wrong type"),
    )
}

// ---------------------------------------------------------------------------
// Local reflection and submission

/// A reader's private draft. It lives only on the reader's device: it has
/// no id, provenance, consent or moderation state, and becomes a
/// [`SubmissionRequest`] only when the reader chooses to send it with their
/// consent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalReflection {
    pub work: String,
    /// The passage revision of the page the reader is reading.
    pub revision: String,
    pub target: PerspectiveTarget,
    pub category: Option<ResponseCategory>,
    pub body: String,
    pub attribution: ReaderAttribution,
    pub seen_at: Option<DateTime>,
}

impl LocalReflection {
    pub fn stage(&self) -> Stage {
        Stage::Local
    }

    /// The request a reader sends, with the consent they chose.
    pub fn submission(self, consent: ConsentChoices) -> SubmissionRequest {
        SubmissionRequest {
            reflection: self,
            consent,
        }
    }
}

/// What a reader sends: their reflection and their consent. Untrusted until
/// [`SubmissionRequest::receive`] checks it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubmissionRequest {
    pub reflection: LocalReflection,
    pub consent: ConsentChoices,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireRequest<T = Value> {
    version: u64,
    kind: String,
    work: String,
    revision: String,
    target: T,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seen_at: Option<String>,
    #[serde(default)]
    attribution: ReaderAttribution,
    consent: WireChoices,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireChoices {
    publish: bool,
    #[serde(default)]
    clarification: bool,
    #[serde(default)]
    feature: bool,
}

impl SubmissionRequest {
    /// Read a request a browser sent:
    /// `{version, kind, work, revision, target, category?, body, seenAt?,
    /// attribution?, consent: {publish, clarification?, feature?}}`.
    /// `consent.publish` must be present.
    pub fn from_json(text: &str) -> Result<Self, ThirdPerspectiveError> {
        let value = read_json(text, "Third Perspective submission")?;
        let wire: WireRequest = serde_json::from_value(value)
            .map_err(|_| wire_error("Third Perspective submission"))?;
        read_kind(&wire.kind)?;
        Ok(Self {
            reflection: LocalReflection {
                target: PerspectiveTarget::from_value(&wire.target)?,
                category: read_category(wire.category.as_deref())?,
                seen_at: wire
                    .seen_at
                    .as_deref()
                    .map(|seen| parse_time("seenAt", seen))
                    .transpose()?,
                work: wire.work,
                revision: wire.revision,
                body: wire.body,
                attribution: wire.attribution,
            },
            consent: ConsentChoices {
                publish: wire.consent.publish,
                clarification: wire.consent.clarification,
                feature: wire.consent.feature,
            },
        })
    }

    pub fn to_json(&self) -> String {
        let reflection = &self.reflection;
        serde_json::to_string(&WireRequest {
            version: THIRD_PERSPECTIVE_VERSION,
            kind: KIND.id().into(),
            work: reflection.work.clone(),
            revision: reflection.revision.clone(),
            target: reflection.target.to_value(),
            category: reflection.category.map(|category| category.id().into()),
            body: reflection.body.clone(),
            seen_at: reflection.seen_at.map(DateTime::rfc3339),
            attribution: reflection.attribution.clone(),
            consent: WireChoices {
                publish: self.consent.publish,
                clarification: self.consent.clarification,
                feature: self.consent.feature,
            },
        })
        .expect("a submission always serializes")
    }

    /// The copy a receiver keeps: the hosted function stamps `received_at`
    /// itself; an Admin user entering a reader's message records when it
    /// came. Text and name are normalized, a `seen_at` later than
    /// `received_at` is dropped, and the consent becomes record 1. Without
    /// agreement to publish nothing is kept.
    pub fn receive(
        self,
        received_at: DateTime,
        intake: Intake,
    ) -> Result<SubmittedCopy, ThirdPerspectiveError> {
        if !self.consent.publish {
            return Err(ThirdPerspectiveError::new(
                ErrorCode::PublicationConsentRequired,
                "a Third Perspective is submitted for publication; `consent.publish` must be true",
            ));
        }
        let reflection = self.reflection;
        let body = normalize_body(&reflection.body).ok_or_else(body_error)?;
        let attribution = normalized_attribution(reflection.attribution);
        let copy = SubmittedCopy {
            category: reflection.category,
            body,
            revision: 1,
            revised_at: None,
            provenance: Provenance {
                work: reflection.work,
                revision: reflection.revision,
                target: reflection.target.into(),
                seen_at: reflection.seen_at.filter(|seen| *seen <= received_at),
                received_at,
                channel: intake.channel(),
                attribution: attribution.clone(),
            },
            intake,
            consents: vec![SubmissionConsent {
                number: 1,
                given_at: received_at,
                publish: true,
                attribution,
                clarification: self.consent.clarification,
                feature_revision: self.consent.feature.then_some(1),
            }],
        };
        copy.validate()?;
        Ok(copy)
    }
}

// ---------------------------------------------------------------------------
// Submitted copy

/// The site's private copy of a submitted reflection: the current text, its
/// provenance, who can act for the submitter, and the reader's consent
/// history. Moderation data, never public as such, never a research note or
/// an author's contribution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubmittedCopy {
    pub category: Option<ResponseCategory>,
    /// The current revision's text.
    pub body: String,
    /// RD12's text revision: 1, raised only by a clarification.
    pub revision: u32,
    /// When the current revision arrived; `None` for revision 1.
    pub revised_at: Option<DateTime>,
    pub provenance: Provenance,
    pub intake: Intake,
    /// Every consent record, oldest first; the last is in effect.
    pub consents: Vec<SubmissionConsent>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireRecord<P = Value> {
    version: u64,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    body: String,
    revision: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revised_at: Option<String>,
    provenance: P,
    intake: WireIntake,
    consents: Vec<WireConsent>,
}

/// A row's `details`, as stored (ADR 0113).
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    intake: WireIntake,
    consents: Vec<WireConsent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revised_at: Option<String>,
}

impl SubmittedCopy {
    /// The consent in effect.
    pub fn consent(&self) -> &SubmissionConsent {
        self.consents
            .last()
            .expect("a validated copy has a consent record")
    }

    /// The consent record numbered `number`.
    pub fn consent_record(&self, number: u32) -> Option<&SubmissionConsent> {
        self.consents.iter().find(|record| record.number == number)
    }

    fn history_error(message: &str) -> ThirdPerspectiveError {
        ThirdPerspectiveError::new(ErrorCode::InvalidConsentHistory, message)
    }

    /// Check every rule (ADRs 0109 to 0111).
    pub fn validate(&self) -> Result<(), ThirdPerspectiveError> {
        if normalize_body(&self.body).as_deref() != Some(self.body.as_str()) {
            return Err(body_error());
        }
        validate_provenance(&self.provenance)?;
        self.intake.validate()?;
        if self.intake.channel() != self.provenance.channel {
            return Err(ThirdPerspectiveError::new(
                ErrorCode::InvalidIntake,
                "`intake` does not match `provenance.channel`",
            ));
        }
        match (self.revision, self.revised_at) {
            (0, _) => {
                return Err(ThirdPerspectiveError::new(
                    ErrorCode::Malformed,
                    "`revision` starts at 1",
                ))
            }
            (1, None) => {}
            (1, Some(_)) | (_, None) => {
                return Err(ThirdPerspectiveError::new(
                    ErrorCode::InvalidTime,
                    "`revisedAt` is set exactly when `revision` is above 1",
                ))
            }
            (_, Some(revised)) if revised < self.provenance.received_at => {
                return Err(ThirdPerspectiveError::new(
                    ErrorCode::InvalidTime,
                    "`revisedAt` is earlier than `provenance.receivedAt`",
                ))
            }
            _ => {}
        }
        // The last slot is kept for a revocation.
        let limit = match self.consents.last() {
            Some(last) if last.publish => MAX_CONSENT_RECORDS - 1,
            _ => MAX_CONSENT_RECORDS,
        };
        if self.consents.is_empty() || self.consents.len() > limit {
            return Err(Self::history_error(
                "`consents` holds 1 to 49 consent records, and a revocation after them",
            ));
        }
        if !self.within_bounds(0) {
            return Err(Self::history_error(
                "the consent records are larger than a stored copy may hold",
            ));
        }
        let first = &self.consents[0];
        if first.given_at != self.provenance.received_at
            || !first.publish
            || first.attribution != self.provenance.attribution
        {
            return Err(Self::history_error(
                "the first consent record is the one received with the submission",
            ));
        }
        let last = self.consents.len() - 1;
        for (index, record) in self.consents.iter().enumerate() {
            if record.number as usize != index + 1 {
                return Err(Self::history_error(
                    "consent records are numbered 1, 2, 3 and so on",
                ));
            }
            if index > 0 && record.given_at < self.consents[index - 1].given_at {
                return Err(Self::history_error("consent records are in time order"));
            }
            if !record.publish && (index != last || record.feature_revision.is_some()) {
                return Err(Self::history_error(
                    "revoking publication is final and covers no feature",
                ));
            }
            if record
                .feature_revision
                .is_some_and(|revision| revision == 0 || revision > self.revision)
            {
                return Err(Self::history_error(
                    "`featureRevision` names a revision of this reflection",
                ));
            }
            validate_attribution(&record.attribution, "consents.attribution")?;
        }
        Ok(())
    }

    /// Read a stored copy, refusing a newer version, an unknown field or any
    /// broken rule. Nothing is repaired.
    pub fn from_json(text: &str) -> Result<Self, ThirdPerspectiveError> {
        let value = read_json(text, "Third Perspective record")?;
        let wire: WireRecord =
            serde_json::from_value(value).map_err(|_| wire_error("Third Perspective record"))?;
        read_kind(&wire.kind)?;
        let provenance = provenance_from_value(&wire.provenance)?;
        let mut name = provenance.attribution.name.clone();
        let consents = wire
            .consents
            .into_iter()
            .map(|record| {
                name = match record.attribution.name {
                    None => name.take(),
                    Some(written) if written.is_empty() => None,
                    Some(written) => Some(written),
                };
                Ok(SubmissionConsent {
                    number: record.number,
                    given_at: parse_time("consents.givenAt", &record.given_at)?,
                    publish: record.publish,
                    attribution: ReaderAttribution {
                        name: name.clone(),
                        publish_name: record.attribution.publish_name,
                    },
                    clarification: record.clarification,
                    feature_revision: record.feature_revision,
                })
            })
            .collect::<Result<Vec<_>, ThirdPerspectiveError>>()?;
        let copy = Self {
            category: read_category(wire.category.as_deref())?,
            body: wire.body,
            revision: wire.revision,
            revised_at: wire
                .revised_at
                .as_deref()
                .map(|revised| parse_time("revisedAt", revised))
                .transpose()?,
            provenance,
            intake: Intake::from_wire(wire.intake)?,
            consents,
        };
        copy.validate()?;
        Ok(copy)
    }

    /// Canonical JSON, in a fixed field order. Private: for storage and the
    /// moderation inbox only.
    pub fn to_json(&self) -> String {
        serde_json::to_string(&WireRecord {
            version: THIRD_PERSPECTIVE_VERSION,
            kind: KIND.id().into(),
            category: self.category.map(|category| category.id().into()),
            body: self.body.clone(),
            revision: self.revision,
            revised_at: self.revised_at.map(DateTime::rfc3339),
            provenance: provenance_value(&self.provenance),
            intake: self.intake.wire(),
            consents: self.wire_consents(),
        })
        .expect("a record always serializes")
    }

    fn wire_consents(&self) -> Vec<WireConsent> {
        let mut previous = &self.provenance.attribution.name;
        self.consents
            .iter()
            .map(|record| {
                let name = &record.attribution.name;
                let written = (name != previous).then(|| name.clone().unwrap_or_default());
                previous = name;
                WireConsent {
                    number: record.number,
                    given_at: record.given_at.rfc3339(),
                    publish: record.publish,
                    attribution: WireAttribution {
                        name: written,
                        publish_name: record.attribution.publish_name,
                    },
                    clarification: record.clarification,
                    feature_revision: record.feature_revision,
                }
            })
            .collect()
    }

    fn stored(&self) -> StoredDetails {
        StoredDetails {
            category: self.category.map(|category| category.id().to_string()),
            intake: self.intake.wire(),
            consents: self.wire_consents(),
            revised_at: self.revised_at.map(DateTime::rfc3339),
        }
    }

    /// What one `openblog_feedback` row keeps in `details` (ADR 0113):
    /// `{category?, intake, consents, revisedAt?}`. The other parts of the
    /// copy have columns of their own: the text in `body`, its revision in
    /// `item_revision`, and the provenance in `work`, `revision`, `target`,
    /// `seen_at`, `received_at`, `channel`, `reader_name` and `publish_name`.
    pub fn stored_details(&self) -> Value {
        serde_json::to_value(self.stored()).expect("details always serialize")
    }

    /// The size of what the row keeps as `details`, which B5's table bounds
    /// at [`MAX_DETAILS_BYTES`].
    pub fn details_bytes(&self) -> usize {
        serde_json::to_string(&self.stored())
            .expect("details always serialize")
            .len()
    }

    /// Read a copy from the parts of a stored row: its text, its text
    /// revision, its `details` and its provenance (B5's record). Every rule
    /// of [`SubmittedCopy::from_json`] applies; nothing is repaired.
    pub fn from_stored(
        body: &str,
        revision: u32,
        details: &Value,
        provenance: &Value,
    ) -> Result<Self, ThirdPerspectiveError> {
        let stored: StoredDetails = serde_json::from_value(details.clone())
            .map_err(|_| wire_error("Third Perspective's stored details"))?;
        let mut record = serde_json::json!({
            "version": THIRD_PERSPECTIVE_VERSION,
            "kind": KIND.id(),
            "body": body,
            "revision": revision,
            "provenance": provenance,
            "intake": stored.intake,
            "consents": stored.consents,
        });
        if let Some(category) = stored.category {
            record["category"] = Value::String(category);
        }
        if let Some(revised_at) = stored.revised_at {
            record["revisedAt"] = Value::String(revised_at);
        }
        Self::from_json(&record.to_string())
    }

    fn within_bounds(&self, reserve: usize) -> bool {
        self.details_bytes() + reserve <= MAX_DETAILS_BYTES
            && self.to_json().len() + reserve <= MAX_JSON_BYTES
    }

    fn in_step(&self, facts: &ModerationFacts) -> Result<(), LifecycleError> {
        if !facts.content_retained {
            return Err(LifecycleError::ContentPurged);
        }
        if facts.revision != self.revision {
            return Err(LifecycleError::OutOfStep);
        }
        Ok(())
    }

    /// Whether the moderator may approve now, and what the approval binds.
    /// Check this before RD12's `approve`, and store the binding with it.
    pub fn check_approval(
        &self,
        facts: &ModerationFacts,
        request: &ApprovalRequest<'_>,
    ) -> Result<ApprovalBinding, LifecycleError> {
        let moderator = request.moderator;
        if moderator.is_empty()
            || moderator.len() > MAX_MODERATOR_CHARS
            || moderator
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(LifecycleError::AnonymousModerator);
        }
        self.in_step(facts)?;
        if facts.state != ModerationState::Pending {
            return Err(LifecycleError::NotPending);
        }
        let consent = self.consent();
        if !consent.publish {
            return Err(LifecycleError::PublicationNotConsented);
        }
        if request.seen_revision != self.revision {
            return Err(LifecycleError::StaleRevision);
        }
        if request.seen_consent != consent.number {
            return Err(LifecycleError::StaleConsent);
        }
        Ok(ApprovalBinding {
            revision: self.revision,
            consent: consent.number,
            approved_by: moderator.to_string(),
            approved_at: request.at,
        })
    }

    /// Record a consent change. Narrowing (hiding a name, declining
    /// clarification or a feature) takes effect at once in every state the
    /// text is kept. Showing a name, or another name, is accepted only while
    /// undecided (pending or clarification). Feature consent changes only by
    /// its own [`FeatureChange`]: `Keep` leaves it bound to the revision it
    /// was, so a change to something else never renews it for edited text,
    /// and `Agree` binds it to the revision the reader saw (the approved one,
    /// or before a decision the current one). Revoking
    /// publication is final and asks for RD12's withdrawal where it applies
    /// (a site Admin's removal and purge for a manual copy).
    pub fn revise_consent(
        &mut self,
        facts: &ModerationFacts,
        change: ConsentChange,
        at: DateTime,
    ) -> Result<ConsentOutcome, LifecycleError> {
        self.in_step(facts)?;
        let current = self.consent().clone();
        if !current.publish || facts.state == ModerationState::Withdrawn {
            return Err(LifecycleError::Closed);
        }
        if at < current.given_at {
            return Err(LifecycleError::InvalidTime);
        }
        let number = current.number + 1;
        // Revoking never depends on anything else the change says, and the
        // last of the [`MAX_CONSENT_RECORDS`] slots is kept for it.
        if !change.publish {
            self.consents.push(SubmissionConsent {
                number,
                given_at: at,
                publish: false,
                attribution: ReaderAttribution {
                    publish_name: false,
                    ..current.attribution
                },
                clarification: false,
                feature_revision: None,
            });
            return Ok(match (facts.state, &self.intake) {
                (
                    ModerationState::Pending
                    | ModerationState::Clarification
                    | ModerationState::Approved,
                    Intake::Hosted { .. },
                ) => ConsentOutcome::Withdraw,
                (
                    ModerationState::Pending
                    | ModerationState::Clarification
                    | ModerationState::Approved,
                    Intake::Manual { .. },
                ) => ConsentOutcome::RemoveAndPurge,
                _ => ConsentOutcome::Recorded,
            });
        }
        let attribution = normalized_attribution(change.attribution);
        check_attribution(&attribution).map_err(|code| match code {
            ErrorCode::ConsentWithoutName => LifecycleError::ConsentWithoutName,
            _ => LifecycleError::InvalidName,
        })?;
        let undecided = matches!(
            facts.state,
            ModerationState::Pending | ModerationState::Clarification
        );
        let feature_revision = match change.feature {
            FeatureChange::Decline => None,
            FeatureChange::Keep => current.feature_revision,
            FeatureChange::Agree { revision_seen } => {
                let bindable = if undecided {
                    Some(self.revision)
                } else if facts.state == ModerationState::Approved {
                    facts.approved_revision
                } else {
                    None
                };
                match bindable {
                    None => return Err(LifecycleError::FeatureNotAvailable),
                    Some(revision) if revision != revision_seen => {
                        return Err(LifecycleError::StaleRevision)
                    }
                    Some(revision) => Some(revision),
                }
            }
        };
        let record = SubmissionConsent {
            number,
            given_at: at,
            publish: true,
            attribution,
            clarification: change.clarification,
            feature_revision,
        };
        if record.same_terms(&current) {
            return Err(LifecycleError::Unchanged);
        }
        if record.widens_name(&current) && !undecided {
            return Err(LifecycleError::WideningAfterDecision);
        }
        // Slots and bytes are kept for what a reader must always be able to
        // do: revoke, and narrow. A change that only narrows may use the
        // narrowing reserve; any other keeps clear of both.
        let narrows = record.narrows(&current);
        let (slots, bytes) = if narrows {
            (MAX_CONSENT_RECORDS - 1, 256)
        } else {
            (
                MAX_CONSENT_RECORDS - 1 - NARROWING_RESERVE,
                CONSENT_RESERVE_BYTES,
            )
        };
        self.consents.push(record);
        if self.consents.len() > slots || !self.within_bounds(bytes) {
            self.consents.pop();
            return Err(LifecycleError::ConsentLimit);
        }
        Ok(ConsentOutcome::Recorded)
    }

    /// Whether the reader can answer a clarification: only a hosted copy has
    /// a submitter (RD12's `Actor::Submitter`, proven by a receipt). A
    /// manual copy cannot be clarified.
    pub fn can_clarify(&self) -> bool {
        matches!(self.intake, Intake::Hosted { .. })
    }

    /// The reader's answer to a clarification request: it replaces the text
    /// as the next revision (apply RD12's `clarify` in the same write). The
    /// text asked about is never approved; a feature consent for it no
    /// longer covers the new text.
    pub fn clarify(
        &mut self,
        facts: &ModerationFacts,
        body: &str,
        at: DateTime,
    ) -> Result<u32, LifecycleError> {
        self.in_step(facts)?;
        if !self.can_clarify() {
            return Err(LifecycleError::ClarificationUnavailable);
        }
        if facts.state != ModerationState::Clarification {
            return Err(LifecycleError::NotInClarification);
        }
        if !self.consent().publish {
            return Err(LifecycleError::Closed);
        }
        let latest = self.revised_at.unwrap_or(self.provenance.received_at);
        if at < latest {
            return Err(LifecycleError::InvalidTime);
        }
        self.body = normalize_body(body).ok_or(LifecycleError::InvalidBody)?;
        self.revision += 1;
        self.revised_at = Some(at);
        Ok(self.revision)
    }

    /// Whether the name the reader gave is one the work credits, for the
    /// moderation inbox. Such a name is never shown with the reflection.
    pub fn name_matches_credit(&self, credited: &[String]) -> bool {
        self.consent()
            .attribution
            .name
            .as_deref()
            .is_some_and(|name| matches_credit(name, credited))
    }

    /// The one public form of this copy (ADR 0111), or `None` while it may
    /// not be shown: only approved, at the current revision and under a
    /// consent record that still allows publication, with the text kept and
    /// the kind shown on the work: `mode` is RD12's
    /// `effective_mode(config, post, ParticipationKind::ThirdPerspective)`,
    /// and only a mode that [shows approved items](ParticipationMode::shows_approved)
    /// shows it. A clarification request about the current text keeps it
    /// private, so a response here is always one RD12's `is_public` allows.
    /// The name appears only while both the approved and the current
    /// consent show that same name, and never when it matches a name the
    /// work credits.
    pub fn approved_response(
        &self,
        facts: &ModerationFacts,
        mode: ParticipationMode,
        work: &PublishedWork,
        target: &TargetStatus,
    ) -> Option<ApprovedResponse> {
        if !mode.shows_approved()
            || !facts.content_retained
            || facts.clarification_asked == Some(facts.revision)
            || facts.state != ModerationState::Approved
            || facts.revision != self.revision
            || facts.approved_revision != Some(self.revision)
            || work.path != self.provenance.work
        {
            return None;
        }
        let current = self.consent();
        let approved = self.consent_record(facts.approved_consent?)?;
        if !current.publish || !approved.publish {
            return None;
        }
        let name = match (
            approved.attribution.public_name(),
            current.attribution.public_name(),
        ) {
            (Some(approved), Some(current)) if approved == current => Some(current),
            _ => None,
        };
        project(
            PublicParts {
                work: &self.provenance.work,
                revision: &self.provenance.revision,
                target: &self.provenance.target,
                category: self.category,
                body: &self.body,
                name,
                received: self.provenance.received_at.ymd(),
            },
            mode,
            work,
            target,
        )
    }

    /// Whether the reader's consent in effect agrees to feature exactly
    /// `revision` of their text (ADR 0110); none agrees to feature any other.
    pub fn feature_covers(&self, revision: u32) -> bool {
        self.consent().publish && self.consent().feature_revision == Some(revision)
    }
}

/// What the one public projection reads of an approved copy: only parts
/// that may be public once the caller has checked approval and consent. A
/// published record (`perspective_publication`) keeps exactly these, so the
/// canonical page and the inbox's preview project through the same code.
pub(crate) struct PublicParts<'a> {
    pub work: &'a str,
    /// The passage revision the reader saw.
    pub revision: &'a str,
    pub target: &'a PassageTarget,
    pub category: Option<ResponseCategory>,
    pub body: &'a str,
    /// The name both the approved and the current consent show, if any.
    pub name: Option<&'a str>,
    /// The day it was received, `YYYY-MM-DD`.
    pub received: String,
}

/// The one public projection (ADR 0111), once approval and consent allow
/// it: only where the kind shows approved items, only on the work it is
/// about, never with a name the work credits, and with the target's
/// standing in the work as published now.
pub(crate) fn project(
    parts: PublicParts<'_>,
    mode: ParticipationMode,
    work: &PublishedWork,
    target: &TargetStatus,
) -> Option<ApprovedResponse> {
    if !mode.shows_approved() || work.path != parts.work {
        return None;
    }
    let name = parts
        .name
        .filter(|name| !matches_credit(name, &work.credited))
        .map(str::to_string);
    let anchor = &parts.target.section;
    let (about, section, stale) = match (&parts.target.selector, target) {
        (PassageSelector::Work, _) => (About::Work, None, false),
        (_, TargetStatus::Current { section }) => (About::Section, section.clone(), false),
        (_, TargetStatus::Stale { section_present }) => (
            About::Section,
            anchor.clone().filter(|_| *section_present),
            true,
        ),
    };
    Some(ApprovedResponse {
        kind: KIND,
        role: READER_ROLE,
        work: parts.work.to_string(),
        about,
        section,
        stale,
        earlier_revision: parts.revision != work.revision,
        category: parts.category,
        body: parts.body.to_string(),
        name,
        received: parts.received,
    })
}

/// Whether `name` is a name the work credits, compared the way a reader would
/// see it: invisible and default-ignorable characters and combining marks
/// are dropped, accented Latin letters fold to their base letter, whitespace
/// collapses and case is ignored. Folding both sides the same way means a
/// precomposed and a decomposed spelling meet.
fn matches_credit(name: &str, credited: &[String]) -> bool {
    let name = credit_fold(name);
    credited.iter().any(|credit| credit_fold(credit) == name)
}

fn credit_fold(value: &str) -> String {
    let visible: String = value
        .chars()
        .filter(|&c| !crate::collaboration::is_invisible(c) && !is_combining_mark(c))
        .collect();
    collapse_whitespace(&visible)
        .to_lowercase()
        .chars()
        .map(base_letter)
        .collect()
}

/// Combining marks, which a decomposed spelling puts after the base letter.
fn is_combining_mark(c: char) -> bool {
    matches!(
        c,
        '\u{0300}'..='\u{036F}'
            | '\u{0483}'..='\u{0489}'
            | '\u{0591}'..='\u{05BD}'
            | '\u{0610}'..='\u{061A}'
            | '\u{064B}'..='\u{065F}'
            | '\u{1AB0}'..='\u{1AFF}'
            | '\u{1DC0}'..='\u{1DFF}'
            | '\u{20D0}'..='\u{20FF}'
            | '\u{FE20}'..='\u{FE2F}'
    )
}

/// The base letter of a lowercase Latin letter with a diacritic (Latin-1
/// Supplement and Latin Extended-A), so a precomposed letter meets the same
/// letter written with a combining mark. A conservative table: it also folds
/// letters such as `ø` and `ł`, which only makes more names count as a match.
fn base_letter(c: char) -> char {
    const TABLE: [(char, &str); 19] = [
        ('a', "àáâãäåāăą"),
        ('c', "çćĉċč"),
        ('d', "ďđ"),
        ('e', "èéêëēĕėęě"),
        ('g', "ĝğġģ"),
        ('h', "ĥħ"),
        ('i', "ìíîïĩīĭįı"),
        ('j', "ĵ"),
        ('k', "ķ"),
        ('l', "ĺļľŀł"),
        ('n', "ñńņňŉ"),
        ('o', "òóôõöøōŏő"),
        ('r', "ŕŗř"),
        ('s', "śŝşš"),
        ('t', "ţťŧ"),
        ('u', "ùúûüũūŭůűų"),
        ('w', "ŵ"),
        ('y', "ýÿŷ"),
        ('z', "źżž"),
    ];
    TABLE
        .iter()
        .find(|(_, folded)| folded.contains(c))
        .map_or(c, |(base, _)| *base)
}

// ---------------------------------------------------------------------------
// Public projection

/// The only role a Third Perspective is shown with.
pub const READER_ROLE: &str = "reader";

/// What an approved response is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum About {
    Work,
    Section,
}

/// The one public form of a Third Perspective: the canonical page's view of
/// an approved copy. It has no field for provenance, intake, consent,
/// moderation state, reasons, revisions, ids, the reader's clock or an
/// unpublished name, so nothing that renders it can show them. It is shown
/// apart from the authors' sections, as a reader's reflection, and never
/// joins the Post, its credits, feeds or portable exports.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedResponse {
    /// Always `third-perspective`.
    pub kind: ParticipationKind,
    /// Always `reader`: never an author's perspective.
    pub role: &'static str,
    pub work: String,
    pub about: About,
    /// The section it is about now; for a stale section, its old heading id
    /// only while that section still exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    /// The section the reader wrote about has changed or gone.
    pub stale: bool,
    /// The reader read an earlier revision of the work.
    pub earlier_revision: bool,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "category_id"
    )]
    pub category: Option<ResponseCategory>,
    /// Plain text; renderers escape it and split paragraphs at blank lines.
    pub body: String,
    /// The reader's name, only with their agreement; otherwise anonymous.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The day it was received, `YYYY-MM-DD`.
    pub received: String,
}

fn category_id<S: serde::Serializer>(
    category: &Option<ResponseCategory>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match category {
        Some(category) => serializer.serialize_str(category.id()),
        None => serializer.serialize_none(),
    }
}

impl ApprovedResponse {
    /// The accessible heading a page gives it: always a reader's, never an
    /// author's or a group's.
    pub fn heading(&self) -> String {
        match &self.name {
            Some(name) => format!("{} from {name}, a reader", KIND.label()),
            None => format!("{} from a reader", KIND.label()),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("a public response always serializes")
    }
}

// ---------------------------------------------------------------------------
// The hosted row, as the one moderation inbox reads it (ADR 0113)

impl PublishedWork {
    /// A post as published now: its path, its passage revision and every
    /// name its work credits show, the site's own author among them.
    pub fn of_post(post: &crate::Post, config: &crate::SiteConfig) -> Self {
        let mut credited: Vec<String> = post
            .credits
            .iter()
            .map(|credit| credit.contributor.name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect();
        let author = config.author.name.trim();
        if !author.is_empty() && !credited.iter().any(|name| name == author) {
            credited.push(author.to_string());
        }
        Self {
            path: post.url.clone(),
            revision: crate::passage_target::PassageDocument::of_post(post, config).revision,
            credited,
        }
    }
}

/// One Third Perspective as the hosted inbox returns it: the row's
/// moderation facts (RD12's columns), the consent record its approval binds,
/// and the copy read back from the row's text, revision, `details` and
/// provenance with every rule of [`SubmittedCopy`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedPerspective {
    pub id: String,
    pub state: ModerationState,
    pub version: u64,
    pub moderated_at: Option<DateTime>,
    pub reason: Option<crate::moderation::ReasonCode>,
    pub copy: SubmittedCopy,
    /// Set only while approved.
    pub approved_revision: Option<u32>,
    /// The consent record the approval covers; set only while approved.
    pub approved_consent: Option<u32>,
    pub clarification_asked: Option<u32>,
    /// RD12's column, and only while the consent in effect agrees: a reader
    /// who declined is never asked.
    pub clarification_consent: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireHostedPerspective {
    id: String,
    status: String,
    version: u64,
    #[serde(default)]
    moderated_at: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    feedback: WireHostedRecord,
    #[serde(default)]
    item_revision: Option<u64>,
    #[serde(default)]
    approved_revision: Option<u64>,
    #[serde(default)]
    clarification_asked: Option<u64>,
    #[serde(default)]
    clarification_consent: Option<bool>,
    #[serde(default)]
    approved_consent: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireHostedRecord {
    version: u64,
    kind: String,
    body: String,
    details: Value,
    provenance: Value,
}

impl HostedPerspective {
    /// Read one hosted inbox item of this kind. A bad item is refused on its
    /// own, naming what is wrong and never what it holds.
    pub fn from_value(value: &Value) -> Result<Self, ThirdPerspectiveError> {
        let invalid = |what: &str| ThirdPerspectiveError::new(ErrorCode::Malformed, what);
        let wire: WireHostedPerspective = serde_json::from_value(value.clone())
            .map_err(|_| invalid("a hosted Third Perspective has an unknown or mistyped field"))?;
        if !crate::scholarly_feedback::is_uuid(&wire.id) {
            return Err(invalid("a hosted Third Perspective needs a UUID `id`"));
        }
        let state = ModerationState::from_id(&wire.status)
            .ok_or_else(|| invalid("a hosted Third Perspective has an unknown state"))?;
        if wire.version == 0 || wire.version > i32::MAX as u64 {
            return Err(invalid(
                "a hosted Third Perspective needs a positive `version`",
            ));
        }
        let reason = wire
            .reason
            .map(|reason| {
                crate::moderation::ReasonCode::from_id(&reason)
                    .ok_or_else(|| invalid("a hosted Third Perspective has an unknown reason"))
            })
            .transpose()?;
        let moderated_at = wire
            .moderated_at
            .map(|time| {
                crate::feedback_provenance::parse_canonical_time(&time)
                    .ok_or_else(|| invalid("`moderatedAt` must be a UTC time"))
            })
            .transpose()?;
        let number = |value: Option<u64>, what: &str| {
            value
                .map(|value| {
                    u32::try_from(value)
                        .ok()
                        .filter(|value| (1..=i32::MAX as u32).contains(value))
                        .ok_or_else(|| invalid(what))
                })
                .transpose()
        };
        let revision = number(wire.item_revision, "`itemRevision` must be positive")?.unwrap_or(1);
        let approved_revision = number(
            wire.approved_revision,
            "`approvedRevision` must be positive",
        )?;
        let clarification_asked = number(
            wire.clarification_asked,
            "`clarificationAsked` must be positive",
        )?;
        let approved_consent = number(wire.approved_consent, "`approvedConsent` must be positive")?;
        if approved_revision.is_some_and(|approved| approved > revision)
            || clarification_asked.is_some_and(|asked| asked > revision)
        {
            return Err(invalid(
                "a hosted Third Perspective names a revision after its current one",
            ));
        }
        let record = wire.feedback;
        if record.version != THIRD_PERSPECTIVE_VERSION {
            return Err(invalid("a hosted Third Perspective needs format version 1"));
        }
        read_kind(&record.kind)?;
        let copy = SubmittedCopy::from_stored(
            &record.body,
            revision,
            &record.details,
            &record.provenance,
        )?;
        let approved = state == ModerationState::Approved;
        if approved_consent.is_some_and(|consent| copy.consent_record(consent).is_none()) {
            return Err(invalid(
                "a hosted Third Perspective's approval names a consent record it does not have",
            ));
        }
        Ok(Self {
            id: wire.id,
            state,
            version: wire.version,
            moderated_at,
            reason,
            clarification_consent: wire.clarification_consent.unwrap_or(false)
                && copy.consent().clarification,
            approved_revision: approved.then(|| approved_revision.unwrap_or(revision)),
            approved_consent: approved_consent.filter(|_| approved),
            clarification_asked,
            copy,
        })
    }

    /// The facts this module decides on, from RD12's facts of the item.
    pub fn facts(&self, item: &ItemFacts<'_>) -> ModerationFacts {
        ModerationFacts::from_item(item, self.approved_consent)
    }
}
