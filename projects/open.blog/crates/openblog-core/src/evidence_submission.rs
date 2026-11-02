//! Evidence submissions: a reader's suggested source or suggested correction
//! that also says which published claim or citation it concerns and which
//! published source, and where in it, the reader offers (ADR 0116).
//!
//! An evidence submission is B5's typed feedback ([`crate::scholarly_feedback`],
//! ADR 0079) of one of the two evidence kinds, `source-suggestion` or
//! `correction-suggestion`, with an optional `evidence` block. The block is
//! the reader's statement, never the author's reading: its claim, evidence
//! link and source ids are the site's own public identities (A4 claims and
//! evidence links, A1/A3 source identifiers and locators), checked here for
//! shape only and later only against what the site publishes
//! ([`PublishedReferences`]), so a reader's guess can never confirm that a
//! private claim or source exists. Nothing here is ever an A4 evidence link,
//! a citation, a Source Library record or a research note, and no field
//! ranks, counts or votes on a submission.
//!
//! Format version 1 (B5) has no block and is read unchanged. A submission
//! with a block is format version 2, which B5's readers refuse; version 1 is
//! still what every submission without evidence is written as, so B5's
//! records stay byte for byte as they are.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::claim_publication::PostEvidence;
use crate::claims::Relation;
use crate::date::DateTime;
use crate::feedback_provenance::FeedbackChannel;
use crate::knowledge_atlas::valid_id;
use crate::participation::ParticipationKind;
use crate::research_notes::LocatorKind;
use crate::scholarly_feedback::{
    reader_text, FeedbackError, FeedbackErrorCode, FeedbackSubmission, ScholarlyFeedback,
    MAX_SUBMISSION_JSON_BYTES,
};

/// The submission and record format version that carries an evidence block.
pub const EVIDENCE_SUBMISSION_VERSION: u64 = 2;
/// The most locators a reader may give for one offered source.
pub const MAX_OFFERED_LOCATORS: usize = 8;
/// The longest locator value or range end a reader may give.
pub const MAX_LOCATOR_VALUE_CHARS: usize = 64;
/// The most octets a stored evidence block takes, as Postgres writes a `jsonb`
/// value as text: the bound `supabase/feedback.sql` checks. Every block either
/// reader accepts fits it, so a stored block can never be refused after the
/// quota and the replay claim were spent.
pub const MAX_EVIDENCE_STORED_BYTES: usize = 4096;

/// The kinds that make an evidence submission: the reader offers a source,
/// or says the passage is wrong. They are the participation registry's own
/// `source-suggestion` and `correction-suggestion` rows (ADR 0101), so every
/// mode, quota and moderation rule of those kinds applies unchanged.
/// Questions, other interpretations and every other kind carry no evidence
/// block.
pub const EVIDENCE_KINDS: [ParticipationKind; 2] = [
    ParticipationKind::SourceSuggestion,
    ParticipationKind::CorrectionSuggestion,
];

/// Whether items of `kind` are evidence submissions.
pub fn is_evidence_kind(kind: ParticipationKind) -> bool {
    matches!(
        kind,
        ParticipationKind::SourceSuggestion | ParticipationKind::CorrectionSuggestion
    )
}

/// One position in an offered source, in the notebook's locator kinds
/// (page, folio, line, section, chapter, canonical, timestamp or an `x-`
/// kind). Reader text, never verified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OfferedLocator {
    pub kind: LocatorKind,
    pub value: String,
    pub to: Option<String>,
}

/// What a reader says about the published claims, citations and sources
/// their submission concerns. Every field is the reader's own statement.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EvidenceOffer {
    /// The id of a published claim (A4) the submission is about.
    pub claim: Option<String>,
    /// The id of a published evidence link on that claim the reader
    /// questions: a challenged citation of evidence.
    pub evidence_link: Option<String>,
    /// The id of a source the post cites that the reader questions: a
    /// challenged citation.
    pub citation: Option<String>,
    /// The id of a source the site publishes that the reader offers as
    /// evidence (a reader-suggested passage of it with `locators`).
    pub source: Option<String>,
    /// Where in `source` the reader looked.
    pub locators: Vec<OfferedLocator>,
    /// How the reader says the evidence they offer (`source` or the
    /// feedback's `details.sourceUrl`) bears on the passage or claim. The
    /// reader's reading, never the author's evidence link.
    pub stance: Option<Relation>,
}

impl EvidenceOffer {
    /// Whether the offer questions a citation: a published evidence link or
    /// a cited source.
    pub fn challenges_citation(&self) -> bool {
        self.evidence_link.is_some() || self.citation.is_some()
    }

    /// The canonical JSON of the block.
    pub fn to_value(&self) -> Value {
        let mut object = Map::new();
        let mut put = |key: &str, value: &Option<String>| {
            if let Some(value) = value {
                object.insert(key.into(), value.clone().into());
            }
        };
        put("claim", &self.claim);
        put("evidenceLink", &self.evidence_link);
        put("citation", &self.citation);
        put("source", &self.source);
        if !self.locators.is_empty() {
            let locators = self
                .locators
                .iter()
                .map(|locator| {
                    let mut item = Map::new();
                    item.insert("kind".into(), locator.kind.as_str().into());
                    item.insert("value".into(), locator.value.clone().into());
                    if let Some(to) = &locator.to {
                        item.insert("to".into(), to.clone().into());
                    }
                    Value::Object(item)
                })
                .collect();
            object.insert("locators".into(), Value::Array(locators));
        }
        if let Some(stance) = self.stance {
            object.insert("stance".into(), stance.as_str().into());
        }
        Value::Object(object)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EvidenceErrorCode {
    /// The feedback itself broke a B5 rule; see [`EvidenceError::feedback`].
    Feedback,
    TooLarge,
    Malformed,
    UnsupportedVersion,
    /// The kind is a question or another interpretation, which offer no
    /// evidence.
    NotEvidenceKind,
    /// A version 2 document without an evidence block.
    MissingEvidence,
    /// An evidence block that names nothing.
    EmptyEvidence,
    /// A claim, evidence link or source id that is not a lowercase slug.
    InvalidReference,
    LinkWithoutClaim,
    LocatorsWithoutSource,
    TooManyLocators,
    InvalidLocator,
    /// A stance with nothing offered for it to describe.
    StanceWithoutEvidence,
    /// A block whose canonical form is larger than the hosted store keeps.
    EvidenceTooLarge,
}

/// Why an evidence submission or record was refused. Messages name the
/// field and never repeat what the reader wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvidenceError {
    pub code: EvidenceErrorCode,
    /// For [`EvidenceErrorCode::Feedback`], B5's own code.
    pub feedback: Option<FeedbackErrorCode>,
    pub message: String,
}

impl EvidenceError {
    fn new(code: EvidenceErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            feedback: None,
            message: message.into(),
        }
    }
}

impl From<FeedbackError> for EvidenceError {
    fn from(error: FeedbackError) -> Self {
        Self {
            code: EvidenceErrorCode::Feedback,
            feedback: Some(error.code),
            message: error.message,
        }
    }
}

impl std::fmt::Display for EvidenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for EvidenceError {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireOffer {
    #[serde(default)]
    claim: Option<String>,
    #[serde(default)]
    evidence_link: Option<String>,
    #[serde(default)]
    citation: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    locators: Option<Vec<WireLocator>>,
    #[serde(default)]
    stance: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireLocator {
    kind: String,
    value: String,
    #[serde(default)]
    to: Option<String>,
}

fn malformed(message: &str) -> EvidenceError {
    EvidenceError::new(EvidenceErrorCode::Malformed, message)
}

/// Read and check an evidence block for a submission of `kind` whose
/// details do (or do not) include a source link. The checks run in a fixed
/// order: shape, references, link needs claim, locators, stance, emptiness.
fn read_offer(value: &Value, has_source_url: bool) -> Result<EvidenceOffer, EvidenceError> {
    if !value.is_object() {
        return Err(malformed("`evidence` must be an object"));
    }
    let wire: WireOffer = serde_json::from_value(value.clone()).map_err(|_| {
        malformed(
            "`evidence` has a field this version does not define, or a field of the wrong type",
        )
    })?;
    for (field, id) in [
        ("claim", &wire.claim),
        ("evidenceLink", &wire.evidence_link),
        ("citation", &wire.citation),
        ("source", &wire.source),
    ] {
        if id.as_deref().is_some_and(|id| !valid_id(id)) {
            return Err(EvidenceError::new(
                EvidenceErrorCode::InvalidReference,
                format!(
                    "`evidence.{field}` must be an id the site publishes: a lowercase slug of at most 64 bytes"
                ),
            ));
        }
    }
    if wire.evidence_link.is_some() && wire.claim.is_none() {
        return Err(EvidenceError::new(
            EvidenceErrorCode::LinkWithoutClaim,
            "`evidence.evidenceLink` needs the `evidence.claim` it belongs to",
        ));
    }
    let wire_locators = wire.locators.unwrap_or_default();
    if !wire_locators.is_empty() && wire.source.is_none() {
        return Err(EvidenceError::new(
            EvidenceErrorCode::LocatorsWithoutSource,
            "`evidence.locators` need the `evidence.source` they are in",
        ));
    }
    if wire_locators.len() > MAX_OFFERED_LOCATORS {
        return Err(EvidenceError::new(
            EvidenceErrorCode::TooManyLocators,
            format!("`evidence.locators` holds at most {MAX_OFFERED_LOCATORS} locators"),
        ));
    }
    let mut locators = Vec::with_capacity(wire_locators.len());
    for (index, locator) in wire_locators.into_iter().enumerate() {
        let invalid = || {
            EvidenceError::new(
                EvidenceErrorCode::InvalidLocator,
                format!(
                    "`evidence.locators[{index}]` needs a known kind (page, folio, line, section, chapter, canonical, timestamp or x-…) and a value of 1 to {MAX_LOCATOR_VALUE_CHARS} characters"
                ),
            )
        };
        let kind = LocatorKind::parse(&locator.kind).ok_or_else(invalid)?;
        let value = reader_text(&locator.value, MAX_LOCATOR_VALUE_CHARS)
            .filter(|value| !value.contains(['\n', '\r', '\t']))
            .ok_or_else(invalid)?;
        let to = locator
            .to
            .map(|to| {
                reader_text(&to, MAX_LOCATOR_VALUE_CHARS)
                    .filter(|to| !to.contains(['\n', '\r', '\t']))
                    .ok_or_else(invalid)
            })
            .transpose()?;
        locators.push(OfferedLocator { kind, value, to });
    }
    let stance = wire
        .stance
        .map(|stance| {
            Relation::ALL
                .into_iter()
                .find(|relation| relation.as_str() == stance)
                .ok_or_else(|| {
                    malformed("`evidence.stance` must be supports, contradicts or contextualizes")
                })
        })
        .transpose()?;
    if stance.is_some() && wire.source.is_none() && !has_source_url {
        return Err(EvidenceError::new(
            EvidenceErrorCode::StanceWithoutEvidence,
            "`evidence.stance` describes offered evidence: give `evidence.source` or `details.sourceUrl`",
        ));
    }
    let offer = EvidenceOffer {
        claim: wire.claim,
        evidence_link: wire.evidence_link,
        citation: wire.citation,
        source: wire.source,
        locators,
        stance,
    };
    if offer == EvidenceOffer::default() {
        return Err(EvidenceError::new(
            EvidenceErrorCode::EmptyEvidence,
            "`evidence` must name a claim, an evidence link, a citation, a source or a stance",
        ));
    }
    if stored_size(&offer.to_value()) > MAX_EVIDENCE_STORED_BYTES {
        return Err(EvidenceError::new(
            EvidenceErrorCode::EvidenceTooLarge,
            format!("`evidence` is larger than {MAX_EVIDENCE_STORED_BYTES} bytes once written out"),
        ));
    }
    Ok(offer)
}

/// The octets `value` takes as Postgres writes a `jsonb` value as text, which
/// puts a space after every `:` and `,`; strings are counted as UTF-8 with
/// JSON's escapes, as both readers canonically write them.
fn stored_size(value: &Value) -> usize {
    match value {
        Value::Object(object) => {
            2 + object
                .iter()
                .map(|(key, value)| {
                    stored_size(&Value::String(key.clone())) + 2 + stored_size(value)
                })
                .sum::<usize>()
                + 2 * object.len().saturating_sub(1)
        }
        Value::Array(items) => {
            2 + items.iter().map(stored_size).sum::<usize>() + 2 * items.len().saturating_sub(1)
        }
        other => other.to_string().len(),
    }
}

/// The version of a document, 1 or 2, or the error B5 would report.
fn read_version(value: &Value, what: &str) -> Result<u64, EvidenceError> {
    match value.get("version").and_then(Value::as_u64) {
        Some(version @ (1 | EVIDENCE_SUBMISSION_VERSION)) => Ok(version),
        Some(version) if version > EVIDENCE_SUBMISSION_VERSION => Err(EvidenceError::new(
            EvidenceErrorCode::UnsupportedVersion,
            format!(
                "this {what} is version {version}, newer than the version {EVIDENCE_SUBMISSION_VERSION} this open.blog reads"
            ),
        )),
        _ => Err(malformed(&format!("a {what} needs `version` 1 or 2"))),
    }
}

/// Split a document into its version 1 form and its evidence block,
/// refusing a block in version 1 and a version 2 document without one.
fn split(value: &Value, what: &str) -> Result<(Value, Option<Value>), EvidenceError> {
    let version = read_version(value, what)?;
    let Some(object) = value.as_object() else {
        return Err(malformed(&format!("a {what} must be an object")));
    };
    let mut plain = object.clone();
    let evidence = plain.remove("evidence");
    match (version, &evidence) {
        (1, Some(_)) => Err(malformed(&format!(
            "a version 1 {what} has no `evidence`; evidence needs version 2"
        ))),
        (2, None) => Err(EvidenceError::new(
            EvidenceErrorCode::MissingEvidence,
            format!("a version 2 {what} needs `evidence`; write it as version 1 without one"),
        )),
        _ => {
            plain.insert("version".into(), 1.into());
            Ok((Value::Object(plain), evidence))
        }
    }
}

/// What a reader sends to suggest a source or a correction, with the
/// optional evidence block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvidenceSubmission {
    /// The B5 submission: kind, work, revision seen, target, text, details,
    /// the reader's clock and their attribution choice (ADRs 0078, 0079).
    pub feedback: FeedbackSubmission,
    pub evidence: Option<EvidenceOffer>,
}

impl EvidenceSubmission {
    /// Read a submission from JSON text, as [`FeedbackSubmission::from_json`]
    /// does, accepting version 2's evidence block.
    pub fn from_json(text: &str) -> Result<Self, EvidenceError> {
        if text.len() > MAX_SUBMISSION_JSON_BYTES {
            return Err(EvidenceError::new(
                EvidenceErrorCode::TooLarge,
                format!("a feedback submission is larger than {MAX_SUBMISSION_JSON_BYTES} bytes"),
            ));
        }
        let value: Value = serde_json::from_str(text)
            .map_err(|_| malformed("a feedback submission is not valid JSON"))?;
        Self::from_value(&value)
    }

    /// Read a submission. Checks run in a fixed order: version, every B5
    /// rule in B5's order, the kind is an evidence kind, then the block.
    pub fn from_value(value: &Value) -> Result<Self, EvidenceError> {
        let (plain, evidence) = split(value, "feedback submission")?;
        let feedback = FeedbackSubmission::from_value(&plain)?;
        if !is_evidence_kind(feedback.kind.participation_kind()) {
            return Err(EvidenceError::new(
                EvidenceErrorCode::NotEvidenceKind,
                format!(
                    "a {} is not an evidence submission; only a source-suggestion or a correction-suggestion offers evidence",
                    feedback.kind.id()
                ),
            ));
        }
        let evidence = evidence
            .map(|block| read_offer(&block, feedback.details.source_url.is_some()))
            .transpose()?;
        Ok(Self { feedback, evidence })
    }

    /// Canonical JSON: version 1, exactly B5's form, without evidence;
    /// version 2 with it.
    pub fn to_value(&self) -> Value {
        with_evidence(self.feedback.to_value(), self.evidence.as_ref())
    }

    pub fn to_json(&self) -> String {
        self.to_value().to_string()
    }

    /// The record a receiver keeps, as [`FeedbackSubmission::receive`]
    /// makes it, with the evidence block beside it.
    pub fn receive(
        self,
        received_at: DateTime,
        channel: FeedbackChannel,
    ) -> Result<EvidenceRecord, EvidenceError> {
        Ok(EvidenceRecord {
            feedback: self.feedback.receive(received_at, channel)?,
            evidence: self.evidence,
        })
    }
}

fn with_evidence(mut value: Value, evidence: Option<&EvidenceOffer>) -> Value {
    if let (Some(evidence), Some(object)) = (evidence, value.as_object_mut()) {
        object.insert("version".into(), EVIDENCE_SUBMISSION_VERSION.into());
        object.insert("evidence".into(), evidence.to_value());
    }
    value
}

/// A received evidence submission: B5's record and the reader's evidence
/// block. Reader data, never research and never an author's evidence link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvidenceRecord {
    pub feedback: ScholarlyFeedback,
    pub evidence: Option<EvidenceOffer>,
}

impl EvidenceRecord {
    /// `{version, kind, body, details, provenance}` as B5 writes it, with
    /// `evidence` and version 2 when there is a block.
    pub fn to_value(&self) -> Value {
        with_evidence(self.feedback.to_value(), self.evidence.as_ref())
    }

    pub fn to_json(&self) -> String {
        self.to_value().to_string()
    }

    /// Read a stored record, checking every rule again.
    pub fn from_value(value: &Value) -> Result<Self, EvidenceError> {
        let (plain, evidence) = split(value, "feedback record")?;
        let feedback = ScholarlyFeedback::from_value(&plain)?;
        if !is_evidence_kind(feedback.kind.participation_kind()) {
            return Err(EvidenceError::new(
                EvidenceErrorCode::NotEvidenceKind,
                format!(
                    "a {} record is not an evidence submission",
                    feedback.kind.id()
                ),
            ));
        }
        let evidence = evidence
            .map(|block| read_offer(&block, feedback.details.source_url.is_some()))
            .transpose()?;
        Ok(Self { feedback, evidence })
    }

    pub fn from_json(text: &str) -> Result<Self, EvidenceError> {
        let value: Value = serde_json::from_str(text)
            .map_err(|_| malformed("a feedback record is not valid JSON"))?;
        Self::from_value(&value)
    }
}

/// What one post publishes that a reader can name: its published claims
/// with their published evidence links, and the sources it cites or its
/// published evidence uses. Built only from public output, never from the
/// private claims file or Source Library.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PublishedReferences {
    claims: BTreeMap<String, BTreeSet<String>>,
    sources: BTreeSet<String>,
}

impl PublishedReferences {
    pub fn new() -> Self {
        Self::default()
    }

    /// The claims, links and sources of a post's claim evidence projection
    /// (ADR 0075).
    pub fn from_post_evidence(post: &PostEvidence) -> Self {
        let mut references = Self::new();
        for claim in &post.claims {
            let links = claim
                .supports
                .iter()
                .chain(&claim.contradicts)
                .chain(&claim.contextualizes);
            let mut ids = BTreeSet::new();
            for link in links {
                ids.insert(link.id.clone());
                references.sources.insert(link.source.clone());
            }
            references.claims.insert(claim.id.clone(), ids);
        }
        references
    }

    /// Add a published claim and its published evidence links.
    pub fn with_claim<'a>(mut self, claim: &str, links: impl IntoIterator<Item = &'a str>) -> Self {
        self.claims
            .entry(claim.to_string())
            .or_default()
            .extend(links.into_iter().map(str::to_string));
        self
    }

    /// Add a source the post cites in its published citation notes or
    /// bibliography (ADR 0044), by its source identifier.
    pub fn with_source(mut self, source: &str) -> Self {
        self.sources.insert(source.to_string());
        self
    }

    /// Whether the post publishes this claim.
    pub fn has_claim(&self, claim: &str) -> bool {
        self.claims.contains_key(claim)
    }

    /// Whether the post publishes this evidence link on this claim.
    pub fn has_link(&self, claim: &str, link: &str) -> bool {
        self.claims
            .get(claim)
            .is_some_and(|links| links.contains(link))
    }

    /// Whether the post cites, or its published evidence uses, this source.
    pub fn has_source(&self, source: &str) -> bool {
        self.sources.contains(source)
    }

    /// Every source this post publishes, by source identifier.
    pub fn sources(&self) -> impl Iterator<Item = &str> {
        self.sources.iter().map(String::as_str)
    }

    /// Whether each reference the reader named is published. The claim,
    /// evidence link and citation are this post's; the offered `source` is
    /// one the site publishes anywhere (ADR 0116), so it is checked against
    /// `site`. A reference that is not published is shown as such and
    /// nothing more; it never says whether something private has that id.
    pub fn check(&self, offer: &EvidenceOffer, site: &SitePublishedSources) -> ReferenceReport {
        let status = |published: bool| {
            if published {
                ReferenceStatus::Published
            } else {
                ReferenceStatus::NotPublished
            }
        };
        let claim = offer.claim.as_deref();
        ReferenceReport {
            claim: claim.map(|claim| status(self.has_claim(claim))),
            evidence_link: offer
                .evidence_link
                .as_deref()
                .map(|link| status(claim.is_some_and(|claim| self.has_link(claim, link)))),
            citation: offer
                .citation
                .as_deref()
                .map(|source| status(self.has_source(source))),
            source: offer
                .source
                .as_deref()
                .map(|source| status(site.has_source(source))),
        }
    }
}

/// The sources the whole site publishes: the published claim-evidence
/// sources and the published bibliography sources of every post. A reader's
/// offered `source` need not be one this post already cites (a suggested
/// source is usually new to the post), only one the site publishes (ADR
/// 0116). Built only from public output.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SitePublishedSources {
    sources: BTreeSet<String>,
}

impl SitePublishedSources {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every post's published sources, from each post's references.
    pub fn from_posts<'a>(posts: impl IntoIterator<Item = &'a PublishedReferences>) -> Self {
        let mut site = Self::new();
        for post in posts {
            site.sources.extend(post.sources().map(str::to_string));
        }
        site
    }

    /// Add a source the site publishes, by its source identifier.
    pub fn with_source(mut self, source: &str) -> Self {
        self.sources.insert(source.to_string());
        self
    }

    /// Whether the site publishes this source anywhere.
    pub fn has_source(&self, source: &str) -> bool {
        self.sources.contains(source)
    }
}

/// Whether a reference a reader named is part of the public output.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReferenceStatus {
    Published,
    /// Not published on this post now: mistyped, withdrawn since, or never
    /// public. Which of these is never said.
    NotPublished,
}

/// The status of each reference an offer names; `None` where it names none.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReferenceReport {
    pub claim: Option<ReferenceStatus>,
    pub evidence_link: Option<ReferenceStatus>,
    pub citation: Option<ReferenceStatus>,
    pub source: Option<ReferenceStatus>,
}

impl ReferenceReport {
    /// Whether some named reference is no longer (or was never) published on
    /// the post: a stale claim or citation target. An offered `source` is not
    /// the post's own target (it is a new suggestion the post may not cite
    /// yet), so it never makes the item stale.
    pub fn any_unpublished(&self) -> bool {
        [self.claim, self.evidence_link, self.citation]
            .contains(&Some(ReferenceStatus::NotPublished))
    }
}

/// The most claims, cited sources and site sources a post's evidence choices
/// list; a post or site with more lists the first ones.
const MAX_CHOICES: usize = 500;

/// How a public source reads in a list: its title and year, or its id.
fn reference_label(reference: &crate::citations::PublicReference) -> String {
    match (&reference.title, &reference.issued) {
        (Some(title), Some(issued)) => format!("{title} ({issued})"),
        (Some(title), None) => title.clone(),
        _ => reference.key.clone(),
    }
}

impl PublishedReferences {
    /// What one post publishes, from its public output only: its published
    /// claims and their published evidence links (ADR 0075), the sources
    /// those links use and the sources its published citations cite (ADR
    /// 0048). Never the private claims file or Source Library.
    pub fn of_post(post: &crate::model::Post) -> Self {
        let mut references = post
            .claim_evidence()
            .map(Self::from_post_evidence)
            .unwrap_or_default();
        if let Some(summary) = post.citations() {
            for reference in &summary.references {
                references.sources.insert(reference.key.clone());
            }
        }
        references
    }
}

impl SitePublishedSources {
    /// Every source a site's published posts publish, as
    /// [`PublishedReferences::of_post`] reads each. A draft publishes
    /// nothing, even in a preview that loads it.
    pub fn of_site(site: &crate::model::Site) -> Self {
        let posts: Vec<PublishedReferences> = site
            .posts
            .iter()
            .filter(|post| !post.draft)
            .map(PublishedReferences::of_post)
            .collect();
        Self::from_posts(&posts)
    }
}

/// The public label of a source the site publishes: the citation text of a
/// published evidence link's source, or a published citation's title.
pub fn published_source_label(site: &crate::model::Site, id: &str) -> Option<String> {
    site.posts
        .iter()
        .filter(|post| !post.draft)
        .find_map(|post| {
            let evidence = post.claim_evidence().and_then(|evidence| {
                evidence
                    .sources
                    .iter()
                    .find(|source| source.reference.key == id)
                    .map(|source| source.text.clone())
            });
            evidence.or_else(|| {
                post.citations().and_then(|summary| {
                    summary
                        .references
                        .iter()
                        .find(|reference| reference.key == id)
                        .map(reference_label)
                })
            })
        })
}

/// What a whole site publishes about sources, read once: the ids of the sources its published
/// posts publish and their public labels. Each lookup is then a map read, so a render lists every
/// post's choices in time linear in the posts and their sources, not their square.
#[derive(Clone, Debug, Default)]
pub struct SiteReferenceIndex {
    sources: SitePublishedSources,
    labels: std::collections::BTreeMap<String, String>,
}

impl SiteReferenceIndex {
    /// Read the site's published posts once, in order: a source is labelled by the first post that
    /// publishes it, from its published evidence link (the citation text) before its published
    /// citation (title and year), exactly as [`published_source_label`] finds it.
    pub fn of_site(site: &crate::model::Site) -> Self {
        let mut labels = std::collections::BTreeMap::new();
        let mut posts = Vec::new();
        for post in site.posts.iter().filter(|post| !post.draft) {
            let mut here: std::collections::BTreeMap<&str, String> =
                std::collections::BTreeMap::new();
            if let Some(summary) = post.citations() {
                for reference in &summary.references {
                    here.entry(reference.key.as_str())
                        .or_insert_with(|| reference_label(reference));
                }
            }
            if let Some(evidence) = post.claim_evidence() {
                let mut first_of_evidence = std::collections::BTreeSet::new();
                for source in &evidence.sources {
                    if first_of_evidence.insert(source.reference.key.as_str()) {
                        here.insert(source.reference.key.as_str(), source.text.clone());
                    }
                }
            }
            for (id, label) in here {
                labels.entry(id.to_string()).or_insert(label);
            }
            posts.push(PublishedReferences::of_post(post));
        }
        Self {
            sources: SitePublishedSources::from_posts(&posts),
            labels,
        }
    }

    /// The sources the site publishes.
    pub fn sources(&self) -> &SitePublishedSources {
        &self.sources
    }

    /// The public label of a source the site publishes, if any post does.
    pub fn label(&self, id: &str) -> Option<&str> {
        self.labels.get(id).map(String::as_str)
    }
}

/// How a published evidence link's relation reads before its source.
pub(crate) fn relation_words(relation: Relation) -> &'static str {
    match relation {
        Relation::Supports => "Supported by",
        Relation::Contradicts => "Contradicted by",
        Relation::Contextualizes => "Given context by",
    }
}

/// How a reader's stance reads to an editor: the reader's statement, never a
/// finding.
pub fn stance_words(stance: Relation) -> &'static str {
    match stance {
        Relation::Supports => "The reader says it supports the passage",
        Relation::Contradicts => "The reader says it contradicts the passage",
        Relation::Contextualizes => "The reader says it gives context to the passage",
    }
}

/// A published claim's published evidence links, each with its relation, in
/// relation order and file order within one.
fn claim_links(
    claim: &crate::claim_publication::PublicClaim,
) -> impl Iterator<Item = (Relation, &crate::claim_publication::PublicEvidenceLink)> {
    [
        (Relation::Supports, &claim.supports),
        (Relation::Contradicts, &claim.contradicts),
        (Relation::Contextualizes, &claim.contextualizes),
    ]
    .into_iter()
    .flat_map(|(relation, links)| links.iter().map(move |link| (relation, link)))
}

fn link_label(
    index: &SiteReferenceIndex,
    relation: Relation,
    link: &crate::claim_publication::PublicEvidenceLink,
) -> String {
    let source = index
        .label(&link.source)
        .map_or_else(|| link.source.clone(), str::to_string);
    format!("{} {source}", relation_words(relation))
}

/// What a reader may name in a post's evidence offer, from public output
/// only (ADR 0116): the post's published claims with their published
/// evidence links, the sources the post publishes (to question a citation),
/// and the sources the whole site publishes (to offer one). Each is `{id,
/// label}`; a claim also lists its links. The form offers only these, so a
/// reader never has to guess an id and nothing private is ever listed.
pub fn reference_choices(post: &crate::model::Post, index: &SiteReferenceIndex) -> Value {
    let claims: Vec<Value> = post
        .claim_evidence()
        .map(|evidence| {
            evidence
                .claims
                .iter()
                .take(MAX_CHOICES)
                .map(|claim| {
                    let links: Vec<Value> = claim_links(claim)
                        .map(|(relation, link)| {
                            serde_json::json!({"id": link.id, "label": link_label(index, relation, link)})
                        })
                        .collect();
                    serde_json::json!({
                        "id": claim.id,
                        "label": format!("Claim {}: {}", claim.number, claim.statement),
                        "links": links,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let label = |id: &str| {
        index
            .label(id)
            .map_or_else(|| id.to_string(), str::to_string)
    };
    let cited: Vec<Value> = PublishedReferences::of_post(post)
        .sources()
        .take(MAX_CHOICES)
        .map(|id| serde_json::json!({"id": id, "label": label(id)}))
        .collect();
    let mut site_sources: Vec<(String, String)> = index
        .sources()
        .sources
        .iter()
        .map(|id| (label(id), id.clone()))
        .collect();
    site_sources.sort();
    let sources: Vec<Value> = site_sources
        .into_iter()
        .take(MAX_CHOICES)
        .map(|(label, id)| serde_json::json!({"id": id, "label": label}))
        .collect();
    serde_json::json!({"version": 1, "claims": claims, "citations": cited, "sources": sources})
}

/// An evidence offer as an editor reviews it beside the post (ADR 0116):
/// each reference the reader named, whether the post (or, for the offered
/// source, the site) publishes it now, and for a published one its public
/// label, so the editor can compare the offer with the claim or citation it
/// targets. A reference that is not published reads only as not published,
/// never as private or mistyped. `post` is the post that has the item's
/// address now, if any.
pub fn evidence_review(
    offer: &EvidenceOffer,
    post: Option<&crate::model::Post>,
    site: &crate::model::Site,
) -> Value {
    let index = SiteReferenceIndex::of_site(site);
    let published = post.map(PublishedReferences::of_post).unwrap_or_default();
    let report = published.check(offer, index.sources());
    let public = |status: Option<ReferenceStatus>| status == Some(ReferenceStatus::Published);
    let mut view = serde_json::json!({ "stale": report.any_unpublished() });
    let claim = post
        .and_then(crate::model::Post::claim_evidence)
        .zip(offer.claim.as_deref())
        .and_then(|(evidence, id)| evidence.claims.iter().find(|claim| claim.id == id))
        .filter(|_| public(report.claim));
    if let Some(id) = &offer.claim {
        let mut entry = serde_json::json!({"id": id, "published": public(report.claim)});
        if let Some(claim) = claim {
            entry["label"] = serde_json::json!(format!("Claim {}", claim.number));
            entry["statement"] = serde_json::json!(claim.statement);
            entry["url"] = serde_json::json!(claim.url);
            if let Some(quote) = &claim.quote {
                entry["quote"] = serde_json::json!(quote);
            }
            entry["links"] = Value::Array(
                claim_links(claim)
                    .map(|(relation, link)| {
                        serde_json::json!({
                            "id": link.id,
                            "relation": relation.as_str(),
                            "label": link_label(&index, relation, link),
                        })
                    })
                    .collect(),
            );
        }
        view["claim"] = entry;
    }
    if let Some(id) = &offer.evidence_link {
        let mut entry = serde_json::json!({"id": id, "published": public(report.evidence_link)});
        let link = claim
            .filter(|_| public(report.evidence_link))
            .and_then(|claim| claim_links(claim).find(|(_, link)| &link.id == id));
        if let Some((relation, link)) = link {
            entry["label"] = serde_json::json!(link_label(&index, relation, link));
        }
        view["evidenceLink"] = entry;
    }
    for (key, id, status) in [
        ("citation", &offer.citation, report.citation),
        ("source", &offer.source, report.source),
    ] {
        if let Some(id) = id {
            let mut entry = serde_json::json!({"id": id, "published": public(status)});
            if let Some(label) = index.label(id).filter(|_| public(status)) {
                entry["label"] = serde_json::json!(label);
            }
            view[key] = entry;
        }
    }
    if !offer.locators.is_empty() {
        view["locators"] = Value::Array(
            offer
                .locators
                .iter()
                .map(|locator| {
                    let mut item =
                        serde_json::json!({"kind": locator.kind.as_str(), "value": locator.value});
                    if let Some(to) = &locator.to {
                        item["to"] = serde_json::json!(to);
                    }
                    item
                })
                .collect(),
        );
    }
    if let Some(stance) = offer.stance {
        view["stance"] = serde_json::json!(stance.as_str());
        view["stanceLabel"] = serde_json::json!(stance_words(stance));
    }
    view
}
