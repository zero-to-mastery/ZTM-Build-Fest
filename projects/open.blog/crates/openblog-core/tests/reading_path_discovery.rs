//! Reading-path discovery (ADR 0216, #79): links from posts and atlas pages,
//! search entries, `paths.json`, the feeds policy and the publication
//! manifest. Discovery follows `listed`, reads the public value only and never
//! changes the order of anything.

use std::collections::BTreeMap;

use openblog_core::atlas_publication::PublicAtlas;
use openblog_core::knowledge_atlas::{Atlas, Links};
use openblog_core::publication_boundary::{
    BoundaryInputs, BoundaryManifest, ItemKind, Projection, Switches,
};
use openblog_core::reading_path::{PublicPaths, PublishedTargets, ReadingPath};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};
use serde_json::{json, Value};

const HOSTILE: &str = "<img src=x onerror=alert(1)>";
const PRIVATE: &str = "PRIVATE-DISCOVERY-MARKER";

fn post(slug: &str, title: &str, date: &str, extra: &str) -> SourceFile {
    SourceFile {
        path: format!("posts/{slug}.md"),
        contents: format!(
            "---\ntitle: {}\ndate: {date}\n{extra}---\nBody.",
            serde_json::to_string(title).unwrap()
        ),
    }
}

fn public_atlas() -> PublicAtlas {
    let library = SourceLibrary::parse(
        &json!({"version": 1, "sources": [{"id": "book", "kind": "work", "title": "A book"}]})
            .to_string(),
        &BTreeMap::new(),
    )
    .unwrap();
    let notebook = Notebook::parse(
        &json!({"version": 1, "passages": [], "notes": []}).to_string(),
        &library,
    )
    .unwrap();
    let atlas = Atlas::parse(
        &json!({"version": 1,
            "entries": [
                {"id": "plato", "kind": "person", "label": "Plato", "visibility": "approved"},
                {"id": "stoics", "kind": "movement", "label": "The Stoics", "visibility": "approved"}],
            "relationships": []})
        .to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .unwrap();
    PublicAtlas::project(&atlas, &library).unwrap()
}

fn base_site() -> Site {
    let config = SiteConfig::from_json(
        r#"{"title": "Paths", "url": "https://example.com", "author": {"name": "Site Author"},
            "feeds": {"rss": true, "json": true, "sitemap": true, "llms": true}}"#,
    )
    .unwrap();
    let mut site = Site::load(
        config,
        Sources {
            posts: vec![
                post("cave", "The cave", "2026-10-20", ""),
                post("other", &format!("Other {HOSTILE}"), "2026-10-19", ""),
                post("third", "Third", "2026-10-18", ""),
                post("alone", "Alone", "2026-10-17", ""),
                post(
                    "hidden",
                    &format!("{PRIVATE} draft"),
                    "2026-10-16",
                    "draft: true\n",
                ),
            ],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .expect("site");
    site.atlas = Some(public_atlas());
    site
}

fn step(id: &str, kind: &str, key: &str, target: &str) -> Value {
    json!({"id": id, "target": {"kind": kind, key: target}})
}

fn then(mut value: Value, relationship: &str, why: &str) -> Value {
    value["transition"] = json!({"relationship": relationship, "why": why});
    value
}

fn path(title: &str, listed: bool, steps: Value) -> ReadingPath {
    ReadingPath::parse(
        "paths/p.json",
        &json!({"format": "openblog-reading-path", "version": 1, "title": title,
            "summary": "A short summary.", "status": "published", "listed": listed,
            "steps": steps})
        .to_string(),
    )
    .unwrap()
}

fn listed_path() -> ReadingPath {
    path(
        &format!("From the cave {HOSTILE}"),
        true,
        json!([
            step("a", "post", "slug", "cave"),
            then(
                step("b", "atlas", "id", "plato"),
                "background",
                "Who made the image."
            ),
            then(
                step("c", "post", "slug", "other"),
                "builds-on",
                "It goes further."
            ),
        ]),
    )
}

fn quiet_path() -> ReadingPath {
    path(
        "Quiet route",
        false,
        json!([
            step("a", "post", "slug", "third"),
            then(step("b", "post", "slug", "alone"), "next", "Next."),
        ]),
    )
}

fn attach(site: &mut Site, paths: &[(&str, ReadingPath)]) {
    let list: Vec<ReadingPath> = paths
        .iter()
        .map(|(slug, path)| {
            let mut path = path.clone();
            path.slug = (*slug).to_string();
            path
        })
        .collect();
    let targets = PublishedTargets::from_site(site);
    site.reading_paths = Some(PublicPaths::resolve(&list, &targets).paths);
}

fn build(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .expect("a build")
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

fn with_paths() -> BTreeMap<String, String> {
    let mut site = base_site();
    attach(
        &mut site,
        &[("cave-route", listed_path()), ("quiet", quiet_path())],
    );
    build(&site)
}

fn without_paths() -> BTreeMap<String, String> {
    build(&base_site())
}

#[test]
fn a_post_and_an_atlas_page_link_to_each_listed_path_they_are_a_step_of() {
    let files = with_paths();
    let cave = &files["posts/cave/index.html"];
    assert!(cave.contains("Part of a reading path"));
    assert!(cave.contains("href=\"/paths/cave-route/#step-1\""));
    assert!(cave.contains("step 1 of 3"));
    // Hostile text in a title is escaped, never markup.
    assert!(!cave.contains(HOSTILE) && cave.contains("&lt;img src=x onerror=alert(1)&gt;"));
    let other = &files["posts/other/index.html"];
    assert!(other.contains("/paths/cave-route/#step-3") && other.contains("step 3 of 3"));
    let plato = &files["atlas/plato/index.html"];
    assert!(plato.contains("/paths/cave-route/#step-2") && plato.contains("step 2 of 3"));
    // An atlas entry that no path names has no section.
    assert!(!files["atlas/stoics/index.html"].contains("Part of a reading path"));
}

#[test]
fn an_unlisted_path_is_published_but_never_advertised() {
    let files = with_paths();
    assert!(files.contains_key("paths/quiet/index.html"));
    for page in ["posts/third/index.html", "posts/alone/index.html"] {
        assert!(!files[page].contains("Part of a reading path"), "{page}");
        assert!(!files[page].contains("/paths/quiet/"), "{page}");
    }
    for discovery in [
        "search.json",
        "paths.json",
        "sitemap.xml",
        "paths/index.html",
    ] {
        assert!(!files[discovery].contains("quiet"), "{discovery}");
        assert!(!files[discovery].contains("Quiet route"), "{discovery}");
    }
}

#[test]
fn discovery_changes_no_order_and_no_page_outside_the_links() {
    let on = with_paths();
    let off = without_paths();
    // A post in no listed path is the very same page, so its neighbours,
    // series box and chronological navigation are untouched.
    for page in [
        "posts/third/index.html",
        "posts/alone/index.html",
        "index.html",
        "archive/index.html",
    ] {
        assert_eq!(on[page], off[page], "{page}");
    }
    // A post in a path differs only by the one added section.
    let strip = |html: &str| {
        let start = html.find("<section class=\"ob-in-paths\"").unwrap();
        let end = start + html[start..].find("</section>\n").unwrap() + "</section>\n".len();
        format!("{}{}", &html[..start], &html[end..])
    };
    assert_eq!(
        strip(&on["posts/cave/index.html"]),
        off["posts/cave/index.html"]
    );
    assert_eq!(
        strip(&on["atlas/plato/index.html"]),
        off["atlas/plato/index.html"]
    );
    // Search keeps every post entry first and in order.
    let posts = |files: &BTreeMap<String, String>| -> Vec<Value> {
        serde_json::from_str::<Value>(&files["search.json"]).unwrap()["entries"]
            .as_array()
            .unwrap()
            .clone()
    };
    let (on_entries, off_entries) = (posts(&on), posts(&off));
    assert_eq!(&on_entries[..off_entries.len()], &off_entries[..]);
    assert_eq!(on_entries.len(), off_entries.len() + 1);
}

#[test]
fn feeds_never_carry_a_path_and_are_the_same_with_or_without_paths() {
    let on = with_paths();
    let off = without_paths();
    for feed in [
        "rss.xml",
        "feed.json",
        "llms.txt",
        "llms-full.txt",
        "robots.txt",
    ] {
        assert_eq!(on[feed], off[feed], "{feed}");
    }
    // The sitemap lists the index and the listed path, not the unlisted one.
    let sitemap = &on["sitemap.xml"];
    assert!(sitemap.contains("/paths/cave-route/") && sitemap.contains("/paths/</loc>"));
    assert!(!sitemap.contains("/paths/quiet/"));
}

#[test]
fn search_finds_a_listed_path_from_public_words_only() {
    let files = with_paths();
    let index: Value = serde_json::from_str(&files["search.json"]).unwrap();
    let entry = index["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["url"] == "/paths/cave-route/")
        .expect("the listed path is in the index");
    assert_eq!(entry["description"], "A short summary.");
    assert!(entry["tags"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t == "reading path"));
    let text = entry["text"].as_str().unwrap();
    assert!(text.contains("who made the image.") && text.contains("it goes further."));
    assert!(!files["search.json"].contains(PRIVATE));
}

#[test]
fn paths_json_lists_only_listed_paths_deterministically_and_leaks_nothing() {
    let files = with_paths();
    let again = with_paths();
    assert_eq!(files["paths.json"], again["paths.json"]);
    let json = &files["paths.json"];
    assert!(!json.contains(PRIVATE) && !json.contains("quiet") && !json.contains("Quiet"));
    let value: Value = serde_json::from_str(json).unwrap();
    assert_eq!(value["format"], "openblog-reading-paths");
    assert_eq!(value["paths"].as_array().unwrap().len(), 1);
    let path = &value["paths"][0];
    assert_eq!(path["slug"], "cave-route");
    assert_eq!(path["url"], "/paths/cave-route/");
    // The author's step ids are not public, and `<` is escaped for embedding.
    assert!(path["steps"][0].get("id").is_none());
    assert!(!json.contains('<'));
    // Relationship semantics and rationale text are carried.
    assert_eq!(path["steps"][1]["transition"]["relationship"], "background");
    assert_eq!(path["steps"][1]["transition"]["why"], "Who made the image.");
}

#[test]
fn no_listed_path_means_no_data_file_no_index_and_no_search_entry() {
    let mut site = base_site();
    attach(&mut site, &[("quiet", quiet_path())]);
    let files = build(&site);
    assert!(!files.contains_key("paths.json"));
    assert!(!files.contains_key("paths/index.html"));
    assert_eq!(files["search.json"], without_paths()["search.json"]);
    let off = without_paths();
    assert!(!off.contains_key("paths.json"));
    assert_eq!(files["posts/cave/index.html"], off["posts/cave/index.html"]);
}

fn manifest(site: &Site, on: bool) -> BoundaryManifest {
    BoundaryManifest::site(&BoundaryInputs {
        switches: Switches {
            reading_paths: on,
            ..Switches::default()
        },
        posts: &site.posts,
        public_atlas: None,
        atlas_blocked: None,
        public_comparisons: None,
        public_paths: site.reading_paths.as_ref(),
        public_interpretations: site.interpretations.as_ref(),
        comparisons_blocked: None,
        claims_blocked: None,
        library: None,
        notebook: None,
        atlas: None,
        claims: None,
        alignments: None,
        stale_comparisons: None,
        acknowledgements: None,
        curation: None,
        unavailable: &[],
        author: "Site Author",
        base_path: "",
    })
}

#[test]
fn the_publication_manifest_names_each_published_path_and_is_absent_when_off() {
    let mut site = base_site();
    attach(
        &mut site,
        &[("cave-route", listed_path()), ("quiet", quiet_path())],
    );
    let on = manifest(&site, true);
    let ids = on.published_ids(Projection::ReadingPaths, ItemKind::Path);
    assert_eq!(ids.into_iter().collect::<Vec<_>>(), ["cave-route", "quiet"]);
    let json = serde_json::to_string(&on).unwrap();
    assert!(!json.contains(PRIVATE));
    assert!(json.contains("unlisted: its page only"));
    assert!(on.summary().unwrap().contains("2 reading paths"));
    // Off, the manifest has no such projection at all.
    let off = manifest(&site, false);
    assert!(off
        .published_ids(Projection::ReadingPaths, ItemKind::Path)
        .is_empty());
    assert!(!serde_json::to_string(&off)
        .unwrap()
        .contains("reading-paths"));
}
