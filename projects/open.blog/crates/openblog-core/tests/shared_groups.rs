//! Groups of more than two: invitations, roles, removal, bounds, and the membership audit trail
//! (ADR 0051).

use openblog_core::collaboration::{
    AuthorizationAction, AuthorizationRole, AuthorizationTarget, NewParticipant,
    NewSharedPublication, NewSourceReference, SharedPublication, SourceKind, MAX_PARTICIPANTS,
};
use openblog_core::invitation::{Identities, InvitationError, InvitationField, NewInvitation};
use openblog_core::members::{AuditEvent, MemberError, MAX_AUDIT_ENTRIES};
use AuthorizationRole::{Contributor, Coordinator, Editor, Reader, SiteOwner};

const NOW: i64 = 1_800_000_000;
const USERS: [&str; 6] = [
    "ada-admin",
    "grace-admin",
    "linus-admin",
    "kay-admin",
    "ida-admin",
    "sam-admin",
];
const KEYS: [&str; 6] = ["ada", "grace", "linus", "kay", "ida", "sam"];

fn identities() -> Identities<'static> {
    Identities {
        active_admin_users: &USERS,
        contributor_ids: &KEYS,
    }
}

fn new_invitation(user: &str, key: &str, roles: &[AuthorizationRole], seed: char) -> NewInvitation {
    NewInvitation {
        id: format!("invitation-{seed}{seed}{seed}"),
        secret: seed.to_string().repeat(64),
        admin_user: user.into(),
        contributor_id: key.into(),
        roles: roles.to_vec(),
        lifetime_days: 0,
    }
}

fn join(
    base: &SharedPublication,
    user: &str,
    key: &str,
    roles: &[AuthorizationRole],
    seed: char,
) -> SharedPublication {
    let new = new_invitation(user, key, roles, seed);
    let (invited, token) = base.invite("ada-admin", &identities(), &new, NOW).unwrap();
    invited
        .accept_invitation(user, &identities(), &token, key, key, NOW)
        .unwrap()
}

fn solo() -> SharedPublication {
    SharedPublication::create(&NewSharedPublication {
        publication_id: "shared-0a1b2c3d4e5f".into(),
        title: "On attention".into(),
        sources: vec![NewSourceReference {
            kind: SourceKind::Video,
            title: "The Art of Noticing".into(),
            url: "https://www.youtube.com/watch?v=abc123".into(),
            ..NewSourceReference::default()
        }],
        creator: NewParticipant {
            admin_user: "ada-admin".into(),
            contributor_id: "ada".into(),
            display_name: "Ada".into(),
        },
        ..NewSharedPublication::default()
    })
    .unwrap()
}

/// Ada owns; grace and kay contribute, linus coordinates, ida edits, sam reads.
fn group() -> SharedPublication {
    let record = join(&solo(), "grace-admin", "grace", &[Contributor], 'a');
    let record = join(&record, "linus-admin", "linus", &[Coordinator], 'b');
    let record = join(&record, "kay-admin", "kay", &[Contributor], 'c');
    let record = join(&record, "ida-admin", "ida", &[Editor], 'd');
    join(&record, "sam-admin", "sam", &[Reader], 'e')
}

fn id_of(record: &SharedPublication, user: &str) -> String {
    record
        .authorization
        .bindings
        .iter()
        .find(|binding| binding.admin_user == user)
        .unwrap()
        .participant_id
        .clone()
}

fn can(record: &SharedPublication, user: &str, action: AuthorizationAction) -> bool {
    let own = id_of(record, user);
    record
        .authorize(
            user,
            &identities(),
            action,
            AuthorizationTarget::Participant(&own),
        )
        .is_ok()
}

#[test]
fn a_group_of_six_joins_without_a_migration() {
    // A record written before groups or the audit trail existed has neither key and still loads.
    let legacy = serde_json::to_value(solo()).unwrap();
    assert!(legacy.get("audit").is_none());
    assert!(SharedPublication::from_json(&legacy.to_string()).is_ok());

    let record = group();
    assert_eq!(record.collaboration.participants.len(), 6);
    assert_eq!(record.authorization.bindings.len(), 6);
    let ids = record
        .collaboration
        .participants
        .iter()
        .map(|participant| participant.id.clone())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), 6);
    // It round-trips through the stored form unchanged.
    let text = serde_json::to_string(&record).unwrap();
    assert_eq!(SharedPublication::from_json(&text).unwrap(), record);
    // Each role holds exactly its own authority.
    assert!(can(
        &record,
        "grace-admin",
        AuthorizationAction::EditSynthesis
    ));
    assert!(can(
        &record,
        "kay-admin",
        AuthorizationAction::EditSynthesis
    ));
    assert!(!can(
        &record,
        "ida-admin",
        AuthorizationAction::EditSynthesis
    ));
    assert!(can(&record, "ida-admin", AuthorizationAction::EditDraft));
    assert!(!can(&record, "sam-admin", AuthorizationAction::EditDraft));
    assert!(record
        .authorize(
            "linus-admin",
            &identities(),
            AuthorizationAction::ArrangeReflection,
            AuthorizationTarget::Publication,
        )
        .is_ok());
    assert!(record
        .authorize(
            "kay-admin",
            &identities(),
            AuthorizationAction::Invite,
            AuthorizationTarget::Publication,
        )
        .is_err());
}

#[test]
fn duplicate_identity_bindings_are_refused() {
    let record = group();
    // Inviting an account or key that is already bound is refused.
    let taken_user = new_invitation("grace-admin", "ida", &[Reader], 'f');
    assert_eq!(
        record
            .invite("ada-admin", &identities(), &taken_user, NOW)
            .err(),
        Some(InvitationError::Invalid(InvitationField::AdminUser))
    );
    let taken_key = new_invitation("sam-admin", "grace", &[Reader], 'f');
    assert!(record
        .invite("ada-admin", &identities(), &taken_key, NOW)
        .is_err());
    // A stored record with a repeated account, key, or participant (any case) does not load.
    for (field, value) in [
        ("adminUser", "grace-admin"),
        ("contributorId", "grace"),
        ("participantId", "PARTICIPANT-2"),
    ] {
        let mut json = serde_json::to_value(&record).unwrap();
        let bindings = json["authorization"]["bindings"].as_array_mut().unwrap();
        bindings[2][field] = serde_json::json!(value);
        assert!(
            SharedPublication::from_json(&json.to_string()).is_err(),
            "{field}"
        );
    }
}

#[test]
fn concurrent_invitations_for_one_identity_cannot_both_land() {
    let base = solo();
    let first = new_invitation("grace-admin", "grace", &[Contributor], 'a');
    let (with_first, token) = base
        .invite("ada-admin", &identities(), &first, NOW)
        .unwrap();
    // A second invitation for the same account or key, built on the result, is refused.
    let second = new_invitation("grace-admin", "kay", &[Reader], 'b');
    assert!(with_first
        .invite("ada-admin", &identities(), &second, NOW)
        .is_err());
    let third = new_invitation("kay-admin", "grace", &[Reader], 'c');
    assert!(with_first
        .invite("ada-admin", &identities(), &third, NOW)
        .is_err());
    // The token redeems once; a second redemption of the same token finds nothing.
    let joined = with_first
        .accept_invitation("grace-admin", &identities(), &token, "grace", "Grace", NOW)
        .unwrap();
    assert_eq!(
        joined
            .accept_invitation("grace-admin", &identities(), &token, "grace", "Grace", NOW)
            .err(),
        Some(InvitationError::Unavailable)
    );
    // Two invitations built on the same loaded record are serialized by the store, which compares
    // the whole stored record; the Admin API test for invitations covers that refusal.
}

#[test]
fn an_unchanged_role_set_is_a_no_op_that_records_nothing() {
    let record = group();
    let ada = id_of(&record, "ada-admin");
    let grace = id_of(&record, "grace-admin");
    let revision = record.authorization.revision;
    // A coordinator resubmitting the owner's roles (in any order) changes nothing and writes no
    // entry, however often, so the trail can neither be filled with false entries nor have its
    // history evicted.
    let owner_roles = [Contributor, SiteOwner];
    let mut current = record.clone();
    for _ in 0..3 {
        current = current
            .change_member_roles(
                "linus-admin",
                &identities(),
                &ada,
                &owner_roles,
                revision,
                NOW,
            )
            .unwrap();
    }
    assert_eq!(current, record);
    // The same holds for a multi-role set submitted in another order.
    let both = record
        .change_member_roles(
            "ada-admin",
            &identities(),
            &grace,
            &[Contributor, Editor],
            revision,
            NOW,
        )
        .unwrap();
    let reordered = both
        .change_member_roles(
            "ada-admin",
            &identities(),
            &grace,
            &[Editor, Contributor],
            both.authorization.revision,
            NOW + 1,
        )
        .unwrap();
    assert_eq!(reordered, both);
    // A no-op is still guarded: a stale revision or an outsider is refused as before.
    assert_eq!(
        both.change_member_roles(
            "linus-admin",
            &identities(),
            &ada,
            &owner_roles,
            revision,
            NOW
        ),
        Err(MemberError::Stale)
    );
    assert_eq!(
        record.change_member_roles(
            "kay-admin",
            &identities(),
            &ada,
            &owner_roles,
            revision,
            NOW
        ),
        Err(MemberError::Denied)
    );
}

#[test]
fn the_group_is_bounded_counting_pending_invitations() {
    let users = (0..MAX_PARTICIPANTS + 2)
        .map(|n| format!("user-{n:03}"))
        .collect::<Vec<_>>();
    let keys = (0..MAX_PARTICIPANTS + 2)
        .map(|n| format!("key-{n:03}"))
        .collect::<Vec<_>>();
    let mut active = users.iter().map(String::as_str).collect::<Vec<_>>();
    active.push("ada-admin");
    let mut registry = keys.iter().map(String::as_str).collect::<Vec<_>>();
    registry.push("ada");
    let identities = Identities {
        active_admin_users: &active,
        contributor_ids: &registry,
    };
    let mut record = solo();
    let mut refused = None;
    for n in 0..MAX_PARTICIPANTS {
        let new = NewInvitation {
            id: format!("invitation-{n:04}"),
            secret: format!("{n:064x}"),
            admin_user: users[n].clone(),
            contributor_id: keys[n].clone(),
            roles: vec![Reader],
            lifetime_days: 0,
        };
        match record.invite("ada-admin", &identities, &new, NOW) {
            Ok((next, _)) => record = next,
            Err(error) => {
                refused = Some((n, error));
                break;
            }
        }
    }
    // One participant plus 99 pending invitations fills the cap; the next invitation is refused
    // and the record is unchanged.
    assert_eq!(
        refused,
        Some((
            MAX_PARTICIPANTS - 1,
            InvitationError::Invalid(InvitationField::Capacity)
        ))
    );
    assert_eq!(record.invitations.len(), MAX_PARTICIPANTS - 1);
}

#[test]
fn ownership_transfers_through_a_second_owner_and_is_never_orphaned() {
    let record = group();
    let revision = record.authorization.revision;
    let linus = id_of(&record, "linus-admin");
    let ada = id_of(&record, "ada-admin");
    // The only owner cannot step down while nobody else holds ownership.
    assert_eq!(
        record.change_member_roles(
            "ada-admin",
            &identities(),
            &ada,
            &[Coordinator],
            revision,
            NOW
        ),
        Err(MemberError::Denied)
    );
    // Promote linus, then ada can step down; linus holds the authority alone.
    let two = record
        .change_member_roles(
            "ada-admin",
            &identities(),
            &linus,
            &[SiteOwner],
            revision,
            NOW,
        )
        .unwrap();
    let transferred = two
        .change_member_roles(
            "ada-admin",
            &identities(),
            &ada,
            &[Contributor],
            two.authorization.revision,
            NOW + 1,
        )
        .unwrap();
    assert!(can(
        &transferred,
        "linus-admin",
        AuthorizationAction::ManageRoles
    ));
    assert!(!can(
        &transferred,
        "ada-admin",
        AuthorizationAction::ManageRoles
    ));
    // Linus is now the last owner and can neither be removed nor demoted.
    let rev = transferred.authorization.revision;
    assert_eq!(
        transferred.remove_member("linus-admin", &identities(), &linus, rev, NOW),
        Err(MemberError::Denied)
    );
    assert_eq!(
        transferred.change_member_roles("linus-admin", &identities(), &linus, &[Reader], rev, NOW),
        Err(MemberError::Denied)
    );
    // An owner whose account is gone does not count: ada cannot leave a stale owner as the only
    // authority.
    let users = [
        "ada-admin",
        "grace-admin",
        "kay-admin",
        "ida-admin",
        "sam-admin",
    ];
    let without_linus = Identities {
        active_admin_users: &users,
        contributor_ids: &KEYS,
    };
    assert_eq!(
        two.change_member_roles(
            "ada-admin",
            &without_linus,
            &ada,
            &[Contributor],
            two.authorization.revision,
            NOW
        ),
        Err(MemberError::Denied)
    );
}

#[test]
fn every_membership_change_is_audited_without_secrets() {
    let record = group();
    let grace = id_of(&record, "grace-admin");
    let ada = id_of(&record, "ada-admin");
    let revision = record.authorization.revision;
    let changed = record
        .change_member_roles(
            "ada-admin",
            &identities(),
            &grace,
            &[Reader],
            revision,
            NOW + 5,
        )
        .unwrap();
    let kay = id_of(&changed, "kay-admin");
    let removed = changed
        .remove_member(
            "ada-admin",
            &identities(),
            &kay,
            changed.authorization.revision,
            NOW + 6,
        )
        .unwrap();
    let trail = removed.audit_for("ada-admin", &identities()).unwrap();
    // Newest first: removal, role change, then five invitations and five joins.
    assert_eq!(trail[0].event, AuditEvent::Removed);
    assert_eq!(
        (trail[0].actor.as_str(), trail[0].subject.as_str()),
        (ada.as_str(), kay.as_str())
    );
    assert_eq!(trail[0].from, vec![Contributor]);
    assert_eq!(trail[1].event, AuditEvent::RolesChanged);
    assert_eq!(
        (trail[1].from.clone(), trail[1].to.clone()),
        (vec![Contributor], vec![Reader])
    );
    assert_eq!(trail[1].at, NOW + 5);
    assert_eq!(trail.len(), 2 + 10);
    assert!(trail.windows(2).all(|pair| pair[0].seq > pair[1].seq));
    // Only people who manage members read it.
    for user in ["grace-admin", "ida-admin", "sam-admin", "stranger"] {
        assert_eq!(
            removed.audit_for(user, &identities()).err(),
            Some(MemberError::Denied),
            "{user}"
        );
    }
    assert!(removed.audit_for("linus-admin", &identities()).is_ok());
    // It names no token, account, key, or display name.
    let text = serde_json::to_string(&removed.audit).unwrap();
    for secret in ["aaaaaaaa", "-admin", "Ada", "token"] {
        assert!(!text.contains(secret), "{secret}");
    }
    // A refused change records nothing.
    let before = changed.audit.len();
    assert_eq!(
        changed.change_member_roles(
            "linus-admin",
            &identities(),
            &ada,
            &[Reader],
            changed.authorization.revision,
            NOW
        ),
        Err(MemberError::Denied)
    );
    assert_eq!(changed.audit.len(), before);
}

#[test]
fn revoked_invitations_are_audited_and_the_trail_is_bounded() {
    let (invited, _) = solo()
        .invite(
            "ada-admin",
            &identities(),
            &new_invitation("grace-admin", "grace", &[Reader], 'a'),
            NOW,
        )
        .unwrap();
    let revoked = invited
        .revoke_invitation("ada-admin", &identities(), "invitation-aaa", NOW + 1)
        .unwrap();
    let events = revoked
        .audit
        .iter()
        .map(|entry| entry.event)
        .collect::<Vec<_>>();
    assert_eq!(events, [AuditEvent::Invited, AuditEvent::InvitationRevoked]);

    let mut record = group();
    let grace = id_of(&record, "grace-admin");
    for turn in 0..MAX_AUDIT_ENTRIES + 20 {
        let role = if turn % 2 == 0 { Reader } else { Contributor };
        record = record
            .change_member_roles(
                "ada-admin",
                &identities(),
                &grace,
                &[role],
                record.authorization.revision,
                NOW + turn as i64,
            )
            .unwrap();
    }
    assert_eq!(record.audit.len(), MAX_AUDIT_ENTRIES);
    assert!(record
        .audit
        .windows(2)
        .all(|pair| pair[0].seq < pair[1].seq));
    assert!(SharedPublication::from_json(&serde_json::to_string(&record).unwrap()).is_ok());
}

#[test]
fn members_with_gone_accounts_stay_listed_but_cannot_act() {
    let record = group();
    let users = [
        "ada-admin",
        "linus-admin",
        "kay-admin",
        "ida-admin",
        "sam-admin",
    ];
    let keys = ["ada", "grace", "linus", "ida", "sam"];
    let mixed = Identities {
        active_admin_users: &users,
        contributor_ids: &keys,
    };
    let listed = record.members_for("ada-admin", &mixed).unwrap();
    let current = |user: &str| {
        listed
            .iter()
            .find(|m| m.admin_user == user)
            .unwrap()
            .binding_current
    };
    // Grace's account is gone and kay's registry key is gone.
    assert!(!current("grace-admin") && !current("kay-admin"));
    assert!(current("ida-admin") && current("linus-admin"));
    let grace = id_of(&record, "grace-admin");
    assert!(record
        .authorize(
            "grace-admin",
            &mixed,
            AuthorizationAction::EditDraft,
            AuthorizationTarget::Participant(&grace),
        )
        .is_err());
    // The listing carries no invitation secret.
    assert!(!serde_json::to_string(&listed).unwrap().contains("secret"));
}
