//! Continuation links on canonical pages (#231, ADRs 0218 to 0223): the
//! earlier page lists where a question went and the later page lists what it
//! continues, as plain links built from `continuations.json`. No script, no
//! count, no reader text. An edge to a page that is not published (a draft, a
//! post waiting for its date) is absent; a removed source takes its links with
//! it; a site without the file is what it was.

use std::collections::BTreeMap;

use openblog_core::continuation::{ContinuationsFile, CONTINUATIONS_ANCHOR, CONTINUATIONS_FILE};
use openblog_core::{
    generate, DateTime, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};
use serde_json::{json, Value};

const ORIGIN: &str = "00000000-0000-4000-8000-000000000001";
const OTHER: &str = "00000000-0000-4000-8000-000000000002";
const NOTE: &str = "The next episode returns to the neap tides.";

fn config() -> SiteConfig {
    SiteConfig::from_json(
        r#"{"title":"T","url":"https://t.dev","postPath":"/posts/{slug}/","author":{"name":"Ada"}}"#,
    )
    .unwrap()
}

fn post(name: &str, front: &str) -> SourceFile {
    SourceFile {
        path: format!("posts/{name}.md"),
        contents: format!("---\ntitle: {name}\n{front}---\nBody of {name}.\n"),
    }
}

fn posts() -> Vec<SourceFile> {
    vec![
        post("tides", "date: 2026-01-01\n"),
        post("neaps", "date: 2026-02-01\nseries: ocean\n"),
        post("springs", "date: 2026-03-01\nseries: ocean\n"),
        post("hidden", "date: 2026-04-01\ndraft: true\n"),
        post("future", "date: 2099-01-01\n"),
    ]
}

fn edge(id: &str, origin: &str, to: &str) -> Value {
    json!({
        "id": id, "kind": "question", "origin": origin,
        "from": "/posts/tides/", "to": to, "relation": "takes-up",
        "linked": "2026-10-27"
    })
}

fn file(items: Vec<Value>) -> String {
    let parsed = json!({ "version": 1, "items": items });
    // Through the canonical writer, as Admin writes it.
    ContinuationsFile::from_json(&parsed.to_string())
        .expect("fixture is valid")
        .to_json()
}

fn load(continuations: Option<String>) -> Site {
    Site::load(
        config(),
        Sources {
            posts: posts(),
            continuations: continuations.map(|contents| SourceFile {
                path: format!("content/{CONTINUATIONS_FILE}"),
                contents,
            }),
            ..Sources::default()
        },
        LoadOptions {
            now: DateTime::parse("2026-10-27T12:00:00Z"),
            ..LoadOptions::default()
        },
    )
    .unwrap()
}

fn build(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

fn page<'a>(files: &'a BTreeMap<String, String>, slug: &str) -> &'a str {
    files
        .get(&format!("posts/{slug}/index.html"))
        .unwrap_or_else(|| panic!("no page for {slug}: {:?}", files.keys().collect::<Vec<_>>()))
}

#[test]
fn both_ends_link_to_each_other_with_plain_html() {
    let mut item = edge("a", ORIGIN, "/posts/neaps/");
    item["note"] = json!(NOTE);
    let files = build(&load(Some(file(vec![item]))));
    let earlier = page(&files, "tides");
    let later = page(&files, "neaps");
    assert!(earlier.contains(&format!("id=\"{CONTINUATIONS_ANCHOR}\"")));
    assert!(earlier.contains("Where this question went"));
    assert!(earlier.contains("href=\"/posts/neaps/\""));
    assert!(earlier.contains(NOTE));
    assert!(later.contains(&format!("id=\"{CONTINUATIONS_ANCHOR}-earlier\"")));
    assert!(later.contains("Earlier questions this continues"));
    assert!(later.contains("href=\"/posts/tides/\""));
    assert!(later.contains("a reader&#39;s question") || later.contains("a reader's question"));
    // A labelled region of links; no script, form or count belongs to it.
    for html in [earlier, later] {
        let start = html.find("<section id=\"ob-continuations").unwrap();
        let end = start + html[start..].find("</section>").unwrap();
        let region = &html[start..end];
        assert!(region.contains("aria-labelledby"));
        for forbidden in ["<script", "<form", "<input", "<button", "subscribe"] {
            assert!(!region.contains(forbidden), "{forbidden} in {region}");
        }
    }
    // The page that is neither end shows nothing.
    assert!(!page(&files, "springs").contains("ob-continuations"));
}

#[test]
fn no_reader_text_or_origin_id_reaches_a_page() {
    let files = build(&load(Some(file(vec![edge("a", ORIGIN, "/posts/neaps/")]))));
    for (path, contents) in &files {
        assert!(!contents.contains(ORIGIN), "{path} carries the origin id");
    }
}

#[test]
fn a_site_without_the_file_is_what_it_was() {
    let without = build(&load(None));
    let empty = build(&load(Some(file(vec![]))));
    assert_eq!(without, empty);
    assert!(without
        .values()
        .all(|html| !html.contains("ob-continuations")));
}

#[test]
fn many_links_one_origin_and_a_duplicate_pair() {
    let files = build(&load(Some(file(vec![
        edge("a", ORIGIN, "/posts/neaps/"),
        edge("b", ORIGIN, "/posts/springs/"),
        edge("c", OTHER, "/posts/neaps/"),
    ]))));
    let earlier = page(&files, "tides");
    assert!(earlier.contains("/posts/neaps/") && earlier.contains("/posts/springs/"));
    assert_eq!(earlier.matches("<li id=\"ob-continuation-").count(), 3);
    // Item anchors are unique on the page.
    for id in [
        "ob-continuation-a",
        "ob-continuation-b",
        "ob-continuation-c",
    ] {
        assert_eq!(earlier.matches(&format!("id=\"{id}\"")).count(), 1);
    }
    // The same origin and page twice is refused when the file is read.
    let twice = json!({ "version": 1, "items": [
        edge("a", ORIGIN, "/posts/neaps/"), edge("b", ORIGIN, "/posts/neaps/")
    ]});
    assert!(ContinuationsFile::from_json(&twice.to_string()).is_err());
}

#[test]
fn a_draft_or_scheduled_target_shows_nothing_and_is_warned_about() {
    let site = load(Some(file(vec![
        edge("draft", ORIGIN, "/posts/hidden/"),
        edge("future", OTHER, "/posts/future/"),
    ])));
    let files = build(&site);
    assert!(!page(&files, "tides").contains("ob-continuations"));
    let warnings = site.warnings.join("\n");
    assert!(warnings.contains("continuation draft is not shown: to-not-published"));
    assert!(warnings.contains("continuation future is not shown: to-not-published"));
}

#[test]
fn a_link_returns_once_its_target_is_due() {
    let item = edge("future", ORIGIN, "/posts/future/");
    let before = build(&load(Some(file(vec![item.clone()]))));
    assert!(!page(&before, "tides").contains("/posts/future/"));
    let after = Site::load(
        config(),
        Sources {
            posts: posts(),
            continuations: Some(SourceFile {
                path: format!("content/{CONTINUATIONS_FILE}"),
                contents: file(vec![item]),
            }),
            ..Sources::default()
        },
        LoadOptions {
            now: DateTime::parse("2099-02-01T00:00:00Z"),
            ..LoadOptions::default()
        },
    )
    .unwrap();
    assert!(page(&build(&after), "tides").contains("href=\"/posts/future/\""));
}

#[test]
fn a_removed_source_takes_its_links_off_the_pages() {
    let mut parsed = ContinuationsFile::from_json(&file(vec![
        edge("a", ORIGIN, "/posts/neaps/"),
        edge("b", OTHER, "/posts/springs/"),
    ]))
    .unwrap();
    assert_eq!(parsed.forget_origin(ORIGIN), 1);
    let files = build(&load(Some(parsed.to_json())));
    let earlier = page(&files, "tides");
    assert!(!earlier.contains("ob-continuation-a"));
    assert!(earlier.contains("ob-continuation-b"));
    assert!(!page(&files, "neaps").contains("ob-continuations"));
}

#[test]
fn a_series_label_follows_the_target_and_an_unknown_one_keeps_the_link() {
    let mut known = edge("a", ORIGIN, "/posts/neaps/");
    known["series"] = json!("ocean");
    let mut unknown = edge("b", ORIGIN, "/posts/springs/");
    unknown["series"] = json!("renamed-away");
    let files = build(&load(Some(file(vec![known, unknown]))));
    let earlier = page(&files, "tides");
    assert!(earlier.contains("in the series ocean"));
    assert!(!earlier.contains("renamed-away"));
    assert!(earlier.contains("href=\"/posts/springs/\""));
}

#[test]
fn a_hostile_note_or_title_is_escaped() {
    let mut item = edge("a", ORIGIN, "/posts/neaps/");
    item["note"] = json!("See <b>this</b> & \"that\"");
    let site = Site::load(
        config(),
        Sources {
            posts: vec![
                post("tides", "date: 2026-01-01\n"),
                post("neaps", "date: 2026-02-01\n"),
            ],
            continuations: Some(SourceFile {
                path: format!("content/{CONTINUATIONS_FILE}"),
                contents: file(vec![item]),
            }),
            ..Sources::default()
        },
        LoadOptions::default(),
    )
    .unwrap();
    let files = build(&site);
    let earlier = page(&files, "tides");
    assert!(!earlier.contains("<b>this</b>"));
    assert!(earlier.contains("&lt;b&gt;this&lt;/b&gt;"));
}

#[test]
fn a_damaged_file_is_refused_naming_the_file_and_no_content() {
    let site = load(Some(
        "{\"version\":1,\"items\":[{\"id\":\"a\",\"secret\":\"x\"}]}".into(),
    ));
    let error = site.continuations_error.expect("refused");
    assert!(error.contains(CONTINUATIONS_FILE));
    assert!(!error.contains("secret"));
    let newer = load(Some("{\"version\":2,\"items\":[]}".into()));
    assert!(newer.continuations_error.is_some());
}

#[test]
fn feeds_search_llms_and_portable_copies_carry_nothing_of_the_links() {
    use openblog_core::portability::PortableProjection;
    let mut item = edge("a", ORIGIN, "/posts/neaps/");
    item["note"] = json!(NOTE);
    let site = load(Some(file(vec![item])));
    let files = build(&site);
    assert!(page(&files, "tides").contains(NOTE));
    // Only the two ends carry the region; every other generated file, the feeds, the search index
    // and the llms files among them, is silent about it.
    let mut checked = Vec::new();
    for (path, contents) in &files {
        if path == "posts/tides/index.html" || path == "posts/neaps/index.html" {
            continue;
        }
        checked.push(path.as_str());
        for private in [
            NOTE,
            ORIGIN,
            CONTINUATIONS_ANCHOR,
            "ob-continuation",
            "Where this question went",
            "Earlier questions this continues",
        ] {
            assert!(!contents.contains(private), "{private} in {path}");
        }
    }
    for expected in [
        "rss.xml",
        "feed.json",
        "search.json",
        "llms.txt",
        "llms-full.txt",
        "api/blog.json",
    ] {
        assert!(
            checked.contains(&expected),
            "{expected} not generated: {checked:?}"
        );
    }
    // The portable copies of both ends are the post itself.
    for post in site
        .posts
        .iter()
        .filter(|post| post.url == "/posts/tides/" || post.url == "/posts/neaps/")
    {
        let projection = PortableProjection::from_post(post, &site.config).unwrap();
        let html = projection.portable_html().unwrap().html;
        let markdown = projection.portable_markdown().unwrap();
        for copy in [html.as_str(), markdown.as_str()] {
            assert!(
                !copy.contains(NOTE) && !copy.contains("ob-continuation"),
                "{}",
                post.url
            );
            assert!(!copy.contains("Where this question went"), "{}", post.url);
            assert!(
                !copy.contains("Earlier questions this continues"),
                "{}",
                post.url
            );
        }
    }
    // Links change no file but the two pages.
    let without = build(&load(None));
    for (path, contents) in &files {
        if path != "posts/tides/index.html" && path != "posts/neaps/index.html" {
            assert_eq!(contents, &without[path], "{path} changed");
        }
    }
}

#[test]
fn reordering_a_series_keeps_the_link_and_its_label() {
    let mut known = edge("a", ORIGIN, "/posts/neaps/");
    known["series"] = json!("ocean");
    let contents = file(vec![known]);
    let reordered = |neaps: &str, springs: &str| {
        let site = Site::load(
            config(),
            Sources {
                posts: vec![
                    post("tides", "date: 2026-01-01\n"),
                    post("neaps", &format!("date: {neaps}\nseries: ocean\n")),
                    post("springs", &format!("date: {springs}\nseries: ocean\n")),
                ],
                continuations: Some(SourceFile {
                    path: format!("content/{CONTINUATIONS_FILE}"),
                    contents: contents.clone(),
                }),
                ..Sources::default()
            },
            LoadOptions {
                now: DateTime::parse("2026-10-27T12:00:00Z"),
                ..LoadOptions::default()
            },
        )
        .unwrap();
        assert!(site
            .warnings
            .iter()
            .all(|warning| !warning.contains("continuation")));
        build(&site)
    };
    // In order, and with the two posts' dates swapped so the series reads the other way round.
    for (neaps, springs) in [("2026-02-01", "2026-03-01"), ("2026-03-01", "2026-02-01")] {
        let files = reordered(neaps, springs);
        let earlier = page(&files, "tides");
        assert!(earlier.contains("href=\"/posts/neaps/\""), "{neaps}");
        assert!(earlier.contains("in the series ocean"), "{neaps}");
        assert!(
            page(&files, "neaps").contains("href=\"/posts/tides/\""),
            "{neaps}"
        );
        assert!(
            !page(&files, "springs").contains("ob-continuations"),
            "{neaps}"
        );
    }
}
