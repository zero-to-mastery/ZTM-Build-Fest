use openblog_core::collaboration::{
    AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference,
    SharedPublication, SourceKind,
};
use openblog_core::invitation::{
    hash_token, token_publication_id, Identities, InvitationError, InvitationField,
    InvitationState, NewInvitation, MAX_INVITATIONS,
};
use AuthorizationRole::{Contributor, Coordinator, Editor, Reader, SiteOwner};

const NOW: i64 = 1_800_000_000;
const DAY: i64 = 86_400;
const PUBLICATION: &str = "shared-0a1b2c3d4e5f";
const USERS: [&str; 5] = [
    "ada-admin",
    "grace-admin",
    "linus-admin",
    "kay-admin",
    "ann-admin",
];
const KEYS: [&str; 5] = ["ada", "grace", "linus", "kay", "ann"];

fn identities() -> Identities<'static> {
    Identities {
        active_admin_users: &USERS,
        contributor_ids: &KEYS,
    }
}

fn record() -> SharedPublication {
    SharedPublication::create(&NewSharedPublication {
        publication_id: PUBLICATION.into(),
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

fn secret(seed: char) -> String {
    seed.to_string().repeat(64)
}

fn new(user: &str, key: &str, roles: &[AuthorizationRole], seed: char) -> NewInvitation {
    NewInvitation {
        id: format!("invitation-{seed}{seed}{seed}"),
        secret: secret(seed),
        admin_user: user.into(),
        contributor_id: key.into(),
        roles: roles.to_vec(),
        lifetime_days: 0,
    }
}

fn invite(
    record: &SharedPublication,
    by: &str,
    user: &str,
    key: &str,
    roles: &[AuthorizationRole],
    seed: char,
) -> Result<(SharedPublication, String), InvitationError> {
    record.invite(by, &identities(), &new(user, key, roles, seed), NOW)
}

fn accept(
    record: &SharedPublication,
    account: &str,
    token: &str,
    key: &str,
    now: i64,
) -> Result<SharedPublication, InvitationError> {
    record.accept_invitation(account, &identities(), token, key, "Grace", now)
}

fn invite_grace(base: &SharedPublication) -> (SharedPublication, String) {
    invite(
        base,
        "ada-admin",
        "grace-admin",
        "grace",
        &[Contributor],
        'a',
    )
    .unwrap()
}

#[test]
fn tokens_are_scoped_high_entropy_and_stored_only_as_a_hash() {
    let (next, token) = invite_grace(&record());
    assert_eq!(token_publication_id(&token), Some(PUBLICATION));
    let stored = serde_json::to_string(&next).unwrap();
    assert!(!stored.contains(&secret('a')) && !stored.contains(&token));
    assert!(stored.contains(&hash_token(&token)));
    let foreign = token.replace(PUBLICATION, "shared-other");
    assert_ne!(hash_token(&token), hash_token(&foreign));
    assert_eq!(
        next.invitations[0].expires_at - next.invitations[0].created_at,
        7 * DAY
    );
    assert!(SharedPublication::from_json(&stored).is_ok());
    for bad in ["", "x", "shared-0a1b2c3d4e5f.short", "shared-0a1b2c3d4e5f."] {
        assert_eq!(token_publication_id(bad), None);
    }
}

#[test]
fn only_site_owners_and_coordinators_invite_and_only_owners_grant_ownership() {
    let (base, token) = invite_grace(&record());
    let base = accept(&base, "grace-admin", &token, "grace", NOW).unwrap();
    for who in ["grace-admin", "kay-admin", "nobody"] {
        assert_eq!(
            invite(&base, who, "linus-admin", "linus", &[Contributor], 'b').unwrap_err(),
            InvitationError::Denied
        );
    }
    let (base, token) = invite(
        &base,
        "ada-admin",
        "linus-admin",
        "linus",
        &[Coordinator],
        'c',
    )
    .unwrap();
    let base = accept(&base, "linus-admin", &token, "linus", NOW).unwrap();
    assert!(invite(&base, "linus-admin", "kay-admin", "kay", &[Editor], 'd').is_ok());
    assert_eq!(
        invite(&base, "linus-admin", "kay-admin", "kay", &[SiteOwner], 'e').unwrap_err(),
        InvitationError::Denied
    );
    let (base, _) = invite(&base, "ada-admin", "kay-admin", "kay", &[SiteOwner], 'f').unwrap();
    assert_eq!(
        base.revoke_invitation("linus-admin", &identities(), "invitation-fff", NOW)
            .unwrap_err(),
        InvitationError::Denied
    );
    assert!(base
        .revoke_invitation("ada-admin", &identities(), "invitation-fff", NOW)
        .is_ok());
}

#[test]
fn acceptance_binds_exactly_the_invited_account_and_key_and_is_single_use() {
    let (base, token) = invite(
        &record(),
        "ada-admin",
        "grace-admin",
        "grace",
        &[Contributor, Editor],
        'a',
    )
    .unwrap();
    let foreign = token.replace(PUBLICATION, "shared-ffffffffffff");
    let guess = format!("{PUBLICATION}.{}", secret('b'));
    for (account, key, presented) in [
        ("linus-admin", "grace", token.as_str()),
        ("grace-admin", "linus", token.as_str()),
        ("grace-admin", "grace", foreign.as_str()),
        ("grace-admin", "grace", guess.as_str()),
        ("grace-admin", "grace", "garbage"),
    ] {
        assert_eq!(
            accept(&base, account, presented, key, NOW).unwrap_err(),
            InvitationError::Unavailable
        );
    }
    assert_eq!(base.invitations[0].state, InvitationState::Pending);

    let joined = accept(&base, "grace-admin", &token, "grace", NOW + 5).unwrap();
    let binding = joined.authorization.bindings.last().unwrap();
    assert_eq!(binding.admin_user, "grace-admin");
    assert_eq!(binding.contributor_id, "grace");
    assert_eq!(binding.participant_id, "participant-2");
    assert_eq!(binding.roles, [Contributor, Editor]);
    assert_eq!(
        joined.authorization.revision,
        base.authorization.revision + 1
    );
    assert_eq!(
        joined.collaboration.revision,
        base.collaboration.revision + 1
    );
    assert_eq!(
        joined
            .collaboration
            .participants
            .last()
            .unwrap()
            .display_name,
        "Grace"
    );
    assert_eq!(joined.invitations[0].state, InvitationState::Accepted);
    assert_eq!(joined.invitations[0].token_hash, None);
    assert_eq!(
        accept(&joined, "grace-admin", &token, "grace", NOW + 6).unwrap_err(),
        InvitationError::Unavailable
    );
}

#[test]
fn expired_revoked_declined_and_reissued_tokens_stop_working() {
    let (base, token) = invite_grace(&record());
    assert!(accept(&base, "grace-admin", &token, "grace", NOW + 7 * DAY - 1).is_ok());
    assert_eq!(
        accept(&base, "grace-admin", &token, "grace", NOW + 7 * DAY).unwrap_err(),
        InvitationError::Unavailable
    );
    assert_eq!(
        base.invitations[0].status(NOW + 7 * DAY),
        InvitationState::Expired
    );

    let revoked = base
        .revoke_invitation("ada-admin", &identities(), "invitation-aaa", NOW)
        .unwrap();
    assert_eq!(
        accept(&revoked, "grace-admin", &token, "grace", NOW).unwrap_err(),
        InvitationError::Unavailable
    );
    assert_eq!(
        revoked
            .revoke_invitation("ada-admin", &identities(), "invitation-aaa", NOW)
            .unwrap_err(),
        InvitationError::Unavailable
    );

    let declined = base.decline_invitation("grace-admin", &token, NOW).unwrap();
    assert_eq!(declined.invitations[0].state, InvitationState::Declined);
    assert_eq!(
        base.decline_invitation("linus-admin", &token, NOW)
            .unwrap_err(),
        InvitationError::Unavailable
    );
    assert_eq!(
        accept(&declined, "grace-admin", &token, "grace", NOW).unwrap_err(),
        InvitationError::Unavailable
    );

    for (source, at) in [(&base, NOW + 8 * DAY), (&declined, NOW), (&base, NOW)] {
        let replacement = NewInvitation {
            id: "invitation-bbb".into(),
            secret: secret('b'),
            lifetime_days: 3,
            ..NewInvitation::default()
        };
        let (next, fresh) = source
            .reissue_invitation(
                "ada-admin",
                &identities(),
                "invitation-aaa",
                &replacement,
                at,
            )
            .unwrap();
        assert_eq!(
            accept(&next, "grace-admin", &token, "grace", at).unwrap_err(),
            InvitationError::Unavailable
        );
        assert!(accept(&next, "grace-admin", &fresh, "grace", at).is_ok());
        assert_eq!(next.invitations.last().unwrap().expires_at - at, 3 * DAY);
    }
    let (joined, _) = (
        accept(&base, "grace-admin", &token, "grace", NOW).unwrap(),
        (),
    );
    let replacement = new("grace-admin", "grace", &[Contributor], 'b');
    assert_eq!(
        joined
            .reissue_invitation(
                "ada-admin",
                &identities(),
                "invitation-aaa",
                &replacement,
                NOW
            )
            .unwrap_err(),
        InvitationError::Unavailable
    );
}

#[test]
fn invalid_duplicate_and_unbindable_invitations_are_refused() {
    let base = record();
    let (pending, _) = invite_grace(&base);
    let field =
        |result: Result<(SharedPublication, String), InvitationError>| match result.unwrap_err() {
            InvitationError::Invalid(field) => field,
            other => panic!("unexpected {other:?}"),
        };
    let user = |record: &SharedPublication, user: &str, key: &str, roles: &[AuthorizationRole]| {
        field(invite(record, "ada-admin", user, key, roles, 'b'))
    };
    assert_eq!(
        user(&base, "ada-admin", "kay", &[Contributor]),
        InvitationField::AdminUser
    );
    assert_eq!(
        user(&pending, "grace-admin", "kay", &[Contributor]),
        InvitationField::AdminUser
    );
    assert_eq!(
        user(&base, "ghost", "kay", &[Contributor]),
        InvitationField::AdminUser
    );
    assert_eq!(
        user(&base, "kay-admin", "ada", &[Contributor]),
        InvitationField::ContributorId
    );
    assert_eq!(
        user(&pending, "kay-admin", "grace", &[Contributor]),
        InvitationField::ContributorId
    );
    assert_eq!(
        user(&base, "kay-admin", "ghost", &[Contributor]),
        InvitationField::ContributorId
    );
    assert_eq!(user(&base, "kay-admin", "kay", &[]), InvitationField::Roles);
    assert_eq!(
        user(&base, "kay-admin", "kay", &[Editor, Editor]),
        InvitationField::Roles
    );
    let mut long = new("kay-admin", "kay", &[Editor], 'b');
    long.lifetime_days = 31;
    assert_eq!(
        field(base.invite("ada-admin", &identities(), &long, NOW)),
        InvitationField::Lifetime
    );
    let mut weak = new("kay-admin", "kay", &[Editor], 'b');
    weak.secret = "abc".into();
    assert_eq!(
        field(base.invite("ada-admin", &identities(), &weak, NOW)),
        InvitationField::Capacity
    );

    let (other, token) = invite(
        &base,
        "ada-admin",
        "grace-admin",
        "grace",
        &[Contributor],
        'c',
    )
    .unwrap();
    let mut taken = other.clone();
    taken.authorization.bindings.push(IdentityBinding {
        admin_user: "grace-admin".into(),
        contributor_id: "ann".into(),
        participant_id: "participant-9".into(),
        roles: vec![Contributor],
    });
    assert_eq!(
        accept(&taken, "grace-admin", &token, "grace", NOW).unwrap_err(),
        InvitationError::Unavailable
    );
}

#[test]
fn removing_an_account_withdraws_its_invitation_and_old_records_still_load() {
    let (base, token) = invite_grace(&record());
    let withdrawn = base.without_admin_user("grace-admin").unwrap();
    assert_eq!(withdrawn.invitations[0].state, InvitationState::Revoked);
    assert_eq!(
        accept(&withdrawn, "grace-admin", &token, "grace", NOW).unwrap_err(),
        InvitationError::Unavailable
    );
    assert!(base.without_admin_user("kay-admin").is_none());

    let legacy = serde_json::to_string(&record()).unwrap();
    assert!(!legacy.contains("invitations"));
    assert!(SharedPublication::from_json(&legacy).is_ok());
}

#[test]
fn the_invitation_list_is_bounded_and_finished_ones_make_room() {
    let mut base = record();
    for index in 0..MAX_INVITATIONS {
        let id = format!("invitation-{index:03}");
        let request = NewInvitation {
            id: id.clone(),
            ..new("grace-admin", "grace", &[Reader], 'a')
        };
        let at = NOW + index as i64;
        let (next, _) = base
            .invite("ada-admin", &identities(), &request, at)
            .unwrap();
        base = next
            .revoke_invitation("ada-admin", &identities(), &id, at)
            .unwrap();
    }
    assert_eq!(base.invitations.len(), MAX_INVITATIONS);
    let (next, _) = invite(&base, "ada-admin", "grace-admin", "grace", &[Editor], 'f').unwrap();
    assert_eq!(next.invitations.len(), MAX_INVITATIONS);
    assert!(next
        .invitations
        .iter()
        .all(|invitation| invitation.id != "invitation-000"));
}

#[test]
fn an_invitation_lapses_when_its_inviter_loses_the_authority_to_grant_it() {
    let (base, token) = invite(
        &record(),
        "ada-admin",
        "linus-admin",
        "linus",
        &[Coordinator],
        'c',
    )
    .unwrap();
    let base = accept(&base, "linus-admin", &token, "linus", NOW).unwrap();
    let (base, kay_token) =
        invite(&base, "linus-admin", "kay-admin", "kay", &[Editor], 'd').unwrap();

    // The coordinator's account is removed, or their registry key is, before the invitee answers.
    let gone = base.without_admin_user("linus-admin").unwrap();
    assert_eq!(
        accept(&gone, "kay-admin", &kay_token, "kay", NOW).unwrap_err(),
        InvitationError::Unavailable
    );
    let no_key = Identities {
        active_admin_users: &USERS,
        contributor_ids: &["ada", "kay"],
    };
    assert_eq!(
        base.accept_invitation("kay-admin", &no_key, &kay_token, "kay", "Kay", NOW)
            .unwrap_err(),
        InvitationError::Unavailable
    );
    assert!(accept(&base, "kay-admin", &kay_token, "kay", NOW).is_ok());
}
