//! Future-question and source suggestions: what a reader sends the editors
//! for possible future work (RD13, ADRs 0152 to 0161).
//!
//! A suggestion is one participation kind (`future-suggestion`) in the one
//! participation and moderation policy (#211), not another system. It is a
//! question, a text, a video, an audio recording or another source, with an
//! optional safe link, optional bibliographic hints, an optional series or
//! article it is about, the reader's chosen display name and an optional,
//! private way to reach them.
//!
//! The rules this module keeps:
//!
//! - A suggestion is untrusted reader text, always. Nothing here reads the
//!   Source Library, and nothing here writes to it: [`library_candidate`]
//!   hands an author a plain list of unverified hints, and only that author's
//!   own later action can make a library record of them.
//! - Nothing about a suggestion is ever public. The kind is not publishable,
//!   so approval admits a suggestion to the editors' queue and publishes
//!   nothing. Crediting the reader is a separate author action, and only
//!   [`Suggestion::credit`] (the name the reader agreed to show) may be used.
//! - Acceptance is editorial interest ([`ACCEPTANCE_NOTICE`]). It is neither
//!   agreement with a suggestion, a check of it, nor permission to use it.
//! - Contact details are optional, private to the site Admin and the
//!   submitter, never in a log, a debug print, an audit event, a conversion
//!   or a library candidate, and are kept only with the reader's agreement to
//!   be contacted. Nothing here sends a message to anyone.
//! - Nothing counts, ranks or votes on suggestions. [`duplicate_groups`]
//!   lets an editor see that the same source came in more than once and
//!   reports no number.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::citations::{public_identifier, public_url_problem};
use crate::date::DateTime;
use crate::feedback_provenance::{is_work_path, parse_canonical_time, FeedbackChannel};
pub use crate::feedback_provenance::{ReaderAttribution, MAX_READER_NAME_CHARS};
use crate::knowledge_atlas::valid_id;
use crate::moderation::{
    may_decide, may_view, Actor, ItemFacts, ModerationPolicy, ModerationState, RetentionStep, View,
};
use crate::participation::{ParticipationKind, ParticipationMode};
use crate::research::normalize_doi_url;
use crate::scholarly_feedback::{normalize_feedback_source_url, reader_text};
use crate::slug::slugify;
use crate::source_library::check_identifier;

/// The participation kind, RD12's `future-suggestion`.
pub const KIND: ParticipationKind = ParticipationKind::FutureSuggestion;
/// The version of the submission and record formats; a reader refuses a
/// higher one.
pub const FUTURE_SUGGESTION_VERSION: u64 = 1;
/// The longest suggestion text, the question or the reader's note.
pub const MAX_TEXT_CHARS: usize = 2_000;
/// The longest title or publisher hint.
pub const MAX_HINT_CHARS: usize = 300;
/// The longest creator name hint.
pub const MAX_CREATOR_CHARS: usize = 200;
/// The most creators a reader may name.
pub const MAX_CREATORS: usize = 8;
/// The most identifiers a reader may give.
pub const MAX_IDENTIFIERS: usize = 4;
/// The longest identifier value.
pub const MAX_IDENTIFIER_CHARS: usize = 128;
/// The longest identifier that is a link, the longest a link may be.
pub const MAX_IDENTIFIER_URL_CHARS: usize = 2_048;
/// The longest year hint, written as the reader likes ("c. 1850", "44 BCE").
pub const MAX_YEAR_CHARS: usize = 32;
/// The longest contact address (RFC 5321's path limit).
pub const MAX_CONTACT_BYTES: usize = 254;
/// The longest series slug or conversion id, in characters.
pub const MAX_ID_CHARS: usize = 64;
/// The largest serialized submission accepted, before parsing.
pub const MAX_SUBMISSION_BYTES: usize = 12 * 1024;
/// The largest whole stored record read back, before parsing. The record is
/// the text (at most 2,000 characters of four bytes, 8,000 bytes, the row's
/// `body`), the row's `details` (held below 16 KiB by its own check), the
/// reader's name, the receipt and the revision (about 1.5 KiB between them).
/// The columns bound the parts, so this bound is their sum with room to spare:
/// no accepted suggestion, with eight links and any number of clarifications,
/// can be refused when it is read back (ADR 0165).
pub const MAX_JSON_BYTES: usize = 32 * 1024;
/// The most a suggestion's stored `details` may measure, as Postgres measures
/// them (`octet_length(details::text)`: jsonb text puts one space after every
/// `:` and `,`). It is below the 16 KiB of the column's check by the room
/// [`MAX_CONVERSIONS`] links at their largest need (about 5 KiB), so neither a
/// link that percent-encoding made longer nor an author's links can ever make
/// a write fail (ADR 0162).
pub const MAX_STORED_DETAILS_BYTES: usize = 11 * 1024;
/// The most conversion references one suggestion keeps.
pub const MAX_CONVERSIONS: usize = 8;
/// The longest admin account name a conversion records.
pub const MAX_ACTOR_CHARS: usize = 64;

/// What acceptance means, in the words an editor's screen and a reader's
/// receipt use.
pub const ACCEPTANCE_NOTICE: &str = "Accepted means the editors are interested in exploring this. \
It does not mean they agree with it, have checked it, or have permission to use it.";

// ---------------------------------------------------------------------------
// Errors

/// Why a submission, record or conversion was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    TooLarge,
    Malformed,
    UnsupportedVersion,
    WrongKind,
    UnknownType,
    InvalidText,
    /// A question carries words only, no link or bibliographic hints.
    NotForQuestion,
    InvalidUrl,
    InvalidHint,
    InvalidAbout,
    InvalidName,
    ConsentWithoutName,
    InvalidContact,
    /// Contact details without the reader's agreement to be contacted.
    ContactWithoutConsent,
    InvalidWork,
    InvalidTime,
    InvalidDetails,
}

/// A refused submission or record. The message names the field and never
/// repeats what the reader wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SuggestionError {
    pub code: ErrorCode,
    pub message: String,
}

impl SuggestionError {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SuggestionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SuggestionError {}

fn malformed(message: &str) -> SuggestionError {
    SuggestionError::new(ErrorCode::Malformed, message)
}

// ---------------------------------------------------------------------------
// Parts

/// What is being suggested. The set is closed: a type this version does not
/// know is refused, never guessed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SuggestionType {
    /// A question for a future piece: words only.
    Question,
    /// A text: an article, a book, a paper, a letter.
    Text,
    Video,
    Audio,
    /// Any other source: an archive, a dataset, an object, a person's account.
    Source,
}

impl SuggestionType {
    pub const ALL: [SuggestionType; 5] = [
        SuggestionType::Question,
        SuggestionType::Text,
        SuggestionType::Video,
        SuggestionType::Audio,
        SuggestionType::Source,
    ];

    pub fn id(self) -> &'static str {
        match self {
            SuggestionType::Question => "question",
            SuggestionType::Text => "text",
            SuggestionType::Video => "video",
            SuggestionType::Audio => "audio",
            SuggestionType::Source => "source",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.id() == id)
    }

    /// A label that names an intent, never a verdict.
    pub fn label(self) -> &'static str {
        match self {
            SuggestionType::Question => "Question for a future piece",
            SuggestionType::Text => "Text to read",
            SuggestionType::Video => "Video to watch",
            SuggestionType::Audio => "Audio to hear",
            SuggestionType::Source => "Other source",
        }
    }
}

/// What a suggestion is about besides the page it was sent from: a series or
/// one published article, named by the site's own slug or path. Optional; a
/// suggestion about neither is about the site.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum About {
    Series(String),
    Article(String),
}

impl About {
    fn to_value(&self) -> Value {
        match self {
            About::Series(slug) => json!({ "series": slug }),
            About::Article(path) => json!({ "article": path }),
        }
    }

    fn from_value(value: &Value) -> Result<Self, SuggestionError> {
        let invalid = |message: &str| SuggestionError::new(ErrorCode::InvalidAbout, message);
        let object = value
            .as_object()
            .filter(|object| object.len() == 1)
            .ok_or_else(|| invalid("`about` names exactly one of `series` or `article`"))?;
        match (object.get("series"), object.get("article")) {
            (Some(Value::String(slug)), None) if valid_slug(slug) => {
                Ok(About::Series(slug.clone()))
            }
            (Some(_), None) => Err(invalid(
                "`about.series` must be a slug as this site writes them: lowercase letters and digits joined by single hyphens",
            )),
            (None, Some(Value::String(path))) if is_work_path(path) => {
                Ok(About::Article(path.clone()))
            }
            (None, Some(_)) => Err(invalid(
                "`about.article` must be the site-relative path of a published page",
            )),
            _ => Err(invalid(
                "`about` names exactly one of `series` or `article`",
            )),
        }
    }
}

/// A slug as the site itself writes them ([`slugify`]): letters and digits,
/// non-ASCII ones included, lowercased and joined by single hyphens, at most
/// [`MAX_ID_CHARS`] characters. A series or a draft is named by its slug, so
/// a series titled in another script is still one a suggestion can name.
pub fn valid_slug(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= MAX_ID_CHARS && slugify(value) == value
}

/// A scheme-qualified identifier the reader gives for the suggested source.
/// A hint, never a stable source identifier of the Source Library.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentifierHint {
    pub scheme: String,
    pub value: String,
}

/// What the reader says about the suggested source. Every field is the
/// reader's own statement, checked for shape only and never against a
/// remote service.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SourceHints {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub creators: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub identifiers: Vec<IdentifierHint>,
}

impl SourceHints {
    pub fn is_empty(&self) -> bool {
        self == &SourceHints::default()
    }

    fn checked(mut self) -> Result<Self, SuggestionError> {
        let invalid = |message: String| SuggestionError::new(ErrorCode::InvalidHint, message);
        let text = |field: &str, value: Option<String>, max: usize| {
            value
                .map(|value| {
                    reader_text(&value, max).ok_or_else(|| {
                        invalid(format!(
                            "`hints.{field}` must be 1 to {max} characters of plain text"
                        ))
                    })
                })
                .transpose()
        };
        self.title = text("title", self.title.take(), MAX_HINT_CHARS)?;
        self.year = text("year", self.year.take(), MAX_YEAR_CHARS)?;
        self.publisher = text("publisher", self.publisher.take(), MAX_HINT_CHARS)?;
        if self.creators.len() > MAX_CREATORS {
            return Err(invalid(format!(
                "`hints.creators` takes at most {MAX_CREATORS} names"
            )));
        }
        self.creators = self
            .creators
            .iter()
            .map(|name| {
                reader_text(name, MAX_CREATOR_CHARS).ok_or_else(|| {
                    invalid(format!(
                        "each `hints.creators` entry must be 1 to {MAX_CREATOR_CHARS} characters of plain text"
                    ))
                })
            })
            .collect::<Result<_, _>>()?;
        if self.identifiers.len() > MAX_IDENTIFIERS {
            return Err(invalid(format!(
                "`hints.identifiers` takes at most {MAX_IDENTIFIERS}"
            )));
        }
        let shape = || {
            invalid(
                "each `hints.identifiers` entry needs one of the schemes doi, isbn, issn, url, pmid or pmcid and a value of that shape"
                    .into(),
            )
        };
        let mut identifiers = Vec::with_capacity(self.identifiers.len());
        for identifier in &self.identifiers {
            let scheme = identifier.scheme.as_str();
            let longest = if scheme == "url" {
                MAX_IDENTIFIER_URL_CHARS
            } else {
                MAX_IDENTIFIER_CHARS
            };
            let value = reader_text(&identifier.value, longest).ok_or_else(shape)?;
            let value = match scheme {
                // A link is held to the one public-address rule and written
                // as a link is everywhere else.
                "url" => normalize_suggestion_url(&value).ok_or_else(shape)?,
                "doi" | "isbn" | "issn" => {
                    check_identifier(scheme, &value).map_err(|_| shape())?;
                    value
                }
                "pmid" | "pmcid" if public_identifier(scheme, &value) => value,
                _ => return Err(shape()),
            };
            identifiers.push(IdentifierHint {
                scheme: scheme.to_string(),
                value,
            });
        }
        self.identifiers = identifiers;
        Ok(self)
    }
}

/// How to reach the reader, with their agreement. Private: it is shown only
/// to those who may see a reader's private identity, and is never written to
/// a log, an audit event or a debug print.
#[derive(Clone, PartialEq, Eq)]
pub struct Contact {
    address: String,
}

impl std::fmt::Debug for Contact {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Contact(<private>)")
    }
}

impl Contact {
    /// The address, for an editor who may see it. Nothing here sends to it.
    pub fn address(&self) -> &str {
        &self.address
    }

    /// A plain mailbox: one ASCII `local@domain`, no display name, comment,
    /// quoting or whitespace.
    pub(crate) fn new(address: &str) -> Result<Self, SuggestionError> {
        let invalid = || {
            SuggestionError::new(
                ErrorCode::InvalidContact,
                "`contact.address` must be one plain e-mail address such as name@example.org",
            )
        };
        let (local, domain) = address.split_once('@').ok_or_else(invalid)?;
        let local_ok = (1..=64).contains(&local.len())
            && local
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._%+-".contains(&b))
            && !local.starts_with('.')
            && !local.ends_with('.')
            && !local.contains("..");
        let labels: Vec<&str> = domain.split('.').collect();
        let domain_ok = labels.len() >= 2
            && labels.iter().all(|label| {
                (1..=63).contains(&label.len())
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    && !label.starts_with('-')
                    && !label.ends_with('-')
            });
        if address.len() > MAX_CONTACT_BYTES || !local_ok || !domain_ok {
            return Err(invalid());
        }
        Ok(Self {
            address: address.to_string(),
        })
    }
}

/// A source link a reader gave: an absolute HTTP(S) address without
/// credentials ([`normalize_feedback_source_url`]) that also passes the one
/// rule for a public address ([`public_url_problem`], shared with the
/// publication boundary): it names no private or local network and carries
/// no key, token or signature, so an editor who opens it reaches the public
/// web. Nothing in open.blog fetches it.
pub fn normalize_suggestion_url(value: &str) -> Option<String> {
    normalize_feedback_source_url(value).filter(|url| public_url_problem(url).is_none())
}

// ---------------------------------------------------------------------------
// Submission

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireSubmission {
    #[serde(rename = "version")]
    _version: u64,
    kind: String,
    #[serde(rename = "type")]
    suggestion_type: String,
    text: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    hints: Option<SourceHints>,
    #[serde(default)]
    about: Option<Value>,
    #[serde(default)]
    attribution: Option<ReaderAttribution>,
    #[serde(default)]
    contact: Option<WireContact>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireContact {
    address: String,
    follow_up: bool,
}

/// What the reader's chosen name looks like in a debug print: a name they
/// agreed to show may be printed, one they did not never is.
struct RedactedAttribution<'a>(&'a ReaderAttribution);

impl std::fmt::Debug for RedactedAttribution<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let attribution = self.0;
        let mut shown = f.debug_struct("ReaderAttribution");
        match (&attribution.name, attribution.publish_name) {
            (Some(name), true) => shown.field("name", name),
            (Some(_), false) => shown.field("name", &format_args!("<private>")),
            (None, _) => shown.field("name", &Option::<String>::None),
        };
        shown
            .field("publish_name", &attribution.publish_name)
            .finish()
    }
}

/// What a reader sends: the suggestion, never a receipt or a state. Every
/// field has passed its rule; nothing is repaired but trimming and the
/// collapsing of whitespace in the name. Its debug print never shows a name
/// the reader did not agree to show, or their contact.
#[derive(Clone, PartialEq, Eq)]
pub struct Submission {
    pub suggestion_type: SuggestionType,
    pub text: String,
    pub url: Option<String>,
    pub hints: SourceHints,
    pub about: Option<About>,
    pub attribution: ReaderAttribution,
    pub contact: Option<Contact>,
}

impl std::fmt::Debug for Submission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Submission")
            .field("suggestion_type", &self.suggestion_type)
            .field("text", &self.text)
            .field("url", &self.url)
            .field("hints", &self.hints)
            .field("about", &self.about)
            .field("attribution", &RedactedAttribution(&self.attribution))
            .field("contact", &self.contact)
            .finish()
    }
}

fn read_version(value: &Value, what: &str) -> Result<(), SuggestionError> {
    match value.get("version").and_then(Value::as_u64) {
        Some(FUTURE_SUGGESTION_VERSION) => Ok(()),
        Some(version) if version > FUTURE_SUGGESTION_VERSION => Err(SuggestionError::new(
            ErrorCode::UnsupportedVersion,
            format!("this {what} is version {version}, newer than the version {FUTURE_SUGGESTION_VERSION} this open.blog reads"),
        )),
        _ => Err(malformed(&format!("a {what} needs `version` 1"))),
    }
}

impl Submission {
    /// Read a submission from JSON text, refusing a newer version, an unknown
    /// field or any broken rule.
    pub fn from_json(text: &str) -> Result<Self, SuggestionError> {
        let value = parse_bounded(text, "suggestion", MAX_SUBMISSION_BYTES)?;
        Self::from_value(&value)
    }

    fn from_value(value: &Value) -> Result<Self, SuggestionError> {
        read_version(value, "suggestion")?;
        let wire: WireSubmission = serde_json::from_value(value.clone()).map_err(|_| {
            malformed("a suggestion has a field this version does not define, or a field of the wrong type")
        })?;
        if wire.kind != KIND.id() {
            return Err(SuggestionError::new(
                ErrorCode::WrongKind,
                "a suggestion's `kind` must be `future-suggestion`",
            ));
        }
        let suggestion_type = SuggestionType::from_id(&wire.suggestion_type).ok_or_else(|| {
            SuggestionError::new(ErrorCode::UnknownType, "`type` is not a suggestion type")
        })?;
        let text = reader_text(&wire.text, MAX_TEXT_CHARS).ok_or_else(|| {
            SuggestionError::new(
                ErrorCode::InvalidText,
                format!("`text` must be 1 to {MAX_TEXT_CHARS} characters of plain text"),
            )
        })?;
        let hints = wire.hints.unwrap_or_default();
        if suggestion_type == SuggestionType::Question && (wire.url.is_some() || !hints.is_empty())
        {
            return Err(SuggestionError::new(
                ErrorCode::NotForQuestion,
                "a question is words only; send a source as its own suggestion",
            ));
        }
        let url = wire
            .url
            .map(|url| {
                normalize_suggestion_url(&url).ok_or_else(|| {
                    SuggestionError::new(
                        ErrorCode::InvalidUrl,
                        "`url` must be an absolute public http: or https: address without credentials",
                    )
                })
            })
            .transpose()?;
        let about = wire.about.as_ref().map(About::from_value).transpose()?;
        let attribution = checked_attribution(wire.attribution.unwrap_or_default())?;
        let contact = wire
            .contact
            .map(|contact| {
                if !contact.follow_up {
                    return Err(SuggestionError::new(
                        ErrorCode::ContactWithoutConsent,
                        "`contact` is kept only when `followUp` agrees to be contacted",
                    ));
                }
                Contact::new(&contact.address)
            })
            .transpose()?;
        let submission = Self {
            suggestion_type,
            text,
            url,
            hints: hints.checked()?,
            about,
            attribution,
            contact,
        };
        let mut stored = Map::new();
        stored.insert("type".into(), submission.suggestion_type.id().into());
        stored.extend(submission.details());
        if postgres_text_bytes(&Value::Object(stored)) > MAX_STORED_DETAILS_BYTES {
            return Err(SuggestionError::new(
                ErrorCode::TooLarge,
                format!(
                    "a suggestion's links and hints are larger than {MAX_STORED_DETAILS_BYTES} bytes once stored"
                ),
            ));
        }
        Ok(submission)
    }

    /// Canonical JSON, in a fixed field order.
    pub fn to_json(&self) -> String {
        self.to_value().to_string()
    }

    fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("version".into(), FUTURE_SUGGESTION_VERSION.into());
        object.insert("kind".into(), KIND.id().into());
        object.insert("type".into(), self.suggestion_type.id().into());
        object.insert("text".into(), self.text.clone().into());
        object.extend(self.details());
        if self.attribution != ReaderAttribution::default() {
            object.insert(
                "attribution".into(),
                serde_json::to_value(&self.attribution).expect("attribution serializes"),
            );
        }
        Value::Object(object)
    }

    /// The fields a hosted row keeps in `details`, beside the columns that
    /// hold the text and the reader's name.
    fn details(&self) -> Map<String, Value> {
        let mut object = Map::new();
        if let Some(url) = &self.url {
            object.insert("url".into(), url.clone().into());
        }
        if !self.hints.is_empty() {
            object.insert(
                "hints".into(),
                serde_json::to_value(&self.hints).expect("hints serialize"),
            );
        }
        if let Some(about) = &self.about {
            object.insert("about".into(), about.to_value());
        }
        if let Some(contact) = &self.contact {
            object.insert(
                "contact".into(),
                json!({ "address": contact.address, "followUp": true }),
            );
        }
        object
    }
}

/// The length in bytes of a JSON value as Postgres writes a jsonb value as
/// text: compact, with one more byte after every `:` and `,`.
fn postgres_text_bytes(value: &Value) -> usize {
    value.to_string().len() + extra_separator_bytes(value)
}

fn extra_separator_bytes(value: &Value) -> usize {
    match value {
        Value::Object(map) => {
            let separators = if map.is_empty() { 0 } else { 2 * map.len() - 1 };
            separators + map.values().map(extra_separator_bytes).sum::<usize>()
        }
        Value::Array(items) => {
            items.len().saturating_sub(1) + items.iter().map(extra_separator_bytes).sum::<usize>()
        }
        _ => 0,
    }
}

fn parse_bounded(text: &str, what: &str, limit: usize) -> Result<Value, SuggestionError> {
    if text.len() > limit {
        return Err(SuggestionError::new(
            ErrorCode::TooLarge,
            format!("a {what} is larger than {limit} bytes"),
        ));
    }
    serde_json::from_str(text).map_err(|_| malformed(&format!("a {what} is not valid JSON")))
}

fn checked_attribution(
    attribution: ReaderAttribution,
) -> Result<ReaderAttribution, SuggestionError> {
    let name = attribution
        .name
        .map(|name| {
            let collapsed = name.split_whitespace().collect::<Vec<_>>().join(" ");
            reader_text(&collapsed, MAX_READER_NAME_CHARS).ok_or_else(|| {
                SuggestionError::new(
                    ErrorCode::InvalidName,
                    format!("`attribution.name` must be 1 to {MAX_READER_NAME_CHARS} characters of plain text"),
                )
            })
        })
        .transpose()?;
    if name.is_none() && attribution.publish_name {
        return Err(SuggestionError::new(
            ErrorCode::ConsentWithoutName,
            "`attribution.publishName` needs a name to publish",
        ));
    }
    Ok(ReaderAttribution {
        name,
        publish_name: attribution.publish_name,
    })
}

// ---------------------------------------------------------------------------
// The received record

/// Where and when the site received a suggestion. The time is the
/// receiver's, never the reader's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    /// The published page the reader sent it from, such as `/posts/tides/`.
    pub work: String,
    pub received_at: DateTime,
    pub channel: FeedbackChannel,
}

impl Receipt {
    fn to_value(&self) -> Value {
        json!({
            "work": self.work,
            "receivedAt": self.received_at.rfc3339(),
            "channel": serde_json::to_value(self.channel).expect("channel serializes"),
        })
    }

    fn from_value(value: &Value) -> Result<Self, SuggestionError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "camelCase")]
        struct Wire {
            work: String,
            received_at: String,
            channel: FeedbackChannel,
        }
        let wire: Wire = serde_json::from_value(value.clone())
            .map_err(|_| malformed("a suggestion's `receipt` is malformed"))?;
        if !is_work_path(&wire.work) {
            return Err(SuggestionError::new(
                ErrorCode::InvalidWork,
                "`receipt.work` must be the site-relative path of a published page",
            ));
        }
        let received_at = parse_canonical_time(&wire.received_at).ok_or_else(|| {
            SuggestionError::new(
                ErrorCode::InvalidTime,
                "`receipt.receivedAt` must be a UTC time written like 2026-10-26T10:00:00Z",
            )
        })?;
        Ok(Self {
            work: wire.work,
            received_at,
            channel: wire.channel,
        })
    }
}

/// One suggestion as the site stores it: the reader's submission, where and
/// when it arrived, and the revision of its text (raised only when the reader
/// answers a clarification request). Moderation state lives in the one
/// moderation record, never here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Suggestion {
    pub submission: Submission,
    pub receipt: Receipt,
    pub revision: u32,
    /// What an author has linked this suggestion to (ADR 0157), newest last.
    /// Kept in the row's `details` beside the suggestion, holding nothing of
    /// the reader, and never part of what the reader sent.
    pub conversions: Vec<Conversion>,
    /// The text revision the reader agreed to be credited by name for
    /// (ADR 0167): set when they send it with `publishName`, or when they
    /// agree again later, and left behind when a clarification raises the
    /// revision, so consent never covers text they did not agree to. Kept in
    /// the row's `details`.
    pub credit_revision: Option<u32>,
}

impl Suggestion {
    /// Receive a submission: stamp it with the receiver's time, the page it
    /// came from and its channel.
    pub fn receive(
        submission: Submission,
        work: &str,
        received_at: DateTime,
        channel: FeedbackChannel,
    ) -> Result<Self, SuggestionError> {
        let receipt = Receipt::from_value(&json!({
            "work": work,
            "receivedAt": received_at.rfc3339(),
            "channel": serde_json::to_value(channel).expect("channel serializes"),
        }))?;
        let submission_credit = (submission.attribution.publish_name
            && submission.attribution.name.is_some())
        .then_some(1);
        Ok(Self {
            submission,
            receipt,
            revision: 1,
            conversions: Vec::new(),
            credit_revision: submission_credit,
        })
    }

    pub fn suggestion_type(&self) -> SuggestionType {
        self.submission.suggestion_type
    }

    /// The name the reader agreed to be credited by for this text as it
    /// stands now, if any (ADR 0167): consent given for the current revision,
    /// and not withdrawn. A clarification that changed the text, or a changed
    /// consent, needs the reader's fresh agreement before this is `Some`
    /// again. It is only ever offered to an editor in the link view; using it
    /// is the author's own action, and nothing here publishes it.
    pub fn credit(&self) -> Option<&str> {
        self.submission
            .attribution
            .public_name()
            .filter(|_| self.credit_revision == Some(self.revision))
    }

    /// The reader's own change to their consent to be credited by name: for
    /// the text as it stands now, or withdrawn. Agreeing needs a name; it
    /// binds the agreement to the current revision, so a later clarification
    /// leaves it behind. Withdrawing clears both the agreement and its
    /// binding.
    pub fn credited(&self, agree: bool) -> Result<Self, SuggestionError> {
        let mut next = self.clone();
        if agree {
            if next.submission.attribution.name.is_none() {
                return Err(SuggestionError::new(
                    ErrorCode::ConsentWithoutName,
                    "`attribution.publishName` needs a name to publish",
                ));
            }
            next.submission.attribution.publish_name = true;
            next.credit_revision = Some(next.revision);
        } else {
            next.submission.attribution.publish_name = false;
            next.credit_revision = None;
        }
        Ok(next)
    }

    /// What an editor still has to find out: the metadata the suggestion
    /// lacks. Absent metadata never blocks a suggestion.
    pub fn missing_metadata(&self) -> Vec<&'static str> {
        let mut missing = Vec::new();
        if self.submission.suggestion_type != SuggestionType::Question {
            if self.submission.url.is_none() && self.submission.hints.identifiers.is_empty() {
                missing.push("a link or identifier");
            }
            if self.submission.hints.title.is_none() {
                missing.push("a title");
            }
            if self.submission.hints.creators.is_empty() {
                missing.push("a creator");
            }
        }
        missing
    }

    /// The reader's answer to a clarification request replaces the text and
    /// nothing else: the revision rises by one.
    pub fn clarified(&self, text: &str) -> Result<Self, SuggestionError> {
        let text = reader_text(text, MAX_TEXT_CHARS).ok_or_else(|| {
            SuggestionError::new(
                ErrorCode::InvalidText,
                format!("`text` must be 1 to {MAX_TEXT_CHARS} characters of plain text"),
            )
        })?;
        let revision = self
            .revision
            .checked_add(1)
            .filter(|r| *r <= i32::MAX as u32);
        let revision = revision.ok_or_else(|| malformed("a suggestion has no revisions left"))?;
        let mut next = self.clone();
        next.submission.text = text;
        next.revision = revision;
        Ok(next)
    }

    /// Read a stored record from JSON text. Every rule of
    /// [`Submission::from_json`] applies; nothing is repaired.
    pub fn from_json(text: &str) -> Result<Self, SuggestionError> {
        let mut value = parse_bounded(text, "suggestion record", MAX_JSON_BYTES)?;
        read_version(&value, "suggestion record")?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| malformed("a suggestion record is an object"))?;
        let receipt = object
            .remove("receipt")
            .ok_or_else(|| malformed("a suggestion record needs a `receipt`"))?;
        let conversions = match object.remove("conversions") {
            None => Vec::new(),
            Some(value) => read_conversions(&value)?,
        };
        let credit = object.remove("creditRevision");
        let revision = object
            .remove("revision")
            .and_then(|revision| revision.as_u64())
            .and_then(|revision| u32::try_from(revision).ok())
            .filter(|revision| (1..=i32::MAX as u32).contains(revision))
            .ok_or_else(|| malformed("a suggestion record needs a positive `revision`"))?;
        let submission = Submission::from_value(&value)?;
        let credit_revision = credit
            .map(|credit| {
                credit
                    .as_u64()
                    .and_then(|credit| u32::try_from(credit).ok())
                    .filter(|credit| (1..=revision).contains(credit))
                    .filter(|_| {
                        submission.attribution.publish_name && submission.attribution.name.is_some()
                    })
                    .ok_or_else(|| {
                        SuggestionError::new(
                            ErrorCode::InvalidDetails,
                            "`creditRevision` is a revision of a suggestion whose reader agreed to be credited",
                        )
                    })
            })
            .transpose()?;
        Ok(Self {
            submission,
            receipt: Receipt::from_value(&receipt)?,
            revision,
            conversions,
            credit_revision,
        })
    }

    /// Canonical JSON of the private record: the submission, the receipt and
    /// the revision, in a fixed order.
    pub fn to_json(&self) -> String {
        let mut value = self.submission.to_value();
        let object = value.as_object_mut().expect("a submission is an object");
        object.insert("receipt".into(), self.receipt.to_value());
        object.insert("revision".into(), self.revision.into());
        if !self.conversions.is_empty() {
            object.insert("conversions".into(), conversions_value(&self.conversions));
        }
        if let Some(credit) = self.credit_revision {
            object.insert("creditRevision".into(), credit.into());
        }
        value.to_string()
    }

    /// What one `openblog_feedback` row keeps in `details` (ADR 0154):
    /// `{type, url?, hints?, about?, contact?, conversions?, creditRevision?}`. The text is the row's `body`,
    /// its revision `item_revision`, the page `work` (with no passage
    /// `revision` or `target`: the one hosted schema change is the loosened
    /// check that allows that), the receipt time `received_at` and the
    /// reader's name `reader_name` and `publish_name`.
    pub fn stored_details(&self) -> Value {
        let mut object = Map::new();
        object.insert("type".into(), self.submission.suggestion_type.id().into());
        object.extend(self.submission.details());
        if !self.conversions.is_empty() {
            object.insert("conversions".into(), conversions_value(&self.conversions));
        }
        if let Some(credit) = self.credit_revision {
            object.insert("creditRevision".into(), credit.into());
        }
        Value::Object(object)
    }

    /// Read a suggestion back from the parts of a stored row. `details` is
    /// read as exactly `{type, url?, hints?, about?, contact?, conversions?, creditRevision?}`: a field of
    /// any other shape or name, the reader's text or name among them, is
    /// refused, never read as part of the suggestion.
    pub fn from_stored(
        body: &str,
        revision: u32,
        details: &Value,
        receipt: &Value,
        attribution: &ReaderAttribution,
    ) -> Result<Self, SuggestionError> {
        let invalid = || {
            SuggestionError::new(
                ErrorCode::InvalidDetails,
                "stored details are `{type, url?, hints?, about?, contact?, conversions?, creditRevision?}` and nothing else",
            )
        };
        let details: StoredDetails =
            serde_json::from_value(details.clone()).map_err(|_| invalid())?;
        let mut record = Map::new();
        record.insert("version".into(), FUTURE_SUGGESTION_VERSION.into());
        record.insert("kind".into(), KIND.id().into());
        record.insert("type".into(), details.suggestion_type.into());
        record.insert("text".into(), body.into());
        for (key, value) in [
            ("url", details.url),
            ("hints", details.hints),
            ("about", details.about),
            ("contact", details.contact),
        ] {
            if let Some(value) = value {
                record.insert(key.into(), value);
            }
        }
        if *attribution != ReaderAttribution::default() {
            record.insert(
                "attribution".into(),
                serde_json::to_value(attribution).expect("attribution serializes"),
            );
        }
        record.insert("receipt".into(), receipt.clone());
        record.insert("revision".into(), revision.into());
        if let Some(conversions) = details.conversions {
            record.insert("conversions".into(), conversions);
        }
        if let Some(credit) = details.credit_revision {
            record.insert("creditRevision".into(), credit);
        }
        Suggestion::from_json(&Value::Object(record).to_string())
    }

    /// Whether the record holds anything private to the site Admin and the
    /// reader: a contact address, or a name the reader did not agree to show.
    pub fn holds_identity(&self) -> bool {
        let attribution = &self.submission.attribution;
        self.submission.contact.is_some()
            || (attribution.name.is_some() && !attribution.publish_name)
    }

    /// The suggestion with its private identity cleared: no contact, and a
    /// name only if the reader agreed to show it. Everything else, the text,
    /// the link, the hints and the page, is as it was.
    pub fn scrubbed(&self) -> Self {
        let mut next = self.clone();
        next.submission.contact = None;
        if !next.submission.attribution.publish_name {
            next.submission.attribution = ReaderAttribution::default();
        }
        next
    }

    /// What an editor sees, or `None` when `actor` may not see the content of
    /// this item at all (a viewer with no role on its work, or text that was
    /// purged): the view is gated on [`may_view`], not on the caller having
    /// remembered to ask. The reader's contact and unpublished name are
    /// included only for an actor who may see a reader's private identity;
    /// everyone else sees the suggestion and only a name the reader agreed
    /// to show.
    pub fn editor_view(
        &self,
        actor: &Actor<'_>,
        item: &ItemFacts<'_>,
        mode: ParticipationMode,
    ) -> Option<EditorView> {
        if item.kind != KIND || !may_view(actor, item, mode, View::Content) {
            return None;
        }
        let identity = may_view(actor, item, mode, View::PrivateIdentity);
        let attribution = &self.submission.attribution;
        Some(EditorView {
            suggestion_type: self.submission.suggestion_type,
            text: self.submission.text.clone(),
            url: self.submission.url.clone(),
            hints: self.submission.hints.clone(),
            about: self.submission.about.clone(),
            work: self.receipt.work.clone(),
            received: self.receipt.received_at.ymd(),
            name: if identity {
                attribution.name.clone()
            } else {
                self.credit().map(str::to_string)
            },
            contact: self.submission.contact.clone().filter(|_| identity),
            missing: self.missing_metadata(),
            notice: ACCEPTANCE_NOTICE,
        })
    }
}

/// The stored `details` of a suggestion row, read strictly (ADR 0154).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredDetails {
    #[serde(rename = "type")]
    suggestion_type: String,
    #[serde(default)]
    url: Option<Value>,
    #[serde(default)]
    hints: Option<Value>,
    #[serde(default)]
    about: Option<Value>,
    #[serde(default)]
    contact: Option<Value>,
    #[serde(default)]
    conversions: Option<Value>,
    #[serde(default, rename = "creditRevision")]
    credit_revision: Option<Value>,
}

/// The stored list of what a suggestion was linked to: at most
/// [`MAX_CONVERSIONS`], each valid, none twice, and not an empty list (an
/// unlinked suggestion has no field at all).
fn read_conversions(value: &Value) -> Result<Vec<Conversion>, SuggestionError> {
    let invalid = |message: &str| SuggestionError::new(ErrorCode::InvalidDetails, message);
    let items = value
        .as_array()
        .filter(|items| (1..=MAX_CONVERSIONS).contains(&items.len()))
        .ok_or_else(|| invalid("`conversions` is one to eight links"))?;
    let mut links: Vec<Conversion> = Vec::with_capacity(items.len());
    for item in items {
        let link = Conversion::from_value(item)?;
        if links
            .iter()
            .any(|seen| seen.kind == link.kind && seen.id == link.id)
        {
            return Err(invalid("a suggestion is linked to one target only once"));
        }
        links.push(link);
    }
    Ok(links)
}

fn conversions_value(conversions: &[Conversion]) -> Value {
    Value::Array(conversions.iter().map(Conversion::to_value).collect())
}

/// Whether a kept suggestion owes the clearing of its private identity now:
/// it holds some, it is approved and kept, and either an author has linked it
/// to future work or retention's period for it
/// ([`RetentionStep::ScrubIdentity`]) has passed. The contact and unpublished
/// name were kept so an editor could ask about the idea; once it is acted on
/// or left for a period, they are not needed.
pub fn identity_scrub_due(
    policy: &ModerationPolicy,
    item: &ItemFacts<'_>,
    suggestion: &Suggestion,
    conversions: &[Conversion],
    now: DateTime,
) -> bool {
    item.kind == KIND
        && item.content_retained
        && item.state == ModerationState::Approved
        && suggestion.holds_identity()
        && (!conversions.is_empty()
            || policy.retention_due(item, now) == Some(RetentionStep::ScrubIdentity))
}

/// A suggestion as one editor may see it. Its debug print never shows the
/// reader's name or contact.
#[derive(Clone, PartialEq, Eq)]
pub struct EditorView {
    pub suggestion_type: SuggestionType,
    pub text: String,
    pub url: Option<String>,
    pub hints: SourceHints,
    pub about: Option<About>,
    pub work: String,
    /// The day it was received, `YYYY-MM-DD`.
    pub received: String,
    pub name: Option<String>,
    pub contact: Option<Contact>,
    pub missing: Vec<&'static str>,
    pub notice: &'static str,
}

impl std::fmt::Debug for EditorView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EditorView")
            .field("suggestion_type", &self.suggestion_type)
            .field("text", &self.text)
            .field("url", &self.url)
            .field("hints", &self.hints)
            .field("about", &self.about)
            .field("work", &self.work)
            .field("received", &self.received)
            .field(
                "name",
                &self.name.as_ref().map(|_| format_args!("<private>")),
            )
            .field("contact", &self.contact)
            .field("missing", &self.missing)
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Duplicates

/// Every key under which this suggestion names a source: one for each
/// identifier it gives and one for its link, so two suggestions are the same
/// source when they share any. An identifier is read as it means, not as it
/// was typed: a DOI by its name however it was written (bare, `doi:` or a
/// resolver link), an ISBN-10 and the ISBN-13 it converts to as one, an ISSN
/// without its hyphen; a link without its scheme, a leading `www.`, its
/// fragment, a trailing slash and tracking parameters, with its other
/// parameters in order, and a DOI resolver link as the DOI it names. Empty
/// for a suggestion that names no source. Keys are for an editor to see that
/// a source came in more than once; they are never a count, a rank or a
/// signal.
pub fn source_keys(submission: &Submission) -> Vec<String> {
    let mut keys = BTreeSet::new();
    for identifier in &submission.hints.identifiers {
        let value = identifier.value.trim();
        let key = match identifier.scheme.as_str() {
            "doi" => doi_key(value),
            "isbn" => isbn_key(value),
            "issn" | "pmid" | "pmcid" => Some(format!(
                "{}:{}",
                identifier.scheme,
                value
                    .chars()
                    .filter(char::is_ascii_alphanumeric)
                    .collect::<String>()
                    .to_ascii_lowercase()
            )),
            "url" => url_key(value),
            _ => None,
        };
        keys.extend(key);
    }
    keys.extend(submission.url.as_deref().and_then(url_key));
    keys.into_iter().collect()
}

fn doi_key(value: &str) -> Option<String> {
    let name = value.strip_prefix("doi:").unwrap_or(value).trim();
    let url = normalize_doi_url(name)?;
    Some(format!(
        "doi:{}",
        url.trim_start_matches("https://doi.org/").to_lowercase()
    ))
}

/// An ISBN as its ISBN-13 digits, so the two forms of one book are one key.
fn isbn_key(value: &str) -> Option<String> {
    let digits: String = value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let thirteen = match digits.len() {
        13 => digits,
        10 => {
            let body = format!("978{}", &digits[..9]);
            let sum: u32 = body
                .chars()
                .enumerate()
                .map(|(index, c)| c.to_digit(10).unwrap_or(0) * if index % 2 == 0 { 1 } else { 3 })
                .sum();
            format!("{body}{}", (10 - sum % 10) % 10)
        }
        _ => return None,
    };
    Some(format!("isbn:{thirteen}"))
}

fn url_key(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    // A DOI resolver link names the DOI it resolves.
    if matches!(host.as_str(), "doi.org" | "dx.doi.org") {
        if let Some(key) = doi_key(value) {
            return Some(key);
        }
    }
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let mut query: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| {
            !(key.starts_with("utm_") || matches!(key.as_ref(), "fbclid" | "gclid" | "igshid"))
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    query.sort();
    let mut key = format!("url:{host}{}", url.path().trim_end_matches('/'));
    for (index, (name, value)) in query.iter().enumerate() {
        key.push(if index == 0 { '?' } else { '&' });
        key.push_str(&format!("{name}={value}"));
    }
    Some(key)
}

/// Groups of two or more suggestions that name the same source (they share
/// any [`source_keys`] key, directly or through a third), as sorted lists of
/// ids, the groups in order of their first id. An editor's aid for handling
/// them together; it reports no number and is never shown to readers. Only
/// items `actor` may see ([`may_view`]) are considered, so a group never
/// reveals that an item the actor cannot see exists.
pub fn duplicate_groups(
    actor: &Actor<'_>,
    mode: ParticipationMode,
    items: &[(&ItemFacts<'_>, &Suggestion)],
) -> Vec<Vec<String>> {
    let visible: Vec<(&str, Vec<String>)> = items
        .iter()
        .filter(|(facts, _)| facts.kind == KIND && may_view(actor, facts, mode, View::Content))
        .map(|(facts, suggestion)| (facts.id, source_keys(&suggestion.submission)))
        .filter(|(_, keys)| !keys.is_empty())
        .collect();
    fn find(parent: &mut [usize], mut index: usize) -> usize {
        while parent[index] != index {
            parent[index] = parent[parent[index]];
            index = parent[index];
        }
        index
    }
    // Items that share a key are one group, and so are items joined through
    // a third.
    let mut parent: Vec<usize> = (0..visible.len()).collect();
    let mut owner: BTreeMap<&str, usize> = BTreeMap::new();
    for (index, (_, keys)) in visible.iter().enumerate() {
        for key in keys {
            match owner.get(key.as_str()) {
                Some(&other) => {
                    let (a, b) = (find(&mut parent, index), find(&mut parent, other));
                    parent[a.max(b)] = a.min(b);
                }
                None => {
                    owner.insert(key, index);
                }
            }
        }
    }
    let mut groups: BTreeMap<usize, BTreeSet<String>> = BTreeMap::new();
    for (index, (id, _)) in visible.iter().enumerate() {
        let root = find(&mut parent, index);
        groups.entry(root).or_default().insert((*id).to_string());
    }
    let mut groups: Vec<Vec<String>> = groups
        .into_values()
        .filter(|ids| ids.len() > 1)
        .map(|ids| ids.into_iter().collect())
        .collect();
    groups.sort();
    groups
}

// ---------------------------------------------------------------------------
// Editorial standing, conversion and library candidates

/// Where a suggestion stands with the editors, derived from the one
/// moderation state and the conversions recorded; it is never stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Standing {
    /// Not yet looked at.
    Received,
    /// The editors asked the reader to say more.
    NeedsClarification,
    /// Accepted: editorial interest, nothing more ([`ACCEPTANCE_NOTICE`]).
    Interested,
    /// An author linked it to future work.
    Converted,
    /// Closed by the editors after an author had linked it to future work.
    /// It is not a decline: the idea was used, and the link stays.
    ClosedConverted,
    /// Declined or closed by the editors, or expired.
    Declined,
    /// The reader withdrew it.
    Withdrawn,
}

impl Standing {
    pub fn of(state: ModerationState, conversions: &[Conversion]) -> Self {
        match state {
            ModerationState::Pending => Standing::Received,
            ModerationState::Clarification => Standing::NeedsClarification,
            ModerationState::Approved if conversions.is_empty() => Standing::Interested,
            ModerationState::Approved => Standing::Converted,
            ModerationState::Removed if !conversions.is_empty() => Standing::ClosedConverted,
            ModerationState::Rejected | ModerationState::Removed => Standing::Declined,
            ModerationState::Withdrawn => Standing::Withdrawn,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Standing::Received => "received",
            Standing::NeedsClarification => "needs-clarification",
            Standing::Interested => "interested",
            Standing::Converted => "converted",
            Standing::ClosedConverted => "closed-converted",
            Standing::Declined => "declined",
            Standing::Withdrawn => "withdrawn",
        }
    }

    /// A label that names a stage, never a verdict on the suggestion.
    pub fn label(self) -> &'static str {
        match self {
            Standing::Received => "Received",
            Standing::NeedsClarification => "Waiting for the reader to say more",
            Standing::Interested => "Editors are interested",
            Standing::Converted => "Linked to future work",
            Standing::ClosedConverted => "Linked to future work, now closed",
            Standing::Declined => "Not taken forward",
            Standing::Withdrawn => "Withdrawn by the reader",
        }
    }
}

/// What the reader's receipt says about a link between their suggestion and
/// work the editors are doing. It is not a promise.
pub const LINK_NOTICE: &str = "An editor has recorded a link between it and work they are doing. That is a record, not a promise to publish, and it says nothing about who is right.";

/// What it says when the editors did not take a suggestion forward.
pub const DECLINE_NOTICE: &str = "Not taking an idea forward is about this site's plans. It is not a judgement of the idea or of you.";

impl Standing {
    /// What a reader's receipt says about their own suggestion, beyond the
    /// stage's label: the one honest sentence, in the words of
    /// [`ACCEPTANCE_NOTICE`]. It never ranks, counts or compares, never says
    /// the suggestion was checked, endorsed or will be published, and never
    /// names what it was linked to.
    pub fn reader_note(self) -> Option<&'static str> {
        match self {
            Standing::Received | Standing::NeedsClarification | Standing::Withdrawn => None,
            Standing::Interested => Some(ACCEPTANCE_NOTICE),
            Standing::Converted | Standing::ClosedConverted => Some(LINK_NOTICE),
            Standing::Declined => Some(DECLINE_NOTICE),
        }
    }

    /// Whether the receipt adds [`ACCEPTANCE_NOTICE`] to the stage: every
    /// stage in which the editors showed interest.
    pub fn shows_acceptance_notice(self) -> bool {
        matches!(
            self,
            Standing::Interested | Standing::Converted | Standing::ClosedConverted
        )
    }
}

/// How the editors have dealt with a suggestion, once they have: the four
/// outcomes an editor records. Derived from the moderation state and the
/// recorded links, never stored as a state of its own; every change of state
/// is already in the private audit trail, and so is every link.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Outcome {
    /// Accepted and kept, not yet linked to anything.
    Held,
    /// Linked to future work an author made from it, whether or not it has
    /// since been closed: the idea was used and the link stays.
    Converted,
    /// Not taken forward: rejected before it was accepted, or expired
    /// unanswered.
    Declined,
    /// Accepted once, then removed by the editors without ever being linked:
    /// the moderation machine removes only what was approved, so removal is
    /// a close, not a decline.
    Closed,
}

impl Outcome {
    pub const ALL: [Outcome; 4] = [
        Outcome::Held,
        Outcome::Converted,
        Outcome::Declined,
        Outcome::Closed,
    ];

    /// The outcome a suggestion has now, or `None` while it is still
    /// undecided (received, waiting for the reader) or was withdrawn by the
    /// reader, which is theirs and not an editorial outcome.
    pub fn of(state: ModerationState, conversions: &[Conversion]) -> Option<Self> {
        match state {
            ModerationState::Pending
            | ModerationState::Clarification
            | ModerationState::Withdrawn => None,
            ModerationState::Approved if conversions.is_empty() => Some(Outcome::Held),
            ModerationState::Approved => Some(Outcome::Converted),
            ModerationState::Removed if !conversions.is_empty() => Some(Outcome::Converted),
            ModerationState::Removed => Some(Outcome::Closed),
            ModerationState::Rejected => Some(Outcome::Declined),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Outcome::Held => "held",
            Outcome::Converted => "converted",
            Outcome::Declined => "declined",
            Outcome::Closed => "closed",
        }
    }

    /// A word for the stage, never a verdict.
    pub fn label(self) -> &'static str {
        match self {
            Outcome::Held => "Held",
            Outcome::Converted => "Converted",
            Outcome::Declined => "Declined",
            Outcome::Closed => "Closed",
        }
    }
}

/// Whether `id` can name what a conversion of `kind` points at: a draft or a
/// series by its slug as the site writes slugs ([`valid_slug`]), a library
/// source by its source id, which the Source Library keeps lowercase ASCII.
fn valid_target(kind: ConversionKind, id: &str) -> bool {
    match kind {
        ConversionKind::Draft | ConversionKind::Series => valid_slug(id),
        ConversionKind::LibrarySource => id.len() <= MAX_ID_CHARS && valid_id(id),
    }
}

/// What a conversion points at, by the id of something an author made.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ConversionKind {
    /// A draft post, by its slug.
    Draft,
    /// A series, by its slug.
    Series,
    /// A record the author made in the Source Library, by its source id.
    LibrarySource,
}

impl ConversionKind {
    pub const ALL: [ConversionKind; 3] = [
        ConversionKind::Draft,
        ConversionKind::Series,
        ConversionKind::LibrarySource,
    ];

    pub fn id(self) -> &'static str {
        match self {
            ConversionKind::Draft => "draft",
            ConversionKind::Series => "series",
            ConversionKind::LibrarySource => "library-source",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.id() == id)
    }
}

/// A link from an accepted suggestion to work an author made from it. It
/// holds the target's id, when and which Admin account recorded it, and
/// nothing of the reader: no name, no contact, no text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conversion {
    pub kind: ConversionKind,
    pub id: String,
    pub at: DateTime,
    pub by: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireConversion {
    kind: String,
    id: String,
    at: String,
    by: String,
}

impl Conversion {
    pub fn to_value(&self) -> Value {
        json!({
            "kind": self.kind.id(),
            "id": self.id,
            "at": self.at.rfc3339(),
            "by": self.by,
        })
    }

    pub fn from_value(value: &Value) -> Result<Self, SuggestionError> {
        let invalid = |message: &str| SuggestionError::new(ErrorCode::InvalidDetails, message);
        let wire: WireConversion = serde_json::from_value(value.clone())
            .map_err(|_| invalid("a conversion has an unknown or mistyped field"))?;
        let kind = ConversionKind::from_id(&wire.kind).ok_or_else(|| {
            invalid("a conversion's `kind` is not draft, series or library-source")
        })?;
        if !valid_target(kind, &wire.id) {
            return Err(invalid(
                "a conversion's `id` must be the slug of what the author made",
            ));
        }
        let at = parse_canonical_time(&wire.at)
            .ok_or_else(|| invalid("a conversion's `at` must be a UTC time"))?;
        if wire.by.is_empty()
            || wire.by.chars().count() > MAX_ACTOR_CHARS
            || wire.by.chars().any(char::is_control)
        {
            return Err(invalid("a conversion's `by` must name an Admin account"));
        }
        Ok(Self {
            kind,
            id: wire.id,
            at,
            by: wire.by,
        })
    }
}

/// Why a conversion or library candidate was refused. Nothing changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConversionError {
    /// The item is not a suggestion.
    WrongKind,
    /// Only the site Admin and a coordinator of the work decide.
    Denied,
    /// Only a suggestion accepted at its current revision, still kept.
    NotAccepted,
    /// This target is already linked.
    AlreadyLinked,
    /// The suggestion keeps [`MAX_CONVERSIONS`] links already.
    TooMany,
    /// The target id is not a slug as this site writes them (a library
    /// source's is a lowercase ASCII source id).
    InvalidTarget,
}

impl ConversionError {
    pub fn code(self) -> &'static str {
        match self {
            ConversionError::WrongKind => "wrongKind",
            ConversionError::Denied => "denied",
            ConversionError::NotAccepted => "notAccepted",
            ConversionError::AlreadyLinked => "alreadyLinked",
            ConversionError::TooMany => "tooMany",
            ConversionError::InvalidTarget => "invalidTarget",
        }
    }
}

impl std::fmt::Display for ConversionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ConversionError::WrongKind => "the item is not a suggestion for future work",
            ConversionError::Denied => {
                "only the site Admin or a coordinator of the work may do this"
            }
            ConversionError::NotAccepted => {
                "only an accepted suggestion can be linked to future work"
            }
            ConversionError::AlreadyLinked => "the suggestion is already linked to that",
            ConversionError::TooMany => "the suggestion is linked to as much as it can be",
            ConversionError::InvalidTarget => "the target must be the slug of what was made",
        })
    }
}

impl std::error::Error for ConversionError {}

/// The one gate for anything an author does with an accepted suggestion: the
/// moderation policy's own approve grant, on a suggestion that is approved at
/// its current revision, not awaiting clarification, and still kept.
fn gate(actor: &Actor<'_>, item: &ItemFacts<'_>) -> Result<(), ConversionError> {
    if item.kind != KIND {
        return Err(ConversionError::WrongKind);
    }
    if !may_decide(actor, item) {
        return Err(ConversionError::Denied);
    }
    if item.state != ModerationState::Approved
        || item.approved_revision != Some(item.revision)
        || item.current_revision_asked()
        || !item.content_retained
    {
        return Err(ConversionError::NotAccepted);
    }
    Ok(())
}

/// Record that an author linked an accepted suggestion to future work they
/// made. It only records the link: it creates no draft, series or source and
/// sends nothing. `existing` is what the suggestion already links to.
pub fn convert(
    actor: &Actor<'_>,
    item: &ItemFacts<'_>,
    existing: &[Conversion],
    kind: ConversionKind,
    target: &str,
    at: DateTime,
) -> Result<Conversion, ConversionError> {
    gate(actor, item)?;
    if !valid_target(kind, target) {
        return Err(ConversionError::InvalidTarget);
    }
    if existing
        .iter()
        .any(|link| link.kind == kind && link.id == target)
    {
        return Err(ConversionError::AlreadyLinked);
    }
    if existing.len() >= MAX_CONVERSIONS {
        return Err(ConversionError::TooMany);
    }
    let by = actor
        .admin_user()
        .filter(|by| !by.is_empty() && by.chars().count() <= MAX_ACTOR_CHARS)
        .ok_or(ConversionError::Denied)?;
    Ok(Conversion {
        kind,
        id: target.to_string(),
        at,
        by: by.to_string(),
    })
}

impl Suggestion {
    /// The suggestion with one more link recorded: the author's explicit act,
    /// decided by [`convert`] (the same actors, the same accepted suggestions).
    /// It creates nothing and sends nothing; the caller stores the result.
    pub fn linked(
        &self,
        actor: &Actor<'_>,
        item: &ItemFacts<'_>,
        kind: ConversionKind,
        target: &str,
        at: DateTime,
    ) -> Result<Self, ConversionError> {
        let link = convert(actor, item, &self.conversions, kind, target, at)?;
        let mut next = self.clone();
        next.conversions.push(link);
        Ok(next)
    }

    /// The outcome now, from the moderation state and the recorded links.
    pub fn outcome(&self, state: ModerationState) -> Option<Outcome> {
        Outcome::of(state, &self.conversions)
    }

    /// The reader-facing standing now.
    pub fn standing(&self, state: ModerationState) -> Standing {
        Standing::of(state, &self.conversions)
    }
}

/// What an author may copy into a private research note by their own explicit
/// action: the reader's suggestion as plain, labelled, unverified text. It
/// keeps where the suggestion came from and that nothing in it was checked or
/// fetched, so it can never be mistaken for the author's own finding, and it
/// leaves out the reader's name, contact and the time they sent it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResearchDraft {
    /// A question for a future piece becomes a research question; anything
    /// else an observation.
    pub question: bool,
    pub text: String,
}

/// Offer the accepted suggestion to its author as a research note draft. This
/// returns text and writes nowhere: the notebook is changed only by the
/// author's own save. The same actors and the same accepted suggestions as
/// [`library_candidate`].
pub fn research_draft(
    suggestion: &Suggestion,
    actor: &Actor<'_>,
    item: &ItemFacts<'_>,
) -> Result<ResearchDraft, ConversionError> {
    gate(actor, item)?;
    let submission = &suggestion.submission;
    let mut lines = vec![
        "A reader's suggestion for future work, copied here as they sent it. It is unverified reader text: nothing in it has been checked, nothing was fetched, and the editors have only said they are interested.".to_string(),
        format!(
            "Sent from {}. Suggested as: {}.",
            suggestion.receipt.work,
            submission.suggestion_type.label()
        ),
        "What they wrote:".to_string(),
        submission.text.clone(),
    ];
    if let Some(url) = &submission.url {
        lines.push(format!("Link they gave (not opened or checked): {url}"));
    }
    let hints = &submission.hints;
    if let Some(title) = &hints.title {
        lines.push(format!("Title they gave: {title}"));
    }
    if !hints.creators.is_empty() {
        lines.push(format!("Creators they gave: {}", hints.creators.join("; ")));
    }
    if let Some(year) = &hints.year {
        lines.push(format!("Year they gave: {year}"));
    }
    if let Some(publisher) = &hints.publisher {
        lines.push(format!("Publisher they gave: {publisher}"));
    }
    for identifier in &hints.identifiers {
        lines.push(format!(
            "{} they gave (not checked): {}",
            identifier.scheme.to_ascii_uppercase(),
            identifier.value
        ));
    }
    match &submission.about {
        Some(About::Series(slug)) => {
            lines.push(format!("They said it is about the series {slug}."))
        }
        Some(About::Article(path)) => {
            lines.push(format!("They said it is about the article {path}."));
        }
        None => {}
    }
    Ok(ResearchDraft {
        question: submission.suggestion_type == SuggestionType::Question,
        text: lines.join("\n\n"),
    })
}

/// The unverified hints an author may copy into a Source Library record by
/// their own action. Never the reader's text, name or contact, and always
/// marked unverified: a reader's statement is not a bibliographic fact.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibraryCandidate {
    pub suggestion_type: SuggestionType,
    pub url: Option<String>,
    pub hints: SourceHints,
    pub unverified: bool,
}

/// Offer the hints of an accepted suggestion to its author. This returns
/// data and writes nowhere: the Source Library is changed only by the
/// author's own save of a record they chose to make.
pub fn library_candidate(
    suggestion: &Suggestion,
    actor: &Actor<'_>,
    item: &ItemFacts<'_>,
) -> Result<LibraryCandidate, ConversionError> {
    gate(actor, item)?;
    if suggestion.submission.suggestion_type == SuggestionType::Question {
        return Err(ConversionError::WrongKind);
    }
    Ok(LibraryCandidate {
        suggestion_type: suggestion.submission.suggestion_type,
        url: suggestion.submission.url.clone(),
        hints: suggestion.submission.hints.clone(),
        unverified: true,
    })
}
