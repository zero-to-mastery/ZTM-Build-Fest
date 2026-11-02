use openblog_core::{
    generate, LoadOptions, OutputFile, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};
use serde_json::Value;

const HARDWOOD: &str = "---\nid: hardwood-install\nname: Hardwood installation\nsummary: Solid oak floors, nailed and finished on site.\n---\nBody.\n";

fn file(path: &str, contents: &str) -> SourceFile {
    SourceFile {
        path: path.into(),
        contents: contents.into(),
    }
}

fn job(name: &str, date: &str, town: &str, region: &str) -> SourceFile {
    file(
        &format!("posts/{name}.md"),
        &format!(
            "---\ntitle: {name}\ndate: {date}\nprofile: job\njob:\n  trade: flooring\n  service: hardwood-install\n  place:\n    town: {town}\n    region: {region}\n    street: 44 Hidden Street\n  address: 44 Hidden Street\n  started: {date}\n  finished: {date}\n---\nDone at 44 Hidden Street.\n"
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

const BASE: &str = r#""title":"Crew","url":"https://crew.example","postPath":"/{slug}/""#;

fn config(extra: &str) -> String {
    if extra.is_empty() {
        format!("{{{BASE}}}")
    } else {
        format!("{{{BASE},{extra}}}")
    }
}

const AREAS: &str = r#""serviceAreas":[{"town":"Bend","region":"OR","note":"within 30 miles"},{"town":"Redmond","region":"Oregon"},{"town":"Sisters","region":"OR"}]"#;

fn posts() -> Vec<SourceFile> {
    vec![
        job("oak-floor", "2026-10-16", "Bend", "Oregon"),
        job("second-oak", "2026-10-02", "bend", "OR"),
        job("sisters-deck", "2026-10-03", "Sisters", "OR"),
        job("boise-floor", "2026-10-04", "Bend", "ID"),
    ]
}

fn find<'a>(files: &'a [OutputFile], path: &str) -> &'a str {
    &files
        .iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("{path} missing"))
        .contents
}

fn json_ld(page: &str) -> Value {
    let marker = "application/ld+json\">";
    let start = page.find(marker).expect("structured data") + marker.len();
    let end = start + page[start..].find("</script>").unwrap();
    serde_json::from_str(&page[start..end]).expect("valid JSON")
}

#[test]
fn without_areas_nothing_changes() {
    let plain = build_with(&config(""), vec![file("services/h.md", HARDWOOD)], posts());
    let empty = build_with(
        &config(r#""serviceAreas":{"version":1,"areas":[]}"#),
        vec![file("services/h.md", HARDWOOD)],
        posts(),
    );
    assert_eq!(plain.len(), empty.len());
    for (a, b) in plain.iter().zip(&empty) {
        assert_eq!((&a.path, &a.contents), (&b.path, &b.contents));
    }
    assert!(plain.iter().all(|file| !file.path.starts_with("areas/")));
    for page in ["index.html", "services/index.html", "404.html"] {
        assert!(!find(&plain, page).contains("/areas/"), "{page}");
    }
    assert!(!find(&plain, "sitemap.xml").contains("/areas/"));
    assert!(!find(&plain, "llms.txt").contains("Service areas"));
    assert!(!find(&plain, "index.html").contains("areaServed"));
}

#[test]
fn an_existing_page_called_areas_only_conflicts_once_areas_exist() {
    let page = file("pages/areas.md", "---\ntitle: Areas\n---\nOur areas.\n");
    let site = |config: &str| {
        Site::load(
            SiteConfig::from_json(config).unwrap(),
            Sources {
                pages: vec![page.clone()],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap()
    };
    assert!(generate(&site(&config("")), &ThemeSet::new()).is_ok());
    let error = generate(&site(&config(AREAS)), &ThemeSet::new()).unwrap_err();
    assert!(error.contains("reserved"), "{error}");
}

#[test]
fn every_area_gets_a_page_with_services_jobs_and_only_its_own_work() {
    let files = build_with(
        &config(AREAS),
        vec![file("services/h.md", HARDWOOD)],
        posts(),
    );
    let index = find(&files, "areas/index.html");
    for href in ["/areas/bend/", "/areas/redmond/", "/areas/sisters/"] {
        assert!(index.contains(&format!("href=\"{href}\"")), "{href}");
    }
    assert!(index.contains("within 30 miles"));
    assert!(index.contains("2 jobs posted") && index.contains("Work here is not yet posted"));

    let bend = find(&files, "areas/bend/index.html");
    assert!(bend.contains("Bend, OR"));
    assert!(bend.contains("within 30 miles"));
    assert!(bend.contains("href=\"/services/hardwood-install/\""));
    assert!(bend.contains("href=\"/oak-floor/\"") && bend.contains("href=\"/second-oak/\""));
    assert!(!bend.contains("sisters-deck") && !bend.contains("boise-floor"));
    assert!(bend.find("/oak-floor/").unwrap() < bend.find("/second-oak/").unwrap());
    assert!(!bend.contains("is not yet posted"));
    assert!(find(&files, "areas/sisters/index.html").contains("href=\"/sisters-deck/\""));
}

#[test]
fn an_area_without_jobs_says_so_plainly_and_keeps_its_services() {
    let files = build_with(
        &config(AREAS),
        vec![file("services/h.md", HARDWOOD)],
        posts(),
    );
    let redmond = find(&files, "areas/redmond/index.html");
    assert!(redmond.contains("Work in Redmond, OR is not yet posted."));
    assert!(redmond.contains("Hardwood installation"));
    assert!(!redmond.contains("Nothing here yet"));
    let none = build_with(&config(AREAS), vec![], vec![]);
    let bare = find(&none, "areas/redmond/index.html");
    assert!(bare.contains("is not yet posted") && !bare.contains(">Services we offer</h2>"));
}

#[test]
fn no_address_beyond_town_and_region_is_ever_published() {
    let files = build_with(
        &config(AREAS),
        vec![file("services/h.md", HARDWOOD)],
        posts(),
    );
    for file in files.iter().filter(|file| file.path.starts_with("areas/")) {
        assert!(
            !file.contents.contains("Hidden Street"),
            "{} shows an address",
            file.path
        );
    }
}

#[test]
fn the_business_block_and_area_served_come_from_configuration() {
    let business = r#""business":{"version":1,"displayName":"Crew Flooring","phone":"+15415550142","trade":"flooring"}"#;
    let files = build_with(
        &config(&format!("{business},{AREAS}")),
        vec![file("services/h.md", HARDWOOD)],
        posts(),
    );
    let bend = find(&files, "areas/bend/index.html");
    assert!(bend.contains("class=\"ob-area-business\"") && bend.contains("ob-business"));
    assert!(bend.contains("tel:+15415550142"));
    let ld = json_ld(bend);
    let node = &ld["@graph"][0];
    assert_eq!(node["@type"], "HomeAndConstructionBusiness");
    assert_eq!(node["name"], "Crew Flooring");
    assert_eq!(node["areaServed"]["@type"], "City");
    assert_eq!(node["areaServed"]["name"], "Bend");
    assert_eq!(node["areaServed"]["containedInPlace"]["name"], "Oregon");
    assert!(node.get("address").is_none());
    let home_page = find(&files, "index.html");
    let home = home_page
        .split("application/ld+json\">")
        .skip(1)
        .map(|chunk| {
            serde_json::from_str::<Value>(&chunk[..chunk.find("</script>").unwrap()]).unwrap()
        })
        .find(|ld| ld.get("areaServed").is_some())
        .expect("home page business data");
    let served = home["areaServed"].as_array().unwrap();
    let names: Vec<&str> = served.iter().map(|a| a["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Bend", "Redmond", "Sisters"]);
    let plain = build_with(&config(AREAS), vec![], vec![]);
    let org = &json_ld(find(&plain, "areas/bend/index.html"))["@graph"][0];
    assert_eq!(org["@type"], "Organization");
    assert_eq!(org["areaServed"]["name"], "Bend");
}

#[test]
fn text_is_escaped_in_the_page_and_the_structured_data() {
    let files = build_with(
        &config(
            r#""serviceAreas":[{"town":"Tom </script><b>&Co","region":"OR","note":"<i>near</i>"}]"#,
        ),
        vec![],
        vec![],
    );
    let page = files
        .iter()
        .find(|file| file.path.starts_with("areas/") && file.path != "areas/index.html")
        .unwrap();
    assert!(!page.contents.contains("<b>&Co") && !page.contents.contains("<i>near"));
    let marker = "application/ld+json\">";
    let start = page.contents.find(marker).unwrap() + marker.len();
    let end = start + page.contents[start..].find("</script>").unwrap();
    let raw = &page.contents[start..end];
    assert!(!raw.contains('<') && !raw.contains('>'), "{raw}");
    let ld: Value = serde_json::from_str(raw).unwrap();
    assert_eq!(ld["@graph"][0]["areaServed"]["name"], "Tom </script><b>&Co");
}

#[test]
fn discovery_hooks_list_the_index_and_every_area() {
    let files = build_with(&config(AREAS), vec![], posts());
    let sitemap = find(&files, "sitemap.xml");
    for url in [
        "/areas/",
        "/areas/bend/",
        "/areas/redmond/",
        "/areas/sisters/",
    ] {
        assert!(
            sitemap.contains(&format!("https://crew.example{url}")),
            "{url}"
        );
    }
    let llms = find(&files, "llms.txt");
    assert!(llms.contains("## Service areas") && llms.contains("https://crew.example/areas/bend/"));
    assert!(find(&files, "index.html").contains("href=\"/areas/\""));
    let own = build_with(
        &config(&format!(
            r#""nav":[{{"label":"Where","href":"/areas/"}}],{AREAS}"#
        )),
        vec![],
        vec![],
    );
    assert!(!find(&own, "index.html").contains(">Areas<"));
}

#[test]
fn the_same_list_builds_the_same_bytes_in_any_order() {
    let reversed = r#""serviceAreas":[{"town":"Sisters","region":"OR"},{"town":"Redmond","region":"Oregon"},{"town":"Bend","region":"OR","note":"within 30 miles"}]"#;
    let a = build_with(&config(AREAS), vec![], posts());
    let b = build_with(&config(reversed), vec![], posts());
    for (x, y) in a.iter().zip(&b) {
        assert_eq!((&x.path, &x.contents), (&y.path, &y.contents));
    }
}
