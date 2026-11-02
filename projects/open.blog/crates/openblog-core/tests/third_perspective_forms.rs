//! The Third Perspective region on published pages (#221, ADR 0114): only a
//! post where the kind is `open` under the one participation policy carries
//! the region, its no-JavaScript text with the site's feedback contact, the
//! passage data and the form's script. A locked or hidden post and a site
//! that leaves the kind off are unchanged, feeds and portable files carry no
//! form (only the labelled canonical link of ADR 0115), and the form sends
//! through the hosted service only where it issues receipts.

use std::collections::BTreeMap;

use openblog_core::passage_target::PassageDocument;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};

const OPEN: &str = "---
title: Tides
date: 2026-10-01
---
The moon causes the tides.

## Methods

We measured the tides twice a day.
";
const LOCKED: &str = "---\ntitle: Locked\ndate: 2026-10-02\nparticipation:\n  - third-perspective: locked\n---\n## Part\n\nClosed text.\n";
const HIDDEN: &str = "---\ntitle: Hidden\ndate: 2026-10-03\nparticipation:\n  - third-perspective: hidden\n---\n## Part\n\nHidden text.\n";

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
const OPEN_KIND: &str = r#","participation":{"kinds":{"third-perspective":"open"}}"#;
const SCRIPT: &str =
    "<script type=\"module\" src=\"/assets/components/ob-third-perspective.js\"></script>\n";
const FEEDBACK_SCRIPT: &str =
    "<script type=\"module\" src=\"/assets/components/ob-passage-feedback.js\"></script>\n";

fn region(page: &str) -> &str {
    let start = page
        .find("<section id=\"ob-third-perspective\"")
        .expect("Third Perspective region");
    let end = start + page[start..].find("</section>\n").unwrap() + "</section>\n".len();
    &page[start..end]
}

#[test]
fn an_open_post_carries_the_region_its_static_path_the_data_and_the_script() {
    let site = site(HOSTED, OPEN_KIND);
    let files = build(&site);
    let page = &files["tides/index.html"];
    assert_eq!(page.matches(SCRIPT).count(), 1);
    assert!(page.find(SCRIPT).unwrap() < page.find("</head>").unwrap());
    assert_eq!(
        page.matches("id=\"ob-passages\"").count(),
        1,
        "the passage data, once"
    );
    assert!(
        !page.contains(FEEDBACK_SCRIPT),
        "passage feedback is a separate kind, still off"
    );
    let post = site.posts.iter().find(|post| post.slug == "tides").unwrap();
    let revision = PassageDocument::of_post(post, &site.config).revision;

    let region = region(page);
    assert!(region.contains("aria-labelledby=\"ob-third-perspective-title\""));
    assert!(region.contains("<h2 id=\"ob-third-perspective-title\">Offer a Third Perspective</h2>"));
    assert!(region.contains(
        "<ob-third-perspective endpoint=\"https://t.dev/api\" page=\"https://t.dev/tides/\" contact=\"mailto:author@t.dev\" receipts>"
    ));
    assert!(region.contains("never as one of the authors’"));
    assert!(region.contains("There are no scores and no votes."));
    // Without JavaScript: write to the author, with the consent choices and the revision read.
    assert!(region.contains("<p class=\"ob-third-perspective-static\">The form needs JavaScript."));
    assert!(region.contains("at <a href=\"mailto:author@t.dev\">author@t.dev</a>"));
    assert!(region.contains("whether it may be published, whether your name may be shown"));
    assert!(region.contains(&format!("<code>{revision}</code>")));
    // The region is after the article's prose, never inside it.
    assert!(
        page.find("ob-prose").unwrap() < page.find("<section id=\"ob-third-perspective\"").unwrap()
    );
}

#[test]
fn locked_hidden_and_switched_off_posts_and_feeds_have_no_form() {
    let files = build(&site(HOSTED, OPEN_KIND));
    for page in ["locked/index.html", "hidden/index.html"] {
        assert!(!files[page].contains("ob-third-perspective"), "{page}");
        assert!(!files[page].contains("id=\"ob-passages\""), "{page}");
    }
    for (path, contents) in &files {
        if path.ends_with(".xml") || path.ends_with(".json") || path.ends_with(".txt") {
            // Feeds link to the form's anchor (ADR 0115) but never carry the region.
            for region in [
                "<ob-third-perspective",
                "ob-third-perspective-",
                "Offer a Third Perspective",
            ] {
                assert!(!contents.contains(region), "{path}: {region}");
            }
        }
    }
    // The kind left off, or no hosted transport: every page is as it was.
    let off = build(&site_off());
    assert!(!off["tides/index.html"].contains("ob-third-perspective"));
    let no_transport = build(&site(r#"{"enabled":false}"#, OPEN_KIND));
    assert!(!no_transport["tides/index.html"].contains("ob-third-perspective"));
    assert_eq!(
        off["tides/index.html"],
        build(&site_off())["tides/index.html"]
    );
}

fn site_off() -> Site {
    site(HOSTED, "")
}

#[test]
fn a_site_without_receipts_offers_the_copy_path_and_both_forms_share_one_data_element() {
    let site = site(
        r#"{"enabled":true,"feedback":true,"endpoint":"https://t.dev/api"}"#,
        OPEN_KIND,
    );
    let files = build(&site);
    let page = &files["tides/index.html"];
    let region = region(page);
    assert!(region.contains(
        "<ob-third-perspective endpoint=\"https://t.dev/api\" page=\"https://t.dev/tides/\">"
    ));
    assert!(!region.contains(" receipts"));
    assert!(!region.contains("contact="));
    assert!(region.contains("you can write your reflection to the author: say which section"));
    assert_eq!(
        page.matches("id=\"ob-passages\"").count(),
        1,
        "one data element for both forms"
    );
    assert!(page.find(FEEDBACK_SCRIPT).unwrap() < page.find(SCRIPT).unwrap());
    assert!(
        page.find("<section id=\"ob-feedback\"").unwrap()
            < page.find("<section id=\"ob-third-perspective\"").unwrap()
    );
}
