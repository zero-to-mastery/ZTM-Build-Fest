//! Where a reader's feedback came from (ADR 0078).
//!
//! A question, correction or other feedback about a passage is only useful
//! if it says which text the reader saw: the published work, the passage
//! revision on the page, the passage target, when the reader saw it and
//! when the site received it. This module defines that record and its one
//! public projection.
//!
//! Feedback provenance is reader data. It is never a research note, a
//! passage of the notebook or a citation, and nothing here reads or writes
//! the author's research. A reader's name is private to moderation unless
//! the reader explicitly agreed to show it, and nothing else about the
//! reader (no address, contact, device or account) is part of the record.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::date::DateTime;
use crate::passage_target::{
    is_passage_revision, normalize_passage_text, PassageDocument, PassageSelector, PassageTarget,
    Resolution, TargetErrorCode,
};

/// The version of the record format; a reader refuses a higher one.
pub const FEEDBACK_PROVENANCE_VERSION: u64 = 1;
/// The longest name a reader may give, as for comments.
pub const MAX_READER_NAME_CHARS: usize = 80;
/// The longest site-relative path of a published work.
pub const MAX_WORK_PATH_CHARS: usize = 500;
/// The largest serialized record accepted, before it is parsed.
pub const MAX_PROVENANCE_JSON_BYTES: usize = 32 * 1024;

/// How the feedback reached the site.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FeedbackChannel {
    /// Through the optional hosted submission endpoint, which stamps the
    /// time it was received.
    Hosted,
    /// Entered by the author from a message (the e-mail or copy fallback
    /// when there is no hosted endpoint); the author records when it came.
    Manual,
}

/// The reader's choice about their name. The default is anonymous.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReaderAttribution {
    /// The name the reader gave, if any. Moderators see it; the public does
    /// not unless `publish_name` is true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The reader's explicit agreement to show `name` with published
    /// feedback. Never assumed.
    #[serde(default)]
    pub publish_name: bool,
}

impl ReaderAttribution {
    pub fn anonymous() -> Self {
        Self::default()
    }

    /// A name, shown only when `publish_name` is true.
    pub fn named(name: &str, publish_name: bool) -> Self {
        Self {
            name: Some(name.to_string()),
            publish_name,
        }
    }

    /// The name the public may see: only one the reader agreed to show.
    pub fn public_name(&self) -> Option<&str> {
        self.name.as_deref().filter(|_| self.publish_name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProvenanceErrorCode {
    TooLarge,
    Malformed,
    UnsupportedVersion,
    InvalidWork,
    InvalidRevision,
    InvalidTarget,
    InvalidTime,
    SeenAfterReceived,
    InvalidName,
    ConsentWithoutName,
}

/// Why a record was refused. Like target errors, it names the field and
/// never repeats what the reader wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProvenanceError {
    pub code: ProvenanceErrorCode,
    /// For [`ProvenanceErrorCode::InvalidTarget`], the target's own code.
    pub target: Option<TargetErrorCode>,
    pub message: String,
}

impl ProvenanceError {
    fn new(code: ProvenanceErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            target: None,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ProvenanceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProvenanceError {}

/// The provenance of one piece of reader feedback about a passage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedbackProvenance {
    /// The published work: the post's site-relative path, such as
    /// `/posts/tides/`.
    pub work: String,
    /// The passage revision of the page the reader saw.
    pub revision: String,
    /// The passage the feedback is about.
    pub target: PassageTarget,
    /// When the reader saw the page, by the reader's own clock. Optional
    /// and untrusted; never later than `received_at`.
    pub seen_at: Option<DateTime>,
    /// When the site received the feedback, stamped by the receiver, never
    /// taken from the reader.
    pub received_at: DateTime,
    pub channel: FeedbackChannel,
    pub attribution: ReaderAttribution,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireProvenance {
    version: u64,
    work: String,
    revision: String,
    target: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seen_at: Option<String>,
    received_at: String,
    channel: FeedbackChannel,
    #[serde(default)]
    attribution: ReaderAttribution,
}

/// A site-relative path to a published page: `/` first and last, no query,
/// fragment, backslash, control character, empty or dot segment.
pub fn is_work_path(path: &str) -> bool {
    let count = path.chars().count();
    (2..=MAX_WORK_PATH_CHARS).contains(&count)
        && path.starts_with('/')
        && path.ends_with('/')
        && !path.starts_with("//")
        && !path.contains("//")
        && !path
            .chars()
            .any(|c| matches!(c, '\\' | '?' | '#') || c.is_control() || c.is_whitespace())
        && !path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
}

/// A canonical UTC time, `2026-10-26T10:00:00Z`, in years 0001 to 9999: the
/// range a Postgres `timestamptz` and a browser's `Date` both hold, so a time
/// accepted here is never refused by storage after a quota slot is spent.
pub(crate) fn parse_canonical_time(value: &str) -> Option<DateTime> {
    DateTime::parse(value).filter(|time| {
        time.rfc3339() == value
            && value.starts_with(|c: char| c.is_ascii_digit())
            && !value.starts_with("0000")
    })
}

fn parse_time(field: &str, value: &str) -> Result<DateTime, ProvenanceError> {
    parse_canonical_time(value).ok_or_else(|| {
        ProvenanceError::new(
            ProvenanceErrorCode::InvalidTime,
            format!("`{field}` must be a UTC time written like 2026-10-26T10:00:00Z"),
        )
    })
}

impl FeedbackProvenance {
    /// A new record as a receiver makes it. The reader's name is
    /// whitespace-collapsed, and a `seen_at` later than `received_at` (a
    /// reader's clock running ahead) is dropped rather than stored.
    pub fn record(
        work: &str,
        revision: &str,
        target: PassageTarget,
        seen_at: Option<DateTime>,
        received_at: DateTime,
        channel: FeedbackChannel,
        attribution: ReaderAttribution,
    ) -> Result<Self, ProvenanceError> {
        let attribution = ReaderAttribution {
            name: attribution
                .name
                .map(|name| normalize_passage_text(&name))
                .filter(|name| !name.is_empty()),
            publish_name: attribution.publish_name,
        };
        let record = Self {
            work: work.to_string(),
            revision: revision.to_string(),
            target,
            seen_at: seen_at.filter(|seen| *seen <= received_at),
            received_at,
            channel,
            attribution,
        };
        record.validate()?;
        Ok(record)
    }

    /// Check every rule (ADR 0078).
    pub fn validate(&self) -> Result<(), ProvenanceError> {
        if !is_work_path(&self.work) {
            return Err(ProvenanceError::new(
                ProvenanceErrorCode::InvalidWork,
                "`work` must be the site-relative path of a published page, such as /posts/tides/",
            ));
        }
        if !is_passage_revision(&self.revision) {
            return Err(ProvenanceError::new(
                ProvenanceErrorCode::InvalidRevision,
                "`revision` must be a passage revision such as p1: and 32 hexadecimal digits",
            ));
        }
        self.target.validate().map_err(|error| ProvenanceError {
            code: ProvenanceErrorCode::InvalidTarget,
            target: Some(error.code),
            message: format!("`target`: {}", error.message),
        })?;
        if self.seen_at.is_some_and(|seen| seen > self.received_at) {
            return Err(ProvenanceError::new(
                ProvenanceErrorCode::SeenAfterReceived,
                "`seenAt` is later than `receivedAt`",
            ));
        }
        if let Some(name) = &self.attribution.name {
            let count = name.chars().count();
            let forbidden = name
                .chars()
                .any(|c| c.is_control() || crate::research_notes::bidi_override(c));
            if count == 0
                || count > MAX_READER_NAME_CHARS
                || forbidden
                || normalize_passage_text(name) != *name
            {
                return Err(ProvenanceError::new(
                    ProvenanceErrorCode::InvalidName,
                    format!("`attribution.name` must be 1 to {MAX_READER_NAME_CHARS} characters of plain text"),
                ));
            }
        } else if self.attribution.publish_name {
            return Err(ProvenanceError::new(
                ProvenanceErrorCode::ConsentWithoutName,
                "`attribution.publishName` needs a name to publish",
            ));
        }
        Ok(())
    }

    /// Read a record from JSON text, refusing a newer version, an unknown
    /// field or any broken rule. Nothing is repaired.
    pub fn from_json(text: &str) -> Result<Self, ProvenanceError> {
        if text.len() > MAX_PROVENANCE_JSON_BYTES {
            return Err(ProvenanceError::new(
                ProvenanceErrorCode::TooLarge,
                format!(
                    "a feedback provenance record is larger than {MAX_PROVENANCE_JSON_BYTES} bytes"
                ),
            ));
        }
        let malformed = |what: &str| ProvenanceError::new(ProvenanceErrorCode::Malformed, what);
        let value: Value = serde_json::from_str(text)
            .map_err(|_| malformed("a feedback provenance record is not valid JSON"))?;
        match value.get("version").and_then(Value::as_u64) {
            Some(FEEDBACK_PROVENANCE_VERSION) => {}
            Some(version) if version > FEEDBACK_PROVENANCE_VERSION => {
                return Err(ProvenanceError::new(
                    ProvenanceErrorCode::UnsupportedVersion,
                    format!("this feedback provenance record is version {version}, newer than the version {FEEDBACK_PROVENANCE_VERSION} this open.blog reads"),
                ));
            }
            _ => return Err(malformed("a feedback provenance record needs `version` 1")),
        }
        let wire: WireProvenance = serde_json::from_value(value).map_err(|_| {
            malformed("a feedback provenance record has a field this version does not define, or a field of the wrong type")
        })?;
        let target = PassageTarget::from_value(&wire.target).map_err(|error| ProvenanceError {
            code: ProvenanceErrorCode::InvalidTarget,
            target: Some(error.code),
            message: format!("`target`: {}", error.message),
        })?;
        let record = Self {
            work: wire.work,
            revision: wire.revision,
            target,
            seen_at: wire
                .seen_at
                .as_deref()
                .map(|seen| parse_time("seenAt", seen))
                .transpose()?,
            received_at: parse_time("receivedAt", &wire.received_at)?,
            channel: wire.channel,
            attribution: wire.attribution,
        };
        record.validate()?;
        Ok(record)
    }

    /// Canonical JSON, in a fixed field order.
    pub fn to_json(&self) -> String {
        serde_json::to_string(&WireProvenance {
            version: FEEDBACK_PROVENANCE_VERSION,
            work: self.work.clone(),
            revision: self.revision.clone(),
            target: self.target.to_value(),
            seen_at: self.seen_at.map(DateTime::rfc3339),
            received_at: self.received_at.rfc3339(),
            channel: self.channel,
            attribution: self.attribution.clone(),
        })
        .expect("a feedback provenance record always serializes")
    }

    /// Resolve the target against the work as it is published now, from
    /// the revision the reader saw.
    pub fn resolve(&self, document: &PassageDocument) -> Resolution {
        document.resolve(&self.target, Some(&self.revision))
    }

    /// The text a quotation target quotes; a work or section target quotes
    /// nothing.
    fn verified_quote(&self) -> Option<String> {
        match &self.target.selector {
            PassageSelector::Quote(quote) => Some(quote.exact.clone()),
            _ => None,
        }
    }

    /// The only form of this record that may appear on a public page, feed
    /// or export (ADR 0078): the work, the revision the reader saw and the
    /// day it was received; the passage only while the work still publishes
    /// that text; and the reader's name only with their agreement. The
    /// reader's clock, the channel and an unpublished name never appear.
    pub fn public(&self, document: &PassageDocument) -> PublicProvenance {
        let resolution = self.resolve(document);
        // The quotation is the `exact` text resolution verified against the
        // section at that location. It is never read again by anchor, which
        // can name more than one section.
        let (section, quote) = match resolution.location() {
            Some(location) => (location.section.clone(), self.verified_quote()),
            None => (
                self.target.section.clone().filter(
                    |_| matches!(resolution, Resolution::Stale(stale) if stale.section_present),
                ),
                None,
            ),
        };
        PublicProvenance {
            work: self.work.clone(),
            revision: self.revision.clone(),
            received: self.received_at.ymd(),
            stale: resolution.is_stale(),
            section,
            quote,
            name: self.attribution.public_name().map(str::to_string),
        }
    }
}

/// The public projection of feedback provenance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProvenance {
    pub work: String,
    /// The passage revision the reader saw.
    pub revision: String,
    /// The day the feedback was received, `YYYY-MM-DD`.
    pub received: String,
    /// Whether the passage no longer resolves in the published work.
    pub stale: bool,
    /// The section the passage is in now; for a stale passage, its old
    /// section only while that section still exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    /// The quoted text, only while the work still publishes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    /// The reader's name, only with their explicit agreement.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl PublicProvenance {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("public provenance always serializes")
    }
}
