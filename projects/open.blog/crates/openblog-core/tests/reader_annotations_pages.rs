//! Reader highlights and private notes on published pages (#85, ADR 0241): only a site that opts in
//! gives its posts the annotation region with its no-JavaScript text, the build's passage text as
//! page data, and the script. No annotation, note or reader identity is ever in a built file, and a
//! site that does not opt in is byte-for-byte what it was.

use std::collections::BTreeMap;

use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};

const POST: &str = "---
title: Tides
date: 2026-10-01
---
The moon causes the tides.

## Methods

We measured the tides twice a day.
";
const DRAFT: &str =
    "---\ntitle: Secret draft\ndate: 2026-10-02\ndraft: true\n---\nPrivate wording.\n";

fn config(extra: &str) -> String {
    format!(
        r#"{{"title":"T","url":"https://t.dev","postPath":"/{{slug}}/","author":{{"name":"A"}}{extra}}}"#
    )
}

fn build(config_json: &str) -> BTreeMap<String, String> {
    let config = SiteConfig::from_json(config_json).unwrap();
    let sources = Sources {
        posts: [("posts/tides.md", POST), ("posts/secret.md", DRAFT)]
            .iter()
            .map(|(path, contents)| SourceFile {
                path: (*path).into(),
                contents: (*contents).into(),
            })
            .collect(),
        ..Sources::default()
    };
    let site = Site::load(config, sources, LoadOptions::default()).unwrap();
    generate(&site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

const ON: &str = r#","readerAnnotations":{"enabled":true}"#;
const SCRIPT: &str =
    "<script type=\"module\" src=\"/assets/components/ob-annotations.js\"></script>";

#[test]
fn an_opted_in_post_carries_the_region_the_passage_text_and_the_script() {
    let files = build(&config(ON));
    let page = &files["tides/index.html"];
    assert_eq!(page.matches("<ob-annotations>").count(), 1);
    assert_eq!(page.matches(SCRIPT).count(), 1);
    assert_eq!(page.matches("id=\"ob-passages\"").count(), 1);
    assert!(page.contains("aria-labelledby=\"ob-annotations-title\""));
    assert!(page.contains("<h2 id=\"ob-annotations-title\">Your highlights and notes</h2>"));
    // The no-JavaScript text says what it needs and that nothing leaves the browser.
    assert!(page.contains("need JavaScript"));
    assert!(page.contains("nothing is sent to anyone"));
    // The script and the data are in the head, the region in the article.
    assert!(page.find(SCRIPT).unwrap() < page.find("</head>").unwrap());
    assert!(page.find("id=\"ob-passages\"").unwrap() < page.find("</head>").unwrap());
    assert!(page.find("<ob-annotations>").unwrap() > page.find("</head>").unwrap());
}

#[test]
fn an_opted_in_post_also_carries_the_trail_region_with_its_disclosure_and_script() {
    let files = build(&config(ON));
    let page = &files["tides/index.html"];
    let trail_script =
        "<script type=\"module\" src=\"/assets/components/ob-reading-trail.js\"></script>";
    assert_eq!(page.matches("<ob-reading-trail>").count(), 1);
    assert_eq!(page.matches(trail_script).count(), 1);
    assert!(page.contains("aria-labelledby=\"ob-reading-trail-title\""));
    assert!(page
        .contains("<h2 id=\"ob-reading-trail-title\">Your reading trails and saved sources</h2>"));
    // The no-JavaScript text says what it needs, that nothing is recorded as a reader reads,
    // and that nothing leaves the browser.
    assert!(page.contains("need JavaScript"));
    assert!(page.contains("Nothing is recorded as you read"));
    assert!(page.contains("stays in this browser only"));
    // Beside the highlights, after them, and its script is in the head.
    assert!(page.find("<ob-annotations>").unwrap() < page.find("<ob-reading-trail>").unwrap());
    assert!(page.find(trail_script).unwrap() < page.find("</head>").unwrap());
}

#[test]
fn an_opted_in_post_carries_the_reading_history_region_between_notes_and_trails() {
    let files = build(&config(ON));
    let page = &files["tides/index.html"];
    let script =
        "<script type=\"module\" src=\"/assets/components/ob-reflection-history.js\"></script>";
    assert_eq!(page.matches("<ob-reflection-history>").count(), 1);
    assert_eq!(page.matches(script).count(), 1);
    assert!(page.contains("aria-labelledby=\"ob-reflection-history-title\""));
    assert!(page.contains("<h2 id=\"ob-reflection-history-title\">Your readings over time</h2>"));
    // The no-JavaScript text says what it needs and that nothing leaves the browser.
    assert!(page.contains("needs JavaScript"));
    assert!(page.contains("Readings stay in this browser only"));
    assert!(page.find("<ob-annotations>").unwrap() < page.find("<ob-reflection-history>").unwrap());
    assert!(
        page.find("<ob-reflection-history>").unwrap() < page.find("<ob-reading-trail>").unwrap()
    );
    assert!(page.find(script).unwrap() < page.find("</head>").unwrap());
}

#[test]
fn a_site_that_does_not_opt_in_has_no_reading_history_region_or_script() {
    let page = &build(&config(""))["tides/index.html"];
    assert!(!page.contains("ob-reflection-history"));
}

#[test]
fn a_site_that_does_not_opt_in_has_no_trail_region_or_script() {
    let page = &build(&config(""))["tides/index.html"];
    assert!(!page.contains("ob-reading-trail"));
}

#[test]
fn it_does_not_load_the_feedback_form_or_name_a_reader() {
    let files = build(&config(ON));
    let page = &files["tides/index.html"];
    assert!(!page.contains("ob-passage-feedback"));
    // The passage text is the published post's, and nothing private is on any page.
    for (path, contents) in &files {
        assert!(
            !contents.contains("Private wording"),
            "{path} holds a draft"
        );
    }
}

#[test]
fn it_shares_the_passage_data_with_the_feedback_form_once() {
    let files = build(&config(&format!(
        r#"{ON},"engagement":{{"enabled":true,"feedback":true,"endpoint":"https://t.dev/api/"}}"#
    )));
    let page = &files["tides/index.html"];
    assert_eq!(page.matches("id=\"ob-passages\"").count(), 1);
    assert_eq!(page.matches(SCRIPT).count(), 1);
    assert_eq!(page.matches("<ob-passage-feedback").count(), 1);
}

#[test]
fn a_site_that_does_not_opt_in_is_unchanged() {
    let plain = build(&config(""));
    let off = build(&config(r#","readerAnnotations":{"enabled":false}"#));
    assert_eq!(plain, off);
    let page = &plain["tides/index.html"];
    assert!(!page.contains("ob-annotations"));
    assert!(!page.contains("id=\"ob-passages\""));
    // Opting in changes the posts' pages and nothing else.
    let on = build(&config(ON));
    for (path, contents) in &plain {
        if !path.starts_with("tides/") {
            assert_eq!(on.get(path), Some(contents), "{path} changed");
        }
    }
}

#[test]
fn the_setting_is_omitted_from_the_written_configuration_while_off() {
    let off = SiteConfig::from_json(&config("")).unwrap();
    assert!(!serde_json::to_string(&off)
        .unwrap()
        .contains("readerAnnotations"));
    let on = SiteConfig::from_json(&config(ON)).unwrap();
    assert!(serde_json::to_string(&on)
        .unwrap()
        .contains("\"readerAnnotations\":{\"enabled\":true}"));
}
