//! Source attribution for shared reflections reaches native pages, feeds, and portable exports
//! as the approved public subset only (ADR 0008).

use openblog_core::collaboration::{
    NewParticipant, NewSharedPublication, NewSourceReference, SharedPublication, SourceKind,
};
use openblog_core::config::SiteConfig;
use openblog_core::feeds;
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::portability::{PortableProjection, RepresentationFormat};
use openblog_core::render;
use openblog_core::shared_source::SharedAttribution;
use openblog_core::theme::ThemeSet;

const CONFIG: &str = r#"{"title":"T","url":"https://example.test","postPath":"/{slug}/","author":{"name":"Author"}}"#;

/// Private values that must never appear in any public output.
const PRIVATE: &[&str] = &[
    "ada-admin",
    "Ada Private",
    "Private working title",
    "shared-0a1b2c3d4e5f",
    "978-0-14-143954-9",
    "George Eliot",
    "Blackwood",
    "1871",
    "source-1",
    "invitation",
    "adminUser",
    "contributorId",
    "C:\\Users",
    "C:/Users",
    "/home/",
    "file:",
    ".openblog",
];

fn record(source: NewSourceReference, question: &str) -> SharedPublication {
    SharedPublication::create(&NewSharedPublication {
        publication_id: "shared-0a1b2c3d4e5f".into(),
        title: "Private working title".into(),
        guiding_question: question.into(),
        sources: vec![source],
        creator: NewParticipant {
            admin_user: "ada-admin".into(),
            contributor_id: "ada".into(),
            display_name: "Ada Private".into(),
        },
    })
    .expect("record")
}

fn book() -> NewSourceReference {
    NewSourceReference {
        kind: SourceKind::Book,
        title: "Middlemarch & <Marriage>".into(),
        url: "https://example.org/books/middlemarch?a=1&b=2".into(),
        creator: "George Eliot".into(),
        publisher: "Blackwood".into(),
        published: "1871".into(),
        isbn: "978-0-14-143954-9".into(),
    }
}

fn post_source(attribution: &SharedAttribution, extra: &str) -> String {
    format!(
        "---\ntitle: Reflection\ndate: 2026-10-01\n{}{extra}---\nBody paragraph.\n",
        attribution.front_matter_lines()
    )
}

fn load(contents: &str, options: LoadOptions) -> Result<Site, String> {
    Site::load(
        SiteConfig::from_json(CONFIG).unwrap(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/reflection.md".into(),
                contents: contents.into(),
            }],
            ..Default::default()
        },
        options,
    )
    .map_err(|errors| errors.join("; "))
}

fn assert_clean(label: &str, output: &str) {
    for needle in PRIVATE {
        assert!(!output.contains(needle), "{label} leaked `{needle}`");
    }
}

#[test]
fn the_public_subset_is_title_link_type_and_question_only() {
    let attribution = SharedAttribution::from_record(&record(book(), "What is a good life?"))
        .expect("attribution");
    assert_eq!(
        attribution.question.as_deref(),
        Some("What is a good life?")
    );
    let source = attribution.source.as_ref().unwrap();
    assert_eq!(source.kind, SourceKind::Book);
    assert_eq!(source.title, "Middlemarch & <Marriage>");
    assert_eq!(
        source.url.as_deref(),
        Some("https://example.org/books/middlemarch?a=1&b=2")
    );
    assert_clean("front matter", &attribution.front_matter_lines());
}

#[test]
fn native_page_preview_feeds_and_exports_show_source_and_question() {
    let attribution =
        SharedAttribution::from_record(&record(book(), "What is a good life?")).unwrap();
    let contents = post_source(&attribution, "");
    let site = load(&contents, LoadOptions::default()).unwrap();

    let files = render::generate(&site, &ThemeSet::new()).unwrap();
    let page = &files
        .iter()
        .find(|file| file.path == "reflection/index.html")
        .unwrap()
        .contents;
    assert!(page.contains("<strong>Guiding question:</strong> What is a good life?"));
    assert!(page.contains("<strong>Source (Book):</strong> <a href=\"https://example.org/books/middlemarch?a=1&amp;b=2\" rel=\"noopener\">Middlemarch &amp; &lt;Marriage&gt;</a>"));
    for file in &files {
        assert_clean(&file.path, &file.contents);
    }

    let post = &site.posts[0];
    let projection = PortableProjection::from_post(post, &site.config).unwrap();
    let html = projection.portable_html().unwrap().html;
    let markdown = projection.portable_markdown().unwrap();
    let text = projection
        .representation(RepresentationFormat::Text)
        .to_string();
    let text = projection.portable_text().unwrap_or(text);
    assert!(html.contains("Guiding question:"));
    assert!(html.contains("href=\"https://example.org/books/middlemarch?a=1&amp;b=2\""));
    assert!(markdown.contains("Guiding question: What is a good life?"));
    assert!(markdown.contains(
        r"Source (Book): [Middlemarch \& \<Marriage\>](https://example.org/books/middlemarch?a=1&b=2)"
    ));
    assert!(text.contains("What is a good life?"));
    assert!(text.contains("Middlemarch"));
    assert!(text.contains("https://example.org/books/middlemarch?a=1&b=2"));

    let rss = feeds::rss(&site).unwrap();
    let json = feeds::json_feed(&site).unwrap();
    let llms = feeds::llms_full(&site).unwrap();
    assert!(rss.contains("Guiding question:"));
    assert!(json.contains("Guiding question:"));
    assert!(llms.contains("What is a good life?"), "{llms}");
    for (label, output) in [
        ("html", &html),
        ("markdown", &markdown),
        ("text", &text),
        ("rss", &rss),
        ("json feed", &json),
        ("llms-full", &llms),
        ("sitemap", &feeds::sitemap(&site, &[])),
        ("search index", &feeds::search_index(&site)),
    ] {
        assert_clean(label, output);
    }
}

#[test]
fn a_draft_previews_natively_but_stays_out_of_public_output() {
    let attribution = SharedAttribution::from_record(&record(book(), "Why?")).unwrap();
    let contents = post_source(&attribution, "draft: true\n");
    let public = load(&contents, LoadOptions::default()).unwrap();
    assert!(public.posts.is_empty());
    for file in render::generate(&public, &ThemeSet::new()).unwrap() {
        assert!(!file.contents.contains("Middlemarch"), "{}", file.path);
    }

    let preview = load(
        &contents,
        LoadOptions {
            preview_source: Some("posts/reflection.md".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let page = PortableProjection::for_authenticated_preview(&preview.posts[0], &preview.config)
        .unwrap()
        .portable_html()
        .unwrap()
        .html;
    assert!(page.contains("Middlemarch"));
    assert_clean("preview", &page);
}

#[test]
fn an_unsupported_provider_or_missing_link_still_names_the_source() {
    let mut video = book();
    video.kind = SourceKind::Video;
    video.isbn.clear();
    video.title = "A talk on an unknown host".into();
    video.url = "https://video.unknown.example/watch/42".into();
    let attribution = SharedAttribution::from_record(&record(video, "")).unwrap();
    let site = load(&post_source(&attribution, ""), LoadOptions::default()).unwrap();
    let page = &render::generate(&site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .find(|file| file.path == "reflection/index.html")
        .unwrap()
        .contents;
    assert!(!page.contains("<iframe"));
    assert!(page.contains("<a href=\"https://video.unknown.example/watch/42\" rel=\"noopener\">A talk on an unknown host</a>"));
    assert!(!page.contains("Guiding question"));

    // Offline authoring: a title alone is enough, and no link is invented.
    let titled = SharedAttribution::from_front_matter(
        &openblog_core::frontmatter::parse("---\nsharedSourceTitle: Notes\n---\n")
            .unwrap()
            .front_matter,
    )
    .unwrap()
    .unwrap();
    assert!(titled.source.as_ref().unwrap().url.is_none());
    assert!(!titled.html().contains("<a "));
}

#[test]
fn a_recognised_video_is_a_link_in_every_output_never_an_embed() {
    let mut video = book();
    video.kind = SourceKind::Video;
    video.isbn.clear();
    video.title = "The Art of Noticing".into();
    video.url = "https://www.youtube.com/watch?v=abc123".into();
    let attribution = SharedAttribution::from_record(&record(video, "")).unwrap();
    let site = load(&post_source(&attribution, ""), LoadOptions::default()).unwrap();
    for file in render::generate(&site, &ThemeSet::new()).unwrap() {
        assert!(!file.contents.contains("<iframe"), "{}", file.path);
    }
    let html = PortableProjection::from_post(&site.posts[0], &site.config)
        .unwrap()
        .portable_html()
        .unwrap()
        .html;
    assert!(html.contains("href=\"https://www.youtube.com/watch?v=abc123\""));
}

#[test]
fn unsafe_published_values_fail_the_load_without_producing_output() {
    for (extra, expected) in [
        (
            "sharedSourceTitle: T\nsharedSourceUrl: javascript:alert(1)\n",
            "sharedSourceUrl",
        ),
        (
            "sharedSourceTitle: T\nsharedSourceUrl: file:///C:/Users/me/secret\n",
            "sharedSourceUrl",
        ),
        (
            "sharedSourceTitle: T\nsharedSourceUrl: https://user:pw@example.org/x\n",
            "sharedSourceUrl",
        ),
        (
            "sharedSourceTitle: T\nsharedSourceType: Painting\n",
            "sharedSourceType",
        ),
        (
            "sharedSourceUrl: https://example.org/x\n",
            "sharedSourceTitle",
        ),
        ("guidingQuestion: \"two\\nlines\"\n", "guidingQuestion"),
    ] {
        let source = format!("---\ntitle: R\ndate: 2026-10-01\n{extra}---\nBody\n");
        let error = load(&source, LoadOptions::default()).expect_err(extra);
        assert!(error.contains(expected), "{error}");
        assert!(error.contains("posts/reflection.md"), "{error}");
    }
    let long = "x".repeat(1_001);
    let source = format!("---\ntitle: R\ndate: 2026-10-01\nguidingQuestion: {long}\n---\nBody\n");
    assert!(load(&source, LoadOptions::default()).is_err());
}

#[test]
fn hostile_text_is_escaped_in_every_representation() {
    let mut hostile = book();
    hostile.title = "<script>alert(1)</script> [x](javascript:alert(1))".into();
    let attribution =
        SharedAttribution::from_record(&record(hostile, "<img src=x onerror=alert(1)>?")).unwrap();
    let site = load(&post_source(&attribution, ""), LoadOptions::default()).unwrap();
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let html = projection.portable_html().unwrap().html;
    let markdown = projection.portable_markdown().unwrap();
    assert!(!html.contains("<script>") && !html.contains("<img"));
    assert!(html.contains("&lt;script&gt;"));
    assert!(markdown.contains(r"\[x\]"), "{markdown}");
    assert!(!html.contains("href=\"javascript:"));
    let page = &render::generate(&site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .find(|file| file.path == "reflection/index.html")
        .unwrap()
        .contents;
    assert!(!page.contains("<script>alert(1)"));
    assert!(!page.contains("<img src=x"));
}

#[test]
fn posts_without_attribution_are_unchanged() {
    let site = load(
        "---\ntitle: Plain\ndate: 2026-10-01\n---\nBody\n",
        LoadOptions::default(),
    )
    .unwrap();
    assert!(site.posts[0].shared_attribution.is_none());
    for file in render::generate(&site, &ThemeSet::new()).unwrap() {
        assert!(!file.contents.contains("ob-shared-source"), "{}", file.path);
    }
    let html = PortableProjection::from_post(&site.posts[0], &site.config)
        .unwrap()
        .portable_html()
        .unwrap()
        .html;
    assert!(!html.contains("ob-shared-source"));
}

#[test]
fn a_record_whose_link_is_no_longer_public_drops_the_link_not_the_title() {
    let mut stored = record(book(), "Q?");
    stored.sources[0].url = Some("file:///C:/Users/ada/notes.html".into());
    let attribution = SharedAttribution::from_record(&stored).unwrap();
    let source = attribution.source.unwrap();
    assert!(source.url.is_none());
    assert_eq!(source.title, "Middlemarch & <Marriage>");
}

#[test]
fn tildes_in_public_text_stay_literal_and_never_break_the_build() {
    let source = "---
title: R
date: 2026-10-01
guidingQuestion: \"Is ~this~ fine?\"
sharedSourceTitle: \"About ~5 to ~10 mins\"
---
Body
";
    let site = load(source, LoadOptions::default()).unwrap();
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let markdown = projection.portable_markdown().unwrap();
    assert!(markdown.contains(r"Is \~this\~ fine?"), "{markdown}");
    let text = projection.portable_text().unwrap();
    assert!(text.contains("Is ~this~ fine?"), "{text}");
    let json = feeds::json_feed(&site).unwrap();
    assert!(json.contains("Is ~this~ fine?"), "{json}");
    assert!(render::generate(&site, &ThemeSet::new()).is_ok());
}
