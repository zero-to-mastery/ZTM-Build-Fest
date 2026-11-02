//! Continuing a discussion across episodes (RD15, #215 and #231, ADRs 0218 to 0225).
//!
//! A *continuation* is an editor's typed link from one approved question,
//! reflection or source suggestion to a later published work that takes it
//! up. It is an ordinary link and nothing more: a reader follows it from the
//! earlier page to the later one, and back, with no account, no script and no
//! hosted service. Everything below is pure.
//!
//! The rules this module keeps:
//!
//! - **A link, not a claim.** A continuation says the later work takes up the
//!   earlier question. It never says the submission caused the work, that its
//!   author agrees, or that the editors endorse it ([`NO_CAUSATION_NOTICE`]),
//!   and an editor's note that says so, or claims popularity, is refused.
//! - **References, not words.** The file holds ids and paths, never a
//!   reader's text, name, contact or receipt. A question or a source
//!   suggestion is never public, so its edge shows only the kind and the
//!   editor's own note.
//! - **Only what is approved.** An edge shows only while its origin is
//!   approved and both pages are published. A removed, withdrawn or deleted
//!   submission takes its edge off every page, with no placeholder
//!   ([`resolve`]); [`ContinuationsFile::forget_origin`] drops it for good.
//! - **Stable links.** Edges name pages by canonical path and a series by its
//!   slug; a renamed series follows its alias, and an unknown series drops
//!   only the series label, never the link.
//! - **Subscriptions are separate.** Off by default, never needed to follow a
//!   link, never in the static output or analytics, and never sent to: this
//!   module validates a request and models the stored record and its
//!   unsubscribe, and nothing here transmits anything ([`SubscriptionRequest`]).
//!
//! The build reads the file through `model::attach_continuations` and Admin
//! writes it (ADR 0224).

use std::collections::{BTreeMap, BTreeSet};

use blake2::{Blake2s256, Digest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::community_feature::{claims_popularity, forbidden_in_context};
use crate::escape::{attr, text};
use crate::feedback_provenance::is_work_path;
use crate::feedback_publication::is_day;
use crate::future_suggestion::Contact;
use crate::knowledge_atlas::valid_id;
use crate::moderation::ModerationState;
use crate::scholarly_feedback::is_uuid;

/// The file's name, in the content folder.
pub const CONTINUATIONS_FILE: &str = "continuations.json";
/// The version of the file format. A reader refuses a higher one.
pub const CONTINUATIONS_VERSION: u64 = 1;
/// The most edges the file holds.
pub const MAX_CONTINUATIONS: usize = 500;
/// The most edges one origin may have: one question can open many episodes.
pub const MAX_PER_ORIGIN: usize = 20;
/// The largest file accepted, before it is parsed.
pub const MAX_CONTINUATIONS_BYTES: usize = 2 * 1024 * 1024;
/// The longest editorial note, in characters.
pub const MAX_NOTE_CHARS: usize = 280;
/// The id of the section that lists where a question went; the section of what a
/// post continues has the same id with `-earlier` added, so a page with both has
/// no repeated id.
pub const CONTINUATIONS_ANCHOR: &str = "ob-continuations";

/// What every list of continuations says, always shown with it.
pub const NO_CAUSATION_NOTICE: &str = "These links connect later work to earlier questions and reflections. A link means the later work takes the topic up. It does not mean the earlier submission caused it, that its author agrees with it, or that the editors endorse it.";
/// What a subscription offer says, shown only where subscriptions are on.
pub const SUBSCRIPTION_NOTICE: &str = "Updates are optional. Every link on this page works without them. Your address is kept privately for this one purpose, is never used for analytics or shared, and you can unsubscribe at any time, which erases it.";

/// Words that say a submission caused, led to or is endorsed by the work.
const CAUSATION_WORDS: &[&str] = &[
    "caused",
    "causes",
    "inspired",
    "prompted",
    "triggered",
    "resulted",
    "endorse",
    "endorsed",
    "endorses",
    "endorsement",
    "approved",
    "validated",
    "confirmed",
    "proved",
    "proven",
    "vindicated",
    "thanks",
];
const CAUSATION_PHRASES: &[&str] = &[
    "because of",
    "thanks to",
    "as a result of",
    "in response to",
    "led to",
    "agrees with",
    "agreed with",
    "was right",
    "were right",
    "proves that",
];

// ---------------------------------------------------------------------------
// Errors

/// Why an edge, the file or a subscription request is refused. Messages name
/// the field, never what was written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContinuationError {
    InvalidId,
    InvalidOrigin,
    /// `uses-source` links a source suggestion, nothing else.
    RelationNeedsSource,
    InvalidPath,
    /// An edge from a page to itself.
    SelfLink,
    InvalidSeries,
    InvalidNote,
    /// The note claims popularity or agreement.
    PopularityClaim,
    /// The note says the submission caused or is endorsed by the work.
    CausationClaim,
    InvalidDay,
    /// The edge repeats an id, or an origin and target already linked.
    Duplicate,
    /// An origin already has [`MAX_PER_ORIGIN`] edges, or the file is full.
    TooMany,
    InvalidContact,
    /// A subscription without the reader's explicit, separate agreement.
    ConsentMissing,
    InvalidScope,
    InvalidToken,
}

impl ContinuationError {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidId => "`id` must be 1 to 64 lowercase letters, digits or hyphens",
            Self::InvalidOrigin => "`origin` must be the id of an approved submission",
            Self::RelationNeedsSource => "`uses-source` links a source suggestion only",
            Self::InvalidPath => {
                "`from` and `to` must be canonical page paths such as /posts/tides/"
            }
            Self::SelfLink => "`from` and `to` must be different pages",
            Self::InvalidSeries => "`series` must be a series slug",
            Self::InvalidNote => "`note` must be plain text of at most 280 characters",
            Self::PopularityClaim => "`note` must not claim popularity, a count or agreement",
            Self::CausationClaim => {
                "`note` must not say the submission caused or is endorsed by the work"
            }
            Self::InvalidDay => "`linked` must be a calendar day such as 2026-10-27",
            Self::Duplicate => "an edge repeats an id or an origin and target already linked",
            Self::TooMany => "a submission may have at most 20 continuations and the file 500",
            Self::InvalidContact => "`address` must be one plain e-mail address",
            Self::ConsentMissing => "a subscription needs the reader's explicit agreement",
            Self::InvalidScope => "`scope` must be a page path or a series slug",
            Self::InvalidToken => "the token is not well formed",
        }
    }
}

impl std::fmt::Display for ContinuationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ContinuationError {}

// ---------------------------------------------------------------------------
// Closed sets

/// What kind of submission a continuation starts from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OriginKind {
    Question,
    Reflection,
    SourceSuggestion,
}

impl OriginKind {
    pub fn id(self) -> &'static str {
        match self {
            Self::Question => "question",
            Self::Reflection => "reflection",
            Self::SourceSuggestion => "source-suggestion",
        }
    }

    /// The words a page uses for it, never a reader's own.
    pub fn label(self) -> &'static str {
        match self {
            Self::Question => "a reader's question",
            Self::Reflection => "a reader's reflection",
            Self::SourceSuggestion => "a reader's source suggestion",
        }
    }
}

/// How the later work relates to the earlier submission: a closed set that
/// describes the link and never its worth.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Relation {
    /// The later work takes the topic up.
    TakesUp,
    /// The later work returns to the same question.
    Revisits,
    /// The later work uses the suggested source.
    UsesSource,
}

impl Relation {
    pub fn id(self) -> &'static str {
        match self {
            Self::TakesUp => "takes-up",
            Self::Revisits => "revisits",
            Self::UsesSource => "uses-source",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        [Self::TakesUp, Self::Revisits, Self::UsesSource]
            .into_iter()
            .find(|relation| relation.id() == id)
    }

    fn later_phrase(self) -> &'static str {
        match self {
            Self::TakesUp => "Taken up in",
            Self::Revisits => "Revisited in",
            Self::UsesSource => "Source used in",
        }
    }

    fn earlier_phrase(self) -> &'static str {
        match self {
            Self::TakesUp => "Takes up",
            Self::Revisits => "Revisits",
            Self::UsesSource => "Uses a source suggested in",
        }
    }
}

// ---------------------------------------------------------------------------
// The edge

/// One continuation, as the public file stores it: ids and paths, an optional
/// editorial note and the day it was linked. No reader text, name, contact,
/// receipt, editor or time of day.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Continuation {
    pub id: String,
    pub kind: OriginKind,
    /// The id of the approved submission.
    pub origin: String,
    /// The canonical path of the page the submission was about.
    pub from: String,
    /// The canonical path of the later work.
    pub to: String,
    /// The slug of the series the later work belongs to, when it does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<String>,
    pub relation: Relation,
    /// The editor's own explanation, never the reader's words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub linked: String,
}

/// An editorial note as stored: whitespace collapsed, at most
/// [`MAX_NOTE_CHARS`] characters of plain text, no claim of popularity,
/// agreement, causation or endorsement. Blank is no note. The checks are
/// lints (ADR 0220): simple, conservative and not a judgement of the note.
pub fn normalize_note(value: &str) -> Result<Option<String>, ContinuationError> {
    let note = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if note.is_empty() {
        return Ok(None);
    }
    if note.chars().count() > MAX_NOTE_CHARS || note.chars().any(forbidden_in_context) {
        return Err(ContinuationError::InvalidNote);
    }
    if claims_popularity(&note) {
        return Err(ContinuationError::PopularityClaim);
    }
    if claims_causation(&note) {
        return Err(ContinuationError::CausationClaim);
    }
    Ok(Some(note))
}

fn claims_causation(note: &str) -> bool {
    let lower = note.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    if words.iter().any(|word| CAUSATION_WORDS.contains(word)) {
        return true;
    }
    let joined = format!(" {} ", words.join(" "));
    CAUSATION_PHRASES
        .iter()
        .any(|phrase| joined.contains(&format!(" {phrase} ")))
}

impl Continuation {
    /// Check every rule on one edge. The note is stored as it normalizes.
    pub fn validated(mut self) -> Result<Self, ContinuationError> {
        if !valid_id(&self.id) || self.id.len() > 64 {
            return Err(ContinuationError::InvalidId);
        }
        if !is_uuid(&self.origin) {
            return Err(ContinuationError::InvalidOrigin);
        }
        if !is_work_path(&self.from) || !is_work_path(&self.to) {
            return Err(ContinuationError::InvalidPath);
        }
        if self.from == self.to {
            return Err(ContinuationError::SelfLink);
        }
        if let Some(series) = &self.series {
            if !valid_id(series) || series.len() > 64 {
                return Err(ContinuationError::InvalidSeries);
            }
        }
        if self.relation == Relation::UsesSource && self.kind != OriginKind::SourceSuggestion {
            return Err(ContinuationError::RelationNeedsSource);
        }
        self.note = match &self.note {
            Some(note) => normalize_note(note)?,
            None => None,
        };
        if !is_day(&self.linked) {
            return Err(ContinuationError::InvalidDay);
        }
        Ok(self)
    }
}

// ---------------------------------------------------------------------------
// The file

/// The versioned public file, `continuations.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ContinuationsFile {
    pub items: Vec<Continuation>,
}

impl ContinuationsFile {
    /// Read the file, refusing a newer version, an unknown field or any broken
    /// rule, naming the item by position and never what it holds. Nothing is
    /// repaired or dropped.
    pub fn from_json(input: &str) -> Result<Self, String> {
        if input.len() > MAX_CONTINUATIONS_BYTES {
            return Err(format!("is larger than {MAX_CONTINUATIONS_BYTES} bytes"));
        }
        let value: Value =
            serde_json::from_str(input).map_err(|_| "is not valid JSON".to_string())?;
        match value.get("version").and_then(Value::as_u64) {
            Some(CONTINUATIONS_VERSION) => {}
            Some(version) if version > CONTINUATIONS_VERSION => {
                return Err(format!(
                    "is version {version}, newer than the version {CONTINUATIONS_VERSION} this open.blog reads"
                ))
            }
            _ => return Err("needs `version` 1".into()),
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            #[allow(dead_code)]
            version: u64,
            items: Vec<Value>,
        }
        let wire: Wire = serde_json::from_value(value)
            .map_err(|_| "needs only `version` and an `items` list".to_string())?;
        if wire.items.len() > MAX_CONTINUATIONS {
            return Err(format!(
                "has {} items; keep at most {MAX_CONTINUATIONS}",
                wire.items.len()
            ));
        }
        let mut file = Self::default();
        for (index, value) in wire.items.into_iter().enumerate() {
            let item: Continuation = serde_json::from_value(value).map_err(|_| {
                format!(
                    "item {}: has a field this version does not define or one of the wrong type",
                    index + 1
                )
            })?;
            file.add(item)
                .map_err(|error| format!("item {}: {error}", index + 1))?;
        }
        Ok(file)
    }

    /// Canonical text: items sorted by origin page, day and id, two-space
    /// indentation and a final line break.
    pub fn to_json(&self) -> String {
        let mut items: Vec<&Continuation> = self.items.iter().collect();
        items.sort_by(|a, b| (&a.from, &a.linked, &a.id).cmp(&(&b.from, &b.linked, &b.id)));
        let value = json!({
            "version": CONTINUATIONS_VERSION,
            "items": items,
        });
        let mut out = serde_json::to_string_pretty(&value).expect("continuations serialize");
        out.push('\n');
        out
    }

    pub fn get(&self, id: &str) -> Option<&Continuation> {
        self.items.iter().find(|item| item.id == id)
    }

    /// Add one edge after validating it. An id, or an origin already linked to
    /// the same page, may not repeat; one origin may open at most
    /// [`MAX_PER_ORIGIN`] continuations and the file holds at most
    /// [`MAX_CONTINUATIONS`].
    pub fn add(&mut self, item: Continuation) -> Result<(), ContinuationError> {
        let item = item.validated()?;
        if self.items.iter().any(|other| {
            other.id == item.id || (other.origin == item.origin && other.to == item.to)
        }) {
            return Err(ContinuationError::Duplicate);
        }
        let for_origin = self
            .items
            .iter()
            .filter(|o| o.origin == item.origin)
            .count();
        if for_origin >= MAX_PER_ORIGIN || self.items.len() >= MAX_CONTINUATIONS {
            return Err(ContinuationError::TooMany);
        }
        self.items.push(item);
        Ok(())
    }

    /// Remove one edge by id. Returns whether it was there.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|item| item.id != id);
        before != self.items.len()
    }

    /// Drop every edge of a submission that was deleted, withdrawn or removed,
    /// and return how many went. This is the durable half of [`resolve`]'s
    /// hiding (ADR 0221).
    pub fn forget_origin(&mut self, origin: &str) -> usize {
        let before = self.items.len();
        self.items.retain(|item| item.origin != origin);
        before - self.items.len()
    }

    /// Follow a series rename: every edge that names `old` names `new`.
    pub fn rename_series(&mut self, old: &str, new: &str) -> Result<usize, ContinuationError> {
        if !valid_id(new) || new.len() > 64 {
            return Err(ContinuationError::InvalidSeries);
        }
        let mut count = 0;
        for item in &mut self.items {
            if item.series.as_deref() == Some(old) {
                item.series = Some(new.to_string());
                count += 1;
            }
        }
        Ok(count)
    }

    /// The edges that leave a page (later work on a question it was about).
    pub fn later_from(&self, from: &str) -> Vec<&Continuation> {
        self.sorted(|item| item.from == from)
    }

    /// The edges that arrive at a page (the earlier submissions it continues).
    pub fn earlier_for(&self, to: &str) -> Vec<&Continuation> {
        self.sorted(|item| item.to == to)
    }

    fn sorted(&self, keep: impl Fn(&Continuation) -> bool) -> Vec<&Continuation> {
        let mut found: Vec<&Continuation> = self.items.iter().filter(|i| keep(i)).collect();
        // By the day linked, then id: never by any measure of attention.
        found.sort_by(|a, b| (&a.linked, &a.id).cmp(&(&b.linked, &b.id)));
        found
    }
}

// ---------------------------------------------------------------------------
// Resolution: what a page may show

/// Where a submission stands now, as the moderation record or the hosted
/// store reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginStanding {
    Approved,
    /// Anything else: pending, clarifying, rejected, removed, withdrawn,
    /// deleted, or not known (a site with no hosted service).
    NotApproved,
}

impl OriginStanding {
    pub fn of(state: Option<ModerationState>) -> Self {
        match state {
            Some(ModerationState::Approved) => Self::Approved,
            _ => Self::NotApproved,
        }
    }
}

/// Why an edge is not shown. The page shows nothing in its place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hidden {
    OriginNotApproved,
    FromNotPublished,
    ToNotPublished,
}

impl Hidden {
    pub fn id(self) -> &'static str {
        match self {
            Self::OriginNotApproved => "origin-not-approved",
            Self::FromNotPublished => "from-not-published",
            Self::ToNotPublished => "to-not-published",
        }
    }
}

/// What the build knows when it resolves an edge.
pub struct Site<'a> {
    /// Canonical paths of the published pages.
    pub published: &'a BTreeSet<String>,
    /// Series slugs now in use.
    pub series: &'a BTreeSet<String>,
    /// Old series slug to current slug, for renamed series.
    pub series_aliases: &'a BTreeMap<String, String>,
}

/// An edge as a page may show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicContinuation {
    pub id: String,
    pub kind: OriginKind,
    pub relation: Relation,
    pub from: String,
    pub to: String,
    pub series: Option<String>,
    pub note: Option<String>,
    pub linked: String,
}

/// Resolve one edge: the public form only while the origin is approved and
/// both pages are published. A series that was renamed shows under its
/// current slug; one that is unknown drops the label and keeps the link.
pub fn resolve(
    edge: &Continuation,
    origin: OriginStanding,
    site: &Site<'_>,
) -> Result<PublicContinuation, Hidden> {
    if origin != OriginStanding::Approved {
        return Err(Hidden::OriginNotApproved);
    }
    if !site.published.contains(&edge.from) {
        return Err(Hidden::FromNotPublished);
    }
    if !site.published.contains(&edge.to) {
        return Err(Hidden::ToNotPublished);
    }
    let series = edge.series.as_ref().and_then(|slug| {
        if site.series.contains(slug) {
            Some(slug.clone())
        } else {
            site.series_aliases
                .get(slug)
                .filter(|current| site.series.contains(*current))
                .cloned()
        }
    });
    Ok(PublicContinuation {
        id: edge.id.clone(),
        kind: edge.kind,
        relation: edge.relation,
        from: edge.from.clone(),
        to: edge.to.clone(),
        series,
        note: edge.note.clone(),
        linked: edge.linked.clone(),
    })
}

/// Which end of the link a section is on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    /// On the earlier page: where the question went.
    Later,
    /// On the later page: what it continues.
    Earlier,
}

/// The id of one list item.
pub fn item_anchor(id: &str) -> String {
    format!("ob-continuation-{id}")
}

/// The static section for one page: a labelled region with the notice and a
/// list of ordinary links, an empty string when there is nothing to show. It
/// needs no script and carries no subscription, count or reader text.
/// `titles` maps a path to the page's title; a page without one shows its
/// path as text.
pub fn render_section(
    direction: Direction,
    items: &[PublicContinuation],
    titles: &BTreeMap<String, String>,
) -> String {
    if items.is_empty() {
        return String::new();
    }
    let (heading, anchor) = match direction {
        Direction::Later => ("Where this question went", CONTINUATIONS_ANCHOR.to_string()),
        Direction::Earlier => (
            "Earlier questions this continues",
            format!("{CONTINUATIONS_ANCHOR}-earlier"),
        ),
    };
    let mut out = format!(
        "<section id=\"{anchor}\" class=\"ob-continuations\" aria-labelledby=\"{anchor}-heading\">\n<h2 id=\"{anchor}-heading\">{heading}</h2>\n<p>{}</p>\n<ul>\n",
        text(NO_CAUSATION_NOTICE)
    );
    for item in items {
        let (path, phrase) = match direction {
            Direction::Later => (&item.to, item.relation.later_phrase()),
            Direction::Earlier => (&item.from, item.relation.earlier_phrase()),
        };
        let title = titles.get(path).map(String::as_str).unwrap_or(path);
        out.push_str(&format!(
            "<li id=\"{}\">{} <a href=\"{}\">{}</a>",
            attr(&item_anchor(&item.id)),
            text(phrase),
            attr(path),
            text(title)
        ));
        if direction == Direction::Earlier {
            out.push_str(&format!(" ({})", text(item.kind.label())));
        }
        if let Some(series) = &item.series {
            out.push_str(&format!(", in the series {}", text(series)));
        }
        if let Some(note) = &item.note {
            out.push_str(&format!(". {}", text(note)));
        }
        out.push_str("</li>\n");
    }
    out.push_str("</ul>\n</section>\n");
    out
}

// ---------------------------------------------------------------------------
// Optional updates

/// How a page offers updates. Subscriptions are off unless a site turns them
/// on, and a site with no hosted service offers only links.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Offer {
    /// Nothing but the ordinary links: the baseline.
    LinkOnly,
    /// A form that asks for an address, with [`SUBSCRIPTION_NOTICE`].
    Form,
}

/// The offer a page makes. Both the setting and a reachable hosted service are
/// needed; either missing falls back to links (ADR 0222).
pub fn offer(enabled: bool, hosted_available: bool) -> Offer {
    if enabled && hosted_available {
        Offer::Form
    } else {
        Offer::LinkOnly
    }
}

/// What a subscription follows: later work on one page's questions, or on one
/// series. Never a person, never a topic across sites.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "kebab-case")]
pub enum Scope {
    Page(String),
    Series(String),
}

impl Scope {
    fn validate(&self) -> Result<(), ContinuationError> {
        let ok = match self {
            Self::Page(path) => is_work_path(path),
            Self::Series(slug) => valid_id(slug) && slug.len() <= 64,
        };
        ok.then_some(()).ok_or(ContinuationError::InvalidScope)
    }
}

/// What a reader sends to subscribe: the scope, an address and a separate,
/// explicit agreement. Unknown fields are refused, so no analytics or
/// tracking field can ride along.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRequest {
    scope: Scope,
    address: String,
    agree: bool,
}

/// A validated request. The address is private and never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct SubscriptionRequest {
    scope: Scope,
    contact: Contact,
}

impl std::fmt::Debug for SubscriptionRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SubscriptionRequest")
            .field("scope", &self.scope)
            .field("contact", &"<private>")
            .finish()
    }
}

impl SubscriptionRequest {
    /// Parse and validate a submission.
    pub fn parse(input: &str) -> Result<Self, ContinuationError> {
        if input.len() > 2 * 1024 {
            return Err(ContinuationError::InvalidContact);
        }
        let wire: WireRequest =
            serde_json::from_str(input).map_err(|_| ContinuationError::InvalidScope)?;
        if !wire.agree {
            return Err(ContinuationError::ConsentMissing);
        }
        wire.scope.validate()?;
        let contact = Contact::new(&wire.address).map_err(|_| ContinuationError::InvalidContact)?;
        Ok(Self {
            scope: wire.scope,
            contact,
        })
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    /// The scope and the private contact, for the service that stores them.
    pub(crate) fn into_parts(self) -> (Scope, Contact) {
        (self.scope, self.contact)
    }
}

/// Whether a subscription is live.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubscriptionState {
    Active,
    /// The reader unsubscribed or deleted it: the address is gone.
    Ended,
}

/// The stored record. It keeps the address only while active, and a digest of
/// the unsubscribe token, never the token. It has no `Serialize`: it cannot be
/// written to a page, a feed or an analytics event by accident.
#[derive(Clone, PartialEq, Eq)]
pub struct Subscription {
    id: String,
    scope: Scope,
    contact: Option<Contact>,
    token_digest: String,
    created: String,
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscription")
            .field("id", &self.id)
            .field("scope", &self.scope)
            .field("state", &self.state())
            .finish()
    }
}

/// An unsubscribe token: 32 to 128 URL-safe characters, made by the hosted
/// service from a secure random source and sent only to the reader.
pub fn is_token(value: &str) -> bool {
    (32..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The digest a record keeps in place of the token.
pub fn token_digest(token: &str) -> String {
    let mut hasher = Blake2s256::new();
    hasher.update(b"openblog-continuation-unsubscribe-v1\0");
    hasher.update((token.len() as u64).to_be_bytes());
    hasher.update(token.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl Subscription {
    /// Start a subscription from a validated request. The service supplies the
    /// id, the token and the day; nothing is sent.
    pub fn start(
        request: SubscriptionRequest,
        id: &str,
        token: &str,
        created: &str,
    ) -> Result<Self, ContinuationError> {
        if !is_uuid(id) {
            return Err(ContinuationError::InvalidId);
        }
        if !is_token(token) {
            return Err(ContinuationError::InvalidToken);
        }
        if !is_day(created) {
            return Err(ContinuationError::InvalidDay);
        }
        Ok(Self {
            id: id.to_string(),
            scope: request.scope,
            contact: Some(request.contact),
            token_digest: token_digest(token),
            created: created.to_string(),
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    pub fn created(&self) -> &str {
        &self.created
    }

    pub fn state(&self) -> SubscriptionState {
        if self.contact.is_some() {
            SubscriptionState::Active
        } else {
            SubscriptionState::Ended
        }
    }

    /// The address, for the one hosted function that sends an update. `None`
    /// once ended.
    pub fn address(&self) -> Option<&str> {
        self.contact.as_ref().map(Contact::address)
    }

    /// Unsubscribe with the token from the reader's own link. A wrong token
    /// changes nothing. Success erases the address and is idempotent.
    pub fn unsubscribe(&mut self, token: &str) -> bool {
        if !is_token(token) || token_digest(token) != self.token_digest {
            return false;
        }
        self.contact = None;
        true
    }

    /// Delete on request or on retention: the address goes whatever the token.
    pub fn erase(&mut self) {
        self.contact = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID: &str = "11111111-2222-4333-8444-555555555555";
    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-";

    fn edge(id: &str, to: &str) -> Continuation {
        Continuation {
            id: id.into(),
            kind: OriginKind::Question,
            origin: UUID.into(),
            from: "/posts/tides/".into(),
            to: to.into(),
            series: Some("sea".into()),
            relation: Relation::TakesUp,
            note: Some("The next episode starts from the question of the moon.".into()),
            linked: "2026-10-27".into(),
        }
    }

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn one_question_can_open_many_continuations_and_each_pair_links_once() {
        let mut file = ContinuationsFile::default();
        file.add(edge("a", "/posts/moon/")).unwrap();
        file.add(edge("b", "/posts/sun/")).unwrap();
        assert_eq!(file.later_from("/posts/tides/").len(), 2);
        assert_eq!(
            file.add(edge("c", "/posts/moon/")),
            Err(ContinuationError::Duplicate)
        );
        assert_eq!(
            file.add(edge("a", "/posts/wind/")),
            Err(ContinuationError::Duplicate)
        );
        assert_eq!(file.earlier_for("/posts/moon/").len(), 1);
    }

    #[test]
    fn a_note_may_not_claim_cause_endorsement_or_popularity() {
        for note in [
            "This was inspired by a reader",
            "Written because of that question",
            "The editors endorse the answer",
            "A popular question",
            "Led to this episode",
        ] {
            assert!(normalize_note(note).is_err(), "{note}");
        }
        assert_eq!(normalize_note("   ").unwrap(), None);
        assert_eq!(
            normalize_note("Takes up  the\nquestion")
                .unwrap()
                .as_deref(),
            Some("Takes up the question")
        );
    }

    #[test]
    fn invalid_links_are_refused() {
        let bad = edge("a", "/posts/tides/");
        assert_eq!(bad.validated(), Err(ContinuationError::SelfLink));
        let mut bad = edge("a", "/posts/moon/");
        bad.to = "https://example.org/".into();
        assert_eq!(bad.validated(), Err(ContinuationError::InvalidPath));
        let mut bad = edge("a", "/posts/moon/");
        bad.origin = "nope".into();
        assert_eq!(bad.validated(), Err(ContinuationError::InvalidOrigin));
        let mut bad = edge("a", "/posts/moon/");
        bad.relation = Relation::UsesSource;
        assert_eq!(bad.validated(), Err(ContinuationError::RelationNeedsSource));
        let mut bad = edge("a", "/posts/moon/");
        bad.linked = "2026-02-30".into();
        assert_eq!(bad.validated(), Err(ContinuationError::InvalidDay));
    }

    #[test]
    fn a_removed_submission_takes_its_edge_off_every_page() {
        let published = set(&["/posts/tides/", "/posts/moon/"]);
        let series = set(&["sea"]);
        let aliases = BTreeMap::new();
        let site = Site {
            published: &published,
            series: &series,
            series_aliases: &aliases,
        };
        let e = edge("a", "/posts/moon/");
        assert!(resolve(&e, OriginStanding::Approved, &site).is_ok());
        for state in [
            None,
            Some(ModerationState::Removed),
            Some(ModerationState::Withdrawn),
            Some(ModerationState::Pending),
        ] {
            assert_eq!(
                resolve(&e, OriginStanding::of(state), &site),
                Err(Hidden::OriginNotApproved)
            );
        }
        let mut file = ContinuationsFile::default();
        file.add(e).unwrap();
        assert_eq!(file.forget_origin(UUID), 1);
        assert!(file.items.is_empty());
    }

    #[test]
    fn unpublished_pages_hide_the_edge() {
        let published = set(&["/posts/tides/"]);
        let none = BTreeSet::new();
        let aliases = BTreeMap::new();
        let site = Site {
            published: &published,
            series: &none,
            series_aliases: &aliases,
        };
        assert_eq!(
            resolve(&edge("a", "/posts/moon/"), OriginStanding::Approved, &site),
            Err(Hidden::ToNotPublished)
        );
    }

    #[test]
    fn a_renamed_series_follows_its_alias_and_an_unknown_one_keeps_the_link() {
        let published = set(&["/posts/tides/", "/posts/moon/"]);
        let series = set(&["ocean"]);
        let aliases: BTreeMap<String, String> = [("sea".to_string(), "ocean".to_string())].into();
        let site = Site {
            published: &published,
            series: &series,
            series_aliases: &aliases,
        };
        let e = edge("a", "/posts/moon/");
        let shown = resolve(&e, OriginStanding::Approved, &site).unwrap();
        assert_eq!(shown.series.as_deref(), Some("ocean"));
        let none = BTreeMap::new();
        let site = Site {
            published: &published,
            series: &series,
            series_aliases: &none,
        };
        let shown = resolve(&e, OriginStanding::Approved, &site).unwrap();
        assert_eq!(shown.series, None);
        assert_eq!(shown.to, "/posts/moon/");

        let mut file = ContinuationsFile::default();
        file.add(e).unwrap();
        assert_eq!(file.rename_series("sea", "ocean").unwrap(), 1);
        assert_eq!(file.items[0].series.as_deref(), Some("ocean"));
    }

    #[test]
    fn the_file_round_trips_canonically_and_reads_strictly() {
        let mut file = ContinuationsFile::default();
        file.add(edge("b", "/posts/sun/")).unwrap();
        file.add(edge("a", "/posts/moon/")).unwrap();
        let written = file.to_json();
        assert!(!written.contains('\r') && written.ends_with("}\n"));
        let back = ContinuationsFile::from_json(&written).unwrap();
        assert_eq!(back.to_json(), written);

        let extra = written.replace("\"kind\"", "\"contact\": \"a@b.org\", \"kind\"");
        let error = ContinuationsFile::from_json(&extra).unwrap_err();
        assert!(error.starts_with("item "), "{error}");
        assert!(!error.contains("a@b.org") && !error.contains("contact"));
        assert!(ContinuationsFile::from_json("{\"version\":2,\"items\":[]}").is_err());
        assert!(ContinuationsFile::from_json("{\"version\":1,\"items\":[],\"x\":1}").is_err());
        let twice = format!(
            "{{\"version\":1,\"items\":[{0},{0}]}}",
            serde_json::to_string(&edge("a", "/posts/moon/")).unwrap()
        );
        assert!(ContinuationsFile::from_json(&twice).is_err());
    }

    #[test]
    fn the_section_is_ordinary_escaped_links_with_the_notice_and_nothing_private() {
        let published = set(&["/posts/tides/", "/posts/moon/"]);
        let series = set(&["sea"]);
        let aliases = BTreeMap::new();
        let site = Site {
            published: &published,
            series: &series,
            series_aliases: &aliases,
        };
        let shown = resolve(&edge("a", "/posts/moon/"), OriginStanding::Approved, &site).unwrap();
        let titles: BTreeMap<String, String> =
            [("/posts/moon/".to_string(), "The <Moon>".to_string())].into();
        let html = render_section(Direction::Later, std::slice::from_ref(&shown), &titles);
        assert!(html.contains("<a href=\"/posts/moon/\">The &lt;Moon&gt;</a>"));
        assert!(html.contains("aria-labelledby"));
        assert!(html.contains(&text(NO_CAUSATION_NOTICE)));
        assert!(!html.contains(UUID) && !html.contains("<form") && !html.contains("<script"));
        let earlier = render_section(Direction::Earlier, std::slice::from_ref(&shown), &titles);
        assert!(earlier.contains("reader") && earlier.contains("question"));
        assert_eq!(render_section(Direction::Later, &[], &titles), "");
    }

    #[test]
    fn updates_are_links_only_unless_turned_on_and_hosted() {
        assert_eq!(offer(false, true), Offer::LinkOnly);
        assert_eq!(offer(true, false), Offer::LinkOnly);
        assert_eq!(offer(true, true), Offer::Form);
    }

    fn request(agree: bool, address: &str) -> String {
        json!({"scope": {"type": "series", "value": "sea"}, "address": address, "agree": agree})
            .to_string()
    }

    #[test]
    fn a_subscription_needs_explicit_agreement_a_plain_address_and_no_extra_fields() {
        assert_eq!(
            SubscriptionRequest::parse(&request(false, "a@example.org")).unwrap_err(),
            ContinuationError::ConsentMissing
        );
        assert_eq!(
            SubscriptionRequest::parse(&request(true, "not an address")).unwrap_err(),
            ContinuationError::InvalidContact
        );
        let tracked = r#"{"scope":{"type":"page","value":"/posts/tides/"},"address":"a@example.org","agree":true,"utm":"x"}"#;
        assert!(SubscriptionRequest::parse(tracked).is_err());
        let ok = SubscriptionRequest::parse(&request(true, "a@example.org")).unwrap();
        assert!(!format!("{ok:?}").contains("example.org"));
    }

    #[test]
    fn unsubscribing_erases_the_address_and_a_wrong_token_does_nothing() {
        let request = SubscriptionRequest::parse(&request(true, "a@example.org")).unwrap();
        let mut sub = Subscription::start(request, UUID, TOKEN, "2026-10-27").unwrap();
        assert_eq!(sub.address(), Some("a@example.org"));
        assert!(!format!("{sub:?}").contains("example.org"));
        assert!(!format!("{sub:?}").contains(TOKEN));
        assert!(!sub.unsubscribe("wrong-token-wrong-token-wrong-token-1"));
        assert_eq!(sub.state(), SubscriptionState::Active);
        assert!(sub.unsubscribe(TOKEN));
        assert_eq!(sub.state(), SubscriptionState::Ended);
        assert_eq!(sub.address(), None);
        assert!(sub.unsubscribe(TOKEN));
    }

    #[test]
    fn deletion_erases_without_a_token() {
        let request = SubscriptionRequest::parse(&request(true, "a@example.org")).unwrap();
        let mut sub = Subscription::start(request, UUID, TOKEN, "2026-10-27").unwrap();
        sub.erase();
        assert_eq!(sub.address(), None);
    }

    #[test]
    fn the_token_is_stored_only_as_a_digest() {
        assert!(is_token(TOKEN) && !is_token("short") && !is_token(&format!("{TOKEN}!")));
        assert_eq!(token_digest(TOKEN).len(), 64);
        assert_ne!(
            token_digest(TOKEN),
            token_digest("another-token-another-token-another")
        );
    }
}
