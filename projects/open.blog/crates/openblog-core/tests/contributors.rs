use openblog_core::{
    contributor::{CreditProvenance, RoleVocabulary},
    markdown::RenderOptions,
    model::load_post_with_credits,
    LoadOptions, Site, SiteConfig, SourceFile, Sources,
};

fn source(path: &str, contents: &str) -> SourceFile {
    SourceFile {
        path: path.into(),
        contents: contents.into(),
    }
}

fn post(path: &str, extra_frontmatter: &str) -> SourceFile {
    source(
        path,
        &format!("---\ntitle: Credit test\ndate: 2026-10-23\n{extra_frontmatter}---\nBody"),
    )
}

#[test]
fn legacy_posts_resolve_the_site_author_without_an_explicit_sidecar() {
    let config = SiteConfig::from_json(
        r#"{"author":{"name":"Legacy Author","url":"/about/","sameAs":["https://example.com/legacy"]}}"#,
    )
    .unwrap();
    let site = Site::load(
        config,
        Sources {
            posts: vec![post("posts/legacy.md", "")],
            ..Default::default()
        },
        LoadOptions {
            include_drafts: true,
            ..Default::default()
        },
    )
    .unwrap();

    let loaded = &site.posts[0];
    assert_eq!(loaded.credit_provenance, CreditProvenance::LegacySiteAuthor);
    assert_eq!(loaded.credits.len(), 1);
    assert_eq!(loaded.credits[0].contributor.name, "Legacy Author");
    assert_eq!(loaded.authors().count(), 1);
}

#[test]
fn explicit_sidecar_preserves_contributor_and_role_order() {
    let config = SiteConfig::from_json(
        r#"{
          "author":{"name":"Legacy Author"},
          "contributors":{
            "ada":{"name":"Ada","orcid":"0000-0002-1825-0097"},
            "grace":{"name":"Grace"}
          }
        }"#,
    )
    .unwrap();
    assert_eq!(
        config.contributors["ada"].orcid,
        "https://orcid.org/0000-0002-1825-0097"
    );
    let site = Site::load(
        config,
        Sources {
            posts: vec![post("posts/study.md", "profile: research\n")],
            credits: vec![source(
                "posts/study.credits.json",
                r#"{
                  "version":1,
                  "credits":[
                    {"contributor":"grace","roles":[
                      {"vocabulary":"crossref","role":"editor"},
                      {"vocabulary":"credit","role":"software"}
                    ]},
                    {"contributor":"ada","roles":[
                      {"vocabulary":"crossref","role":"author"},
                      {"vocabulary":"credit","role":"conceptualization"}
                    ]}
                  ]
                }"#,
            )],
            ..Default::default()
        },
        LoadOptions {
            include_drafts: true,
            ..Default::default()
        },
    )
    .unwrap();

    let loaded = &site.posts[0];
    assert_eq!(loaded.credit_provenance, CreditProvenance::ExplicitSidecar);
    assert_eq!(loaded.credits[0].contributor_id, "grace");
    assert_eq!(loaded.credits[1].contributor_id, "ada");
    assert_eq!(loaded.credits[0].roles[0].role, "editor");
    assert_eq!(
        loaded.credits[0].roles[1].vocabulary,
        RoleVocabulary::Credit
    );
    assert_eq!(
        loaded
            .authors()
            .map(|credit| credit.contributor.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Ada"]
    );
}

#[test]
fn an_empty_explicit_sidecar_disables_legacy_inheritance() {
    let config = SiteConfig::from_json(r#"{"author":{"name":"Legacy Author"}}"#).unwrap();
    let site = Site::load(
        config,
        Sources {
            posts: vec![post("posts/anonymous.md", "")],
            credits: vec![source(
                "posts/anonymous.credits.json",
                r#"{"version":1,"credits":[]}"#,
            )],
            ..Default::default()
        },
        LoadOptions {
            include_drafts: true,
            ..Default::default()
        },
    )
    .unwrap();

    assert!(site.posts[0].credits.is_empty());
    assert_eq!(
        site.posts[0].credit_provenance,
        CreditProvenance::ExplicitSidecar
    );
}

#[test]
fn malformed_credit_sources_report_the_sidecar_path() {
    let config = SiteConfig::from_json(
        r#"{"contributors":{"ada":{"name":"Ada"},"grace":{"name":"Grace"}}}"#,
    )
    .unwrap();
    let errors = Site::load(
        config,
        Sources {
            posts: vec![post("posts/broken.md", "")],
            credits: vec![source(
                "posts/broken.credits.json",
                r#"{"version":1,"credits":[
                  {"contributor":"ada","roles":[{"vocabulary":"crossref","role":"author"}]},
                  {"contributor":"ada","roles":[{"vocabulary":"credit","role":"software"}]}
                ]}"#,
            )],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_err();

    assert!(errors.iter().any(|error| {
        error.contains("posts/broken.credits.json") && error.contains("duplicate contributor `ada`")
    }));
}

#[test]
fn invalid_manual_orcid_cannot_enter_the_config_model() {
    let error = SiteConfig::from_json(
        r#"{"contributors":{"ada":{"name":"Ada","orcid":"0000-0002-1825-0098"}}}"#,
    )
    .unwrap_err();
    assert!(error.contains("contributors.ada.orcid"));
    assert!(error.contains("checksum"));
}

#[test]
fn executable_contributor_profile_urls_cannot_enter_the_config_model() {
    let error = SiteConfig::from_json(
        r#"{"contributors":{"ada":{"name":"Ada","url":"javascript:alert(1)"}}}"#,
    )
    .unwrap_err();
    assert!(error.contains("contributors.ada.url"));
    assert!(error.contains("HTTP(S) URL or a site-root path"));

    let config =
        SiteConfig::from_json(r#"{"contributors":{"ada":{"name":"Ada","url":"/people/ada/"}}}"#)
            .unwrap();
    assert_eq!(config.contributors["ada"].url, "/people/ada/");
}

#[test]
fn contributor_same_as_values_must_be_absolute_http_urls() {
    let error = SiteConfig::from_json(
        r#"{"contributors":{"ada":{"name":"Ada","sameAs":["javascript:alert(1)"]}}}"#,
    )
    .unwrap_err();
    assert!(error.contains("contributors.ada.sameAs"));

    let config = SiteConfig::from_json(
        r#"{"contributors":{"ada":{"name":"Ada","sameAs":[" https://example.test/ada "]}}}"#,
    )
    .unwrap();
    assert_eq!(
        config.contributors["ada"].same_as,
        vec!["https://example.test/ada"]
    );
}

#[test]
fn editable_config_cannot_claim_authenticated_orcid_provenance() {
    let error = SiteConfig::from_json(
        r#"{
          "contributors":{
            "ada":{
              "name":"Ada",
              "orcid":"0000-0002-1825-0097",
              "authenticated":true
            }
          }
        }"#,
    )
    .unwrap_err();
    assert!(error.contains("unknown field `authenticated`"));
}

#[test]
fn sidecar_validation_rejects_unknowns_duplicates_and_orphans() {
    let config = SiteConfig::from_json(
        r#"{"contributors":{"ada":{"name":"Ada"},"grace":{"name":"Grace"}}}"#,
    )
    .unwrap();
    let cases = [
        (
            r#"{"version":2,"credits":[]}"#,
            "unsupported credit file version 2",
        ),
        (
            r#"{"version":1,"credits":[{"contributor":"missing","roles":[{"vocabulary":"crossref","role":"author"}]}]}"#,
            "unknown contributor `missing`",
        ),
        (
            r#"{"version":1,"credits":[{"contributor":"ada","roles":[{"vocabulary":"crossref","role":"author"},{"vocabulary":"crossref","role":"author"}]}]}"#,
            "duplicate role `crossref:author`",
        ),
        (
            r#"{"version":1,"credits":[{"contributor":"ada","roles":[{"vocabulary":"crossref","role":"inventor"}]}]}"#,
            "unknown crossref role `inventor`",
        ),
        (
            r#"{"version":1,"credits":[{"contributor":"ada","roles":[{"vocabulary":"made-up","role":"author"}]}]}"#,
            "unknown variant `made-up`",
        ),
    ];
    for (contents, expected) in cases {
        let errors = Site::load(
            config.clone(),
            Sources {
                posts: vec![post("posts/check.md", "")],
                credits: vec![source("posts/check.credits.json", contents)],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap_err();
        assert!(
            errors
                .iter()
                .any(|error| error.contains("posts/check.credits.json")
                    && error.contains(expected)),
            "expected `{expected}` in {errors:?}"
        );
    }

    let errors = Site::load(
        config,
        Sources {
            credits: vec![source(
                "posts/orphan.credits.json",
                r#"{"version":1,"credits":[]}"#,
            )],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_err();
    assert!(errors[0].contains("has no matching Markdown post"));
}

#[test]
fn recipe_posts_use_the_same_profile_independent_resolver() {
    let config =
        SiteConfig::from_json(r#"{"contributors":{"cook":{"name":"Test Cook"}}}"#).unwrap();
    let site = Site::load(
        config,
        Sources {
            posts: vec![post("posts/recipe.md", "profile: recipe\n")],
            credits: vec![source(
                "posts/recipe.credits.json",
                r#"{"version":1,"credits":[{"contributor":"cook","roles":[{"vocabulary":"crossref","role":"author"}]}]}"#,
            )],
            ..Default::default()
        },
        LoadOptions {
            include_drafts: true,
            ..Default::default()
        },
    )
    .unwrap();

    assert!(site.posts[0].recipe.is_some());
    assert_eq!(
        site.posts[0].authors().next().unwrap().contributor.name,
        "Test Cook"
    );
}

#[test]
fn colliding_markdown_extensions_cannot_share_one_sidecar() {
    let config = SiteConfig::from_json(r#"{"contributors":{"ada":{"name":"Ada"}}}"#).unwrap();
    let errors = Site::load(
        config,
        Sources {
            posts: vec![
                post("posts/study.md", "slug: study-md\n"),
                post("posts/study.markdown", "slug: study-markdown\n"),
            ],
            credits: vec![source(
                "posts/study.credits.json",
                r#"{"version":1,"credits":[{"contributor":"ada","roles":[{"vocabulary":"crossref","role":"author"}]}]}"#,
            )],
            ..Default::default()
        },
        LoadOptions {
            include_drafts: true,
            ..Default::default()
        },
    )
    .unwrap_err();

    assert!(errors.iter().any(|error| {
        error.contains("posts/study.credits.json")
            && error.contains("ambiguous credit sidecar target")
            && error.contains("posts/study.md")
            && error.contains("posts/study.markdown")
    }));
    assert!(!errors
        .iter()
        .any(|error| error.contains("has no matching Markdown post")));

    let legacy_only = Site::load(
        SiteConfig::default(),
        Sources {
            posts: vec![
                post("posts/study.md", "slug: study-md\n"),
                post("posts/study.markdown", "slug: study-markdown\n"),
            ],
            ..Default::default()
        },
        LoadOptions {
            include_drafts: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(legacy_only.posts.len(), 2);
}

#[test]
fn malformed_posts_do_not_make_their_sidecars_look_orphaned() {
    let config = SiteConfig::default();
    let errors = Site::load(
        config,
        Sources {
            posts: vec![source(
                "posts/broken.md",
                "---\ntitle: Broken\ndate: not-a-date\n---\nBody",
            )],
            credits: vec![source(
                "posts/broken.credits.json",
                r#"{"version":1,"credits":[]}"#,
            )],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_err();

    assert!(errors
        .iter()
        .any(|error| { error.contains("posts/broken.md") && error.contains("unrecognised date") }));
    assert!(!errors
        .iter()
        .any(|error| error.contains("posts/broken.credits.json")));
    assert!(!errors
        .iter()
        .any(|error| error.contains("has no matching Markdown post")));
}

#[test]
fn manually_constructed_non_markdown_post_sources_return_an_error() {
    let errors = Site::load(
        SiteConfig::default(),
        Sources {
            posts: vec![source("posts/not-markdown.txt", "text")],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_err();

    assert!(errors[0].contains("must end in `.md` or `.markdown`"));
}

#[test]
fn single_post_helper_rejects_a_sidecar_owned_by_another_post() {
    let config = SiteConfig::from_json(r#"{"contributors":{"ada":{"name":"Ada"}}}"#).unwrap();
    let markdown = post("posts/first.md", "");
    let wrong_sidecar = source(
        "posts/second.credits.json",
        r#"{"version":1,"credits":[{"contributor":"ada","roles":[{"vocabulary":"crossref","role":"author"}]}]}"#,
    );

    let error = load_post_with_credits(
        &markdown,
        &config,
        RenderOptions::default(),
        Some(&wrong_sidecar),
    )
    .unwrap_err();
    assert!(error.contains("does not belong to `posts/first.md`"));
    assert!(error.contains("expected `posts/first.credits.json`"));
}
