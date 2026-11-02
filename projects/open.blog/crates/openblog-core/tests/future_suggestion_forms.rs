//! The suggestion region on published pages (#227, ADRs 0152 to 0157): only a post where the kind is
//! `open` under the one participation policy carries the region. With a hosted service it holds the
//! no-JavaScript text with the site's contact and the form's script; with none, a site that names a
//! contact still shows a static way to write to the author, and one that names none shows nothing.
//! A site that leaves the kind off, a locked or hidden post, feeds and portable files carry no region
//! and no script, and every page reads exactly as it did.

use std::collections::BTreeMap;

use openblog_core::participation::manifest;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};

const OPEN: &str = "---
title: Tides
date: 2026-10-01
---
The moon causes the tides.

## Methods

We measured the tides twice a day.
";
const LOCKED: &str = "---\ntitle: Locked\ndate: 2026-10-02\nparticipation:\n  - future-suggestion: locked\n---\nClosed text.\n";
const HIDDEN: &str = "---\ntitle: Hidden\ndate: 2026-10-03\nparticipation:\n  - future-suggestion: hidden\n---\nHidden text.\n";

const POSTS: &[(&str, &str)] = &[
    ("posts/tides.md", OPEN),
    ("posts/locked.md", LOCKED),
    ("posts/hidden.md", HIDDEN),
];

fn site(engagement: &str, participation: &str) -> Site {
    let config = SiteConfig::from_json(&format!(
        r#"{{"title":"T","url":"https://t.dev","postPath":"/{{slug}}/","author":{{"name":"A"}},"engagement":{engagement}{participation}}}"#
    ))
    .unwrap();
    let sources = Sources {
        posts: POSTS
            .iter()
            .map(|(path, contents)| SourceFile {
                path: (*path).into(),
                contents: (*contents).into(),
            })
            .collect(),
        ..Sources::default()
    };
    Site::load(config, sources, LoadOptions::default()).unwrap()
}

fn build(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

const HOSTED: &str = r#"{"enabled":true,"endpoint":"https://t.dev/api/","receipts":true,"feedbackContact":"mailto:author@t.dev"}"#;
const HOSTED_NO_RECEIPTS: &str = r#"{"enabled":true,"endpoint":"https://t.dev/api/"}"#;
const STATIC_CONTACT: &str = r#"{"feedbackContact":"https://t.dev/contact/"}"#;
const STATIC_NONE: &str = r#"{}"#;
const OPEN_KIND: &str = r#","participation":{"kinds":{"future-suggestion":"open"}}"#;
const SCRIPT: &str =
    "<script type=\"module\" src=\"/assets/components/ob-future-suggestion.js\"></script>\n";

fn region(page: &str) -> &str {
    let start = page
        .find("<section id=\"ob-future-suggestion\"")
        .expect("suggestion region");
    let end = start + page[start..].find("</section>\n").unwrap() + "</section>\n".len();
    &page[start..end]
}

#[test]
fn an_open_post_carries_the_region_its_static_path_and_the_script() {
    let files = build(&site(HOSTED, OPEN_KIND));
    let page = &files["tides/index.html"];
    assert_eq!(page.matches(SCRIPT).count(), 1);
    assert!(page.find(SCRIPT).unwrap() < page.find("</head>").unwrap());
    assert!(
        !page.contains("id=\"ob-passages\""),
        "a suggestion needs no passage data"
    );
    let region = region(page);
    assert!(region.contains("aria-labelledby=\"ob-future-suggestion-title\""));
    assert!(region
        .contains("<h2 id=\"ob-future-suggestion-title\">Suggest something for future work</h2>"));
    assert!(region.contains(
        "<ob-future-suggestion endpoint=\"https://t.dev/api\" page=\"https://t.dev/tides/\" work=\"/tides/\" contact=\"mailto:author@t.dev\" receipts>"
    ));
    // Without JavaScript: write to the author, with what to say.
    assert!(region.contains("<p class=\"ob-future-suggestion-static\">The form needs JavaScript."));
    assert!(region.contains("at <a href=\"mailto:author@t.dev\">author@t.dev</a>"));
    assert!(region.contains("whether you may be contacted about it"));
    // It says what acceptance means and that nothing is counted.
    assert!(region.contains("never to this page"));
    assert!(region.contains("not that they agree with it, have checked it or may use it"));
    assert!(region.contains("There are no votes and no counts."));
    // The region is after the article's prose, never inside it, and shows no one else's suggestions.
    assert!(
        page.find("ob-prose").unwrap() < page.find("<section id=\"ob-future-suggestion\"").unwrap()
    );
    assert!(!region.contains("<ul") && !region.contains("<ol"));
    // Without receipts the form still renders, and prepares the suggestion to copy.
    let without = build(&site(HOSTED_NO_RECEIPTS, OPEN_KIND));
    let region = self::region(&without["tides/index.html"]);
    assert!(region.contains("<ob-future-suggestion endpoint=\"https://t.dev/api\" page=\"https://t.dev/tides/\" work=\"/tides/\">"));
    assert!(!region.contains("receipts"));
    assert!(!region.contains("contact="));
}

#[test]
fn a_static_site_shows_its_contact_and_loads_nothing() {
    let files = build(&site(STATIC_CONTACT, OPEN_KIND));
    let page = &files["tides/index.html"];
    let region = region(page);
    assert!(!region.contains("<ob-future-suggestion"));
    assert!(region.contains("This site does not take suggestions through a form, but you can write your suggestion to the author through <a href=\"https://t.dev/contact/\">the contact page</a>"));
    assert!(
        !page.contains("ob-future-suggestion.js"),
        "no script on a static page"
    );
    assert!(!page.contains("/api"), "no endpoint is named");
    // The contact is the site's own, configured; with none there is nothing to show.
    let bare = build(&site(STATIC_NONE, OPEN_KIND));
    assert!(!bare["tides/index.html"].contains("ob-future-suggestion"));
    // A portable file never carries the form or its script.
    for (path, contents) in &files {
        if !path.ends_with("tides/index.html") {
            assert!(!contents.contains("ob-future-suggestion"), "{path}");
        }
    }
}

#[test]
fn locked_hidden_and_switched_off_posts_and_feeds_have_no_region() {
    let files = build(&site(HOSTED, OPEN_KIND));
    for page in ["locked/index.html", "hidden/index.html"] {
        assert!(!files[page].contains("ob-future-suggestion"), "{page}");
    }
    for (path, contents) in &files {
        if path.ends_with(".xml") || path.ends_with(".json") || path.ends_with(".txt") {
            assert!(
                !contents.contains("ob-future-suggestion-"),
                "{path}: no form in a feed or a portable file"
            );
        }
    }
    // Locked at the site: nothing is taken, so no form.
    let locked = build(&site(
        HOSTED,
        r#","participation":{"kinds":{"future-suggestion":"locked"}}"#,
    ));
    assert!(!locked["tides/index.html"].contains("ob-future-suggestion"));
}

#[test]
fn a_site_that_leaves_the_kind_off_is_byte_for_byte_what_it_was() {
    let off = build(&site(HOSTED, ""));
    let named_off = build(&site(
        HOSTED,
        r#","participation":{"kinds":{"future-suggestion":"off"}}"#,
    ));
    assert_eq!(off, named_off, "off is the default");
    for (path, contents) in &off {
        assert!(!contents.contains("ob-future-suggestion"), "{path}");
        assert!(!contents.contains("future-suggestion"), "{path}");
    }
    // Another kind open changes no page to carry this one.
    let question = build(&site(
        HOSTED,
        r#","participation":{"kinds":{"third-perspective":"open"}}"#,
    ));
    for (path, contents) in &question {
        assert!(!contents.contains("ob-future-suggestion"), "{path}");
    }
    // Building twice gives the same files.
    assert_eq!(
        build(&site(HOSTED, OPEN_KIND)),
        build(&site(HOSTED, OPEN_KIND))
    );
    // The static fallback with no contact and no transport leaves every page as it was.
    assert_eq!(
        build(&site(STATIC_NONE, OPEN_KIND)),
        build(&site(STATIC_NONE, ""))
    );
}

#[test]
fn the_manifest_names_the_kind_only_where_it_is_open() {
    let on = site(HOSTED, OPEN_KIND);
    let manifest: serde_json::Value = serde_json::from_str(&manifest(&on).unwrap()).unwrap();
    assert_eq!(manifest["/tides/"]["future-suggestion"], "open");
    assert!(manifest
        .get("/hidden/")
        .is_none_or(|post| post.get("future-suggestion").is_none()));
    assert_eq!(manifest["/locked/"]["future-suggestion"], "locked");
    // Off: no manifest at all, as before.
    assert!(openblog_core::participation::manifest(&site(HOSTED, "")).is_none());
    // The manifest holds modes and nothing a reader wrote.
    let text = serde_json::to_string(&manifest).unwrap();
    assert!(!text.contains("letters") && !text.contains("@"));
}
