//! Record-level authorization: every role against every collaboration operation, with the
//! target resolved from the record's own contract, and the states that must grant nothing.

use openblog_core::collaboration::{
    Approval, AuthorizationAction, AuthorizationRole, AuthorizationTarget, Contribution,
    IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference, Participant,
    PublishError, Reveal, SharedPublication, SourceKind,
};
use openblog_core::invitation::{Identities, NewInvitation};
use AuthorizationAction::*;
use AuthorizationRole::*;

const NOW: i64 = 1_800_000_000;
const ACTIONS: [AuthorizationAction; 13] = [
    ViewPublication,
    ViewPublished,
    ViewRevealed,
    ViewContribution,
    EditContribution,
    Invite,
    RevealContribution,
    ApproveContribution,
    Schedule,
    Publish,
    RemoveMember,
    ManageRoles,
    Export,
];
const PEOPLE: [(&str, AuthorizationRole); 6] = [
    ("owner", SiteOwner),
    ("coord", Coordinator),
    ("writer", Contributor),
    ("other", Contributor),
    ("editor", Editor),
    ("reader", Reader),
];
const USERS: [&str; 7] = [
    "owner-admin",
    "coord-admin",
    "writer-admin",
    "other-admin",
    "editor-admin",
    "reader-admin",
    "guest-admin",
];
const KEYS: [&str; 7] = [
    "owner", "coord", "writer", "other", "editor", "reader", "guest",
];

fn identities() -> Identities<'static> {
    Identities {
        active_admin_users: &USERS,
        contributor_ids: &KEYS,
    }
}

/// Six bound participants. `writer` owns draft `w`, `other` owns draft `o`, and `o` is revealed
/// to the editor, the reader, and the coordinator.
fn group() -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: "shared-0a1b2c3d4e5f".into(),
        title: "On attention".into(),
        sources: vec![NewSourceReference {
            kind: SourceKind::Video,
            title: "The Art of Noticing".into(),
            url: "https://www.youtube.com/watch?v=abc123".into(),
            ..NewSourceReference::default()
        }],
        creator: NewParticipant {
            admin_user: "owner-admin".into(),
            contributor_id: "owner".into(),
            display_name: "Owner".into(),
        },
        ..NewSharedPublication::default()
    })
    .unwrap();
    // The creator's participant id is generated; use it as the "owner" person's participant.
    let owner_participant = record.authorization.bindings[0].participant_id.clone();
    for (id, role) in PEOPLE.iter().skip(1) {
        record.collaboration.participants.push(Participant {
            id: (*id).into(),
            display_name: (*id).into(),
            profile_url: None,
        });
        record.authorization.bindings.push(IdentityBinding {
            admin_user: format!("{id}-admin"),
            contributor_id: (*id).into(),
            participant_id: (*id).into(),
            roles: vec![*role],
        });
    }
    record.collaboration.participants[0].id = owner_participant.clone();
    for (id, by) in [("w", "writer"), ("o", "other")] {
        record.collaboration.contributions.push(Contribution {
            id: id.into(),
            participant_id: by.into(),
            markdown: format!("Private draft {id}"),
        });
    }
    record.collaboration.reveals.push(Reveal {
        contribution_id: "o".into(),
        participant_ids: vec!["editor".into(), "reader".into(), "coord".into()],
    });
    record
}

fn owner_id(record: &SharedPublication) -> String {
    record.authorization.bindings[0].participant_id.clone()
}

fn targets(record: &SharedPublication) -> Vec<AuthorizationTarget<'_>> {
    let mut targets = vec![AuthorizationTarget::Publication];
    targets.extend(
        record
            .collaboration
            .participants
            .iter()
            .map(|p| AuthorizationTarget::Participant(p.id.as_str())),
    );
    targets.extend([
        AuthorizationTarget::Contribution("w"),
        AuthorizationTarget::Contribution("o"),
        AuthorizationTarget::Contribution("missing"),
        AuthorizationTarget::Participant("missing"),
    ]);
    targets
}

/// The participant ids of everyone but the site owner.
const OTHERS: [&str; 5] = ["coord", "writer", "other", "editor", "reader"];

/// The complete set of grants for one person; everything else must be denied.
fn expected<'a>(
    person: &str,
    owner: &'a str,
) -> Vec<(AuthorizationAction, AuthorizationTarget<'a>)> {
    use AuthorizationTarget::*;
    let mut grants = vec![
        (ViewPublication, Publication),
        (ViewPublished, Publication),
        (Export, Publication),
    ];
    let manage = |grants: &mut Vec<_>, action, with_owner: bool| {
        if with_owner {
            grants.push((action, Participant(owner)));
        }
        grants.extend(OTHERS.iter().map(|id| (action, Participant(id))));
    };
    match person {
        "owner" => {
            grants.extend([
                (Invite, Publication),
                (Schedule, Publication),
                (Publish, Publication),
            ]);
            // The creator also holds `contributor`, which may approve for themselves only, and
            // the only site owner cannot remove themselves.
            grants.push((ApproveContribution, Participant(owner)));
            manage(&mut grants, RemoveMember, false);
            manage(&mut grants, ManageRoles, true);
        }
        "coord" => {
            grants.extend([
                (Invite, Publication),
                (Schedule, Publication),
                (Publish, Publication),
                (ViewRevealed, Contribution("o")),
            ]);
            manage(&mut grants, RemoveMember, false);
            manage(&mut grants, ManageRoles, false);
        }
        "writer" => grants.extend([
            (ViewContribution, Contribution("w")),
            (EditContribution, Contribution("w")),
            (RevealContribution, Contribution("w")),
            (ApproveContribution, Participant("writer")),
        ]),
        "other" => grants.extend([
            (ViewContribution, Contribution("o")),
            (EditContribution, Contribution("o")),
            (RevealContribution, Contribution("o")),
            (ApproveContribution, Participant("other")),
        ]),
        "editor" => grants.extend([
            (ViewRevealed, Contribution("o")),
            (ViewContribution, Contribution("o")),
            (EditContribution, Contribution("o")),
        ]),
        "reader" => grants.push((ViewRevealed, Contribution("o"))),
        _ => unreachable!(),
    }
    grants
}

#[test]
fn every_role_operation_and_resolved_target_is_decided_by_the_record() {
    let record = group();
    let owner = owner_id(&record);
    for (person, _) in PEOPLE {
        let allowed = expected(person, &owner);
        for action in ACTIONS {
            for target in targets(&record) {
                let got = record
                    .authorize(&format!("{person}-admin"), &identities(), action, target)
                    .is_ok();
                let want = allowed.iter().any(|(a, t)| *a == action && *t == target);
                assert_eq!(got, want, "{person} {action:?} {target:?}");
            }
        }
    }
}

fn can_do_anything(record: &SharedPublication, identities: &Identities<'_>, user: &str) -> bool {
    ACTIONS.iter().any(|action| {
        targets(record)
            .into_iter()
            .any(|t| record.authorize(user, identities, *action, t).is_ok())
    })
}

#[test]
fn unbound_stale_and_foreign_requesters_hold_no_grants() {
    let record = group();
    // An Admin account that is not bound, a near-miss name, and an empty name.
    for user in ["guest-admin", "OWNER-ADMIN", "owner-admin ", ""] {
        assert!(!can_do_anything(&record, &identities(), user), "{user:?}");
    }
    // The owner's account disabled, its contributor key removed, or its participant removed.
    let active = ["coord-admin", "writer-admin"];
    let stale_account = Identities {
        active_admin_users: &active,
        contributor_ids: &KEYS,
    };
    assert!(!can_do_anything(&record, &stale_account, "owner-admin"));
    let keys = ["coord", "writer"];
    let stale_key = Identities {
        active_admin_users: &USERS,
        contributor_ids: &keys,
    };
    assert!(!can_do_anything(&record, &stale_key, "owner-admin"));
    let mut gone = group();
    gone.collaboration.participants.retain(|p| p.id != "writer");
    assert!(!can_do_anything(&gone, &identities(), "writer-admin"));
    // A record never accepts grants from another publication's policy.
    let mut foreign = group();
    foreign.authorization.publication_id = "shared-ffffffffffff".into();
    assert!(!can_do_anything(&foreign, &identities(), "owner-admin"));
}

#[test]
fn removing_an_account_revokes_every_grant_at_once() {
    let record = group().without_admin_user("coord-admin").unwrap();
    assert!(!can_do_anything(&record, &identities(), "coord-admin"));
    assert!(record
        .authorize(
            "owner-admin",
            &identities(),
            Invite,
            AuthorizationTarget::Publication
        )
        .is_ok());
}

#[test]
fn pending_revoked_and_expired_invitees_hold_no_grants() {
    let invite = |record: &SharedPublication, seed: char, now: i64| {
        record
            .invite(
                "owner-admin",
                &identities(),
                &NewInvitation {
                    id: format!("invitation-{seed}{seed}{seed}"),
                    secret: seed.to_string().repeat(64),
                    admin_user: "guest-admin".into(),
                    contributor_id: "guest".into(),
                    roles: vec![SiteOwner],
                    lifetime_days: 1,
                },
                now,
            )
            .unwrap()
            .0
    };
    let base = group();
    assert!(!can_do_anything(&base, &identities(), "guest-admin"));
    let pending = invite(&base, 'a', NOW);
    assert!(!can_do_anything(&pending, &identities(), "guest-admin"));
    let id = pending.invitations[0].id.clone();
    let revoked = pending
        .revoke_invitation("owner-admin", &identities(), &id, NOW)
        .unwrap();
    assert!(!can_do_anything(&revoked, &identities(), "guest-admin"));
    let expired = invite(&base, 'b', NOW - 3 * 86_400);
    assert!(!can_do_anything(&expired, &identities(), "guest-admin"));
}

fn approve(record: &mut SharedPublication, by: &str, revision: u64) {
    record.collaboration.approvals.push(Approval {
        participant_id: by.into(),
        revision,
    });
}

#[test]
fn site_ownership_never_publishes_unapproved_contributions() {
    let mut record = group();
    let revision = record.collaboration.revision;
    let publish =
        |record: &SharedPublication, user: &str| record.authorize_publish(user, &identities());
    assert_eq!(
        publish(&record, "owner-admin"),
        Err(PublishError::Unapproved)
    );
    assert_eq!(
        publish(&record, "coord-admin"),
        Err(PublishError::Unapproved)
    );
    // Another person's approval does not help, nor does an approval of a different revision.
    approve(&mut record, "coord", revision);
    approve(&mut record, "writer", revision + 1);
    assert_eq!(
        publish(&record, "owner-admin"),
        Err(PublishError::Unapproved)
    );
    record.collaboration.approvals.pop();
    approve(&mut record, "writer", revision);
    assert_eq!(
        publish(&record, "owner-admin"),
        Err(PublishError::Unapproved)
    );
    approve(&mut record, "other", revision);
    assert_eq!(publish(&record, "owner-admin"), Ok(()));
    assert_eq!(publish(&record, "coord-admin"), Ok(()));
    // Approval is not authority: nobody else gains the grant, and learns nothing about approvals.
    for user in [
        "writer-admin",
        "editor-admin",
        "reader-admin",
        "guest-admin",
        "nobody",
    ] {
        assert_eq!(publish(&record, user), Err(PublishError::Denied), "{user}");
    }
    // A contract with no drafts has nothing unapproved.
    let mut empty = group();
    empty.collaboration.contributions.clear();
    empty.collaboration.reveals.clear();
    assert_eq!(publish(&empty, "owner-admin"), Ok(()));
}
