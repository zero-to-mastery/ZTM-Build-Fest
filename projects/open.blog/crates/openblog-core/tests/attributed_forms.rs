//! The Third Perspective region on a shared reflection (#223, ADR 0131): where
//! the site opens author responses on a post whose body is an arranged
//! reflection with committed credits, the region lists each author's section
//! by author, place, first words and digest, computed by the build from the
//! committed content alone, so a reader can write about one author's section.
//! Everywhere else the region, and every other page, is exactly as before.

use std::collections::BTreeMap;

use openblog_core::attributed_perspective::AttributedSections;
use openblog_core::reflection::{compose_bound, ComposedTurn, Placement, ReflectionLayout};
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};
use serde_json::Value;

const TURNS: [(&str, &str); 3] = [
    (
        "MINA",
        "The moon pulls the water, and the water answers it twice a day along the whole shore.",
    ),
    ("JOE", "It is also the sun."),
    ("MINA", "Neither explains the harbour."),
];
const CREDITS: &str = r#"{"version":1,"credits":[
  {"contributor":"mina","roles":[{"vocabulary":"crossref","role":"author"}]},
  {"contributor":"joe","roles":[{"vocabulary":"crossref","role":"author"}]}]}"#;
const HOSTED: &str = r#"{"enabled":true,"endpoint":"https://t.dev/api/","receipts":true,"feedbackContact":"mailto:author@t.dev"}"#;

fn arranged(turns: &[(&str, &str)]) -> String {
    let composed: Vec<ComposedTurn<'_>> = turns
        .iter()
        .enumerate()
        .map(|(round, (name, text))| ComposedTurn {
            round,
            round_prompt: None,
            display_name: name,
            label: None,
            placement: Placement { lane: 0, lanes: 1 },
            body: (*text).to_string(),
        })
        .collect();
    let keys: Vec<String> = turns.iter().map(|(name, _)| name.to_lowercase()).collect();
    let bound: Vec<Option<&str>> = keys.iter().map(|key| Some(key.as_str())).collect();
    compose_bound(ReflectionLayout::Sequential, &composed, &bound)
}

fn site(kinds: &str, body: &str, credits: bool) -> Site {
    site_with_front(kinds, body, credits, "")
}

fn site_with_front(kinds: &str, body: &str, credits: bool, front: &str) -> Site {
    let config = SiteConfig::from_json(&format!(
        r#"{{"title":"T","url":"https://t.dev","postPath":"/{{slug}}/","author":{{"name":"A"}},
        "contributors":{{"mina":{{"name":"Mina"}},"joe":{{"name":"Joe"}}}},
        "engagement":{HOSTED},"participation":{{"kinds":{kinds}}}}}"#
    ))
    .unwrap();
    Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: "posts/shared-tides.md".into(),
                contents: format!(
                    "---\ntitle: Tides, together\ndate: 2026-10-01\n{front}---\n{body}"
                ),
            }],
            credits: if credits {
                vec![SourceFile {
                    path: "posts/shared-tides.credits.json".into(),
                    contents: CREDITS.into(),
                }]
            } else {
                Vec::new()
            },
            ..Sources::default()
        },
        LoadOptions::default(),
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

fn region(page: &str) -> &str {
    let start = page
        .find("<section id=\"ob-third-perspective\"")
        .expect("Third Perspective region");
    let end = start + page[start..].find("</section>\n").unwrap() + "</section>\n".len();
    &page[start..end]
}

fn data(page: &str) -> Option<Value> {
    let marker = "<script type=\"application/json\" id=\"ob-attributed-sections\">";
    let start = page.find(marker)? + marker.len();
    let end = start + page[start..].find("</script>")?;
    Some(serde_json::from_str(&page[start..end]).unwrap())
}

const BOTH_OPEN: &str = r#"{"third-perspective":"open","author-response":"open"}"#;

#[test]
fn an_open_shared_reflection_lists_each_authors_section_in_its_region() {
    let site = site(BOTH_OPEN, &arranged(&TURNS), true);
    let page = &build(&site)["shared-tides/index.html"];
    let list = data(page).expect("the list of author sections");
    let published = AttributedSections::of_post(&site.posts[0]);
    assert_eq!(list["version"], 1);
    assert_eq!(list["work"], "/shared-tides/");
    let sections = list["sections"].as_array().unwrap();
    assert_eq!(sections.len(), 3);
    for (entry, section) in sections.iter().zip(published.sections()) {
        assert_eq!(entry["anchor"], section.anchor());
        assert_eq!(entry["contributor"], section.contribution);
        assert_eq!(entry["nth"], section.nth);
        assert_eq!(entry["author"], section.author);
        assert_eq!(entry["digest"], section.digest);
        assert_eq!(entry["excerpt"], section.excerpt);
    }
    assert_eq!(sections[0]["anchor"], "ob-by-mina-0");
    assert_eq!(sections[1]["anchor"], "ob-by-joe-0");
    assert_eq!(sections[2]["anchor"], "ob-by-mina-1");
    // The first words only, cut at a word, never a side of the page.
    let excerpt = sections[0]["excerpt"].as_str().unwrap();
    assert!(
        excerpt.ends_with('…') && excerpt.chars().count() <= 61,
        "{excerpt}"
    );
    assert!(excerpt.starts_with("The moon pulls the water"));
    assert_eq!(sections[1]["excerpt"], "It is also the sun.");
    let json = list.to_string();
    for visual in ["left", "right", "lane", "column", "position"] {
        assert!(!json.contains(visual), "{visual}");
    }
    // It sits in the region, which says how to name a section without JavaScript.
    let region = region(page);
    assert!(region.contains("id=\"ob-attributed-sections\""));
    assert!(region.contains("To write about one author’s section, name it by its author and its place among that author’s sections, such as “MINA, section 1”."));
    assert!(region.ends_with("</script>\n</section>\n"));
    // The list once, and no private id anywhere on the page.
    assert_eq!(page.matches("id=\"ob-attributed-sections\"").count(), 1);
    assert!(!page.contains("p-mina") && !page.contains("participant"));
}

#[test]
fn it_is_deterministic_and_script_safe() {
    let hostile = [
        ("MINA", "Tides `</script>` & \"quotes\" more"),
        ("JOE", "It is also the sun."),
    ];
    let site = site(BOTH_OPEN, &arranged(&hostile), true);
    let first = build(&site);
    let second = build(&site);
    assert_eq!(first, second, "the same site builds the same bytes");
    let page = &first["shared-tides/index.html"];
    let list = data(page).expect("the list");
    assert!(list["sections"][0]["excerpt"]
        .as_str()
        .unwrap()
        .contains("</script>"));
    // Nothing in it can end the element or open markup.
    let start = page.find("id=\"ob-attributed-sections\">").unwrap();
    let end = start + page[start..].find("</script>").unwrap();
    let inside = &page[start..end];
    assert!(!inside.contains("</script") && !inside.contains('<') && !inside.contains(" & "));
}

#[test]
fn where_author_responses_are_off_the_region_and_every_page_are_as_they_were() {
    let body = arranged(&TURNS);
    let baseline = build(&site(r#"{"third-perspective":"open"}"#, &body, true));
    let page = &baseline["shared-tides/index.html"];
    assert!(data(page).is_none(), "no author sections are listed");
    let region = region(page);
    assert!(!region.contains("author’s section"));
    assert!(!region.contains("ob-attributed-sections"));
    // The region is the one the Third Perspective form always had.
    let revision = {
        let site = site(r#"{"third-perspective":"open"}"#, &body, true);
        openblog_core::passage_target::PassageDocument::of_post(&site.posts[0], &site.config)
            .revision
    };
    assert_eq!(
        region,
        format!("<section id=\"ob-third-perspective\" class=\"ob-third-perspective\" aria-labelledby=\"ob-third-perspective-title\">\n<h2 id=\"ob-third-perspective-title\">Offer a Third Perspective</h2>\n<ob-third-perspective endpoint=\"https://t.dev/api\" page=\"https://t.dev/shared-tides/\" contact=\"mailto:author@t.dev\" receipts>\n<p>Share your own reading of this work, or of one section of it. If a moderator approves it, it is shown here as a reader’s reflection, never as one of the authors’, and only as you agree: published or not, with your name or without. There are no scores and no votes.</p>\n<p class=\"ob-third-perspective-static\">The form needs JavaScript. Without it, you can write your reflection to the author at <a href=\"mailto:author@t.dev\">author@t.dev</a>: say which section it is about, whether it may be published, whether your name may be shown and whether you may be asked to clarify it, and give this page’s passage revision, <code>{revision}</code>.</p>\n</ob-third-perspective>\n</section>\n")
    );
    // Naming the kind off, or leaving it out, builds exactly the same files.
    let off = build(&site(
        r#"{"third-perspective":"open","author-response":"off"}"#,
        &body,
        true,
    ));
    assert_eq!(off, baseline);
    // Hidden on this post by its own front matter is the same too.
    let hidden = build(&site_with_front(
        BOTH_OPEN,
        &body,
        true,
        "participation:
  - author-response: hidden
",
    ));
    assert_eq!(
        hidden["shared-tides/index.html"],
        baseline["shared-tides/index.html"]
    );
}

#[test]
fn a_post_that_attributes_nothing_lists_nothing() {
    // No credits sidecar: nobody can be attributed from committed content.
    let uncredited = build(&site(BOTH_OPEN, &arranged(&TURNS), false));
    assert!(data(&uncredited["shared-tides/index.html"]).is_none());
    assert!(!region(&uncredited["shared-tides/index.html"]).contains("author’s section"));
    // Credits that do not pair with the body's authors.
    let two_authors_one_name = [("MINA", "One."), ("MINA", "Two.")];
    let unpaired = build(&site(BOTH_OPEN, &arranged(&two_authors_one_name), true));
    assert!(data(&unpaired["shared-tides/index.html"]).is_none());
    // An ordinary post.
    let plain = build(&site(BOTH_OPEN, "# Heading\n\nText.\n", true));
    assert!(data(&plain["shared-tides/index.html"]).is_none());
    // Locked answers still let readers write about an author's section.
    let locked = build(&site(
        r#"{"third-perspective":"open","author-response":"locked"}"#,
        &arranged(&TURNS),
        true,
    ));
    assert!(data(&locked["shared-tides/index.html"]).is_some());
}

#[test]
fn feeds_and_portable_files_never_carry_the_list() {
    let files = build(&site(BOTH_OPEN, &arranged(&TURNS), true));
    for (path, contents) in &files {
        if path.ends_with(".xml") || path.ends_with(".json") || path.ends_with(".txt") {
            assert!(
                !contents.contains("ob-attributed-sections"),
                "{path}: the list belongs to the page's own region"
            );
        }
    }
}

// ---- An approved reflection about an author's section, on the canonical page

fn published(
    site_json_kinds: &str,
    turns: &[(&str, &str)],
    items: Vec<Value>,
) -> BTreeMap<String, String> {
    let config = SiteConfig::from_json(&format!(
        r#"{{"title":"T","url":"https://t.dev","postPath":"/{{slug}}/","author":{{"name":"A"}},
        "contributors":{{"mina":{{"name":"Mina"}},"joe":{{"name":"Joe"}}}},
        "engagement":{HOSTED},"participation":{{"kinds":{site_json_kinds}}}}}"#
    ))
    .unwrap();
    let site = Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: "posts/shared-tides.md".into(),
                contents: format!(
                    "---\ntitle: Tides, together\ndate: 2026-10-01\n---\n{}",
                    arranged(turns)
                ),
            }],
            credits: vec![SourceFile {
                path: "posts/shared-tides.credits.json".into(),
                contents: CREDITS.into(),
            }],
            third_perspectives: Some(SourceFile {
                path: "content/third-perspectives.json".into(),
                contents: serde_json::to_string_pretty(
                    &serde_json::json!({"version": 1, "items": items}),
                )
                .unwrap(),
            }),
            ..Sources::default()
        },
        LoadOptions::default(),
    )
    .unwrap();
    assert!(
        site.third_perspectives_error.is_none(),
        "{:?}",
        site.third_perspectives_error
    );
    build(&site)
}

#[test]
fn a_published_reflection_about_an_authors_section_says_whose_and_never_claims_which_change() {
    let original = site(BOTH_OPEN, &arranged(&TURNS), true);
    let target = AttributedSections::of_post(&original.posts[0]).sections()[0]
        .target()
        .perspective_target()
        .to_value();
    let revision = openblog_core::passage_target::PassageDocument::of_post(
        &original.posts[0],
        &original.config,
    )
    .revision;
    let item = serde_json::json!({
        "id": "00000000-0000-4000-8000-000000000001", "post": "posts/shared-tides.md", "work": "/shared-tides/",
        "revision": revision, "target": target, "body": "I read the harbour differently.",
        "received": "2026-10-26", "approved": "2026-10-27",
    });
    let section = |files: &BTreeMap<String, String>| {
        let page = &files["shared-tides/index.html"];
        let start = page.find("<section id=\"ob-third-perspectives\"").unwrap();
        page[start
            ..start
                + page[start..]
                    .find(
                        "</section>
",
                    )
                    .unwrap()]
            .to_string()
    };
    // The section is as the reader read it: its author's section has an
    // anchor now, so the reflection follows it there, labelled as a reader's,
    // and is not listed a second time (ADR 0138).
    let files = published(BOTH_OPEN, &TURNS, vec![item.clone()]);
    let page = &files["shared-tides/index.html"];
    assert!(page.contains("id=\"ob-by-mina-0\""), "{page}");
    let listed = section(&files);
    assert!(
        listed.contains("shown after that section") && !listed.contains("I read the harbour"),
        "the list only points to it: {listed}"
    );
    let turn = &page[page.find("id=\"ob-by-mina-0\"").unwrap()..];
    let turn = &turn[..turn.find("</section>").unwrap()];
    assert!(turn.contains(TURNS[0].1));
    assert!(
        turn.find(TURNS[0].1).unwrap() < turn.find("ob-conversation").unwrap(),
        "the conversation follows the author's words"
    );
    assert!(turn.contains("Third Perspective from a reader"), "{turn}");
    assert!(turn.contains("I read the harbour differently."));
    // Her section was rewritten: it says changed or removed, never which.
    let edited = section(&published(
        BOTH_OPEN,
        &[("MINA", "Rewritten."), TURNS[1], TURNS[2]],
        vec![item.clone()],
    ));
    assert!(
        edited.contains("About a section by MINA, since changed or removed"),
        "{edited}"
    );
    // She has no sections any more: no author is named.
    let gone = section(&published(BOTH_OPEN, &[TURNS[1]], vec![item.clone()]));
    assert!(
        gone.contains("About one author’s section, since changed or removed"),
        "{gone}"
    );
    // A hostile target is refused when the file is read.
    let mut bad = item.clone();
    bad["target"]["section"] = serde_json::json!("ob-by-Mina-0");
    let files = std::panic::catch_unwind(|| {
        published(BOTH_OPEN, &TURNS, vec![bad]);
    });
    assert!(files.is_err(), "the file is refused, not half-read");
}
