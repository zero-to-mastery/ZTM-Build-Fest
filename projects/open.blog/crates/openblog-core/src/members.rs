//! Member management for a shared publication: who can sign in to it, with which roles.
//!
//! Login access lives in the identity bindings of the authorization policy. Credit lives in the
//! collaboration contract's participants, contributions, and approvals. Changing or ending a
//! member's access edits bindings only; the participant, their drafts, reveals, approvals, and
//! name stay exactly as they were (ADR 0015). Every operation takes the whole record and returns
//! the next one, guarded by the policy revision the requester last saw.

use serde::{Deserialize, Serialize};

use crate::collaboration::{
    valid_id, AuthorizationAction, AuthorizationContext, AuthorizationRole, AuthorizationTarget,
    IdentityBinding, SharedPublication,
};
use crate::invitation::Identities;

/// The most audit entries a record keeps. The oldest go first, so the trail stays bounded.
pub const MAX_AUDIT_ENTRIES: usize = 500;

/// What a membership audit entry records.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuditEvent {
    Invited,
    InvitationRevoked,
    Joined,
    RolesChanged,
    Removed,
}

/// One change to who may act in a publication. It names participants and invitation IDs only,
/// never a token, an account name, a display name, or any prose, so it can be shown to the
/// people who manage members without exposing anything else.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AuditEntry {
    /// Strictly increasing within a record.
    pub seq: u64,
    pub at: i64,
    /// The participant who made the change.
    pub actor: String,
    pub event: AuditEvent,
    /// The participant changed, or the invitation for invitation events.
    pub subject: String,
    /// Roles before the change, when there were any.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub from: Vec<AuthorizationRole>,
    /// Roles after the change, when there are any.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub to: Vec<AuthorizationRole>,
}

/// Structural rules applied whenever a record is read or written.
pub(crate) fn valid_audit(audit: &[AuditEntry]) -> bool {
    audit.len() <= MAX_AUDIT_ENTRIES
        && audit.windows(2).all(|pair| pair[0].seq < pair[1].seq)
        && audit.iter().all(|entry| {
            valid_id(&entry.actor)
                && valid_id(&entry.subject)
                && entry.from.len() <= 5
                && entry.to.len() <= 5
        })
}

impl SharedPublication {
    /// Append an entry, forgetting the oldest when full.
    pub(crate) fn record_audit(
        &mut self,
        at: i64,
        actor: &str,
        event: AuditEvent,
        subject: &str,
        from: &[AuthorizationRole],
        to: &[AuthorizationRole],
    ) {
        let seq = self
            .audit
            .last()
            .map_or(1, |last| last.seq.saturating_add(1));
        if self.audit.len() >= MAX_AUDIT_ENTRIES {
            self.audit.remove(0);
        }
        self.audit.push(AuditEntry {
            seq,
            at,
            actor: actor.to_string(),
            event,
            subject: subject.to_string(),
            from: from.to_vec(),
            to: to.to_vec(),
        });
    }

    /// The membership audit trail, newest first, for a requester who may manage members.
    pub fn audit_for(
        &self,
        requester: &str,
        identities: &Identities<'_>,
    ) -> Result<Vec<&AuditEntry>, MemberError> {
        self.authorize(
            requester,
            identities,
            AuthorizationAction::Invite,
            AuthorizationTarget::Publication,
        )
        .map_err(|_| MemberError::Denied)?;
        Ok(self.audit.iter().rev().collect())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemberError {
    /// The requester may not do this, or the participant is not a member they can see.
    Denied,
    /// The policy changed since the requester loaded it.
    Stale,
    /// The roles are empty or repeat.
    Roles,
    /// The result is not a valid record.
    Invalid,
}

/// One member as the requester may see them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub participant_id: String,
    pub display_name: String,
    pub admin_user: String,
    pub contributor_id: String,
    pub roles: Vec<AuthorizationRole>,
    pub is_you: bool,
    /// Whether the requester may change this member's roles.
    pub can_change_roles: bool,
    /// Whether the requester may end this member's access.
    pub can_remove: bool,
    /// Whether the participant has drafts or approvals that stay credited after access ends.
    pub has_contributions: bool,
    /// False when the sign-in account or contributor profile no longer exists, so the binding
    /// cannot act.
    pub binding_current: bool,
}

impl SharedPublication {
    /// The members, visible to a site owner or coordinator only.
    pub fn members_for(
        &self,
        requester: &str,
        identities: &Identities<'_>,
    ) -> Result<Vec<Member>, MemberError> {
        let me = self
            .authorize(
                requester,
                identities,
                AuthorizationAction::Invite,
                AuthorizationTarget::Publication,
            )
            .map_err(|_| MemberError::Denied)?;
        Ok(self
            .authorization
            .bindings
            .iter()
            .map(|binding| {
                let participant = self
                    .collaboration
                    .participants
                    .iter()
                    .find(|participant| participant.id == binding.participant_id);
                let id = binding.participant_id.as_str();
                Member {
                    participant_id: binding.participant_id.clone(),
                    display_name: participant
                        .map(|participant| participant.display_name.clone())
                        .unwrap_or_default(),
                    admin_user: binding.admin_user.clone(),
                    contributor_id: binding.contributor_id.clone(),
                    roles: binding.roles.clone(),
                    is_you: binding.participant_id == me.participant_id,
                    can_change_roles: self.may(
                        requester,
                        identities,
                        AuthorizationAction::ManageRoles,
                        id,
                    ),
                    can_remove: self.may(
                        requester,
                        identities,
                        AuthorizationAction::RemoveMember,
                        id,
                    ),
                    has_contributions: self
                        .collaboration
                        .contributions
                        .iter()
                        .any(|contribution| contribution.participant_id == id)
                        || self
                            .collaboration
                            .approvals
                            .iter()
                            .any(|approval| approval.participant_id == id),
                    binding_current: participant.is_some()
                        && identities
                            .active_admin_users
                            .contains(&binding.admin_user.as_str())
                        && identities
                            .contributor_ids
                            .contains(&binding.contributor_id.as_str()),
                }
            })
            .collect())
    }

    fn may(
        &self,
        requester: &str,
        identities: &Identities<'_>,
        action: AuthorizationAction,
        participant_id: &str,
    ) -> bool {
        self.authorize(
            requester,
            identities,
            action,
            AuthorizationTarget::Participant(participant_id),
        )
        .is_ok()
    }

    /// Replace one member's roles. The rules of policy replacement apply, so only a site owner
    /// can grant or strip `siteOwner` and the last site owner cannot be demoted.
    pub fn change_member_roles(
        &self,
        requester: &str,
        identities: &Identities<'_>,
        participant_id: &str,
        roles: &[AuthorizationRole],
        expected_revision: u64,
        now: i64,
    ) -> Result<Self, MemberError> {
        let me = self.guard(requester, identities, participant_id, expected_revision)?;
        if roles.is_empty()
            || roles
                .iter()
                .enumerate()
                .any(|(index, role)| roles[..index].contains(role))
        {
            return Err(MemberError::Roles);
        }
        // Submitting the roles a member already holds, in any order, changes nothing: no audit
        // entry and no new revision. Policy replacement lets anyone who manages members resubmit
        // unchanged bindings, so recording these would let a coordinator write false entries
        // about the owner and push real history out of the bounded trail.
        let current = self
            .authorization
            .bindings
            .iter()
            .find(|binding| binding.participant_id == participant_id)
            .map(|binding| binding.roles.as_slice())
            .unwrap_or_default();
        if current.len() == roles.len() && roles.iter().all(|role| current.contains(role)) {
            return Ok(self.clone());
        }
        let mut next = self.clone();
        next.authorization.revision = expected_revision.saturating_add(1);
        let binding = next
            .binding_mut(participant_id)
            .ok_or(MemberError::Denied)?;
        let before = std::mem::replace(&mut binding.roles, roles.to_vec());
        next.record_audit(
            now,
            &me,
            AuditEvent::RolesChanged,
            participant_id,
            &before,
            roles,
        );
        let text = serde_json::to_string(&next.authorization).map_err(|_| MemberError::Invalid)?;
        next.authorization = self
            .authorization
            .replace_from_json(
                &self.context(requester, identities),
                &text,
                expected_revision,
            )
            .map_err(|_| MemberError::Denied)?;
        next.revalidated()
    }

    /// End one member's login access. Their participant, drafts, reveals, approvals, and name
    /// are untouched, so credit for what they wrote stays. The last site owner cannot be removed.
    pub fn remove_member(
        &self,
        requester: &str,
        identities: &Identities<'_>,
        participant_id: &str,
        expected_revision: u64,
        now: i64,
    ) -> Result<Self, MemberError> {
        let me = self.guard(requester, identities, participant_id, expected_revision)?;
        if !self.may(
            requester,
            identities,
            AuthorizationAction::RemoveMember,
            participant_id,
        ) {
            return Err(MemberError::Denied);
        }
        let mut next = self.clone();
        let before = self
            .authorization
            .bindings
            .iter()
            .find(|binding| binding.participant_id == participant_id)
            .map(|binding| binding.roles.clone())
            .unwrap_or_default();
        next.authorization
            .bindings
            .retain(|binding| binding.participant_id != participant_id);
        next.authorization.revision = expected_revision.saturating_add(1);
        next.record_audit(now, &me, AuditEvent::Removed, participant_id, &before, &[]);
        next.revalidated()
    }

    /// Denied comes before stale, so a probe learns nothing about a record it cannot manage.
    fn guard(
        &self,
        requester: &str,
        identities: &Identities<'_>,
        participant_id: &str,
        expected_revision: u64,
    ) -> Result<String, MemberError> {
        let me = self
            .authorize(
                requester,
                identities,
                AuthorizationAction::Invite,
                AuthorizationTarget::Publication,
            )
            .map_err(|_| MemberError::Denied)?
            .participant_id
            .clone();
        if self
            .authorization
            .bindings
            .iter()
            .all(|binding| binding.participant_id != participant_id)
        {
            return Err(MemberError::Denied);
        }
        if self.authorization.revision != expected_revision {
            return Err(MemberError::Stale);
        }
        Ok(me)
    }

    fn context<'a>(
        &'a self,
        requester: &'a str,
        identities: &'a Identities<'a>,
    ) -> AuthorizationContext<'a> {
        AuthorizationContext {
            publication_id: &self.publication_id,
            authenticated_admin_user: requester,
            active_admin_users: identities.active_admin_users,
            contributor_ids: identities.contributor_ids,
            collaboration: &self.collaboration,
            target: AuthorizationTarget::Publication,
        }
    }

    fn binding_mut(&mut self, participant_id: &str) -> Option<&mut IdentityBinding> {
        self.authorization
            .bindings
            .iter_mut()
            .find(|binding| binding.participant_id == participant_id)
    }

    fn revalidated(self) -> Result<Self, MemberError> {
        let text = serde_json::to_string(&self).map_err(|_| MemberError::Invalid)?;
        Self::from_json(&text).map_err(|_| MemberError::Invalid)
    }
}
