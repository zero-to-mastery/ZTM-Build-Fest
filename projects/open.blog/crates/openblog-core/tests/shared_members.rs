use openblog_core::collaboration::{
    AuthorizationRole, NewParticipant, NewSharedPublication, NewSourceReference, SharedPublication,
    SourceKind,
};
use openblog_core::invitation::{Identities, NewInvitation};
use openblog_core::members::MemberError;
use AuthorizationRole::{Contributor, Coordinator, Reader, SiteOwner};

const NOW: i64 = 1_800_000_000;
const USERS: [&str; 4] = ["ada-admin", "grace-admin", "linus-admin", "kay-admin"];
const KEYS: [&str; 4] = ["ada", "grace", "linus", "kay"];

fn identities() -> Identities<'static> {
    Identities {
        active_admin_users: &USERS,
        contributor_ids: &KEYS,
    }
}

fn join(
    base: &SharedPublication,
    user: &str,
    key: &str,
    roles: &[AuthorizationRole],
    seed: char,
) -> SharedPublication {
    let new = NewInvitation {
        id: format!("invitation-{seed}{seed}{seed}"),
        secret: seed.to_string().repeat(64),
        admin_user: user.into(),
        contributor_id: key.into(),
        roles: roles.to_vec(),
        lifetime_days: 0,
    };
    let (invited, token) = base.invite("ada-admin", &identities(), &new, NOW).unwrap();
    invited
        .accept_invitation(user, &identities(), &token, key, key, NOW)
        .unwrap()
}

/// Ada owns; grace is a contributor; linus is a coordinator.
fn team() -> SharedPublication {
    let base = SharedPublication::create(&NewSharedPublication {
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
    .unwrap();
    let base = join(&base, "grace-admin", "grace", &[Contributor], 'a');
    join(&base, "linus-admin", "linus", &[Coordinator], 'b')
}

fn revision(record: &SharedPublication) -> u64 {
    record.authorization.revision
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

#[test]
fn owners_and_coordinators_list_members_with_what_they_may_do() {
    let record = team();
    let owner_view = record.members_for("ada-admin", &identities()).unwrap();
    assert_eq!(owner_view.len(), 3);
    assert!(owner_view
        .iter()
        .all(|m| m.can_change_roles && m.binding_current));
    // The only site owner cannot be removed.
    assert!(owner_view
        .iter()
        .all(|m| m.can_remove == (m.admin_user != "ada-admin")));
    let coordinator_view = record.members_for("linus-admin", &identities()).unwrap();
    let owner = coordinator_view
        .iter()
        .find(|m| m.admin_user == "ada-admin")
        .unwrap();
    assert!(!owner.can_change_roles && !owner.can_remove);
    assert!(
        coordinator_view
            .iter()
            .find(|m| m.is_you)
            .unwrap()
            .admin_user
            == "linus-admin"
    );
    assert_eq!(
        record.members_for("grace-admin", &identities()),
        Err(MemberError::Denied)
    );
    assert_eq!(
        record.members_for("stranger", &identities()),
        Err(MemberError::Denied)
    );
}

#[test]
fn a_binding_whose_account_is_gone_is_flagged() {
    let record = team();
    let users = ["ada-admin", "linus-admin"];
    let identities = Identities {
        active_admin_users: &users,
        contributor_ids: &KEYS,
    };
    let members = record.members_for("ada-admin", &identities).unwrap();
    assert!(
        !members
            .iter()
            .find(|m| m.admin_user == "grace-admin")
            .unwrap()
            .binding_current
    );
}

#[test]
fn changing_roles_is_guarded_by_revision_and_role_rules() {
    let record = team();
    let grace = id_of(&record, "grace-admin");
    let rev = revision(&record);
    let next = record
        .change_member_roles("ada-admin", &identities(), &grace, &[Reader], rev, NOW)
        .unwrap();
    assert_eq!(revision(&next), rev + 1);
    assert_eq!(next.collaboration, record.collaboration);
    assert_eq!(
        record.change_member_roles("ada-admin", &identities(), &grace, &[Reader], rev - 1, NOW),
        Err(MemberError::Stale)
    );
    assert_eq!(
        record.change_member_roles("ada-admin", &identities(), &grace, &[], rev, NOW),
        Err(MemberError::Roles)
    );
    assert_eq!(
        record.change_member_roles(
            "ada-admin",
            &identities(),
            &grace,
            &[Reader, Reader],
            rev,
            NOW
        ),
        Err(MemberError::Roles)
    );
    // A coordinator cannot grant ownership, touch the owner, or act for a plain contributor.
    assert_eq!(
        record.change_member_roles("linus-admin", &identities(), &grace, &[SiteOwner], rev, NOW),
        Err(MemberError::Denied)
    );
    let ada = id_of(&record, "ada-admin");
    assert_eq!(
        record.change_member_roles("linus-admin", &identities(), &ada, &[Reader], rev, NOW),
        Err(MemberError::Denied)
    );
    assert_eq!(
        record.change_member_roles("grace-admin", &identities(), &grace, &[SiteOwner], rev, NOW),
        Err(MemberError::Denied)
    );
    // The only site owner cannot demote themselves.
    assert_eq!(
        record.change_member_roles("ada-admin", &identities(), &ada, &[Contributor], rev, NOW),
        Err(MemberError::Denied)
    );
    // Unknown participants read the same as forbidden ones.
    assert_eq!(
        record.change_member_roles(
            "ada-admin",
            &identities(),
            "participant-99",
            &[Reader],
            rev,
            NOW
        ),
        Err(MemberError::Denied)
    );
}

#[test]
fn removing_a_member_ends_access_but_keeps_credit() {
    let record = team();
    let grace = id_of(&record, "grace-admin");
    let rev = revision(&record);
    let next = record
        .remove_member("linus-admin", &identities(), &grace, rev, NOW)
        .unwrap();
    assert_eq!(revision(&next), rev + 1);
    assert!(next
        .authorization
        .bindings
        .iter()
        .all(|b| b.admin_user != "grace-admin"));
    assert_eq!(next.collaboration, record.collaboration);
    assert!(next
        .collaboration
        .participants
        .iter()
        .any(|p| p.id == grace));
    assert!(next.members_for("grace-admin", &identities()).is_err());
    // The freed account and profile can be invited again as a new participant.
    let again = join(&next, "grace-admin", "grace", &[Reader], 'c');
    assert_ne!(id_of(&again, "grace-admin"), grace);
}

#[test]
fn removal_refuses_stale_state_unauthorised_requests_and_the_last_owner() {
    let record = team();
    let rev = revision(&record);
    let grace = id_of(&record, "grace-admin");
    let ada = id_of(&record, "ada-admin");
    assert_eq!(
        record.remove_member("ada-admin", &identities(), &grace, rev + 1, NOW),
        Err(MemberError::Stale)
    );
    assert_eq!(
        record.remove_member("grace-admin", &identities(), &grace, rev, NOW),
        Err(MemberError::Denied)
    );
    assert_eq!(
        record.remove_member("linus-admin", &identities(), &ada, rev, NOW),
        Err(MemberError::Denied)
    );
    assert_eq!(
        record.remove_member("ada-admin", &identities(), &ada, rev, NOW),
        Err(MemberError::Denied)
    );
    assert_eq!(
        record.remove_member("ada-admin", &identities(), "participant-99", rev, NOW),
        Err(MemberError::Denied)
    );
}
