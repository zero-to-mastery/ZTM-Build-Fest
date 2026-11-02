//! Approval snapshots: affirmative, attributable, timestamped consent bound to exact content.
//!
//! An approval says one author affirmed that the piece, as they saw it, may be published under
//! the stated policy. It is bound to a digest of exactly what it covers, so it can never carry
//! over to different content: the author's own section revisions (or, under the whole-piece
//! scope, every section revision), plus the frame the piece is published in (the author set,
//! the order and ownership of sections, the public title and source attribution) and the policy
//! revision. Nothing is "invalidated" by a stored flag. An approval counts only while the
//! recomputed binding equals the stored one, so a change nobody thought to hook still fails
//! closed. [`ApprovalSet::reconcile`] additionally drops stale approvals durably, so removing
//! and restoring an author or reverting an edit cannot revive consent given earlier.
//!
//! Only the person approving can approve or withdraw: the requester must equal the participant,
//! so no role, including the site owner, can forge or erase another author's consent. A
//! publish grant never replaces approval (ADR 0014); [`ApprovalSet::evaluate`] is the check the
//! publish gate runs, at publish time, against the content as it is then.
//!
//! The set stores digests, never prose, tokens, or names. Every refusal about another
//! participant is the same [`ApprovalError::Denied`], and a failed call changes nothing.

use std::collections::HashSet;
use std::fmt;

use blake2::{Blake2s256, Digest};
use serde::{Deserialize, Serialize};

use crate::collaboration::{
    valid_id, AuthorizationRole, SharedPublication, MAX_CONTRIBUTIONS, MAX_PARTICIPANTS,
};
use crate::shared_source::SharedAttribution;

pub const APPROVAL_SET_VERSION: u8 = 1;
/// The wording of the consent an approver affirms. Bumping it invalidates older approvals.
pub const CONSENT_VERSION: u8 = 1;
pub const MAX_APPROVAL_SET_BYTES: usize = 64 * 1024;
const BINDING_BYTES: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalError {
    /// The requester may not do this, or the target does not exist for them.
    Denied,
    /// The approver's view of the content is no longer the current content.
    Stale,
    /// The input is malformed, unaffirmed, or exceeds a limit.
    Invalid,
}

impl fmt::Display for ApprovalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Denied => "approval access denied",
            Self::Stale => "the content changed since it was read",
            Self::Invalid => "invalid approval",
        })
    }
}

impl std::error::Error for ApprovalError {}

/// Whose approval publication needs. Under every requirement each author who owns a section, and
/// each author named on a synthesis item, must approve: nobody's words publish without their own
/// consent. The requirement only decides who else must approve as well (ADR 0052).
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalRequirement {
    /// Every author the maintainer added, whether or not they wrote a section.
    #[default]
    AllAuthors,
    /// Only authors who own at least one published section.
    ContributingAuthors,
    /// The contributing authors and these named participants, in canonical (sorted) order. A
    /// named participant who is no longer an author cannot approve, so the piece stays blocked
    /// until someone with the grant changes the rule or restores their access.
    NamedAuthors(Vec<String>),
    /// The contributing authors and every author who holds one of these roles, in canonical
    /// (declaration) order. A listed role that no current author holds blocks the piece, so
    /// losing the person who held it never lowers the bar.
    AuthorsWithRoles(Vec<AuthorizationRole>),
}

/// What an approval covers, which decides which edits invalidate it.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalScope {
    /// The approver's own section revisions. Another author's edit leaves it standing.
    #[default]
    OwnSections,
    /// Every section revision. Any prose edit invalidates every approval.
    WholePiece,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ApprovalPolicy {
    #[serde(default)]
    pub requirement: ApprovalRequirement,
    #[serde(default)]
    pub scope: ApprovalScope,
}

fn role_rank(role: AuthorizationRole) -> u8 {
    match role {
        AuthorizationRole::SiteOwner => 0,
        AuthorizationRole::Coordinator => 1,
        AuthorizationRole::Contributor => 2,
        AuthorizationRole::Editor => 3,
        AuthorizationRole::Reader => 4,
    }
}

impl ApprovalPolicy {
    /// The same policy in its one canonical form: named participants sorted, roles in declaration
    /// order. Two requests that differ only in order are the same policy, so the binding and the
    /// "nothing changed" check never depend on the order someone clicked. Refuses an empty,
    /// repeated (ignoring ASCII case), malformed or oversized list.
    pub fn normalized(mut self) -> Result<Self, ApprovalError> {
        match &mut self.requirement {
            ApprovalRequirement::AllAuthors | ApprovalRequirement::ContributingAuthors => {}
            ApprovalRequirement::NamedAuthors(named) => {
                named.sort_unstable();
                let mut seen = HashSet::new();
                if named.is_empty()
                    || named.len() > MAX_PARTICIPANTS
                    || !named
                        .iter()
                        .all(|id| valid_id(id) && seen.insert(id.to_ascii_lowercase()))
                {
                    return Err(ApprovalError::Invalid);
                }
            }
            ApprovalRequirement::AuthorsWithRoles(roles) => {
                roles.sort_unstable_by_key(|role| role_rank(*role));
                if roles.is_empty() || roles.windows(2).any(|pair| pair[0] == pair[1]) {
                    return Err(ApprovalError::Invalid);
                }
            }
        }
        Ok(self)
    }

    fn is_canonical(&self) -> bool {
        self.clone().normalized().as_ref() == Ok(self)
    }
}

/// A plain label for a publication role, as the approval rule names it.
pub fn role_label(role: AuthorizationRole) -> &'static str {
    match role {
        AuthorizationRole::SiteOwner => "site owner",
        AuthorizationRole::Coordinator => "coordinator",
        AuthorizationRole::Contributor => "contributor",
        AuthorizationRole::Editor => "editor",
        AuthorizationRole::Reader => "reader",
    }
}

/// The role label with its indefinite article ("an editor"), for sentences about a role.
pub fn role_with_article(role: AuthorizationRole) -> String {
    let label = role_label(role);
    let article = if label.starts_with(['a', 'e', 'i', 'o', 'u']) {
        "an"
    } else {
        "a"
    };
    format!("{article} {label}")
}

fn join_names(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {}", rest.join(", "), last),
    }
}

/// The policy in one or two plain sentences, for everyone who reviews or changes it. `names` gives
/// the display names of the participants a named rule lists, in the policy's order.
pub fn describe_policy(policy: &ApprovalPolicy, names: &[String]) -> String {
    const WRITERS: &str = "Everyone who wrote a section or is named on a conversation item";
    let who = match &policy.requirement {
        ApprovalRequirement::AllAuthors => "Every author must approve.".to_string(),
        ApprovalRequirement::ContributingAuthors => format!("{WRITERS} must approve."),
        ApprovalRequirement::NamedAuthors(_) => {
            format!("{WRITERS} must approve, and so must {}.", join_names(names))
        }
        ApprovalRequirement::AuthorsWithRoles(roles) => {
            let roles: Vec<&str> = roles.iter().map(|role| role_label(*role)).collect();
            format!(
                "{WRITERS} must approve, and so must every author with the {} role.",
                roles.join(" or ")
            )
        }
    };
    let scope = match policy.scope {
        ApprovalScope::OwnSections => {
            "An approval covers the approver's own sections and the frame of the piece."
        }
        ApprovalScope::WholePiece => {
            "An approval covers the whole piece, so any edit clears every approval."
        }
    };
    format!("{who} {scope}")
}

/// Why the approval rule cannot be met by the authors as they are now, whatever anyone approves.
/// Holds participant ids and roles only; callers turn ids into display names for people who may
/// see them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleGaps {
    /// Named participants who are not current authors, so they cannot approve.
    pub named: Vec<String>,
    /// Listed roles that no current author holds.
    pub roles: Vec<AuthorizationRole>,
}

impl RuleGaps {
    pub fn is_empty(&self) -> bool {
        self.named.is_empty() && self.roles.is_empty()
    }
}

/// One exact section revision in the piece, in publication order. `digest` is the prose-free
/// digest of the revision (`RevisionStamp::digest`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Section<'a> {
    pub contribution_id: &'a str,
    pub owner: &'a str,
    pub revision: u64,
    pub digest: &'a str,
}

/// The piece as it would be published now: the author set, ordered sections, and public metadata.
#[derive(Clone, Copy, Debug)]
pub struct ApprovalSubject<'a> {
    pub authors: &'a [&'a str],
    pub sections: &'a [Section<'a>],
    pub metadata: &'a [&'a str],
    /// Authors named on a synthesis item (`SynthesisSet::attributed_authors`). Each is a required
    /// approver under every policy, and each must be one of `authors`.
    pub attributed: &'a [&'a str],
    /// The publication roles each author holds, as (author, role) pairs. Only role-based rules
    /// read them; every participant named must be one of `authors`.
    pub roles: &'a [(&'a str, AuthorizationRole)],
}

/// The public, approvable metadata of a record: title and the source attribution that can reach
/// a page. Private source fields and collaboration state are not part of it.
pub fn public_metadata(record: &SharedPublication) -> Vec<String> {
    let mut metadata = vec![record.title.clone().unwrap_or_default()];
    if let Some(attribution) = SharedAttribution::from_record(record) {
        metadata.push(attribution.question.unwrap_or_default());
        if let Some(source) = attribution.source {
            metadata.push(source.title);
            metadata.push(source.url.unwrap_or_default());
            metadata.push(source.kind.label().to_string());
        }
    }
    if let Some(placement) = &record.series {
        metadata.extend(placement.binding_values());
    }
    metadata
}

/// Whose authority a rule change is made under. Both roles hold the policy grant, but only a
/// site owner may drop anyone the rule currently requires (amending ADR 0020, recorded in ADR
/// 0052): a coordinator may only keep or add required approvers, so a coordinator can never
/// take a site owner, or anyone else, out of the people whose consent publication waits on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleAuthority {
    /// May make any rule change, including one that drops required approvers.
    SiteOwner,
    /// May make only changes after which everyone currently required is still required.
    Coordinator,
}

/// What [`ApprovalSet::change_policy`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyChange {
    /// The policy was already this one; nothing changed and no revision was used.
    Unchanged,
    /// The policy changed, its revision advanced, and this many standing approvals were cleared.
    Changed { cleared: usize },
}

/// Why [`ApprovalSet::change_policy`] refused. Nothing changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyError {
    /// The policy changed since the requester read it.
    Stale,
    /// The policy is malformed: an empty, repeated or invalid list.
    Invalid,
    /// A real change was asked for without confirming that it clears every approval.
    Unconfirmed,
    /// The authors as they are now could never meet this rule. `named` lists participants the
    /// rule needs who cannot approve; `roles` lists roles no current author holds.
    Unmeetable(RuleGaps),
    /// A coordinator asked for a change that drops these currently required participants (ids,
    /// in the order the current rule lists them). Only a site owner may make it.
    DropsApprovers(Vec<String>),
}

/// Where one author's approval stands against the content as it is now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalState {
    /// A standing approval whose binding matches the content now.
    Approved,
    /// An approval exists but the content, frame or policy changed since, so it no longer counts.
    Stale,
    /// No approval is stored.
    Awaiting,
}

/// Whether publication may proceed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Readiness {
    Ready,
    /// Participants whose approval is missing or no longer matches the content, and what in the
    /// rule no current author can satisfy. Callers decide who may see either.
    Blocked {
        missing: Vec<String>,
        gaps: RuleGaps,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Approval {
    participant_id: String,
    approved_at: i64,
    consent_version: u8,
    binding: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ApprovalSet {
    version: u8,
    #[serde(default)]
    policy: ApprovalPolicy,
    #[serde(default)]
    policy_revision: u64,
    #[serde(default)]
    approvals: Vec<Approval>,
}

impl Default for ApprovalSet {
    fn default() -> Self {
        Self::new()
    }
}

fn put(hasher: &mut Blake2s256, part: &[u8]) {
    hasher.update((part.len() as u64).to_be_bytes());
    hasher.update(part);
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl ApprovalSubject<'_> {
    fn is_valid(&self) -> bool {
        if self.authors.is_empty()
            || self.authors.len() > MAX_PARTICIPANTS
            || self.sections.is_empty()
            || self.sections.len() > MAX_CONTRIBUTIONS
        {
            return false;
        }
        let mut authors = HashSet::new();
        if self
            .authors
            .iter()
            .any(|id| !valid_id(id) || !authors.insert(id.to_ascii_lowercase()))
        {
            return false;
        }
        if !self.attributed.iter().all(|a| self.authors.contains(a))
            || !self.roles.iter().all(|(a, _)| self.authors.contains(a))
        {
            return false;
        }
        let mut sections = HashSet::new();
        self.sections.iter().all(|section| {
            valid_id(section.contribution_id)
                && sections.insert(section.contribution_id.to_ascii_lowercase())
                && self.authors.contains(&section.owner)
                && section.digest.len() <= BINDING_BYTES
        })
    }

    fn has_author(&self, participant: &str) -> bool {
        self.authors.contains(&participant)
    }

    fn writes_or_is_attributed(&self, author: &str) -> bool {
        self.sections.iter().any(|section| section.owner == author)
            || self.attributed.contains(&author)
    }

    fn holds_role(&self, author: &str, roles: &[AuthorizationRole]) -> bool {
        self.roles
            .iter()
            .any(|(who, role)| *who == author && roles.contains(role))
    }

    /// Everyone whose approval the requirement needs, in author order, then named participants
    /// who are not authors (they can never approve, so they keep the piece blocked).
    fn required<'s>(&'s self, requirement: &'s ApprovalRequirement) -> Vec<&'s str> {
        let mut required: Vec<&str> = self
            .authors
            .iter()
            .copied()
            .filter(|author| match requirement {
                ApprovalRequirement::AllAuthors => true,
                ApprovalRequirement::ContributingAuthors => self.writes_or_is_attributed(author),
                ApprovalRequirement::NamedAuthors(named) => {
                    self.writes_or_is_attributed(author) || named.iter().any(|n| n == author)
                }
                ApprovalRequirement::AuthorsWithRoles(roles) => {
                    self.writes_or_is_attributed(author) || self.holds_role(author, roles)
                }
            })
            .collect();
        if let ApprovalRequirement::NamedAuthors(named) = requirement {
            required.extend(
                named
                    .iter()
                    .map(String::as_str)
                    .filter(|named| !self.has_author(named)),
            );
        }
        required
    }

    fn gaps(&self, requirement: &ApprovalRequirement) -> RuleGaps {
        match requirement {
            ApprovalRequirement::NamedAuthors(named) => RuleGaps {
                named: named
                    .iter()
                    .filter(|named| !self.has_author(named))
                    .cloned()
                    .collect(),
                roles: Vec::new(),
            },
            ApprovalRequirement::AuthorsWithRoles(roles) => RuleGaps {
                named: Vec::new(),
                roles: roles
                    .iter()
                    .copied()
                    .filter(|role| !self.roles.iter().any(|(_, held)| held == role))
                    .collect(),
            },
            _ => RuleGaps::default(),
        }
    }

    fn binding(&self, policy: &ApprovalPolicy, policy_revision: u64, participant: &str) -> String {
        let mut hasher = Blake2s256::new();
        hasher.update(b"openblog-approval-binding-v1\0");
        hasher.update([CONSENT_VERSION]);
        put(&mut hasher, format!("{policy:?}").as_bytes());
        hasher.update(policy_revision.to_be_bytes());
        put(&mut hasher, participant.as_bytes());
        let mut authors = self.authors.to_vec();
        authors.sort_unstable();
        hasher.update((authors.len() as u64).to_be_bytes());
        for author in authors {
            put(&mut hasher, author.as_bytes());
        }
        hasher.update((self.metadata.len() as u64).to_be_bytes());
        for value in self.metadata {
            put(&mut hasher, value.as_bytes());
        }
        // Order and ownership are part of the frame, so reordering invalidates everyone.
        hasher.update((self.sections.len() as u64).to_be_bytes());
        for section in self.sections {
            put(&mut hasher, section.contribution_id.as_bytes());
            put(&mut hasher, section.owner.as_bytes());
        }
        // Prose revisions: only what the scope covers. An author who owns no section has no
        // prose of their own to scope to, so their approval covers the whole piece.
        let owns_prose = self.sections.iter().any(|s| s.owner == participant);
        for section in self.sections {
            if policy.scope == ApprovalScope::WholePiece
                || !owns_prose
                || section.owner == participant
            {
                put(&mut hasher, section.contribution_id.as_bytes());
                hasher.update(section.revision.to_be_bytes());
                put(&mut hasher, section.digest.as_bytes());
            }
        }
        hex(&hasher.finalize())
    }
}

impl ApprovalSet {
    pub fn new() -> Self {
        Self {
            version: APPROVAL_SET_VERSION,
            policy: ApprovalPolicy::default(),
            policy_revision: 0,
            approvals: Vec::new(),
        }
    }

    pub fn from_json(source: &str) -> Result<Self, ApprovalError> {
        if source.len() > MAX_APPROVAL_SET_BYTES {
            return Err(ApprovalError::Invalid);
        }
        let set: Self = serde_json::from_str(source).map_err(|_| ApprovalError::Invalid)?;
        if !set.is_valid() {
            return Err(ApprovalError::Invalid);
        }
        Ok(set)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("an approval set always serializes")
    }

    fn is_valid(&self) -> bool {
        let mut seen = HashSet::new();
        self.version == APPROVAL_SET_VERSION
            && self.approvals.len() <= MAX_PARTICIPANTS
            && self.approvals.iter().all(|approval| {
                valid_id(&approval.participant_id)
                    && seen.insert(approval.participant_id.to_ascii_lowercase())
                    && approval.approved_at >= 0
                    && approval.consent_version == CONSENT_VERSION
                    && approval.binding.len() == BINDING_BYTES
                    && approval
                        .binding
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())
            })
            && self.policy.is_canonical()
    }

    pub fn policy(&self) -> &ApprovalPolicy {
        &self.policy
    }

    /// Advances with every real policy change. A requester names the revision they read when
    /// they change the policy, so a change made in between is refused instead of overwritten.
    pub fn policy_revision(&self) -> u64 {
        self.policy_revision
    }

    /// Change the policy. A real change advances the policy revision and drops every approval,
    /// because consent given under one policy is not consent under another. Setting the current
    /// policy, in any order, changes nothing, and so does a malformed one. Returns whether
    /// anything changed. Routes use [`ApprovalSet::change_policy`], which also checks the
    /// revision, the confirmation and that the rule can be met.
    pub fn set_policy(&mut self, policy: ApprovalPolicy) -> bool {
        let Ok(policy) = policy.normalized() else {
            return false;
        };
        if policy == self.policy {
            return false;
        }
        self.policy = policy;
        self.policy_revision += 1;
        self.approvals.clear();
        true
    }

    /// The token an author's approval would bind to now. An approver reads it with the content
    /// and sends it back as `seen`, so the approval covers what they read, not what exists later.
    pub fn binding_for(
        &self,
        subject: &ApprovalSubject<'_>,
        participant: &str,
    ) -> Result<String, ApprovalError> {
        if !subject.has_author(participant) {
            return Err(ApprovalError::Denied);
        }
        if !subject.is_valid() {
            return Err(ApprovalError::Invalid);
        }
        Ok(subject.binding(&self.policy, self.policy_revision, participant))
    }

    /// Record `participant`'s own approval of the content whose token they read. Only the
    /// participant can approve for themselves, and only as a current author. On any error the
    /// set is unchanged.
    pub fn approve(
        &mut self,
        requester: &str,
        participant: &str,
        subject: &ApprovalSubject<'_>,
        seen: &str,
        affirmed: bool,
        now: i64,
    ) -> Result<(), ApprovalError> {
        if requester != participant || !subject.has_author(participant) {
            return Err(ApprovalError::Denied);
        }
        if !affirmed || now < 0 || !subject.is_valid() {
            return Err(ApprovalError::Invalid);
        }
        let binding = subject.binding(&self.policy, self.policy_revision, participant);
        if seen != binding {
            return Err(ApprovalError::Stale);
        }
        self.approvals
            .retain(|approval| approval.participant_id != participant);
        self.approvals.push(Approval {
            participant_id: participant.to_string(),
            approved_at: now,
            consent_version: CONSENT_VERSION,
            binding,
        });
        Ok(())
    }

    /// A requester who holds the policy grant (checked by the caller through
    /// `SharedPublication::authorize`) changes the policy against the revision they read.
    /// `subject` is the piece as it is now and `approvers` the authors who currently hold the
    /// approve grant. Submitting the current policy, in any order, is a no-op that needs no
    /// confirmation and advances nothing. A real change needs `confirmed`, because it clears every
    /// standing approval, and must be one the authors as they are now could meet: every named
    /// participant, and every author a role rule adds, must be able to approve, and every listed
    /// role must be held by an author. Under [`RuleAuthority::Coordinator`] the change must also
    /// keep everyone the current rule requires of the piece as it is now, including a named
    /// participant who can no longer approve: losing a person never lowers the bar unless a site
    /// owner decides it should. A change never records, keeps or moves an approval. On any error
    /// the set is unchanged.
    pub fn change_policy(
        &mut self,
        policy: ApprovalPolicy,
        expected_revision: u64,
        confirmed: bool,
        authority: RuleAuthority,
        subject: &ApprovalSubject<'_>,
        approvers: &[&str],
    ) -> Result<PolicyChange, PolicyError> {
        if expected_revision != self.policy_revision {
            return Err(PolicyError::Stale);
        }
        let policy = policy.normalized().map_err(|_| PolicyError::Invalid)?;
        if policy == self.policy {
            return Ok(PolicyChange::Unchanged);
        }
        if !confirmed {
            return Err(PolicyError::Unconfirmed);
        }
        if authority == RuleAuthority::Coordinator {
            let after = subject.required(&policy.requirement);
            let dropped = subject
                .required(&self.policy.requirement)
                .into_iter()
                .filter(|before| !after.contains(before))
                .map(str::to_string)
                .collect::<Vec<_>>();
            if !dropped.is_empty() {
                return Err(PolicyError::DropsApprovers(dropped));
            }
        }
        let mut gaps = subject.gaps(&policy.requirement);
        if matches!(
            policy.requirement,
            ApprovalRequirement::NamedAuthors(_) | ApprovalRequirement::AuthorsWithRoles(_)
        ) {
            for needed in subject.required(&policy.requirement) {
                if !subject.writes_or_is_attributed(needed)
                    && !approvers.contains(&needed)
                    && !gaps.named.iter().any(|gap| gap == needed)
                {
                    gaps.named.push(needed.to_string());
                }
            }
        }
        if !gaps.is_empty() {
            return Err(PolicyError::Unmeetable(gaps));
        }
        let cleared = self.approvals.len();
        self.set_policy(policy);
        Ok(PolicyChange::Changed { cleared })
    }

    /// Take back one's own approval. Nobody else can withdraw it. Returns whether one stood.
    pub fn withdraw(&mut self, requester: &str, participant: &str) -> Result<bool, ApprovalError> {
        if requester != participant {
            return Err(ApprovalError::Denied);
        }
        let before = self.approvals.len();
        self.approvals
            .retain(|approval| approval.participant_id != participant);
        Ok(self.approvals.len() != before)
    }

    fn holds(&self, subject: &ApprovalSubject<'_>, participant: &str) -> bool {
        subject.has_author(participant)
            && self.approvals.iter().any(|approval| {
                approval.participant_id == participant
                    && approval.binding
                        == subject.binding(&self.policy, self.policy_revision, participant)
            })
    }

    /// Where `participant`'s approval stands against the content as it is now. A person who is
    /// not an author, or an invalid subject, is `Awaiting`: nothing about them is counted.
    pub fn state(&self, subject: &ApprovalSubject<'_>, participant: &str) -> ApprovalState {
        if !subject.is_valid() || !subject.has_author(participant) {
            return ApprovalState::Awaiting;
        }
        if self.holds(subject, participant) {
            ApprovalState::Approved
        } else if self
            .approvals
            .iter()
            .any(|approval| approval.participant_id == participant)
        {
            ApprovalState::Stale
        } else {
            ApprovalState::Awaiting
        }
    }

    /// Whether the policy needs `participant`'s approval before publication.
    pub fn is_required(&self, subject: &ApprovalSubject<'_>, participant: &str) -> bool {
        subject
            .required(&self.policy.requirement)
            .contains(&participant)
    }

    /// Everyone the policy needs to approve the piece as it is now, in author order, then named
    /// participants who are no longer authors.
    pub fn required(&self, subject: &ApprovalSubject<'_>) -> Vec<String> {
        subject
            .required(&self.policy.requirement)
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    /// What in the policy no current author can satisfy, whatever anyone approves.
    pub fn gaps(&self, subject: &ApprovalSubject<'_>) -> RuleGaps {
        subject.gaps(&self.policy.requirement)
    }

    /// Whether `participant` has a standing approval of the content as it is now.
    pub fn is_approved(&self, subject: &ApprovalSubject<'_>, participant: &str) -> bool {
        subject.is_valid() && self.holds(subject, participant)
    }

    /// Drop every approval that no longer matches the content, including those of people who
    /// are no longer authors. Routes call it in the same write as any change to prose, order,
    /// metadata, or the author set. An invalid subject changes nothing. Returns how many dropped.
    pub fn reconcile(&mut self, subject: &ApprovalSubject<'_>) -> Result<usize, ApprovalError> {
        if !subject.is_valid() {
            return Err(ApprovalError::Invalid);
        }
        let before = self.approvals.len();
        let (policy, revision) = (&self.policy, self.policy_revision);
        self.approvals.retain(|approval| {
            subject.has_author(&approval.participant_id)
                && approval.binding == subject.binding(policy, revision, &approval.participant_id)
        });
        Ok(before - self.approvals.len())
    }

    /// The publish gate's question, asked against the content as it is at that moment, so an
    /// edit between scheduling and publishing blocks publication. Time itself never expires or
    /// renews an approval. An invalid subject is an error, never `Ready`.
    pub fn evaluate(&self, subject: &ApprovalSubject<'_>) -> Result<Readiness, ApprovalError> {
        if !subject.is_valid() {
            return Err(ApprovalError::Invalid);
        }
        // Each required person counts only through their own standing approval: no number of
        // other approvals stands in for a missing one.
        let missing: Vec<String> = subject
            .required(&self.policy.requirement)
            .into_iter()
            .filter(|author| !self.holds(subject, author))
            .map(str::to_string)
            .collect();
        let gaps = subject.gaps(&self.policy.requirement);
        Ok(if missing.is_empty() && gaps.is_empty() {
            Readiness::Ready
        } else {
            Readiness::Blocked { missing, gaps }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_800_000_000;

    struct Piece {
        authors: Vec<&'static str>,
        sections: Vec<(&'static str, &'static str, u64, &'static str)>,
        metadata: Vec<&'static str>,
        roles: Vec<(&'static str, AuthorizationRole)>,
    }

    impl Piece {
        fn new() -> Self {
            Self {
                authors: vec!["ann", "bo"],
                sections: vec![("ann-s", "ann", 1, "d-a1"), ("bo-s", "bo", 1, "d-b1")],
                metadata: vec!["Title", "Question?"],
                roles: Vec::new(),
            }
        }
        fn with<R>(&self, run: impl FnOnce(&ApprovalSubject<'_>) -> R) -> R {
            let sections: Vec<Section<'_>> = self
                .sections
                .iter()
                .map(|(contribution_id, owner, revision, digest)| Section {
                    contribution_id,
                    owner,
                    revision: *revision,
                    digest,
                })
                .collect();
            run(&ApprovalSubject {
                authors: &self.authors,
                sections: &sections,
                metadata: &self.metadata,
                attributed: &[],
                roles: &self.roles,
            })
        }
    }

    fn approve(set: &mut ApprovalSet, piece: &Piece, who: &str) {
        piece.with(|subject| {
            let seen = set.binding_for(subject, who).unwrap();
            set.approve(who, who, subject, &seen, true, T).unwrap();
        });
    }

    fn ready(set: &ApprovalSet, piece: &Piece) -> bool {
        piece.with(|s| set.evaluate(s).unwrap() == Readiness::Ready)
    }

    fn missing(set: &ApprovalSet, piece: &Piece) -> Vec<String> {
        piece.with(|s| match set.evaluate(s).unwrap() {
            Readiness::Blocked { missing, .. } => missing,
            Readiness::Ready => Vec::new(),
        })
    }

    fn both() -> (ApprovalSet, Piece) {
        let mut set = ApprovalSet::new();
        let piece = Piece::new();
        approve(&mut set, &piece, "ann");
        approve(&mut set, &piece, "bo");
        (set, piece)
    }

    fn without_bo() -> Piece {
        let mut piece = Piece::new();
        piece.authors.retain(|a| *a != "bo");
        piece.sections.retain(|s| s.1 != "bo");
        piece
    }

    #[test]
    fn approval_is_affirmative_attributable_timestamped_and_revision_bound() {
        let mut set = ApprovalSet::new();
        let piece = Piece::new();
        assert_eq!(missing(&set, &piece), ["ann", "bo"]);
        piece.with(|s| {
            let seen = set.binding_for(s, "ann").unwrap();
            assert_eq!(
                set.approve("ann", "ann", s, &seen, false, T),
                Err(ApprovalError::Invalid)
            );
            assert!(!set.is_approved(s, "ann"));
            set.approve("ann", "ann", s, &seen, true, T).unwrap();
            assert!(set.is_approved(s, "ann"));
        });
        let json = set.to_json();
        assert!(json.contains("\"participantId\":\"ann\""));
        assert!(json.contains(&format!("\"approvedAt\":{T}")));
        assert!(json.contains("\"consentVersion\":1"));
        assert_eq!(ApprovalSet::from_json(&json).unwrap(), set);
    }

    #[test]
    fn an_edit_invalidates_only_the_owner_under_own_sections_scope() {
        let (set, mut piece) = both();
        assert!(ready(&set, &piece));
        piece.sections[1].2 = 2;
        piece.sections[1].3 = "d-b2";
        assert_eq!(missing(&set, &piece), ["bo"]);
        piece.with(|s| assert!(set.is_approved(s, "ann")));
    }

    #[test]
    fn whole_piece_scope_invalidates_everyone_on_any_prose_edit() {
        let mut set = ApprovalSet::new();
        set.set_policy(ApprovalPolicy {
            scope: ApprovalScope::WholePiece,
            ..Default::default()
        });
        let mut piece = Piece::new();
        approve(&mut set, &piece, "ann");
        approve(&mut set, &piece, "bo");
        assert!(ready(&set, &piece));
        piece.sections[1].3 = "d-b2";
        assert_eq!(missing(&set, &piece), ["ann", "bo"]);
    }

    #[test]
    fn metadata_reorder_and_author_set_changes_invalidate_everyone() {
        let (set, piece) = both();
        let mut renamed = Piece::new();
        renamed.metadata[0] = "Other title";
        assert_eq!(missing(&set, &renamed), ["ann", "bo"]);
        let mut reordered = Piece::new();
        reordered.sections.reverse();
        assert_eq!(missing(&set, &reordered), ["ann", "bo"]);
        let mut joined = Piece::new();
        joined.authors.push("cy");
        assert_eq!(missing(&set, &joined), ["ann", "bo", "cy"]);
        assert_eq!(missing(&set, &without_bo()), ["ann"]);
        assert!(ready(&set, &piece));
    }

    #[test]
    fn removal_and_restore_cannot_revive_consent_once_reconciled() {
        let (mut set, piece) = both();
        without_bo().with(|s| assert_eq!(set.reconcile(s), Ok(2)));
        assert_eq!(missing(&set, &piece), ["ann", "bo"]);
    }

    #[test]
    fn reconcile_keeps_matching_approvals_and_drops_stale_ones() {
        let (mut set, mut piece) = both();
        piece.sections[0].3 = "d-a2";
        piece.with(|s| assert_eq!(set.reconcile(s), Ok(1)));
        piece.sections[0].3 = "d-a1";
        assert_eq!(missing(&set, &piece), ["ann"]);
    }

    #[test]
    fn a_policy_change_drops_approvals_and_cannot_be_reverted_into_consent() {
        let (mut set, piece) = both();
        assert!(!set.set_policy(ApprovalPolicy::default()));
        assert!(ready(&set, &piece));
        assert!(set.set_policy(ApprovalPolicy {
            requirement: ApprovalRequirement::ContributingAuthors,
            ..Default::default()
        }));
        assert!(!ready(&set, &piece));
        set.set_policy(ApprovalPolicy::default());
        assert_eq!(missing(&set, &piece), ["ann", "bo"]);
    }

    #[test]
    fn requirement_policy_decides_who_must_approve() {
        let mut piece = Piece::new();
        piece.authors.push("cy");
        let mut set = ApprovalSet::new();
        approve(&mut set, &piece, "ann");
        approve(&mut set, &piece, "bo");
        assert_eq!(missing(&set, &piece), ["cy"]);
        set.set_policy(ApprovalPolicy {
            requirement: ApprovalRequirement::ContributingAuthors,
            ..Default::default()
        });
        approve(&mut set, &piece, "ann");
        approve(&mut set, &piece, "bo");
        assert!(ready(&set, &piece));
    }

    #[test]
    fn a_non_contributing_authors_approval_covers_the_whole_piece() {
        let mut piece = Piece::new();
        piece.authors.push("cy");
        let mut set = ApprovalSet::new();
        approve(&mut set, &piece, "ann");
        approve(&mut set, &piece, "bo");
        approve(&mut set, &piece, "cy");
        assert!(ready(&set, &piece));
        piece.sections[1].2 = 2;
        piece.sections[1].3 = "d-b2";
        assert_eq!(missing(&set, &piece), ["bo", "cy"]);
        piece.with(|s| assert!(set.is_approved(s, "ann")));
    }

    #[test]
    fn nobody_can_forge_or_erase_another_authors_consent() {
        let mut set = ApprovalSet::new();
        let piece = Piece::new();
        piece.with(|s| {
            let seen = set.binding_for(s, "bo").unwrap();
            for requester in ["ann", "owner", "", "BO"] {
                assert_eq!(
                    set.approve(requester, "bo", s, &seen, true, T),
                    Err(ApprovalError::Denied)
                );
            }
            // A non-author cannot approve even for themselves.
            assert_eq!(
                set.approve("owner", "owner", s, &seen, true, T),
                Err(ApprovalError::Denied)
            );
            assert_eq!(set.binding_for(s, "owner"), Err(ApprovalError::Denied));
        });
        assert_eq!(set, ApprovalSet::new());
        let (mut set, _) = both();
        let before = set.clone();
        assert_eq!(set.withdraw("owner", "bo"), Err(ApprovalError::Denied));
        assert_eq!(set.withdraw("ann", "bo"), Err(ApprovalError::Denied));
        assert_eq!(set, before);
    }

    #[test]
    fn a_stale_view_is_refused_without_changing_anything() {
        let mut set = ApprovalSet::new();
        let mut piece = Piece::new();
        let seen = piece.with(|s| set.binding_for(s, "ann").unwrap());
        piece.sections[0].3 = "d-a2";
        piece.with(|s| {
            assert_eq!(
                set.approve("ann", "ann", s, &seen, true, T),
                Err(ApprovalError::Stale)
            );
            assert_eq!(
                set.approve("ann", "ann", s, "junk", true, T),
                Err(ApprovalError::Stale)
            );
        });
        assert_eq!(set, ApprovalSet::new());
    }

    #[test]
    fn withdrawal_and_reapproval() {
        let (mut set, piece) = both();
        assert_eq!(set.withdraw("bo", "bo"), Ok(true));
        assert_eq!(set.withdraw("bo", "bo"), Ok(false));
        assert_eq!(missing(&set, &piece), ["bo"]);
        approve(&mut set, &piece, "bo");
        assert!(ready(&set, &piece));
    }

    #[test]
    fn an_edit_between_scheduling_and_publishing_blocks_and_time_changes_nothing() {
        let (set, mut piece) = both();
        // Scheduled: the approvals stand however long the delay is.
        assert!(ready(&set, &piece));
        // Publish time: the content changed since.
        piece.sections[0].2 = 2;
        piece.sections[0].3 = "d-a2";
        assert_eq!(missing(&set, &piece), ["ann"]);
    }

    #[test]
    fn invalid_subjects_never_read_as_ready() {
        let (mut set, piece) = both();
        let before = set.clone();
        let cases: [fn(&mut Piece); 5] = [
            |p| p.authors.clear(),
            |p| p.sections.clear(),
            |p| p.sections[0].1 = "stranger",
            |p| p.sections[1].0 = "ann-s",
            |p| p.authors.push("ANN"),
        ];
        for mutate in cases {
            let mut broken = Piece::new();
            mutate(&mut broken);
            broken.with(|s| {
                assert_eq!(set.evaluate(s), Err(ApprovalError::Invalid));
                assert_eq!(set.reconcile(s), Err(ApprovalError::Invalid));
                assert!(!set.is_approved(s, "ann"));
            });
        }
        assert_eq!(set, before);
        assert!(ready(&set, &piece));
    }

    #[test]
    fn untrusted_stored_data_fails_to_load() {
        let (set, _) = both();
        let good = set.to_json();
        assert!(ApprovalSet::from_json(&good).is_ok());
        let at = good.find("\"binding\":\"").unwrap() + 11;
        let short = format!("{}ab{}", &good[..at], &good[at + 64..]);
        for bad in [
            good.replace("\"ann\"", "\"an n\""),
            short,
            good.replace("\"version\":1", "\"version\":2"),
            good.replace("\"consentVersion\":1", "\"consentVersion\":9"),
            good.replace("\"approvedAt\":1800000000", "\"approvedAt\":-1"),
            good.replace("}]}", "}],\"extra\":1}"),
            good.replace("\"participantId\":\"bo\"", "\"participantId\":\"ANN\""),
            "{".to_string(),
            "x".repeat(MAX_APPROVAL_SET_BYTES + 1),
        ] {
            assert_eq!(
                ApprovalSet::from_json(&bad),
                Err(ApprovalError::Invalid),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_stored_set_holds_no_prose_names_or_revision_digests() {
        let (set, _) = both();
        let json = set.to_json();
        for secret in ["Title", "Question?", "d-a1", "d-b1", "ann-s"] {
            assert!(!json.contains(secret), "{secret}");
        }
        assert!(!format!("{set:?}").contains("Question?"));
    }

    #[test]
    fn public_metadata_follows_only_the_public_attribution() {
        use crate::collaboration::{
            NewParticipant, NewSharedPublication, NewSourceReference, SourceKind,
        };
        let mut record = SharedPublication::create(&NewSharedPublication {
            publication_id: "pub".into(),
            title: "T".into(),
            guiding_question: "Q?".into(),
            sources: vec![NewSourceReference {
                kind: SourceKind::Article,
                title: "Src".into(),
                url: "https://example.com/a".into(),
                creator: "Private Creator".into(),
                ..Default::default()
            }],
            creator: NewParticipant {
                admin_user: "owner".into(),
                contributor_id: "owner".into(),
                display_name: "Owner".into(),
            },
        })
        .unwrap();
        let before = public_metadata(&record);
        assert_eq!(&before[..4], ["T", "Q?", "Src", "https://example.com/a"]);
        assert!(!before.concat().contains("Private Creator"));
        record.collaboration.revision += 1;
        record.sources[0].creator = Some("Someone Else".into());
        assert_eq!(public_metadata(&record), before);
        record.guiding_question = Some("Other?".into());
        assert_ne!(public_metadata(&record), before);
    }

    fn named(ids: &[&str]) -> ApprovalPolicy {
        ApprovalPolicy {
            requirement: ApprovalRequirement::NamedAuthors(
                ids.iter().map(|id| id.to_string()).collect(),
            ),
            ..Default::default()
        }
    }

    fn with_roles(roles: &[AuthorizationRole]) -> ApprovalPolicy {
        ApprovalPolicy {
            requirement: ApprovalRequirement::AuthorsWithRoles(roles.to_vec()),
            ..Default::default()
        }
    }

    /// Ann and Bo wrote; Cy wrote nothing and owns the site; Di only edits.
    fn group() -> Piece {
        let mut piece = Piece::new();
        piece.authors.extend(["cy", "di"]);
        piece.roles = vec![
            ("ann", AuthorizationRole::Contributor),
            ("bo", AuthorizationRole::Contributor),
            ("cy", AuthorizationRole::SiteOwner),
            ("cy", AuthorizationRole::Contributor),
            ("di", AuthorizationRole::Editor),
        ];
        piece
    }

    fn change(
        set: &mut ApprovalSet,
        piece: &Piece,
        policy: ApprovalPolicy,
        approvers: &[&str],
    ) -> Result<PolicyChange, PolicyError> {
        let revision = set.policy_revision();
        piece.with(|s| {
            set.change_policy(
                policy,
                revision,
                true,
                RuleAuthority::SiteOwner,
                s,
                approvers,
            )
        })
    }

    const APPROVERS: [&str; 3] = ["ann", "bo", "cy"];

    #[test]
    fn writers_always_approve_and_named_or_role_rules_only_add_people() {
        let piece = group();
        let mut set = ApprovalSet::new();
        // All authors: an editor who cannot approve blocks, as before (ADR 0022).
        assert_eq!(missing(&set, &piece), ["ann", "bo", "cy", "di"]);
        set.set_policy(named(&["cy"]));
        assert_eq!(missing(&set, &piece), ["ann", "bo", "cy"]);
        set.set_policy(with_roles(&[AuthorizationRole::SiteOwner]));
        assert_eq!(missing(&set, &piece), ["ann", "bo", "cy"]);
        // A role rule that matches nobody but writers still needs every writer.
        set.set_policy(with_roles(&[AuthorizationRole::Contributor]));
        assert_eq!(missing(&set, &piece), ["ann", "bo", "cy"]);
        // A named rule cannot leave out a writer: their words need their own consent.
        set.set_policy(named(&["cy"]));
        piece.with(|s| {
            assert!(set.is_required(s, "ann"));
            assert!(!set.is_required(s, "di"));
            assert_eq!(set.required(s), ["ann", "bo", "cy"]);
        });
    }

    #[test]
    fn a_rule_never_fabricates_an_individual_approval() {
        let piece = group();
        let mut set = ApprovalSet::new();
        set.set_policy(named(&["cy"]));
        approve(&mut set, &piece, "ann");
        approve(&mut set, &piece, "bo");
        // Two of three is not three: the named approver is still missing.
        assert_eq!(missing(&set, &piece), ["cy"]);
        approve(&mut set, &piece, "cy");
        assert!(ready(&set, &piece));
        // Di was not required and is not counted as approving: no approval exists for them, and
        // the stored set holds exactly the three people who approved.
        piece.with(|s| {
            assert_eq!(set.state(s, "di"), ApprovalState::Awaiting);
            assert!(!set.is_approved(s, "di"));
        });
        let stored: Vec<_> = set
            .approvals
            .iter()
            .map(|a| a.participant_id.as_str())
            .collect();
        assert_eq!(stored, ["ann", "bo", "cy"]);
        // An author holding two listed roles is one approver, counted once.
        let mut set = ApprovalSet::new();
        set.set_policy(with_roles(&[
            AuthorizationRole::SiteOwner,
            AuthorizationRole::Contributor,
        ]));
        approve(&mut set, &piece, "ann");
        approve(&mut set, &piece, "bo");
        assert_eq!(missing(&set, &piece), ["cy"]);
    }

    #[test]
    fn policies_have_one_canonical_form_and_malformed_ones_are_refused() {
        assert_eq!(
            named(&["bo", "ann"]).normalized().unwrap(),
            named(&["ann", "bo"])
        );
        assert_eq!(
            with_roles(&[AuthorizationRole::Editor, AuthorizationRole::SiteOwner])
                .normalized()
                .unwrap(),
            with_roles(&[AuthorizationRole::SiteOwner, AuthorizationRole::Editor])
        );
        for bad in [
            named(&[]),
            named(&["ann", "ANN"]),
            named(&["not valid"]),
            with_roles(&[]),
            with_roles(&[AuthorizationRole::Editor, AuthorizationRole::Editor]),
        ] {
            assert_eq!(
                bad.clone().normalized(),
                Err(ApprovalError::Invalid),
                "{bad:?}"
            );
            let mut set = ApprovalSet::new();
            assert!(!set.set_policy(bad));
            assert_eq!(set, ApprovalSet::new());
        }
        // A stored policy that is not canonical does not load.
        let mut set = ApprovalSet::new();
        set.set_policy(named(&["ann", "bo"]));
        let good = set.to_json();
        assert!(good.contains("\"namedAuthors\":[\"ann\",\"bo\"]"));
        assert_eq!(ApprovalSet::from_json(&good).unwrap(), set);
        let reordered = good.replace("[\"ann\",\"bo\"]", "[\"bo\",\"ann\"]");
        assert_eq!(
            ApprovalSet::from_json(&reordered),
            Err(ApprovalError::Invalid)
        );
        assert_eq!(
            ApprovalSet::from_json(&good.replace("[\"ann\",\"bo\"]", "[]")),
            Err(ApprovalError::Invalid)
        );
        // A set written before rules existed still loads with its approvals intact.
        let (legacy, piece) = both();
        let legacy = ApprovalSet::from_json(&legacy.to_json()).unwrap();
        assert!(ready(&legacy, &piece));
    }

    #[test]
    fn changing_the_policy_needs_the_current_revision_and_a_confirmation() {
        let piece = group();
        let mut set = ApprovalSet::new();
        approve(&mut set, &piece, "ann");
        let before = set.clone();
        piece.with(|s| {
            // A stale revision, a missing confirmation and a malformed policy change nothing.
            assert_eq!(
                set.change_policy(
                    named(&["cy"]),
                    7,
                    true,
                    RuleAuthority::SiteOwner,
                    s,
                    &APPROVERS
                ),
                Err(PolicyError::Stale)
            );
            assert_eq!(
                set.change_policy(
                    named(&["cy"]),
                    0,
                    false,
                    RuleAuthority::SiteOwner,
                    s,
                    &APPROVERS
                ),
                Err(PolicyError::Unconfirmed)
            );
            assert_eq!(
                set.change_policy(named(&[]), 0, true, RuleAuthority::SiteOwner, s, &APPROVERS),
                Err(PolicyError::Invalid)
            );
            // Resubmitting the current policy is a no-op without a confirmation.
            assert_eq!(
                set.change_policy(
                    ApprovalPolicy::default(),
                    0,
                    false,
                    RuleAuthority::SiteOwner,
                    s,
                    &APPROVERS
                ),
                Ok(PolicyChange::Unchanged)
            );
        });
        assert_eq!(set, before);
        // A real change clears every approval and advances the revision once.
        assert_eq!(
            change(&mut set, &piece, named(&["cy"]), &APPROVERS),
            Ok(PolicyChange::Changed { cleared: 1 })
        );
        assert_eq!(set.policy_revision(), 1);
        assert_eq!(missing(&set, &piece), ["ann", "bo", "cy"]);
        // The same rule in another order is the same rule.
        assert_eq!(
            change(&mut set, &piece, named(&["cy"]), &APPROVERS),
            Ok(PolicyChange::Unchanged)
        );
        assert_eq!(set.policy_revision(), 1);
    }

    #[test]
    fn a_coordinator_may_keep_or_add_required_approvers_but_never_drop_one() {
        let piece = group();
        let coordinator = |set: &mut ApprovalSet, policy: ApprovalPolicy| {
            let revision = set.policy_revision();
            piece.with(|s| {
                set.change_policy(
                    policy,
                    revision,
                    true,
                    RuleAuthority::Coordinator,
                    s,
                    &APPROVERS,
                )
            })
        };
        let mut set = ApprovalSet::new();
        set.set_policy(ApprovalPolicy {
            requirement: ApprovalRequirement::ContributingAuthors,
            ..Default::default()
        });
        // Adding the site owner who wrote nothing keeps Ann and Bo and adds Cy.
        assert_eq!(
            coordinator(&mut set, named(&["cy"])),
            Ok(PolicyChange::Changed { cleared: 0 })
        );
        // The same people under another rule, or another scope, drop nobody.
        assert_eq!(
            coordinator(&mut set, with_roles(&[AuthorizationRole::SiteOwner])),
            Ok(PolicyChange::Changed { cleared: 0 })
        );
        let whole = ApprovalPolicy {
            scope: ApprovalScope::WholePiece,
            ..with_roles(&[AuthorizationRole::SiteOwner])
        };
        assert_eq!(
            coordinator(&mut set, whole.clone()),
            Ok(PolicyChange::Changed { cleared: 0 })
        );
        // Taking the non-writing site owner out again needs a site owner, and changes nothing.
        approve(&mut set, &piece, "ann");
        let before = set.clone();
        let only_writers = ApprovalPolicy {
            requirement: ApprovalRequirement::ContributingAuthors,
            scope: ApprovalScope::WholePiece,
        };
        assert_eq!(
            coordinator(&mut set, only_writers.clone()),
            Err(PolicyError::DropsApprovers(vec!["cy".to_string()]))
        );
        assert_eq!(set, before);
        assert_eq!(
            change(&mut set, &piece, only_writers, &APPROVERS),
            Ok(PolicyChange::Changed { cleared: 1 })
        );
        // Every author (Di only edits, so cannot approve) to a named rule drops Di.
        let mut set = ApprovalSet::new();
        assert_eq!(
            coordinator(&mut set, named(&["cy"])),
            Err(PolicyError::DropsApprovers(vec!["di".to_string()]))
        );
        // A named participant who is no longer an author is still required: a coordinator cannot
        // clear them, even with a replacement, but a site owner can.
        let mut set = ApprovalSet::new();
        set.set_policy(named(&["zed"]));
        assert_eq!(
            coordinator(&mut set, named(&["cy"])),
            Err(PolicyError::DropsApprovers(vec!["zed".to_string()]))
        );
        assert_eq!(
            coordinator(&mut set, named(&["cy", "zed"])),
            Err(PolicyError::Unmeetable(RuleGaps {
                named: vec!["zed".to_string()],
                roles: Vec::new(),
            }))
        );
        assert_eq!(
            change(&mut set, &piece, named(&["cy"]), &APPROVERS),
            Ok(PolicyChange::Changed { cleared: 0 })
        );
    }

    #[test]
    fn two_changes_from_one_revision_cannot_both_land() {
        let piece = group();
        let mut set = ApprovalSet::new();
        let read = set.policy_revision();
        piece.with(|s| {
            set.change_policy(
                named(&["cy"]),
                read,
                true,
                RuleAuthority::SiteOwner,
                s,
                &APPROVERS,
            )
            .unwrap();
            assert_eq!(
                set.change_policy(
                    with_roles(&[AuthorizationRole::SiteOwner]),
                    read,
                    true,
                    RuleAuthority::SiteOwner,
                    s,
                    &APPROVERS
                ),
                Err(PolicyError::Stale)
            );
        });
        assert_eq!(set.policy(), &named(&["cy"]));
    }

    #[test]
    fn a_rule_the_authors_could_never_meet_is_refused() {
        let piece = group();
        let mut set = ApprovalSet::new();
        let before = set.clone();
        // Di edits but cannot approve; "zed" is not an author; nobody is a coordinator.
        assert_eq!(
            change(&mut set, &piece, named(&["di", "zed"]), &APPROVERS),
            Err(PolicyError::Unmeetable(RuleGaps {
                named: vec!["zed".into(), "di".into()],
                roles: vec![],
            }))
        );
        assert_eq!(
            change(
                &mut set,
                &piece,
                with_roles(&[AuthorizationRole::Coordinator]),
                &APPROVERS
            ),
            Err(PolicyError::Unmeetable(RuleGaps {
                named: vec![],
                roles: vec![AuthorizationRole::Coordinator],
            }))
        );
        assert_eq!(
            change(
                &mut set,
                &piece,
                with_roles(&[AuthorizationRole::Editor]),
                &APPROVERS
            ),
            Err(PolicyError::Unmeetable(RuleGaps {
                named: vec!["di".into()],
                roles: vec![],
            }))
        );
        assert_eq!(set, before);
    }

    #[test]
    fn losing_a_named_approver_or_the_only_role_holder_blocks_instead_of_lowering_the_bar() {
        let mut set = ApprovalSet::new();
        set.set_policy(named(&["cy"]));
        let full = group();
        for who in ["ann", "bo", "cy"] {
            approve(&mut set, &full, who);
        }
        assert!(ready(&set, &full));
        // Cy loses access: the author set changed, so everyone approves again, and nobody's
        // approval can ever cover for the named approver who is gone.
        let mut without_cy = group();
        without_cy.authors.retain(|a| *a != "cy");
        without_cy.roles.retain(|(a, _)| *a != "cy");
        without_cy.with(|s| {
            assert_eq!(
                set.evaluate(s).unwrap(),
                Readiness::Blocked {
                    missing: vec!["ann".into(), "bo".into(), "cy".into()],
                    gaps: RuleGaps {
                        named: vec!["cy".into()],
                        roles: vec![],
                    },
                }
            );
        });
        // A role rule whose only holder leaves is blocked the same way, not satisfied by nobody.
        let mut set = ApprovalSet::new();
        set.set_policy(with_roles(&[AuthorizationRole::SiteOwner]));
        without_cy.with(|s| {
            assert_eq!(
                set.evaluate(s).unwrap(),
                Readiness::Blocked {
                    missing: vec!["ann".into(), "bo".into()],
                    gaps: RuleGaps {
                        named: vec![],
                        roles: vec![AuthorizationRole::SiteOwner],
                    },
                }
            );
            assert_eq!(set.gaps(s).roles, [AuthorizationRole::SiteOwner]);
        });
        // The resolution: someone with the grant changes the rule to one the authors can meet.
        assert_eq!(
            change(
                &mut set,
                &without_cy,
                ApprovalPolicy {
                    requirement: ApprovalRequirement::ContributingAuthors,
                    ..Default::default()
                },
                &["ann", "bo"]
            ),
            Ok(PolicyChange::Changed { cleared: 0 })
        );
        approve(&mut set, &without_cy, "ann");
        approve(&mut set, &without_cy, "bo");
        assert!(ready(&set, &without_cy));
    }

    #[test]
    fn an_approval_read_under_an_older_policy_is_stale() {
        let piece = group();
        let mut set = ApprovalSet::new();
        let seen = piece.with(|s| set.binding_for(s, "ann").unwrap());
        change(&mut set, &piece, named(&["cy"]), &APPROVERS).unwrap();
        piece.with(|s| {
            assert_eq!(
                set.approve("ann", "ann", s, &seen, true, T),
                Err(ApprovalError::Stale)
            );
        });
        // Changing back does not revive the old token: the revision moved on.
        change(&mut set, &piece, ApprovalPolicy::default(), &APPROVERS).unwrap();
        piece.with(|s| {
            assert_eq!(
                set.approve("ann", "ann", s, &seen, true, T),
                Err(ApprovalError::Stale)
            );
        });
        assert_eq!(set.policy_revision(), 2);
    }

    #[test]
    fn role_pairs_must_name_authors() {
        let mut piece = group();
        piece.roles.push(("stranger", AuthorizationRole::SiteOwner));
        let set = ApprovalSet::new();
        piece.with(|s| assert_eq!(set.evaluate(s), Err(ApprovalError::Invalid)));
    }

    #[test]
    fn the_rule_reads_as_plain_words() {
        assert_eq!(
            describe_policy(&ApprovalPolicy::default(), &[]),
            "Every author must approve. An approval covers the approver's own sections and the frame of the piece."
        );
        assert!(describe_policy(&named(&["a", "b"]), &["Ada".into(), "Bo".into()])
            .starts_with("Everyone who wrote a section or is named on a conversation item must approve, and so must Ada and Bo."));
        assert!(describe_policy(
            &with_roles(&[AuthorizationRole::SiteOwner, AuthorizationRole::Coordinator]),
            &[]
        )
        .contains("every author with the site owner or coordinator role."));
    }
}
