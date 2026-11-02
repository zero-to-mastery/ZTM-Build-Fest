//! The landing page on the home page (ADR 0245 to 0247, #324).
//!
//! The hard invariant: a site with no visible landing sections builds exactly
//! as it did before landing sections existed. The golden files in
//! `tests/fixtures/landing/` were captured from the build before the landing
//! renderer was written; set `OPENBLOG_BLESS=1` to rewrite them on purpose.

use std::collections::BTreeMap;
use std::path::PathBuf;

use openblog_core::landing::LandingPage;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};

fn config(extra: &str) -> SiteConfig {
    SiteConfig::from_json(&format!(
        r#"{{"title": "Landing Test", "url": "https://example.com", "author": {{"name": "Ada", "url": "https://example.com/about/"}},
            "postsPerPage": 2,
            "home": {{"heading": "Fresh writing", "intro": "Welcome to *the* blog.", "showSeries": true}}{extra}}}"#
    ))
    .unwrap()
}

fn post(slug: &str, day: u32, series: &str) -> SourceFile {
    let series = if series.is_empty() {
        String::new()
    } else {
        format!("series: {series}\n")
    };
    SourceFile {
        path: format!("posts/{slug}.md"),
        contents: format!(
            "---\ntitle: Post {slug}\ndate: 2026-10-{day:02}\n{series}---\nBody of {slug}.\n"
        ),
    }
}

fn sources(landing: Option<&str>) -> Sources {
    Sources {
        posts: vec![
            post("one", 1, "guide"),
            post("two", 2, "guide"),
            post("three", 3, ""),
            post("four", 4, ""),
            post("five", 5, ""),
        ],
        series: vec![SourceFile {
            path: "series/guide.md".into(),
            contents: "---\nname: The Guide\n---\nAbout.\n".into(),
        }],
        landing: landing.map(|contents| SourceFile {
            path: "content/landing.json".into(),
            contents: contents.into(),
        }),
        ..Default::default()
    }
}

fn load(config: SiteConfig, landing: Option<&str>) -> Site {
    Site::load(config, sources(landing), LoadOptions::default()).expect("site")
}

fn build(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .expect("generated")
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

fn page_file(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/landing")
        .join(name)
}

fn landing(sections: serde_json::Value) -> String {
    serde_json::json!({"format": "openblog-landing", "version": 1, "sections": sections})
        .to_string()
}

fn home(site: &Site) -> String {
    build(site)["index.html"].clone()
}

fn count(haystack: &str, needle: &str) -> usize {
    haystack.matches(needle).count()
}

// ----- the invariant -------------------------------------------------------

#[test]
fn a_site_with_no_landing_page_builds_exactly_as_it_did_before() {
    let files = build(&load(config(""), None));
    for (name, path) in [
        ("home.html", "index.html"),
        ("home-page-2.html", "page/2/index.html"),
        ("home-page-3.html", "page/3/index.html"),
    ] {
        let actual = &files[path];
        let golden = page_file(name);
        if std::env::var_os("OPENBLOG_BLESS").is_some() {
            std::fs::create_dir_all(golden.parent().unwrap()).unwrap();
            std::fs::write(&golden, actual).unwrap();
        }
        let expected = std::fs::read_to_string(&golden).expect("golden file");
        assert_eq!(actual, &expected.replace("\r\n", "\n"), "{path} changed");
    }
}

#[test]
fn no_visible_sections_means_the_same_bytes_whatever_the_file_holds() {
    let plain = build(&load(config(""), None));
    for file in [
        landing(serde_json::json!([])),
        landing(serde_json::json!([
            {"id": "a", "type": "series", "heading": "Series", "hidden": true},
            {"id": "b", "type": "rich-text", "markdown": "Hidden", "hidden": true}
        ])),
    ] {
        let with = build(&load(config(""), Some(&file)));
        assert_eq!(with, plain, "{file}");
    }
}

#[test]
fn a_missing_landing_page_or_an_unreadable_one_leaves_the_site_unchanged() {
    let plain = build(&load(config(""), None));
    for bad in [
        "{ not json",
        r#"{"format":"openblog-landing","version":3,"sections":[]}"#,
        r#"{"format":"openblog-landing","version":1,"sections":[{"id":"x","type":"html","markup":"<b>"}]}"#,
    ] {
        let site = load(config(""), Some(bad));
        assert!(
            site.warnings.iter().any(|w| w.contains("landing.json")),
            "{bad}: {:?}",
            site.warnings
        );
        assert_eq!(build(&site), plain, "{bad}");
    }
}

#[test]
fn the_legacy_layout_has_the_same_post_list_series_and_one_heading() {
    let legacy = home(&load(config(""), None));
    let page = LandingPage::from_legacy(&config("").home);
    let mapped = home(&load(config(""), Some(&page.to_canonical_json())));
    assert_eq!(count(&mapped, "<h1"), 1);
    assert_eq!(count(&legacy, "<h1"), 1);
    let list = |html: &str| {
        let start = html.find("<ul class=\"ob-list").expect("list");
        let end = start + html[start..].find("</ul>").unwrap();
        html[start..end].to_string()
    };
    assert_eq!(list(&mapped), list(&legacy), "the same post list");
    assert!(mapped.contains("Fresh writing"));
    assert!(mapped.contains("Welcome to <em>the</em> blog."));
    assert!(mapped.contains("The Guide"), "the series cards are there");
    // With the series hidden, as showSeries false does.
    let mut hidden = config("").home;
    hidden.show_series = false;
    let page = LandingPage::from_legacy(&hidden);
    let mapped = home(&load(config(""), Some(&page.to_canonical_json())));
    assert!(!mapped.contains("ob-series-list"));
}

// ----- sections ------------------------------------------------------------

#[test]
fn sections_render_in_order_and_hidden_ones_render_nothing() {
    let file = landing(serde_json::json!([
        {"id": "hello", "type": "welcome", "heading": "Hello there", "subheading": "Sub"},
        {"id": "secret", "type": "rich-text", "markdown": "HIDDEN-TEXT", "hidden": true},
        {"id": "text", "type": "rich-text", "markdown": "Middle text"},
        {"id": "latest", "type": "latest-posts", "heading": "Newest", "count": 2},
        {"id": "series", "type": "series", "heading": "All series"}
    ]));
    let html = home(&load(config(""), Some(&file)));
    let order: Vec<usize> = ["Hello there", "Middle text", "Newest", "All series"]
        .iter()
        .map(|needle| html.find(needle).unwrap_or_else(|| panic!("{needle}")))
        .collect();
    assert!(order.windows(2).all(|w| w[0] < w[1]), "{order:?}");
    assert!(!html.contains("HIDDEN-TEXT"));
    assert!(!html.contains("id=\"secret\"") && !html.contains("ob-home-secret"));
    // The count is honoured: the two newest posts only.
    assert!(html.contains("Post five") && html.contains("Post four"));
    assert!(!html.contains("Post three"));
}

#[test]
fn exactly_one_h1_and_headings_never_skip_a_level() {
    let cases = [
        // A welcome banner owns the h1.
        landing(serde_json::json!([
            {"id": "a", "type": "welcome", "heading": "Banner"},
            {"id": "b", "type": "rich-text", "markdown": "# Big\n\n#### Deep\n\ntext"},
            {"id": "c", "type": "latest-posts", "heading": "Latest"},
            {"id": "d", "type": "faq", "items": [{"question": "Why?", "answer": "# Because"}]},
            {"id": "e", "type": "callout", "title": "Note", "body": "## inside"},
            {"id": "f", "type": "opening-hours", "rows": [{"days": "Mon", "hours": "9"}]},
            {"id": "g", "type": "contact", "email": "a@b.co"}
        ])),
        // No welcome: the first section with a heading owns it.
        landing(serde_json::json!([
            {"id": "a", "type": "rich-text", "markdown": "### only text"},
            {"id": "c", "type": "latest-posts", "heading": "Latest"},
            {"id": "d", "type": "series", "heading": "S"}
        ])),
        // Nothing with a heading of its own: the site title.
        landing(serde_json::json!([
            {"id": "a", "type": "rich-text", "markdown": "just text"}
        ])),
    ];
    for file in cases {
        let html = home(&load(config(""), Some(&file)));
        assert_eq!(count(&html, "<h1"), 1, "{file}\n{html}");
        let levels: Vec<u8> = html
            .match_indices("<h")
            .filter_map(|(i, _)| {
                let rest = &html[i + 2..];
                let level = rest.as_bytes().first()?;
                (level.is_ascii_digit() && matches!(rest.as_bytes().get(1), Some(b' ' | b'>')))
                    .then(|| level - b'0')
            })
            .collect();
        let mut current = 0u8;
        for level in &levels {
            assert!(
                *level <= current + 1,
                "skipped a level in {levels:?}\n{html}"
            );
            current = *level;
        }
    }
}

#[test]
fn authored_markup_in_any_field_is_inert_text() {
    // Short enough for every field's bound, so the page is accepted whole.
    let evil = "<script>alert(1)</script><b onclick=x>";
    let evil_md =
        "<script>alert(1)</script><img src=x onerror=alert(1)><iframe src=//e.example></iframe>";
    let file = landing(serde_json::json!([
        {"id": "a", "type": "welcome", "heading": evil, "subheading": evil,
         "image": {"src": "/pic.png", "alt": evil}, "button": {"label": evil, "href": "/go/"}},
        {"id": "b", "type": "rich-text", "markdown": format!("{evil}\n\n[x](javascript:alert(1)) ![y](data:text/html,z)\n\n<div onclick=\"x\">d</div>")},
        {"id": "c", "type": "latest-posts", "heading": evil},
        {"id": "d", "type": "series", "heading": evil},
        {"id": "e", "type": "buttons", "items": [{"label": evil, "href": "https://example.com/?a=1&b=\"2\""}]},
        {"id": "f", "type": "image", "src": "/x.png", "alt": evil, "caption": evil},
        {"id": "g", "type": "video", "provider": "youtube", "video": "dQw4w9WgXcQ", "title": evil},
        {"id": "h", "type": "map", "provider": "openstreetmap", "label": evil, "lat": 1.5, "lon": 2.5},
        {"id": "i", "type": "opening-hours", "rows": [{"days": evil, "hours": evil}], "note": evil},
        {"id": "j", "type": "contact", "email": "a@b.co", "phone": "+1 555 0100", "address": evil},
        {"id": "k", "type": "social-links", "items": [{"label": evil, "href": "https://example.social/@me"}]},
        {"id": "l", "type": "faq", "items": [{"question": evil, "answer": evil_md}]},
        {"id": "m", "type": "callout", "title": evil, "body": evil_md},
        {"id": "n", "type": "featured-post", "post": "three", "heading": evil}
    ]));
    let site = load(config(""), Some(&file));
    assert!(site.landing.is_some(), "{:?}", site.warnings);
    let html = home(&site);
    // The page's own markup contains no script, frame or handler; only the
    // escaped text of what was typed.
    for forbidden in [
        "<script>alert",
        "<img src=x",
        "onerror=alert(1)>",
        "<div onclick",
        "<b onclick",
        "javascript:",
        "data:text/html",
    ] {
        assert!(!html.contains(forbidden), "{forbidden} survived");
    }
    assert!(
        html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
        "{html}"
    );
    assert_eq!(
        count(&html, "<script"),
        count(&build(&load(config(""), None))["index.html"], "<script")
    );
    // The only frames are the two the engine rebuilt from validated parts.
    assert_eq!(count(&html, "<iframe"), 2, "{html}");
    for frame in html.split("<iframe src=\"").skip(1) {
        let src = frame.split('"').next().unwrap();
        assert!(
            src.starts_with("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")
                || src.starts_with("https://www.openstreetmap.org/export/embed.html?bbox="),
            "{src}"
        );
    }
}

#[test]
fn every_image_is_emitted_with_its_alt_text() {
    let file = landing(serde_json::json!([
        {"id": "a", "type": "welcome", "heading": "H", "image": {"src": "/a.png", "alt": "A red door"}},
        {"id": "b", "type": "image", "src": "https://example.com/b.png", "alt": "A blue \"door\""}
    ]));
    let html = home(&load(config(""), Some(&file)));
    assert!(html.contains("alt=\"A red door\""));
    assert!(html.contains("alt=\"A blue &quot;door&quot;\""));
    assert_eq!(count(&html, "<img"), count(&html, " alt=\""));
}

#[test]
fn pager_pages_still_show_the_post_list_only() {
    let file = landing(serde_json::json!([
        {"id": "a", "type": "welcome", "heading": "Banner"},
        {"id": "b", "type": "rich-text", "markdown": "Landing text"},
        {"id": "c", "type": "latest-posts", "heading": "Latest", "count": 2}
    ]));
    let files = build(&load(config(""), Some(&file)));
    let plain = build(&load(config(""), None));
    for path in ["page/2/index.html", "page/3/index.html"] {
        assert_eq!(files[path], plain[path], "{path}");
        assert!(!files[path].contains("Landing text"));
    }
}

#[test]
fn featured_post_pieces_and_empty_lists_render_sensibly() {
    let file = landing(serde_json::json!([
        {"id": "a", "type": "featured-post", "post": "three", "heading": "Pick"},
        {"id": "b", "type": "featured-post", "post": "no-such-post"},
        {"id": "c", "type": "series", "heading": "Series"}
    ]));
    let site = load(config(""), Some(&file));
    assert!(
        site.warnings.iter().any(|w| w.contains("no-such-post")),
        "{:?}",
        site.warnings
    );
    let html = home(&site);
    assert!(html.contains("Pick") && html.contains("Post three") && html.contains("/three/"));
    assert!(!html.contains("no-such-post"));
    // A site with no posts and no series: the sections that list render a
    // quiet empty state or nothing, never an error.
    let empty = Site::load(
        config(""),
        Sources {
            landing: Some(SourceFile {
                path: "content/landing.json".into(),
                contents: landing(serde_json::json!([
                    {"id": "a", "type": "latest-posts", "heading": "Latest"},
                    {"id": "b", "type": "series", "heading": "Series"}
                ])),
            }),
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();
    let html = home(&empty);
    assert!(html.contains("Nothing here yet."));
    assert!(!html.contains("ob-series-list"));
}

#[test]
fn structured_pieces_render_as_semantic_markup() {
    let file = landing(serde_json::json!([
        {"id": "btn", "type": "buttons", "items": [{"label": "Mail me", "href": "mailto:me@example.com"}, {"label": "Docs", "href": "https://example.com/docs", "style": "secondary"}]},
        {"id": "vid", "type": "video", "provider": "vimeo", "video": "12345", "title": "A tour"},
        {"id": "map", "type": "map", "provider": "openstreetmap", "label": "The shop", "lat": 51.5, "lon": -0.12},
        {"id": "hrs", "type": "opening-hours", "rows": [{"days": "Mon to Fri", "hours": "9 to 5"}]},
        {"id": "con", "type": "contact", "email": "me@example.com", "phone": "+1 (555) 010-0100"},
        {"id": "soc", "type": "social-links", "items": [{"label": "Mastodon", "href": "https://example.social/@me"}]},
        {"id": "faq", "type": "faq", "items": [{"question": "Why?", "answer": "Because *so*."}]},
        {"id": "cal", "type": "callout", "tone": "warning", "body": "Careful"}
    ]));
    let html = home(&load(config(""), Some(&file)));
    for needle in [
        "href=\"mailto:me@example.com\"",
        "ob-home-button",
        "href=\"https://vimeo.com/12345\"",
        "<iframe src=\"https://player.vimeo.com/video/12345?dnt=1\" title=\"A tour\" loading=\"lazy\"",
        "https://www.openstreetmap.org/?mlat=51.500000&amp;mlon=-0.120000",
        "<table",
        "Mon to Fri",
        "href=\"tel:+15550100100\"",
        "rel=\"me noopener noreferrer\"",
        "<details",
        "<summary",
        "Because <em>so</em>.",
        "ob-home-callout-warning",
    ] {
        assert!(html.contains(needle), "{needle}\n{html}");
    }
    assert_eq!(count(&html, "loading=\"lazy\""), 2, "both frames are lazy");
    assert_eq!(count(&html, "<h1"), 1, "the site title owns the h1");
}

#[test]
fn frames_appear_only_for_video_and_map_sections_and_are_privacy_enhanced() {
    // A page with neither a video nor a map section has no frame at all.
    let plain = landing(serde_json::json!([
        {"id": "w", "type": "welcome", "heading": "Hello"},
        {"id": "r", "type": "rich-text", "markdown": "Some *text*"},
        {"id": "b", "type": "buttons", "items": [{"label": "Mail me", "href": "mailto:me@example.com"}]},
        {"id": "f", "type": "faq", "items": [{"question": "Why?", "answer": "Because."}]}
    ]));
    let html = home(&load(config(""), Some(&plain)));
    assert!(!html.contains("<iframe"), "{html}");
    // A video section's frame uses the no-cookie host, loads lazily and is titled.
    let video = landing(serde_json::json!([
        {"id": "v", "type": "video", "provider": "youtube", "video": "dQw4w9WgXcQ", "title": "A tour"}
    ]));
    let html = home(&load(config(""), Some(&video)));
    assert_eq!(count(&html, "<iframe"), 1, "{html}");
    let frame = html
        .split("<iframe ")
        .nth(1)
        .unwrap()
        .split('>')
        .next()
        .unwrap();
    assert!(
        frame.contains("src=\"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"),
        "{frame}"
    );
    assert!(frame.contains("loading=\"lazy\""), "{frame}");
    assert!(frame.contains("title=\"A tour\""), "{frame}");
    assert!(!html.contains("https://www.youtube.com/embed"), "{html}");
}

#[test]
fn the_pager_continues_a_latest_posts_list_that_ends_where_page_two_starts() {
    let full = landing(serde_json::json!([
        {"id": "c", "type": "latest-posts", "heading": "Latest"}
    ]));
    let html = home(&load(config(""), Some(&full)));
    assert!(html.contains("rel=\"next\""), "{html}");
    assert_eq!(count(&html, "ob-pager-status"), 1);
    // A shorter list would skip posts, so it offers no "older" link.
    let short = landing(serde_json::json!([
        {"id": "c", "type": "latest-posts", "heading": "Latest", "count": 1}
    ]));
    assert!(!home(&load(config(""), Some(&short))).contains("rel=\"next\""));
}

#[test]
fn a_short_first_list_links_to_the_archive_when_it_carries_no_pager() {
    let short = landing(serde_json::json!([
        {"id": "c", "type": "latest-posts", "heading": "Latest", "count": 1}
    ]));
    let html = home(&load(config(""), Some(&short)));
    assert_eq!(
        count(&html, "href=\"/archive/\">All posts</a>"),
        1,
        "{html}"
    );
    // A list that shows every post, or one that carries the pager, needs none.
    let all = landing(serde_json::json!([
        {"id": "c", "type": "latest-posts", "heading": "Latest", "count": 5}
    ]));
    assert!(!home(&load(config(""), Some(&all))).contains("All posts"));
    let full = landing(serde_json::json!([
        {"id": "c", "type": "latest-posts", "heading": "Latest"}
    ]));
    assert!(!home(&load(config(""), Some(&full))).contains("All posts"));
}

// ----- nothing leaves the home page (ADR 0263) ----------------------------------

#[test]
fn landing_text_reaches_only_the_home_page_never_feeds_search_or_other_files() {
    let marker = "LANDINGMARKERzq";
    let hostile = format!("{marker} <script>alert(1)</script>");
    // Fields this release does not know are kept in the file for a newer release and never drawn.
    let unknown = "UNKNOWNFIELDzq";
    let file = landing(serde_json::json!([
        {"id": "a", "type": "welcome", "heading": hostile, "subheading": hostile, "class": unknown, "style": unknown},
        {"id": "b", "type": "rich-text", "markdown": format!("{hostile}\n\n<img src=x onerror=alert(1)>")},
        {"id": "c", "type": "faq", "items": [{"question": hostile, "answer": hostile}]},
        {"id": "d", "type": "callout", "title": hostile, "body": hostile},
        {"id": "e", "type": "contact", "email": "a@b.co", "address": hostile}
    ]));
    let site = load(config(""), Some(&file));
    assert!(site.landing.is_some(), "{:?}", site.warnings);
    let files = build(&site);
    let holders: Vec<&str> = files
        .iter()
        .filter(|(_, contents)| contents.contains(marker))
        .map(|(path, _)| path.as_str())
        .collect();
    assert_eq!(
        holders,
        ["index.html"],
        "landing text is on the home page and nowhere else (feeds, search, sitemap, exports)"
    );
    for (path, contents) in &files {
        assert!(
            !contents.contains("<script>alert(1)") && !contents.contains("<img src=x"),
            "{path} holds authored markup"
        );
    }
    assert!(
        files.values().all(|contents| !contents.contains(unknown)),
        "an unknown field reached the output"
    );
    // The same site without the landing page has no trace of it either.
    let plain = build(&load(config(""), None));
    assert!(plain.values().all(|contents| !contents.contains(marker)));
}
