use openblog_core::job::CostBand;
use openblog_core::{LoadOptions, Site, SiteConfig, SourceFile, Sources};

const HARDWOOD: &str = "---\nversion: 1\nid: hardwood-install\nname: Hardwood installation\nsummary: Solid oak or maple floors, nailed and finished on site.\nincludes:\n  - Removing the old floor\n  - Two coats of finish\npriceBand: 2k-10k\ntypicalTimeline: 2 to 4 days\nfaq:\n  - question: Can you match my existing floor?\n    answer: \"Usually: we bring samples to compare.\"\n  - question: Do I have to move out?\n    answer: No.\nfuture: kept\n---\nWe install hardwood floors.\n";

fn file(path: &str, contents: &str) -> SourceFile {
    SourceFile {
        path: path.into(),
        contents: contents.into(),
    }
}

fn job(name: &str, service: &str, draft: bool) -> SourceFile {
    let draft = if draft { "draft: true\n" } else { "" };
    file(
        &format!("posts/{name}.md"),
        &format!(
            "---\ntitle: {name}\ndate: 2026-10-16\n{draft}profile: job\njob:\n  trade: flooring\n  service: {service}\n  place:\n    town: Bend\n    region: OR\n  started: 2026-10-14\n  finished: 2026-10-16\n---\nDone.\n"
        ),
    )
}

fn load(sources: Sources) -> Result<Site, Vec<String>> {
    let config = SiteConfig::from_json(r#"{"title":"Crew","url":"https://crew.example"}"#).unwrap();
    Site::load(config, sources, LoadOptions::default())
}

fn with_services(services: Vec<SourceFile>, posts: Vec<SourceFile>) -> Result<Site, Vec<String>> {
    load(Sources {
        services,
        posts,
        ..Default::default()
    })
}

#[test]
fn a_service_loads_with_every_field() {
    let site = with_services(vec![file("services/hardwood.md", HARDWOOD)], vec![]).unwrap();
    let service = &site.services[0];
    assert_eq!(service.id, "hardwood-install");
    assert_eq!(service.name, "Hardwood installation");
    assert_eq!(
        service.includes,
        ["Removing the old floor", "Two coats of finish"]
    );
    assert_eq!(service.price_band, Some(CostBand::From2kTo10k));
    assert_eq!(service.typical_timeline.as_deref(), Some("2 to 4 days"));
    assert_eq!(service.faq.len(), 2);
    assert_eq!(
        service.faq[0].answer,
        "Usually: we bring samples to compare."
    );
    assert_eq!(service.url, "/services/hardwood-install/");
    assert!(service.html.contains("We install hardwood floors."));
}

#[test]
fn the_price_band_is_the_jobs_cost_band_enum() {
    let site = with_services(
        vec![file(
            "services/a.md",
            "---\nid: a\nname: A\nsummary: S\npriceBand: ask\n---\n",
        )],
        vec![],
    )
    .unwrap();
    assert_eq!(site.services[0].price_band, Some(CostBand::Ask));
    let errors = with_services(
        vec![file(
            "services/a.md",
            "---\nid: a\nname: A\nsummary: S\npriceBand: cheap\n---\n",
        )],
        vec![],
    )
    .unwrap_err();
    let band_list = CostBand::ALL.map(CostBand::as_str).join(", ");
    assert!(
        errors[0].contains("priceBand: `cheap` is not a price band")
            && errors[0].contains(&band_list),
        "{errors:?}"
    );
}

#[test]
fn every_problem_is_listed_at_once_naming_the_field() {
    let errors = with_services(
        vec![file(
            "services/bad.md",
            "---\nversion: 2\nid: Not An Id\nsummary: S\nincludes: [x]\ntypicalTimeline: ok\nfaq:\n  - question: Only a question\n  - question: Q\n    answer: A\n---\n",
        )],
        vec![],
    )
    .unwrap_err();
    let all = errors.join("\n");
    assert!(all.starts_with("services/bad.md: "), "{all}");
    for expected in [
        "version: `2`",
        "id: `Not An Id` is not a service id",
        "name: add the service's name",
        "faq entry 1: add an answer",
    ] {
        assert!(all.contains(expected), "{expected} in {all}");
    }
    assert!(!all.contains("faq entry 2"), "{all}");
}

#[test]
fn an_empty_or_malformed_faq_is_refused_with_a_hint() {
    let errors = with_services(
        vec![file(
            "services/a.md",
            "---\nid: a\nname: A\nsummary: S\nfaq:\n  - just text\n---\n",
        )],
        vec![],
    )
    .unwrap_err();
    assert!(errors[0].contains("faq: write each entry as"), "{errors:?}");
    let site = with_services(
        vec![file(
            "services/a.md",
            "---\nid: a\nname: A\nsummary: S\n---\n",
        )],
        vec![],
    )
    .unwrap();
    assert!(site.services[0].faq.is_empty());
}

#[test]
fn ids_are_unique() {
    let errors = with_services(
        vec![
            file("services/a.md", HARDWOOD),
            file("services/b.md", HARDWOOD),
        ],
        vec![],
    )
    .unwrap_err();
    assert_eq!(
        errors,
        ["services/b.md: duplicate service id `hardwood-install` (also in services/a.md)"]
    );
}

#[test]
fn a_job_naming_an_unknown_service_fails_listing_the_known_ids() {
    let tile = "---\nid: tile\nname: Tile\nsummary: S\n---\n";
    let errors = with_services(
        vec![
            file("services/hardwood.md", HARDWOOD),
            file("services/tile.md", tile),
        ],
        vec![job("oak", "hardwod-install", false)],
    )
    .unwrap_err();
    assert_eq!(
        errors,
        ["posts/oak.md: job.service: `hardwod-install` is not one of this site's services; known service ids are hardwood-install, tile"]
    );
    let site = with_services(
        vec![
            file("services/hardwood.md", HARDWOOD),
            file("services/tile.md", tile),
        ],
        vec![job("oak", "hardwood-install", false)],
    )
    .unwrap();
    assert_eq!(site.posts.len(), 1);
}

#[test]
fn a_draft_job_with_an_unknown_service_is_only_a_warning() {
    let config = SiteConfig::from_json(r#"{"title":"Crew","url":"https://crew.example"}"#).unwrap();
    let site = Site::load(
        config,
        Sources {
            services: vec![file("services/hardwood.md", HARDWOOD)],
            posts: vec![job("oak", "nope", true)],
            ..Default::default()
        },
        LoadOptions {
            include_drafts: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        site.warnings.iter().any(|warning| warning
            .contains("job not ready to publish: job.service: `nope`")
            && warning.contains("hardwood-install")),
        "{:?}",
        site.warnings
    );
}

#[test]
fn a_site_without_services_checks_no_job_service() {
    let site = with_services(vec![], vec![job("oak", "anything-goes", false)]).unwrap();
    assert_eq!(site.posts.len(), 1);
    assert!(site.services.is_empty());
    assert!(site
        .warnings
        .iter()
        .all(|warning| !warning.contains("service")));
}

#[test]
fn a_draft_service_is_unpublished_and_only_warns_while_unfinished() {
    let unfinished = "---\nid: gutters\nname: Gutters\nsummary: \"\"\ndraft: true\n---\n";
    let finished_draft = "---\nid: decks\nname: Decks\nsummary: Built to last.\ndraft: true\n---\n";
    let live = with_services(
        vec![
            file("services/hardwood.md", HARDWOOD),
            file("services/gutters.md", unfinished),
            file("services/decks.md", finished_draft),
        ],
        vec![job("oak", "decks", false)],
    )
    .unwrap_err();
    assert!(
        live[0].contains("`decks` is not one of this site's services")
            && live[0].ends_with("known service ids are hardwood-install"),
        "{live:?}"
    );

    let config = SiteConfig::from_json(r#"{"title":"Crew","url":"https://crew.example"}"#).unwrap();
    let sources = Sources {
        services: vec![
            file("services/hardwood.md", HARDWOOD),
            file("services/gutters.md", unfinished),
            file("services/decks.md", finished_draft),
        ],
        ..Default::default()
    };
    let published = Site::load(config.clone(), sources.clone(), LoadOptions::default()).unwrap();
    assert_eq!(published.services.len(), 1);
    assert!(published
        .warnings
        .iter()
        .any(|warning| warning
            .contains("services/gutters.md: service not ready to publish: summary:")));
    let preview = Site::load(
        config,
        sources,
        LoadOptions {
            include_drafts: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(preview.services.len(), 2);
    assert!(preview
        .services
        .iter()
        .any(|service| service.id == "decks" && service.draft));
}

#[test]
fn a_file_that_declares_a_service_marker_but_is_invalid_still_fails_the_build() {
    for body in [
        "---\nversion: 1\ntitle: Old\n---\n",
        "---\nid: Bad Id\n---\n",
    ] {
        let errors = with_services(vec![file("services/foo.md", body)], vec![]).unwrap_err();
        assert!(
            errors.iter().any(|e| e.starts_with("services/foo.md:")),
            "{errors:?}"
        );
    }
    let legacy = "---\ntitle: Old\n---\nHello\n";
    let site = with_services(vec![file("services/foo.md", legacy)], vec![]).unwrap();
    assert!(site.services.is_empty());
}
