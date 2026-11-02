//! An author's answer to a Third Perspective about their own section, as the
//! hosted store keeps it and the inbox reads it back (#223, ADRs 0131 to 0135).
//!
//! [`crate::attributed_perspective::admit_response`] decides who may answer and
//! seals that decision. This module is the other half: the one request Admin
//! sends the hosted function, the row the function stores, the answer read
//! back into a checked [`HostedAuthorResponse`], and the checks that an answer
//! still belongs under its parent. The browser-free half of the hosted function
//! (`netlify/lib/author-response.mjs`) is held to the same fixture,
//! `tests/fixtures/author-responses.json`.
//!
//! An answer is one `openblog_feedback` row of kind `author-response` (no
//! schema change): its text in `body`, the parent's work, passage revision and
//! target in the existing columns, and in `details` the parent's id, the
//! responder's public handle, published name and standing, and, private to
//! moderation and never public, the participant binding and the account that
//! wrote it. It always starts pending.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::attributed_perspective::{AttributedTarget, Responder, StaleReason, Standing};
use crate::collaboration::{valid_admin_username, valid_contributor_id};
use crate::date::DateTime;
use crate::feedback_provenance::{is_work_path, parse_canonical_time};
use crate::moderation::{ModerationAction, ModerationState, PolicyError};
use crate::participation::ParticipationKind;
use crate::passage_target::normalize_passage_text;
use crate::scholarly_feedback::is_uuid;
use crate::third_perspective::{normalize_body, PerspectiveTarget};

pub const AUTHOR_RESPONSE_KIND: ParticipationKind = ParticipationKind::AuthorResponse;
pub const AUTHOR_RESPONSE_VERSION: u64 = 1;
/// The longest request, in bytes.
pub const MAX_JSON_BYTES: usize = 16 * 1024;
/// The longest published name of a responder, in characters.
pub const MAX_AUTHOR_NAME_CHARS: usize = 80;
/// The most an answer's `details` hold, in bytes (the column's own bound).
pub const MAX_DETAILS_BYTES: usize = 16 * 1024;

/// Why a request or a stored answer is refused. The code is what the hosted
/// function answers with; the message names the field and never repeats what
/// anyone wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorResponseError {
    pub code: &'static str,
    pub message: String,
}

impl AuthorResponseError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AuthorResponseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AuthorResponseError {}

/// Where the section stood when the answer was written, as the store keeps
/// it: public (a page may say the section has changed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoredStanding {
    Current { moved: bool },
    Stale { reason: StaleReason },
}

impl StoredStanding {
    pub fn of(standing: &Standing) -> Self {
        match standing {
            Standing::Current { moved, .. } => StoredStanding::Current { moved: *moved },
            Standing::Stale { reason, .. } => StoredStanding::Stale { reason: *reason },
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            StoredStanding::Current { moved } => json!({"state": "current", "moved": moved}),
            StoredStanding::Stale { reason } => json!({"state": "stale", "reason": reason.id()}),
        }
    }

    fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        match object.get("state")?.as_str()? {
            "current" if object.len() == 2 => Some(StoredStanding::Current {
                moved: object.get("moved")?.as_bool()?,
            }),
            "stale" if object.len() == 2 => {
                let reason = [
                    StaleReason::SectionChangedOrRemoved,
                    StaleReason::AuthorAbsent,
                    StaleReason::Ambiguous,
                ]
                .into_iter()
                .find(|reason| Some(reason.id()) == object.get("reason").and_then(Value::as_str))?;
                Some(StoredStanding::Stale { reason })
            }
            _ => None,
        }
    }
}

/// Who answered, as the row's `details` keep it: the public part (handle,
/// published name, standing) and the private part (the participant binding and
/// the account), which no public view reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredResponder {
    /// The public contributor handle the section is credited to.
    pub contributor: String,
    /// The name the section, and so the answer, is published under.
    pub author: String,
    pub standing: StoredStanding,
    /// Private: the participant whose binding named the contributor.
    pub participant: String,
    /// Private: the Admin account that wrote the answer.
    pub account: String,
}

impl StoredResponder {
    pub fn of(responder: &Responder, account: &str) -> Self {
        Self {
            contributor: responder.contributor.clone(),
            author: responder.author.clone(),
            standing: StoredStanding::of(&responder.standing),
            participant: responder.participant.clone(),
            account: account.to_string(),
        }
    }

    fn check(&self) -> Result<(), AuthorResponseError> {
        let invalid = |message: &str| AuthorResponseError::new("invalidResponder", message);
        if !valid_contributor_id(&self.contributor) {
            return Err(invalid(
                "`responder.contributor` must be a contributor registry key",
            ));
        }
        if !author_name_ok(&self.author) {
            return Err(invalid(
                "`responder.author` must be 1 to 80 characters of plain text",
            ));
        }
        if !valid_participant(&self.participant) {
            return Err(invalid("`binding.participant` must be a participant id"));
        }
        if !valid_admin_username(&self.account) {
            return Err(AuthorResponseError::new(
                "invalidActor",
                "`actor` must be an Admin account name",
            ));
        }
        Ok(())
    }

    /// The row's `details` (without the parent): public fields under
    /// `responder`, private ones under `binding`.
    fn details(&self, parent: &str) -> Value {
        json!({
            "parent": parent,
            "responder": {
                "contributor": self.contributor,
                "author": self.author,
                "standing": self.standing.to_value(),
            },
            "binding": {"participant": self.participant, "account": self.account},
        })
    }
}

fn valid_participant(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= crate::collaboration::MAX_IDENTIFIER_BYTES
        && !value.starts_with(['-', '_', '.'])
        && !value.ends_with(['-', '_', '.'])
        && !value.contains("..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// A published name as B5 checks a name: collapsed whitespace, 1 to 80
/// characters, no control or text-direction character.
fn author_name_ok(name: &str) -> bool {
    let count = name.chars().count();
    (1..=MAX_AUTHOR_NAME_CHARS).contains(&count)
        && normalize_passage_text(name) == name
        && !name
            .chars()
            .any(|c| c.is_control() || crate::research_notes::bidi_override(c))
}

/// What Admin sends the hosted function to store an answer: the work, the
/// parent as Admin saw it, the text and the responder `admit_response`
/// confirmed. The function checks all of it again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorResponseRequest {
    pub work: String,
    pub parent_id: String,
    pub parent_version: u64,
    pub body: String,
    pub responder: StoredResponder,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRequest {
    version: Value,
    kind: String,
    work: String,
    parent: WireParent,
    body: String,
    responder: WireResponder,
    binding: WireBinding,
    actor: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireParent {
    id: String,
    version: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireResponder {
    contributor: String,
    author: String,
    standing: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireBinding {
    participant: String,
}

fn malformed(message: &str) -> AuthorResponseError {
    AuthorResponseError::new("malformed", message)
}

impl AuthorResponseRequest {
    /// Read a request from JSON text, refusing a newer version, an unknown
    /// field or any broken rule. The checks run in the order the hosted
    /// function runs them, so both report the same first problem. The text is
    /// normalized (line breaks, trimmed); nothing else is repaired.
    pub fn from_json(text: &str) -> Result<Self, AuthorResponseError> {
        if text.len() > MAX_JSON_BYTES {
            return Err(AuthorResponseError::new(
                "tooLarge",
                format!("an author response is larger than {MAX_JSON_BYTES} bytes"),
            ));
        }
        let value: Value = serde_json::from_str(text)
            .map_err(|_| malformed("an author response is not valid JSON"))?;
        match value.get("version").and_then(Value::as_u64) {
            Some(version) if version > AUTHOR_RESPONSE_VERSION => {
                return Err(AuthorResponseError::new(
                    "unsupportedVersion",
                    format!("this author response is version {version}, newer than the version {AUTHOR_RESPONSE_VERSION} this open.blog reads"),
                ))
            }
            Some(AUTHOR_RESPONSE_VERSION) => {}
            _ => return Err(malformed("an author response needs `version` 1")),
        }
        let wire: WireRequest = serde_json::from_value(value).map_err(|_| {
            malformed("an author response has a field this version does not define, or a field of the wrong type")
        })?;
        let _ = wire.version;
        if wire.kind != AUTHOR_RESPONSE_KIND.id() {
            return Err(AuthorResponseError::new(
                "wrongKind",
                "`kind` must be `author-response`",
            ));
        }
        if !is_work_path(&wire.work) {
            return Err(AuthorResponseError::new(
                "invalidWork",
                "`work` must be the site-relative path of a published page, such as /posts/tides/",
            ));
        }
        let parent_version = wire
            .parent
            .version
            .as_u64()
            .filter(|version| (1..=i32::MAX as u64).contains(version));
        let (true, Some(parent_version)) = (is_uuid(&wire.parent.id), parent_version) else {
            return Err(AuthorResponseError::new(
                "invalidParent",
                "`parent` must name a Third Perspective by its id and version",
            ));
        };
        let Some(body) = normalize_body(&wire.body) else {
            return Err(AuthorResponseError::new(
                "invalidBody",
                "`body` must be 1 to 4000 characters of plain text",
            ));
        };
        let standing = StoredStanding::from_value(&wire.responder.standing).ok_or_else(|| {
            AuthorResponseError::new(
                "invalidResponder",
                "`responder.standing` must say current or stale with a known reason",
            )
        })?;
        let responder = StoredResponder {
            contributor: wire.responder.contributor,
            author: wire.responder.author,
            standing,
            participant: wire.binding.participant,
            account: wire.actor,
        };
        responder.check()?;
        Ok(Self {
            work: wire.work,
            parent_id: wire.parent.id.to_ascii_lowercase(),
            parent_version,
            body,
            responder,
        })
    }

    /// A request built from what Admin decided, checked by the same rules in
    /// the same order as [`AuthorResponseRequest::from_json`] reads one.
    pub fn new(
        work: &str,
        parent_id: &str,
        parent_version: u64,
        text: &str,
        responder: StoredResponder,
    ) -> Result<Self, AuthorResponseError> {
        if !is_work_path(work) {
            return Err(AuthorResponseError::new(
                "invalidWork",
                "`work` must be the site-relative path of a published page, such as /posts/tides/",
            ));
        }
        if !is_uuid(parent_id) || !(1..=i32::MAX as u64).contains(&parent_version) {
            return Err(AuthorResponseError::new(
                "invalidParent",
                "`parent` must name a Third Perspective by its id and version",
            ));
        }
        let Some(body) = normalize_body(text) else {
            return Err(AuthorResponseError::new(
                "invalidBody",
                "`body` must be 1 to 4000 characters of plain text",
            ));
        };
        responder.check()?;
        Ok(Self {
            work: work.to_string(),
            parent_id: parent_id.to_ascii_lowercase(),
            parent_version,
            body,
            responder,
        })
    }

    /// The canonical JSON an Admin sends.
    pub fn to_value(&self) -> Value {
        json!({
            "version": AUTHOR_RESPONSE_VERSION,
            "kind": AUTHOR_RESPONSE_KIND.id(),
            "work": self.work,
            "parent": {"id": self.parent_id, "version": self.parent_version},
            "body": self.body,
            "responder": {
                "contributor": self.responder.contributor,
                "author": self.responder.author,
                "standing": self.responder.standing.to_value(),
            },
            "binding": {"participant": self.responder.participant},
            "actor": self.responder.account,
        })
    }

    pub fn to_json(&self) -> String {
        self.to_value().to_string()
    }

    /// What the receiver keeps: the `openblog_feedback` row's columns. The
    /// parent's passage revision and target are the parent row's own, read by
    /// the receiver and never taken from the request. Always pending; no
    /// reader name, no consent, nothing a reader could take back.
    pub fn row(
        &self,
        parent: &ParentRow,
        received_at: DateTime,
    ) -> Result<Value, AuthorResponseError> {
        let row = json!({
            "format_version": AUTHOR_RESPONSE_VERSION,
            "kind": AUTHOR_RESPONSE_KIND.id(),
            "work": self.work,
            "revision": parent.revision,
            "target": parent.target.to_value(),
            "body": self.body,
            "details": self.responder.details(&self.parent_id),
            "seen_at": Value::Null,
            "received_at": received_at.rfc3339(),
            "channel": "hosted",
            "reader_name": Value::Null,
            "publish_name": false,
            "clarification_consent": false,
        });
        if row["details"].to_string().len() > MAX_DETAILS_BYTES {
            return Err(malformed("an author response's details are too large"));
        }
        Ok(row)
    }
}

/// The columns of the parent row an answer copies.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParentRow {
    /// The passage revision the reader saw.
    pub revision: String,
    pub target: PerspectiveTarget,
}

/// Why an answer does not belong under a parent, or may not be decided.
/// The same codes the hosted function answers with.
pub const PARENT_UNAVAILABLE: &str = "parentUnavailable";
/// The responder an answer stores is not, now, the account bound to the
/// section's contributor.
pub const RESPONDER_DENIED: &str = "denied";
pub const PARENT_NOT_ATTRIBUTED: &str = "notAttributed";
pub const PARENT_RESPONDER_MISMATCH: &str = "responderMismatch";
pub const PARENT_WRONG_WORK: &str = "wrongWork";

/// What a Third Perspective must be, for an answer to stand under it: the
/// facts of its stored row, read the same way by the hosted function and the
/// inbox.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParentFacts {
    pub kind: ParticipationKind,
    pub work: String,
    pub state: ModerationState,
    pub revision: u32,
    pub approved_revision: Option<u32>,
    pub clarification_asked: Option<u32>,
    /// Whether the consent record the approval covers agreed to publish.
    pub approved_consent_publishes: bool,
    /// Whether the consent in effect now agrees to publish.
    pub current_consent_publishes: bool,
    pub retained: bool,
    pub target: PerspectiveTarget,
}

impl ParentFacts {
    /// Whether the perspective is shown to readers now, as RD12 and ADR 0111
    /// decide it: approved at its current text, the text not under a request
    /// to clarify, kept, and both consents agreeing to publish. (Whether its
    /// kind is shown on the post is the mode's question, asked of the work.)
    pub fn is_shown(&self) -> bool {
        self.retained
            && self.state == ModerationState::Approved
            && self.approved_revision == Some(self.revision)
            && self.clarification_asked != Some(self.revision)
            && self.approved_consent_publishes
            && self.current_consent_publishes
    }

    /// Check that an answer by `contributor` on `work` belongs under this
    /// perspective: it is a Third Perspective of that work, shown now, about
    /// an attributed section of that very contributor.
    pub fn check_answer(&self, work: &str, contributor: &str) -> Result<(), &'static str> {
        if self.kind != ParticipationKind::ThirdPerspective || !self.is_shown() {
            return Err(PARENT_UNAVAILABLE);
        }
        if self.work != work {
            return Err(PARENT_WRONG_WORK);
        }
        match AttributedTarget::from_perspective(&self.target) {
            Ok(Some(target)) if target.contribution == contributor => Ok(()),
            Ok(Some(_)) => Err(PARENT_RESPONDER_MISMATCH),
            _ => Err(PARENT_NOT_ATTRIBUTED),
        }
    }

    /// Read the facts from the fixture's and the hosted function's shape.
    pub fn from_value(value: &Value) -> Result<Self, AuthorResponseError> {
        let invalid = || AuthorResponseError::new("malformed", "a parent's facts are not valid");
        let number = |key: &str| {
            value[key]
                .as_u64()
                .and_then(|number| u32::try_from(number).ok())
        };
        Ok(Self {
            kind: value["kind"]
                .as_str()
                .and_then(ParticipationKind::from_id)
                .ok_or_else(invalid)?,
            work: value["work"].as_str().ok_or_else(invalid)?.to_string(),
            state: value["state"]
                .as_str()
                .and_then(ModerationState::from_id)
                .ok_or_else(invalid)?,
            revision: number("revision").ok_or_else(invalid)?,
            approved_revision: number("approvedRevision"),
            clarification_asked: number("clarificationAsked"),
            approved_consent_publishes: value["approvedConsentPublishes"] == true,
            current_consent_publishes: value["currentConsentPublishes"] == true,
            retained: value["retained"] == true,
            target: PerspectiveTarget::from_value(&value["target"]).map_err(|_| {
                AuthorResponseError::new("malformed", "a parent's target is not valid")
            })?,
        })
    }
}

/// Whether `decider` may take `action` on an answer written by `account`.
/// The one rule beyond RD12's table: nobody approves their own answer
/// (ADR 0128). Taking one's own words down stays allowed.
pub fn may_decide_answer(
    account: &str,
    decider: &str,
    action: ModerationAction,
) -> Result<(), PolicyError> {
    crate::attributed_perspective::may_decide_response(Some(account), decider, action)
}

/// One answer as the hosted inbox returns it, read back and checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedAuthorResponse {
    pub id: String,
    pub state: ModerationState,
    pub version: u64,
    pub moderated_at: Option<DateTime>,
    pub reason: Option<crate::moderation::ReasonCode>,
    pub work: String,
    /// The parent's passage revision.
    pub revision: String,
    pub target: PerspectiveTarget,
    pub body: String,
    pub parent: String,
    pub responder: StoredResponder,
    pub received_at: DateTime,
    pub approved_revision: Option<u32>,
    pub item_revision: u32,
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
    feedback: WireRecord,
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
struct WireRecord {
    version: u64,
    kind: String,
    body: String,
    details: Value,
    provenance: Value,
}

impl HostedAuthorResponse {
    /// Read one hosted item of this kind. A bad item is refused on its own,
    /// naming what is wrong and never what it holds.
    pub fn from_value(value: &Value) -> Result<Self, AuthorResponseError> {
        let invalid = |message: &str| AuthorResponseError::new("malformed", message.to_string());
        let wire: WireHosted = serde_json::from_value(value.clone())
            .map_err(|_| invalid("a hosted author response has an unknown or mistyped field"))?;
        if !is_uuid(&wire.id) {
            return Err(invalid("a hosted author response needs a UUID `id`"));
        }
        let state = ModerationState::from_id(&wire.status)
            .ok_or_else(|| invalid("a hosted author response has an unknown state"))?;
        if wire.version == 0 || wire.version > i32::MAX as u64 {
            return Err(invalid(
                "a hosted author response needs a positive `version`",
            ));
        }
        // An answer is never asked to clarify and has no consent record.
        if wire.clarification_asked.is_some()
            || wire.clarification_consent == Some(true)
            || wire.approved_consent.is_some()
        {
            return Err(invalid(
                "a hosted author response carries a reader's clarification or consent",
            ));
        }
        let reason = wire
            .reason
            .map(|reason| {
                crate::moderation::ReasonCode::from_id(&reason)
                    .ok_or_else(|| invalid("a hosted author response has an unknown reason"))
            })
            .transpose()?;
        let moderated_at = wire
            .moderated_at
            .map(|time| {
                parse_canonical_time(&time)
                    .ok_or_else(|| invalid("`moderatedAt` must be a UTC time"))
            })
            .transpose()?;
        let revision = match wire.item_revision {
            None => 1,
            Some(1) => 1,
            Some(_) => return Err(invalid("an author response is never revised")),
        };
        if wire.approved_revision.is_some_and(|approved| approved != 1) {
            return Err(invalid(
                "an author response is approved at its one revision",
            ));
        }
        let record = wire.feedback;
        if record.version != AUTHOR_RESPONSE_VERSION || record.kind != AUTHOR_RESPONSE_KIND.id() {
            return Err(invalid("a hosted author response needs format version 1"));
        }
        let Some(body) = normalize_body(&record.body).filter(|body| *body == record.body) else {
            return Err(invalid("a hosted author response needs plain text"));
        };
        let provenance = record
            .provenance
            .as_object()
            .ok_or_else(|| invalid("a hosted author response needs provenance"))?;
        let work = provenance
            .get("work")
            .and_then(Value::as_str)
            .filter(|work| is_work_path(work))
            .ok_or_else(|| invalid("a hosted author response needs a post path"))?
            .to_string();
        let passage_revision = provenance
            .get("revision")
            .and_then(Value::as_str)
            .filter(|revision| crate::passage_target::is_passage_revision(revision))
            .ok_or_else(|| invalid("a hosted author response needs a passage revision"))?
            .to_string();
        let target = PerspectiveTarget::from_value(&provenance["target"])
            .map_err(|_| invalid("a hosted author response needs a valid target"))?;
        let received_at = provenance
            .get("receivedAt")
            .and_then(Value::as_str)
            .and_then(parse_canonical_time)
            .ok_or_else(|| invalid("a hosted author response needs a UTC `receivedAt`"))?;
        let details = record
            .details
            .as_object()
            .ok_or_else(|| invalid("a hosted author response needs details"))?;
        let parent = details
            .get("parent")
            .and_then(Value::as_str)
            .filter(|parent| is_uuid(parent))
            .ok_or_else(|| invalid("a hosted author response must name its parent"))?
            .to_string();
        let responder = details
            .get("responder")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("a hosted author response must name its responder"))?;
        let binding = details
            .get("binding")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("a hosted author response must keep its binding"))?;
        let text = |object: &serde_json::Map<String, Value>, key: &str| {
            object
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| invalid("a hosted author response's responder is incomplete"))
        };
        let stored = StoredResponder {
            contributor: text(responder, "contributor")?,
            author: text(responder, "author")?,
            standing: responder
                .get("standing")
                .and_then(StoredStanding::from_value)
                .ok_or_else(|| invalid("a hosted author response has an unknown standing"))?,
            participant: text(binding, "participant")?,
            account: text(binding, "account")?,
        };
        stored
            .check()
            .map_err(|_| invalid("a hosted author response's responder is not valid"))?;
        // The answer's target must be an attributed section of its responder,
        // or it was never one a contributor could write.
        match AttributedTarget::from_perspective(&target) {
            Ok(Some(attributed)) if attributed.contribution == stored.contributor => {}
            _ => {
                return Err(invalid(
                    "a hosted author response is not about its responder's section",
                ))
            }
        }
        Ok(Self {
            id: wire.id,
            state,
            version: wire.version,
            moderated_at,
            reason,
            work,
            revision: passage_revision,
            target,
            body,
            parent,
            responder: stored,
            received_at,
            approved_revision: (state == ModerationState::Approved).then_some(revision),
            item_revision: revision,
        })
    }
}
