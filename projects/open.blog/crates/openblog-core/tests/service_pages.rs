use openblog_core::{
    generate, LoadOptions, OutputFile, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};
use serde_json::Value;

const HARDWOOD: &str = "---\nid: hardwood-install\nname: Hardwood installation\nsummary: Solid oak or maple floors, nailed and finished on site.\nincludes:\n  - Removing the old floor\n  - Two coats of finish\npriceBand: 2k-10k\ntypicalTimeline: 2 to 4 days\nfaq:\n  - question: Can you match my existing floor?\n    answer: Usually, we bring samples.\n  - question: \"Is it </script><b>safe</b> & clean?\"\n    answer: Yes.\n---\nWe install hardwood floors.\n";
const TILE: &str = "---\nid: tile\nname: Tile\nsummary: Bathroom and kitchen tile.\n---\n";

fn file(path: &str, contents: &str) -> SourceFile {
    SourceFile {
        path: path.into(),
        contents: contents.into(),
    }
}

fn job(name: &str, date: &str, trade: &str, service: &str) -> SourceFile {
    file(
        &format!("posts/{name}.md"),
        &format!(
            "---\ntitle: {name}\ndate: {date}\nprofile: job\njob:\n  trade: {trade}\n  service: {service}\n  place:\n    town: Bend\n    region: OR\n  started: {date}\n  finished: {date}\n---\nDone.\n"
        ),
    )
}

fn build_with(config: &str, services: Vec<SourceFile>, posts: Vec<SourceFile>) -> Vec<OutputFile> {
    let site = Site::load(
        SiteConfig::from_json(config).unwrap(),
        Sources {
            services,
            posts,
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();
    generate(&site, &ThemeSet::new()).unwrap()
}

const CONFIG: &str = r#"{"title":"Crew","url":"https://crew.example","postPath":"/{slug}/"}"#;

fn build(services: Vec<SourceFile>, posts: Vec<SourceFile>) -> Vec<OutputFile> {
    build_with(CONFIG, services, posts)
}

fn find<'a>(files: &'a [OutputFile], path: &str) -> &'a str {
    &files
        .iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("{path} missing"))
        .contents
}

fn jobs() -> Vec<SourceFile> {
    vec![
        job("oak-floor", "2026-10-16", "flooring", "hardwood-install"),
        job("second-oak", "2026-10-02", "flooring", "hardwood-install"),
        job("deck", "2026-10-03", "flooring", "hardwood-install"),
        job("shower", "2026-10-12", "flooring", "tile"),
    ]
}

fn json_ld(page: &str) -> Value {
    let marker = "application/ld+json\">";
    let start = page.find(marker).expect("structured data") + marker.len();
    let end = start + page[start..].find("</script>").unwrap();
    serde_json::from_str(&page[start..end]).expect("valid JSON")
}

fn types(ld: &Value) -> Vec<&str> {
    ld["@graph"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| node["@type"].as_str().unwrap())
        .collect()
}

#[test]
fn a_site_without_services_has_no_service_output() {
    let files = build(vec![], jobs());
    assert!(files.iter().all(|file| !file.path.starts_with("services/")));
    for page in ["index.html", "jobs/index.html", "404.html"] {
        assert!(
            !find(&files, page).contains("/services/"),
            "{page} mentions services"
        );
    }
    assert!(!find(&files, "sitemap.xml").contains("/services/"));
    assert!(!find(&files, "llms.txt").contains("Services"));
}

#[test]
fn every_service_gets_a_page_and_the_index_lists_recent_jobs() {
    let files = build(
        vec![
            file("services/hardwood.md", HARDWOOD),
            file("services/tile.md", TILE),
        ],
        jobs(),
    );
    let index = find(&files, "services/index.html");
    assert!(
        index.contains("href=\"/services/hardwood-install/\"")
            && index.contains("href=\"/services/tile/\"")
    );
    assert!(index.contains("Price band: $2,000 to $10,000"));
    assert!(index.contains("Typical timeline: 2 to 4 days"));
    assert!(index.contains("href=\"/oak-floor/\"") && index.contains("href=\"/shower/\""));
    let hardwood_at = index.find("href=\"/services/hardwood-install/\"").unwrap();
    assert!(hardwood_at < index.find("href=\"/shower/\"").unwrap());

    let page = find(&files, "services/hardwood-install/index.html");
    assert!(
        page.contains("<h2>What is included</h2>") && page.contains("<li>Two coats of finish</li>")
    );
    assert!(page.contains("We install hardwood floors."));
    assert!(page.contains("Price band: $2,000 to $10,000"));
    assert!(page.contains("a guide, not a quote"));
    assert!(page.contains("Frequently asked questions"));
    assert!(page.contains("<h3>Can you match my existing floor?</h3>"));
    assert!(page.contains("href=\"/oak-floor/\"") && page.contains("href=\"/second-oak/\""));
    assert!(!page.contains("href=\"/shower/\""));
    assert!(page.contains("href=\"/jobs/flooring/hardwood-install/\""));
    assert!(page.contains("href=\"https://crew.example/services/hardwood-install/\""));

    let tile = find(&files, "services/tile/index.html");
    assert!(tile.contains("href=\"/shower/\""));
    assert!(!tile.contains("What is included"));
}

#[test]
fn structured_data_is_a_service_with_a_faq_page_only_when_there_are_questions() {
    let files = build(
        vec![
            file("services/hardwood.md", HARDWOOD),
            file("services/tile.md", TILE),
        ],
        vec![],
    );
    let ld = json_ld(find(&files, "services/hardwood-install/index.html"));
    assert_eq!(ld["@context"], "https://schema.org");
    assert_eq!(types(&ld), ["Service", "FAQPage"]);
    let service = &ld["@graph"][0];
    assert_eq!(service["name"], "Hardwood installation");
    assert_eq!(
        service["url"],
        "https://crew.example/services/hardwood-install/"
    );
    assert_eq!(service["provider"]["@type"], "Organization");
    assert_eq!(service["provider"]["name"], "Crew");
    assert_eq!(
        service["offers"]["description"],
        "Price band: $2,000 to $10,000"
    );
    assert_eq!(
        service["hasOfferCatalog"]["itemListElement"][1]["itemOffered"]["name"],
        "Two coats of finish"
    );
    let faq = &ld["@graph"][1];
    assert_eq!(faq["mainEntity"].as_array().unwrap().len(), 2);
    assert_eq!(faq["mainEntity"][0]["@type"], "Question");
    assert_eq!(faq["mainEntity"][0]["acceptedAnswer"]["@type"], "Answer");
    assert_eq!(
        faq["mainEntity"][0]["acceptedAnswer"]["text"],
        "Usually, we bring samples."
    );

    let tile_page = find(&files, "services/tile/index.html");
    assert_eq!(types(&json_ld(tile_page)), ["Service"]);
    assert!(!tile_page.contains("FAQPage") && !tile_page.contains("Frequently asked"));
}

#[test]
fn text_is_escaped_in_the_page_and_in_the_script() {
    let files = build(vec![file("services/hardwood.md", HARDWOOD)], vec![]);
    let page = find(&files, "services/hardwood-install/index.html");
    assert!(!page.contains("</script><b>"), "{page}");
    assert!(page.contains("&lt;/script&gt;&lt;b&gt;safe&lt;/b&gt; &amp; clean?"));
    let ld = json_ld(page);
    assert_eq!(
        ld["@graph"][1]["mainEntity"][1]["name"],
        "Is it </script><b>safe</b> & clean?"
    );
    let marker = "application/ld+json\">";
    let start = page.find(marker).unwrap() + marker.len();
    let end = start + page[start..].find("</script>").unwrap();
    let script = &page[start..end];
    assert!(!script.contains('<') && !script.contains('>') && !script.contains('&'));
}

#[test]
fn a_business_provider_is_the_local_business_node() {
    let config = r#"{"title":"Crew","url":"https://crew.example","postPath":"/{slug}/","business":{"version":1,"displayName":"Crew Floors","trade":"flooring","phone":"+13605550142"}}"#;
    let files = build_with(config, vec![file("services/hardwood.md", HARDWOOD)], vec![]);
    let ld = json_ld(find(&files, "services/hardwood-install/index.html"));
    let provider = &ld["@graph"][0]["provider"];
    assert_eq!(provider["@type"], "HomeAndConstructionBusiness");
    assert_eq!(provider["@id"], "https://crew.example/#business");
    assert_eq!(provider["name"], "Crew Floors");
}

#[test]
fn output_is_deterministic_and_independent_of_file_order() {
    let forward = build(
        vec![
            file("services/hardwood.md", HARDWOOD),
            file("services/tile.md", TILE),
        ],
        jobs(),
    );
    let again = build(
        vec![
            file("services/hardwood.md", HARDWOOD),
            file("services/tile.md", TILE),
        ],
        jobs(),
    );
    let reversed = build(
        vec![
            file("services/tile.md", TILE),
            file("services/hardwood.md", HARDWOOD),
        ],
        jobs(),
    );
    for (left, right) in forward.iter().zip(&again) {
        assert_eq!((&left.path, &left.contents), (&right.path, &right.contents));
    }
    for path in [
        "services/index.html",
        "services/hardwood-install/index.html",
        "sitemap.xml",
    ] {
        assert_eq!(find(&forward, path), find(&reversed, path), "{path}");
    }
}

#[test]
fn services_join_the_sitemap_navigation_and_llms_index() {
    let files = build(vec![file("services/hardwood.md", HARDWOOD)], vec![]);
    let sitemap = find(&files, "sitemap.xml");
    assert!(sitemap.contains("<loc>https://crew.example/services/</loc>"));
    assert!(sitemap.contains("<loc>https://crew.example/services/hardwood-install/</loc>"));
    let home = find(&files, "index.html");
    assert_eq!(home.matches("href=\"/services/\"").count(), 1, "{home}");
    assert!(find(&files, "llms.txt").contains("## Services"));

    let own_nav = r#"{"title":"Crew","url":"https://crew.example","nav":[{"label":"What we do","href":"/services/"}]}"#;
    let files = build_with(
        own_nav,
        vec![file("services/hardwood.md", HARDWOOD)],
        vec![],
    );
    let home = find(&files, "index.html");
    assert_eq!(
        home.matches("class=\"ob-nav-link\" href=\"/services/\"")
            .count(),
        1
    );
    assert!(home.contains("What we do") && !home.contains(">Services<"));
}

#[test]
fn changing_a_price_band_changes_the_page_and_the_structured_data() {
    let before = build(vec![file("services/hardwood.md", HARDWOOD)], vec![]);
    let after = build(
        vec![file(
            "services/hardwood.md",
            &HARDWOOD.replace("priceBand: 2k-10k", "priceBand: 10k-50k"),
        )],
        vec![],
    );
    let page = find(&after, "services/hardwood-install/index.html");
    assert!(page.contains("Price band: $10,000 to $50,000"));
    assert!(!page.contains("$2,000 to $10,000"));
    assert_eq!(
        json_ld(page)["@graph"][0]["offers"]["description"],
        "Price band: $10,000 to $50,000"
    );
    assert_ne!(
        find(&before, "services/index.html"),
        find(&after, "services/index.html")
    );
}

#[test]
fn services_reserve_their_address() {
    let site = Site::load(
        SiteConfig::from_json(CONFIG).unwrap(),
        Sources {
            services: vec![file("services/hardwood.md", HARDWOOD)],
            pages: vec![file("pages/services.md", "---\ntitle: Services\n---\nHi")],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();
    let error = generate(&site, &ThemeSet::new()).unwrap_err();
    assert!(error.contains("reserved"), "{error}");
}

#[test]
fn a_legacy_services_file_without_a_service_marker_changes_nothing() {
    let legacy = "---\ntitle: Old notes\n---\nKept from before services existed.\n";
    let mut with = Sources::default();
    assert!(!with.add(file("services/foo.md", legacy)));
    assert!(with.services.is_empty());
    let without = build(vec![], jobs());
    let legacy_build = build(vec![file("services/foo.md", legacy)], jobs());
    assert_eq!(without.len(), legacy_build.len());
    for (a, b) in without.iter().zip(&legacy_build) {
        assert_eq!((&a.path, &a.contents), (&b.path, &b.contents));
    }
    assert!(legacy_build
        .iter()
        .all(|f| !f.path.starts_with("services/")));
}
