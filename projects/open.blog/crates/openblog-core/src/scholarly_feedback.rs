//! Typed scholarly feedback: what a reader sends about a passage, and the
//! record a receiver keeps (ADRs 0079 and 0080).
//!
//! A reader asks a question, suggests a source, suggests a correction or
//! offers another interpretation of a passage of a published post. Each is a
//! *feedback kind* with its own small set of details, and every one carries
//! the same [`FeedbackProvenance`] (ADR 0078): the work, the passage revision
//! the reader saw, the passage target and the reader's attribution choice.
//!
//! The hosted function (`netlify/functions/engagement.mjs`) reads the same
//! submissions with `web/components/passage-feedback.js`; both read
//! `tests/fixtures/scholarly-feedback.json` and must agree on every code and
//! record. Without the hosted service, a reader's copied submission entered by
//! the author ([`FeedbackChannel::Manual`]) produces the same record.
//!
//! A kind is the reader's stated intent, never a verdict: a suggested
//! correction is not a correction until an author decides (#83, RD6), and
//! nothing here edits a post, a citation or the author's research.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::date::DateTime;
use crate::feedback_provenance::{
    is_work_path, FeedbackChannel, FeedbackProvenance, ProvenanceError, ReaderAttribution,
    MAX_READER_NAME_CHARS,
};
use crate::passage_target::{
    is_passage_revision, normalize_passage_text, PassageSelector, PassageTarget, TargetErrorCode,
};

/// The version of the submission and record formats; a reader refuses a
/// higher one.
pub const FEEDBACK_SUBMISSION_VERSION: u64 = 1;
/// The longest feedback text, as for comments.
pub const MAX_FEEDBACK_BODY_CHARS: usize = 4_000;
/// The longest suggested replacement wording of a suggested correction.
pub const MAX_SUGGESTED_TEXT_CHARS: usize = 2_000;
/// The longest source link, in bytes once normalized.
pub const MAX_SOURCE_URL_BYTES: usize = 2_048;
/// The largest serialized submission accepted, before it is parsed.
pub const MAX_SUBMISSION_JSON_BYTES: usize = 32 * 1024;

/// What a reader says they are offering. The id is stored; the set is owned
/// by code, so adding a kind (a Third Perspective, RD10; a future question,
/// RD13) needs no database change. An id this version does not know is
/// refused as [`FeedbackErrorCode::UnknownKind`], never guessed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FeedbackKind {
    /// A question about the passage.
    Question,
    /// A source the reader thinks bears on the passage. Needs a link.
    SourceSuggestion,
    /// Wording the reader thinks is wrong, optionally with replacement
    /// wording and evidence. Never a correction before an author decides.
    CorrectionSuggestion,
    /// Another reading of the passage, offered beside the author's.
    AlternativeInterpretation,
}

/// Whether a kind uses a detail field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetailRule {
    NotUsed,
    Optional,
    Required,
}

impl FeedbackKind {
    pub const ALL: [FeedbackKind; 4] = [
        FeedbackKind::Question,
        FeedbackKind::SourceSuggestion,
        FeedbackKind::CorrectionSuggestion,
        FeedbackKind::AlternativeInterpretation,
    ];

    /// The stored id: lowercase letters, digits and hyphens.
    pub fn id(self) -> &'static str {
        match self {
            FeedbackKind::Question => "question",
            FeedbackKind::SourceSuggestion => "source-suggestion",
            FeedbackKind::CorrectionSuggestion => "correction-suggestion",
            FeedbackKind::AlternativeInterpretation => "alternative-interpretation",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.id() == id)
    }

    /// The participation kind this is (ADR 0101): the same id, in the one
    /// registry whose site and post modes govern it.
    pub fn participation_kind(self) -> crate::participation::ParticipationKind {
        use crate::participation::ParticipationKind;
        match self {
            FeedbackKind::Question => ParticipationKind::Question,
            FeedbackKind::SourceSuggestion => ParticipationKind::SourceSuggestion,
            FeedbackKind::CorrectionSuggestion => ParticipationKind::CorrectionSuggestion,
            FeedbackKind::AlternativeInterpretation => ParticipationKind::AlternativeInterpretation,
        }
    }

    /// A label for moderators and forms. It names the reader's intent.
    pub fn label(self) -> &'static str {
        match self {
            FeedbackKind::Question => "Question",
            FeedbackKind::SourceSuggestion => "Suggested source",
            FeedbackKind::CorrectionSuggestion => "Suggested correction",
            FeedbackKind::AlternativeInterpretation => "Another interpretation",
        }
    }

    /// Whether this kind may point at a target of this shape. A suggested
    /// correction is about specific text, so it needs a section or a
    /// quotation; the others may be about the whole post.
    pub fn accepts(self, selector: &PassageSelector) -> bool {
        !matches!(
            (self, selector),
            (FeedbackKind::CorrectionSuggestion, PassageSelector::Work)
        )
    }

    /// How this kind uses `details.sourceUrl`.
    pub fn source_url(self) -> DetailRule {
        match self {
            FeedbackKind::SourceSuggestion => DetailRule::Required,
            _ => DetailRule::Optional,
        }
    }

    /// How this kind uses `details.suggestedText`.
    pub fn suggested_text(self) -> DetailRule {
        match self {
            FeedbackKind::CorrectionSuggestion => DetailRule::Optional,
            _ => DetailRule::NotUsed,
        }
    }
}

impl Serialize for FeedbackKind {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.id())
    }
}

/// The kind-specific details of a submission. Both are optional in the
/// format; [`FeedbackKind`] says which a kind uses.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FeedbackDetails {
    /// An absolute HTTP(S) link without credentials, stored normalized.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// Replacement wording a reader suggests, as plain text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_text: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FeedbackErrorCode {
    TooLarge,
    Malformed,
    UnsupportedVersion,
    UnknownKind,
    InvalidWork,
    InvalidRevision,
    InvalidTarget,
    TargetNotAllowed,
    InvalidBody,
    DetailNotAllowed,
    MissingSource,
    InvalidSourceUrl,
    InvalidSuggestedText,
    InvalidTime,
    InvalidName,
    ConsentWithoutName,
    InvalidRecord,
}

/// Why a submission or record was refused. The message names the field and
/// never repeats what the reader wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedbackError {
    pub code: FeedbackErrorCode,
    /// For [`FeedbackErrorCode::InvalidTarget`], the target's own code.
    pub target: Option<TargetErrorCode>,
    pub message: String,
}

impl FeedbackError {
    fn new(code: FeedbackErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            target: None,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for FeedbackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FeedbackError {}

impl From<ProvenanceError> for FeedbackError {
    fn from(error: ProvenanceError) -> Self {
        Self {
            code: FeedbackErrorCode::InvalidRecord,
            target: error.target,
            message: format!("`provenance`: {}", error.message),
        }
    }
}

/// What a reader sends: the feedback and the provenance only the reader can
/// give. The receiver adds when it arrived and by which channel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedbackSubmission {
    pub kind: FeedbackKind,
    pub work: String,
    /// The passage revision of the page the reader saw.
    pub revision: String,
    pub target: PassageTarget,
    /// The feedback text, trimmed.
    pub body: String,
    pub details: FeedbackDetails,
    /// When the reader saw the page, by the reader's clock.
    pub seen_at: Option<DateTime>,
    pub attribution: ReaderAttribution,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireSubmission {
    #[allow(dead_code)]
    version: u64,
    kind: String,
    work: String,
    revision: String,
    target: Value,
    body: String,
    #[serde(default)]
    details: Option<FeedbackDetails>,
    #[serde(default)]
    seen_at: Option<String>,
    #[serde(default)]
    attribution: Option<ReaderAttribution>,
}

/// A character never accepted in reader text: a control character other
/// than tab and line breaks, or a bidirectional embedding, override or
/// isolate, which can make text display differently from what it says.
fn forbidden_in_text(character: char) -> bool {
    (character.is_control() && !matches!(character, '\t' | '\n' | '\r'))
        || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// Trimmed reader text of 1 to `max` characters, or `None`.
pub(crate) fn reader_text(value: &str, max: usize) -> Option<String> {
    let text = value.trim();
    let count = text.chars().count();
    ((1..=max).contains(&count) && !text.chars().any(forbidden_in_text)).then(|| text.to_string())
}

/// A source link: an absolute HTTP(S) address without credentials, written
/// without surrounding whitespace, control, whitespace or text-direction
/// characters, normalized by the WHATWG URL rules, and ASCII once
/// normalized (a non-ASCII host is written in Punycode).
pub fn normalize_feedback_source_url(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > MAX_SOURCE_URL_BYTES
        || value.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none_or(str::is_empty)
    {
        return None;
    }
    let normalized = String::from(url);
    (normalized.is_ascii() && normalized.len() <= MAX_SOURCE_URL_BYTES).then_some(normalized)
}

/// A canonical UTC time, `2026-10-26T10:00:00Z`.
fn parse_time(value: &str) -> Result<DateTime, FeedbackError> {
    crate::feedback_provenance::parse_canonical_time(value).ok_or_else(|| {
        FeedbackError::new(
            FeedbackErrorCode::InvalidTime,
            "`seenAt` must be a UTC time written like 2026-10-26T10:00:00Z",
        )
    })
}

fn malformed(message: &str) -> FeedbackError {
    FeedbackError::new(FeedbackErrorCode::Malformed, message)
}

fn read_version(value: &Value, what: &str) -> Result<(), FeedbackError> {
    match value.get("version").and_then(Value::as_u64) {
        Some(FEEDBACK_SUBMISSION_VERSION) => Ok(()),
        Some(version) if version > FEEDBACK_SUBMISSION_VERSION => Err(FeedbackError::new(
            FeedbackErrorCode::UnsupportedVersion,
            format!("this {what} is version {version}, newer than the version {FEEDBACK_SUBMISSION_VERSION} this open.blog reads"),
        )),
        _ => Err(malformed(&format!("a {what} needs `version` 1"))),
    }
}

impl FeedbackSubmission {
    /// Read a submission from JSON text, refusing a newer version, an
    /// unknown field or any broken rule. Text is trimmed and the reader's
    /// name collapsed to single spaces; nothing else is repaired.
    pub fn from_json(text: &str) -> Result<Self, FeedbackError> {
        if text.len() > MAX_SUBMISSION_JSON_BYTES {
            return Err(FeedbackError::new(
                FeedbackErrorCode::TooLarge,
                format!("a feedback submission is larger than {MAX_SUBMISSION_JSON_BYTES} bytes"),
            ));
        }
        let value: Value = serde_json::from_str(text)
            .map_err(|_| malformed("a feedback submission is not valid JSON"))?;
        Self::from_value(&value)
    }

    /// Read a submission from its JSON value. The checks run in a fixed
    /// order, the same as in `passage-feedback.js`, so both report the same
    /// first problem.
    pub fn from_value(value: &Value) -> Result<Self, FeedbackError> {
        read_version(value, "feedback submission")?;
        let wrong_shape = || {
            malformed("a feedback submission has a field this version does not define, or a field of the wrong type")
        };
        // serde would read an array into a struct by position; only an
        // object (or null) is a valid `details` or `attribution`.
        if ["details", "attribution"]
            .iter()
            .any(|key| value.get(key).is_some_and(Value::is_array))
        {
            return Err(wrong_shape());
        }
        let wire: WireSubmission =
            serde_json::from_value(value.clone()).map_err(|_| wrong_shape())?;
        let kind = FeedbackKind::from_id(&wire.kind).ok_or_else(|| {
            FeedbackError::new(
                FeedbackErrorCode::UnknownKind,
                "`kind` is not a kind of feedback this site accepts",
            )
        })?;
        if !is_work_path(&wire.work) {
            return Err(FeedbackError::new(
                FeedbackErrorCode::InvalidWork,
                "`work` must be the site-relative path of a published page, such as /posts/tides/",
            ));
        }
        if !is_passage_revision(&wire.revision) {
            return Err(FeedbackError::new(
                FeedbackErrorCode::InvalidRevision,
                "`revision` must be a passage revision such as p1: and 32 hexadecimal digits",
            ));
        }
        let target = PassageTarget::from_value(&wire.target).map_err(|error| FeedbackError {
            code: FeedbackErrorCode::InvalidTarget,
            target: Some(error.code),
            message: format!("`target`: {}", error.message),
        })?;
        if !kind.accepts(&target.selector) {
            return Err(FeedbackError::new(
                FeedbackErrorCode::TargetNotAllowed,
                format!("a {} must point at a section or a quotation", kind.id()),
            ));
        }
        let body = reader_text(&wire.body, MAX_FEEDBACK_BODY_CHARS).ok_or_else(|| {
            FeedbackError::new(
                FeedbackErrorCode::InvalidBody,
                format!("`body` must be 1 to {MAX_FEEDBACK_BODY_CHARS} characters of plain text"),
            )
        })?;
        let details = read_details(kind, wire.details.unwrap_or_default())?;
        let seen_at = wire.seen_at.as_deref().map(parse_time).transpose()?;
        let attribution = read_attribution(wire.attribution.unwrap_or_default())?;
        Ok(Self {
            kind,
            work: wire.work,
            revision: wire.revision,
            target,
            body,
            details,
            seen_at,
            attribution,
        })
    }

    /// Canonical JSON of the submission, as a reader's browser sends it and
    /// as the copy fallback shows it.
    pub fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("version".into(), FEEDBACK_SUBMISSION_VERSION.into());
        object.insert("kind".into(), self.kind.id().into());
        object.insert("work".into(), self.work.clone().into());
        object.insert("revision".into(), self.revision.clone().into());
        object.insert("target".into(), self.target.to_value());
        object.insert("body".into(), self.body.clone().into());
        if self.details != FeedbackDetails::default() {
            object.insert(
                "details".into(),
                serde_json::to_value(&self.details).expect("details serialize"),
            );
        }
        if let Some(seen) = self.seen_at {
            object.insert("seenAt".into(), seen.rfc3339().into());
        }
        if self.attribution != ReaderAttribution::default() {
            object.insert(
                "attribution".into(),
                serde_json::to_value(&self.attribution).expect("attribution serializes"),
            );
        }
        Value::Object(object)
    }

    pub fn to_json(&self) -> String {
        self.to_value().to_string()
    }

    /// The record a receiver keeps: the hosted function stamps
    /// `received_at` itself, an author entering a copied submission records
    /// when it came. A `seen_at` later than `received_at` is dropped.
    pub fn receive(
        self,
        received_at: DateTime,
        channel: FeedbackChannel,
    ) -> Result<ScholarlyFeedback, FeedbackError> {
        let provenance = FeedbackProvenance::record(
            &self.work,
            &self.revision,
            self.target,
            self.seen_at,
            received_at,
            channel,
            self.attribution,
        )?;
        Ok(ScholarlyFeedback {
            kind: self.kind,
            body: self.body,
            details: self.details,
            provenance,
        })
    }
}

fn read_details(
    kind: FeedbackKind,
    details: FeedbackDetails,
) -> Result<FeedbackDetails, FeedbackError> {
    let not_allowed = |field: &str| {
        FeedbackError::new(
            FeedbackErrorCode::DetailNotAllowed,
            format!("a {} has no `details.{field}`", kind.id()),
        )
    };
    if details.source_url.is_some() && kind.source_url() == DetailRule::NotUsed {
        return Err(not_allowed("sourceUrl"));
    }
    if details.suggested_text.is_some() && kind.suggested_text() == DetailRule::NotUsed {
        return Err(not_allowed("suggestedText"));
    }
    if details.source_url.is_none() && kind.source_url() == DetailRule::Required {
        return Err(FeedbackError::new(
            FeedbackErrorCode::MissingSource,
            format!("a {} needs `details.sourceUrl`", kind.id()),
        ));
    }
    let source_url = details
        .source_url
        .map(|url| {
            normalize_feedback_source_url(&url).ok_or_else(|| {
                FeedbackError::new(
                    FeedbackErrorCode::InvalidSourceUrl,
                    "`details.sourceUrl` must be an absolute HTTP(S) link without credentials",
                )
            })
        })
        .transpose()?;
    let suggested_text = details
        .suggested_text
        .map(|text| {
            reader_text(&text, MAX_SUGGESTED_TEXT_CHARS).ok_or_else(|| {
                FeedbackError::new(
                    FeedbackErrorCode::InvalidSuggestedText,
                    format!("`details.suggestedText` must be 1 to {MAX_SUGGESTED_TEXT_CHARS} characters of plain text"),
                )
            })
        })
        .transpose()?;
    Ok(FeedbackDetails {
        source_url,
        suggested_text,
    })
}

fn read_attribution(attribution: ReaderAttribution) -> Result<ReaderAttribution, FeedbackError> {
    let name = attribution
        .name
        .map(|name| normalize_passage_text(&name))
        .filter(|name| !name.is_empty());
    if let Some(name) = &name {
        if name.chars().count() > MAX_READER_NAME_CHARS
            || name.chars().any(|c| {
                c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            })
        {
            return Err(FeedbackError::new(
                FeedbackErrorCode::InvalidName,
                format!("`attribution.name` must be 1 to {MAX_READER_NAME_CHARS} characters of plain text"),
            ));
        }
    } else if attribution.publish_name {
        return Err(FeedbackError::new(
            FeedbackErrorCode::ConsentWithoutName,
            "`attribution.publishName` needs a name to publish",
        ));
    }
    Ok(ReaderAttribution {
        name,
        publish_name: attribution.publish_name,
    })
}

/// One piece of received feedback: its kind, text and details, and where it
/// came from. Reader data, never a research note; accepting it still needs a
/// separate author edit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScholarlyFeedback {
    pub kind: FeedbackKind,
    pub body: String,
    pub details: FeedbackDetails,
    pub provenance: FeedbackProvenance,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireRecord {
    #[allow(dead_code)]
    version: u64,
    kind: String,
    body: String,
    details: FeedbackDetails,
    provenance: Value,
}

impl ScholarlyFeedback {
    /// The record as JSON: `{version, kind, body, details, provenance}`,
    /// where `provenance` is the ADR 0078 record.
    pub fn to_value(&self) -> Value {
        let provenance: Value =
            serde_json::from_str(&self.provenance.to_json()).expect("provenance is JSON");
        let mut object = Map::new();
        object.insert("version".into(), FEEDBACK_SUBMISSION_VERSION.into());
        object.insert("kind".into(), self.kind.id().into());
        object.insert("body".into(), self.body.clone().into());
        object.insert(
            "details".into(),
            serde_json::to_value(&self.details).expect("details serialize"),
        );
        object.insert("provenance".into(), provenance);
        Value::Object(object)
    }

    pub fn to_json(&self) -> String {
        self.to_value().to_string()
    }

    /// Read a record, such as one the hosted moderation API returns. Every
    /// submission rule is checked again: stored data is not trusted more
    /// than a reader's request.
    pub fn from_value(value: &Value) -> Result<Self, FeedbackError> {
        read_version(value, "feedback record")?;
        let wire: WireRecord = serde_json::from_value(value.clone()).map_err(|_| {
            malformed("a feedback record has a field this version does not define, or a field of the wrong type")
        })?;
        let provenance = FeedbackProvenance::from_json(&wire.provenance.to_string())?;
        let mut submission = Value::Object(Map::new());
        submission["version"] = FEEDBACK_SUBMISSION_VERSION.into();
        submission["kind"] = wire.kind.into();
        submission["work"] = provenance.work.clone().into();
        submission["revision"] = provenance.revision.clone().into();
        submission["target"] = provenance.target.to_value();
        submission["body"] = wire.body.clone().into();
        submission["details"] = serde_json::to_value(&wire.details).expect("details serialize");
        let checked = FeedbackSubmission::from_value(&submission)?;
        if checked.body != wire.body || checked.details != wire.details {
            return Err(FeedbackError::new(
                FeedbackErrorCode::InvalidRecord,
                "a feedback record holds text or a link that is not in its stored form",
            ));
        }
        Ok(Self {
            kind: checked.kind,
            body: checked.body,
            details: checked.details,
            provenance,
        })
    }

    pub fn from_json(text: &str) -> Result<Self, FeedbackError> {
        let value: Value = serde_json::from_str(text)
            .map_err(|_| malformed("a feedback record is not valid JSON"))?;
        Self::from_value(&value)
    }
}

/// Where a hosted item is in moderation: the participation policy's states
/// (RD12, #211), read by [`crate::feedback_moderation`] (ADR 0083). Public
/// submissions always start [`FeedbackStatus::Pending`]; an id no version
/// defines is refused rather than misread.
pub type FeedbackStatus = crate::moderation::ModerationState;

/// One item of the hosted moderation list (`GET /admin/feedback`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedFeedback {
    /// The hosted row id, a UUID.
    pub id: String,
    pub status: FeedbackStatus,
    /// The row's moderation version: every change names the version it
    /// expects and raises it, so concurrent moderation is refused (ADR 0083).
    pub version: u64,
    pub moderated_at: Option<DateTime>,
    /// Why the item was last rejected or removed, if it was.
    pub reason: Option<crate::moderation::ReasonCode>,
    pub feedback: ScholarlyFeedback,
    /// The reader's evidence block of a version 2 record (ADR 0116): their
    /// statement, never checked for truth and never an author's evidence
    /// link.
    pub evidence: Option<crate::evidence_submission::EvidenceOffer>,
    /// The text's revision (ADR 0102), raised only when a clarification
    /// replaces it; 1 for an item stored before the inbox (ADR 0106).
    pub revision: u32,
    /// The revision an approval covers. An item approved before the inbox
    /// stored none, and was approved at its only revision.
    pub approved_revision: Option<u32>,
    /// The revision a moderator last asked the submitter to clarify.
    pub clarification_asked: Option<u32>,
    /// The submitter agreed to be asked to clarify.
    pub clarification_consent: bool,
    /// The author's correction decisions on the item (ADR 0117), oldest
    /// first, when the hosted service stores them: `None` when it does not
    /// (the column is not there), an empty log when nobody has decided yet.
    pub decisions: Option<crate::correction_decision::DecisionLog>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireHosted {
    id: String,
    status: String,
    version: u64,
    #[serde(default)]
    moderated_at: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    feedback: Value,
    #[serde(default)]
    item_revision: Option<u64>,
    #[serde(default)]
    approved_revision: Option<u64>,
    #[serde(default)]
    clarification_asked: Option<u64>,
    #[serde(default)]
    clarification_consent: Option<bool>,
    #[serde(default)]
    decisions: Option<Value>,
}

pub fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(index, c)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

impl HostedFeedback {
    /// Whether `value` is a hosted item id: a UUID.
    pub fn is_id(value: &str) -> bool {
        is_uuid(value)
    }

    /// Read one moderation item. A bad item is refused on its own, so one
    /// broken row never hides the rest of the queue.
    pub fn from_value(value: &Value) -> Result<Self, FeedbackError> {
        let invalid = |what: &str| FeedbackError::new(FeedbackErrorCode::InvalidRecord, what);
        let wire: WireHosted = serde_json::from_value(value.clone())
            .map_err(|_| invalid("a hosted feedback item has an unknown or mistyped field"))?;
        if !is_uuid(&wire.id) {
            return Err(invalid("a hosted feedback item needs a UUID `id`"));
        }
        let status = FeedbackStatus::from_id(&wire.status).ok_or_else(|| {
            invalid("a hosted feedback item has a status this version does not know")
        })?;
        if wire.version == 0 || wire.version > i32::MAX as u64 {
            return Err(invalid("a hosted feedback item needs a positive `version`"));
        }
        let reason = wire
            .reason
            .map(|reason| {
                crate::moderation::ReasonCode::from_id(&reason).ok_or_else(|| {
                    invalid("a hosted feedback item has a reason this version does not know")
                })
            })
            .transpose()?;
        let moderated_at = wire
            .moderated_at
            .map(|time| {
                crate::feedback_provenance::parse_canonical_time(&time)
                    .ok_or_else(|| invalid("`moderatedAt` must be a UTC time"))
            })
            .transpose()?;
        let revision_of = |value: Option<u64>, what: &str| {
            value
                .map(|value| {
                    u32::try_from(value)
                        .ok()
                        .filter(|value| (1..=i32::MAX as u32).contains(value))
                        .ok_or_else(|| invalid(what))
                })
                .transpose()
        };
        let revision = revision_of(
            wire.item_revision,
            "a hosted feedback item needs a positive `itemRevision`",
        )?
        .unwrap_or(1);
        let approved_revision = revision_of(
            wire.approved_revision,
            "`approvedRevision` must be a positive revision",
        )?;
        let clarification_asked = revision_of(
            wire.clarification_asked,
            "`clarificationAsked` must be a positive revision",
        )?;
        if approved_revision.is_some_and(|approved| approved > revision)
            || clarification_asked.is_some_and(|asked| asked > revision)
        {
            return Err(invalid(
                "a hosted feedback item names a revision after its current one",
            ));
        }
        // A version 2 record is an evidence submission (ADR 0116); every
        // other version is read by B5's reader, which refuses what it does
        // not know.
        // A version 2 record without its block is one the hosted function read with
        // evidence switched off: it is the version 1 record it also is, so it can still
        // be moderated and erased.
        let mut wire_feedback = wire.feedback;
        if wire_feedback.get("version").and_then(Value::as_u64)
            == Some(crate::evidence_submission::EVIDENCE_SUBMISSION_VERSION)
            && wire_feedback.get("evidence").is_none()
        {
            wire_feedback["version"] = 1.into();
        }
        let (feedback, evidence) = if wire_feedback.get("version").and_then(Value::as_u64)
            == Some(crate::evidence_submission::EVIDENCE_SUBMISSION_VERSION)
        {
            let record = crate::evidence_submission::EvidenceRecord::from_value(&wire_feedback)
                .map_err(|error| match error.feedback {
                    Some(code) => FeedbackError::new(code, error.message),
                    None => invalid("a hosted evidence submission is not valid"),
                })?;
            (record.feedback, record.evidence)
        } else {
            (ScholarlyFeedback::from_value(&wire_feedback)?, None)
        };
        let decisions = wire
            .decisions
            .map(|value| {
                crate::correction_decision::DecisionLog::from_value(&value)
                    .ok()
                    .filter(|log| log.item() == wire.id.to_ascii_lowercase())
                    .ok_or_else(|| {
                        invalid("a hosted feedback item's `decisions` are not its decision log")
                    })
            })
            .transpose()?;
        Ok(Self {
            id: wire.id,
            status,
            version: wire.version,
            moderated_at,
            reason,
            feedback,
            evidence,
            revision,
            // Only an approved item has an approval; one approved before the
            // inbox stored none and was approved at its only revision.
            approved_revision: (status == FeedbackStatus::Approved)
                .then(|| approved_revision.unwrap_or(revision)),
            clarification_asked,
            clarification_consent: wire.clarification_consent.unwrap_or(false),
            decisions,
        })
    }
}
