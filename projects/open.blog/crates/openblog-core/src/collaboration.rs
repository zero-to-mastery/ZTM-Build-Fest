//! Group-safe contracts shared by future collaboration capabilities.

use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fmt};

use http::Uri;

use crate::contributor;

pub const COLLABORATION_CONTRACT_VERSION: u8 = 1;
pub const MAX_CONTRACT_BYTES: usize = 256 * 1024;
pub const MAX_PARTICIPANTS: usize = 100;
pub const MAX_CONTRIBUTIONS: usize = 1_000;
pub const MAX_REVEALS: usize = 1_000;
pub const MAX_LAYOUT_ITEMS: usize = 1_000;
pub const MAX_APPROVALS: usize = MAX_PARTICIPANTS;
pub const MAX_IDENTIFIER_BYTES: usize = 128;
pub const MAX_DISPLAY_NAME_BYTES: usize = 200;
pub const MAX_PROFILE_URL_BYTES: usize = 2_048;
pub const MAX_MARKDOWN_BYTES: usize = 64 * 1024;
pub const MAX_REGION_BYTES: usize = 64;
pub const COLLABORATION_AUTHORIZATION_VERSION: u8 = 1;
pub const MAX_AUTHORIZATION_POLICY_BYTES: usize = 64 * 1024;
pub const MAX_AUTHORIZATION_BINDINGS: usize = MAX_PARTICIPANTS;
pub const MAX_ADMIN_USERNAME_BYTES: usize = 32;
pub const SHARED_PUBLICATION_VERSION: u8 = 1;
/// The largest stored record that loads. It sits above the pretty-printed text of a record at
/// every other bound at once (a full group with the longest names and keys, every source, every
/// invitation and a full audit trail, about 600 KiB), so ordinary use can never write a record
/// that no longer loads; the store also refuses to write anything larger (#188).
pub const MAX_SHARED_PUBLICATION_BYTES: usize = 1024 * 1024;
pub const MAX_SOURCES: usize = 20;
pub const MAX_PUBLICATION_TITLE_BYTES: usize = 300;
pub const MAX_GUIDING_QUESTION_BYTES: usize = 1_000;
pub const MAX_SOURCE_TITLE_BYTES: usize = 300;
pub const MAX_SOURCE_DETAIL_BYTES: usize = 200;
pub const MAX_SOURCE_DATE_BYTES: usize = 64;
pub const MAX_SOURCE_URL_BYTES: usize = 2_048;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CollaborationContract {
    pub version: u8,
    pub revision: u64,
    pub participants: Vec<Participant>,
    pub contributions: Vec<Contribution>,
    pub reveals: Vec<Reveal>,
    pub layout: Vec<LayoutItem>,
    pub approvals: Vec<Approval>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Participant {
    pub id: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Contribution {
    pub id: String,
    pub participant_id: String,
    pub markdown: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Reveal {
    pub contribution_id: String,
    pub participant_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LayoutItem {
    pub contribution_id: String,
    pub region: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Approval {
    pub participant_id: String,
    pub revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PairProjection<'a> {
    pub first: &'a Participant,
    pub second: &'a Participant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollaborationError {
    InvalidContract,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AuthorizationPolicy {
    pub version: u8,
    pub revision: u64,
    pub publication_id: String,
    pub bindings: Vec<IdentityBinding>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IdentityBinding {
    pub admin_user: String,
    pub contributor_id: String,
    pub participant_id: String,
    pub roles: Vec<AuthorizationRole>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthorizationRole {
    SiteOwner,
    Coordinator,
    Contributor,
    Editor,
    Reader,
}

/// A collaboration action an authenticated request asks to perform. Each action takes exactly one
/// [`AuthorizationTarget`] kind; a target of any other kind is denied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthorizationAction {
    /// Read the shared publication's title, guiding question, and source references, never a
    /// contribution draft. Targets the publication.
    ViewPublication,
    /// Read the published projection. Targets the publication.
    ViewPublished,
    /// Read one contribution draft whose reveal lists the requester. Targets a contribution.
    ViewRevealed,
    /// Read one contribution draft's private content. Targets a contribution.
    ViewContribution,
    /// Change one contribution draft. Targets a contribution.
    EditContribution,
    /// Read or save the requester's own private contribution draft (`DraftSet`). Targets the
    /// requester's own participant, because draft ids are not contract contributions. Only
    /// Contributors and Editors hold it, and only for themselves: revealed drafts are read
    /// through `DraftSet::view`, never through this grant.
    EditDraft,
    /// Read and change the shared synthesis items (ADR 0025) as the requester's own participant:
    /// add, edit, withdraw from, reorder and approve items. Targets the requester's own
    /// participant. Only Contributors hold it, and only for themselves, because a named author
    /// must be able to approve the piece, which Editors cannot.
    EditSynthesis,
    /// Answer a reader's Third Perspective as the author of one attributed section (ADR 0128).
    /// Targets the author's own participant. Only Contributors hold it, and only for themselves:
    /// a coordinator or site owner moderates the response but never writes as another author,
    /// and a contributor registry key or an Editor binding grants nothing here.
    RespondAsAuthor,
    /// Capture, edit and remove the requester's own media moments (ADR 0062 to 0064), and read
    /// the moments other authors revealed with a draft. Targets the requester's own participant.
    /// Only Contributors hold it, and only for themselves: a moment proposed for the piece makes
    /// its owner a required approver, which an Editor cannot be.
    EditMoments,
    /// Choose how contribution drafts may be revealed. Targets the publication. Coordinators and
    /// site owners hold it; it reveals nothing and reads no draft.
    SetRevealPolicy,
    /// Choose whose approval publication needs and what an approval covers (ADR 0052). Targets
    /// the publication. Coordinators and site owners hold it; it reads no draft, never approves
    /// for anyone, and a real change clears every standing approval.
    SetApprovalPolicy,
    /// Choose a shared reflection's layout and arrangement (ADR 0031). Targets the publication.
    /// Coordinators and site owners hold it; it reads no draft and changes no prose.
    ArrangeReflection,
    /// Start an invitation into the publication. Targets the publication.
    Invite,
    /// Reveal one's own contribution draft. Targets a contribution.
    RevealContribution,
    /// Submit one's own approval of the current revision. Targets a participant.
    ApproveContribution,
    /// Request a publication time. Targets the publication.
    Schedule,
    /// Request publication. Targets the publication.
    Publish,
    /// Remove a participant from the publication. Targets a participant. The last site owner
    /// cannot be removed.
    RemoveMember,
    /// Grant or revoke one participant's binding, or change its roles. Targets a participant.
    /// [`AuthorizationPolicy::replace_from_json`] applies this grant to every binding a
    /// replacement adds, changes, or removes; a kept binding's identity never changes.
    ManageRoles,
    /// Export the published projection, never private collaboration state. Targets the
    /// publication.
    Export,
    /// Set, change or remove the publication's series placement (ADR 0038, ADR 0039). Targets
    /// the publication. An arrangement decision, so Site owners and Coordinators hold it and
    /// participants do not; authors consent to the placement through approval.
    PlaceInSeries,
    /// Create a new series definition (`content/series/<slug>.md`: name and premise) from this
    /// publication's Admin view. Targets the publication. Series are site-owned, so only Site
    /// owners hold it (ADR 0039).
    CreateSeries,
}

/// What a request acts on. Participant and contribution IDs come from the request and resolve
/// against the server-side collaboration contract; ownership and reveal recipients are read from
/// that contract, never from the request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthorizationTarget<'a> {
    Publication,
    Participant(&'a str),
    Contribution(&'a str),
}

/// Server-side facts for one request. Callers fill the identity fields from the authenticated
/// session, the current Admin users file, and the current contributor registry, load the policy
/// and contract from the same publication record, and authorize inside the same transaction as
/// any change the grant permits.
pub struct AuthorizationContext<'a> {
    pub publication_id: &'a str,
    pub authenticated_admin_user: &'a str,
    pub active_admin_users: &'a [&'a str],
    pub contributor_ids: &'a [&'a str],
    pub collaboration: &'a CollaborationContract,
    pub target: AuthorizationTarget<'a>,
}

/// Why [`SharedPublication::authorize_publish`] refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishError {
    /// The requester may not publish this record.
    Denied,
    /// The requester may publish, but a contributing participant has not approved this revision.
    Unapproved,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthorizationError;

impl fmt::Display for AuthorizationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("collaboration access denied")
    }
}

impl std::error::Error for AuthorizationError {}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TargetKind {
    Publication,
    Participant,
    Contribution,
}

/// A target resolved against the contract, from the bound participant's point of view.
enum ResolvedTarget<'a> {
    Publication,
    Participant {
        id: &'a str,
        site_owner: bool,
        last_site_owner: bool,
    },
    Contribution {
        owner: &'a str,
        revealed_to_requester: bool,
    },
}

impl AuthorizationAction {
    fn target_kind(self) -> TargetKind {
        use AuthorizationAction::*;
        match self {
            ViewPublication | ViewPublished | Invite | SetRevealPolicy | SetApprovalPolicy
            | ArrangeReflection | Schedule | Publish | Export | PlaceInSeries | CreateSeries => {
                TargetKind::Publication
            }
            ApproveContribution | EditDraft | EditSynthesis | EditMoments | RespondAsAuthor
            | RemoveMember | ManageRoles => TargetKind::Participant,
            ViewRevealed | ViewContribution | EditContribution | RevealContribution => {
                TargetKind::Contribution
            }
        }
    }
}

impl AuthorizationPolicy {
    pub fn from_json(source: &str) -> Result<Self, AuthorizationError> {
        if source.len() > MAX_AUTHORIZATION_POLICY_BYTES {
            return Err(AuthorizationError);
        }
        let policy: Self = serde_json::from_str(source).map_err(|_| AuthorizationError)?;
        if !policy.is_valid() {
            return Err(AuthorizationError);
        }
        Ok(policy)
    }

    fn is_valid(&self) -> bool {
        if self.version != COLLABORATION_AUTHORIZATION_VERSION
            || !valid_id(&self.publication_id)
            || self.bindings.len() > MAX_AUTHORIZATION_BINDINGS
        {
            return false;
        }
        let mut admin_users = HashSet::with_capacity(self.bindings.len());
        let mut contributor_ids = HashSet::with_capacity(self.bindings.len());
        let mut participant_keys = HashSet::with_capacity(self.bindings.len());
        self.bindings.iter().all(|binding| {
            let mut roles = HashSet::with_capacity(binding.roles.len());
            valid_admin_username(&binding.admin_user)
                && valid_contributor_id(&binding.contributor_id)
                && valid_id(&binding.participant_id)
                && !binding.roles.is_empty()
                && admin_users.insert(binding.admin_user.as_str())
                && contributor_ids.insert(binding.contributor_id.as_str())
                && participant_keys.insert(binding.participant_id.to_ascii_lowercase())
                && binding.roles.iter().all(|role| roles.insert(*role))
        })
    }

    /// Replace the complete publication policy on behalf of the requester in `context`, after an
    /// optimistic revision check. The requester must be allowed [`AuthorizationAction::ManageRoles`]
    /// on their own binding and on every binding the replacement adds, changes, or removes, so
    /// only a site owner can touch a binding that holds or gains `siteOwner`. Only roles can
    /// change: a kept binding keeps its account, registry key, and participant; a new binding
    /// reuses no current account or registry key and cannot take over a participant that the
    /// contract already links to a draft, reveal, or approval. A policy that has a current site
    /// owner must keep one. Returning a new value keeps malformed, stale, unauthorized, or
    /// cross-publication input atomic. The context's target is ignored.
    pub fn replace_from_json(
        &self,
        context: &AuthorizationContext<'_>,
        source: &str,
        expected_revision: u64,
    ) -> Result<Self, AuthorizationError> {
        if self.revision != expected_revision {
            return Err(AuthorizationError);
        }
        let requester = self.requester(context)?;
        let replacement = Self::from_json(source)?;
        if replacement.publication_id != self.publication_id
            || expected_revision.checked_add(1) != Some(replacement.revision)
            || !may_manage(requester, requester)
        {
            return Err(AuthorizationError);
        }
        for current in &self.bindings {
            let allowed = match replacement.binding_for(&current.participant_id) {
                None => may_manage(requester, current),
                Some(next) if !same_identity(current, next) => false,
                Some(next) if same_roles(current, next) => true,
                Some(next) => may_manage(requester, current) && may_manage(requester, next),
            };
            if !allowed {
                return Err(AuthorizationError);
            }
        }
        for next in &replacement.bindings {
            if self.binding_for(&next.participant_id).is_none()
                && (!may_manage(requester, next)
                    || self.bindings.iter().any(|current| {
                        current.admin_user == next.admin_user
                            || current.contributor_id == next.contributor_id
                    })
                    || references_participant(context.collaboration, &next.participant_id))
            {
                return Err(AuthorizationError);
            }
        }
        if self.current_site_owners(context, None) > 0
            && replacement.current_site_owners(context, None) == 0
        {
            return Err(AuthorizationError);
        }
        Ok(replacement)
    }

    /// The binding for a participant, matched ASCII case-insensitively like the contract.
    fn binding_for(&self, participant_id: &str) -> Option<&IdentityBinding> {
        self.bindings
            .iter()
            .find(|binding| binding.participant_id.eq_ignore_ascii_case(participant_id))
    }

    /// Deny by default: the request must come from an active Admin user whose binding in this
    /// publication still resolves to a registry key and a current participant, and one of the
    /// binding's roles must allow `action` on the resolved target. A grant permits the request;
    /// it never records authorship, credit, a reveal, or an approval. The check takes no
    /// revision: the caller must pass the policy and contract it loaded in the same transaction
    /// as the change the grant permits.
    pub fn authorize<'a>(
        &'a self,
        context: &AuthorizationContext<'_>,
        action: AuthorizationAction,
    ) -> Result<&'a IdentityBinding, AuthorizationError> {
        let binding = self.requester(context)?;
        let collaboration = context.collaboration;
        let own = binding.participant_id.as_str();
        let target = match (action.target_kind(), context.target) {
            (TargetKind::Publication, AuthorizationTarget::Publication) => {
                ResolvedTarget::Publication
            }
            (TargetKind::Participant, AuthorizationTarget::Participant(id)) => {
                let participant = collaboration
                    .participants
                    .iter()
                    .find(|participant| participant.id == id)
                    .ok_or(AuthorizationError)?;
                let site_owner = self
                    .bindings
                    .iter()
                    .any(|other| other.participant_id == participant.id && holds_site_owner(other));
                ResolvedTarget::Participant {
                    id: participant.id.as_str(),
                    site_owner,
                    last_site_owner: site_owner
                        && self.current_site_owners(context, Some(participant.id.as_str())) == 0,
                }
            }
            (TargetKind::Contribution, AuthorizationTarget::Contribution(id)) => {
                let contribution = collaboration
                    .contributions
                    .iter()
                    .find(|contribution| contribution.id == id)
                    .ok_or(AuthorizationError)?;
                ResolvedTarget::Contribution {
                    owner: contribution.participant_id.as_str(),
                    revealed_to_requester: collaboration.reveals.iter().any(|reveal| {
                        reveal.contribution_id == contribution.id
                            && reveal.participant_ids.iter().any(|viewer| viewer == own)
                    }),
                }
            }
            _ => return Err(AuthorizationError),
        };
        if binding
            .roles
            .iter()
            .any(|role| role_allows(*role, action, &target, own))
        {
            Ok(binding)
        } else {
            Err(AuthorizationError)
        }
    }

    /// Site-owner bindings that could still authorize a request, other than `except`'s. A binding
    /// whose account, registry key, or participant is gone cannot act, so it never counts as the
    /// site owner a publication must keep.
    fn current_site_owners(
        &self,
        context: &AuthorizationContext<'_>,
        except: Option<&str>,
    ) -> usize {
        self.bindings
            .iter()
            .filter(|binding| {
                holds_site_owner(binding)
                    && except != Some(binding.participant_id.as_str())
                    && is_current(binding, context)
            })
            .count()
    }

    /// The requester's binding, when the policy belongs to the requested publication and the
    /// signed-in account, its contributor key, and its participant are all still current.
    fn requester<'a>(
        &'a self,
        context: &AuthorizationContext<'_>,
    ) -> Result<&'a IdentityBinding, AuthorizationError> {
        if self.publication_id != context.publication_id {
            return Err(AuthorizationError);
        }
        self.bindings
            .iter()
            .find(|binding| binding.admin_user == context.authenticated_admin_user)
            .filter(|binding| is_current(binding, context))
            .ok_or(AuthorizationError)
    }
}

/// Whether a binding's account is an active Admin user, its contributor key is in the registry,
/// and its participant is in the contract.
fn is_current(binding: &IdentityBinding, context: &AuthorizationContext<'_>) -> bool {
    context
        .active_admin_users
        .contains(&binding.admin_user.as_str())
        && context
            .contributor_ids
            .contains(&binding.contributor_id.as_str())
        && context
            .collaboration
            .participants
            .iter()
            .any(|participant| participant.id == binding.participant_id)
}

pub(crate) fn holds_site_owner(binding: &IdentityBinding) -> bool {
    binding.roles.contains(&AuthorizationRole::SiteOwner)
}

/// The identity triple that replacement never changes.
fn same_identity(current: &IdentityBinding, next: &IdentityBinding) -> bool {
    current.admin_user == next.admin_user
        && current.contributor_id == next.contributor_id
        && current.participant_id == next.participant_id
}

/// Roles are a set; `from_json` already rejects repeats, so equal length and containment suffice.
fn same_roles(current: &IdentityBinding, next: &IdentityBinding) -> bool {
    current.roles.len() == next.roles.len()
        && current.roles.iter().all(|role| next.roles.contains(role))
}

/// Whether the contract links a participant to a draft, a reveal, or an approval, matched ASCII
/// case-insensitively. Binding a new account to such a participant would hand it that person's
/// drafts and consent.
fn references_participant(collaboration: &CollaborationContract, participant_id: &str) -> bool {
    let matches = |id: &str| id.eq_ignore_ascii_case(participant_id);
    collaboration
        .contributions
        .iter()
        .any(|contribution| matches(&contribution.participant_id))
        || collaboration
            .reveals
            .iter()
            .any(|reveal| reveal.participant_ids.iter().any(|id| matches(id)))
        || collaboration
            .approvals
            .iter()
            .any(|approval| matches(&approval.participant_id))
}

/// Whether `requester` may manage `binding`. The binding's own `siteOwner` role decides, so a
/// replacement that grants or strips `siteOwner` needs a site owner either way. A binding in a
/// replacement need not resolve in the contract yet, because an accepted invitation adds the
/// participant and the binding in one transaction.
pub(crate) fn may_manage(requester: &IdentityBinding, binding: &IdentityBinding) -> bool {
    let target = ResolvedTarget::Participant {
        id: binding.participant_id.as_str(),
        site_owner: holds_site_owner(binding),
        last_site_owner: false,
    };
    requester.roles.iter().any(|role| {
        role_allows(
            *role,
            AuthorizationAction::ManageRoles,
            &target,
            &requester.participant_id,
        )
    })
}

/// The complete role matrix. Anything not listed is denied, so a new role or action starts with
/// no access.
fn role_allows(
    role: AuthorizationRole,
    action: AuthorizationAction,
    target: &ResolvedTarget<'_>,
    own: &str,
) -> bool {
    use AuthorizationAction::*;
    use AuthorizationRole::*;

    match (role, action, target) {
        (
            SiteOwner | Coordinator | Contributor | Editor | Reader,
            ViewPublication | ViewPublished | Export,
            _,
        ) => true,
        (
            SiteOwner | Coordinator | Contributor | Editor | Reader,
            ViewRevealed,
            ResolvedTarget::Contribution {
                revealed_to_requester,
                ..
            },
        ) => *revealed_to_requester,
        (
            SiteOwner | Coordinator,
            Invite | SetRevealPolicy | SetApprovalPolicy | ArrangeReflection | Schedule | Publish
            | PlaceInSeries,
            _,
        ) => true,
        (SiteOwner, CreateSeries, _) => true,
        (
            SiteOwner,
            RemoveMember,
            ResolvedTarget::Participant {
                last_site_owner, ..
            },
        ) => !last_site_owner,
        (SiteOwner, ManageRoles, ResolvedTarget::Participant { .. }) => true,
        (
            Coordinator,
            RemoveMember | ManageRoles,
            ResolvedTarget::Participant { site_owner, .. },
        ) => !site_owner,
        (
            Contributor,
            ViewContribution | EditContribution | RevealContribution,
            ResolvedTarget::Contribution { owner, .. },
        ) => *owner == own,
        (Contributor | Editor, EditDraft, ResolvedTarget::Participant { id, .. }) => *id == own,
        (
            Contributor,
            ApproveContribution | EditSynthesis | EditMoments | RespondAsAuthor,
            ResolvedTarget::Participant { id, .. },
        ) => *id == own,
        (
            Editor,
            ViewContribution | EditContribution,
            ResolvedTarget::Contribution {
                owner,
                revealed_to_requester,
            },
        ) => *owner == own || *revealed_to_requester,
        _ => false,
    }
}

impl fmt::Display for CollaborationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid collaboration contract")
    }
}

impl std::error::Error for CollaborationError {}

impl CollaborationContract {
    pub fn from_json(source: &str) -> Result<Self, CollaborationError> {
        if source.len() > MAX_CONTRACT_BYTES {
            return Err(CollaborationError::InvalidContract);
        }
        let contract: Self =
            serde_json::from_str(source).map_err(|_| CollaborationError::InvalidContract)?;
        if !contract.is_valid() {
            return Err(CollaborationError::InvalidContract);
        }
        Ok(contract)
    }

    /// Parse a complete replacement only when the caller observed the current revision.
    /// The existing value is never mutated, so parse, validation, or concurrency failures
    /// cannot partially apply participant data.
    pub fn replace_from_json(
        &self,
        source: &str,
        expected_revision: u64,
    ) -> Result<Self, CollaborationError> {
        if self.revision != expected_revision {
            return Err(CollaborationError::InvalidContract);
        }
        let replacement = Self::from_json(source)?;
        if expected_revision.checked_add(1) != Some(replacement.revision) {
            return Err(CollaborationError::InvalidContract);
        }
        Ok(replacement)
    }

    pub fn pair_projection(&self) -> Option<PairProjection<'_>> {
        let [first, second] = self.participants.as_slice() else {
            return None;
        };
        Some(PairProjection { first, second })
    }

    fn is_valid(&self) -> bool {
        if self.version != COLLABORATION_CONTRACT_VERSION
            || self.participants.is_empty()
            || self.participants.len() > MAX_PARTICIPANTS
            || self.contributions.len() > MAX_CONTRIBUTIONS
            || self.reveals.len() > MAX_REVEALS
            || self.layout.len() > MAX_LAYOUT_ITEMS
            || self.approvals.len() > MAX_APPROVALS
        {
            return false;
        }

        let mut participant_ids = HashSet::with_capacity(self.participants.len());
        let mut participant_keys = HashSet::with_capacity(self.participants.len());
        for participant in &self.participants {
            if !valid_id(&participant.id)
                || !participant_ids.insert(participant.id.as_str())
                || !participant_keys.insert(participant.id.to_ascii_lowercase())
                || !valid_text(&participant.display_name, MAX_DISPLAY_NAME_BYTES)
                || participant
                    .profile_url
                    .as_deref()
                    .is_some_and(|url| !valid_profile_url(url))
            {
                return false;
            }
        }

        let mut contribution_ids = HashSet::with_capacity(self.contributions.len());
        let mut contribution_keys = HashSet::with_capacity(self.contributions.len());
        for contribution in &self.contributions {
            if !valid_id(&contribution.id)
                || !contribution_ids.insert(contribution.id.as_str())
                || !contribution_keys.insert(contribution.id.to_ascii_lowercase())
                || !participant_ids.contains(contribution.participant_id.as_str())
                || contribution.markdown.len() > MAX_MARKDOWN_BYTES
                || contribution.markdown.contains('\0')
            {
                return false;
            }
        }

        let mut revealed_contributions = HashSet::with_capacity(self.reveals.len());
        for reveal in &self.reveals {
            let mut viewers = HashSet::with_capacity(reveal.participant_ids.len());
            if !contribution_ids.contains(reveal.contribution_id.as_str())
                || !revealed_contributions.insert(reveal.contribution_id.as_str())
                || reveal.participant_ids.is_empty()
                || reveal.participant_ids.len() > MAX_PARTICIPANTS
                || reveal.participant_ids.iter().any(|id| {
                    !participant_ids.contains(id.as_str()) || !viewers.insert(id.as_str())
                })
            {
                return false;
            }
        }

        let mut laid_out_contributions = HashSet::with_capacity(self.layout.len());
        for item in &self.layout {
            if !contribution_ids.contains(item.contribution_id.as_str())
                || !laid_out_contributions.insert(item.contribution_id.as_str())
                || !valid_slug(&item.region, MAX_REGION_BYTES)
            {
                return false;
            }
        }

        let mut approvers = HashSet::with_capacity(self.approvals.len());
        self.approvals.iter().all(|approval| {
            participant_ids.contains(approval.participant_id.as_str())
                && approvers.insert(approval.participant_id.as_str())
                && approval.revision == self.revision
        })
    }
}

/// One shared publication's private record: its title or guiding question, its ordered source
/// references, and the collaboration contract and authorization policy that belong to it. Keeping
/// them in one versioned record is what ties the policy and the contract to one publication.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SharedPublication {
    pub version: u8,
    pub publication_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guiding_question: Option<String>,
    pub sources: Vec<SourceReference>,
    pub collaboration: CollaborationContract,
    pub authorization: AuthorizationPolicy,
    /// Publication-scoped invitations. They live in the record so accepting one adds the
    /// participant, the binding, and the invitation outcome in one atomic write.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub invitations: Vec<crate::invitation::Invitation>,
    /// Who changed membership and when (ADR 0051). Absent in records written before it existed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub audit: Vec<crate::members::AuditEntry>,
    /// The ordinary series this publication joins (ADR 0038). Absent for every legacy record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<crate::shared_series::SeriesPlacement>,
    /// Counts placement changes, so a change made against an older read is refused (ADR 0039).
    /// Zero, and absent from the file, until the first change.
    #[serde(default, skip_serializing_if = "crate::shared_series::is_zero")]
    pub series_revision: u64,
}

/// Author-entered attribution for material that prompted a shared publication. It is not a
/// citation and never replaces the resulting work's canonical URL or identifier.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SourceReference {
    pub id: String,
    pub kind: SourceKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isbn: Option<String>,
    pub provenance: SourceProvenance,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Video,
    Article,
    Podcast,
    Book,
    #[default]
    Other,
}

impl SourceKind {
    /// The reader-facing name, also the front matter value that publishes this kind.
    pub fn label(self) -> &'static str {
        match self {
            Self::Video => "Video",
            Self::Article => "Article",
            Self::Podcast => "Podcast",
            Self::Book => "Book",
            Self::Other => "Other",
        }
    }

    /// Parse a published kind; anything unrecognised is not a kind.
    pub fn from_label(value: &str) -> Option<Self> {
        [
            Self::Video,
            Self::Article,
            Self::Podcast,
            Self::Book,
            Self::Other,
        ]
        .into_iter()
        .find(|kind| kind.label().eq_ignore_ascii_case(value.trim()))
    }
}

/// Where a source reference's values came from. Version 1 records only what an author typed;
/// optional provider suggestions would need their own provenance and never overwrite it.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceProvenance {
    Author,
}

/// What an authenticated creator submits. Identity fields come from the session and the
/// contributor registry, never from the request body.
#[derive(Clone, Debug, Default)]
pub struct NewSharedPublication {
    pub publication_id: String,
    pub title: String,
    pub guiding_question: String,
    pub sources: Vec<NewSourceReference>,
    pub creator: NewParticipant,
}

#[derive(Clone, Debug, Default)]
pub struct NewSourceReference {
    pub kind: SourceKind,
    pub title: String,
    pub url: String,
    pub creator: String,
    pub publisher: String,
    pub published: String,
    pub isbn: String,
}

#[derive(Clone, Debug, Default)]
pub struct NewParticipant {
    pub admin_user: String,
    pub contributor_id: String,
    pub display_name: String,
}

/// Why a shared publication was refused. Errors name a field and a source position from the
/// requester's own submission, never a submitted value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SharedPublicationError {
    TitleOrQuestionRequired,
    Title,
    GuidingQuestion,
    NoSources,
    TooManySources,
    Source { index: usize, field: SourceField },
    Creator,
    InvalidRecord,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceField {
    Title,
    Url,
    Creator,
    Publisher,
    Published,
    Isbn,
}

impl fmt::Display for SharedPublicationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TitleOrQuestionRequired => {
                formatter.write_str("a shared publication needs a title or a guiding question")
            }
            Self::Title => formatter.write_str("invalid title"),
            Self::GuidingQuestion => formatter.write_str("invalid guiding question"),
            Self::NoSources => formatter.write_str("a shared publication needs a source"),
            Self::TooManySources => formatter.write_str("too many sources"),
            Self::Source { index, field } => {
                let field = match field {
                    SourceField::Title => "title",
                    SourceField::Url => "link",
                    SourceField::Creator => "creator",
                    SourceField::Publisher => "publisher",
                    SourceField::Published => "publication date",
                    SourceField::Isbn => "ISBN",
                };
                write!(formatter, "source {} has an invalid {field}", index + 1)
            }
            Self::Creator => formatter.write_str("the creator cannot be bound"),
            Self::InvalidRecord => formatter.write_str("invalid shared publication record"),
        }
    }
}

impl std::error::Error for SharedPublicationError {}

/// The creator's opaque participant ID. Later participants receive their own IDs; nothing in the
/// record treats the first participant as one half of a pair.
const CREATOR_PARTICIPANT_ID: &str = "participant-1";

impl SharedPublication {
    /// Parse a stored record. Every failure is one non-identifying error.
    pub fn from_json(source: &str) -> Result<Self, SharedPublicationError> {
        if source.len() > MAX_SHARED_PUBLICATION_BYTES {
            return Err(SharedPublicationError::InvalidRecord);
        }
        let record: Self =
            serde_json::from_str(source).map_err(|_| SharedPublicationError::InvalidRecord)?;
        record
            .validate()
            .map_err(|_| SharedPublicationError::InvalidRecord)?;
        Ok(record)
    }

    /// Build the first revision of a shared publication from manual input. Text is trimmed, links
    /// are normalized to ASCII HTTP(S), source IDs follow authored order, and the creator becomes
    /// the only participant, bound as site owner and contributor. Nothing here touches a Post,
    /// Document, credit, or generated output.
    pub fn create(new: &NewSharedPublication) -> Result<Self, SharedPublicationError> {
        let optional = |value: &str| {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        };
        let title = optional(&new.title);
        let guiding_question = optional(&new.guiding_question);
        if title.is_none() && guiding_question.is_none() {
            return Err(SharedPublicationError::TitleOrQuestionRequired);
        }
        let creator = &new.creator;
        let display_name = creator.display_name.trim();
        if !valid_admin_username(&creator.admin_user)
            || !valid_contributor_id(&creator.contributor_id)
            || !valid_text(display_name, MAX_DISPLAY_NAME_BYTES)
        {
            return Err(SharedPublicationError::Creator);
        }
        if new.sources.is_empty() {
            return Err(SharedPublicationError::NoSources);
        }
        if new.sources.len() > MAX_SOURCES {
            return Err(SharedPublicationError::TooManySources);
        }
        let sources = new
            .sources
            .iter()
            .enumerate()
            .map(|(index, source)| {
                let url = match source.url.trim() {
                    "" => None,
                    url => Some(normalize_source_url(url).ok_or(
                        SharedPublicationError::Source {
                            index,
                            field: SourceField::Url,
                        },
                    )?),
                };
                Ok(SourceReference {
                    id: format!("source-{}", index + 1),
                    kind: source.kind,
                    title: source.title.trim().to_string(),
                    url,
                    creator: optional(&source.creator),
                    publisher: optional(&source.publisher),
                    published: optional(&source.published),
                    isbn: optional(&source.isbn),
                    provenance: SourceProvenance::Author,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let record = Self {
            version: SHARED_PUBLICATION_VERSION,
            publication_id: new.publication_id.clone(),
            title,
            guiding_question,
            sources,
            collaboration: CollaborationContract {
                version: COLLABORATION_CONTRACT_VERSION,
                revision: 1,
                participants: vec![Participant {
                    id: CREATOR_PARTICIPANT_ID.into(),
                    display_name: display_name.to_string(),
                    profile_url: None,
                }],
                contributions: Vec::new(),
                reveals: Vec::new(),
                layout: Vec::new(),
                approvals: Vec::new(),
            },
            authorization: AuthorizationPolicy {
                version: COLLABORATION_AUTHORIZATION_VERSION,
                revision: 1,
                publication_id: new.publication_id.clone(),
                bindings: vec![IdentityBinding {
                    admin_user: creator.admin_user.clone(),
                    contributor_id: creator.contributor_id.clone(),
                    participant_id: CREATOR_PARTICIPANT_ID.into(),
                    roles: vec![AuthorizationRole::SiteOwner, AuthorizationRole::Contributor],
                }],
            },
            invitations: Vec::new(),
            audit: Vec::new(),
            series: None,
            series_revision: 0,
        };
        record.validate()?;
        Ok(record)
    }

    /// The one server-side entry point for a collaboration action on this record. It authorizes
    /// the signed-in Admin account against this record's own policy and contract, so a request can
    /// never borrow another publication's grants, and every failure is the same private error.
    /// Callers must load the identities in the same transaction as any change the grant permits.
    pub fn authorize<'a>(
        &'a self,
        admin_user: &str,
        identities: &crate::invitation::Identities<'_>,
        action: AuthorizationAction,
        target: AuthorizationTarget<'_>,
    ) -> Result<&'a IdentityBinding, AuthorizationError> {
        self.authorization.authorize(
            &AuthorizationContext {
                publication_id: &self.publication_id,
                authenticated_admin_user: admin_user,
                active_admin_users: identities.active_admin_users,
                contributor_ids: identities.contributor_ids,
                collaboration: &self.collaboration,
                target,
            },
            action,
        )
    }

    /// Authorizes publishing. The role grant alone is never enough: every participant who owns a
    /// contribution must have approved the current contract revision, so a site owner cannot
    /// publish prose its author has not approved. An unapproved publication reports
    /// [`PublishError::Unapproved`] only to a requester who already holds the publish grant.
    pub fn authorize_publish(
        &self,
        admin_user: &str,
        identities: &crate::invitation::Identities<'_>,
    ) -> Result<(), PublishError> {
        self.authorize(
            admin_user,
            identities,
            AuthorizationAction::Publish,
            AuthorizationTarget::Publication,
        )
        .map_err(|_| PublishError::Denied)?;
        let collaboration = &self.collaboration;
        let approved = |participant_id: &str| {
            collaboration.approvals.iter().any(|approval| {
                approval.participant_id == participant_id
                    && approval.revision == collaboration.revision
            })
        };
        if collaboration
            .contributions
            .iter()
            .all(|contribution| approved(&contribution.participant_id))
        {
            Ok(())
        } else {
            Err(PublishError::Unapproved)
        }
    }

    /// The record without any binding for `admin_user`, with the policy revision advanced, or
    /// `None` when the account holds no binding here. Removing or adding an Admin account calls
    /// this for every record, so a reused username can never inherit an old binding.
    pub fn without_admin_user(&self, admin_user: &str) -> Option<Self> {
        let bound = self
            .authorization
            .bindings
            .iter()
            .any(|binding| binding.admin_user == admin_user);
        let mut record = self.clone();
        let invited =
            crate::invitation::withdraw_for_admin_user(&mut record.invitations, admin_user);
        if !bound && !invited {
            return None;
        }
        if bound {
            record
                .authorization
                .bindings
                .retain(|binding| binding.admin_user != admin_user);
            record.authorization.revision = record.authorization.revision.saturating_add(1);
        }
        Some(record)
    }

    fn validate(&self) -> Result<(), SharedPublicationError> {
        if self.version != SHARED_PUBLICATION_VERSION
            || !valid_id(&self.publication_id)
            || self.authorization.publication_id != self.publication_id
            || !self.collaboration.is_valid()
            || !self.authorization.is_valid()
        {
            return Err(SharedPublicationError::InvalidRecord);
        }
        if !crate::invitation::valid_invitations(self) || !crate::members::valid_audit(&self.audit)
        {
            return Err(SharedPublicationError::InvalidRecord);
        }
        if self.title.is_none() && self.guiding_question.is_none() {
            return Err(SharedPublicationError::TitleOrQuestionRequired);
        }
        if self
            .title
            .as_deref()
            .is_some_and(|title| !valid_text(title, MAX_PUBLICATION_TITLE_BYTES))
        {
            return Err(SharedPublicationError::Title);
        }
        if self
            .guiding_question
            .as_deref()
            .is_some_and(|question| !valid_text(question, MAX_GUIDING_QUESTION_BYTES))
        {
            return Err(SharedPublicationError::GuidingQuestion);
        }
        if self
            .series
            .as_ref()
            .is_some_and(|placement| placement.validate().is_err())
        {
            return Err(SharedPublicationError::InvalidRecord);
        }
        if self.sources.is_empty() {
            return Err(SharedPublicationError::NoSources);
        }
        if self.sources.len() > MAX_SOURCES {
            return Err(SharedPublicationError::TooManySources);
        }
        let mut source_keys = HashSet::with_capacity(self.sources.len());
        for (index, source) in self.sources.iter().enumerate() {
            if !valid_id(&source.id) || !source_keys.insert(source.id.to_ascii_lowercase()) {
                return Err(SharedPublicationError::InvalidRecord);
            }
            let invalid = |field| SharedPublicationError::Source { index, field };
            let detail = |value: &Option<String>, max_bytes| {
                value
                    .as_deref()
                    .is_some_and(|value| !valid_text(value, max_bytes))
            };
            if !valid_text(&source.title, MAX_SOURCE_TITLE_BYTES) {
                return Err(invalid(SourceField::Title));
            }
            if source
                .url
                .as_deref()
                .is_some_and(|url| !valid_source_url(url))
            {
                return Err(invalid(SourceField::Url));
            }
            if detail(&source.creator, MAX_SOURCE_DETAIL_BYTES) {
                return Err(invalid(SourceField::Creator));
            }
            if detail(&source.publisher, MAX_SOURCE_DETAIL_BYTES) {
                return Err(invalid(SourceField::Publisher));
            }
            if detail(&source.published, MAX_SOURCE_DATE_BYTES) {
                return Err(invalid(SourceField::Published));
            }
            if source
                .isbn
                .as_deref()
                .is_some_and(|isbn| source.kind != SourceKind::Book || !valid_isbn(isbn))
            {
                return Err(invalid(SourceField::Isbn));
            }
        }
        Ok(())
    }
}

/// Normalize a pasted source link to the stored form: an absolute HTTP(S) URL with no
/// credentials whose host is punycode and whose path and query are percent-encoded. Control and
/// bidi characters are refused before parsing, because the URL parser would otherwise silently
/// drop tabs and newlines from the middle of a link.
pub fn normalize_source_url(input: &str) -> Option<String> {
    let input = input.trim();
    if input
        .chars()
        .any(|character| character.is_control() || is_bidi_control(character))
    {
        return None;
    }
    let url = url::Url::parse(input).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host().is_none()
    {
        return None;
    }
    let normalized = String::from(url);
    valid_source_url(&normalized).then_some(normalized)
}

/// A stored source link: the contributor profile-link rules for absolute HTTP(S), kept ASCII so
/// a displayed link cannot carry bidi controls or lookalike Unicode hosts.
fn valid_source_url(value: &str) -> bool {
    value.len() <= MAX_SOURCE_URL_BYTES
        && value.is_ascii()
        && value
            .parse::<Uri>()
            .is_ok_and(|uri| matches!(uri.scheme_str(), Some("http" | "https")))
        && contributor::safe_profile_url(value)
}

/// ISBN-10 or ISBN-13 digits, optionally grouped by hyphens or spaces, with `X` only as an
/// ISBN-10 check digit. The checksum is not verified, so a mistyped digit is kept, not lost.
fn valid_isbn(value: &str) -> bool {
    let symbols = value
        .bytes()
        .filter(|byte| !matches!(byte, b'-' | b' '))
        .collect::<Vec<_>>();
    let digits = |symbols: &[u8]| symbols.iter().all(u8::is_ascii_digit);
    match symbols.as_slice() {
        [body @ .., last] if symbols.len() == 10 => {
            digits(body) && (last.is_ascii_digit() || matches!(last, b'X' | b'x'))
        }
        all => all.len() == 13 && digits(all),
    }
}

pub(crate) fn valid_id(value: &str) -> bool {
    valid_slug(value, MAX_IDENTIFIER_BYTES)
}

/// The Admin sign-in username rule, owned here so CLI account creation and a binding's
/// `adminUser` cannot drift apart: every account the CLI creates can be bound, and a binding can
/// never name an account the CLI could not create. A name hand-edited into the users file outside
/// this rule can still sign in but can never be bound, so it fails closed.
pub fn valid_admin_username(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_ADMIN_USERNAME_BYTES
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b'-')
        })
}

/// A binding names an existing contributor registry key, so it uses the registry key rule.
pub(crate) fn valid_contributor_id(value: &str) -> bool {
    value.len() <= MAX_IDENTIFIER_BYTES && contributor::valid_registry_key(value)
}

/// Opaque ASCII identifiers may later key files or URLs, so `.` is only a separator:
/// dot segments such as `.` and `..` can never be expressed, and Windows device stems are
/// refused. Contract collections compare participant and contribution IDs ASCII
/// case-insensitively, so two entries cannot share one key on a case-insensitive filesystem.
fn valid_slug(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && !value.starts_with(['-', '_', '.'])
        && !value.ends_with(['-', '_', '.'])
        && !value.contains("..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        && !is_windows_device_stem(value.split('.').next().unwrap_or(value))
}

fn is_windows_device_stem(stem: &str) -> bool {
    let stem = stem.to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit())
}

/// Identity text keeps ordinary Unicode, including joiners used by scripts and emoji, but
/// rejects controls that could reorder another participant's name or make it invisible.
pub(crate) fn valid_text(value: &str, max_bytes: usize) -> bool {
    value.len() <= max_bytes
        && !value.chars().any(|character| {
            character.is_control() || is_line_break(character) || is_bidi_control(character)
        })
        && value
            .chars()
            .any(|character| !character.is_whitespace() && !is_invisible(character))
}

pub(crate) fn is_bidi_control(character: char) -> bool {
    matches!(
        character,
        '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

/// Unicode line and paragraph separators are not `Cc` controls but still break a name
/// across lines.
fn is_line_break(character: char) -> bool {
    matches!(character, '\u{2028}' | '\u{2029}')
}

/// Default_Ignorable_Code_Point plus blank-rendering fillers. These remain allowed inside a
/// name, where joiners, variation selectors, and emoji tags are legitimate, but a name made only
/// of them would render as nobody.
pub(crate) fn is_invisible(character: char) -> bool {
    matches!(
        character,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{061C}'
            | '\u{115F}'..='\u{1160}'
            | '\u{17B4}'..='\u{17B5}'
            | '\u{180B}'..='\u{180F}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{2800}'
            | '\u{3164}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FEFF}'
            | '\u{FFA0}'
            | '\u{FFF0}'..='\u{FFF8}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D159}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0000}'..='\u{E0FFF}'
    )
}

/// Reuse the contributor profile-link rules, narrowed to absolute HTTPS because a
/// collaboration contract has no site context against which a relative link could resolve.
/// Non-ASCII must be percent-encoded, which keeps bidi controls out of displayed links.
fn valid_profile_url(value: &str) -> bool {
    value.len() <= MAX_PROFILE_URL_BYTES
        && value.is_ascii()
        && value
            .parse::<Uri>()
            .is_ok_and(|uri| uri.scheme_str() == Some("https"))
        && contributor::safe_profile_url(value)
}
