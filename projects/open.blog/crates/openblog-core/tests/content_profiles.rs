use openblog_core::{
    frontmatter, generate, model, profile, LoadOptions, Site, SiteConfig, SourceFile, Sources,
    ThemeSet,
};

fn fields(source: &str) -> frontmatter::FrontMatter {
    frontmatter::parse(source).unwrap().front_matter
}

#[test]
fn defaults_articles_and_resolves_the_legacy_recipe_marker() {
    let article = profile::resolve(&fields("---\ntitle: Notes\n---\nBody"));
    assert_eq!(article.id, "article");
    assert_eq!(article.behavior, profile::ProfileBehavior::Article);
    assert!(article.warnings.is_empty());

    let recipe = profile::resolve(&fields("---\nrecipe: true\n---\nBody"));
    assert_eq!(recipe.id, "recipe");
    assert_eq!(recipe.behavior, profile::ProfileBehavior::Recipe);
    assert!(recipe.warnings.is_empty());
}

#[test]
fn canonical_profile_wins_when_a_legacy_marker_disagrees() {
    let resolved = profile::resolve(&fields("---\nprofile: article\nrecipe: true\n---\nBody"));

    assert_eq!(resolved.id, "article");
    assert_eq!(resolved.behavior, profile::ProfileBehavior::Article);
    assert_eq!(
        resolved.warnings,
        vec!["profile `article` overrides the legacy recipe marker"]
    );
}

#[test]
fn unknown_profiles_keep_the_authored_id_and_fall_back_to_article_behavior() {
    let resolved = profile::resolve(&fields("---\nprofile: Field-Notes\n---\nBody"));

    assert_eq!(resolved.id, "Field-Notes");
    assert_eq!(resolved.behavior, profile::ProfileBehavior::Article);
    assert_eq!(
        resolved.warnings,
        vec!["unknown content profile `Field-Notes`; rendering as an article"]
    );
}

#[test]
fn catalog_describes_profiles_and_their_authoring_fields() {
    let profiles = profile::catalog();
    assert_eq!(
        profiles.iter().map(|item| item.id).collect::<Vec<_>>(),
        vec![
            "article",
            "recipe",
            "research",
            "video",
            "field-journal",
            "job"
        ]
    );
    assert_eq!(profiles[0].label, "Article");
    assert!(profiles[0].fields.is_empty());
    assert_eq!(
        profiles[1]
            .fields
            .iter()
            .map(|field| field.key)
            .collect::<Vec<_>>(),
        vec![
            "servings",
            "yield",
            "prepTime",
            "cookTime",
            "totalTime",
            "cuisine",
            "category",
            "calories"
        ]
    );
    assert_eq!(profiles[2].label, "Research");
    assert_eq!(
        profiles[2]
            .fields
            .iter()
            .map(|field| field.key)
            .collect::<Vec<_>>(),
        vec!["doi", "license"]
    );
    assert_eq!(profiles[3].label, "Video production");
    assert_eq!(
        profiles[3]
            .fields
            .iter()
            .map(|field| field.key)
            .collect::<Vec<_>>(),
        vec![
            "productionStatus",
            "seasonNumber",
            "episodeNumber",
            "productionCredits",
            "videoUrl",
            "duration",
            "thumbnail",
            "aiDisclosure"
        ]
    );
    assert_eq!(profiles[4].label, "Field journal");
    assert_eq!(
        profiles[4]
            .fields
            .iter()
            .map(|field| field.key)
            .collect::<Vec<_>>(),
        vec![
            "activity",
            "location",
            "locationPrivacy",
            "distanceKm",
            "elevationGainM",
            "duration",
            "conditions"
        ]
    );
}

#[test]
fn resolves_and_loads_a_privacy_safe_field_journal() {
    let resolved = profile::resolve(&fields("---\nprofile: field-journal\n---\nBody"));
    assert_eq!(resolved.behavior, profile::ProfileBehavior::FieldJournal);

    let post = model::load_post(
        &SourceFile {
            path: "posts/ridge.md".into(),
            contents: "---\ntitle: Ridge walk\ndate: 2026-10-23\nprofile: field-journal\nactivity: Hike\nlocation: Northern ridge\nlocationPrivacy: trimmed\ndistanceKm: 8.4\nelevationGainM: 420\nduration: 2 hr 15 min\nconditions: Cool and windy\nroute: /tracks/private.gpx\nrouteShape: 0,80 400,20 1000,60\nelevationProfile: 0,90 500,15 1000,55\n---\nTrail notes."
                .into(),
        },
        &SiteConfig::default(),
        Default::default(),
    )
    .unwrap();

    let journal = post.field_journal.expect("field journal metadata");
    assert_eq!(journal.activity, "Hike");
    assert_eq!(journal.location.as_deref(), Some("Northern ridge"));
    assert_eq!(journal.distance_km.as_deref(), Some("8.4"));
    assert_eq!(journal.elevation_gain_m, Some(420));
    assert_eq!(journal.duration_seconds, Some(8100));
    assert!(
        journal.route_url.is_none(),
        "non-exact tracks are never published"
    );
    assert_eq!(journal.route_shape.as_deref(), Some("0,80 400,20 1000,60"));
}

#[test]
fn field_journal_output_never_exposes_a_non_exact_source_track() {
    let build = |privacy: &str| {
        let site = Site::load(
            SiteConfig::from_json(
                r#"{"title":"Trail notes","url":"https://walk.example","postPath":"/{slug}/"}"#,
            )
            .unwrap(),
            Sources {
                posts: vec![SourceFile {
                    path: "posts/ridge.md".into(),
                    contents: format!(
                        "---\ntitle: Ridge walk\ndate: 2026-10-23\nprofile: field-journal\nlocationPrivacy: {privacy}\nroute: /tracks/uploads/2026/secret.gpx\nrouteShape: 0,80 400,20 1000,60\nconditions: Cool & windy\n---\nTrail notes."
                    ),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        let files = generate(&site, &ThemeSet::new()).unwrap();
        files
            .iter()
            .find(|file| file.path == "ridge/index.html")
            .unwrap()
            .contents
            .clone()
    };

    let trimmed = build("trimmed");
    assert!(trimmed.contains("Privacy-filtered route outline"));
    assert!(trimmed.contains("Cool &amp; windy"));
    assert!(!trimmed.contains("secret.gpx"));

    let hidden = build("hidden");
    assert!(!hidden.contains("Privacy-filtered route outline"));
    assert!(!hidden.contains("secret.gpx"));

    let exact = build("exact");
    assert!(exact.contains("href=\"/tracks/uploads/2026/secret.gpx\" download"));

    let unsafe_site = Site::load(
        SiteConfig::default(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/unsafe.md".into(),
                contents: "---\ntitle: Unsafe\ndate: 2026-10-23\nprofile: field-journal\nlocationPrivacy: exact\nroute: javascript:alert(1)\n---\nNotes."
                    .into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();
    let unsafe_page = generate(&unsafe_site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .find(|file| file.path == "posts/unsafe/index.html")
        .unwrap()
        .contents;
    assert!(!unsafe_page.contains("javascript:"));
}

#[test]
fn resolves_the_research_profile_without_changing_article_or_recipe_behavior() {
    let resolved = profile::resolve(&fields(
        "---\nprofile: research\ndoi: 10.1234/example\n---\nBody",
    ));

    assert_eq!(resolved.id, "research");
    assert_eq!(resolved.behavior, profile::ProfileBehavior::Research);
    assert!(resolved.warnings.is_empty());
}

#[test]
fn resolves_and_loads_the_video_profile() {
    let resolved = profile::resolve(&fields(
        "---\nprofile: video\nvideoUrl: https://youtu.be/dQw4w9WgXcQ\n---\nBody",
    ));
    assert_eq!(resolved.id, "video");
    assert_eq!(resolved.behavior, profile::ProfileBehavior::Video);

    let post = model::load_post(
        &SourceFile {
            path: "posts/episode.md".into(),
            contents: "---\ntitle: Episode one\ndate: 2026-10-23\nprofile: video\nvideoUrl: https://www.youtube.com/watch?v=dQw4w9WgXcQ\nduration: 12 min 34 sec\nthumbnail: /images/episode.jpg\naiDisclosure: AI-assisted animation\n---\n## Transcript\nOpening narration."
                .into(),
        },
        &SiteConfig::default(),
        Default::default(),
    )
    .unwrap();

    let video = post.video.expect("video metadata");
    assert_eq!(video.youtube_id.as_deref(), Some("dQw4w9WgXcQ"));
    assert_eq!(video.duration_seconds, Some(754));
    assert_eq!(video.thumbnail.as_deref(), Some("/images/episode.jpg"));
    assert_eq!(
        video.ai_disclosure.as_deref(),
        Some("AI-assisted animation")
    );
}

#[test]
fn loaded_posts_expose_the_resolved_profile_and_obey_canonical_precedence() {
    let post = model::load_post(
        &SourceFile {
            path: "posts/supper.md".into(),
            contents: "---\ntitle: Supper\ndate: 2026-10-23\nprofile: article\nrecipe: true\n---\n## Ingredients\n- Beans\n\n## Steps\n1. Cook"
                .into(),
        },
        &SiteConfig::default(),
        Default::default(),
    )
    .unwrap();

    assert_eq!(post.profile, "article");
    assert!(post.recipe.is_none());
}

#[test]
fn site_load_surfaces_profile_fallbacks_as_source_scoped_warnings() {
    let site = Site::load(
        SiteConfig::default(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/notes.md".into(),
                contents:
                    "---\ntitle: Notes\ndate: 2026-10-23\nprofile: field-notes\n---\n## Entry\nBody"
                        .into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();

    assert_eq!(site.posts[0].profile, "field-notes");
    assert!(site.warnings.contains(
        &"posts/notes.md: unknown content profile `field-notes`; rendering as an article"
            .to_string()
    ));
}

#[test]
fn canonical_recipe_profile_keeps_legacy_generated_output_byte_for_byte() {
    let build = |marker: &str| {
        let site = Site::load(
            SiteConfig::from_json(
                r#"{"title":"Kitchen","url":"https://food.example","postPath":"/{slug}/"}"#,
            )
            .unwrap(),
            Sources {
                posts: vec![SourceFile {
                    path: "posts/soup.md".into(),
                    contents: format!(
                        "---\ntitle: Soup\ndate: 2026-10-23\n{marker}\nservings: 4\nprepTime: 10 min\n---\n## Ingredients\n- Water\n\n## Steps\n1. Simmer"
                    ),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        generate(&site, &ThemeSet::new()).unwrap()
    };

    assert_eq!(build("profile: recipe"), build("recipe: true"));
}
