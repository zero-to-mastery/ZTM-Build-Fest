//! One moderation state machine for every participation kind (ADRs 0102 to
//! 0104).
//!
//! Every item a reader or an author adds (see [`crate::participation`])
//! starts [`ModerationState::Pending`], whoever sent it. Only an approval of
//! the item's current revision makes it public, and only while its kind is
//! shown on its post. A request for clarification never publishes the text it
//! asks about: the submitter's answer replaces it as a new revision that goes
//! back to pending. Removal, withdrawal, rejection and expiry are distinct,
//! private states, and every change carries an [`AuditEvent`] that names who
//! acted, when, why and on which revision, never what anyone wrote.
//!
//! The policy is pure: callers build [`ItemFacts`] from the stored item and
//! resolve the [`Actor`] with [`SharedWorks::actor`] from the authenticated
//! session or the hosted moderation token, the shared-publication records and
//! the loaded site, then apply the returned [`Transition`] and its audit
//! event in one write, and treat any error as "nothing changed". Every
//! combination the rules do not list is denied.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::attributed_perspective::AttributedTarget;
use crate::collaboration::{
    AuthorizationAction, AuthorizationRole, AuthorizationTarget, SharedPublication,
};
use crate::config::SiteConfig;
use crate::date::DateTime;
use crate::invitation::Identities;
use crate::model::Site;
use crate::participation::{Origin, ParticipationKind, ParticipationMode, TargetShape};
use crate::third_perspective::PerspectiveTarget;

const DAY_SECONDS: i64 = 86_400;
/// The longest retention period accepted, in days (about ten years).
pub const MAX_RETENTION_DAYS: u32 = 3_650;

/// Where an item is in moderation. Only `Approved` can ever be public.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ModerationState {
    /// Received and waiting for a moderator. Never public.
    Pending,
    /// A moderator asked the submitter to clarify. Never public, and the text
    /// it asks about can never be approved, now or after a reopening.
    Clarification,
    /// Accepted. Public while its kind is publishable and shown on its post.
    Approved,
    /// Declined, by a moderator or by expiry. Never public.
    Rejected,
    /// Taken down after approval. Never public again unless re-approved.
    Removed,
    /// Taken back by its submitter. Never public, never reopened.
    Withdrawn,
}

impl ModerationState {
    pub const ALL: [ModerationState; 6] = [
        ModerationState::Pending,
        ModerationState::Clarification,
        ModerationState::Approved,
        ModerationState::Rejected,
        ModerationState::Removed,
        ModerationState::Withdrawn,
    ];

    /// The stored id, the shape ADR 0080's `status` column (hosted feedback table) accepts.
    pub fn id(self) -> &'static str {
        match self {
            ModerationState::Pending => "pending",
            ModerationState::Clarification => "clarification",
            ModerationState::Approved => "approved",
            ModerationState::Rejected => "rejected",
            ModerationState::Removed => "removed",
            ModerationState::Withdrawn => "withdrawn",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|state| state.id() == id)
    }

    /// A label for moderators.
    pub fn label(self) -> &'static str {
        match self {
            ModerationState::Pending => "Pending",
            ModerationState::Clarification => "Waiting for clarification",
            ModerationState::Approved => "Approved",
            ModerationState::Rejected => "Rejected",
            ModerationState::Removed => "Removed",
            ModerationState::Withdrawn => "Withdrawn",
        }
    }

    /// Whether moderation is over for the item.
    pub fn is_closed(self) -> bool {
        matches!(
            self,
            ModerationState::Rejected | ModerationState::Removed | ModerationState::Withdrawn
        )
    }

    /// The value the existing `openblog_comments.status` column can hold
    /// (`pending`, `approved` or `rejected`) until an additive migration
    /// widens it. Every state that is not public maps to a value that is not
    /// public; comments never reach `Clarification` (they carry no consent)
    /// or `Withdrawn` (they have no submitter receipt).
    pub fn legacy_comment_status(self) -> &'static str {
        match self {
            ModerationState::Pending | ModerationState::Clarification => "pending",
            ModerationState::Approved => "approved",
            ModerationState::Rejected | ModerationState::Removed | ModerationState::Withdrawn => {
                "rejected"
            }
        }
    }

    /// Read a stored comment status. Anything else is unknown, and an
    /// unknown state is never public.
    pub fn from_legacy_comment_status(status: &str) -> Option<Self> {
        match status {
            "pending" => Some(ModerationState::Pending),
            "approved" => Some(ModerationState::Approved),
            "rejected" => Some(ModerationState::Rejected),
            _ => None,
        }
    }
}

/// A change someone asks for on an existing item. Creating an item is
/// [`ModerationPolicy::admit`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ModerationAction {
    /// Pending to approved, binding the approval to the current revision.
    /// Refused while the current revision is one a clarification request
    /// asked about.
    Approve,
    /// Pending or clarification to rejected, with a reason.
    Reject,
    /// Pending to clarification, with a reason, when the submitter consented
    /// to be asked.
    RequestClarification,
    /// The submitter's answer: clarification to pending as a new revision
    /// that replaces the text asked about.
    Clarify,
    /// Approved to removed, with a reason.
    Remove,
    /// Rejected or removed back to pending, while the text is still kept. An
    /// item whose current revision a clarification request asked about (it
    /// was rejected or expired before the submitter answered) returns to
    /// clarification instead, so only an answer can make it approvable.
    Reopen,
    /// The submitter takes the item back from pending, clarification or
    /// approved.
    Withdraw,
    /// Retention: pending or clarification to rejected once its period ends.
    Expire,
    /// An abuse report is upheld: the report is approved (never public) and
    /// the reported item, if still approved, is removed in the same decision.
    UpholdReport,
}

impl ModerationAction {
    pub const ALL: [ModerationAction; 9] = [
        ModerationAction::Approve,
        ModerationAction::Reject,
        ModerationAction::RequestClarification,
        ModerationAction::Clarify,
        ModerationAction::Remove,
        ModerationAction::Reopen,
        ModerationAction::Withdraw,
        ModerationAction::Expire,
        ModerationAction::UpholdReport,
    ];

    pub fn id(self) -> &'static str {
        match self {
            ModerationAction::Approve => "approve",
            ModerationAction::Reject => "reject",
            ModerationAction::RequestClarification => "request-clarification",
            ModerationAction::Clarify => "clarify",
            ModerationAction::Remove => "remove",
            ModerationAction::Reopen => "reopen",
            ModerationAction::Withdraw => "withdraw",
            ModerationAction::Expire => "expire",
            ModerationAction::UpholdReport => "uphold-report",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|action| action.id() == id)
    }

    /// A label for moderators.
    pub fn label(self) -> &'static str {
        match self {
            ModerationAction::Approve => "Approve",
            ModerationAction::Reject => "Reject",
            ModerationAction::RequestClarification => "Ask to clarify",
            ModerationAction::Clarify => "Clarify",
            ModerationAction::Remove => "Remove from the post",
            ModerationAction::Reopen => "Reopen",
            ModerationAction::Withdraw => "Withdraw",
            ModerationAction::Expire => "Expire",
            ModerationAction::UpholdReport => "Uphold the report",
        }
    }
}

impl Serialize for ModerationState {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.id())
    }
}

impl<'de> Deserialize<'de> for ModerationState {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let id = String::deserialize(deserializer)?;
        Self::from_id(&id).ok_or_else(|| serde::de::Error::custom("unknown moderation state"))
    }
}

/// Why a moderator acted. Reasons describe moderation grounds, never a
/// factual verdict: there is no "incorrect" or "misinformation" code, and a
/// rejected suggested correction is not thereby wrong.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ReasonCode {
    Spam,
    Abusive,
    PersonalData,
    OffTopic,
    Duplicate,
    Rights,
    Unclear,
    NeedsSource,
    /// An abuse report needs no action.
    NoAction,
    Other,
    /// Set by the policy on an item removed because a report was upheld.
    UpheldReport,
    /// Set by the policy when retention ends a pending or clarification item.
    Expired,
}

impl ReasonCode {
    pub const ALL: [ReasonCode; 12] = [
        ReasonCode::Spam,
        ReasonCode::Abusive,
        ReasonCode::PersonalData,
        ReasonCode::OffTopic,
        ReasonCode::Duplicate,
        ReasonCode::Rights,
        ReasonCode::Unclear,
        ReasonCode::NeedsSource,
        ReasonCode::NoAction,
        ReasonCode::Other,
        ReasonCode::UpheldReport,
        ReasonCode::Expired,
    ];

    pub fn id(self) -> &'static str {
        match self {
            ReasonCode::Spam => "spam",
            ReasonCode::Abusive => "abusive",
            ReasonCode::PersonalData => "personal-data",
            ReasonCode::OffTopic => "off-topic",
            ReasonCode::Duplicate => "duplicate",
            ReasonCode::Rights => "rights",
            ReasonCode::Unclear => "unclear",
            ReasonCode::NeedsSource => "needs-source",
            ReasonCode::NoAction => "no-action",
            ReasonCode::Other => "other",
            ReasonCode::UpheldReport => "upheld-report",
            ReasonCode::Expired => "expired",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|reason| reason.id() == id)
    }

    /// A label for moderators. It names a ground, never a verdict.
    pub fn label(self) -> &'static str {
        match self {
            ReasonCode::Spam => "Spam",
            ReasonCode::Abusive => "Abusive",
            ReasonCode::PersonalData => "Contains personal data",
            ReasonCode::OffTopic => "Off topic",
            ReasonCode::Duplicate => "Duplicate",
            ReasonCode::Rights => "Rights or permission problem",
            ReasonCode::Unclear => "Unclear",
            ReasonCode::NeedsSource => "Needs a source",
            ReasonCode::NoAction => "No action needed",
            ReasonCode::Other => "Other",
            ReasonCode::UpheldReport => "An abuse report was upheld",
            ReasonCode::Expired => "Expired without a decision",
        }
    }
}

const DECLINE_REASONS: &[ReasonCode] = &[
    ReasonCode::Spam,
    ReasonCode::Abusive,
    ReasonCode::PersonalData,
    ReasonCode::OffTopic,
    ReasonCode::Duplicate,
    ReasonCode::Rights,
    ReasonCode::Other,
];
const DISMISS_REPORT_REASONS: &[ReasonCode] = &[
    ReasonCode::NoAction,
    ReasonCode::Duplicate,
    ReasonCode::Spam,
    ReasonCode::Other,
];
const CLARIFICATION_REASONS: &[ReasonCode] = &[
    ReasonCode::Unclear,
    ReasonCode::NeedsSource,
    ReasonCode::PersonalData,
    ReasonCode::Other,
];
const UPHOLD_REASONS: &[ReasonCode] = &[
    ReasonCode::Spam,
    ReasonCode::Abusive,
    ReasonCode::PersonalData,
    ReasonCode::OffTopic,
    ReasonCode::Rights,
    ReasonCode::Other,
];

/// The reasons a request may give for `action` on `kind`; empty means the
/// request must give none.
pub fn allowed_reasons(action: ModerationAction, kind: ParticipationKind) -> &'static [ReasonCode] {
    match action {
        ModerationAction::Reject if kind == ParticipationKind::AbuseReport => {
            DISMISS_REPORT_REASONS
        }
        ModerationAction::Reject | ModerationAction::Remove => DECLINE_REASONS,
        ModerationAction::RequestClarification => CLARIFICATION_REASONS,
        ModerationAction::UpholdReport => UPHOLD_REASONS,
        ModerationAction::Approve
        | ModerationAction::Clarify
        | ModerationAction::Reopen
        | ModerationAction::Withdraw
        | ModerationAction::Expire => &[],
    }
}

/// Who is asking, as established by the server. Identifiers name Admin
/// accounts for the private audit trail; readers are never identified.
///
/// Admin users have no site roles (ADR 0006: every Admin user edits
/// everything), so an Admin session's actor depends on the work it acts on:
/// [`SharedWorks::actor`] is the one resolver, and callers never build an
/// Admin actor from a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Actor<'a> {
    /// Anyone, through the public submission path. Also an Admin session on a
    /// shared work where its binding grants nothing here (editor or reader
    /// only, or a binding that no longer resolves): it sees what readers see
    /// and moderates nothing.
    Public,
    /// The item's own submitter, proven by the server (a reader's private
    /// receipt, or the author's session for an author response).
    Submitter,
    /// The site's Admin: the hosted moderation token, or an Admin session
    /// acting on a work that is not part of any shared publication in which
    /// that account holds a binding. The only actor besides the submitter
    /// that sees a reader's private identity.
    SiteAdmin { admin_user: &'a str },
    /// An Admin session bound as coordinator or site owner in a shared
    /// publication, acting on that publication's works, which are `works`.
    /// A publication's site owner is a coordinator here, never the site Admin.
    Coordinator {
        admin_user: &'a str,
        works: &'a [&'a str],
    },
    /// An Admin session bound as contributor (and not coordinator or site
    /// owner) in a shared publication, acting on that publication's works.
    ContributingAuthor {
        admin_user: &'a str,
        works: &'a [&'a str],
    },
    /// The retention job.
    System,
}

/// An actor's role as the audit trail records it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ActorRole {
    Public,
    Submitter,
    SiteAdmin,
    Coordinator,
    ContributingAuthor,
    System,
}

impl ActorRole {
    pub const ALL: [ActorRole; 6] = [
        ActorRole::Public,
        ActorRole::Submitter,
        ActorRole::SiteAdmin,
        ActorRole::Coordinator,
        ActorRole::ContributingAuthor,
        ActorRole::System,
    ];

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|role| role.id() == id)
    }

    pub fn id(self) -> &'static str {
        match self {
            ActorRole::Public => "public",
            ActorRole::Submitter => "submitter",
            ActorRole::SiteAdmin => "site-admin",
            ActorRole::Coordinator => "coordinator",
            ActorRole::ContributingAuthor => "contributing-author",
            ActorRole::System => "system",
        }
    }
}

impl Actor<'_> {
    pub fn role(&self) -> ActorRole {
        match self {
            Actor::Public => ActorRole::Public,
            Actor::Submitter => ActorRole::Submitter,
            Actor::SiteAdmin { .. } => ActorRole::SiteAdmin,
            Actor::Coordinator { .. } => ActorRole::Coordinator,
            Actor::ContributingAuthor { .. } => ActorRole::ContributingAuthor,
            Actor::System => ActorRole::System,
        }
    }

    /// The Admin account acting, for the private record: an Admin session's
    /// user, or [`MODERATION_TOKEN_ACTOR`] for the hosted token. Never
    /// anything about a reader.
    pub fn account(&self) -> Option<&str> {
        self.admin_user()
    }

    pub(crate) fn admin_user(&self) -> Option<&str> {
        match self {
            Actor::SiteAdmin { admin_user }
            | Actor::Coordinator { admin_user, .. }
            | Actor::ContributingAuthor { admin_user, .. } => Some(admin_user),
            _ => None,
        }
    }

    /// Whether a coordinator or contributing author holds a binding on the
    /// publication this work belongs to. A work-less item is never in scope.
    fn covers(works: &[&str], work: Option<&str>) -> bool {
        work.is_some_and(|work| works.contains(&work))
    }
}

/// The published work of each shared publication (ADR 0103): the
/// [`Post::url`](crate::model::Post::url) of the post loaded from
/// `posts/{publication_id}.md` ([`crate::assembly::post_path`]). It is
/// resolved at request time from the loaded site, never stored, so a renamed
/// slug moves the work with it. A publication whose post is not loaded has no
/// work yet. Build it from the site as Admin loads it, drafts included.
#[derive(Clone, Debug)]
pub struct SharedWorks<'a> {
    publications: Vec<(&'a SharedPublication, Option<&'a str>)>,
    /// Every loaded post's path, to tell a work from a path nothing loads.
    posts: Vec<&'a str>,
}

/// Who the server authenticated for a moderation request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Principal<'a> {
    /// The hosted moderation token (`OPENBLOG_ADMIN_API_KEY`).
    ModerationToken,
    /// A signed-in Admin session.
    AdminSession { admin_user: &'a str },
}

/// The audit trail's account name for the hosted moderation token. It is not
/// a valid Admin username, so it never names an Admin account.
pub const MODERATION_TOKEN_ACTOR: &str = "@moderation-token";

impl<'a> SharedWorks<'a> {
    pub fn new(records: &'a [SharedPublication], site: &'a Site) -> Self {
        let publications = records
            .iter()
            .map(|record| {
                let path = crate::assembly::post_path(record);
                let work = site
                    .posts
                    .iter()
                    .find(|post| post.source == path)
                    .map(|post| post.url.as_str());
                (record, work)
            })
            .collect();
        let posts = site.posts.iter().map(|post| post.url.as_str()).collect();
        Self {
            publications,
            posts,
        }
    }

    /// The shared publication whose post is `work`, if any: the record that
    /// decides who may answer there. Never a name or a guess; a path no
    /// publication publishes has none.
    pub fn record_for_work(&self, work: &str) -> Option<&'a SharedPublication> {
        self.publications
            .iter()
            .find(|(_, published)| *published == Some(work))
            .map(|(record, _)| *record)
    }

    /// The works of one shared publication: its post's path, or none when the
    /// publication is unknown or its post is not loaded. This is the `works`
    /// of a coordinator or contributing author acting for it.
    pub fn works(&self, publication_id: &str) -> &[&'a str] {
        self.publications
            .iter()
            .find(|(record, _)| record.publication_id == publication_id)
            .map_or(&[], |(_, work)| work.as_slice())
    }

    /// The actor a principal is when acting on an item about `work` (ADR
    /// 0103). Deny by default:
    ///
    /// - The moderation token is the site Admin.
    /// - An Admin session acting on a work of a shared publication in which
    ///   it holds a binding has that binding's publication roles for that
    ///   publication's works: site owner or coordinator is
    ///   [`Actor::Coordinator`], contributor is [`Actor::ContributingAuthor`],
    ///   and anything else, or a binding whose account, registry key or
    ///   participant no longer resolves, is [`Actor::Public`].
    /// - An Admin session holding a binding anywhere, acting on a path that is
    ///   no loaded post (a deleted post, or a slug since renamed), is
    ///   [`Actor::Public`]: whether it is a shared work cannot be told, so it
    ///   fails closed, and the moderation token still reaches it.
    /// - Otherwise, including an item with no work, an Admin session is the
    ///   site Admin, as every Admin user edits everything (ADR 0006).
    pub fn actor<'s>(
        &'s self,
        principal: Principal<'a>,
        work: Option<&str>,
        identities: &Identities<'_>,
    ) -> Actor<'s> {
        let admin_user = match principal {
            Principal::ModerationToken => {
                return Actor::SiteAdmin {
                    admin_user: MODERATION_TOKEN_ACTOR,
                }
            }
            Principal::AdminSession { admin_user } => admin_user,
        };
        let Some(work) = work else {
            return Actor::SiteAdmin { admin_user };
        };
        let bound = |record: &SharedPublication| {
            record
                .authorization
                .bindings
                .iter()
                .any(|binding| binding.admin_user == admin_user)
        };
        if let Some((record, works)) = self
            .publications
            .iter()
            .find(|(record, works)| *works == Some(work) && bound(record))
        {
            return publication_actor(admin_user, record, works.as_slice(), identities);
        }
        if !self.posts.contains(&work) && self.publications.iter().any(|(record, _)| bound(record))
        {
            return Actor::Public;
        }
        Actor::SiteAdmin { admin_user }
    }
}

/// An Admin session's actor on one shared publication's works, from its
/// current binding there. Every role holds `ViewPublication`, so authorizing
/// it is the existing check that the binding still resolves.
fn publication_actor<'s>(
    admin_user: &'s str,
    record: &SharedPublication,
    works: &'s [&'s str],
    identities: &Identities<'_>,
) -> Actor<'s> {
    let Ok(binding) = record.authorize(
        admin_user,
        identities,
        AuthorizationAction::ViewPublication,
        AuthorizationTarget::Publication,
    ) else {
        return Actor::Public;
    };
    let holds = |role| binding.roles.contains(&role);
    if holds(AuthorizationRole::SiteOwner) || holds(AuthorizationRole::Coordinator) {
        Actor::Coordinator { admin_user, works }
    } else if holds(AuthorizationRole::Contributor) {
        Actor::ContributingAuthor { admin_user, works }
    } else {
        Actor::Public
    }
}

/// The server-side facts about one stored item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ItemFacts<'a> {
    pub id: &'a str,
    pub kind: ParticipationKind,
    /// The published work's path (`/posts/tides/`), when the kind has one.
    pub work: Option<&'a str>,
    /// The item an author response answers or an abuse report reports.
    pub parent: Option<&'a str>,
    pub state: ModerationState,
    /// Raised by every transition; a request names the version it saw.
    pub version: u64,
    /// The text's revision, raised only when a clarification replaces it.
    pub revision: u32,
    /// The revision an approval covers, set only while approved.
    pub approved_revision: Option<u32>,
    /// The revision a moderator last asked the submitter to clarify. It stays
    /// recorded after rejection, expiry or reopening; only the submitter's
    /// answer, a later revision, moves the item past it. While it equals
    /// `revision` the item can never be approved or public.
    pub clarification_asked: Option<u32>,
    /// The submitter agreed to be asked to clarify.
    pub clarification_consent: bool,
    /// Whether the text, details and reader name are still stored. Retention
    /// purges them and keeps only the audit trail.
    pub content_retained: bool,
    /// When the item entered its current state.
    pub state_since: DateTime,
}

impl ItemFacts<'_> {
    /// Whether a clarification request asked about the current revision, so
    /// the text it carries is the text the submitter was asked to change.
    pub fn current_revision_asked(&self) -> bool {
        self.clarification_asked == Some(self.revision)
    }
}

/// A request to change an item.
#[derive(Clone, Copy, Debug)]
pub struct Request<'a> {
    pub actor: Actor<'a>,
    pub action: ModerationAction,
    /// The item version the requester saw; anything else is stale.
    pub expected_version: u64,
    pub reason: Option<ReasonCode>,
    pub at: DateTime,
    /// For [`ModerationAction::UpholdReport`] only: the stored item the
    /// report names.
    pub reported_item: Option<&'a ItemFacts<'a>>,
}

/// What a decision changes on one item. Apply it, with its audit event, in
/// one write; if the write fails nothing changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transition {
    pub item: String,
    pub from: ModerationState,
    pub to: ModerationState,
    pub version: u64,
    pub revision: u32,
    pub approved_revision: Option<u32>,
    /// The revision a clarification replaced. Its text must not be kept as
    /// a publishable revision.
    pub superseded_revision: Option<u32>,
    /// The item's [`ItemFacts::clarification_asked`] after the change: set to
    /// the current revision by a clarification request, otherwise unchanged.
    pub clarification_asked: Option<u32>,
    pub audit: AuditEvent,
}

/// The outcome of a request: the item's transition and, when an upheld
/// report takes its target down, the target's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub item: Transition,
    pub reported_item: Option<Transition>,
}

/// A request to create an item.
#[derive(Clone, Copy, Debug)]
pub struct Submission<'a> {
    /// The new item's id, chosen by the receiver.
    pub id: &'a str,
    pub actor: Actor<'a>,
    pub kind: ParticipationKind,
    /// The work the item is about. For an item that answers or reports
    /// another, it must be the parent's work.
    pub work: Option<&'a str>,
    /// The kind's effective mode on that work.
    pub mode: ParticipationMode,
    /// For a response or a report: the stored parent and its kind's mode.
    pub parent: Option<(&'a ItemFacts<'a>, ParticipationMode)>,
    /// For an author response to a Third Perspective: the target that
    /// perspective stores. Required there, so a caller cannot leave out the
    /// one fact that says whose section it is (ADR 0129).
    pub parent_target: Option<&'a PerspectiveTarget>,
    /// Proof that the author of an attributed section was confirmed. Only
    /// [`crate::attributed_perspective::admit_response`] can issue one.
    pub author_grant: Option<AuthorGrant>,
    pub clarification_consent: bool,
    pub at: DateTime,
}

/// A sealed token: the author of an attributed section was checked against
/// the private record. It has no public constructor, so a plain author
/// response (a coordinator's, a site owner's) can never stand in for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthorGrant(());

impl AuthorGrant {
    pub(crate) fn issue() -> Self {
        Self(())
    }
}

/// A created item: always pending, at version and revision 1.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Admission {
    pub state: ModerationState,
    pub version: u64,
    pub revision: u32,
    pub clarification_consent: bool,
    pub audit: AuditEvent,
}

/// What the audit trail records for one event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuditAction {
    Submit,
    Moderate(ModerationAction),
    /// Retention purged the text, details and reader name.
    PurgeContent,
    /// Retention cleared a kept editorial item's private contact and
    /// unpublished name and nothing else (ADR 0155).
    ScrubIdentity,
    /// An author linked an accepted suggestion for future work to something
    /// they made from it (ADR 0162). The item's state is unchanged, so the
    /// event's `from` and `to` are the same state; it holds no link target.
    Convert,
    /// The author recorded a correction decision on an evidence submission
    /// (ADR 0117). It is not a moderation action: the item's state, version
    /// and approval are unchanged, so the event's `from` and `to` are the
    /// same state.
    Decide,
}

impl AuditAction {
    pub fn id(self) -> &'static str {
        match self {
            AuditAction::Submit => "submit",
            AuditAction::Moderate(action) => action.id(),
            AuditAction::PurgeContent => "purge-content",
            AuditAction::ScrubIdentity => "scrub-identity",
            AuditAction::Convert => "convert",
            AuditAction::Decide => "decide",
        }
    }
}

/// One private audit record. It holds no text, details, reader name,
/// contact, address or device data, only who acted on which item and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditEvent {
    pub item: String,
    pub kind: ParticipationKind,
    pub action: AuditAction,
    pub from: Option<ModerationState>,
    pub to: ModerationState,
    pub actor: ActorRole,
    /// The Admin account for site Admins, coordinators and contributing
    /// authors; never anything about a reader.
    pub actor_id: Option<String>,
    pub reason: Option<ReasonCode>,
    pub at: DateTime,
    pub revision: u32,
    pub version: u64,
    /// The other item of an upheld report, a response or a report.
    pub related: Option<String>,
}

impl AuditEvent {
    /// The stored form, with fixed keys.
    pub fn to_json(&self) -> Value {
        json!({
            "item": self.item,
            "kind": self.kind.id(),
            "action": self.action.id(),
            "from": self.from.map(ModerationState::id),
            "to": self.to.id(),
            "actor": self.actor.id(),
            "actorId": self.actor_id,
            "reason": self.reason.map(ReasonCode::id),
            "at": self.at.rfc3339(),
            "revision": self.revision,
            "version": self.version,
            "related": self.related,
        })
    }
}

/// Why a request was refused. Codes and messages name no item text,
/// identity or stored value; nothing changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyError {
    /// The actor holds no grant for this action on this item.
    Denied,
    /// The kind is hidden here, or the item answered or reported is not
    /// public. The same answer whether or not it exists.
    Unavailable,
    /// The kind is locked here: approved items are shown, nothing is accepted.
    Closed,
    /// The request names a version other than the stored one.
    Stale,
    /// The action does not apply to this kind or from this state.
    NotAllowed,
    ReasonRequired,
    ReasonNotAllowed,
    /// The submitter did not agree to be asked to clarify.
    ConsentRequired,
    /// Retention already purged the text.
    ContentPurged,
    /// Retention has not reached the item yet.
    NotDue,
    /// The reported item is missing or is not the one the report names.
    ReportMismatch,
    /// The submission's target does not fit its kind.
    InvalidTarget,
}

impl PolicyError {
    pub fn code(self) -> &'static str {
        match self {
            PolicyError::Denied => "denied",
            PolicyError::Unavailable => "unavailable",
            PolicyError::Closed => "closed",
            PolicyError::Stale => "stale",
            PolicyError::NotAllowed => "notAllowed",
            PolicyError::ReasonRequired => "reasonRequired",
            PolicyError::ReasonNotAllowed => "reasonNotAllowed",
            PolicyError::ConsentRequired => "consentRequired",
            PolicyError::ContentPurged => "contentPurged",
            PolicyError::NotDue => "notDue",
            PolicyError::ReportMismatch => "reportMismatch",
            PolicyError::InvalidTarget => "invalidTarget",
        }
    }
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            PolicyError::Denied => "this moderation action is not permitted",
            PolicyError::Unavailable => "participation is not available here",
            PolicyError::Closed => "this discussion is read-only",
            PolicyError::Stale => "the item changed; reload it and try again",
            PolicyError::NotAllowed => "this action does not apply to the item",
            PolicyError::ReasonRequired => "choose a reason",
            PolicyError::ReasonNotAllowed => "this reason does not apply to the action",
            PolicyError::ConsentRequired => "the submitter did not agree to be asked to clarify",
            PolicyError::ContentPurged => "the item's text is no longer kept",
            PolicyError::NotDue => "the item's retention period has not ended",
            PolicyError::ReportMismatch => "the reported item does not match the report",
            PolicyError::InvalidTarget => "the submission's target does not fit its kind",
        })
    }
}

impl std::error::Error for PolicyError {}

/// How long moderation keeps what it does not publish, in days.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct RetentionPolicy {
    /// A pending item nobody moderated expires (rejected, `expired`).
    pub pending_days: u32,
    /// An unanswered clarification request expires the same way.
    pub clarification_days: u32,
    /// After rejection or removal, or after approval of a kind that is never
    /// public (an upheld abuse report), the text, details and reader name are
    /// purged. A withdrawn item's are purged at once. An accepted suggestion
    /// for future work is kept, but its private contact and unpublished name
    /// are cleared this long after approval.
    pub closed_days: u32,
    /// Audit events are kept this long, at least as long as `closed_days`,
    /// so the record of a removal outlives the text it removed.
    pub audit_days: u32,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            pending_days: 90,
            clarification_days: 30,
            closed_days: 30,
            audit_days: 365,
        }
    }
}

impl RetentionPolicy {
    pub(crate) fn validate(&self) -> Result<(), String> {
        for (name, days) in [
            ("pendingDays", self.pending_days),
            ("clarificationDays", self.clarification_days),
            ("closedDays", self.closed_days),
            ("auditDays", self.audit_days),
        ] {
            if !(1..=MAX_RETENTION_DAYS).contains(&days) {
                return Err(format!(
                    "participation.retention.{name} must be between 1 and {MAX_RETENTION_DAYS} days"
                ));
            }
        }
        if self.audit_days < self.closed_days {
            return Err(
                "participation.retention.auditDays must be at least closedDays, so a removal's \
                 record outlives its text"
                    .into(),
            );
        }
        Ok(())
    }

    fn ended(since: DateTime, days: u32, now: DateTime) -> bool {
        now.unix() >= since.unix().saturating_add(i64::from(days) * DAY_SECONDS)
    }
}

/// When each retention step falls due, for one run of the retention job
/// ([`ModerationPolicy::cutoffs`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetentionCutoffs {
    /// A pending item whose state began at or before this expires.
    pub pending_until: DateTime,
    /// An unanswered clarification request from at or before this expires.
    pub clarification_until: DateTime,
    /// A closed item's text from at or before this is purged.
    pub closed_until: DateTime,
    /// An audit event recorded at or before this is deleted.
    pub audit_until: DateTime,
    /// Whether comments are covered (the site set `participation.retention`).
    pub comments: bool,
}

impl RetentionCutoffs {
    /// The form Admin sends the hosted function, with fixed keys.
    pub fn to_json(&self) -> Value {
        json!({
            "pendingUntil": self.pending_until.rfc3339(),
            "clarificationUntil": self.clarification_until.rfc3339(),
            "closedUntil": self.closed_until.rfc3339(),
            "auditUntil": self.audit_until.rfc3339(),
            "comments": self.comments,
        })
    }
}

/// What a deletion request changes ([`ModerationPolicy::erase`]). Apply the
/// withdrawal, the purge and both audit events in one write; if it fails,
/// nothing changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Erasure {
    /// The withdrawal taken first, for a submitter's item that was still
    /// open or public.
    pub withdrawal: Option<Transition>,
    /// The purge's audit event. It holds no text.
    pub purge: AuditEvent,
    /// The item's state afterwards, which the purge does not change.
    pub state: ModerationState,
    /// The item's version afterwards.
    pub version: u64,
}

/// Whether a kind's submitters get a private receipt (ADR 0107): the reader
/// kinds that may be asked to clarify. Comments predate receipts, abuse
/// reports are anonymous, and authors act through Admin.
pub fn issues_receipts(kind: ParticipationKind) -> bool {
    kind.rules().origin == Origin::Reader && kind.rules().clarification
}

/// A step the retention job owes an item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetentionStep {
    /// Apply [`ModerationAction::Expire`] as [`Actor::System`].
    Expire,
    /// Delete the text, details and reader name; keep the state and audit.
    PurgeContent,
    /// Clear only the private contact and the unpublished name of an
    /// approved editorial item, which is otherwise kept (ADR 0155). The text,
    /// the link, the hints, the state and the audit trail stay. The item is
    /// due once `closed_days` have passed since it was approved; a caller
    /// that knows the item holds no such detail owes it nothing.
    ScrubIdentity,
}

/// What a viewer asks to see of a stored item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    /// The text and details.
    Content,
    /// A reader's name they did not agree to publish, and any contact detail.
    PrivateIdentity,
}

/// The one moderation policy, with the site's retention periods.
///
/// The default is a site that never set `participation.retention`: the
/// default periods, applied to every kind except comments, which predate
/// this policy and are kept as before (ADR 0104).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ModerationPolicy {
    pub retention: RetentionPolicy,
    /// Whether retention also expires and purges comments. Only a site that
    /// sets `participation.retention` itself opts its comments in.
    pub comment_retention: bool,
}

impl ModerationPolicy {
    /// Retention the site set explicitly: it applies to every kind,
    /// comments included.
    pub fn new(retention: RetentionPolicy) -> Self {
        Self {
            retention,
            comment_retention: true,
        }
    }

    pub fn from_config(config: &SiteConfig) -> Self {
        config
            .participation
            .retention
            .map_or_else(Self::default, Self::new)
    }

    /// Whether retention covers this kind at all.
    pub fn retains(&self, kind: ParticipationKind) -> bool {
        kind != ParticipationKind::Comment || self.comment_retention
    }

    /// Create an item. It is always [`ModerationState::Pending`]: no actor,
    /// kind or mode creates anything public.
    pub fn admit(&self, submission: &Submission<'_>) -> Result<Admission, PolicyError> {
        let rules = submission.kind.rules();
        let permitted = match (rules.origin, submission.actor) {
            (Origin::Reader, Actor::Public) => true,
            (Origin::Author, Actor::SiteAdmin { .. }) => true,
            (
                Origin::Author,
                Actor::Coordinator { works, .. } | Actor::ContributingAuthor { works, .. },
            ) => Actor::covers(works, submission.work),
            _ => false,
        };
        if !permitted {
            return Err(PolicyError::Denied);
        }
        match submission.mode {
            ParticipationMode::Hidden => return Err(PolicyError::Unavailable),
            ParticipationMode::Locked => return Err(PolicyError::Closed),
            ParticipationMode::Open => {}
        }
        let related = match (rules.target, submission.parent) {
            (TargetShape::Item, Some((parent, parent_mode))) => {
                if submission.kind == ParticipationKind::AuthorResponse
                    && parent.kind == ParticipationKind::ThirdPerspective
                {
                    // An answer about an attributed section is that section
                    // author's alone: refused here unless it carries the grant
                    // `admit_response` issues, whoever else may otherwise
                    // write author responses on this work.
                    let Some(target) = submission.parent_target else {
                        return Err(PolicyError::InvalidTarget);
                    };
                    if !matches!(AttributedTarget::from_perspective(target), Ok(None))
                        && submission.author_grant.is_none()
                    {
                        return Err(PolicyError::Denied);
                    }
                }
                let answerable = match submission.kind {
                    ParticipationKind::AuthorResponse => {
                        parent.kind.rules().publishable
                            && parent.kind != ParticipationKind::AuthorResponse
                    }
                    _ => parent.kind.rules().publishable,
                };
                if !answerable || !is_public(parent, parent_mode) || parent.work != submission.work
                {
                    return Err(PolicyError::Unavailable);
                }
                Some(parent.id.to_string())
            }
            (TargetShape::Item, None) => return Err(PolicyError::InvalidTarget),
            (_, Some(_)) => return Err(PolicyError::InvalidTarget),
            (_, None) if submission.work.is_none() => return Err(PolicyError::InvalidTarget),
            (_, None) => None,
        };
        let clarification_consent = rules.clarification && submission.clarification_consent;
        Ok(Admission {
            state: ModerationState::Pending,
            version: 1,
            revision: 1,
            clarification_consent,
            audit: AuditEvent {
                item: submission.id.to_string(),
                kind: submission.kind,
                action: AuditAction::Submit,
                from: None,
                to: ModerationState::Pending,
                actor: submission.actor.role(),
                actor_id: submission.actor.admin_user().map(str::to_string),
                reason: None,
                at: submission.at,
                revision: 1,
                version: 1,
                related,
            },
        })
    }

    /// Decide a request on a stored item. Checks run in a fixed order, so an
    /// actor without a grant learns nothing about the item's state: grant,
    /// kind, version, state, reason, consent, retained text, retention, and
    /// for an upheld report the reported item.
    pub fn decide(
        &self,
        item: &ItemFacts<'_>,
        request: &Request<'_>,
    ) -> Result<Decision, PolicyError> {
        let action = request.action;
        if !granted(&request.actor, action, item) {
            return Err(PolicyError::Denied);
        }
        if !applies(item.kind, action) {
            return Err(PolicyError::NotAllowed);
        }
        if request.expected_version != item.version {
            return Err(PolicyError::Stale);
        }
        let to = match (action, next_state(action, item.state)) {
            (_, None) => return Err(PolicyError::NotAllowed),
            // The text a clarification request asked about is never
            // approved, whatever happened to the item since (ADR 0102).
            (ModerationAction::Approve, Some(_)) if item.current_revision_asked() => {
                return Err(PolicyError::NotAllowed)
            }
            (ModerationAction::Reopen, Some(_)) if item.current_revision_asked() => {
                ModerationState::Clarification
            }
            (_, Some(to)) => to,
        };
        let allowed = allowed_reasons(action, item.kind);
        match request.reason {
            None if !allowed.is_empty() => return Err(PolicyError::ReasonRequired),
            Some(reason) if !allowed.contains(&reason) => {
                return Err(PolicyError::ReasonNotAllowed)
            }
            _ => {}
        }
        if action == ModerationAction::RequestClarification && !item.clarification_consent {
            return Err(PolicyError::ConsentRequired);
        }
        if !item.content_retained {
            return Err(PolicyError::ContentPurged);
        }
        if action == ModerationAction::Expire && !self.expiry_due(item, request.at) {
            return Err(PolicyError::NotDue);
        }
        let reported_item = match (action, request.reported_item) {
            (ModerationAction::UpholdReport, Some(reported)) => {
                if item.parent != Some(reported.id) {
                    return Err(PolicyError::ReportMismatch);
                }
                // Upholding takes the reported item out of public view, or
                // changes nothing: the actor must be able to remove it.
                if !granted(&request.actor, ModerationAction::Remove, reported) {
                    return Err(PolicyError::Denied);
                }
                (reported.state == ModerationState::Approved).then(|| {
                    let mut removal = transition(
                        reported,
                        &request.actor,
                        ModerationAction::Remove,
                        ModerationState::Removed,
                        Some(ReasonCode::UpheldReport),
                        request.at,
                    );
                    removal.audit.related = Some(item.id.to_string());
                    removal
                })
            }
            (ModerationAction::UpholdReport, None) => return Err(PolicyError::ReportMismatch),
            (_, Some(_)) => return Err(PolicyError::ReportMismatch),
            (_, None) => None,
        };
        let reason = match action {
            ModerationAction::Expire => Some(ReasonCode::Expired),
            _ => request.reason,
        };
        let mut decided = transition(item, &request.actor, action, to, reason, request.at);
        decided.audit.related = match action {
            ModerationAction::UpholdReport => item.parent.map(str::to_string),
            _ => None,
        };
        Ok(Decision {
            item: decided,
            reported_item,
        })
    }

    fn expiry_due(&self, item: &ItemFacts<'_>, now: DateTime) -> bool {
        if !self.retains(item.kind) {
            return false;
        }
        match item.state {
            ModerationState::Pending => {
                RetentionPolicy::ended(item.state_since, self.retention.pending_days, now)
            }
            ModerationState::Clarification => {
                RetentionPolicy::ended(item.state_since, self.retention.clarification_days, now)
            }
            _ => false,
        }
    }

    /// The step retention owes an item now, if any. Approved items are kept
    /// while they are published; an approved item of a kind that is never
    /// public (an upheld abuse report) is closed, so its text is purged after
    /// `closed_days` like a rejected one, and its audit events stay. An
    /// approved editorial item (a suggestion for future work) is kept, but
    /// owes [`RetentionStep::ScrubIdentity`] once `closed_days` have passed
    /// since its approval. Comments are never due unless the site set
    /// retention itself.
    pub fn retention_due(&self, item: &ItemFacts<'_>, now: DateTime) -> Option<RetentionStep> {
        if !self.retains(item.kind) {
            return None;
        }
        match item.state {
            ModerationState::Pending | ModerationState::Clarification => {
                self.expiry_due(item, now).then_some(RetentionStep::Expire)
            }
            ModerationState::Approved if item.kind.rules().publishable => None,
            ModerationState::Approved if item.kind.rules().editorial => (item.content_retained
                && RetentionPolicy::ended(item.state_since, self.retention.closed_days, now))
            .then_some(RetentionStep::ScrubIdentity),
            ModerationState::Rejected | ModerationState::Removed | ModerationState::Approved => {
                (item.content_retained
                    && RetentionPolicy::ended(item.state_since, self.retention.closed_days, now))
                .then_some(RetentionStep::PurgeContent)
            }
            ModerationState::Withdrawn => {
                item.content_retained.then_some(RetentionStep::PurgeContent)
            }
        }
    }

    /// The audit event recording a purge. The state does not change.
    pub fn purge_event(&self, item: &ItemFacts<'_>, at: DateTime) -> Option<AuditEvent> {
        self.retention_event(item, at, RetentionStep::PurgeContent)
    }

    /// The audit event recording the clearing of a kept item's private
    /// identity ([`RetentionStep::ScrubIdentity`]). The state does not change.
    pub fn scrub_event(&self, item: &ItemFacts<'_>, at: DateTime) -> Option<AuditEvent> {
        self.retention_event(item, at, RetentionStep::ScrubIdentity)
    }

    fn retention_event(
        &self,
        item: &ItemFacts<'_>,
        at: DateTime,
        step: RetentionStep,
    ) -> Option<AuditEvent> {
        (self.retention_due(item, at) == Some(step)).then(|| AuditEvent {
            item: item.id.to_string(),
            kind: item.kind,
            action: match step {
                RetentionStep::ScrubIdentity => AuditAction::ScrubIdentity,
                _ => AuditAction::PurgeContent,
            },
            from: Some(item.state),
            to: item.state,
            actor: ActorRole::System,
            actor_id: None,
            reason: None,
            at,
            revision: item.revision,
            // A purge raises the version, so no view from before it can
            // still act on the item.
            version: item.version.saturating_add(1),
            related: None,
        })
    }

    /// The times at or before which each retention step is due now (ADR
    /// 0108): an item whose state began at or before its step's time owes
    /// that step, and an audit event recorded at or before `audit_until` may
    /// be deleted. `comments` says whether comments are covered at all.
    pub fn cutoffs(&self, now: DateTime) -> RetentionCutoffs {
        let before = |days: u32| {
            DateTime::from_unix(now.unix().saturating_sub(i64::from(days) * DAY_SECONDS))
        };
        RetentionCutoffs {
            pending_until: before(self.retention.pending_days),
            clarification_until: before(self.retention.clarification_days),
            closed_until: before(self.retention.closed_days),
            audit_until: before(self.retention.audit_days),
            comments: self.comment_retention,
        }
    }

    /// A deletion request (ADR 0107): the text, details and reader name of
    /// one item are deleted now, and only its state and audit trail remain.
    ///
    /// - The submitter, proven by their private receipt, may ask for any of
    ///   their items: one still pending, waiting for clarification or
    ///   approved is withdrawn first, in the same write, so it is never
    ///   public again; a rejected or removed one is purged as it is.
    ///   Comments and abuse reports carry no receipt, so their submitters
    ///   cannot ask here.
    /// - The site Admin, acting on a request a reader made some other way,
    ///   may purge an item that is already closed (rejected, removed or
    ///   withdrawn) or an upheld abuse report; anything still open or public
    ///   must be decided first, so no erasure skips a moderation decision.
    ///
    /// Checks run in the policy's order: grant, version, retained text,
    /// state.
    pub fn erase(
        &self,
        item: &ItemFacts<'_>,
        actor: &Actor<'_>,
        expected_version: u64,
        at: DateTime,
    ) -> Result<Erasure, PolicyError> {
        let permitted = match actor {
            Actor::Submitter => issues_receipts(item.kind),
            Actor::SiteAdmin { .. } => true,
            _ => false,
        };
        if !permitted {
            return Err(PolicyError::Denied);
        }
        if expected_version != item.version {
            return Err(PolicyError::Stale);
        }
        if !item.content_retained {
            return Err(PolicyError::ContentPurged);
        }
        let withdrawal = match (actor, item.state) {
            (
                Actor::Submitter,
                ModerationState::Pending
                | ModerationState::Clarification
                | ModerationState::Approved,
            ) => Some(transition(
                item,
                actor,
                ModerationAction::Withdraw,
                ModerationState::Withdrawn,
                None,
                at,
            )),
            (Actor::Submitter, _) => None,
            (_, ModerationState::Rejected | ModerationState::Removed)
            | (_, ModerationState::Withdrawn) => None,
            (_, ModerationState::Approved)
                if !item.kind.rules().publishable && !item.kind.rules().editorial =>
            {
                None
            }
            _ => return Err(PolicyError::NotAllowed),
        };
        let (state, version) = withdrawal
            .as_ref()
            .map_or((item.state, item.version), |change| {
                (change.to, change.version)
            });
        let version = version.saturating_add(1);
        Ok(Erasure {
            purge: AuditEvent {
                item: item.id.to_string(),
                kind: item.kind,
                action: AuditAction::PurgeContent,
                from: Some(state),
                to: state,
                actor: actor.role(),
                actor_id: actor.admin_user().map(str::to_string),
                reason: None,
                at,
                revision: item.revision,
                version,
                related: None,
            },
            withdrawal,
            state,
            version,
        })
    }

    /// Whether an audit event recorded at `event_at` may now be deleted.
    /// Audit events are this policy's own records, never the comments
    /// themselves, so `auditDays` applies to them for every kind.
    pub fn audit_due(&self, event_at: DateTime, now: DateTime) -> bool {
        RetentionPolicy::ended(event_at, self.retention.audit_days, now)
    }
}

/// Whether an item may be shown to readers, counted or previewed in public:
/// a publishable kind, approved at its current revision, that revision not
/// one a clarification request asked about, text still kept, and the kind
/// shown on its post. Everything else, including any state a
/// reader of stored data does not recognise, is private.
pub fn is_public(item: &ItemFacts<'_>, mode: ParticipationMode) -> bool {
    item.kind.rules().publishable
        && item.state == ModerationState::Approved
        && item.approved_revision == Some(item.revision)
        && !item.current_revision_asked()
        && item.content_retained
        && mode.shows_approved()
}

/// Whether `actor` may see part of a stored item. Out of scope, a
/// coordinator or contributing author sees only what the public sees. Only
/// the site Admin and the submitter see a reader's private identity, never a
/// coordinator, contributing author or publication site owner, and
/// contributing authors never see abuse reports.
pub fn may_view(
    actor: &Actor<'_>,
    item: &ItemFacts<'_>,
    mode: ParticipationMode,
    view: View,
) -> bool {
    if !item.content_retained {
        return false;
    }
    match view {
        View::PrivateIdentity => matches!(actor, Actor::SiteAdmin { .. } | Actor::Submitter),
        View::Content => match actor {
            Actor::SiteAdmin { .. } | Actor::Submitter => true,
            Actor::Coordinator { works, .. } if Actor::covers(works, item.work) => true,
            Actor::ContributingAuthor { works, .. }
                if Actor::covers(works, item.work)
                    && item.kind != ParticipationKind::AbuseReport =>
            {
                true
            }
            Actor::System => false,
            _ => is_public(item, mode),
        },
    }
}

/// Whether `actor` may record the author's correction decision on `item`
/// (ADR 0117): the approve row of the grant list, so the site Admin and a
/// coordinator of the item's work, never a contributing author, the
/// submitter, the public or the retention job. A decision speaks for the
/// work, as an approval does.
pub fn may_decide(actor: &Actor<'_>, item: &ItemFacts<'_>) -> bool {
    granted(actor, ModerationAction::Approve, item)
}

/// The complete grant list; anything not listed is denied.
fn granted(actor: &Actor<'_>, action: ModerationAction, item: &ItemFacts<'_>) -> bool {
    use ModerationAction::*;
    match actor {
        Actor::SiteAdmin { .. } => matches!(
            action,
            Approve | Reject | RequestClarification | Remove | Reopen | UpholdReport
        ),
        Actor::Coordinator { works, .. } => {
            matches!(
                action,
                Approve | Reject | RequestClarification | Remove | UpholdReport
            ) && Actor::covers(works, item.work)
        }
        Actor::Submitter => matches!(action, Clarify | Withdraw),
        Actor::System => action == Expire,
        Actor::Public | Actor::ContributingAuthor { .. } => false,
    }
}

/// Whether an action exists for a kind at all.
fn applies(kind: ParticipationKind, action: ModerationAction) -> bool {
    let rules = kind.rules();
    match action {
        ModerationAction::Approve => kind != ParticipationKind::AbuseReport,
        ModerationAction::UpholdReport => kind == ParticipationKind::AbuseReport,
        ModerationAction::RequestClarification | ModerationAction::Clarify => rules.clarification,
        ModerationAction::Remove => rules.publishable || rules.editorial,
        ModerationAction::Reject
        | ModerationAction::Reopen
        | ModerationAction::Withdraw
        | ModerationAction::Expire => true,
    }
}

/// The state machine. `None` means the action does not apply from `from`.
/// One exception depends on the item rather than its state: reopening an
/// item whose current revision a clarification request asked about returns
/// it to clarification, and approving such an item is refused
/// ([`ItemFacts::current_revision_asked`]).
pub fn next_state(action: ModerationAction, from: ModerationState) -> Option<ModerationState> {
    use ModerationAction as A;
    use ModerationState as S;
    match (action, from) {
        (A::Approve | A::UpholdReport, S::Pending) => Some(S::Approved),
        (A::Reject | A::Expire, S::Pending | S::Clarification) => Some(S::Rejected),
        (A::RequestClarification, S::Pending) => Some(S::Clarification),
        (A::Clarify, S::Clarification) => Some(S::Pending),
        (A::Remove, S::Approved) => Some(S::Removed),
        (A::Reopen, S::Rejected | S::Removed) => Some(S::Pending),
        (A::Withdraw, S::Pending | S::Clarification | S::Approved) => Some(S::Withdrawn),
        _ => None,
    }
}

fn transition(
    item: &ItemFacts<'_>,
    actor: &Actor<'_>,
    action: ModerationAction,
    to: ModerationState,
    reason: Option<ReasonCode>,
    at: DateTime,
) -> Transition {
    let clarified = action == ModerationAction::Clarify;
    let revision = if clarified {
        item.revision.saturating_add(1)
    } else {
        item.revision
    };
    let version = item.version.saturating_add(1);
    Transition {
        item: item.id.to_string(),
        from: item.state,
        to,
        version,
        revision,
        approved_revision: (to == ModerationState::Approved).then_some(revision),
        superseded_revision: clarified.then_some(item.revision),
        clarification_asked: if action == ModerationAction::RequestClarification {
            Some(item.revision)
        } else {
            item.clarification_asked
        },
        audit: AuditEvent {
            item: item.id.to_string(),
            kind: item.kind,
            action: AuditAction::Moderate(action),
            from: Some(item.state),
            to,
            actor: actor.role(),
            actor_id: actor.admin_user().map(str::to_string),
            reason,
            at,
            revision,
            version,
            related: None,
        },
    }
}
