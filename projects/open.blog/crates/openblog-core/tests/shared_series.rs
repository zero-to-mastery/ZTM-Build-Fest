//! A shared reflection joins an ordinary series through the existing `series` and `seriesOrder`
//! front matter, with the placement approved like any other public metadata (ADR 0038).

use openblog_core::approval::ApprovalSet;
use openblog_core::assembly::{assemble, with_subject, Assembly, AssemblyError};
use openblog_core::collaboration::{
    AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference,
    Participant, SharedPublication, SourceKind,
};
use openblog_core::config::SiteConfig;
use openblog_core::contributor::Contributor;
use openblog_core::draft::DraftSet;
use openblog_core::media_moment::MomentSet;
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::shared_series::{SeriesError, SeriesPlacement};
use openblog_core::synthesis::SynthesisSet;

const T: i64 = 1_800_000_000;
const ALL: [&str; 2] = ["ann", "bo"];
const DATE: &str = "2030-01-31T09:00:00Z";
const AUTHOR: &str = r#"{"vocabulary":"crossref","role":"author"}"#;

fn record(id: &str) -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: id.into(),
        title: "Noticing, together".into(),
        guiding_question: "What did you notice?".into(),
        sources: vec![NewSourceReference {
            kind: SourceKind::Video,
            title: "The Art of Noticing".into(),
            ..NewSourceReference::default()
        }],
        creator: NewParticipant {
            admin_user: "ann-admin".into(),
            contributor_id: "ann".into(),
            display_name: "Ann".into(),
        },
    })
    .unwrap();
    record.collaboration.participants[0].id = "ann".into();
    record.authorization.bindings[0].participant_id = "ann".into();
    record.collaboration.participants.push(Participant {
        id: "bo".into(),
        display_name: "Bo".into(),
        profile_url: None,
    });
    record.authorization.bindings.push(IdentityBinding {
        admin_user: "bo-admin".into(),
        contributor_id: "bo".into(),
        participant_id: "bo".into(),
        roles: vec![AuthorizationRole::Contributor],
    });
    record
}

fn drafts() -> DraftSet {
    let mut set = DraftSet::new(&ALL).unwrap();
    set.save("ann", "ann", 0, "Ann words", T).unwrap();
    set.save("bo", "bo", 0, "Bo words", T).unwrap();
    set
}

fn approve_all(record: &SharedPublication, set: &DraftSet, approvals: &mut ApprovalSet) {
    for who in ALL {
        let seen = with_subject(
            record,
            None,
            set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &ALL,
            |s| approvals.binding_for(s, who).unwrap(),
        );
        with_subject(
            record,
            None,
            set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &ALL,
            |s| approvals.approve(who, who, s, &seen, true, T),
        )
        .unwrap();
    }
}

fn publish(record: &SharedPublication, approvals: &ApprovalSet) -> Result<Assembly, AssemblyError> {
    assemble(
        record,
        None,
        &drafts(),
        &SynthesisSet::new(),
        &MomentSet::new(),
        approvals,
        &ALL,
        DATE,
    )
}

fn approved(record: &SharedPublication) -> Assembly {
    let mut approvals = ApprovalSet::new();
    approve_all(record, &drafts(), &mut approvals);
    publish(record, &approvals).unwrap()
}

fn placed(id: &str, series: &str, order: Option<u32>) -> (SharedPublication, Assembly) {
    let record = record(id)
        .with_series(Some(SeriesPlacement::new(series, order).unwrap()))
        .unwrap();
    let made = approved(&record);
    (record, made)
}

fn config() -> SiteConfig {
    let mut config = SiteConfig::from_json(
        r#"{"title":"T","url":"https://example.test","postPath":"/{slug}/","author":{"name":"Site Owner"}}"#,
    )
    .unwrap();
    for (id, name) in [("ann", "Ann"), ("bo", "Bo"), ("cy", "Cy")] {
        config.contributors.insert(
            id.into(),
            Contributor {
                name: name.into(),
                url: format!("https://example.org/{id}"),
                ..Contributor::default()
            },
        );
    }
    config
}

fn file(path: &str, contents: &str) -> SourceFile {
    SourceFile {
        path: path.into(),
        contents: contents.into(),
    }
}

fn load(posts: Vec<SourceFile>, credits: Vec<SourceFile>, series: Vec<SourceFile>) -> Site {
    Site::load(
        config(),
        Sources {
            posts,
            credits,
            series,
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"))
}

fn titles(site: &Site, slug: &str) -> Vec<String> {
    site.series_by_slug(slug)
        .unwrap()
        .posts
        .iter()
        .map(|&i| site.posts[i].title.clone())
        .collect()
}

#[test]
fn a_record_without_a_placement_is_byte_for_byte_a_legacy_record() {
    let legacy = record("shared-0a1b2c3d4e5f");
    let json = serde_json::to_string(&legacy).unwrap();
    assert!(!json.contains("series"));
    assert_eq!(SharedPublication::from_json(&json).unwrap(), legacy);
    // Clearing a placement restores the exact legacy approval binding and Post.
    let mut approvals = ApprovalSet::new();
    approve_all(&legacy, &drafts(), &mut approvals);
    let round_trip = legacy
        .with_series(Some(SeriesPlacement::new("S", Some(1)).unwrap()))
        .unwrap()
        .with_series(None)
        .unwrap();
    let made = publish(&round_trip, &approvals).unwrap();
    assert!(!made.source.contains("series"));
    assert_eq!(made.source, publish(&legacy, &approvals).unwrap().source);
}

#[test]
fn the_placement_is_ordinary_series_front_matter_and_loads_through_the_series_model() {
    let (_, made) = placed("shared-0a1b2c3d4e5f", "Field Notes", Some(2));
    assert!(made.source.contains("series: Field Notes\n"));
    assert!(made.source.contains("seriesOrder: 2\n"));
    let site = load(
        vec![
            file(
                "posts/legacy-one.md",
                "---\ntitle: Legacy one\ndate: 2029-01-01\nseries: field-notes\nseriesOrder: 1\n---\nx",
            ),
            file(&made.path, &made.source),
        ],
        vec![file(&made.credits_path, &made.credits)],
        vec![file(
            "series/field-notes.md",
            "---\nname: Field Notes\ntheme: paper\n---\nSite owned description",
        )],
    );
    // One series, defined by the site, holds the legacy and the shared post in order.
    assert_eq!(site.series.len(), 1);
    assert_eq!(
        titles(&site, "field-notes"),
        ["Legacy one", "Noticing, together"]
    );
    let shared = site
        .posts
        .iter()
        .position(|p| p.title.starts_with("Noticing"))
        .unwrap();
    let (prev, next) = site.series_neighbors(shared);
    assert_eq!(prev.unwrap().title, "Legacy one");
    assert!(next.is_none());
    assert_eq!(
        site.series_by_slug("field-notes").unwrap().theme.as_deref(),
        Some("paper")
    );
}

#[test]
fn legacy_posts_and_series_are_unchanged_by_a_collaborative_neighbour_elsewhere() {
    let legacy = || {
        vec![
            file(
                "posts/a.md",
                "---\ntitle: A\ndate: 2029-01-01\nseries: old\n---\nx",
            ),
            file("posts/b.md", "---\ntitle: B\ndate: 2029-02-01\n---\ny"),
        ]
    };
    let before = load(legacy(), vec![], vec![]);
    let (_, made) = placed("shared-0a1b2c3d4e5f", "Brand New", None);
    let mut posts = legacy();
    posts.push(file(&made.path, &made.source));
    let after = load(posts, vec![file(&made.credits_path, &made.credits)], vec![]);
    assert_eq!(titles(&before, "old"), titles(&after, "old"));
    let b = after.posts.iter().position(|p| p.title == "B").unwrap();
    assert_eq!(after.series_neighbors(b), (None, None));
    // The new series exists only because the publication named it.
    assert_eq!(titles(&after, "brand-new"), ["Noticing, together"]);
}

#[test]
fn arbitrary_titles_work_and_cannot_inject_front_matter() {
    let long = "A".repeat(120);
    for title in [
        "Série: 日本語 & <b>bold</b> # not a comment",
        "\"quoted\" 'single' - dash",
        "true",
        "[not, a, list]",
        "  padded  ",
        long.as_str(),
    ] {
        let (_, made) = placed("shared-0a1b2c3d4e5f", title, Some(1));
        let site = load(
            vec![file(&made.path, &made.source)],
            vec![file(&made.credits_path, &made.credits)],
            vec![],
        );
        let slug = openblog_core::slug::slugify(title);
        assert_eq!(
            site.posts[0].series.as_deref(),
            Some(slug.as_str()),
            "{title}"
        );
        assert_eq!(site.posts[0].series_order, Some(1));
        assert_eq!(site.posts[0].title, "Noticing, together");
    }
}

#[test]
fn refusals_name_the_problem_and_never_repeat_the_value() {
    let bad = |text: &str| SeriesPlacement::new(text, None).unwrap_err();
    assert_eq!(bad(""), SeriesError::Reference);
    assert_eq!(bad("   "), SeriesError::Reference);
    assert_eq!(bad("one\ntwo"), SeriesError::Reference);
    assert_eq!(bad("one\u{202E}two"), SeriesError::Reference);
    assert_eq!(bad("tab\there"), SeriesError::Reference);
    assert_eq!(bad("x\ny: injected"), SeriesError::Reference);
    assert_eq!(bad(&"a".repeat(121)), SeriesError::Reference);
    assert_eq!(bad("!!! ???"), SeriesError::NoAddress);
    assert_eq!(bad("\u{1F600}"), SeriesError::NoAddress);
    for error in [SeriesError::Reference, SeriesError::NoAddress] {
        assert!(!error.to_string().contains("injected"));
    }
    // A stored record that says otherwise fails to load, as does an unknown placement field.
    let json = serde_json::to_value(placed("shared-0a1b2c3d4e5f", "S", None).0).unwrap();
    for series in [
        serde_json::json!({ "series": "x\ny: z" }),
        serde_json::json!({ "series": "!!!" }),
        serde_json::json!({ "series": " padded " }),
        serde_json::json!({ "series": "ok", "theme": "x" }),
        serde_json::json!({ "series": "ok", "order": -1 }),
    ] {
        let mut tampered = json.clone();
        tampered["series"] = series;
        assert!(SharedPublication::from_json(&tampered.to_string()).is_err());
    }
}

#[test]
fn changing_the_placement_invalidates_every_approval_and_reverting_restores_them() {
    let (record, _) = placed("shared-0a1b2c3d4e5f", "Notes", Some(1));
    let mut approvals = ApprovalSet::new();
    approve_all(&record, &drafts(), &mut approvals);
    assert!(publish(&record, &approvals).is_ok());
    for changed in [
        record.with_series(Some(SeriesPlacement::new("Other", Some(1)).unwrap())),
        record.with_series(Some(SeriesPlacement::new("Notes", Some(2)).unwrap())),
        record.with_series(Some(SeriesPlacement::new("Notes", None).unwrap())),
        record.with_series(None),
    ] {
        let changed = changed.unwrap();
        match publish(&changed, &approvals) {
            Err(AssemblyError::Blocked { missing }) => assert_eq!(missing, ["Ann", "Bo"]),
            other => panic!("expected blocked, got {other:?}"),
        }
    }
    // Recomputed, never flagged: putting it back revives the consent that really covered it.
    let back = record
        .with_series(None)
        .unwrap()
        .with_series(record.series.clone())
        .unwrap();
    assert!(publish(&back, &approvals).is_ok());
}

#[test]
fn a_placement_alone_never_publishes() {
    let record = record("shared-0a1b2c3d4e5f")
        .with_series(Some(SeriesPlacement::new("Notes", None).unwrap()))
        .unwrap();
    assert!(matches!(
        publish(&record, &ApprovalSet::new()),
        Err(AssemblyError::Blocked { .. })
    ));
}

#[test]
fn duplicate_orders_and_unordered_parts_sort_deterministically_without_losing_a_post() {
    let (_, one) = placed("shared-0a1b2c3d4e5f", "Run", Some(1));
    let (_, two) = placed("shared-1a1b2c3d4e5f", "Run", Some(1));
    let (_, none) = placed("shared-2a1b2c3d4e5f", "Run", None);
    let dated = |made: &Assembly, name: &str, date: &str| {
        let source = made
            .source
            .replace(DATE, date)
            .replace("noticing-together", &name.to_lowercase().replace(' ', "-"))
            .replace("Noticing, together", name);
        file(&made.path, &source)
    };
    let site = load(
        vec![
            dated(&one, "Shared A", "2030-03-01T09:00:00Z"),
            dated(&two, "Shared B", "2030-02-01T09:00:00Z"),
            dated(&none, "Shared C", "2030-01-01T09:00:00Z"),
            file(
                "posts/legacy.md",
                "---\ntitle: Legacy tie\ndate: 2029-06-01\nseries: run\nseriesOrder: 1\n---\nx",
            ),
            file(
                "posts/legacy-late.md",
                "---\ntitle: Legacy unordered\ndate: 2031-01-01\nseries: run\n---\nx",
            ),
        ],
        vec![
            file(&one.credits_path, &one.credits),
            file(&two.credits_path, &two.credits),
            file(&none.credits_path, &none.credits),
        ],
        vec![],
    );
    let run = site.series_by_slug("run").unwrap();
    assert_eq!(run.posts.len(), 5);
    let dates: Vec<String> = run
        .posts
        .iter()
        .map(|&i| site.posts[i].title.clone() + &format!("{:?}", site.posts[i].series_order))
        .collect();
    // Ties on the same order go by date; unordered parts follow every ordered one, by date.
    assert_eq!(
        dates,
        [
            "Legacy tieSome(1)",
            "Shared BSome(1)",
            "Shared ASome(1)",
            "Shared CNone",
            "Legacy unorderedNone"
        ]
    );
    let shared_dates: Vec<_> = run.posts[1..3]
        .iter()
        .map(|&i| site.posts[i].date)
        .collect();
    assert!(shared_dates[0] < shared_dates[1]);
}

#[test]
fn series_contributors_follow_the_work_credits_as_they_change() {
    let (_, made) = placed("shared-0a1b2c3d4e5f", "Notes", Some(2));
    let solo = file(
        "posts/solo.md",
        "---\ntitle: Solo\ndate: 2029-01-01\nseries: notes\nseriesOrder: 1\n---\nx",
    );
    let credits = |people: &[&str]| {
        let entries: Vec<String> = people
            .iter()
            .map(|id| format!(r#"{{"contributor":"{id}","roles":[{AUTHOR}]}}"#))
            .collect();
        format!(r#"{{"version":1,"credits":[{}]}}"#, entries.join(","))
    };
    let site = |sidecar: Option<String>| {
        let mut sidecars = vec![file(&made.credits_path, &made.credits)];
        if let Some(sidecar) = sidecar {
            sidecars.push(file("posts/solo.credits.json", &sidecar));
        }
        load(
            vec![solo.clone(), file(&made.path, &made.source)],
            sidecars,
            vec![],
        )
    };
    let ids = |site: &Site| -> Vec<String> {
        let series = site.series_by_slug("notes").unwrap();
        site.series_contributors(series)
            .iter()
            .map(|c| c.contributor_id.clone())
            .collect()
    };
    // First appearance wins reading from the first part; a repeated person appears once.
    assert_eq!(ids(&site(Some(credits(&["cy"])))), ["cy", "ann", "bo"]);
    assert_eq!(
        ids(&site(Some(credits(&["bo", "cy"])))),
        ["bo", "cy", "ann"]
    );
    // Dropping a credit removes the person; nothing lingers.
    assert_eq!(ids(&site(Some(credits(&["ann"])))), ["ann", "bo"]);
    // Without a sidecar the legacy site author credit stands in for the ordinary post.
    assert_eq!(site(None).series_by_slug("notes").unwrap().posts.len(), 2);
    assert_eq!(ids(&site(None)).len(), 3);
}

#[test]
fn a_published_shared_reflection_names_its_authors_in_the_series_it_joins() {
    let (_, made) = placed("shared-0a1b2c3d4e5f", "Notes", Some(2));
    let solo = file(
        "posts/solo.md",
        "---\ntitle: Solo\ndate: 2029-01-01\nseries: notes\nseriesOrder: 1\n---\nx",
    );
    let site = load(
        vec![solo, file(&made.path, &made.source)],
        vec![file(&made.credits_path, &made.credits)],
        vec![],
    );
    let shared = site.posts.iter().find(|post| post.title != "Solo").unwrap();
    assert!(shared.is_collaborative());
    assert!(site.series_is_collaborative(site.series_by_slug("notes").unwrap()));
    let files = openblog_core::render::generate(&site, &openblog_core::ThemeSet::new()).unwrap();
    let html = |path: &str| {
        files
            .iter()
            .find(|file| file.path == path)
            .unwrap_or_else(|| panic!("no {path}"))
            .contents
            .as_str()
    };
    let series = html("series/notes/index.html");
    assert!(series.contains("Contributors: Site Owner, Ann, and Bo</p>"));
    assert!(series.contains("<span class=\"ob-part-credit\">By Ann and Bo</span>"));
    assert!(series.contains("<span class=\"ob-part-credit\">By Site Owner</span>"));
    let solo_page = html("solo/index.html");
    assert!(solo_page.contains("<span class=\"ob-meta ob-part-credit\">By Ann and Bo</span></a>"));
    // No account, publication id or other collaboration state reaches the navigation.
    for private in ["ann-admin", "bo-admin", "shared-0a1b2c3d4e5f"] {
        let nav = &solo_page[solo_page.find("ob-series-box").unwrap()..];
        assert!(
            !nav[..nav.find("</aside>").unwrap()].contains(private),
            "{private}"
        );
        assert!(!series.contains(private), "{private}");
    }
}

#[test]
fn a_shared_reflections_feeds_and_copies_carry_its_series_but_no_collaboration_state() {
    use openblog_core::portability::PortableProjection;

    let (_, made) = placed("shared-0a1b2c3d4e5f", "Notes", Some(2));
    let solo = file(
        "posts/solo.md",
        "---\ntitle: Solo\ndate: 2029-01-01\nseries: notes\nseriesOrder: 1\n---\nx",
    );
    let site = load(
        vec![solo, file(&made.path, &made.source)],
        vec![file(&made.credits_path, &made.credits)],
        vec![],
    );
    let files = openblog_core::render::generate(&site, &openblog_core::ThemeSet::new()).unwrap();
    let output = |path: &str| {
        files
            .iter()
            .find(|file| file.path == path)
            .unwrap_or_else(|| panic!("no {path}"))
            .contents
            .clone()
    };
    let shared = site.posts.iter().find(|post| post.title != "Solo").unwrap();
    let solo = site.posts.iter().find(|post| post.title == "Solo").unwrap();
    let mut public = vec![
        output("rss.xml"),
        output("feed.json"),
        output("llms-full.txt"),
    ];
    for post in [shared, solo] {
        let projection = PortableProjection::for_site(&site, post).unwrap();
        public.push(projection.portable_html().unwrap().html);
        public.push(projection.portable_markdown().unwrap());
        public.push(projection.portable_text().unwrap());
    }
    // The series, the shared part's place and its authors travel with every copy.
    let rss = &public[0];
    assert!(rss.contains("<category domain=\"https://example.test/series/\">Notes</category>"));
    assert!(public[3].contains(
        "Part 2 in the series <a href=\"https://example.test/series/notes/\">Notes</a>. This part is by Ann and Bo. Series contributors: Site Owner, Ann, and Bo."
    ));
    assert!(public[6].contains("Part 1 in the series"));
    // No account, publication id, approval or other collaboration state reaches any of them.
    for text in &public {
        for private in [
            "ann-admin",
            "bo-admin",
            "shared-0a1b2c3d4e5f",
            "approv",
            "binding",
            "participant",
        ] {
            assert!(!text.contains(private), "{private} in {text}");
        }
    }
}
