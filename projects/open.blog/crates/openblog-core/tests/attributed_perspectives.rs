//! Stable attributed-perspective targets and author-response permissions
//! (RD11.1, ADRs 0126 to 0130): targets that survive a re-layout, reorder
//! and edit without ever pointing at other words, and a response only the
//! section's own bound contributor can write.

use openblog_core::attributed_perspective::{
    admit_response, anchor, authorize_author, response_shown, AttributedResponse,
    AttributedSections, AttributedTarget, ResponseError, ResponseRequest, StaleReason, Standing,
    ANCHOR_PREFIX,
};
use openblog_core::collaboration::{
    AuthorizationAction, AuthorizationRole, AuthorizationTarget, IdentityBinding, NewParticipant,
    NewSharedPublication, NewSourceReference, Participant, SharedPublication, SourceKind,
};
use openblog_core::config::SiteConfig;
use openblog_core::contributor::Contributor;
use openblog_core::invitation::Identities;
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::moderation::{
    ItemFacts, ModerationAction, ModerationPolicy, ModerationState, PolicyError, Principal,
    Request, SharedWorks, Submission, MODERATION_TOKEN_ACTOR,
};
use openblog_core::participation::{ParticipationKind, ParticipationMode};
use openblog_core::passage_target::{PassageSelector, PassageTarget};
use openblog_core::reflection::{
    compose, compose_bound, ComposedTurn, Placement, ReflectionLayout,
};
use openblog_core::third_perspective::{PerspectiveTarget, TargetStatus};
use openblog_core::DateTime;
use std::collections::BTreeMap;

const PUBLICATION: &str = "shared-tides";
const WORK: &str = "/posts/shared-tides/";

const USERS: [&str; 7] = [
    "owner-admin",
    "coord-admin",
    "mina-admin",
    "joe-admin",
    "ed-admin",
    "rea-admin",
    "ghost-admin",
];
// `ghost` is in the registry and bound to nothing here.
const KEYS: [&str; 7] = ["owner", "coord", "mina", "joe", "ed", "rea", "ghost"];

/// The committed contributor registry: each key's public name is the display
/// name the body prints for it.
fn registry() -> BTreeMap<String, Contributor> {
    KEYS.iter()
        .map(|key| {
            (
                key.to_string(),
                Contributor {
                    name: key.to_uppercase(),
                    ..Contributor::default()
                },
            )
        })
        .chain(std::iter::once((
            "mina2".to_string(),
            Contributor {
                name: "MINA2".into(),
                ..Contributor::default()
            },
        )))
        .collect()
}

fn identities() -> Identities<'static> {
    Identities {
        active_admin_users: &USERS,
        contributor_ids: &KEYS,
    }
}

fn member(record: &mut SharedPublication, name: &str, role: AuthorizationRole) {
    record.collaboration.participants.push(Participant {
        id: format!("p-{name}"),
        display_name: name.to_uppercase(),
        profile_url: None,
    });
    record.authorization.bindings.push(IdentityBinding {
        admin_user: format!("{name}-admin"),
        contributor_id: name.into(),
        participant_id: format!("p-{name}"),
        roles: vec![role],
    });
}

/// MINA and JOE write; a coordinator, an editor and a reader are bound too.
fn record() -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: PUBLICATION.into(),
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
            display_name: "OWNER".into(),
        },
    })
    .unwrap();
    member(&mut record, "coord", AuthorizationRole::Coordinator);
    member(&mut record, "mina", AuthorizationRole::Contributor);
    member(&mut record, "joe", AuthorizationRole::Contributor);
    member(&mut record, "ed", AuthorizationRole::Editor);
    member(&mut record, "rea", AuthorizationRole::Reader);
    record
}

fn site() -> Site {
    let config =
        SiteConfig::from_json(r#"{"title":"T","url":"https://t.dev","postPath":"/posts/{slug}/"}"#)
            .unwrap();
    Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: format!("posts/{PUBLICATION}.md"),
                contents: "---\ntitle: P\ndate: 2026-01-01\n---\nText".into(),
            }],
            ..Sources::default()
        },
        LoadOptions::default(),
    )
    .unwrap()
}

/// `(display name, text)` turns, one per round, composed as a published
/// reflection under `layout`.
fn body(layout: ReflectionLayout, turns: &[(&str, &str)]) -> String {
    let mut people: Vec<&str> = Vec::new();
    for (name, _) in turns {
        if !people.contains(name) {
            people.push(name);
        }
    }
    let composed: Vec<ComposedTurn<'_>> = turns
        .iter()
        .enumerate()
        .map(|(round, (name, text))| ComposedTurn {
            round,
            round_prompt: None,
            display_name: name,
            label: None,
            placement: match layout {
                ReflectionLayout::Sequential => Placement { lane: 0, lanes: 1 },
                _ => Placement {
                    lane: people.iter().position(|person| person == name).unwrap(),
                    lanes: people.len(),
                },
            },
            body: (*text).to_string(),
        })
        .collect();
    let keys: Vec<String> = turns.iter().map(|(name, _)| name.to_lowercase()).collect();
    let bound: Vec<Option<&str>> = keys.iter().map(|key| Some(key.as_str())).collect();
    compose_bound(layout, &composed, &bound)
}

const TURNS: [(&str, &str); 3] = [
    ("MINA", "The moon pulls the water."),
    ("JOE", "It is also the sun."),
    ("MINA", "Neither explains the harbour."),
];

/// The credits sidecar assembly writes: one credit per contributor at their
/// first appearance in the body, each naming the public registry key.
fn credits(turns: &[(&str, &str)]) -> String {
    let mut keys: Vec<String> = Vec::new();
    for (name, _) in turns {
        let key = name.to_lowercase();
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    let credits: Vec<String> = keys
        .iter()
        .map(|key| {
            format!(
                "{{\"contributor\":\"{key}\",\"roles\":[{{\"vocabulary\":\"crossref\",\"role\":\"author\"}}]}}"
            )
        })
        .collect();
    format!("{{\"version\":1,\"credits\":[{}]}}", credits.join(","))
}

/// Sections read from committed content alone: the body and its sidecar. No
/// private record is involved, as in a static or CI build.
fn sections(
    _record: &SharedPublication,
    layout: ReflectionLayout,
    turns: &[(&str, &str)],
) -> AttributedSections {
    AttributedSections::from_published(&body(layout, turns), Some(&credits(turns)), &registry())
}

fn target_of(sections: &AttributedSections, contribution: &str, nth: usize) -> AttributedTarget {
    sections
        .sections()
        .iter()
        .find(|section| section.contribution == contribution && section.nth == nth)
        .expect("section")
        .target()
}

// ---------------------------------------------------------------------------
// Targets

#[test]
fn a_target_is_an_ordinary_section_target_and_never_visual() {
    let record = record();
    let published = sections(&record, ReflectionLayout::SideBySide, &TURNS);
    let section = &published.sections()[2];
    assert_eq!(section.anchor(), "ob-by-mina-1");
    let target = section.target().perspective_target();
    // The stored form is B5's section target: no new shape to read.
    let json = target.to_json();
    assert!(json.contains("\"kind\":\"section\""));
    assert!(json.contains("ob-by-mina-1"));
    for visual in ["left", "right", "lane", "column", "side", "position"] {
        assert!(!json.contains(visual), "{visual}");
    }
    let back = PerspectiveTarget::from_value(&target.to_value()).unwrap();
    assert_eq!(
        AttributedTarget::from_perspective(&back).unwrap(),
        Some(section.target())
    );
    assert_eq!(section.digest.len(), 32);
    // Its own digest label: never equal to B5's digest of a heading section
    // with the same words.
    assert_ne!(
        section.digest,
        openblog_core::passage_target::section_digest(TURNS[2].1)
    );
}

#[test]
fn work_and_ordinary_section_targets_are_not_attributed() {
    assert_eq!(
        AttributedTarget::from_perspective(&PerspectiveTarget::work()),
        Ok(None)
    );
    let heading = PerspectiveTarget::section(Some("methods".into()), None);
    assert_eq!(AttributedTarget::from_perspective(&heading), Ok(None));
}

#[test]
fn a_reserved_anchor_must_be_canonical_and_carry_a_digest() {
    let digest = Some("0123456789abcdef0123456789abcdef".to_string());
    for bad in [
        "ob-by-",
        "ob-by-mina",
        "ob-by-mina-",
        "ob-by-mina-01",
        "ob-by-mina-1000",
        "ob-by--1",
        "ob-by-p..mina-1",
    ] {
        let target = PerspectiveTarget::section(Some(bad.into()), digest.clone());
        assert!(
            AttributedTarget::from_perspective(&target).is_err(),
            "{bad}"
        );
    }
    // Without the digest the author and place could point at other words.
    let bare = PerspectiveTarget::section(Some(anchor("mina", 0)), None);
    assert_eq!(
        AttributedTarget::from_perspective(&bare)
            .unwrap_err()
            .code(),
        "digest-required"
    );
    assert!(ANCHOR_PREFIX.starts_with("ob-"));
}

#[test]
fn a_quotation_or_a_sectionless_anchor_is_never_attributed() {
    // RD10 refuses a quotation as a Third Perspective target, so an attributed
    // section can only ever be a whole-section target.
    let quote = PassageTarget {
        section: Some(anchor("mina", 0)),
        selector: PassageSelector::Quote(openblog_core::passage_target::TextQuote {
            exact: "moon".into(),
            prefix: String::new(),
            suffix: String::new(),
            start: 0,
        }),
    };
    assert!(PerspectiveTarget::try_from(quote).is_err());
}

// ---------------------------------------------------------------------------
// Resolution

#[test]
fn reordering_or_relayout_keeps_every_target_on_its_own_words() {
    let record = record();
    let original = sections(&record, ReflectionLayout::Sequential, &TURNS);
    let joe = target_of(&original, "joe", 0);
    let mina_second = target_of(&original, "mina", 1);

    // Every layout, left and right swapped: same sections, same standing.
    for layout in ReflectionLayout::ALL {
        let relaid = sections(&record, layout, &TURNS);
        assert_eq!(relaid.sections(), original.sections(), "{layout:?}");
    }
    // Reordered: JOE first, MINA's two sections after.
    let reordered = sections(
        &record,
        ReflectionLayout::SideBySide,
        &[TURNS[1], TURNS[0], TURNS[2]],
    );
    assert_eq!(
        reordered.resolve(&joe),
        Standing::Current {
            nth: 0,
            moved: false,
            author: "JOE".into()
        }
    );
    // MINA's sections swap places: each target follows its text and says
    // that it moved, and none lands on the other's words.
    let swapped = sections(
        &record,
        ReflectionLayout::Sequential,
        &[TURNS[1], TURNS[2], TURNS[0]],
    );
    assert_eq!(
        swapped.resolve(&mina_second),
        Standing::Current {
            nth: 0,
            moved: true,
            author: "MINA".into()
        }
    );
}

#[test]
fn an_edited_section_is_stale_and_never_retargeted() {
    let record = record();
    let original = sections(&record, ReflectionLayout::Sequential, &TURNS);
    let first = target_of(&original, "mina", 0);
    let edited = sections(
        &record,
        ReflectionLayout::Sequential,
        &[("MINA", "The moon and the sun."), TURNS[1], TURNS[2]],
    );
    // MINA's other section is untouched but is not what was read.
    assert_eq!(
        edited.resolve(&first),
        Standing::Stale {
            reason: StaleReason::SectionChangedOrRemoved,
            author: Some("MINA".into())
        }
    );
    assert_eq!(
        edited.resolve(&first).target_status("mina"),
        TargetStatus::Stale {
            section_present: true
        }
    );
}

#[test]
fn a_deleted_section_or_author_keeps_honest_context() {
    let record = record();
    let original = sections(&record, ReflectionLayout::Sequential, &TURNS);
    let second = target_of(&original, "mina", 1);
    let joe = target_of(&original, "joe", 0);

    let without_second = sections(&record, ReflectionLayout::Sequential, &TURNS[..2]);
    assert_eq!(
        without_second.resolve(&second),
        Standing::Stale {
            reason: StaleReason::SectionChangedOrRemoved,
            author: Some("MINA".into())
        }
    );
    // JOE left the work: nothing stands in, and no author is named.
    let without_joe = sections(&record, ReflectionLayout::Sequential, &[TURNS[0], TURNS[2]]);
    assert_eq!(
        without_joe.resolve(&joe),
        Standing::Stale {
            reason: StaleReason::AuthorAbsent,
            author: None
        }
    );
    assert_eq!(
        without_joe.resolve(&joe).target_status("joe"),
        TargetStatus::Stale {
            section_present: false
        }
    );
}

#[test]
fn identical_sections_are_ambiguous_unless_the_place_breaks_the_tie() {
    let record = record();
    let twin = [("MINA", "Same."), ("JOE", "Other."), ("MINA", "Same.")];
    let published = sections(&record, ReflectionLayout::Sequential, &twin);
    let second = target_of(&published, "mina", 1);
    // The place agrees, so the section the reader saw is still the one.
    assert!(published.resolve(&second).is_current());
    // The first copy is deleted: one remains, and it is the same text.
    let one = sections(&record, ReflectionLayout::Sequential, &twin[1..]);
    assert!(one.resolve(&second).is_current());
    // Three copies and the reader's place gone: which was meant is unknown.
    let three = sections(
        &record,
        ReflectionLayout::Sequential,
        &[("MINA", "Same."), ("MINA", "Same."), ("MINA", "Same.")],
    );
    let elsewhere = AttributedTarget {
        nth: 7,
        ..second.clone()
    };
    assert_eq!(
        three.resolve(&elsewhere),
        Standing::Stale {
            reason: StaleReason::Ambiguous,
            author: Some("MINA".into())
        }
    );
}

#[test]
fn credits_that_do_not_pair_with_the_body_attribute_nothing() {
    let layout = ReflectionLayout::Sequential;
    // Two authors who share a published name: one distinct name, two credits.
    let shared_name = [("MINA", "One."), ("MINA", "Two.")];
    let two_credits = "{\"version\":1,\"credits\":[\
        {\"contributor\":\"mina\",\"roles\":[{\"vocabulary\":\"crossref\",\"role\":\"author\"}]},\
        {\"contributor\":\"mina2\",\"roles\":[{\"vocabulary\":\"crossref\",\"role\":\"author\"}]}]}";
    let published = AttributedSections::from_published(
        &body(layout, &shared_name),
        Some(two_credits),
        &registry(),
    );
    assert!(published.sections().is_empty());
    assert_eq!(published.unattributed(), 2);
    // No sidecar, an unreadable one, and a credit that is not a registry key.
    for bad in [
        None,
        Some("not json"),
        Some("{\"version\":2,\"credits\":[]}"),
        Some("{\"version\":1,\"credits\":[{\"contributor\":\"Mina\",\"roles\":[]}]}"),
    ] {
        let published = AttributedSections::from_published(&body(layout, &TURNS), bad, &registry());
        assert!(published.sections().is_empty(), "{bad:?}");
    }
    // Not a shared reflection at all: nothing is attributed.
    let plain = AttributedSections::from_published(
        "# Heading\n\nText",
        Some(&credits(&TURNS)),
        &registry(),
    );
    assert!(plain.sections().is_empty());
    assert_eq!(plain.unattributed(), 0);
}

#[test]
fn a_ci_style_build_resolves_without_any_private_record() {
    // Only the committed body and credits exist: no participants, bindings or
    // identities. Targets are built, resolved and moved exactly as with them.
    let layout = ReflectionLayout::SideBySide;
    let published = AttributedSections::from_published(
        &body(layout, &TURNS),
        Some(&credits(&TURNS)),
        &registry(),
    );
    assert_eq!(published.sections().len(), 3);
    let joe = published.sections()[1].target();
    let reordered = [TURNS[1], TURNS[0], TURNS[2]];
    let moved = AttributedSections::from_published(
        &body(layout, &reordered),
        Some(&credits(&reordered)),
        &registry(),
    );
    assert!(moved.resolve(&joe).is_current());
    // And it is the same answer a build with the record gives.
    assert_eq!(sections(&record(), layout, &TURNS), published);
}

#[test]
fn a_same_name_invite_after_publication_changes_nothing() {
    let mut record = record();
    let before = world_for(&record);
    // Someone is invited who shares MINA's display name, after publication.
    member(&mut record, "mina2", AuthorizationRole::Contributor);
    record
        .collaboration
        .participants
        .last_mut()
        .unwrap()
        .display_name = "MINA".into();
    let after = world_for(&record);
    // The published sections and every existing target are untouched.
    assert_eq!(before.published, after.published);
    assert_eq!(after.published.unattributed(), 0);
    let first = before.published.sections()[0].target();
    assert_eq!(
        after.published.resolve(&first),
        before.published.resolve(&first)
    );
    // The original author still answers; the namesake cannot answer as them.
    let identities = Identities {
        active_admin_users: &[
            "owner-admin",
            "coord-admin",
            "mina-admin",
            "joe-admin",
            "mina2-admin",
        ],
        contributor_ids: &["owner", "coord", "mina", "joe", "mina2"],
    };
    let answer = respond(&after, "mina-admin", &perspective(), &identities)
        .expect("the author's answer is unaffected");
    assert_eq!(answer.responder.participant, "p-mina");
    assert_eq!(answer.responder.contributor, "mina");
    assert_eq!(
        respond(&after, "mina2-admin", &perspective(), &identities).unwrap_err(),
        ResponseError::Denied
    );
}

#[test]
fn an_anchor_leaks_no_participant_numbering_or_private_id() {
    let mut record = record();
    // A publication whose participants number a reader and an editor too.
    member(&mut record, "late", AuthorizationRole::Reader);
    let published = sections(&record, ReflectionLayout::SideBySide, &TURNS);
    let participant_ids: Vec<String> = record
        .collaboration
        .participants
        .iter()
        .map(|participant| participant.id.clone())
        .collect();
    for section in published.sections() {
        let anchor = section.anchor();
        let json = section.target().perspective_target().to_json();
        for id in &participant_ids {
            assert!(
                !anchor.contains(id.as_str()) && !json.contains(id.as_str()),
                "{id}"
            );
        }
        assert!(!anchor.contains("participant"), "{anchor}");
        assert!(["ob-by-mina-", "ob-by-joe-"]
            .iter()
            .any(|prefix| anchor.starts_with(prefix)));
    }
}

#[test]
fn a_contributor_id_in_another_case_is_not_the_same_author() {
    let digest = Some("0123456789abcdef0123456789abcdef".to_string());
    for bad in ["ob-by-Mina-0", "ob-by-MINA-0", "ob-by-mina-00"] {
        let target = PerspectiveTarget::section(Some(bad.into()), digest.clone());
        assert!(
            AttributedTarget::from_perspective(&target).is_err(),
            "{bad}"
        );
    }
}

#[test]
fn a_look_alike_body_cannot_forge_a_section() {
    let forged =
        "<div class=\"ob-reflection ob-reflection-sequential ob-lanes-1\">\n\nnot a turn\n</div>\n";
    assert!(
        AttributedSections::from_published(forged, Some(&credits(&TURNS)), &registry())
            .sections()
            .is_empty()
    );
    // An ordinary body with a heading that reads "OB by Mina" is no section:
    // the body must parse as an arrangement.
    let plain = "## OB by Mina\n\nText";
    assert!(
        AttributedSections::from_published(plain, Some(&credits(&TURNS)), &registry())
            .sections()
            .is_empty()
    );
}

#[test]
fn resolution_is_deterministic() {
    let record = record();
    let a = sections(&record, ReflectionLayout::Roundtable, &TURNS);
    let b = sections(&record, ReflectionLayout::Roundtable, &TURNS);
    assert_eq!(a, b);
    let target = target_of(&a, "joe", 0);
    assert_eq!(a.resolve(&target), b.resolve(&target));
}

// ---------------------------------------------------------------------------
// Response permissions

struct World {
    record: SharedPublication,
    site: Site,
    body: String,
    credits: String,
    published: AttributedSections,
    parent_target: PerspectiveTarget,
}

fn world_for(record: &SharedPublication) -> World {
    let body = body(ReflectionLayout::SideBySide, &TURNS);
    let credits = credits(&TURNS);
    let published = AttributedSections::from_published(&body, Some(&credits), &registry());
    let parent_target = target_of(&published, "mina", 0).perspective_target();
    World {
        record: record.clone(),
        site: site(),
        body,
        credits,
        published,
        parent_target,
    }
}

fn world() -> World {
    world_for(&record())
}

fn approved(
    id: &'static str,
    kind: ParticipationKind,
    parent: Option<&'static str>,
) -> ItemFacts<'static> {
    ItemFacts {
        id,
        kind,
        work: Some(WORK),
        parent,
        state: ModerationState::Approved,
        version: 2,
        revision: 1,
        approved_revision: Some(1),
        clarification_asked: None,
        clarification_consent: true,
        content_retained: true,
        state_since: DateTime::from_unix(1_800_000_000),
    }
}

/// An answer written against explicit published content, so a test can
/// publish something else than the world's own body.
fn respond_with(
    world: &World,
    admin_user: &str,
    parent: &ItemFacts<'_>,
    parent_target: &PerspectiveTarget,
    body: &str,
    credits: Option<&str>,
    identities: &Identities<'_>,
) -> Result<AttributedResponse, ResponseError> {
    let records = [world.record.clone()];
    let works = SharedWorks::new(&records, &world.site);
    admit_response(
        &ModerationPolicy::new(Default::default()),
        &ResponseRequest {
            id: "response-1",
            record: &world.record,
            identities,
            admin_user,
            works: &works,
            work: WORK,
            mode: ParticipationMode::Open,
            parent,
            parent_mode: ParticipationMode::Open,
            parent_target,
            body,
            credits,
            registry: &registry(),
            at: DateTime::from_unix(1_800_000_100),
        },
    )
}

fn respond_to(
    world: &World,
    admin_user: &str,
    parent: &ItemFacts<'_>,
    parent_target: &PerspectiveTarget,
    identities: &Identities<'_>,
) -> Result<AttributedResponse, ResponseError> {
    respond_with(
        world,
        admin_user,
        parent,
        parent_target,
        &world.body,
        Some(&world.credits),
        identities,
    )
}

fn respond(
    world: &World,
    admin_user: &str,
    parent: &ItemFacts<'_>,
    identities: &Identities<'_>,
) -> Result<AttributedResponse, ResponseError> {
    respond_to(world, admin_user, parent, &world.parent_target, identities)
}

fn session(admin_user: &str) -> Principal<'_> {
    Principal::AdminSession { admin_user }
}

fn perspective() -> ItemFacts<'static> {
    approved("perspective-1", ParticipationKind::ThirdPerspective, None)
}

#[test]
fn the_sections_own_contributor_answers_and_the_answer_starts_pending() {
    let world = world();
    let answer = respond(&world, "mina-admin", &perspective(), &identities())
        .expect("mina wrote the section");
    assert_eq!(answer.admission.state, ModerationState::Pending);
    assert_eq!(
        answer.admission.audit.actor_id.as_deref(),
        Some("mina-admin")
    );
    assert_eq!(
        answer.admission.audit.related.as_deref(),
        Some("perspective-1")
    );
    // The private binding and the public handle are both stored.
    assert_eq!(answer.responder.participant, "p-mina");
    assert_eq!(answer.responder.contributor, "mina");
    assert_eq!(answer.responder.author, "MINA");
    assert!(answer.responder.standing.is_current());
}

#[test]
fn nobody_else_can_answer_as_that_author() {
    let world = world();
    let identities = identities();
    // Another contributor, the coordinator, the site owner, an editor, a
    // reader, an account in the registry bound to nothing and an unknown
    // account: the same refusal, whoever asks.
    for admin_user in [
        "joe-admin",
        "coord-admin",
        "owner-admin",
        "ed-admin",
        "rea-admin",
        "ghost-admin",
        "nobody",
    ] {
        assert_eq!(
            respond(&world, admin_user, &perspective(), &identities).unwrap_err(),
            ResponseError::Denied,
            "{admin_user}"
        );
    }
    // The moderation token is no Admin account at all.
    assert_eq!(
        respond(&world, MODERATION_TOKEN_ACTOR, &perspective(), &identities).unwrap_err(),
        ResponseError::Denied
    );
}

#[test]
fn a_registry_key_alone_and_a_dropped_account_are_refused() {
    let world = world();
    // The key `mina` is no longer in the registry.
    let without_key = Identities {
        active_admin_users: &USERS,
        contributor_ids: &["owner", "coord", "joe", "ed", "rea"],
    };
    assert_eq!(
        respond(&world, "mina-admin", &perspective(), &without_key).unwrap_err(),
        ResponseError::Denied
    );
    // A deactivated account.
    let inactive = Identities {
        active_admin_users: &["owner-admin", "joe-admin"],
        contributor_ids: &KEYS,
    };
    assert_eq!(
        respond(&world, "mina-admin", &perspective(), &inactive).unwrap_err(),
        ResponseError::Denied
    );
}

#[test]
fn another_publications_record_never_answers_for_this_work() {
    let world = world();
    let mut other = world.record.clone();
    other.publication_id = "other-publication".into();
    let swapped = World {
        record: other,
        ..world_for(&world.record)
    };
    assert_eq!(
        respond(&swapped, "mina-admin", &perspective(), &identities()).unwrap_err(),
        ResponseError::Denied
    );
}

#[test]
fn registry_identity_without_the_contributor_role_grants_nothing() {
    let mut world = world();
    let index = world
        .record
        .authorization
        .bindings
        .iter()
        .position(|binding| binding.participant_id == "p-mina")
        .unwrap();
    // Mina is demoted to editor: still in the registry, still bound.
    world.record.authorization.bindings[index].roles = vec![AuthorizationRole::Editor];
    assert_eq!(
        respond(&world, "mina-admin", &perspective(), &identities()).unwrap_err(),
        ResponseError::Denied
    );
    // The contributor role on that participant is the grant, whatever else
    // the binding holds.
    world.record.authorization.bindings[index].roles = vec![
        AuthorizationRole::Coordinator,
        AuthorizationRole::Contributor,
    ];
    assert!(respond(&world, "mina-admin", &perspective(), &identities()).is_ok());
}

#[test]
fn the_grant_is_the_contributors_own_participant_only() {
    let world = world();
    let identities = identities();
    let grant = |admin_user: &str, participant: &str| {
        world
            .record
            .authorize(
                admin_user,
                &identities,
                AuthorizationAction::RespondAsAuthor,
                AuthorizationTarget::Participant(participant),
            )
            .is_ok()
    };
    assert!(grant("mina-admin", "p-mina"));
    assert!(grant("joe-admin", "p-joe"));
    assert!(!grant("mina-admin", "p-joe"));
    assert!(!grant("coord-admin", "p-mina"));
    assert!(!grant("coord-admin", "p-coord"));
    assert!(!grant("owner-admin", "p-mina"));
    assert!(!grant("ed-admin", "p-ed"));
    assert!(!grant("rea-admin", "p-rea"));
    assert_eq!(
        authorize_author(&world.record, &identities, "mina-admin", "p-mina"),
        Ok(())
    );
    assert_eq!(
        authorize_author(&world.record, &identities, "mina-admin", "p-joe"),
        Err(ResponseError::Denied)
    );
}

#[test]
fn in_a_group_work_each_author_answers_only_their_own_sections() {
    let world = world();
    let identities = identities();
    let joe_target = target_of(&world.published, "joe", 0).perspective_target();
    assert!(respond_to(
        &world,
        "joe-admin",
        &perspective(),
        &joe_target,
        &identities
    )
    .is_ok());
    assert_eq!(
        respond_to(
            &world,
            "mina-admin",
            &perspective(),
            &joe_target,
            &identities
        )
        .unwrap_err(),
        ResponseError::Denied
    );
    // A perspective on the whole work is not attributed: this module grants
    // nothing and RD12's generic author response applies.
    assert_eq!(
        respond_to(
            &world,
            "joe-admin",
            &perspective(),
            &PerspectiveTarget::work(),
            &identities
        )
        .unwrap_err(),
        ResponseError::NotAttributed
    );
}

#[test]
fn a_changed_section_can_still_be_answered_but_a_gone_author_cannot() {
    let world = world();
    let identities = identities();
    let edited_turns = [("MINA", "Rewritten."), TURNS[1], TURNS[2]];
    let answer = respond_with(
        &world,
        "mina-admin",
        &perspective(),
        &world.parent_target,
        &body(ReflectionLayout::Sequential, &edited_turns),
        Some(&credits(&edited_turns)),
        &identities,
    )
    .expect("the author may answer a reader of the earlier text");
    assert!(matches!(
        answer.responder.standing,
        Standing::Stale {
            reason: StaleReason::SectionChangedOrRemoved,
            ..
        }
    ));
    // The author has no section any more: nothing is left to answer about.
    let gone_turns = [TURNS[1]];
    assert_eq!(
        respond_with(
            &world,
            "mina-admin",
            &perspective(),
            &world.parent_target,
            &body(ReflectionLayout::Sequential, &gone_turns),
            Some(&credits(&gone_turns)),
            &identities
        )
        .unwrap_err(),
        ResponseError::AuthorUnconfirmed
    );
    // Without the committed sidecar nothing can be attributed, so nothing is
    // answered either.
    assert_eq!(
        respond_with(
            &world,
            "mina-admin",
            &perspective(),
            &world.parent_target,
            &world.body,
            None,
            &identities
        )
        .unwrap_err(),
        ResponseError::AuthorUnconfirmed
    );
}

#[test]
fn a_removed_participant_leaves_nobody_who_can_answer() {
    let mut world = world();
    let identities = identities();
    world
        .record
        .authorization
        .bindings
        .retain(|binding| binding.participant_id != "p-mina");
    assert_eq!(
        respond(&world, "mina-admin", &perspective(), &identities).unwrap_err(),
        ResponseError::Denied
    );
    world
        .record
        .collaboration
        .participants
        .retain(|participant| participant.id != "p-mina");
    assert_eq!(
        respond(&world, "mina-admin", &perspective(), &identities).unwrap_err(),
        ResponseError::Denied
    );
}

#[test]
fn the_parent_must_be_a_public_third_perspective_of_this_work() {
    let world = world();
    let identities = identities();
    let mut pending = perspective();
    pending.state = ModerationState::Pending;
    pending.approved_revision = None;
    let comment = approved("c", ParticipationKind::Comment, None);
    let mut elsewhere = perspective();
    elsewhere.work = Some("/posts/other/");
    let mut purged = perspective();
    purged.content_retained = false;
    for parent in [pending, comment, elsewhere, purged] {
        assert_eq!(
            respond(&world, "mina-admin", &parent, &identities).unwrap_err(),
            ResponseError::Unavailable
        );
    }
}

#[test]
fn modes_and_the_one_policy_still_decide() {
    let world = world();
    let identities = identities();
    let records = [world.record.clone()];
    let works = SharedWorks::new(&records, &world.site);
    let parent = perspective();
    for (mode, expected) in [
        (ParticipationMode::Locked, PolicyError::Closed),
        (ParticipationMode::Hidden, PolicyError::Unavailable),
    ] {
        let error = admit_response(
            &ModerationPolicy::new(Default::default()),
            &ResponseRequest {
                id: "r",
                record: &world.record,
                identities: &identities,
                admin_user: "mina-admin",
                works: &works,
                work: WORK,
                mode,
                parent: &parent,
                parent_mode: ParticipationMode::Open,
                parent_target: &world.parent_target,
                body: &world.body,
                credits: Some(&world.credits),
                registry: &registry(),
                at: DateTime::from_unix(1_800_000_100),
            },
        )
        .unwrap_err();
        assert_eq!(error, ResponseError::Policy(expected));
    }
}

// ---------------------------------------------------------------------------
// The sealed admission and the stored responder

/// A plain author response, as RD12 alone would admit it, from `admin_user`
/// on this work, without the sealed grant.
fn plain_admit(
    world: &World,
    principal: Principal<'_>,
    parent_target: Option<&PerspectiveTarget>,
) -> Result<(), PolicyError> {
    let records = [world.record.clone()];
    let works = SharedWorks::new(&records, &world.site);
    let identities = identities();
    let actor = works.actor(principal, Some(WORK), &identities);
    let parent = perspective();
    ModerationPolicy::new(Default::default())
        .admit(&Submission {
            id: "plain",
            actor,
            kind: ParticipationKind::AuthorResponse,
            work: Some(WORK),
            mode: ParticipationMode::Open,
            parent: Some((&parent, ParticipationMode::Open)),
            parent_target,
            author_grant: None,
            clarification_consent: false,
            at: DateTime::from_unix(1_800_000_100),
        })
        .map(|_| ())
}

#[test]
fn a_coordinator_cannot_speak_as_the_author_through_the_plain_policy() {
    let world = world();
    // The coordinator, the publication's site owner and the moderation token
    // are all permitted author responses by RD12 in general...
    let work = PerspectiveTarget::work();
    for principal in [
        session("coord-admin"),
        session("owner-admin"),
        Principal::ModerationToken,
        session("mina-admin"),
    ] {
        assert!(
            plain_admit(&world, principal, Some(&work)).is_ok(),
            "{principal:?}"
        );
        // ...but not to a perspective about an attributed section, however
        // the request is made, unless it came through `admit_response`.
        assert_eq!(
            plain_admit(&world, principal, Some(&world.parent_target)),
            Err(PolicyError::Denied),
            "{principal:?}"
        );
        // Leaving the target out is no way around it.
        assert_eq!(
            plain_admit(&world, principal, None),
            Err(PolicyError::InvalidTarget),
            "{principal:?}"
        );
    }
    // A reserved anchor that is not a valid section is no ordinary heading.
    let digest = Some("0123456789abcdef0123456789abcdef".to_string());
    let broken = PerspectiveTarget::section(Some("ob-by-Mina-0".into()), digest);
    assert_eq!(
        plain_admit(&world, session("coord-admin"), Some(&broken)),
        Err(PolicyError::Denied)
    );
    // An ordinary heading keeps RD12's generic meaning.
    let heading = PerspectiveTarget::section(Some("methods".into()), None);
    assert!(plain_admit(&world, session("coord-admin"), Some(&heading)).is_ok());
}

#[test]
fn a_stored_responder_must_be_the_sections_own_contributor() {
    let parent = perspective();
    let response = approved(
        "response-1",
        ParticipationKind::AuthorResponse,
        Some("perspective-1"),
    );
    let open = ParticipationMode::Open;
    let target = target_of(
        &sections(&record(), ReflectionLayout::Sequential, &TURNS),
        "mina",
        0,
    )
    .perspective_target();
    // The bound contributor's answer is shown...
    assert!(response_shown(
        &response,
        open,
        Some("mina"),
        &parent,
        open,
        &target
    ));
    // ...another contributor's, or one with no stored responder (a coordinator
    // who got a plain author response stored), is not.
    for responder in [Some("joe"), Some("coord"), Some("MINA"), None] {
        assert!(
            !response_shown(&response, open, responder, &parent, open, &target),
            "{responder:?}"
        );
    }
    // A perspective that is not about an attributed section needs no responder.
    assert!(response_shown(
        &response,
        open,
        None,
        &parent,
        open,
        &PerspectiveTarget::work()
    ));
    // A malformed reserved anchor is never shown an answer.
    let digest = Some("0123456789abcdef0123456789abcdef".to_string());
    let broken = PerspectiveTarget::section(Some("ob-by-mina".into()), digest);
    assert!(!response_shown(
        &response,
        open,
        Some("mina"),
        &parent,
        open,
        &broken
    ));
}

#[test]
fn a_response_is_shown_only_while_it_and_its_parent_are_public() {
    let parent = perspective();
    let response = approved(
        "response-1",
        ParticipationKind::AuthorResponse,
        Some("perspective-1"),
    );
    let open = ParticipationMode::Open;
    let target = PerspectiveTarget::work();
    let shown = |response: &ItemFacts<'_>, response_mode, parent: &ItemFacts<'_>, parent_mode| {
        response_shown(response, response_mode, None, parent, parent_mode, &target)
    };
    assert!(shown(&response, open, &parent, open));
    // Taking the parent down hides the response without touching it.
    let mut removed = perspective();
    removed.state = ModerationState::Removed;
    assert!(!shown(&response, open, &removed, open));
    // A hidden kind, a pending response, another parent.
    assert!(!shown(
        &response,
        ParticipationMode::Hidden,
        &perspective(),
        open
    ));
    assert!(!shown(
        &response,
        open,
        &perspective(),
        ParticipationMode::Hidden
    ));
    let mut pending = response;
    pending.state = ModerationState::Pending;
    pending.approved_revision = None;
    assert!(!shown(&pending, open, &perspective(), open));
    let other = approved(
        "response-2",
        ParticipationKind::AuthorResponse,
        Some("perspective-9"),
    );
    assert!(!shown(&other, open, &perspective(), open));
    // Locked still shows what was approved.
    assert!(shown(
        &response,
        ParticipationMode::Locked,
        &perspective(),
        ParticipationMode::Locked
    ));
}

#[test]
fn a_coordinator_moderates_the_response_but_a_contributor_never_does() {
    let world = world();
    let identities = identities();
    let records = [world.record.clone()];
    let works = SharedWorks::new(&records, &world.site);
    let policy = ModerationPolicy::new(Default::default());
    let mut response = approved(
        "response-1",
        ParticipationKind::AuthorResponse,
        Some("perspective-1"),
    );
    response.state = ModerationState::Pending;
    response.approved_revision = None;
    response.version = 1;
    let decide = |admin_user: &str, action: ModerationAction| {
        let actor = works.actor(session(admin_user), Some(WORK), &identities);
        policy.decide(
            &response,
            &Request {
                actor,
                action,
                expected_version: 1,
                reason: None,
                at: DateTime::from_unix(1_800_000_200),
                reported_item: None,
            },
        )
    };
    assert!(decide("coord-admin", ModerationAction::Approve).is_ok());
    // The author does not approve their own answer.
    assert_eq!(
        decide("mina-admin", ModerationAction::Approve).unwrap_err(),
        PolicyError::Denied
    );
}

// ---------------------------------------------------------------------------
// The reserved anchor space

fn heading_ids(markdown: &str) -> Vec<String> {
    let html = openblog_core::markdown::render(markdown, Default::default()).html;
    html.match_indices("<h")
        .filter_map(|(at, _)| {
            let tag = &html[at..];
            let id = tag.split("id=\"").nth(1)?.split('"').next()?;
            Some(id.to_string())
        })
        .collect()
}

#[test]
fn no_heading_can_take_an_attributed_anchor() {
    // Generated slugs: "OB by Mina" would slug to `ob-by-mina`.
    let ids = heading_ids("## OB by Mina\n\ntext\n\n## OB by Mina\n\n## Methods\n");
    assert!(
        ids.iter().all(|id| !id.starts_with(ANCHOR_PREFIX)),
        "{ids:?}"
    );
    assert_eq!(ids.len(), 3);
    // Still unique and still deterministic.
    assert_ne!(ids[0], ids[1]);
    assert_eq!(ids[2], "methods");
    assert_eq!(
        ids,
        heading_ids("## OB by Mina\n\ntext\n\n## OB by Mina\n\n## Methods\n")
    );
    // An id the author writes in the reserved space is not honoured either.
    let written = heading_ids("## Notes {#ob-by-mina-0}\n\n## Other {#plain}\n");
    assert!(
        written.iter().all(|id| !id.starts_with(ANCHOR_PREFIX)),
        "{written:?}"
    );
    assert_eq!(written[1], "plain");
    // The ordinary headings are untouched.
    assert_eq!(heading_ids("## Obey the tide\n"), ["obey-the-tide"]);
}

#[test]
fn nobody_approves_their_own_answer_even_as_a_coordinator() {
    use openblog_core::attributed_perspective::may_decide_response;
    // A coordinator who is also a contributor writes an answer...
    let mut world = world();
    for binding in &mut world.record.authorization.bindings {
        if binding.participant_id == "p-mina" {
            binding.roles = vec![
                AuthorizationRole::Coordinator,
                AuthorizationRole::Contributor,
            ];
        }
    }
    assert!(respond(&world, "mina-admin", &perspective(), &identities()).is_ok());
    // ...but cannot approve it, while another coordinator can.
    assert_eq!(
        may_decide_response(Some("mina-admin"), "mina-admin", ModerationAction::Approve),
        Err(PolicyError::Denied)
    );
    assert_eq!(
        may_decide_response(Some("mina-admin"), "coord-admin", ModerationAction::Approve),
        Ok(())
    );
    // Taking one's own words down is always allowed.
    for action in [ModerationAction::Remove, ModerationAction::Reject] {
        assert_eq!(
            may_decide_response(Some("mina-admin"), "mina-admin", action),
            Ok(())
        );
    }
}

// ---------------------------------------------------------------------------
// Credits that drift fail closed (ADR 0136)

/// The same body composed without binding each turn to its contributor, as
/// every body assembled before ADR 0136 was.
fn unbound_body(turns: &[(&str, &str)]) -> String {
    let composed: Vec<ComposedTurn<'_>> = turns
        .iter()
        .enumerate()
        .map(|(round, (name, text))| ComposedTurn {
            round,
            round_prompt: None,
            display_name: name,
            label: None,
            placement: Placement { lane: 0, lanes: 1 },
            body: (*text).to_string(),
        })
        .collect();
    compose(ReflectionLayout::Sequential, &composed)
}

/// Credits reordered in the post editor (a byline change), body unchanged.
fn reversed_credits() -> String {
    "{\"version\":1,\"credits\":[{\"contributor\":\"joe\",\"roles\":[{\"vocabulary\":\"crossref\",\"role\":\"author\"}]},{\"contributor\":\"mina\",\"roles\":[{\"vocabulary\":\"crossref\",\"role\":\"author\"}]}]}".into()
}

#[test]
fn credits_reordered_after_publication_attribute_nothing_and_answer_nobody() {
    // MINA, JOE, MINA with the credits swapped: the section MINA wrote would
    // have been attributed to joe, and joe could have answered as MINA.
    let reversed = reversed_credits();
    for body in [
        body(ReflectionLayout::SideBySide, &TURNS),
        unbound_body(&TURNS),
    ] {
        let published = AttributedSections::from_published(&body, Some(&reversed), &registry());
        assert!(published.sections().is_empty());
        assert_eq!(published.unattributed(), 3);
        let honest = AttributedSections::from_published(&body, Some(&credits(&TURNS)), &registry());
        assert_eq!(honest.sections().len(), 3);
        // A target read before the reorder is never answerable after it.
        let target = honest.sections()[0].target().perspective_target();
        let world = world();
        for admin_user in ["joe-admin", "mina-admin"] {
            let refused = respond_with(
                &world,
                admin_user,
                &perspective(),
                &target,
                &body,
                Some(&reversed),
                &identities(),
            );
            assert!(
                matches!(
                    refused,
                    Err(ResponseError::Denied | ResponseError::AuthorUnconfirmed)
                ),
                "{admin_user}"
            );
        }
    }
}

#[test]
fn a_registry_name_that_is_not_the_body_name_attributes_nothing_in_an_unbound_body() {
    // The credit says `mina` but the registry has since named that key
    // something else: the old body cannot be trusted to mean the same person.
    let mut renamed = registry();
    renamed.get_mut("mina").unwrap().name = "Someone Else".into();
    let published =
        AttributedSections::from_published(&unbound_body(&TURNS), Some(&credits(&TURNS)), &renamed);
    assert!(published.sections().is_empty());
    // A registry that lacks a credited key attributes nothing either.
    let mut lacking = registry();
    lacking.remove("joe");
    assert!(AttributedSections::from_published(
        &unbound_body(&TURNS),
        Some(&credits(&TURNS)),
        &lacking
    )
    .sections()
    .is_empty());
    // And an unchanged registry still pairs an unbound body by name.
    assert_eq!(
        AttributedSections::from_published(
            &unbound_body(&TURNS),
            Some(&credits(&TURNS)),
            &registry()
        )
        .sections()
        .len(),
        3
    );
}

#[test]
fn a_bound_body_is_paired_by_what_it_states_not_by_a_name() {
    // A participant's display name need not be the registry name: the body
    // states the contributor itself.
    let mut pen_names = registry();
    pen_names.get_mut("mina").unwrap().name = "Mina Quill".into();
    let published = AttributedSections::from_published(
        &body(ReflectionLayout::Sequential, &TURNS),
        Some(&credits(&TURNS)),
        &pen_names,
    );
    assert_eq!(published.sections().len(), 3);
    assert_eq!(published.sections()[0].contribution, "mina");
    // Some turns bound and others not: not trusted.
    let mut mixed = body(ReflectionLayout::Sequential, &TURNS);
    mixed = mixed.replacen(" ob-turn-by-joe", "", 1);
    assert!(
        AttributedSections::from_published(&mixed, Some(&credits(&TURNS)), &registry())
            .sections()
            .is_empty()
    );
    // One name stated under two keys: not trusted.
    let mut two_keys = body(ReflectionLayout::Sequential, &TURNS);
    let last = two_keys.rfind("ob-turn-by-mina").unwrap();
    two_keys.replace_range(last + 11..last + 15, "joe");
    assert!(
        AttributedSections::from_published(&two_keys, Some(&credits(&TURNS)), &registry())
            .sections()
            .is_empty()
    );
    let swapped_keys = body(ReflectionLayout::Sequential, &TURNS)
        .replace("ob-turn-by-mina", "ob-turn-by-x")
        .replace("ob-turn-by-joe", "ob-turn-by-mina")
        .replace("ob-turn-by-x", "ob-turn-by-joe");
    assert!(
        AttributedSections::from_published(&swapped_keys, Some(&credits(&TURNS)), &registry())
            .sections()
            .is_empty(),
        "keys stated in the body must be the credits' first-appearance order"
    );
}

#[test]
fn a_contributor_key_of_a_hundred_bytes_is_bound_and_attributed() {
    // Contributor ids allow up to 128 bytes, so a long registry key binds.
    let long = "a".repeat(100);
    let composed: Vec<ComposedTurn<'_>> = [("ADA", "One."), ("GRACE", "Two.")]
        .iter()
        .enumerate()
        .map(|(round, (name, text))| ComposedTurn {
            round,
            round_prompt: None,
            display_name: name,
            label: None,
            placement: Placement { lane: 0, lanes: 1 },
            body: (*text).to_string(),
        })
        .collect();
    let bound = compose_bound(
        ReflectionLayout::Sequential,
        &composed,
        &[Some(long.as_str()), Some("grace")],
    );
    assert!(bound.contains(&format!("ob-turn-by-{long}")));
    let mut people = registry();
    people.insert(
        long.clone(),
        Contributor {
            name: "ADA".into(),
            ..Contributor::default()
        },
    );
    people.insert(
        "grace".into(),
        Contributor {
            name: "GRACE".into(),
            ..Contributor::default()
        },
    );
    let sidecar = format!(
        "{{\"version\":1,\"credits\":[        {{\"contributor\":\"{long}\",\"roles\":[{{\"vocabulary\":\"crossref\",\"role\":\"author\"}}]}},        {{\"contributor\":\"grace\",\"roles\":[{{\"vocabulary\":\"crossref\",\"role\":\"author\"}}]}}]}}"
    );
    let published = AttributedSections::from_published(&bound, Some(&sidecar), &people);
    assert_eq!(published.sections().len(), 2);
    assert_eq!(published.sections()[0].contribution, long);
    // A key past the credit rule's limit is still never trusted.
    let too_long = "a".repeat(129);
    let unbound = compose_bound(
        ReflectionLayout::Sequential,
        &composed,
        &[Some(too_long.as_str()), Some("grace")],
    );
    assert!(!unbound.contains("ob-turn-by-aaa"));
}
