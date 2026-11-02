//! Collaborative series context in feeds and portable output (ADR 0041): a published part of a
//! series that holds a collaborative work states its series (name, canonical link, place in the
//! reading order) and who wrote it, in RSS, JSON Feed, llms-full.txt and every portable copy.
//! Every other post keeps exactly the output it had.

use openblog_core::contributor::Contributor;
use openblog_core::portability::{PortableProjection, RepresentationFormat};
use openblog_core::render;
use openblog_core::{
    feeds, DateTime, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};

const AUTHOR: &str = r#"{"vocabulary":"crossref","role":"author"}"#;
const EDITOR: &str = r#"{"vocabulary":"crossref","role":"editor"}"#;
const SERIES_URL: &str = "https://example.test/series/letters/";
/// The series index: the taxonomy an RSS series category belongs to.
const SERIES_INDEX: &str = "https://example.test/series/";

fn config() -> SiteConfig {
    let mut config = SiteConfig::from_json(
        r#"{"title":"T","url":"https://example.test","postPath":"/{slug}/","author":{"name":"Site Owner","url":"https://example.test/about/"}}"#,
    )
    .unwrap();
    for (id, name, url) in [
        ("ann", "Ann", "https://example.org/ann"),
        ("bo", "Bo", "https://example.org/bo"),
        ("cy", "Cy", ""),
        ("dee", "Dee", "https://example.org/dee"),
        // Credited only on a draft and a scheduled work, so never public.
        ("eve", "Eve Hidden", "https://example.org/eve"),
        (
            "mal",
            "<img src=x onerror=alert(1)> [Mal](javascript:alert(1)) **bold**",
            "",
        ),
        ("kim", "Kim <https://kim.example>", ""),
        ("att", "AT&amp;T", ""),
    ] {
        config.contributors.insert(
            id.into(),
            Contributor {
                name: name.into(),
                url: url.into(),
                ..Contributor::default()
            },
        );
    }
    config
}

fn file(path: &str, contents: &str) -> SourceFile {
    SourceFile {
        path: path.into(),
        contents: contents.into(),
    }
}

fn post(
    slug: &str,
    series: Option<&str>,
    date: &str,
    order: Option<u32>,
    extra: &str,
) -> SourceFile {
    let series = series
        .map(|series| format!("series: {series}\n"))
        .unwrap_or_default();
    let order = order
        .map(|order| format!("seriesOrder: {order}\n"))
        .unwrap_or_default();
    file(
        &format!("posts/{slug}.md"),
        &format!(
            "---\ntitle: Part {slug}\ndate: {date}\ndescription: About {slug}.\ntags: [notes]\n{series}{order}{extra}---\nBody of {slug}.\n"
        ),
    )
}

fn credits(slug: &str, authors: &[&str], editors: &[&str]) -> SourceFile {
    let entries: Vec<String> = authors
        .iter()
        .map(|id| format!(r#"{{"contributor":"{id}","roles":[{AUTHOR}]}}"#))
        .chain(
            editors
                .iter()
                .map(|id| format!(r#"{{"contributor":"{id}","roles":[{EDITOR}]}}"#)),
        )
        .collect();
    file(
        &format!("posts/{slug}.credits.json"),
        &format!(r#"{{"version":1,"credits":[{}]}}"#, entries.join(",")),
    )
}

fn series_file(slug: &str, name: &str) -> SourceFile {
    file(
        &format!("series/{slug}.md"),
        &format!("---\nname: {name}\n---\nA recurring premise.\n"),
    )
}

/// An ordinary series (one part with an explicit single author), a loose post, and a "letters"
/// series of ordinary parts. With `collaborative`, the second letter is a three-author work, so
/// letters becomes a collaborative series. Both series hold a draft and a scheduled work that
/// credit Eve and are never public.
fn sources(collaborative: bool) -> Sources {
    let posts = vec![
        post("g1", Some("guides"), "2026-01-01", Some(1), ""),
        post("g2", Some("guides"), "2026-02-01", Some(2), ""),
        post(
            "g-draft",
            Some("guides"),
            "2026-02-05",
            Some(3),
            "draft: true\n",
        ),
        post("loose", None, "2026-03-01", None, ""),
        post("l1", Some("letters"), "2026-04-01", Some(1), ""),
        post("l2", Some("letters"), "2026-05-01", Some(2), ""),
        post("l3", Some("letters"), "2026-06-01", Some(3), ""),
        post("l4", Some("letters"), "2026-07-01", None, ""),
        post(
            "l-draft",
            Some("letters"),
            "2026-07-05",
            Some(5),
            "draft: true\n",
        ),
        post("l-later", Some("letters"), "2099-01-01", Some(6), ""),
    ];
    let mut sidecars = vec![
        credits("g2", &["cy"], &[]),
        credits("g-draft", &["eve", "ann"], &[]),
        credits("l-draft", &["eve", "ann"], &[]),
        credits("l-later", &["eve", "bo"], &[]),
    ];
    if collaborative {
        sidecars.push(credits("l2", &["ann", "bo", "cy"], &["dee"]));
        sidecars.push(credits("l3", &["dee"], &[]));
    }
    Sources {
        posts,
        credits: sidecars,
        series: vec![
            series_file("guides", "Guides"),
            series_file("letters", "Letters"),
        ],
        pages: vec![],
        ..Default::default()
    }
}

fn load(sources: Sources) -> Site {
    load_with(sources, false)
}

fn load_with(sources: Sources, include_drafts: bool) -> Site {
    Site::load(
        config(),
        sources,
        LoadOptions {
            include_drafts,
            now: DateTime::parse("2030-01-01T00:00:00Z"),
            ..LoadOptions::default()
        },
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"))
}

fn output<'a>(files: &'a [render::OutputFile], path: &str) -> &'a str {
    &files
        .iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("no {path}"))
        .contents
}

fn post_of<'a>(site: &'a Site, slug: &str) -> &'a openblog_core::Post {
    site.posts.iter().find(|post| post.slug == slug).unwrap()
}

/// The RSS item whose link is `/<slug>/`.
fn rss_item<'a>(xml: &'a str, slug: &str) -> &'a str {
    let link = format!("<link>https://example.test/{slug}/</link>");
    let at = xml.find(&link).unwrap_or_else(|| panic!("no item {slug}"));
    let start = xml[..at].rfind("<item>").unwrap();
    let end = at + xml[at..].find("</item>").unwrap() + "</item>".len();
    &xml[start..end]
}

fn json_item(feed: &serde_json::Value, slug: &str) -> serde_json::Value {
    let url = format!("https://example.test/{slug}/");
    feed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["url"] == url.as_str())
        .unwrap_or_else(|| panic!("no item {slug}"))
        .clone()
}

/// The llms-full.txt section of `/<slug>/`.
fn llms_section<'a>(text: &'a str, slug: &str) -> &'a str {
    let heading = format!("## Part {slug}\n");
    let start = text.find(&heading).unwrap_or_else(|| panic!("no {slug}"));
    let end = text[start..]
        .find("\n---\n")
        .map_or(text.len(), |end| start + end);
    &text[start..end]
}

fn legacy_fixture(name: &str) -> String {
    let path = format!(
        "{}/tests/fixtures/legacy_series/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{path}: {error}"))
        .replace("\r\n", "\n")
}

const CONTEXT_L2: &str = "Part 2 in the series <a href=\"https://example.test/series/letters/\">Letters</a>. This part is by Ann, Bo, and Cy. Series contributors: Site Owner, Ann, Bo, Cy, and Dee.";
const CONTEXT_L1: &str = "Part 1 in the series <a href=\"https://example.test/series/letters/\">Letters</a>. This part is by Site Owner. Series contributors: Site Owner, Ann, Bo, Cy, and Dee.";

#[test]
fn feeds_without_a_collaborative_series_are_byte_for_byte_what_they_were() {
    // The site's feeds before collaborative series context existed, captured from the previous
    // release's code: ordinary series, a loose post, drafts and scheduled works.
    let files = render::generate(&load(sources(false)), &ThemeSet::new()).unwrap();
    for name in ["rss.xml", "feed.json", "llms-full.txt", "llms.txt"] {
        assert_eq!(
            output(&files, name),
            legacy_fixture(name),
            "{name} changed for a site without a collaborative series"
        );
    }
}

#[test]
fn a_collaborative_series_elsewhere_changes_no_other_post() {
    let before = load(sources(false));
    let after = load(sources(true));
    let (old, new) = (
        render::generate(&before, &ThemeSet::new()).unwrap(),
        render::generate(&after, &ThemeSet::new()).unwrap(),
    );
    let old_json: serde_json::Value = serde_json::from_str(output(&old, "feed.json")).unwrap();
    let new_json: serde_json::Value = serde_json::from_str(output(&new, "feed.json")).unwrap();
    for slug in ["g1", "g2", "loose"] {
        assert_eq!(
            rss_item(output(&old, "rss.xml"), slug),
            rss_item(output(&new, "rss.xml"), slug),
            "{slug}"
        );
        assert_eq!(
            json_item(&old_json, slug),
            json_item(&new_json, slug),
            "{slug}"
        );
        assert_eq!(
            llms_section(output(&old, "llms-full.txt"), slug),
            llms_section(output(&new, "llms-full.txt"), slug),
            "{slug}"
        );
        // Every portable copy of the post is exactly the context-free projection.
        let post = post_of(&after, slug);
        assert_eq!(after.series_context(post), None);
        let site_copy = PortableProjection::for_site(&after, post).unwrap();
        let plain = PortableProjection::from_post(post, &after.config).unwrap();
        assert_eq!(
            site_copy.portable_html().unwrap(),
            plain.portable_html().unwrap()
        );
        assert_eq!(
            site_copy.portable_markdown().unwrap(),
            plain.portable_markdown().unwrap()
        );
        assert_eq!(
            site_copy.portable_text().unwrap(),
            plain.portable_text().unwrap()
        );
        assert_eq!(
            site_copy.source_revision().unwrap(),
            plain.source_revision().unwrap()
        );
    }
}

#[test]
fn feed_items_name_their_series_place_link_and_authors() {
    let site = load(sources(true));
    let files = render::generate(&site, &ThemeSet::new()).unwrap();
    let xml = output(&files, "rss.xml");

    // A collaborative part: its authors, its series as a category in the series taxonomy, and the
    // sentence, with the series link, in its full content.
    let l2 = rss_item(xml, "l2");
    for creator in ["Ann", "Bo", "Cy"] {
        assert!(
            l2.contains(&format!("<dc:creator>{creator}</dc:creator>")),
            "{l2}"
        );
    }
    assert!(!l2.contains("<dc:creator>Dee</dc:creator>"), "{l2}");
    assert!(
        l2.contains(&format!(
            "<category domain=\"{SERIES_INDEX}\">Letters</category>"
        )),
        "{l2}"
    );
    assert!(l2.contains("<category>notes</category>"), "{l2}");
    assert!(
        l2.contains(&format!("<p class=\"ob-series-context\">{CONTEXT_L2}</p>")),
        "{l2}"
    );
    // An ordinary part of the same series reads the same way, with its own author.
    let l1 = rss_item(xml, "l1");
    assert!(l1.contains("<dc:creator>Site Owner</dc:creator>"), "{l1}");
    assert!(l1.contains(&format!(
        "<category domain=\"{SERIES_INDEX}\">Letters</category>"
    )));
    assert!(
        l1.contains(&format!("<p class=\"ob-series-context\">{CONTEXT_L1}</p>")),
        "{l1}"
    );
    // An unordered part takes its place in the reading order.
    assert!(rss_item(xml, "l4").contains("Part 4 in the series"));

    let feed: serde_json::Value = serde_json::from_str(output(&files, "feed.json")).unwrap();
    let item = json_item(&feed, "l2");
    assert_eq!(
        item["_openblog"],
        serde_json::json!({"about": feeds::JSON_FEED_EXTENSION_ABOUT, "series": {
            "title": "Letters",
            "url": SERIES_URL,
            "part": 2,
            "parts": 4,
            "authors": ["Ann", "Bo", "Cy"],
            "contributors": ["Site Owner", "Ann", "Bo", "Cy", "Dee"],
        }})
    );
    assert!(item["content_html"].as_str().unwrap().contains(CONTEXT_L2));
    assert!(item["content_text"].as_str().unwrap().contains(
        "Part 2 in the series Letters (https://example.test/series/letters/). This part is by Ann, Bo, and Cy. Series contributors: Site Owner, Ann, Bo, Cy, and Dee."
    ));
    assert_eq!(
        json_item(&feed, "l3")["_openblog"]["series"]["authors"],
        serde_json::json!(["Dee"])
    );
    assert!(json_item(&feed, "g1").get("_openblog").is_none());

    let llms = llms_section(output(&files, "llms-full.txt"), "l2");
    assert!(
        llms.contains(&format!(
            "- Series: Part 2 of 4 in [Letters](<{SERIES_URL}>)\n- Part authors: Ann, Bo, and Cy\n- Series contributors: Site Owner, Ann, Bo, Cy, and Dee\n"
        )),
        "{llms}"
    );

    // A summary-only RSS item still names its series, but RSS has nowhere else to put the series
    // link, place or authors: they are only in the full content (and in JSON Feed's extension).
    let mut summary = load(sources(true));
    summary.config.feeds.full_content = false;
    let xml = feeds::rss(&summary).unwrap();
    let l2 = rss_item(&xml, "l2");
    assert!(!l2.contains("<content:encoded>"));
    assert!(!l2.contains(SERIES_URL), "{l2}");
    assert!(l2.contains(&format!(
        "<category domain=\"{SERIES_INDEX}\">Letters</category>"
    )));
    let feed: serde_json::Value =
        serde_json::from_str(&feeds::json_feed(&summary).unwrap()).unwrap();
    assert_eq!(json_item(&feed, "l2")["_openblog"]["series"]["part"], 2);
    assert_eq!(json_item(&feed, "l2")["content_text"], "About l2.");
}

#[test]
fn portable_copies_link_the_canonical_series() {
    let site = load(sources(true));
    let post = post_of(&site, "l2");
    let projection = PortableProjection::for_site(&site, post).unwrap();
    let html = projection.portable_html().unwrap().html;
    // The context follows the work's own credits and comes before the body.
    let context = html.find("<p class=\"ob-series-context\">").unwrap();
    assert!(html.find("ob-contributions").unwrap() < context);
    assert!(context < html.find("<p>Body of l2.</p>").unwrap());
    assert!(html.contains(CONTEXT_L2), "{html}");

    let markdown = projection.portable_markdown().unwrap();
    assert!(
        markdown.contains(&format!(
            "\n## Series\n\nPart 2 in the series [Letters]({SERIES_URL}). This part is by Ann, Bo, and Cy. Series contributors: Site Owner, Ann, Bo, Cy, and Dee.\n"
        )),
        "{markdown}"
    );
    let text = projection.portable_text().unwrap();
    assert!(text.contains(&format!("Part 2 in the series Letters ({SERIES_URL}).")));
    // The external copy is a different artifact from the context-free one, so syndication sees
    // the change, and the canonical page link is untouched.
    let plain = PortableProjection::from_post(post, &site.config).unwrap();
    assert_ne!(
        projection.source_revision().unwrap(),
        plain.source_revision().unwrap()
    );
    assert_eq!(projection.canonical_url(), "https://example.test/l2/");

    // An ordinary part has no Contributions list but still says who wrote it.
    let l1 = PortableProjection::for_site(&site, post_of(&site, "l1")).unwrap();
    assert!(l1.portable_html().unwrap().html.starts_with(&format!(
        "<p class=\"ob-series-context\">{CONTEXT_L1}</p>\n<p>Body of l1.</p>"
    )));
    assert!(l1.portable_markdown().unwrap().contains(
        "Body of l1.\n\n## Series\n\nPart 1 in the series [Letters](https://example.test/series/letters/). This part is by Site Owner."
    ));
}

#[test]
fn a_later_part_leaves_earlier_parts_copies_unchanged() {
    // Portable copies never state the number of parts, so publishing another part by a known
    // contributor changes neither an earlier part's copy nor its source revision; JSON Feed's
    // extension object still carries the new total.
    let copies = |site: &Site, slug: &str| {
        let projection = PortableProjection::for_site(site, post_of(site, slug)).unwrap();
        (
            projection.portable_html().unwrap().html,
            projection.portable_markdown().unwrap(),
            projection.portable_text().unwrap(),
            projection.source_revision().unwrap(),
        )
    };
    let before = load(sources(true));
    let mut grown = sources(true);
    grown
        .posts
        .push(post("l5", Some("letters"), "2026-08-01", None, ""));
    grown.credits.push(credits("l5", &["ann"], &[]));
    let after = load(grown);
    for slug in ["l1", "l2", "l3", "l4"] {
        assert_eq!(copies(&before, slug), copies(&after, slug), "{slug}");
    }
    assert_eq!(after.series_context(post_of(&after, "l5")).unwrap().part, 5);
    let feed: serde_json::Value = serde_json::from_str(&feeds::json_feed(&after).unwrap()).unwrap();
    assert_eq!(json_item(&feed, "l2")["_openblog"]["series"]["parts"], 5);
}

#[test]
fn a_copy_that_loses_the_series_context_fails_closed() {
    let site = load(sources(true));
    let projection = PortableProjection::for_site(&site, post_of(&site, "l2")).unwrap();
    let html = projection.portable_html().unwrap().html;
    let markdown = projection.portable_markdown().unwrap();
    let text = projection.portable_text().unwrap();
    for (format, artifact) in [
        (RepresentationFormat::Html, html.as_str()),
        (RepresentationFormat::Markdown, markdown.as_str()),
        (RepresentationFormat::Text, text.as_str()),
    ] {
        assert!(projection
            .analyze_portable_artifact(format, artifact)
            .unwrap()
            .is_empty());
        // Losing the link, the place, or a name is a missing fact, never a silent loss.
        for (from, to) in [
            (SERIES_URL, "https://example.test/elsewhere/"),
            ("Part 2 in the series", "Part in the series"),
            ("Series contributors: Site Owner, ", "Series contributors: "),
        ] {
            let broken = artifact.replace(from, to);
            let findings = projection
                .analyze_portable_artifact(format, &broken)
                .unwrap();
            assert!(
                findings
                    .iter()
                    .any(|finding| finding.code == "missing-semantic-fact"
                        && finding.capability_id.as_deref() == Some("series")),
                "{format:?}: dropping `{from}` was accepted"
            );
        }
    }
}

#[test]
fn drafts_scheduled_works_and_their_authors_never_appear() {
    let site = load(sources(true));
    let files = render::generate(&site, &ThemeSet::new()).unwrap();
    for name in ["rss.xml", "feed.json", "llms-full.txt", "llms.txt"] {
        let body = output(&files, name);
        for hidden in ["Eve Hidden", "l-draft", "l-later", "Part 5", "of 6", "of 5"] {
            assert!(!body.contains(hidden), "{name} shows {hidden}");
        }
    }
    for slug in ["l1", "l2", "l3", "l4"] {
        let projection = PortableProjection::for_site(&site, post_of(&site, slug)).unwrap();
        let all = format!(
            "{}{}{}",
            projection.portable_html().unwrap().html,
            projection.portable_markdown().unwrap(),
            projection.portable_text().unwrap()
        );
        assert!(
            !all.contains("Eve") && !all.contains("of 6"),
            "{slug}: {all}"
        );
    }
    // A site loaded with drafts and scheduled works still counts only the public parts, and a
    // draft or a scheduled work has no public context of its own.
    let with_drafts = load_with(sources(true), true);
    for slug in ["l-draft", "l-later"] {
        assert!(with_drafts.posts.iter().any(|post| post.slug == slug));
        assert_eq!(
            with_drafts.series_context(post_of(&with_drafts, slug)),
            None,
            "{slug}"
        );
    }
    let context = with_drafts
        .series_context(post_of(&with_drafts, "l2"))
        .unwrap();
    assert_eq!(
        Some(context.clone()),
        site.series_context(post_of(&site, "l2"))
    );
    assert_eq!((context.part, context.parts), (2, 4));
    assert!(!context.contributors.iter().any(|name| name.contains("Eve")));
    // So does a site previewing the scheduled work, which holds it as a post.
    let preview = Site::load(
        config(),
        sources(true),
        LoadOptions {
            now: DateTime::parse("2030-01-01T00:00:00Z"),
            preview_source: Some("posts/l-later.md".into()),
            ..LoadOptions::default()
        },
    )
    .unwrap();
    assert_eq!(preview.series_context(post_of(&preview, "l-later")), None);
    assert_eq!(
        preview.series_context(post_of(&preview, "l2")),
        Some(context)
    );
    // When the series loses its last collaborative work, its parts' feeds return to the plain
    // output, byte for byte.
    let mut reverted = sources(true);
    reverted
        .credits
        .retain(|sidecar| sidecar.path != "posts/l2.credits.json");
    reverted.credits.push(credits("l2", &["ann"], &[]));
    let reverted = load(reverted);
    assert!(reverted.series_context(post_of(&reverted, "l1")).is_none());
    let reverted_xml = feeds::rss(&reverted).unwrap();
    let plain_xml = feeds::rss(&load(sources(false))).unwrap();
    for slug in ["l1", "l4"] {
        assert_eq!(rss_item(&reverted_xml, slug), rss_item(&plain_xml, slug));
    }
}

#[test]
fn hostile_series_and_contributor_names_stay_text_and_the_build_succeeds() {
    let mut hostile = sources(true);
    hostile.series = vec![file(
        "series/letters.md",
        "---\nname: \"<b>Letters</b> [x](javascript:alert(1)) & co\"\n---\nA premise.\n",
    )];
    hostile
        .credits
        .retain(|sidecar| sidecar.path != "posts/l2.credits.json");
    hostile
        .credits
        .push(credits("l2", &["mal", "kim", "att"], &[]));
    let site = load(hostile);
    let files = render::generate(&site, &ThemeSet::new()).unwrap_or_else(|error| panic!("{error}"));
    let xml = output(&files, "rss.xml");
    let l2 = rss_item(xml, "l2");
    assert!(l2.contains(&format!(
        "<category domain=\"{SERIES_INDEX}\">&lt;b&gt;Letters&lt;/b&gt; [x](javascript:alert(1)) &amp; co</category>"
    )), "{l2}");

    let projection = PortableProjection::for_site(&site, post_of(&site, "l2")).unwrap();
    let html = projection.portable_html().unwrap().html;
    assert!(html.contains(&format!(
        "in the series <a href=\"{SERIES_URL}\">&lt;b&gt;Letters&lt;/b&gt; [x](javascript:alert(1)) &amp; co</a>. This part is by &lt;img src=x onerror=alert(1)&gt; [Mal](javascript:alert(1)) **bold**, Kim &lt;https://kim.example&gt;, and AT&amp;amp;T."
    )), "{html}");
    assert!(!html.contains("<b>") && !html.contains("<img") && !html.contains("href=\"javascript"));

    let markdown = projection.portable_markdown().unwrap();
    assert!(markdown.contains(
        "in the series [\\<b\\>Letters\\</b\\> \\[x\\](javascript:alert(1)) \\& co](https://example.test/series/letters/). This part is by \\<img src=x onerror=alert(1)\\> \\[Mal\\](javascript:alert(1)) \\*\\*bold\\*\\*, Kim \\<https://kim.example\\>, and AT\\&amp;T."
    ), "{markdown}");

    let feed: serde_json::Value = serde_json::from_str(output(&files, "feed.json")).unwrap();
    assert_eq!(
        json_item(&feed, "l2")["_openblog"]["series"]["title"],
        "<b>Letters</b> [x](javascript:alert(1)) & co"
    );
    let llms = llms_section(output(&files, "llms-full.txt"), "l2");
    assert!(llms.contains(
        "- Series: Part 2 of 4 in [\\<b>Letters\\</b> \\[x\\](javascript:alert(1)) \\& co](<https://example.test/series/letters/>)"
    ), "{llms}");
    assert!(
        llms.contains("Kim \\<https://kim.example>, and AT\\&amp;T"),
        "{llms}"
    );
}
