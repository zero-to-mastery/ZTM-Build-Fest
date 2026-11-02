//! Publication-scoped invitations to a shared publication.
//!
//! An invitation names the Admin account and contributor registry key it is for, the roles it
//! grants, and an expiry. Its token is shown once to the inviter and only a hash is stored. Every
//! operation takes the whole record and returns the next one, so a caller can write it atomically
//! and a failure changes nothing. Accepting adds the participant, the binding, and the outcome in
//! one step; nothing here sends a message or contacts anyone ([ADR 0013](../../../docs/adr)).

use std::collections::HashSet;

use blake2::{Blake2s256, Digest};
use serde::{Deserialize, Serialize};

use crate::collaboration::{
    may_manage, valid_admin_username, valid_contributor_id, valid_id, valid_text,
    AuthorizationAction, AuthorizationRole, AuthorizationTarget, IdentityBinding, Participant,
    SharedPublication, MAX_DISPLAY_NAME_BYTES, MAX_PARTICIPANTS,
};
use crate::members::AuditEvent;

pub const MAX_INVITATIONS: usize = 100;
pub const DEFAULT_INVITATION_LIFETIME_DAYS: u32 = 7;
pub const MAX_INVITATION_LIFETIME_DAYS: u32 = 30;
const SECONDS_PER_DAY: i64 = 86_400;
const SECRET_HEX_BYTES: usize = 64;
const HASH_DOMAIN: &[u8] = b"openblog-invitation-v1\0";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InvitationState {
    Pending,
    Accepted,
    Declined,
    Revoked,
    Expired,
}

/// One invitation as stored. Only a pending invitation holds a token hash.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Invitation {
    pub id: String,
    pub admin_user: String,
    pub contributor_id: String,
    pub roles: Vec<AuthorizationRole>,
    pub invited_by: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub state: InvitationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<i64>,
    /// The participant an accepted invitation created.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub participant_id: Option<String>,
}

impl Invitation {
    /// The state as of `now`: a pending invitation past its expiry reads as expired.
    pub fn status(&self, now: i64) -> InvitationState {
        if self.state == InvitationState::Pending && now >= self.expires_at {
            InvitationState::Expired
        } else {
            self.state
        }
    }
}

pub struct Identities<'a> {
    pub active_admin_users: &'a [&'a str],
    pub contributor_ids: &'a [&'a str],
}

#[derive(Clone, Debug, Default)]
pub struct NewInvitation {
    /// A fresh opaque invitation ID.
    pub id: String,
    /// 64 lowercase hex characters from the operating system's random source.
    pub secret: String,
    pub admin_user: String,
    pub contributor_id: String,
    pub roles: Vec<AuthorizationRole>,
    /// Zero means the default lifetime.
    pub lifetime_days: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvitationField {
    AdminUser,
    ContributorId,
    Roles,
    Lifetime,
    Capacity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvitationError {
    /// The requester may not do this. Names no identity.
    Denied,
    /// The request is not acceptable for the named field.
    Invalid(InvitationField),
    /// The token is wrong, spent, expired, withdrawn, or for another account. One answer for all
    /// of them, so a probe learns nothing about which.
    Unavailable,
}

impl std::fmt::Display for InvitationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Denied => "collaboration access denied",
            Self::Invalid(_) => "invalid invitation",
            Self::Unavailable => "invitation unavailable",
        })
    }
}

impl std::error::Error for InvitationError {}

/// The token an inviter copies: the publication it is scoped to, then the secret.
pub fn token_for(publication_id: &str, secret: &str) -> String {
    format!("{publication_id}.{secret}")
}

/// The publication a token claims to be for, so a caller can load that record. The claim is only
/// a lookup key; the hash check still binds the secret to the publication.
pub fn token_publication_id(token: &str) -> Option<&str> {
    let (publication_id, secret) = token.split_once('.')?;
    (valid_id(publication_id) && valid_secret(secret)).then_some(publication_id)
}

pub fn hash_token(token: &str) -> String {
    let mut digest = Blake2s256::new();
    digest.update(HASH_DOMAIN);
    digest.update(token.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_secret(value: &str) -> bool {
    value.len() == SECRET_HEX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Structural rules for the stored invitations, applied whenever a record is read or written.
pub(crate) fn valid_invitations(record: &SharedPublication) -> bool {
    let invitations = &record.invitations;
    if invitations.len() > MAX_INVITATIONS {
        return false;
    }
    let mut ids = HashSet::new();
    let mut hashes = HashSet::new();
    let mut pending_users = HashSet::new();
    let mut pending_keys = HashSet::new();
    invitations.iter().all(|invitation| {
        let pending = invitation.state == InvitationState::Pending;
        let hash_ok = match (&invitation.token_hash, pending) {
            (Some(hash), true) => valid_hash(hash) && hashes.insert(hash.as_str()),
            (None, false) => true,
            _ => false,
        };
        let participant_ok = match (&invitation.participant_id, invitation.state) {
            (Some(id), InvitationState::Accepted) => valid_id(id),
            (None, InvitationState::Accepted) => false,
            (None, _) => true,
            _ => false,
        };
        let roles_ok = !invitation.roles.is_empty()
            && invitation.roles.len() <= 5
            && invitation
                .roles
                .iter()
                .enumerate()
                .all(|(index, role)| !invitation.roles[..index].contains(role));
        valid_id(&invitation.id)
            && ids.insert(invitation.id.to_ascii_lowercase())
            && valid_admin_username(&invitation.admin_user)
            && valid_contributor_id(&invitation.contributor_id)
            && valid_id(&invitation.invited_by)
            && roles_ok
            && invitation.expires_at > invitation.created_at
            && invitation.expires_at - invitation.created_at
                <= i64::from(MAX_INVITATION_LIFETIME_DAYS) * SECONDS_PER_DAY
            && hash_ok
            && participant_ok
            && (!pending
                || (pending_users.insert(invitation.admin_user.as_str())
                    && pending_keys.insert(invitation.contributor_id.as_str())))
    })
}

/// Withdraw every pending invitation for an account that was removed or re-created, so the name
/// cannot be reused to redeem an old token. Returns whether anything changed.
pub(crate) fn withdraw_for_admin_user(invitations: &mut [Invitation], admin_user: &str) -> bool {
    let mut changed = false;
    for invitation in invitations.iter_mut() {
        if invitation.state == InvitationState::Pending && invitation.admin_user == admin_user {
            invitation.state = InvitationState::Revoked;
            invitation.token_hash = None;
            changed = true;
        }
    }
    changed
}

fn sweep(invitations: &mut [Invitation], now: i64) {
    for invitation in invitations.iter_mut() {
        if invitation.status(now) == InvitationState::Expired
            && invitation.state == InvitationState::Pending
        {
            invitation.state = InvitationState::Expired;
            invitation.token_hash = None;
            invitation.resolved_at = Some(invitation.expires_at);
        }
    }
}

impl SharedPublication {
    /// The requester's binding when it may invite. Only coordinators and site owners may.
    fn inviter<'a>(
        &'a self,
        admin_user: &'a str,
        identities: &'a Identities<'a>,
    ) -> Result<&'a IdentityBinding, InvitationError> {
        self.authorize(
            admin_user,
            identities,
            AuthorizationAction::Invite,
            AuthorizationTarget::Publication,
        )
        .map_err(|_| InvitationError::Denied)
    }

    /// Whether the requester may grant or withdraw exactly these roles. Reuses the role-management
    /// rule, so a coordinator can never hand out or cancel a site owner invitation.
    fn may_grant(requester: &IdentityBinding, roles: &[AuthorizationRole]) -> bool {
        let prospective = IdentityBinding {
            admin_user: String::new(),
            contributor_id: String::new(),
            participant_id: String::new(),
            roles: roles.to_vec(),
        };
        may_manage(requester, &prospective)
    }

    /// The invitations a requester who may invite can see, newest first. Hashes stay inside.
    pub fn invitations_for(
        &self,
        requester: &str,
        identities: &Identities<'_>,
    ) -> Result<Vec<&Invitation>, InvitationError> {
        self.inviter(requester, identities)?;
        let mut invitations = self.invitations.iter().collect::<Vec<_>>();
        invitations.sort_by_key(|invitation| std::cmp::Reverse(invitation.created_at));
        Ok(invitations)
    }

    /// Start an invitation. Returns the next record and the token to copy; the token is not
    /// stored and cannot be shown again.
    pub fn invite(
        &self,
        requester: &str,
        identities: &Identities<'_>,
        new: &NewInvitation,
        now: i64,
    ) -> Result<(Self, String), InvitationError> {
        let inviter = self.inviter(requester, identities)?;
        let invited_by = inviter.participant_id.clone();
        if !Self::may_grant(inviter, &new.roles) {
            return Err(InvitationError::Denied);
        }
        let mut next = self.clone();
        sweep(&mut next.invitations, now);
        let token = next.add_invitation(&invited_by, identities, new, now)?;
        next.record_audit(
            now,
            &invited_by,
            AuditEvent::Invited,
            &new.id,
            &[],
            &new.roles,
        );
        next.checked().map(|next| (next, token))
    }

    fn add_invitation(
        &mut self,
        invited_by: &str,
        identities: &Identities<'_>,
        new: &NewInvitation,
        now: i64,
    ) -> Result<String, InvitationError> {
        use InvitationError::Invalid;
        let days = if new.lifetime_days == 0 {
            DEFAULT_INVITATION_LIFETIME_DAYS
        } else {
            new.lifetime_days
        };
        if days > MAX_INVITATION_LIFETIME_DAYS {
            return Err(Invalid(InvitationField::Lifetime));
        }
        if new.roles.is_empty()
            || new.roles.len() > 5
            || new
                .roles
                .iter()
                .enumerate()
                .any(|(index, role)| new.roles[..index].contains(role))
        {
            return Err(Invalid(InvitationField::Roles));
        }
        if !valid_admin_username(&new.admin_user)
            || !identities
                .active_admin_users
                .contains(&new.admin_user.as_str())
            || self
                .authorization
                .bindings
                .iter()
                .any(|binding| binding.admin_user == new.admin_user)
            || self.invitations.iter().any(|invitation| {
                invitation.state == InvitationState::Pending
                    && invitation.admin_user == new.admin_user
            })
        {
            return Err(Invalid(InvitationField::AdminUser));
        }
        if !valid_contributor_id(&new.contributor_id)
            || !identities
                .contributor_ids
                .contains(&new.contributor_id.as_str())
            || self
                .authorization
                .bindings
                .iter()
                .any(|binding| binding.contributor_id == new.contributor_id)
            || self.invitations.iter().any(|invitation| {
                invitation.state == InvitationState::Pending
                    && invitation.contributor_id == new.contributor_id
            })
        {
            return Err(Invalid(InvitationField::ContributorId));
        }
        let pending = self
            .invitations
            .iter()
            .filter(|invitation| invitation.state == InvitationState::Pending)
            .count();
        if !valid_id(&new.id)
            || !valid_secret(&new.secret)
            || self
                .invitations
                .iter()
                .any(|invitation| invitation.id.eq_ignore_ascii_case(&new.id))
            || self.collaboration.participants.len() + pending >= MAX_PARTICIPANTS
        {
            return Err(Invalid(InvitationField::Capacity));
        }
        if self.invitations.len() >= MAX_INVITATIONS {
            // Make room by forgetting the oldest finished invitation; pending ones are kept.
            let oldest = self
                .invitations
                .iter()
                .enumerate()
                .filter(|(_, invitation)| invitation.state != InvitationState::Pending)
                .min_by_key(|(_, invitation)| invitation.created_at)
                .map(|(index, _)| index);
            match oldest {
                Some(index) => {
                    self.invitations.remove(index);
                }
                None => return Err(Invalid(InvitationField::Capacity)),
            }
        }
        let token = token_for(&self.publication_id, &new.secret);
        self.invitations.push(Invitation {
            id: new.id.clone(),
            admin_user: new.admin_user.clone(),
            contributor_id: new.contributor_id.clone(),
            roles: new.roles.clone(),
            invited_by: invited_by.to_string(),
            created_at: now,
            expires_at: now + i64::from(days) * SECONDS_PER_DAY,
            state: InvitationState::Pending,
            token_hash: Some(hash_token(&token)),
            resolved_at: None,
            participant_id: None,
        });
        Ok(token)
    }

    /// Withdraw a pending invitation. Its token stops working immediately.
    pub fn revoke_invitation(
        &self,
        requester: &str,
        identities: &Identities<'_>,
        invitation_id: &str,
        now: i64,
    ) -> Result<Self, InvitationError> {
        let inviter = self.inviter(requester, identities)?;
        let actor = inviter.participant_id.clone();
        let mut next = self.clone();
        sweep(&mut next.invitations, now);
        let invitation = next
            .invitations
            .iter_mut()
            .find(|invitation| invitation.id == invitation_id)
            .ok_or(InvitationError::Unavailable)?;
        if invitation.state != InvitationState::Pending {
            return Err(InvitationError::Unavailable);
        }
        if !Self::may_grant(inviter, &invitation.roles) {
            return Err(InvitationError::Denied);
        }
        invitation.state = InvitationState::Revoked;
        invitation.token_hash = None;
        invitation.resolved_at = Some(now);
        let (id, roles) = (invitation.id.clone(), invitation.roles.clone());
        next.record_audit(now, &actor, AuditEvent::InvitationRevoked, &id, &roles, &[]);
        next.checked()
    }

    /// Replace a spent invitation with a fresh one for the same account, key, and roles. The old
    /// token stops working and a new one is returned, in one step.
    pub fn reissue_invitation(
        &self,
        requester: &str,
        identities: &Identities<'_>,
        invitation_id: &str,
        replacement: &NewInvitation,
        now: i64,
    ) -> Result<(Self, String), InvitationError> {
        let inviter = self.inviter(requester, identities)?;
        let invited_by = inviter.participant_id.clone();
        let mut next = self.clone();
        sweep(&mut next.invitations, now);
        let old = next
            .invitations
            .iter_mut()
            .find(|invitation| invitation.id == invitation_id)
            .ok_or(InvitationError::Unavailable)?;
        if old.state == InvitationState::Accepted {
            return Err(InvitationError::Unavailable);
        }
        if !Self::may_grant(inviter, &old.roles) {
            return Err(InvitationError::Denied);
        }
        let revoked =
            (old.state == InvitationState::Pending).then(|| (old.id.clone(), old.roles.clone()));
        if revoked.is_some() {
            old.state = InvitationState::Revoked;
            old.token_hash = None;
            old.resolved_at = Some(now);
        }
        let new = NewInvitation {
            admin_user: old.admin_user.clone(),
            contributor_id: old.contributor_id.clone(),
            roles: old.roles.clone(),
            ..replacement.clone()
        };
        let token = next.add_invitation(&invited_by, identities, &new, now)?;
        if let Some((id, roles)) = revoked {
            next.record_audit(
                now,
                &invited_by,
                AuditEvent::InvitationRevoked,
                &id,
                &roles,
                &[],
            );
        }
        next.record_audit(
            now,
            &invited_by,
            AuditEvent::Invited,
            &new.id,
            &[],
            &new.roles,
        );
        next.checked().map(|next| (next, token))
    }

    /// Redeem a token for the signed-in account. The account must be the one the invitation
    /// names, and `confirmed_contributor_id` must be the key it names, so a token can never bind
    /// another identity silently. Every refusal is [`InvitationError::Unavailable`] and consumes
    /// nothing.
    pub fn accept_invitation(
        &self,
        acceptor: &str,
        identities: &Identities<'_>,
        token: &str,
        confirmed_contributor_id: &str,
        display_name: &str,
        now: i64,
    ) -> Result<Self, InvitationError> {
        let index = self.find_pending(token, acceptor, now)?;
        let invitation = &self.invitations[index];
        // The inviter must still hold the authority that issued the invitation.
        let inviter_current = self
            .authorization
            .bindings
            .iter()
            .find(|binding| binding.participant_id == invitation.invited_by)
            .and_then(|binding| self.inviter(&binding.admin_user, identities).ok())
            .is_some_and(|inviter| Self::may_grant(inviter, &invitation.roles));
        if !inviter_current {
            return Err(InvitationError::Unavailable);
        }
        let participants = &self.collaboration.participants;
        let taken = |id: &str| {
            participants
                .iter()
                .any(|participant| participant.id.eq_ignore_ascii_case(id))
                || self
                    .authorization
                    .bindings
                    .iter()
                    .any(|binding| binding.participant_id.eq_ignore_ascii_case(id))
        };
        let participant_id = (participants.len() + 1..)
            .map(|number| format!("participant-{number}"))
            .find(|id| !taken(id))
            .ok_or(InvitationError::Unavailable)?;
        if invitation.contributor_id != confirmed_contributor_id
            || !identities.active_admin_users.contains(&acceptor)
            || !identities
                .contributor_ids
                .contains(&invitation.contributor_id.as_str())
            || !valid_text(display_name, MAX_DISPLAY_NAME_BYTES)
            || self.authorization.bindings.iter().any(|binding| {
                binding.admin_user == invitation.admin_user
                    || binding.contributor_id == invitation.contributor_id
            })
        {
            return Err(InvitationError::Unavailable);
        }
        let mut next = self.clone();
        let accepted = &mut next.invitations[index];
        accepted.state = InvitationState::Accepted;
        accepted.token_hash = None;
        accepted.resolved_at = Some(now);
        accepted.participant_id = Some(participant_id.clone());
        let binding = IdentityBinding {
            admin_user: accepted.admin_user.clone(),
            contributor_id: accepted.contributor_id.clone(),
            participant_id: participant_id.clone(),
            roles: accepted.roles.clone(),
        };
        next.authorization.bindings.push(binding);
        next.authorization.revision = next.authorization.revision.saturating_add(1);
        next.collaboration.participants.push(Participant {
            id: participant_id,
            display_name: display_name.to_string(),
            profile_url: None,
        });
        next.collaboration.revision = next.collaboration.revision.saturating_add(1);
        let joined = next
            .authorization
            .bindings
            .last()
            .map(|binding| (binding.participant_id.clone(), binding.roles.clone()));
        if let Some((id, roles)) = joined {
            next.record_audit(now, &id, AuditEvent::Joined, &id, &[], &roles);
        }
        next.checked().map_err(|_| InvitationError::Unavailable)
    }

    /// Turn an invitation down. Only the invited account holding the token may.
    pub fn decline_invitation(
        &self,
        decliner: &str,
        token: &str,
        now: i64,
    ) -> Result<Self, InvitationError> {
        let index = self.find_pending(token, decliner, now)?;
        let mut next = self.clone();
        let declined = &mut next.invitations[index];
        declined.state = InvitationState::Declined;
        declined.token_hash = None;
        declined.resolved_at = Some(now);
        next.checked().map_err(|_| InvitationError::Unavailable)
    }

    /// The pending, unexpired invitation that `token` opens for `account`. Compares against every
    /// stored hash without stopping early, so timing reveals nothing about which one matched.
    fn find_pending(&self, token: &str, account: &str, now: i64) -> Result<usize, InvitationError> {
        if token_publication_id(token) != Some(self.publication_id.as_str()) {
            return Err(InvitationError::Unavailable);
        }
        let presented = hash_token(token);
        let mut found = None;
        for (index, invitation) in self.invitations.iter().enumerate() {
            let stored = invitation.token_hash.as_deref().unwrap_or("");
            if constant_time_eq(stored, &presented) {
                found = Some(index);
            }
        }
        let index = found.ok_or(InvitationError::Unavailable)?;
        let invitation = &self.invitations[index];
        if invitation.state != InvitationState::Pending
            || invitation.status(now) != InvitationState::Pending
            || invitation.admin_user != account
        {
            return Err(InvitationError::Unavailable);
        }
        Ok(index)
    }

    fn checked(self) -> Result<Self, InvitationError> {
        let text = serde_json::to_string(&self).map_err(|_| InvitationError::Unavailable)?;
        Self::from_json(&text).map_err(|_| InvitationError::Invalid(InvitationField::Capacity))
    }
}
