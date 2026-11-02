//! Reading-path pages (ADR 0215, #78): a complete static ordered path, an
//! honest transition for every step, previous and next links, escaping of
//! hostile text, an index that follows `listed`, and no output at all when the
//! site publishes no paths.

use std::collections::BTreeMap;

use openblog_core::reading_path::{PublicPaths, PublishedTargets, ReadingPath};
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};
use serde_json::{json, Value};

const HOSTILE: &str = "<img src=x onerror=alert(1)>";
const PRIVATE: &str = "PRIVATE-PAGE-MARKER";

fn post(slug: &str, title: &str, extra: &str) -> SourceFile {
    SourceFile {
        path: format!("posts/{slug}.md"),
        contents: format!(
            "---\ntitle: {}\ndate: 2026-10-20\n{extra}---\nBody.",
            serde_json::to_string(title).unwrap()
        ),
    }
}

fn site() -> Site {
    let config = SiteConfig::from_json(
        r#"{"title": "Paths", "url": "https://example.com", "author": {"name": "Site Author"}}"#,
    )
    .unwrap();
    Site::load(
        config,
        Sources {
            posts: vec![
                post("cave", "The cave", ""),
                post("other", &format!("Other {HOSTILE}"), ""),
                post("third", "Third", ""),
                post("hidden", &format!("{PRIVATE} draft"), "draft: true\n"),
            ],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .expect("site")
}

fn step(id: &str, slug: &str) -> Value {
    json!({"id": id, "target": {"kind": "post", "slug": slug}})
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

fn with_paths(paths: &[(&str, ReadingPath)]) -> BTreeMap<String, String> {
    let mut site = site();
    let mut list = Vec::new();
    for (slug, path) in paths {
        let mut path = path.clone();
        path.slug = (*slug).to_string();
        list.push(path);
    }
    let targets = PublishedTargets::from_site(&site);
    site.reading_paths = Some(PublicPaths::resolve(&list, &targets).paths);
    build(&site)
}

fn build(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .expect("a build")
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

fn main_path() -> ReadingPath {
    let mut side = step("c", "third");
    side["optional"] = json!(true);
    side["difficulty"] = json!("advanced");
    side["rationale"] = json!("A side road.");
    side["prerequisites"] = json!("Some Greek.");
    let side = then(side, "contrasts-with", "It disagrees <b>loudly</b>.");
    path(
        "From the cave",
        true,
        json!([
            step("a", "cave"),
            then(
                step("b", "other"),
                "builds-on",
                "It takes the image further."
            ),
            side,
        ]),
    )
}

#[test]
fn a_site_without_paths_writes_nothing_about_them() {
    let files = build(&site());
    assert!(files.keys().all(|path| !path.starts_with("paths/")));
    assert!(files.values().all(|text| !text.contains("ob-reading-path")));
}

#[test]
fn a_path_page_is_a_complete_ordered_list_without_javascript() {
    let files = with_paths(&[("cave-route", main_path())]);
    let page = &files["paths/cave-route/index.html"];
    let one = page.find("id=\"step-1\"").unwrap();
    let two = page.find("id=\"step-2\"").unwrap();
    let three = page.find("id=\"step-3\"").unwrap();
    assert!(one < two && two < three);
    // Every step links to its target.
    assert!(page.contains("href=\"/posts/cave/\""));
    assert!(page.contains("href=\"/posts/other/\""));
    assert!(page.contains("href=\"/posts/third/\""));
    // Previous and next navigation, with the ends marked.
    assert!(page.contains("First step"));
    assert!(page.contains("End of the path"));
    assert!(page.contains("href=\"#step-3\" rel=\"next\""));
    assert!(page.contains("href=\"#step-1\" rel=\"prev\""));
    // The transition says exactly the relationship and the author's reason.
    assert!(page.contains("Builds on the step it follows"));
    assert!(page.contains("It takes the image further."));
    assert!(page.contains("Contrasts with the step it follows"));
    // The optional step says it can be skipped, and its notes are notes.
    assert!(page.contains("optional: you can skip it"));
    assert!(page.contains("a note, not a requirement"));
    assert!(
        page.contains("advanced (the author&#39;s judgement)")
            || page.contains("advanced (the author's judgement)")
    );
    // The component is loaded, as a module, by this page only.
    assert!(page.contains("/assets/components/ob-reading-path.js"));
    assert!(!files["index.html"].contains("ob-reading-path"));
    assert!(page.contains("<ob-reading-path data-slug=\"cave-route\">"));
}

#[test]
fn an_optional_step_does_not_move_what_the_next_step_follows() {
    let mut aside = then(step("b", "other"), "applies", "A worked example.");
    aside["optional"] = json!(true);
    let route = path(
        "Skippable",
        true,
        json!([
            step("a", "cave"),
            aside,
            then(step("c", "third"), "builds-on", "It builds on the first."),
        ]),
    );
    let files = with_paths(&[("skip", route)]);
    let page = &files["paths/skip/index.html"];
    let third = &page[page.find("id=\"step-3\"").unwrap()..];
    // Step 3 follows step 1, not the optional step 2, and says so.
    assert!(third.contains("(step <a href=\"#step-1\">1, The cave</a>)"));
}

#[test]
fn a_transition_never_says_more_than_the_author_wrote() {
    let route = path(
        "Just next",
        true,
        json!([
            step("a", "cave"),
            then(step("b", "other"), "next", "Simply the next read."),
        ]),
    );
    let files = with_paths(&[("plain", route)]);
    let page = &files["paths/plain/index.html"];
    assert!(page.contains("Comes next, with no further relationship claimed"));
    // Only the fixed note mentions influence, and only to deny it.
    assert_eq!(page.matches("nfluence").count(), 1);
    assert!(!page.contains("was influenced by"));
}

#[test]
fn hostile_text_is_escaped_everywhere() {
    let files = with_paths(&[("cave-route", main_path())]);
    let page = &files["paths/cave-route/index.html"];
    assert!(!page.contains(HOSTILE));
    assert!(!page.contains("<b>loudly</b>"));
    assert!(page.contains("&lt;b&gt;loudly&lt;/b&gt;"));
}

#[test]
fn drafts_and_private_text_never_reach_a_path_page_or_the_index() {
    let route = path(
        "With a draft",
        true,
        json!([
            step("a", "cave"),
            then(step("b", "other"), "next", "Next."),
            // A draft post at the end is left out whole, with no trace.
            then(step("c", "hidden"), "next", "Then the draft."),
        ]),
    );
    let files = with_paths(&[("draft-end", route)]);
    for (name, text) in &files {
        if name.starts_with("paths/") {
            assert!(!text.contains(PRIVATE), "{name}");
            assert!(!text.contains("/posts/hidden/"), "{name}");
            assert!(!text.contains("Then the draft."), "{name}");
        }
    }
    assert!(files["paths/draft-end/index.html"].contains("End of the path"));
    assert!(!files["paths/draft-end/index.html"].contains("id=\"step-3\""));
}

#[test]
fn the_index_and_sitemap_list_only_listed_paths() {
    let unlisted = path(
        "Quiet route",
        false,
        json!([step("a", "cave"), then(step("b", "other"), "next", "Next.")]),
    );
    let files = with_paths(&[("loud", main_path()), ("quiet", unlisted)]);
    let index = &files["paths/index.html"];
    assert!(index.contains("href=\"/paths/loud/\""));
    assert!(!index.contains("quiet"));
    assert!(!index.contains("Quiet route"));
    // The unlisted path is still published at its address.
    assert!(files.contains_key("paths/quiet/index.html"));
    let sitemap = &files["sitemap.xml"];
    assert!(sitemap.contains("https://example.com/paths/"));
    assert!(sitemap.contains("https://example.com/paths/loud/"));
    assert!(!sitemap.contains("/paths/quiet/"));
}

#[test]
fn only_unlisted_paths_write_no_index() {
    let unlisted = path(
        "Quiet route",
        false,
        json!([step("a", "cave"), then(step("b", "other"), "next", "Next.")]),
    );
    let files = with_paths(&[("quiet", unlisted)]);
    assert!(!files.contains_key("paths/index.html"));
    assert!(files.contains_key("paths/quiet/index.html"));
    assert!(!files["paths/quiet/index.html"].contains("href=\"/paths/\""));
    assert!(!files["sitemap.xml"].contains("/paths/"));
}

#[test]
fn the_same_paths_build_the_same_bytes() {
    let a = with_paths(&[("cave-route", main_path())]);
    let b = with_paths(&[("cave-route", main_path())]);
    assert_eq!(a, b);
}

#[test]
fn several_paths_each_get_their_own_page() {
    let second = path(
        "Second",
        true,
        json!([step("a", "third"), then(step("b", "cave"), "next", "Next.")]),
    );
    let files = with_paths(&[("one", main_path()), ("two", second)]);
    assert!(files.contains_key("paths/one/index.html"));
    assert!(files.contains_key("paths/two/index.html"));
    let index = &files["paths/index.html"];
    assert!(index.find("/paths/one/").unwrap() < index.find("/paths/two/").unwrap());
}
