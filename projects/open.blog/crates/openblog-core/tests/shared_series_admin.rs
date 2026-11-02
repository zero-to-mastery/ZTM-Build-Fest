//! Setting a shared reflection's series placement from Admin, previewing the reading order and
//! creating a series definition (ADR 0039).

use openblog_core::collaboration::{
    AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference,
    Participant, SharedPublication, SourceKind,
};
use openblog_core::config::SiteConfig;
use openblog_core::invitation::Identities;
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::shared_series::{
    order_preview, series_choices, series_definition, DefinitionError, PlacementError, SeriesError,
    SeriesPlacement,
};
use openblog_core::DateTime;

const USERS: [&str; 6] = [
    "owner-admin",
    "coord-admin",
    "writer-admin",
    "editor-admin",
    "reader-admin",
    "stranger",
];
const KEYS: [&str; 5] = ["owner", "coord", "writer", "editor", "reader"];

fn identities() -> Identities<'static> {
    Identities {
        active_admin_users: &USERS,
        contributor_ids: &KEYS,
    }
}

/// One participant per role, each bound under their own Admin account.
fn record() -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: "shared-0a1b2c3d4e5f".into(),
        title: "Noticing, together".into(),
        guiding_question: "What did you notice?".into(),
        sources: vec![NewSourceReference {
            kind: SourceKind::Video,
            title: "The Art of Noticing".into(),
            ..NewSourceReference::default()
        }],
        creator: NewParticipant {
            admin_user: "owner-admin".into(),
            contributor_id: "owner".into(),
            display_name: "Owner".into(),
        },
    })
    .unwrap();
    record.collaboration.participants[0].id = "owner".into();
    record.authorization.bindings[0].participant_id = "owner".into();
    for (id, role) in [
        ("coord", AuthorizationRole::Coordinator),
        ("writer", AuthorizationRole::Contributor),
        ("editor", AuthorizationRole::Editor),
        ("reader", AuthorizationRole::Reader),
    ] {
        record.collaboration.participants.push(Participant {
            id: id.into(),
            display_name: id.into(),
            profile_url: None,
        });
        record.authorization.bindings.push(IdentityBinding {
            admin_user: format!("{id}-admin"),
            contributor_id: id.into(),
            participant_id: id.into(),
            roles: vec![role],
        });
    }
    record
}

fn placement(series: &str, order: Option<u32>) -> Option<SeriesPlacement> {
    Some(SeriesPlacement::new(series, order).unwrap())
}

#[test]
fn only_site_owners_and_coordinators_arrange_the_series_and_every_refusal_is_the_same() {
    let record = record();
    for (user, allowed) in [
        ("owner-admin", true),
        ("coord-admin", true),
        ("writer-admin", false),
        ("editor-admin", false),
        ("reader-admin", false),
        ("stranger", false),
        ("nobody", false),
    ] {
        let result = record.place_in_series(user, &identities(), placement("Letters", Some(2)), 0);
        match result {
            Ok(next) => {
                assert!(allowed, "{user}");
                assert_eq!(next.series, placement("Letters", Some(2)));
                assert_eq!(next.series_revision, 1);
            }
            Err(error) => {
                assert!(!allowed, "{user}");
                assert_eq!(error, PlacementError::Denied, "{user}");
            }
        }
    }
    // A disabled account holds no grant even with a binding.
    let disabled = Identities {
        active_admin_users: &["owner-admin"],
        contributor_ids: &KEYS,
    };
    assert_eq!(
        record.place_in_series("coord-admin", &disabled, placement("Letters", None), 0),
        Err(PlacementError::Denied)
    );
}

#[test]
fn a_change_against_an_older_read_is_refused_and_a_repeat_changes_nothing() {
    let legacy = record();
    let first = legacy
        .place_in_series(
            "coord-admin",
            &identities(),
            placement("Letters", Some(1)),
            0,
        )
        .unwrap();
    // Someone who read revision 0 cannot overwrite the newer choice, even with the same value.
    for stale in [
        placement("Other", None),
        placement("Letters", Some(1)),
        None,
    ] {
        assert_eq!(
            first.place_in_series("owner-admin", &identities(), stale, 0),
            Err(PlacementError::Stale)
        );
    }
    // A request that changes nothing keeps the record and its revision exactly.
    let same = first
        .place_in_series(
            "owner-admin",
            &identities(),
            placement("Letters", Some(1)),
            1,
        )
        .unwrap();
    assert_eq!(same, first);
    let unchanged = legacy
        .place_in_series("owner-admin", &identities(), None, 0)
        .unwrap();
    assert_eq!(unchanged, legacy);
    assert!(!serde_json::to_string(&unchanged)
        .unwrap()
        .contains("series"));

    // Reordering and removing each advance the revision; the counter survives removal.
    let moved = first
        .place_in_series(
            "owner-admin",
            &identities(),
            placement("Letters", Some(3)),
            1,
        )
        .unwrap();
    assert_eq!(moved.series_revision, 2);
    let removed = moved
        .place_in_series("coord-admin", &identities(), None, 2)
        .unwrap();
    assert_eq!((removed.series.clone(), removed.series_revision), (None, 3));
    let json = serde_json::to_string(&removed).unwrap();
    assert!(json.contains("\"seriesRevision\":3"));
    assert_eq!(SharedPublication::from_json(&json).unwrap(), removed);
}

#[test]
fn an_invalid_placement_is_refused_without_naming_the_value() {
    let bad = SeriesPlacement {
        series: "Line\nbreak: injected".into(),
        order: None,
    };
    let refused = record().place_in_series("owner-admin", &identities(), Some(bad), 0);
    assert_eq!(
        refused,
        Err(PlacementError::Invalid(SeriesError::Reference))
    );
}

fn config() -> SiteConfig {
    SiteConfig::from_json(
        r#"{"title":"T","url":"https://example.test","postPath":"/{slug}/","author":{"name":"Site Owner"}}"#,
    )
    .unwrap()
}

fn file(path: &str, contents: &str) -> SourceFile {
    SourceFile {
        path: path.into(),
        contents: contents.into(),
    }
}

fn post(slug: &str, date: &str, extra: &str) -> SourceFile {
    file(
        &format!("posts/{slug}.md"),
        &format!("---\ntitle: {slug}\ndate: {date}\n{extra}---\nBody."),
    )
}

/// The site as readers see it on 2030-06-01: no drafts and nothing scheduled after that date.
fn public_site(posts: Vec<SourceFile>, series: Vec<SourceFile>) -> Site {
    Site::load(
        config(),
        Sources {
            posts,
            series,
            ..Default::default()
        },
        LoadOptions {
            include_drafts: false,
            now: DateTime::parse("2030-06-01T00:00:00Z"),
            preview_source: None,
        },
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"))
}

fn letters_site() -> Site {
    public_site(
        vec![
            post("one", "2030-01-01", "series: Letters\nseriesOrder: 1\n"),
            post("two-a", "2030-02-01", "series: Letters\nseriesOrder: 2\n"),
            post("loose", "2030-03-01", "series: Letters\n"),
            post("hidden", "2030-01-15", "series: Letters\nseriesOrder: 2\ndraft: true\n"),
            post("later", "2031-01-01", "series: Letters\nseriesOrder: 1\n"),
            post("secret", "2030-01-01", "series: Unannounced\ndraft: true\n"),
        ],
        vec![file(
            "series/letters.md",
            "---\nname: Letters across time\ndescription: Two writers answer one letter.\n---\nPremise.",
        )],
    )
}

fn order_of(preview: &openblog_core::shared_series::SeriesOrderPreview) -> Vec<String> {
    preview
        .parts
        .iter()
        .map(|part| match &part.title {
            Some(title) => title.clone(),
            None => "THIS".into(),
        })
        .collect()
}

#[test]
fn the_preview_places_this_reflection_by_the_sites_own_ordering() {
    let site = letters_site();
    let at = |order| order_preview(&site, &placement("letters", order).unwrap(), true);
    // Ties go by date, and this reflection publishes after every existing part.
    assert_eq!(order_of(&at(Some(2))), ["one", "two-a", "THIS", "loose"]);
    assert_eq!(order_of(&at(Some(1))), ["one", "THIS", "two-a", "loose"]);
    assert_eq!(order_of(&at(Some(0))), ["THIS", "one", "two-a", "loose"]);
    // Unordered goes after the ordered parts and after older unordered ones.
    assert_eq!(order_of(&at(None)), ["one", "two-a", "loose", "THIS"]);
    let preview = at(Some(9));
    assert_eq!(order_of(&preview), ["one", "two-a", "THIS", "loose"]);
    assert_eq!(preview.name, "Letters across time");
    assert!(preview.defined);
    assert_eq!(preview.description, "Two writers answer one letter.");
    assert_eq!(preview.parts[0].url.as_deref(), Some("/one/"));
    // Once published it is one of the site's posts, so no placeholder is added.
    assert_eq!(
        order_of(&order_preview(
            &site,
            &placement("Letters", Some(2)).unwrap(),
            false
        )),
        ["one", "two-a", "loose"]
    );
}

#[test]
fn drafts_scheduled_posts_and_unknown_series_never_appear_in_lists_or_previews() {
    let site = letters_site();
    let choices = series_choices(&site);
    assert_eq!(choices.len(), 1, "{choices:?}");
    assert_eq!(choices[0].slug, "letters");
    assert_eq!(choices[0].parts, 3);
    assert!(choices[0].defined);
    let text = serde_json::to_string(&choices).unwrap();
    for private in ["hidden", "later", "secret", "Unannounced"] {
        assert!(!text.contains(private), "{private}");
    }
    let unannounced = order_preview(&site, &placement("Unannounced", None).unwrap(), true);
    assert_eq!(order_of(&unannounced), ["THIS"]);
    assert!(!unannounced.defined);
    assert_eq!(unannounced.name, "Unannounced");
    assert_eq!(unannounced.description, "");
    let preview = serde_json::to_string(&order_preview(
        &site,
        &placement("Letters", None).unwrap(),
        true,
    ))
    .unwrap();
    assert!(!preview.contains("hidden") && !preview.contains("later"));
}

#[test]
fn a_series_definition_loads_as_the_series_a_placement_with_that_title_joins() {
    for (title, premise) in [
        (
            "Letters across time",
            "Two writers answer one letter, a season apart.",
        ),
        ("Año: ¿por qué? #1", ""),
        ("---\nname", "x"),
    ] {
        let Ok(definition) = series_definition(title, premise) else {
            assert!(title.contains('\n'));
            continue;
        };
        let reference = SeriesPlacement::new(title, None).unwrap();
        let site = public_site(
            vec![post(
                "part",
                "2030-01-01",
                &format!("series: \"{}\"\n", reference.series.replace('"', "\\\"")),
            )],
            vec![file(&definition.path, &definition.source)],
        );
        assert_eq!(site.series.len(), 1, "{title}: {:?}", site.series);
        let series = &site.series[0];
        assert_eq!(series.slug, definition.slug);
        assert_eq!(series.name, title.trim());
        assert_eq!(series.posts.len(), 1);
        assert_eq!(series.description_text, premise);
        assert_eq!(definition.path, format!("series/{}.md", definition.slug));
    }
}

#[test]
fn a_premise_reads_as_written_and_can_never_become_markup_or_add_a_field() {
    let premise = "<script>alert(1)</script> [link](javascript:x) **bold** theme: dark";
    let definition = series_definition("Letters", premise).unwrap();
    let site = public_site(Vec::new(), vec![file(&definition.path, &definition.source)]);
    let series = &site.series[0];
    assert!(!series.description_html.contains("<script"));
    assert!(!series.description_html.contains("<a "));
    assert!(!series.description_html.contains("<strong>"));
    assert!(series.description_html.contains("&lt;script&gt;"));
    assert!(series.theme.is_none());
    assert_eq!(series.description_text, premise);
    // A title that tries to close the front matter stays one quoted value.
    let sneaky = series_definition("x\" theme: dark", "").unwrap();
    let site = public_site(Vec::new(), vec![file(&sneaky.path, &sneaky.source)]);
    assert!(site.series[0].theme.is_none());
    assert_eq!(site.series[0].name, "x\" theme: dark");
}

#[test]
fn bad_titles_and_premises_are_refused_by_rule() {
    assert_eq!(
        series_definition("  ", ""),
        Err(DefinitionError::Title(SeriesError::Reference))
    );
    assert_eq!(
        series_definition("!!!", ""),
        Err(DefinitionError::Title(SeriesError::NoAddress))
    );
    for premise in ["line\nbreak", "bidi \u{202E}", &"p".repeat(501)] {
        assert_eq!(
            series_definition("Letters", premise),
            Err(DefinitionError::Premise)
        );
    }
    assert!(series_definition("Letters", &"p".repeat(500)).is_ok());
}
