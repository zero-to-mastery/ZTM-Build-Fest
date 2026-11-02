//! Featuring an approved reflection (#214, ADRs 0176 to 0181): a separate,
//! revision-bound consent; withdrawal that takes the feature off with no
//! public tombstone; honest provenance; and nothing that counts, ranks or
//! claims consensus.

use openblog_core::community_feature::{
    body_digest, feature_anchor, normalize_context, project_post, resolve_post, FeatureError,
    FeatureOff, FeatureRecord, FeatureRequest, FeaturedPerspective, FeaturesFile, HiddenReason,
    HostedStanding, NotShown, COMMUNITY_FEATURES_FILE, MAX_CONTEXT_CHARS, NON_CONSENSUS_NOTICE,
};
use openblog_core::participation::ParticipationMode;
use openblog_core::passage_target::PassageDocument;
use openblog_core::perspective_publication::{
    NameStanding, PublishedPerspective, ThirdPerspectivesFile,
};
use openblog_core::third_perspective::{
    ConsentChange, ConsentChoices, ConsentOutcome, FeatureChange, HostedPerspective, Intake,
    LocalReflection, ModerationFacts, ModerationState, PerspectiveTarget, ReaderAttribution,
    ResponseCategory, SubmittedCopy,
};
use openblog_core::{DateTime, LoadOptions, Site, SiteConfig, SourceFile, Sources};
use serde_json::{json, Value};

const ID_1: &str = "00000000-0000-4000-8000-000000000001";
const ID_2: &str = "00000000-0000-4000-8000-000000000002";
const SOURCE: &str = "posts/tides.md";
const BODY: &str =
    "The moon causes the tides.\n\n## Methods\n\nWe measured the tides twice a day.\n";
const REFLECTION: &str = "Tides as a <conversation> & a rhythm.\n\nA second paragraph.";
const DIGEST: &str = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
const OPEN: ParticipationMode = ParticipationMode::Open;
const HIDDEN: ParticipationMode = ParticipationMode::Hidden;

fn time(value: &str) -> DateTime {
    DateTime::parse(value).unwrap()
}

fn site() -> Site {
    let config = SiteConfig::from_json(
        r#"{"title":"T","url":"https://t.dev","postPath":"/posts/{slug}/","author":{"name":"Ada Lovelace"},"engagement":{"enabled":true,"endpoint":"https://t.dev/api","receipts":true},"participation":{"kinds":{"third-perspective":"open"}}}"#,
    )
    .unwrap();
    Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: SOURCE.into(),
                contents: format!("---\ntitle: Tides\ndate: 2026-01-01\n---\n{BODY}"),
            }],
            ..Sources::default()
        },
        LoadOptions::default(),
    )
    .unwrap()
}

fn copy(site: &Site, name: &str, publish_name: bool, feature: bool) -> SubmittedCopy {
    let post = &site.posts[0];
    let document = PassageDocument::of_post(post, &site.config);
    LocalReflection {
        work: post.url.clone(),
        revision: document.revision.clone(),
        target: PerspectiveTarget::try_from(document.section_target(1).unwrap()).unwrap(),
        category: Some(ResponseCategory::Connection),
        body: REFLECTION.into(),
        attribution: ReaderAttribution::named(name, publish_name),
        seen_at: None,
    }
    .submission(ConsentChoices {
        publish: true,
        clarification: true,
        feature,
    })
    .receive(
        time("2026-10-26T10:00:00Z"),
        Intake::Hosted {
            receipt_digest: DIGEST.into(),
        },
    )
    .unwrap()
}

fn hosted_row(
    copy: &SubmittedCopy,
    status: &str,
    approved_consent: Option<u32>,
) -> HostedPerspective {
    let record: Value = serde_json::from_str(&copy.to_json()).unwrap();
    HostedPerspective::from_value(&json!({
        "id": ID_1, "status": status, "version": 2,
        "moderatedAt": "2026-10-27T09:00:00Z", "reason": null,
        "feedback": {"version": 1, "kind": "third-perspective", "body": copy.body, "details": copy.stored_details(), "provenance": record["provenance"]},
        "itemRevision": copy.revision, "approvedRevision": if status == "approved" { json!(copy.revision) } else { Value::Null },
        "clarificationAsked": null, "clarificationConsent": true, "approvedConsent": approved_consent,
    }))
    .unwrap()
}

fn facts(state: ModerationState, revision: u32, retained: bool) -> ModerationFacts {
    ModerationFacts {
        state,
        revision,
        approved_revision: (state == ModerationState::Approved).then_some(revision),
        approved_consent: (state == ModerationState::Approved).then_some(1),
        clarification_asked: None,
        content_retained: retained,
    }
}

fn approved(copy: &SubmittedCopy) -> (HostedPerspective, ModerationFacts) {
    (
        hosted_row(copy, "approved", Some(1)),
        facts(ModerationState::Approved, copy.revision, true),
    )
}

fn request(note: &str) -> FeatureRequest {
    FeatureRequest {
        selected_by: "mikey".into(),
        context: note.into(),
        at: time("2026-10-28T12:00:00Z"),
    }
}

fn publish(site: &Site, hosted: &HostedPerspective) -> PublishedPerspective {
    PublishedPerspective::from_hosted(
        SOURCE,
        hosted,
        &site.posts[0],
        &site.config,
        time("2026-10-27T09:00:00Z"),
    )
    .unwrap()
}

fn narrow(
    copy: &mut SubmittedCopy,
    facts: &ModerationFacts,
    show: bool,
    feature: FeatureChange,
    day: &str,
) {
    copy.revise_consent(
        facts,
        ConsentChange {
            publish: true,
            attribution: ReaderAttribution::named("Mina", show),
            clarification: true,
            feature,
        },
        time(day),
    )
    .unwrap();
}

fn try_feature(
    site: &Site,
    hosted: &HostedPerspective,
    facts: &ModerationFacts,
    item: &PublishedPerspective,
    note: &str,
) -> Result<FeatureRecord, FeatureError> {
    FeatureRecord::new(
        SOURCE,
        hosted,
        facts,
        item,
        &site.posts[0],
        &site.config,
        &request(note),
    )
}

/// A featured, published, approved reflection: the site, the hosted row, its
/// facts, the published file and the feature.
struct World {
    site: Site,
    hosted: HostedPerspective,
    facts: ModerationFacts,
    published: ThirdPerspectivesFile,
    record: FeatureRecord,
}

fn world(name: &str, publish_name: bool) -> World {
    let site = site();
    let copy = copy(&site, name, publish_name, true);
    let (hosted, facts) = approved(&copy);
    let item = publish(&site, &hosted);
    let record = try_feature(
        &site,
        &hosted,
        &facts,
        &item,
        "Connects the tides to a shared rhythm.",
    )
    .unwrap();
    World {
        site,
        hosted,
        facts,
        published: ThirdPerspectivesFile { items: vec![item] },
        record,
    }
}

impl World {
    fn standing_of(
        &self,
        hosted: Option<(&HostedPerspective, &ModerationFacts)>,
    ) -> HostedStanding {
        self.record.hosted_standing(
            hosted.map(|(hosted, facts)| (Some(hosted), facts)),
            Some(&self.site.posts[0]),
            &self.site.config,
            OPEN,
        )
    }

    fn standing(&self) -> HostedStanding {
        self.standing_of(Some((&self.hosted, &self.facts)))
    }

    fn page_with(
        &self,
        published: &ThirdPerspectivesFile,
    ) -> Result<FeaturedPerspective, NotShown> {
        resolve_post(
            &[&self.record],
            published,
            Some(&self.site.posts[0]),
            &self.site.config,
            OPEN,
            HIDDEN,
        )
        .remove(0)
        .1
    }

    fn page(&self) -> Result<FeaturedPerspective, NotShown> {
        self.page_with(&self.published)
    }

    fn copy(&self) -> SubmittedCopy {
        self.hosted.copy.clone()
    }
}

// ---- Consent

#[test]
fn approval_alone_features_nothing_and_consent_is_separate_and_explicit() {
    let site = site();
    let without = copy(&site, "Mina", true, false);
    let (hosted, facts) = approved(&without);
    let item = publish(&site, &hosted);
    assert_eq!(
        try_feature(&site, &hosted, &facts, &item, "").unwrap_err(),
        FeatureError::ConsentMissing
    );

    // The reader agrees later, by their own change, for the approved text.
    let mut later = without.clone();
    narrow(
        &mut later,
        &facts,
        true,
        FeatureChange::Agree { revision_seen: 1 },
        "2026-10-28T08:00:00Z",
    );
    assert_eq!(later.consent().feature_revision, Some(1));
    let hosted = hosted_row(&later, "approved", Some(1));
    let record = try_feature(&site, &hosted, &facts, &item, "").unwrap();
    assert_eq!(record.revision, 1);
    assert_eq!(record.context, None, "a note is optional");

    // Only a site Admin user chooses; a pending copy is never featured.
    let mut stranger = request("");
    stranger.selected_by = "not an admin!".into();
    assert_eq!(
        FeatureRecord::new(
            SOURCE,
            &hosted,
            &facts,
            &item,
            &site.posts[0],
            &site.config,
            &stranger
        )
        .unwrap_err(),
        FeatureError::InvalidEditor
    );
    let consenting = copy(&site, "Mina", true, true);
    let pending = hosted_row(&consenting, "pending", None);
    assert_eq!(
        try_feature(
            &site,
            &pending,
            &facts_of(ModerationState::Pending),
            &item,
            ""
        )
        .unwrap_err(),
        FeatureError::NotShownNow
    );
}

fn facts_of(state: ModerationState) -> ModerationFacts {
    facts(state, 1, true)
}

#[test]
fn a_material_edit_needs_renewed_consent_for_the_new_revision() {
    let w = world("Mina", true);
    assert_eq!(w.standing(), HostedStanding::Covered);

    // A clarification replaces the text as revision 2: the old consent
    // covers the old words only.
    let mut edited = w.copy();
    let asking = facts(ModerationState::Clarification, 1, true);
    edited
        .clarify(
            &asking,
            "A rewritten reflection.",
            time("2026-10-29T08:00:00Z"),
        )
        .unwrap();
    assert_eq!(edited.revision, 2);
    let reapproved = hosted_row(&edited, "approved", Some(1));
    let new_facts = facts(ModerationState::Approved, 2, true);
    assert_eq!(
        w.standing_of(Some((&reapproved, &new_facts))),
        HostedStanding::MustComeOff(FeatureOff::TextChanged)
    );
    let item = publish(&w.site, &reapproved);
    assert_eq!(
        try_feature(&w.site, &reapproved, &new_facts, &item, "").unwrap_err(),
        FeatureError::ConsentForOtherRevision
    );

    // The reader renews, for the text as it now stands; featuring is then
    // possible again, as a new record that binds the new text.
    let mut renewed = edited.clone();
    narrow(
        &mut renewed,
        &new_facts,
        true,
        FeatureChange::Agree { revision_seen: 2 },
        "2026-10-30T08:00:00Z",
    );
    let hosted = hosted_row(&renewed, "approved", Some(1));
    let again = try_feature(&w.site, &hosted, &new_facts, &item, "").unwrap();
    assert_eq!(again.revision, 2);
    assert_ne!(again.digest, w.record.digest);
}

#[test]
fn changing_what_the_reader_may_be_asked_never_renews_feature_consent_for_edited_text() {
    // The reader agrees to feature revision 1, answers a clarification (text
    // revision 2), then only toggles whether they may be asked to clarify.
    // Nothing they did agreed to feature the new words.
    let w = world("Mina", true);
    let mut edited = w.copy();
    edited
        .clarify(
            &facts(ModerationState::Clarification, 1, true),
            "A rewritten reflection.",
            time("2026-10-29T08:00:00Z"),
        )
        .unwrap();
    edited
        .revise_consent(
            &facts(ModerationState::Pending, 2, true),
            ConsentChange {
                publish: true,
                attribution: edited.consent().attribution.clone(),
                clarification: !edited.consent().clarification,
                feature: FeatureChange::Keep,
            },
            time("2026-10-29T09:00:00Z"),
        )
        .unwrap();
    assert_eq!(edited.consent().feature_revision, Some(1));

    // Approved at revision 2: feature consent still names revision 1.
    let hosted = hosted_row(&edited, "approved", Some(2));
    let approved = facts(ModerationState::Approved, 2, true);
    let item = publish(&w.site, &hosted);
    assert_eq!(
        try_feature(&w.site, &hosted, &approved, &item, "").unwrap_err(),
        FeatureError::ConsentForOtherRevision
    );

    // Even after approval, a toggle keeps it where it was; only an explicit
    // agreement for the revision the reader saw binds revision 2, and one for
    // a revision they did not see is refused.
    let toggle = |feature| ConsentChange {
        publish: true,
        attribution: edited.consent().attribution.clone(),
        clarification: edited.consent().clarification,
        feature,
    };
    let mut after = edited.clone();
    assert!(after
        .revise_consent(
            &approved,
            ConsentChange {
                clarification: !edited.consent().clarification,
                ..toggle(FeatureChange::Keep)
            },
            time("2026-10-30T08:00:00Z")
        )
        .is_ok());
    assert_eq!(after.consent().feature_revision, Some(1));
    assert_eq!(
        after.revise_consent(
            &approved,
            toggle(FeatureChange::Agree { revision_seen: 1 }),
            time("2026-10-30T09:00:00Z")
        ),
        Err(openblog_core::third_perspective::LifecycleError::StaleRevision)
    );
    after
        .revise_consent(
            &approved,
            toggle(FeatureChange::Agree { revision_seen: 2 }),
            time("2026-10-30T10:00:00Z"),
        )
        .unwrap();
    assert_eq!(after.consent().feature_revision, Some(2));
}

#[test]
fn a_feature_dated_before_the_reflection_was_approved_is_never_shown() {
    let mut w = world("Mina", true);
    assert!(w.page().is_ok());
    // A clock that ran behind cannot date a feature before its approval: the
    // day is raised to the approval's.
    let item = &w.published.items[0];
    let mut early = request("");
    early.at = time("2026-01-01T00:00:00Z");
    let record = FeatureRecord::new(
        SOURCE,
        &w.hosted,
        &w.facts,
        item,
        &w.site.posts[0],
        &w.site.config,
        &early,
    )
    .unwrap();
    assert_eq!(record.featured, item.approved);
    // A hand-edited earlier day is refused by the page.
    w.record.featured = "2026-10-01".into();
    assert!(w.record.featured < w.published.items[0].approved);
    assert_eq!(w.page().unwrap_err(), NotShown::Off(FeatureOff::Misdated));
    w.record.featured = w.published.items[0].approved.clone();
    assert!(w.page().is_ok(), "the same day is honest");
}

#[test]
fn the_published_text_that_differs_from_what_was_agreed_is_never_featured() {
    let mut w = world("Mina", true);
    assert!(w.page().is_ok());
    // An editor hand-edits the published words.
    w.published.items[0].body = "Edited by an editor.".into();
    assert_eq!(
        w.page().unwrap_err(),
        NotShown::Off(FeatureOff::TextChanged)
    );
    assert!(project_post(
        &[&w.record],
        &w.published,
        &w.site.posts[0],
        &w.site.config,
        OPEN,
        HIDDEN
    )
    .is_empty());
    // And a feature cannot be made over a published text that is not the copy.
    let site = site();
    let copy = copy(&site, "Mina", true, true);
    let (hosted, facts) = approved(&copy);
    let mut item = publish(&site, &hosted);
    item.body = "Different".into();
    assert_eq!(
        try_feature(&site, &hosted, &facts, &item, "").unwrap_err(),
        FeatureError::PublishedDiffers
    );
}

// ---- Withdrawal, revoked consent, retention, deleted source

#[test]
fn withdrawal_deletion_and_a_declined_feature_each_take_it_off_with_no_tombstone() {
    let w = world("Mina", true);
    let gone = HostedStanding::MustComeOff;

    // The reader withdrew: the hosted copy is withdrawn and its text purged.
    let mut withdrawn = w.copy();
    let outcome = withdrawn
        .revise_consent(
            &w.facts,
            ConsentChange {
                publish: false,
                attribution: ReaderAttribution::named("Mina", false),
                clarification: false,
                feature: FeatureChange::Decline,
            },
            time("2026-10-31T08:00:00Z"),
        )
        .unwrap();
    assert_eq!(outcome, ConsentOutcome::Withdraw);
    let row = hosted_row(&withdrawn, "withdrawn", None);
    let purged = facts(ModerationState::Withdrawn, 1, false);
    assert_eq!(
        w.standing_of(Some((&row, &purged))),
        gone(FeatureOff::Withdrawn)
    );
    // A withdrawn row whose text was purged is still told apart from a gone
    // row: the reason is "withdrawn", not "deleted".
    assert_eq!(
        w.record.hosted_standing(
            Some((None, &purged)),
            Some(&w.site.posts[0]),
            &w.site.config,
            OPEN
        ),
        gone(FeatureOff::Withdrawn)
    );
    // Even before the purge, a withdrawn row is off.
    let kept = facts(ModerationState::Withdrawn, 1, true);
    assert_eq!(
        w.standing_of(Some((&row, &kept))),
        gone(FeatureOff::Withdrawn)
    );

    // Expired retention: the text is purged, or the row is gone.
    let expired = facts(ModerationState::Approved, 1, false);
    assert_eq!(
        w.standing_of(Some((&w.hosted, &expired))),
        gone(FeatureOff::Deleted)
    );
    assert_eq!(w.standing_of(None), gone(FeatureOff::Deleted));
    // The order of the checks is the ADR's table: purged beats not approved,
    // and what the reader or editors decided beats a lost article.
    let purged_pending = facts(ModerationState::Pending, 1, false);
    assert_eq!(
        w.standing_of(Some((&w.hosted, &purged_pending))),
        gone(FeatureOff::Deleted)
    );
    assert_eq!(
        w.record.hosted_standing(None, None, &w.site.config, OPEN),
        gone(FeatureOff::Deleted)
    );
    // With the article gone too, the reflection's own state is still the
    // reason: withdrawn, purged and declined are never "hidden".
    let no_post = |hosted: Option<(Option<&HostedPerspective>, &ModerationFacts)>| {
        w.record.hosted_standing(hosted, None, &w.site.config, OPEN)
    };
    assert_eq!(no_post(Some((None, &purged))), gone(FeatureOff::Withdrawn));
    assert_eq!(
        no_post(Some((Some(&w.hosted), &expired))),
        gone(FeatureOff::Deleted)
    );
    assert_eq!(
        no_post(Some((
            Some(&w.hosted),
            &facts(ModerationState::Removed, 1, true)
        ))),
        gone(FeatureOff::NotApproved)
    );

    // Not approved any more (removed by moderation).
    let removed = facts(ModerationState::Removed, 1, true);
    assert_eq!(
        w.standing_of(Some((&w.hosted, &removed))),
        gone(FeatureOff::NotApproved)
    );

    // The reader declines featuring but stays published: the reflection is
    // still shown, its feature is not.
    let mut declined = w.copy();
    narrow(
        &mut declined,
        &w.facts,
        true,
        FeatureChange::Decline,
        "2026-10-31T09:00:00Z",
    );
    let row = hosted_row(&declined, "approved", Some(1));
    assert_eq!(
        w.standing_of(Some((&row, &w.facts))),
        gone(FeatureOff::ConsentDeclined)
    );
    assert!(PublishedPerspective::shown_now(
        &row,
        Some(&w.site.posts[0]),
        &w.site.config
    ));
    assert_eq!(
        w.record
            .hosted_standing(Some((Some(&row), &w.facts)), None, &w.site.config, OPEN),
        gone(FeatureOff::ConsentDeclined)
    );

    // Taking a reflection off takes its feature off in the same step, and the
    // file keeps nothing: no id, no day, no note.
    let mut features = FeaturesFile::default();
    features.feature(w.record.clone()).unwrap();
    let mut published = w.published.clone();
    assert_eq!(
        features.unpublish_reflection(&mut published, ID_1),
        (true, true)
    );
    assert!(published.items.is_empty() && features.items.is_empty());
    let text = features.to_json();
    for kept in [ID_1, "2026-10", "rhythm", "Mina"] {
        assert!(!text.contains(kept), "{kept} survived: {text}");
    }
    assert_eq!(
        features.unpublish_reflection(&mut published, ID_1),
        (false, false)
    );

    // On the page a feature whose reflection is no longer published is simply
    // absent, with no mark of a gap.
    let shown = project_post(
        &[&w.record],
        &ThirdPerspectivesFile::default(),
        &w.site.posts[0],
        &w.site.config,
        OPEN,
        HIDDEN,
    );
    assert!(shown.is_empty());
}

#[test]
fn a_deleted_source_article_is_never_shown_and_is_not_dropped() {
    let w = world("Mina", true);
    assert_eq!(
        w.record.hosted_standing(
            Some((Some(&w.hosted), &w.facts)),
            None,
            &w.site.config,
            OPEN
        ),
        HostedStanding::Hidden(HiddenReason::SourceGone)
    );
    let resolved = resolve_post(
        &[&w.record],
        &w.published,
        None,
        &w.site.config,
        OPEN,
        HIDDEN,
    );
    assert_eq!(
        resolved[0].1.as_ref().unwrap_err(),
        &NotShown::Hidden(HiddenReason::SourceGone)
    );
    // The file still holds it, so restoring the article restores the page.
    assert!(w.page().is_ok());
    assert_eq!(w.standing(), HostedStanding::Covered);
    let mut features = FeaturesFile::default();
    features.feature(w.record.clone()).unwrap();
    assert_eq!(
        FeaturesFile::from_json(&features.to_json()).unwrap(),
        features
    );
}

// ---- Identity

#[test]
fn a_hidden_name_leaves_the_committed_file_by_republishing_and_a_feature_keeps_no_name() {
    let w = world("Mina", true);
    let shown = w.page().unwrap();
    assert_eq!(shown.response.name.as_deref(), Some("Mina"));
    assert!(shown.provenance.contains("Mina, a reader"));
    let post = Some(&w.site.posts[0]);

    // The reader hides their name after approval, by their own change.
    let mut hidden = w.copy();
    narrow(
        &mut hidden,
        &w.facts,
        false,
        FeatureChange::Keep,
        "2026-10-31T08:00:00Z",
    );
    let row = hosted_row(&hidden, "approved", Some(1));
    // The feature stands (it was agreed for the text, not the name)...
    assert_eq!(
        w.standing_of(Some((&row, &w.facts))),
        HostedStanding::Covered
    );
    // ...but the committed file still holds the name until it is published
    // again, and Admin is told so on every load.
    assert_eq!(
        w.published.items[0].name_standing(&row, post, &w.site.config),
        NameStanding::Narrowed
    );
    assert_eq!(
        w.published.items[0].name_standing(&w.hosted, post, &w.site.config),
        NameStanding::Current
    );
    // Nothing new is featured against the stale file.
    assert_eq!(
        try_feature(&w.site, &row, &w.facts, &w.published.items[0], "").unwrap_err(),
        FeatureError::PublishedDiffers
    );

    // Republishing from the hosted copy, the one step Admin takes, drops the
    // name from the file; the feature then shows anonymously.
    let mut published = w.published.clone();
    published.publish(publish(&w.site, &row)).unwrap();
    assert_eq!(published.items[0].name, None);
    assert!(!published.to_json().contains("Mina"));
    assert_eq!(
        published.items[0].name_standing(&row, post, &w.site.config),
        NameStanding::Current
    );
    let anonymous = w.page_with(&published).unwrap();
    assert_eq!(anonymous.response.name, None);
    assert!(anonymous.provenance.contains("from a reader,"));
    // The feature file never held the name at all.
    assert!(!FeaturesFile {
        items: vec![w.record.clone()]
    }
    .to_json()
    .contains("Mina"));

    // Nothing widens after approval, and a private name is never published.
    let mut widen = w.copy();
    let error = widen
        .revise_consent(
            &w.facts,
            ConsentChange {
                publish: true,
                attribution: ReaderAttribution::named("Someone Else", true),
                clarification: true,
                feature: FeatureChange::Keep,
            },
            time("2026-10-31T08:00:00Z"),
        )
        .unwrap_err();
    assert_eq!(error.code(), "wideningAfterDecision");
    let private = world("Hidden Reader", false);
    assert_eq!(private.published.items[0].name, None);
}

// ---- Placement

#[test]
fn a_reflection_has_one_placement_on_the_page_it_is_about() {
    let w = world("Mina", true);
    let mut features = FeaturesFile::default();
    features.feature(w.record.clone()).unwrap();
    assert_eq!(
        features.feature(w.record.clone()).unwrap_err(),
        FeatureError::AlreadyFeatured
    );
    let mut moved = w.record.clone();
    moved.post = "posts/other.md".into();
    assert_eq!(
        features.feature(moved.clone()).unwrap_err(),
        FeatureError::AlreadyFeatured
    );

    // A file that places one reflection twice is refused whole.
    let mut value: Value = serde_json::from_str(&features.to_json()).unwrap();
    let item = value["items"][0].clone();
    value["items"].as_array_mut().unwrap().push(item);
    assert!(FeaturesFile::from_json(&value.to_string())
        .unwrap_err()
        .contains("one placement"));

    // A feature naming another post than the reflection's is not shown.
    let resolved = resolve_post(
        &[&moved],
        &w.published,
        Some(&w.site.posts[0]),
        &w.site.config,
        OPEN,
        HIDDEN,
    );
    assert_eq!(
        resolved[0].1.as_ref().unwrap_err(),
        &NotShown::Off(FeatureOff::NotApproved)
    );

    // A kind the work hides shows no feature.
    let hidden = resolve_post(
        &[&w.record],
        &w.published,
        Some(&w.site.posts[0]),
        &w.site.config,
        HIDDEN,
        HIDDEN,
    );
    assert_eq!(
        hidden[0].1.as_ref().unwrap_err(),
        &NotShown::Off(FeatureOff::NotApproved)
    );
}

// ---- Provenance and non-consensus

#[test]
fn the_page_form_is_honest_provenance_with_no_count_rank_or_editor() {
    let w = world("Mina", true);
    let shown = w.page().unwrap();
    assert_eq!(shown.response.role, "reader");
    assert_eq!(shown.featured, "2026-10-28");
    assert_eq!(
        shown.context.as_deref(),
        Some("Connects the tides to a shared rhythm.")
    );
    assert!(shown.provenance.contains("received 2026-10-26"));
    assert!(shown.provenance.contains("approved by the editors"));
    assert!(shown.provenance.contains("separate permission"));
    assert!(NON_CONSENSUS_NOTICE.contains("not a vote"));
    assert!(NON_CONSENSUS_NOTICE.starts_with("The editors chose these reflections"));
    assert_eq!(feature_anchor(ID_1), format!("ob-feature-{ID_1}"));
    assert_ne!(feature_anchor(ID_1), format!("ob-perspective-{ID_1}"));
    assert!(NON_CONSENSUS_NOTICE.contains("does not mean"));
    let json = shown.to_json().to_lowercase();
    for forbidden in [
        "count",
        "rank",
        "score",
        "vote",
        "like",
        "popular",
        "weight",
        "position",
        "selectedby",
        "mikey",
        "moderator",
        "consent",
        "digest",
        "receipt",
        "intake",
    ] {
        assert!(!json.contains(forbidden), "{forbidden} in {json}");
    }

    // Features are listed by the day they were featured, never by anything
    // else.
    let mut earlier = w.record.clone();
    earlier.id = ID_2.into();
    earlier.featured = "2026-10-27".into();
    let mut features = FeaturesFile::default();
    features.feature(w.record.clone()).unwrap();
    features.feature(earlier).unwrap();
    let order: Vec<&str> = features
        .for_post(SOURCE)
        .iter()
        .map(|record| record.id.as_str())
        .collect();
    assert_eq!(order, [ID_2, ID_1]);
}

#[test]
fn an_editors_note_may_not_claim_popularity_a_count_or_agreement() {
    assert_eq!(normalize_context("   ").unwrap(), None);
    assert_eq!(
        normalize_context("  A careful   reading of method.  ")
            .unwrap()
            .as_deref(),
        Some("A careful reading of method.")
    );
    for bad in [
        "The most popular reflection this week",
        "Most agreed with by readers",
        "A top-rated take",
        "Upvoted by many",
        "Community consensus is clear",
        "12 readers found this useful",
        "Everyone agrees",
        "Trending",
        "A popular reading",
        "A reader favourite",
        "A favorite of the group",
        "Widely shared since March",
        "The most-agreed reflection",
        "Most agreed-with, by far",
        "Liked by 12 readers",
        "Readers: 12",
        "Three people disagreed",
        "90% of readers nodded",
        "12 more people wrote",
        "Voted up",
    ] {
        assert_eq!(
            normalize_context(bad).unwrap_err(),
            FeatureError::PopularityClaim,
            "{bad}"
        );
    }
    assert_eq!(
        normalize_context(&"x".repeat(MAX_CONTEXT_CHARS + 1)).unwrap_err(),
        FeatureError::InvalidContext
    );
    assert_eq!(
        normalize_context("bad \u{202e} bidi").unwrap_err(),
        FeatureError::InvalidContext
    );
    assert_eq!(
        normalize_context("a\u{0}b").unwrap_err(),
        FeatureError::InvalidContext
    );
    assert!(normalize_context(&"x".repeat(MAX_CONTEXT_CHARS)).is_ok());
}

// ---- The file

fn good_item() -> Value {
    json!({
        "id": ID_1, "post": SOURCE, "revision": 1, "digest": body_digest(REFLECTION),
        "featured": "2026-10-28", "context": "A careful reading."
    })
}

fn file(items: Vec<Value>) -> String {
    serde_json::to_string_pretty(&json!({"version": 1, "items": items})).unwrap()
}

#[test]
fn the_file_is_versioned_strict_canonical_and_holds_no_words_or_private_field() {
    assert_eq!(COMMUNITY_FEATURES_FILE, "community-perspectives.json");
    let read = FeaturesFile::from_json(&file(vec![good_item()])).unwrap();
    assert_eq!(read.items.len(), 1);
    assert_eq!(FeaturesFile::from_json(&read.to_json()).unwrap(), read);
    assert_eq!(
        read.to_json(),
        FeaturesFile::from_json(&read.to_json()).unwrap().to_json(),
        "deterministic"
    );
    assert!(read.to_json().ends_with("}\n"));
    assert_eq!(
        FeaturesFile::default().to_json(),
        "{\n  \"items\": [],\n  \"version\": 1\n}\n"
    );

    for (field, value) in [
        ("body", json!(REFLECTION)),
        ("consents", json!([])),
        ("selectedBy", json!("mikey")),
        ("rank", json!(1)),
        ("votes", json!(3)),
        ("moderator", json!("mikey")),
        ("featureRevision", json!(1)),
        ("name", json!("Mina")),
    ] {
        let mut bad = good_item();
        bad[field] = value;
        let error = FeaturesFile::from_json(&file(vec![bad])).unwrap_err();
        assert!(error.starts_with("item 1:"), "{field}: {error}");
        assert!(
            !error.contains(REFLECTION) && !error.contains("mikey"),
            "{error}"
        );
    }
    for (field, value) in [
        ("id", json!("00000000-0000-4000-8000-00000000000A")),
        ("post", json!("../secret.md")),
        ("revision", json!(0)),
        ("digest", json!("ABC")),
        ("featured", json!("2026-13-01")),
        ("context", json!("")),
        ("context", json!("  padded ")),
        ("context", json!("The most popular one")),
        ("context", json!("x".repeat(MAX_CONTEXT_CHARS + 1))),
    ] {
        let mut bad = good_item();
        bad[field] = value;
        assert!(
            FeaturesFile::from_json(&file(vec![bad])).is_err(),
            "{field}"
        );
    }
    assert!(FeaturesFile::from_json(r#"{"version":2,"items":[]}"#)
        .unwrap_err()
        .contains("newer"));
    assert!(FeaturesFile::from_json(r#"{"version":0,"items":[]}"#).is_err());
    assert!(FeaturesFile::from_json(r#"{"version":1,"items":[],"extra":1}"#).is_err());
    assert!(FeaturesFile::from_json("not json").is_err());
}

#[test]
fn the_digest_is_stable_and_binds_the_exact_text() {
    assert_eq!(body_digest("a"), body_digest("a"));
    assert_ne!(body_digest("a"), body_digest("a "));
    assert_eq!(body_digest("a").len(), 64);
}
