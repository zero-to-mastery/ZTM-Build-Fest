//! Passage feedback forms on published pages (#82, ADR 0082): only an open
//! post on a site that opts in to hosted feedback carries its passage text as
//! page data, the feedback region with its no-JavaScript text, and the form's
//! script. The data is the build's own passage text (ADR 0076), escaped so
//! no text can end its element. Every other page, feed and file is
//! byte-for-byte what it is without the opt-in.

use std::collections::BTreeMap;

use openblog_core::passage_target::PassageDocument;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};

const OPEN: &str = "---
title: Tides
date: 2026-10-01
---
The moon causes the tides. The sun matters too.

## Methods

We measured the tides twice a day[^1].

## Results {#methods}

A second section under an anchor an author repeated.

### Hostile &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; \u{2028} heading

Text with <b>raw</b> HTML, `code` and a [link](https://example.org/).

[^1]: At the harbour.
";
const LOCKED: &str =
    "---\ntitle: Locked\ndate: 2026-10-02\ncomments: locked\n---\n## Part\n\nClosed text.\n";
const HIDDEN: &str =
    "---\ntitle: Hidden\ndate: 2026-10-03\ncomments: hidden\n---\n## Part\n\nHidden text.\n";

const POSTS: &[(&str, &str)] = &[
    ("posts/tides.md", OPEN),
    ("posts/locked.md", LOCKED),
    ("posts/hidden.md", HIDDEN),
];

fn config(engagement: &str) -> String {
    format!(
        r#"{{"title":"T","url":"https://t.dev","postPath":"/{{slug}}/","author":{{"name":"A"}},"engagement":{engagement}}}"#
    )
}

const OPTED_IN: &str = r#"{"enabled":true,"feedback":true,"endpoint":"https://t.dev/api/"}"#;
const OPTED_OUT: &str = r#"{"enabled":true,"endpoint":"https://t.dev/api/"}"#;

fn site(config_json: &str) -> Site {
    let config = SiteConfig::from_json(config_json).unwrap();
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

const DATA_OPEN: &str = "<script type=\"application/json\" id=\"ob-passages\">";
const SCRIPT: &str =
    "<script type=\"module\" src=\"/assets/components/ob-passage-feedback.js\"></script>\n";

/// The page data element's JSON, as a browser reads it.
fn page_data(page: &str) -> serde_json::Value {
    let start = page.find(DATA_OPEN).expect("passage data") + DATA_OPEN.len();
    let end = start + page[start..].find("</script>").unwrap();
    serde_json::from_str(&page[start..end]).unwrap()
}

/// The feedback region of a page.
fn region(page: &str) -> &str {
    let start = page
        .find("<section id=\"ob-feedback\"")
        .expect("feedback region");
    let end = start + page[start..].find("</section>\n").unwrap() + "</section>\n".len();
    &page[start..end]
}

#[test]
fn an_open_post_carries_the_build_passage_text_the_form_and_its_script() {
    let site = site(&config(OPTED_IN));
    let files = build(&site);
    let page = &files["tides/index.html"];
    assert_eq!(page.matches("id=\"ob-passages\"").count(), 1);
    assert_eq!(page.matches(SCRIPT).count(), 1);
    // The data and the script are in the head, the region after the article's navigation.
    assert!(page.find(DATA_OPEN).unwrap() < page.find("</head>").unwrap());
    assert!(page.find(SCRIPT).unwrap() < page.find("</head>").unwrap());

    let post = site.posts.iter().find(|post| post.slug == "tides").unwrap();
    let document = PassageDocument::of_post(post, &site.config);
    let data = page_data(page);
    assert_eq!(data["version"], 1);
    assert_eq!(data["work"], "/tides/");
    assert_eq!(data["revision"], document.revision.as_str());
    let sections = data["sections"].as_array().unwrap();
    assert_eq!(sections.len(), document.sections.len());
    for (index, (published, built)) in sections.iter().zip(&document.sections).enumerate() {
        assert_eq!(published["index"], index);
        assert_eq!(published["text"], built.text.as_str());
        assert_eq!(published["digest"], built.digest.as_str());
        assert_eq!(published["anchor"].as_str(), built.anchor.as_deref());
    }
    // The lead section has no anchor and no title; a repeated anchor keeps
    // each heading's own title, in order.
    assert!(sections[0].get("anchor").is_none() && sections[0].get("title").is_none());
    assert_eq!(sections[1]["anchor"], "methods");
    assert_eq!(sections[1]["title"], "Methods");
    assert_eq!(sections[2]["anchor"], "methods");
    assert_eq!(sections[2]["title"], "Results");
    // Generated parts of the page are not passage text.
    assert!(!sections[1]["text"]
        .as_str()
        .unwrap()
        .contains("At the harbour"));
    assert!(!data.to_string().contains("raw</b>"));

    let region = region(page);
    assert!(region.contains("aria-labelledby=\"ob-feedback-title\""));
    assert!(region.contains("<h2 id=\"ob-feedback-title\">Questions and corrections</h2>"));
    // The endpoint without its trailing slash, and this page's own address.
    assert!(region.contains(
        "<ob-passage-feedback endpoint=\"https://t.dev/api\" page=\"https://t.dev/tides/\">"
    ));
    // Without JavaScript the reader learns how to name the passage, and the revision.
    assert!(region.contains("class=\"ob-passage-feedback-static\""));
    assert!(region.contains(&format!("<code>{}</code>", document.revision)));
    assert!(!region.contains("contact="));
    // The region never repeats the post's text.
    assert!(!region.contains("moon"));
}

#[test]
fn hostile_text_stays_data_inside_the_page_data_element() {
    let site = site(&config(OPTED_IN));
    let page = build(&site).remove("tides/index.html").unwrap();
    let start = page.find(DATA_OPEN).unwrap() + DATA_OPEN.len();
    let raw = &page[start..start + page[start..].find("</script>").unwrap()];
    for forbidden in ['<', '>', '&', '\u{2028}', '\u{2029}'] {
        assert!(!raw.contains(forbidden), "{forbidden:?} in the data");
    }
    assert!(raw.contains("\\u003c/script\\u003e"));
    let data = page_data(&page);
    let hostile = data["sections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|section| section["text"].as_str().unwrap().starts_with("Hostile"))
        .unwrap();
    assert!(hostile["title"]
        .as_str()
        .unwrap()
        .contains("</script><script>alert(1)</script> &"));
    assert_eq!(page.matches("<script>alert(1)</script>").count(), 0);
}

#[test]
fn locked_and_hidden_posts_and_every_other_file_are_unchanged() {
    let with = build(&site(&config(OPTED_IN)));
    let without = build(&site(&config(OPTED_OUT)));
    let mut changed = Vec::new();
    for (path, contents) in &with {
        if without.get(path) != Some(contents) {
            changed.push(path.as_str());
        }
    }
    // Only the open post's page, and the policies the hosted function reads:
    // the participation manifest the opt-in folds into (ADR 0101) and B5's
    // own file for a function deployed before it (ADR 0081).
    assert_eq!(
        changed,
        [
            "openblog-feedback.json",
            "openblog-participation.json",
            "tides/index.html"
        ]
    );
    assert_eq!(with.len(), without.len() + 2);

    // The open page is the page without the opt-in plus the data, the script and the region.
    let page = &with["tides/index.html"];
    let start = page.find(DATA_OPEN).unwrap();
    let data_line = &page[start..start + page[start..].find('\n').unwrap() + 1];
    let stripped = page
        .replacen(data_line, "", 1)
        .replacen(SCRIPT, "", 1)
        .replacen(region(page), "", 1);
    assert_eq!(&stripped, &without["tides/index.html"]);

    for path in [
        "rss.xml",
        "feed.json",
        "llms.txt",
        "locked/index.html",
        "hidden/index.html",
    ] {
        if let Some(contents) = with.get(path) {
            assert!(!contents.contains("ob-passage"), "{path}");
            assert!(!contents.contains("ob-feedback"), "{path}");
        }
    }
}

#[test]
fn feedback_needs_hosted_engagement_and_its_own_switch() {
    let reference = build(&site(&config(r#"{"enabled":false}"#)));
    for engagement in [
        r#"{"enabled":false,"feedback":true}"#,
        r#"{"enabled":false,"feedback":true,"endpoint":"https://t.dev/api"}"#,
    ] {
        let files = build(&site(&config(engagement)));
        assert_eq!(files, reference, "{engagement}");
    }
    let files = build(&site(&config(OPTED_OUT)));
    assert!(files.values().all(|page| !page.contains("ob-passage")));
}

#[test]
fn a_feedback_contact_is_offered_as_a_link_in_the_static_text() {
    let mail = build(&site(&config(
        r#"{"enabled":true,"feedback":true,"endpoint":"https://t.dev/api","feedbackContact":"mailto:ada@t.dev"}"#,
    )));
    let region_html = region(&mail["tides/index.html"]).to_string();
    assert!(region_html.contains(" contact=\"mailto:ada@t.dev\">"));
    assert!(region_html.contains("to the author at <a href=\"mailto:ada@t.dev\">ada@t.dev</a>:"));

    let page = build(&site(&config(
        r#"{"enabled":true,"feedback":true,"endpoint":"https://t.dev/api","feedbackContact":"https://t.dev/contact/?a=1&b=2"}"#,
    )));
    let region_html = region(&page["tides/index.html"]).to_string();
    assert!(region_html.contains(" contact=\"https://t.dev/contact/?a=1&amp;b=2\">"));
    assert!(region_html
        .contains("through <a href=\"https://t.dev/contact/?a=1&amp;b=2\">the contact page</a>:"));
}

#[test]
fn a_base_path_prefixes_the_script_but_not_the_work_the_function_checks() {
    let site = site(
        r#"{"title":"T","url":"https://t.dev/blog/","postPath":"/{slug}/","engagement":{"enabled":true,"feedback":true,"endpoint":"https://t.dev/blog/api"}}"#,
    );
    let files = build(&site);
    let page = &files["tides/index.html"];
    assert!(page.contains(
        "<script type=\"module\" src=\"/blog/assets/components/ob-passage-feedback.js\"></script>"
    ));
    let policy: BTreeMap<String, String> =
        serde_json::from_str(&files["openblog-feedback.json"]).unwrap();
    let work = page_data(page)["work"].as_str().unwrap().to_string();
    assert_eq!(policy.get(&work).map(String::as_str), Some("open"));
}
