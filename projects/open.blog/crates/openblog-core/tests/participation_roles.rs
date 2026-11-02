//! Who an Admin session is in moderation (ADR 0103). A shared publication's
//! works are the path of the post loaded from `posts/{publication_id}.md`,
//! resolved from the loaded site at request time; on them a bound co-writer
//! has their publication roles, and elsewhere every Admin user is the site
//! Admin. Only the site Admin and the submitter see a reader's private name.

use openblog_core::collaboration::{
    valid_admin_username, AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication,
    NewSourceReference, Participant, SharedPublication, SourceKind,
};
use openblog_core::config::SiteConfig;
use openblog_core::invitation::Identities;
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::moderation::{
    may_view, Actor, ActorRole, ItemFacts, ModerationAction, ModerationPolicy, ModerationState,
    PolicyError, Principal, Request, SharedWorks, View, MODERATION_TOKEN_ACTOR,
};
use openblog_core::participation::{ParticipationKind, ParticipationMode};
use openblog_core::DateTime;

const SHARED: &str = "shared-tides";
const UNPUBLISHED: &str = "shared-unpublished";

fn site(posts: &[(&str, &str)]) -> Site {
    let config =
        SiteConfig::from_json(r#"{"title":"T","url":"https://t.dev","postPath":"/posts/{slug}/"}"#)
            .unwrap();
    Site::load(
        config,
        Sources {
            posts: posts
                .iter()
                .map(|(path, front_matter)| SourceFile {
                    path: (*path).into(),
                    contents: format!("---\ntitle: P\ndate: 2026-01-01\n{front_matter}---\nText"),
                })
                .collect(),
            ..Sources::default()
        },
        LoadOptions::default(),
    )
    .unwrap()
}

/// A shared publication created by `owner-admin` (site owner and
/// contributor), with one more participant per `(name, role)`, each bound
/// under `{name}-admin`.
fn record(publication_id: &str, members: &[(&str, AuthorizationRole)]) -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: publication_id.into(),
        title: "Tides, together".into(),
        guiding_question: String::new(),
        sources: vec![NewSourceReference {
            kind: SourceKind::Article,
            title: "Tide tables".into(),
            ..NewSourceReference::default()
        }],
        creator: NewParticipant {
            admin_user: "owner-admin".into(),
            contributor_id: "owner".into(),
            display_name: "Owner".into(),
        },
    })
    .unwrap();
    for (name, role) in members {
        record.collaboration.participants.push(Participant {
            id: (*name).into(),
            display_name: (*name).into(),
            profile_url: None,
        });
        record.authorization.bindings.push(IdentityBinding {
            admin_user: format!("{name}-admin"),
            contributor_id: (*name).into(),
            participant_id: (*name).into(),
            roles: vec![*role],
        });
    }
    record
}

#[test]
fn a_shared_publications_work_is_the_path_of_its_loaded_post() {
    let site = site(&[(&format!("posts/{SHARED}.md"), ""), ("posts/solo.md", "")]);
    let records = [record(SHARED, &[]), record(UNPUBLISHED, &[])];
    let works = SharedWorks::new(&records, &site);
    assert_eq!(works.works(SHARED), [format!("/posts/{SHARED}/").as_str()]);
    // A publication whose post is not loaded, or an unknown publication, has
    // no work, so nobody holds a publication role on anything through it.
    assert!(works.works(UNPUBLISHED).is_empty());
    assert!(works.works("shared-unknown").is_empty());
}

#[test]
fn a_renamed_slug_moves_the_work_with_the_post() {
    let path = format!("posts/{SHARED}.md");
    let records = [record(SHARED, &[])];
    let before = site(&[(&path, "slug: tides\n"), ("posts/solo.md", "")]);
    assert_eq!(
        SharedWorks::new(&records, &before).works(SHARED),
        ["/posts/tides/"]
    );
    // The file keeps its publication id; only the slug changes, and the work
    // follows it on the next request.
    let after = site(&[(&path, "slug: high-water\n"), ("posts/solo.md", "")]);
    assert_eq!(
        SharedWorks::new(&records, &after).works(SHARED),
        ["/posts/high-water/"]
    );
    // A post that merely has the publication's slug is not its work.
    let impostor = site(&[("posts/other.md", &format!("slug: {SHARED}\n"))]);
    assert!(SharedWorks::new(&records, &impostor)
        .works(SHARED)
        .is_empty());
}

const OTHER: &str = "shared-other";
const TIDES: &str = "/posts/tides/";
const SOLO: &str = "/posts/solo/";
const USERS: [&str; 7] = [
    "owner-admin",
    "coord-admin",
    "writer-admin",
    "editor-admin",
    "reader-admin",
    "other-admin",
    "solo-admin",
];
const KEYS: [&str; 6] = ["owner", "coord", "writer", "editor", "reader", "other"];
const CO_WRITERS: [&str; 5] = [
    "owner-admin",
    "coord-admin",
    "writer-admin",
    "editor-admin",
    "reader-admin",
];

fn identities() -> Identities<'static> {
    Identities {
        active_admin_users: &USERS,
        contributor_ids: &KEYS,
    }
}

/// `SHARED` at `/posts/{tides_slug}/`, where `owner-admin` is site owner and
/// contributor and every other role has one member; `OTHER` at
/// `/posts/shared-other/`, created by `other-admin` alone; and the ordinary
/// post `/posts/solo/`.
fn fixture(tides_slug: &str) -> (Vec<SharedPublication>, Site) {
    let mut other = record(OTHER, &[]);
    other.authorization.bindings[0].admin_user = "other-admin".into();
    other.authorization.bindings[0].contributor_id = "other".into();
    let records = vec![
        record(
            SHARED,
            &[
                ("coord", AuthorizationRole::Coordinator),
                ("writer", AuthorizationRole::Contributor),
                ("editor", AuthorizationRole::Editor),
                ("reader", AuthorizationRole::Reader),
            ],
        ),
        other,
    ];
    let site = site(&[
        (
            &format!("posts/{SHARED}.md"),
            &format!("slug: {tides_slug}\n"),
        ),
        (&format!("posts/{OTHER}.md"), ""),
        ("posts/solo.md", ""),
    ]);
    (records, site)
}

fn pending_question(work: Option<&'static str>) -> ItemFacts<'static> {
    ItemFacts {
        id: "item-1",
        kind: ParticipationKind::Question,
        work,
        parent: None,
        state: ModerationState::Pending,
        version: 1,
        revision: 1,
        approved_revision: None,
        clarification_asked: None,
        clarification_consent: true,
        content_retained: true,
        state_since: DateTime::from_unix(1_800_000_000),
    }
}

fn session(admin_user: &str) -> Principal<'_> {
    Principal::AdminSession { admin_user }
}

#[test]
fn a_co_writer_on_a_shared_work_cannot_see_private_names_on_that_work() {
    let (records, site) = fixture("tides");
    let works = SharedWorks::new(&records, &site);
    let item = pending_question(Some(TIDES));
    let open = ParticipationMode::Open;
    for user in CO_WRITERS {
        let actor = works.actor(session(user), Some(TIDES), &identities());
        assert_ne!(actor.role(), ActorRole::SiteAdmin, "{user}");
        assert!(
            !may_view(&actor, &item, open, View::PrivateIdentity),
            "{user} sees a reader's private name on a shared work"
        );
    }
    // Each has their publication role, for that publication's works only.
    let role = |user| works.actor(session(user), Some(TIDES), &identities());
    assert_eq!(
        role("owner-admin"),
        Actor::Coordinator {
            admin_user: "owner-admin",
            works: &[TIDES],
        },
        "a publication's site owner is its coordinator, not the site Admin"
    );
    assert_eq!(
        role("coord-admin"),
        Actor::Coordinator {
            admin_user: "coord-admin",
            works: &[TIDES],
        }
    );
    assert_eq!(
        role("writer-admin"),
        Actor::ContributingAuthor {
            admin_user: "writer-admin",
            works: &[TIDES],
        }
    );
    assert_eq!(role("editor-admin"), Actor::Public);
    assert_eq!(role("reader-admin"), Actor::Public);
    // Coordinators and authors in scope still read the pending text.
    for (user, sees) in [
        ("owner-admin", true),
        ("coord-admin", true),
        ("writer-admin", true),
        ("editor-admin", false),
        ("reader-admin", false),
    ] {
        assert_eq!(
            may_view(&role(user), &item, open, View::Content),
            sees,
            "{user}"
        );
    }
    // The publication's site owner moderates there but cannot reopen.
    let policy = ModerationPolicy::default();
    let approve = Request {
        actor: role("owner-admin"),
        action: ModerationAction::Approve,
        expected_version: 1,
        reason: None,
        at: DateTime::from_unix(1_800_000_000),
        reported_item: None,
    };
    assert!(policy.decide(&item, &approve).is_ok());
    let rejected = ItemFacts {
        state: ModerationState::Rejected,
        ..item
    };
    let reopen = Request {
        action: ModerationAction::Reopen,
        ..approve
    };
    assert_eq!(policy.decide(&rejected, &reopen), Err(PolicyError::Denied));

    // Only the site Admin and the submitter see private names there: the
    // moderation token, and Admin users with no binding in the publication.
    for actor in [
        works.actor(Principal::ModerationToken, Some(TIDES), &identities()),
        works.actor(session("solo-admin"), Some(TIDES), &identities()),
        works.actor(session("other-admin"), Some(TIDES), &identities()),
        Actor::Submitter,
    ] {
        assert!(
            may_view(&actor, &item, open, View::PrivateIdentity),
            "{actor:?}"
        );
    }
}

#[test]
fn outside_their_shared_publications_admin_users_are_the_site_admin() {
    let (records, site) = fixture("tides");
    let works = SharedWorks::new(&records, &site);
    for user in CO_WRITERS.into_iter().chain(["solo-admin"]) {
        // An ordinary post, another publication's work, or an item without a
        // work: every Admin user edits everything (ADR 0006).
        for work in [Some(SOLO), Some("/posts/shared-other/"), None] {
            assert_eq!(
                works.actor(session(user), work, &identities()),
                Actor::SiteAdmin { admin_user: user },
                "{user} {work:?}"
            );
        }
    }
    // The moderation token is the site Admin everywhere, under a name no
    // Admin account can have.
    for work in [Some(TIDES), Some(SOLO), Some("/posts/gone/"), None] {
        assert_eq!(
            works.actor(Principal::ModerationToken, work, &identities()),
            Actor::SiteAdmin {
                admin_user: MODERATION_TOKEN_ACTOR,
            }
        );
    }
    assert!(!valid_admin_username(MODERATION_TOKEN_ACTOR));
}

#[test]
fn a_binding_that_no_longer_resolves_or_an_unknown_path_fails_closed() {
    let (records, site) = fixture("tides");
    let works = SharedWorks::new(&records, &site);
    // The writer's registry key was renamed: the binding grants nothing, and
    // it never falls back to the site Admin on that work.
    let without_writer = Identities {
        active_admin_users: &USERS,
        contributor_ids: &["owner", "coord", "editor", "reader", "other"],
    };
    assert_eq!(
        works.actor(session("writer-admin"), Some(TIDES), &without_writer),
        Actor::Public
    );
    // A path no loaded post has (deleted, or a slug since renamed): a bound
    // account cannot tell whether it is a shared work, so it gets nothing;
    // an account bound nowhere is still the site Admin.
    for user in CO_WRITERS {
        assert_eq!(
            works.actor(session(user), Some("/posts/gone/"), &identities()),
            Actor::Public,
            "{user}"
        );
    }
    assert_eq!(
        works.actor(session("solo-admin"), Some("/posts/gone/"), &identities()),
        Actor::SiteAdmin {
            admin_user: "solo-admin"
        }
    );
}

#[test]
fn after_a_slug_rename_roles_follow_the_post_and_the_old_path_fails_closed() {
    let (records, site) = fixture("high-water");
    let works = SharedWorks::new(&records, &site);
    assert_eq!(
        works.actor(
            session("writer-admin"),
            Some("/posts/high-water/"),
            &identities()
        ),
        Actor::ContributingAuthor {
            admin_user: "writer-admin",
            works: &["/posts/high-water/"],
        }
    );
    // Items stored against the old path stay out of a co-writer's private view.
    let old = pending_question(Some(TIDES));
    let actor = works.actor(session("writer-admin"), Some(TIDES), &identities());
    assert_eq!(actor, Actor::Public);
    assert!(!may_view(
        &actor,
        &old,
        ParticipationMode::Open,
        View::PrivateIdentity
    ));
}
