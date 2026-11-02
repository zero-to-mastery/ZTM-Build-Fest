//! The community section of a canonical page (#230, ADRs 0180 to 0184): the
//! reflections the editors chose to feature, rendered as static HTML from
//! `community-perspectives.json` through the one public projection, framed as
//! an editorial choice and never counted, ranked or ordered by popularity.
//! Portable copies, feeds, search and `llms` files carry the canonical link
//! and nothing of them; a site without the file, or with features that do not
//! stand, is byte-for-byte what it was.

use std::collections::{BTreeMap, BTreeSet};

use openblog_core::community_feature::{
    body_digest, COMMUNITY_FEATURES_ANCHOR, COMMUNITY_FEATURES_FILE, NON_CONSENSUS_NOTICE,
};
use openblog_core::passage_target::PassageDocument;
use openblog_core::perspective_publication::THIRD_PERSPECTIVES_FILE;
use openblog_core::portability::PortableProjection;
use openblog_core::third_perspective::PerspectiveTarget;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};
use serde_json::{json, Value};

const ID_1: &str = "00000000-0000-4000-8000-000000000001";
const ID_2: &str = "00000000-0000-4000-8000-000000000002";
const ID_3: &str = "00000000-0000-4000-8000-000000000003";
const BODY: &str =
    "The moon causes the tides.\n\n## Methods\n\nWe measured the tides twice a day.\n";
const REFLECTION_1: &str = "Tides as a <conversation> & a rhythm.\n\nA second paragraph.";
const REFLECTION_2: &str = "Zebra-striped thoughts about the moon.";
const NOTE: &str = "Connects the tides to a shared rhythm.";

const HOSTED: &str =
    r#""engagement":{"enabled":true,"endpoint":"https://t.dev/api","receipts":true}"#;
const OPEN_KIND: &str = r#","participation":{"kinds":{"third-perspective":"open"}}"#;
const LOCKED_KIND: &str = r#","participation":{"kinds":{"third-perspective":"locked"}}"#;

fn config(participation: &str) -> SiteConfig {
    SiteConfig::from_json(&format!(
        r#"{{"title":"T","url":"https://t.dev","postPath":"/posts/{{slug}}/","author":{{"name":"Ada Lovelace"}},{HOSTED}{participation}}}"#
    ))
    .unwrap()
}

fn post(front: &str) -> SourceFile {
    SourceFile {
        path: "posts/tides.md".into(),
        contents: format!("---\ntitle: Tides\ndate: 2026-01-01\n{front}---\n{BODY}"),
    }
}

fn load(participation: &str, front: &str, third: Option<String>, features: Option<String>) -> Site {
    Site::load(
        config(participation),
        Sources {
            posts: vec![post(front)],
            third_perspectives: third.map(|contents| SourceFile {
                path: format!("content/{THIRD_PERSPECTIVES_FILE}"),
                contents,
            }),
            community_features: features.map(|contents| SourceFile {
                path: format!("content/{COMMUNITY_FEATURES_FILE}"),
                contents,
            }),
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

fn methods() -> (String, Value) {
    let site = load(OPEN_KIND, "", None, None);
    let document = PassageDocument::of_post(&site.posts[0], &site.config);
    let target = PerspectiveTarget::try_from(document.section_target(1).unwrap()).unwrap();
    (document.revision.clone(), target.to_value())
}

fn published(id: &str, body: &str, name: Option<&str>, about_section: bool) -> Value {
    let (revision, target) = methods();
    let mut value = json!({
        "id": id, "post": "posts/tides.md", "work": "/posts/tides/", "revision": revision,
        "target": if about_section { target } else { PerspectiveTarget::work().to_value() },
        "category": "connection", "body": body,
        "received": "2026-10-26", "approved": "2026-10-27",
    });
    if let Some(name) = name {
        value["name"] = json!(name);
    }
    value
}

fn featured(id: &str, body: &str, day: &str, context: Option<&str>) -> Value {
    let mut value = json!({
        "id": id, "post": "posts/tides.md", "revision": 1, "digest": body_digest(body),
        "featured": day,
    });
    if let Some(context) = context {
        value["context"] = json!(context);
    }
    value
}

fn file(items: Vec<Value>) -> String {
    serde_json::to_string_pretty(&json!({"version": 1, "items": items})).unwrap()
}

fn third_file() -> String {
    file(vec![
        published(ID_1, REFLECTION_1, Some("Mina Unique"), true),
        published(ID_2, REFLECTION_2, None, false),
    ])
}

fn features_file() -> String {
    file(vec![
        featured(ID_2, REFLECTION_2, "2026-10-29", None),
        featured(ID_1, REFLECTION_1, "2026-10-28", Some(NOTE)),
    ])
}

/// A site that publishes two reflections and features both.
fn featured_site(participation: &str) -> Site {
    load(participation, "", Some(third_file()), Some(features_file()))
}

fn section(page: &str) -> &str {
    let start = page
        .find(&format!("<section id=\"{COMMUNITY_FEATURES_ANCHOR}\""))
        .expect("community section");
    let end = start + page[start..].find("</section>\n").unwrap() + "</section>\n".len();
    &page[start..end]
}

fn ids(page: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = page;
    while let Some(at) = rest.find(" id=\"") {
        let after = &rest[at + 5..];
        let end = after.find('"').unwrap();
        found.push(after[..end].to_string());
        rest = &after[end..];
    }
    found
}

#[test]
fn the_section_is_a_static_list_with_the_fixed_notice_honest_provenance_and_no_signals() {
    let site = featured_site(LOCKED_KIND);
    assert_eq!(site.posts[0].community_features().len(), 2);
    let files = build(&site);
    let page = &files["posts/tides/index.html"];
    let html = section(page);

    // Semantics: a labelled region, one list, one article per feature.
    assert!(html.contains("aria-labelledby=\"ob-community-perspectives-title\""));
    assert!(html.contains("<h2 id=\"ob-community-perspectives-title\">Community perspectives</h2>"));
    assert!(html.contains(&format!(
        "<p class=\"ob-community-notice\">{}</p>",
        NON_CONSENSUS_NOTICE.replace('\'', "&#39;")
    )));
    assert_eq!(html.matches("<ul ").count(), 1);
    assert!(!html.contains("<ol"));
    assert_eq!(html.matches("<article ").count(), 2);

    // Each says it was chosen by the editors, whose reflection it is and why.
    assert_eq!(html.matches("Chosen by the editors").count(), 2);
    assert!(html.contains("<h3 id=\"ob-feature-00000000-0000-4000-8000-000000000001-title\">Third Perspective from Mina Unique, a reader</h3>"));
    assert!(html.contains("A Third Perspective from Mina Unique, a reader, received 2026-10-26 and approved by the editors. It is featured here from 2026-10-28, with the reader"), "{html}");
    assert!(html.contains("<h3 id=\"ob-feature-00000000-0000-4000-8000-000000000002-title\">Third Perspective from a reader</h3>"));
    // The reader's words whole and escaped; the editors' note labelled as theirs.
    assert!(html.contains("<p>Tides as a &lt;conversation&gt; &amp; a rhythm.</p>"));
    assert!(html.contains("<p>A second paragraph.</p>"));
    assert!(html.contains(&format!(
        "<p class=\"ob-feature-note\"><strong>Note from the editors:</strong> {NOTE}</p>"
    )));
    assert_eq!(html.matches("Note from the editors").count(), 1);
    assert!(html.contains("About <a href=\"#"), "{html}");
    assert!(html.contains("About the whole work"));
    assert!(html.contains("<a href=\"#ob-perspective-00000000-0000-4000-8000-000000000001\">"));

    // By the day featured, never by popularity: ID_1 (28th) before ID_2 (29th).
    assert!(html.find(ID_1).unwrap() < html.find(ID_2).unwrap());

    // No count, rank, score or popularity signal is written anywhere in it
    // (the notice's own words "not a vote" are the one allowed mention).
    let words = html.to_lowercase().replace("not a vote", "");
    for signal in [
        "popular",
        "rank",
        "score",
        "upvote",
        "likes",
        "reactions",
        "trending",
        "most ",
        "top ",
        "best",
        "vote",
        "featured reflections",
    ] {
        assert!(!words.contains(signal), "{signal} in {html}");
    }

    // The section follows the Third Perspectives; every id on the page is
    // unique, so each reflection has two different anchors.
    let third = page.find("id=\"ob-third-perspectives\"").unwrap();
    let community = page.find("id=\"ob-community-perspectives\"").unwrap();
    assert!(third < community);
    let all = ids(page);
    let unique: BTreeSet<&String> = all.iter().collect();
    assert_eq!(all.len(), unique.len(), "duplicate ids: {all:?}");
    assert!(all.contains(&format!("ob-perspective-{ID_1}")));
    assert!(all.contains(&format!("ob-feature-{ID_1}")));
    // Progressive enhancement only: no script, no custom element, no form.
    assert!(!html.contains("<script") && !html.contains("<form") && !html.contains("<ob-"));
}

#[test]
fn output_is_deterministic_whatever_the_order_of_the_file() {
    let a = vec![
        featured(ID_1, REFLECTION_1, "2026-10-28", Some(NOTE)),
        featured(ID_2, REFLECTION_2, "2026-10-29", None),
    ];
    let b = vec![a[1].clone(), a[0].clone()];
    let one = build(&load(
        LOCKED_KIND,
        "",
        Some(third_file()),
        Some(file(a.clone())),
    ));
    let two = build(&load(LOCKED_KIND, "", Some(third_file()), Some(file(b))));
    assert_eq!(one, two);
    let again = build(&load(LOCKED_KIND, "", Some(third_file()), Some(file(a))));
    assert_eq!(one, again);
}

#[test]
fn anonymity_is_mixed_per_reflection_and_a_hidden_name_is_never_shown() {
    let files = build(&featured_site(LOCKED_KIND));
    let html = section(&files["posts/tides/index.html"]).to_string();
    assert_eq!(html.matches("Mina Unique").count(), 2);
    let anonymous = &html[html.find(&format!("id=\"ob-feature-{ID_2}\"")).unwrap()..];
    assert!(!anonymous.contains("Mina"));
}

#[test]
fn a_site_with_no_file_or_no_standing_feature_is_byte_for_byte_what_it_was() {
    let legacy = build(&load(LOCKED_KIND, "", Some(third_file()), None));
    assert!(!legacy["posts/tides/index.html"].contains("ob-community-perspectives"));
    // An empty file is the same.
    assert_eq!(
        build(&load(
            LOCKED_KIND,
            "",
            Some(third_file()),
            Some(file(vec![]))
        )),
        legacy
    );
    // A feature whose reflection is not published, whose text changed, whose
    // day is before its approval is absent with no mark of a gap: the page is
    // exactly the legacy page.
    let not_published = load(
        LOCKED_KIND,
        "",
        None,
        Some(file(vec![featured(ID_1, REFLECTION_1, "2026-10-28", None)])),
    );
    assert!(not_published.posts[0].community_features().is_empty());
    assert_eq!(
        build(&not_published),
        build(&load(LOCKED_KIND, "", None, None))
    );
    for (items, why) in [
        (
            vec![featured(ID_1, "Another text", "2026-10-28", None)],
            "text changed",
        ),
        (
            vec![featured(ID_1, REFLECTION_1, "2026-10-01", None)],
            "misdated",
        ),
        (
            vec![featured(ID_3, REFLECTION_1, "2026-10-28", None)],
            "not published",
        ),
    ] {
        let site = load(LOCKED_KIND, "", Some(third_file()), Some(file(items)));
        assert!(site.posts[0].community_features().is_empty(), "{why}");
        assert_eq!(build(&site), legacy, "{why}");
        // The warning names the id and a fixed reason, never the words.
        let warnings = site.warnings.join("\n");
        assert!(warnings.contains("is not shown"), "{why}: {warnings}");
        assert!(!warnings.contains("Another text") && !warnings.contains("rhythm"));
    }
    // A withdrawn reflection leaves third-perspectives.json, and its feature
    // is gone from the page with it.
    let withdrawn = load(
        LOCKED_KIND,
        "",
        Some(file(vec![published(ID_2, REFLECTION_2, None, false)])),
        Some(file(vec![featured(
            ID_1,
            REFLECTION_1,
            "2026-10-28",
            Some(NOTE),
        )])),
    );
    let page = build(&withdrawn)["posts/tides/index.html"].clone();
    assert!(!page.contains("ob-community-perspectives") && !page.contains(NOTE));
    assert!(!page.contains("Tides as a"));
    // A post that hides the kind shows no feature, and a site that leaves the
    // kind off is untouched.
    let hidden = load(
        OPEN_KIND,
        "participation:\n  - third-perspective: hidden\n",
        Some(third_file()),
        Some(file(vec![featured(ID_1, REFLECTION_1, "2026-10-28", None)])),
    );
    assert!(hidden.posts[0].community_features().is_empty());
    assert!(!build(&hidden)["posts/tides/index.html"].contains("ob-community-perspectives"));
    let off = load(
        "",
        "",
        Some(third_file()),
        Some(file(vec![featured(ID_1, REFLECTION_1, "2026-10-28", None)])),
    );
    assert!(off.posts[0].community_features().is_empty());
    assert_eq!(
        build(&off),
        build(&load("", "", Some(third_file()), None)),
        "with the kind off, the file changes no byte"
    );
}

#[test]
fn a_feature_never_stands_without_its_reflection_in_the_third_perspectives_list() {
    let site = featured_site(LOCKED_KIND);
    let post = &site.posts[0];
    for feature in post.community_features() {
        assert!(
            post.third_perspectives()
                .iter()
                .any(|item| item.id == feature.id),
            "{}",
            feature.id
        );
    }
    assert!(post
        .capabilities
        .iter()
        .any(|capability| capability.id == "third-perspectives"));
}

#[test]
fn feeds_portable_copies_search_and_llms_carry_only_the_canonical_link() {
    let site = featured_site(LOCKED_KIND);
    let files = build(&site);
    assert!(files["posts/tides/index.html"].contains(NOTE));
    for (path, contents) in &files {
        if path == "posts/tides/index.html" {
            continue;
        }
        for secret in [
            "Tides as a",
            "conversation",
            "Zebra-striped",
            "Mina Unique",
            NOTE,
            ID_1,
            ID_2,
            "ob-feature",
            "ob-community-perspectives-title",
            "Chosen by the editors",
            NON_CONSENSUS_NOTICE,
        ] {
            assert!(!contents.contains(secret), "{secret} in {path}");
        }
    }
    // The same post's other forms keep their canonical link.
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let html = projection.portable_html().unwrap();
    assert!(html
        .html
        .contains("https://t.dev/posts/tides/#ob-third-perspectives"));
    assert!(!html.html.contains(NOTE) && !html.html.contains("Zebra"));
    let markdown = projection.portable_markdown().unwrap();
    assert!(
        markdown.contains("[canonical article](https://t.dev/posts/tides/#ob-third-perspectives)")
    );
    assert!(!markdown.contains(NOTE) && !markdown.contains("Zebra"));
    assert!(files["llms-full.txt"].contains("canonical page, <https://t.dev/posts/tides/>"));
    // A feature changes no file but the post's own page.
    let legacy = build(&load(LOCKED_KIND, "", Some(third_file()), None));
    for (path, contents) in &files {
        if path != "posts/tides/index.html" {
            assert_eq!(contents, &legacy[path], "{path} changed");
        }
    }
}

#[test]
fn reader_text_a_name_and_a_note_are_escaped_and_never_become_markup() {
    let body = "<img src=x onerror=alert(1)> and <script>alert(2)</script> & \"quotes\"";
    let note = "<b>Read</b> this & <a href=\"https://evil.example\">that</a>";
    let third = file(vec![published(
        ID_1,
        body,
        Some("Mina \"><svg onload=alert(3)>"),
        false,
    )]);
    let site = load(
        LOCKED_KIND,
        "",
        Some(third),
        Some(file(vec![featured(ID_1, body, "2026-10-28", Some(note))])),
    );
    let page = build(&site)["posts/tides/index.html"].clone();
    let html = section(&page);
    assert!(html.contains(NON_CONSENSUS_NOTICE.replace('\'', "&#39;").as_str()));
    for raw in [
        "<img",
        "<script",
        "<svg",
        "<b>",
        "<a href=\"https://evil",
        "onload=alert(3)>",
    ] {
        assert!(!html.contains(raw), "{raw} in {html}");
    }
    assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;"));
    assert!(html.contains("&lt;b&gt;Read&lt;/b&gt;"));
}

// ---- The fixtures shared with the node tests (tests/fixtures)

const SHARED: &str = include_str!("../../../tests/fixtures/community-features.json");
const GOLDEN_PATH: &str = "../../tests/fixtures/community-section.html";

#[test]
fn the_shared_fixture_agrees_with_the_notice_the_reasons_and_the_note_lint() {
    use openblog_core::community_feature::{
        normalize_context, FeatureError, FeatureOff, HiddenReason,
    };
    let fixture: Value = serde_json::from_str(SHARED).unwrap();
    assert_eq!(fixture["notice"], NON_CONSENSUS_NOTICE);
    let reasons = fixture["reasons"].as_array().unwrap();
    let mut seen = Vec::new();
    for off in [
        FeatureOff::Withdrawn,
        FeatureOff::Deleted,
        FeatureOff::NotApproved,
        FeatureOff::ConsentDeclined,
        FeatureOff::TextChanged,
        FeatureOff::Misdated,
    ] {
        let entry = reasons.iter().find(|r| r["id"] == off.id()).unwrap();
        assert_eq!(entry["standing"], "mustComeOff");
        assert_eq!(entry["explanation"], off.explanation());
        seen.push(off.id());
    }
    let hidden = reasons
        .iter()
        .find(|r| r["id"] == HiddenReason::SourceGone.id())
        .unwrap();
    assert_eq!(hidden["standing"], "hidden");
    assert_eq!(
        hidden["explanation"],
        HiddenReason::SourceGone.explanation()
    );
    assert_eq!(
        reasons.len(),
        seen.len() + 1,
        "the fixture lists every reason"
    );
    for entry in fixture["notes"].as_array().unwrap() {
        let note = entry["note"].as_str().unwrap();
        let result = normalize_context(note);
        if entry["ok"].as_bool().unwrap() {
            assert!(result.is_ok(), "{note} should pass");
        } else {
            assert_eq!(
                result,
                Err(FeatureError::PopularityClaim),
                "{note} should be refused"
            );
        }
    }
}

/// The section of the fixture site is byte-for-byte the golden page the node
/// tests read, so Rust and node agree on one markup. Run with
/// `OPENBLOG_BLESS=1` to rewrite it after an intended change.
#[test]
fn the_section_is_the_shared_golden_markup() {
    let files = build(&featured_site(LOCKED_KIND));
    let html = section(&files["posts/tides/index.html"]).to_string();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(GOLDEN_PATH);
    if std::env::var_os("OPENBLOG_BLESS").is_some() {
        std::fs::write(&path, &html).unwrap();
    }
    let golden = std::fs::read_to_string(&path)
        .unwrap()
        .replace("\r\n", "\n");
    assert_eq!(html, golden);
}
