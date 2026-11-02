use openblog_core::{
    generate, model,
    research::{normalize_doi_url, EvidenceCode, EvidenceOutcome},
    LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};

#[test]
fn unrelated_unicode_identifier_text_is_rejected_without_panicking() {
    assert_eq!(normalize_doi_url("ééééééééa"), None);
}

#[test]
fn doi_names_and_resolver_urls_are_canonicalized_without_losing_authored_percent_signs() {
    assert_eq!(
        normalize_doi_url("10.1234/foo%2Fbar").as_deref(),
        Some("https://doi.org/10.1234/foo%252Fbar")
    );
    assert_eq!(
        normalize_doi_url("https://doi.org/10.1234/foo%2Fbar").as_deref(),
        Some("https://doi.org/10.1234/foo%2Fbar")
    );
    assert_eq!(
        normalize_doi_url("doi:10.1234/foo%2Fbar").as_deref(),
        Some("https://doi.org/10.1234/foo%252Fbar")
    );
    assert_eq!(
        normalize_doi_url("https://doi.org/10.1234/work?download=1"),
        None
    );
    assert_eq!(
        normalize_doi_url("https://doi.org/10.1234/work#section"),
        None
    );
    assert_eq!(normalize_doi_url("https://doi.org/10.1234/work%"), None);
    assert_eq!(normalize_doi_url("https://doi.org/10.1234/work%2"), None);
}

fn load(contents: &str) -> openblog_core::Post {
    model::load_post(
        &SourceFile {
            path: "posts/study.md".into(),
            contents: contents.into(),
        },
        &SiteConfig::default(),
        Default::default(),
    )
    .unwrap()
}

#[test]
fn research_posts_normalize_authored_work_metadata_without_a_network_lookup() {
    let post = load(
        "---\ntitle: Study\ndate: 2026-10-23\nprofile: research\ndoi: 10.1234/café/results\nlicense: https://creativecommons.org/licenses/by/4.0/\n---\n## Abstract\nSummary.\n\n## References\n1. [Prior work](https://doi.org/10.1000/prior)",
    );

    let research = post.research.expect("research metadata");
    assert_eq!(research.doi.as_deref(), Some("10.1234/café/results"));
    assert_eq!(
        research.doi_url.as_deref(),
        Some("https://doi.org/10.1234/caf%C3%A9%2Fresults")
    );
    assert_eq!(
        research.license.as_deref(),
        Some("https://creativecommons.org/licenses/by/4.0/")
    );
}

#[test]
fn research_references_are_only_resolvable_links_in_the_bounded_reference_section() {
    let post = load(
        "---\ntitle: Study\ndate: 2026-10-23\nprofile: research\n---\n## Abstract\nSee [background](https://example.com/background).\n\n## References\n1. [Prior work](https://doi.org/10.1000/prior)\n2. [Dataset](https://data.example/set)\n3. A print-only source\n\n### Commentary\n[Still part of references](https://example.com/commentary)\n\n## Appendix\n[Not a reference](https://example.com/appendix)",
    );

    let references = post.research.expect("research metadata").references;
    assert_eq!(
        references
            .iter()
            .map(|reference| (reference.label.as_str(), reference.url.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("Prior work", "https://doi.org/10.1000/prior"),
            ("Dataset", "https://data.example/set"),
            ("Still part of references", "https://example.com/commentary"),
        ]
    );
}

#[test]
fn nested_reference_headings_do_not_define_document_sections() {
    let site = Site::load(
        SiteConfig::default(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/quoted.md".into(),
                contents: "---\ntitle: Quoted\ndate: 2026-10-23\nprofile: research\n---\n## Abstract\nSummary.\n\n> ## References\n> [Quoted source](https://example.com/quoted)\n\n[Ordinary link](https://example.com/body)"
                    .into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();

    let post = &site.posts[0];
    assert!(post.research.as_ref().unwrap().references.is_empty());
    assert!(site
        .evidence
        .iter()
        .any(|finding| finding.code == EvidenceCode::ReferencesMissing));
}

#[test]
fn research_evidence_findings_share_one_source_aware_site_contract() {
    let site = Site::load(
        SiteConfig::default(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/incomplete.md".into(),
                contents: "---\ntitle: Incomplete\ndate: 2026-10-23\nprofile: research\ndoi: definitely-not-a-doi\nlicense: https://\n---\nA claim with an unresolved note.[^missing]"
                    .into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();

    assert_eq!(
        site.evidence
            .iter()
            .map(|finding| finding.code)
            .collect::<Vec<_>>(),
        vec![
            EvidenceCode::DoiInvalid,
            EvidenceCode::LicenseUrlInvalid,
            EvidenceCode::AbstractMissing,
            EvidenceCode::ReferencesMissing,
            EvidenceCode::FootnoteUnresolved,
        ]
    );
    assert_eq!(site.evidence[0].source.field(), Some("doi"));
    assert_eq!(site.evidence[4].source.line(), Some(8));
}

#[test]
fn explicitly_empty_research_fields_are_reported_as_invalid() {
    let site = Site::load(
        SiteConfig::default(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/empty-fields.md".into(),
                contents: "---\ntitle: Empty fields\ndate: 2026-10-23\nprofile: research\ndoi:\nlicense:\n---\n## Abstract\nSummary.\n\n## References\n1. [Source](https://example.com/source)"
                    .into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();

    assert_eq!(
        site.evidence
            .iter()
            .map(|finding| finding.code)
            .collect::<Vec<_>>(),
        vec![EvidenceCode::DoiInvalid, EvidenceCode::LicenseUrlInvalid]
    );
}

#[test]
fn reference_guidance_distinguishes_review_work_from_non_preferred_doi_links() {
    let site = Site::load(
        SiteConfig::default(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/references.md".into(),
                contents: "---\ntitle: References\ndate: 2026-10-23\nprofile: research\n---\n## Abstract\nSummary.\n\n## References\n1. Print-only reference\n2. [Older DOI link](http://dx.doi.org/10.1000/old)\n3. [Preferred DOI link](https://doi.org/10.1000/current)"
                    .into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();

    assert_eq!(
        site.evidence
            .iter()
            .map(|finding| (finding.code, finding.outcome, finding.source.line()))
            .collect::<Vec<_>>(),
        vec![
            (
                EvidenceCode::ReferenceLinkReview,
                EvidenceOutcome::NeedsReview,
                Some(10),
            ),
            (
                EvidenceCode::DoiLinkNonPreferred,
                EvidenceOutcome::Potential,
                Some(11),
            ),
        ]
    );
    assert_eq!(site.evidence[1].source.column, Some(4));
}

#[test]
fn reference_review_covers_prose_and_nested_list_entries_with_precise_locations() {
    let site = Site::load(
        SiteConfig::default(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/reference-shapes.md".into(),
                contents: "---\ntitle: Reference shapes\ndate: 2026-10-23\nprofile: research\n---\n## Abstract\nSummary.\n\n## References\nSmith, A. Print source.\n\n1. Parent print source\n   - Nested print source"
                    .into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();

    assert_eq!(
        site.evidence
            .iter()
            .filter(|finding| finding.code == EvidenceCode::ReferenceLinkReview)
            .map(|finding| (finding.source.line, finding.source.column))
            .collect::<Vec<_>>(),
        vec![
            (Some(10), Some(1)),
            (Some(13), Some(4)),
            (Some(12), Some(1))
        ]
    );
}

#[test]
fn footnote_analysis_uses_markdown_events_instead_of_code_or_escaped_text() {
    let site = Site::load(
        SiteConfig::default(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/notes.md".into(),
                contents: "---\ntitle: Notes\ndate: 2026-10-23\nprofile: research\n---\n## Abstract\nSummary.[^missing]\n\n    [^missing]: not a definition\n\n```md\n[^fenced]\n```\n\n``[^inline]`` and \\[^escaped]\n\n## References\n1. [Source](https://example.com/source)"
                    .into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();

    let unresolved = site
        .evidence
        .iter()
        .filter(|finding| finding.code == EvidenceCode::FootnoteUnresolved)
        .collect::<Vec<_>>();
    assert_eq!(unresolved.len(), 1, "{unresolved:#?}");
    assert!(unresolved[0].message.contains("missing"));
}

#[test]
fn malformed_http_authorities_are_not_resolvable_urls() {
    for license in ["https://@", "https://.", "https://example.com:bad"] {
        let site = Site::load(
            SiteConfig::default(),
            Sources {
                posts: vec![SourceFile {
                    path: "posts/url.md".into(),
                    contents: format!(
                        "---\ntitle: URL\ndate: 2026-10-23\nprofile: research\nlicense: {license}\n---\n## Abstract\nSummary.\n\n## References\n1. [Malformed]({license})"
                    ),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();

        assert!(
            site.evidence
                .iter()
                .any(|finding| finding.code == EvidenceCode::LicenseUrlInvalid),
            "expected invalid license finding for {license}"
        );
        assert!(site.posts[0]
            .research
            .as_ref()
            .unwrap()
            .references
            .is_empty());
    }
}

#[test]
fn research_fields_do_not_change_article_or_recipe_output() {
    let build = |profile: &str, extra: &str, body: &str| {
        let site = Site::load(
            SiteConfig::from_json(r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/"}"#)
                .unwrap(),
            Sources {
                posts: vec![SourceFile {
                    path: "posts/work.md".into(),
                    contents: format!(
                        "---\ntitle: Work\ndate: 2026-10-23\nprofile: {profile}\n{extra}---\n{body}"
                    ),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        assert!(site.evidence.is_empty());
        generate(&site, &ThemeSet::new()).unwrap()
    };
    let research_fields =
        "doi: 10.1234/ignored\nlicense: https://creativecommons.org/licenses/by/4.0/\n";

    assert_eq!(
        build("article", "", "## Notes\nBody"),
        build("article", research_fields, "## Notes\nBody")
    );
    assert_eq!(
        build(
            "recipe",
            "",
            "## Ingredients\n- Water\n\n## Steps\n1. Simmer"
        ),
        build(
            "recipe",
            research_fields,
            "## Ingredients\n- Water\n\n## Steps\n1. Simmer"
        )
    );
}
