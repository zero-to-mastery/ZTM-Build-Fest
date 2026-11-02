//! The `compare` fence on the page, in a portable copy, and as a validation error (ADR 0291).

use openblog_core::{
    markdown::{render, RenderOptions},
    portability::PortableProjection,
    LoadOptions, Site, SiteConfig, SourceFile, Sources,
};

const PAIR: &str = "```compare\nbefore: /images/floor-before.jpg\nbefore-alt: The old floor, stained along the door\nbefore-caption: Day one\nafter: https://cdn.example/floor-after.jpg\nafter-alt: The same floor, sanded and sealed\nafter-label: Finished\n```\n";

fn site(body: &str) -> (SiteConfig, Site) {
    let config = SiteConfig::from_json(
        r#"{ "title": "Fixture", "url": "https://example.test/blog", "postPath": "/{slug}/",
             "author": { "name": "Site Author" } }"#,
    )
    .unwrap();
    let site = Site::load(
        config.clone(),
        Sources {
            posts: vec![SourceFile {
                path: "posts/floor.md".into(),
                contents: format!("---\ntitle: Floor\ndate: 2026-10-01\n---\n{body}"),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"));
    (config, site)
}

#[test]
fn the_page_gets_the_element_around_two_captioned_figures() {
    let rendered = render(PAIR, RenderOptions::default());
    assert!(rendered.errors.is_empty(), "{:?}", rendered.errors);
    assert!(rendered.html.contains("<ob-compare class=\"ob-compare\">"));
    assert!(rendered.html.contains("</ob-compare>"));
    assert_eq!(rendered.html.matches("<figure").count(), 2);
    assert_eq!(rendered.html.matches("<figcaption>").count(), 2);
    assert!(rendered.html.contains("<img loading=\"lazy\" decoding=\"async\" src=\"/images/floor-before.jpg\" alt=\"The old floor, stained along the door\">"));
    assert_eq!(rendered.capabilities.len(), 1);
    assert_eq!(rendered.capabilities[0].id, "before-after");
    assert_eq!(rendered.capabilities[0].native_renderer, Some("ob-compare"));
    assert!(!rendered.code_languages.contains(&"compare".to_string()));
}

#[test]
fn missing_alt_text_is_an_error_with_a_plain_message() {
    let rendered = render(
        "```compare\nbefore: /a.jpg\nafter: /b.jpg\nafter-alt: B\n```\n",
        RenderOptions::default(),
    );
    assert_eq!(rendered.errors.len(), 1);
    assert!(
        rendered.errors[0].contains(
            "the before picture needs a description for people who cannot see it; add a `before-alt:` line"
        ),
        "{:?}",
        rendered.errors
    );
    assert!(rendered.html.contains("ob-compare-error"));
    assert!(!rendered.html.contains("<img"));
}

#[test]
fn a_portable_copy_is_two_figures_with_captions_and_nothing_else() {
    let (config, site) = site(PAIR);
    let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
    let output = projection.portable_html().unwrap();
    assert_eq!(
        output.html,
        "<figure class=\"ob-compare-pane\"><img loading=\"lazy\" decoding=\"async\" src=\"https://example.test/blog/images/floor-before.jpg\" alt=\"The old floor, stained along the door\"><figcaption>Before: Day one</figcaption></figure>\n<figure class=\"ob-compare-pane\"><img loading=\"lazy\" decoding=\"async\" src=\"https://cdn.example/floor-after.jpg\" alt=\"The same floor, sanded and sealed\"><figcaption>Finished</figcaption></figure>\n"
    );
    assert!(!output.html.contains("ob-compare>"));
    assert_eq!(output.capabilities[0].id, "before-after");
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let urls: Vec<_> = output
        .images
        .iter()
        .map(|image| image.url.as_str())
        .collect();
    assert_eq!(
        urls,
        [
            "https://example.test/blog/images/floor-before.jpg",
            "https://cdn.example/floor-after.jpg"
        ]
    );
}

#[test]
fn portable_markdown_and_text_keep_both_pictures_and_captions() {
    let (config, site) = site(PAIR);
    let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
    let markdown = projection.portable_markdown().unwrap();
    assert!(markdown.contains("![The old floor, stained along the door](https://example.test/blog/images/floor-before.jpg)\n\n*Before: Day one*"), "{markdown}");
    assert!(markdown.contains("![The same floor, sanded and sealed](https://cdn.example/floor-after.jpg)\n\n*Finished*"), "{markdown}");
    assert!(!markdown.contains("```compare"));
    let text = projection.portable_text().unwrap();
    assert!(
        text.contains("Before: Day one") && text.contains("Finished"),
        "{text}"
    );
}

#[test]
fn a_placeholder_description_is_flagged_by_the_accessibility_audit() {
    use openblog_core::accessibility::{audit_document, DocumentAuditInput, FindingCode};
    let audit = |markdown| {
        audit_document(DocumentAuditInput {
            path: "posts/floor.md",
            markdown,
            body_line: 1,
            embeds_enabled: true,
            cover_alt: None,
        })
    };
    assert!(audit(PAIR).is_empty());
    let findings = audit("Intro.\n\n```compare\nbefore: /a.jpg\nbefore-alt: floor.jpg\nafter: /b.jpg\nafter-alt: A sealed floor\n```\n");
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::ImageAltPlaceholder);
    assert_eq!(findings[0].source.line(), Some(3));
}

#[test]
fn a_site_without_a_compare_fence_renders_as_before() {
    let rendered = render(
        "Hello.\n\n```rust\nfn main() {}\n```\n",
        RenderOptions::default(),
    );
    assert!(!rendered.html.contains("ob-compare"));
    assert!(rendered.capabilities.is_empty());
}
