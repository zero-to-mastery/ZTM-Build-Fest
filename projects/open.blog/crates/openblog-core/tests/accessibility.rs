use openblog_core::accessibility::{
    audit_document, audit_site_language, AuditOutcome, AuditScope, DocumentAuditInput, FindingCode,
};
use openblog_core::{LoadOptions, Site, SiteConfig, SourceFile, Sources};

#[test]
fn empty_text_link_is_a_located_detected_issue() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/example.md",
        markdown: "Intro.\n\nA [](/destination) link.\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    let finding = &findings[0];
    assert_eq!(finding.code, FindingCode::LinkNameEmpty);
    assert_eq!(finding.outcome, AuditOutcome::Detected);
    assert_eq!(finding.source.path, "posts/example.md");
    assert_eq!(finding.source.line(), Some(3));
    assert!(finding.message.contains("accessible name"));
    assert!(!finding.repair.is_empty());
}

#[test]
fn empty_markdown_image_alt_is_a_review_task_not_a_failure() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/chart.md",
        markdown: "Context.\n\n![](/images/chart.png)\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::ImageAltReview);
    assert_eq!(findings[0].outcome, AuditOutcome::NeedsReview);
    assert_eq!(findings[0].source.line(), Some(3));
    assert!(findings[0].message.contains("decorative"));
}

#[test]
fn filename_like_image_alt_is_only_a_potential_issue() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/chart.md",
        markdown: "![quarterly-results.png](/images/chart.png)\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::ImageAltPlaceholder);
    assert_eq!(findings[0].outcome, AuditOutcome::Potential);
    assert!(findings[0].repair.contains("purpose"));
}

#[test]
fn common_placeholder_image_alt_is_a_potential_issue() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/photo.md",
        markdown: "![image](/images/sunset.webp)\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::ImageAltPlaceholder);
    assert_eq!(findings[0].outcome, AuditOutcome::Potential);
}

#[test]
fn empty_cover_alt_is_located_in_front_matter_for_review() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/cover.md",
        markdown: "Body.\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: Some(""),
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::ImageAltReview);
    assert_eq!(findings[0].outcome, AuditOutcome::NeedsReview);
    assert_eq!(findings[0].source.line(), None);
    assert_eq!(findings[0].source.field(), Some("coverAlt"));
}

#[test]
fn placeholder_cover_alt_is_a_front_matter_potential_issue() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/cover.md",
        markdown: "Body.\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: Some("cover-photo.jpg"),
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::ImageAltPlaceholder);
    assert_eq!(findings[0].outcome, AuditOutcome::Potential);
    assert_eq!(findings[0].source.field(), Some("coverAlt"));
}

#[test]
fn skipped_heading_level_is_a_located_potential_issue() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/outline.md",
        markdown: "## Context\n\n#### Detail\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::HeadingLevelSkip);
    assert_eq!(findings[0].outcome, AuditOutcome::Potential);
    assert_eq!(findings[0].source.line(), Some(3));
    assert!(findings[0].message.contains("H2 to H4"));
}

#[test]
fn first_body_heading_is_checked_after_the_generated_page_title() {
    let findings = audit_document(DocumentAuditInput {
        path: "pages/about.md",
        markdown: "### Background\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::HeadingLevelSkip);
    assert!(findings[0].message.contains("H1 to H3"));
}

#[test]
fn generic_link_phrase_is_a_potential_issue_not_a_certain_failure() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/links.md",
        markdown: "For the full report, [read more](/report).\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::LinkPurposeReview);
    assert_eq!(findings[0].outcome, AuditOutcome::Potential);
    assert!(findings[0].message.contains("read more"));
}

#[test]
fn tables_create_one_structure_review_task_per_document() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/data.md",
        markdown: "| A | B |\n| - | - |\n| 1 | 2 |\n\n| C | D |\n| - | - |\n| 3 | 4 |\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::TableStructureReview);
    assert_eq!(findings[0].outcome, AuditOutcome::NeedsReview);
    assert_eq!(findings[0].source.line(), Some(1));
    assert!(findings[0].repair.contains("headers"));
}

#[test]
fn raw_html_creates_one_bounded_review_task() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/custom.md",
        markdown: "<aside>Custom</aside>\n\nText with <span>inline HTML</span>.\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::RawHtmlReview);
    assert_eq!(findings[0].outcome, AuditOutcome::NeedsReview);
    assert_eq!(findings[0].source.line(), Some(1));
}

#[test]
fn raw_html_inside_a_link_defers_its_name_to_review() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/custom-link.md",
        markdown: "[<span aria-label=\"Open demo\"></span>](/demo)\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::RawHtmlReview);
    assert!(!findings
        .iter()
        .any(|finding| finding.code == FindingCode::LinkNameEmpty));
}

#[test]
fn earlier_raw_html_does_not_make_a_later_custom_link_name_certain() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/custom-link.md",
        markdown: "<aside>Note</aside>\n\n[<span aria-label=\"Open demo\"></span>](/demo)\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::RawHtmlReview);
}

#[test]
fn locations_include_the_canonical_front_matter_line_offset() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/offset.md",
        markdown: "Intro.\n\n#### Detail\n",
        body_line: 7,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::HeadingLevelSkip);
    assert_eq!(findings[0].source.line(), Some(9));
}

#[test]
fn codepen_url_in_a_code_fence_is_not_a_rendered_embed() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/code.md",
        markdown: "```text\nhttps://codepen.io/example/pen/abc123\n```\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert!(findings.is_empty());
}

#[test]
fn blockquoted_standalone_link_follows_production_embed_semantics() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/demo.md",
        markdown: "> [Open the demo](https://codepen.io/example/pen/abc123)\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::EmbedAccessibilityReview);
}

#[test]
fn multiline_link_is_not_reported_when_production_does_not_embed_it() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/demo.md",
        markdown: "[Open the demo\n](https://codepen.io/example/pen/abc123)\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert!(findings.is_empty());
}

#[test]
fn inline_codepen_link_is_not_reported_as_a_rendered_embed() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/demo.md",
        markdown: "Compare the [demo](https://codepen.io/example/pen/abc123) with production.\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert!(findings.is_empty());
}

#[test]
fn standalone_codepen_link_is_not_an_embed_when_embeds_are_disabled() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/demo.md",
        markdown: "[Open the demo](https://codepen.io/example/pen/abc123)\n",
        body_line: 1,
        embeds_enabled: false,
        cover_alt: None,
    });

    assert!(findings.is_empty());
}

#[test]
fn linked_audio_or_video_creates_one_alternatives_review_task() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/talk.md",
        markdown:
            "[Watch the recorded talk](/media/talk.mp4) and [download audio](/media/talk.mp3).\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::MediaAlternativesReview);
    assert_eq!(findings[0].outcome, AuditOutcome::NeedsReview);
    assert_eq!(findings[0].source.line(), Some(1));
    assert!(findings[0].repair.contains("captions"));
}

#[test]
fn rendered_embed_creates_an_embed_review_task() {
    let findings = audit_document(DocumentAuditInput {
        path: "posts/demo.md",
        markdown: "[Open the demo](https://codepen.io/example/pen/abc123)\n",
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    });

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::EmbedAccessibilityReview);
    assert_eq!(findings[0].scope, AuditScope::Embed);
    assert_eq!(findings[0].source.line(), Some(1));
}

#[test]
fn missing_site_language_is_one_site_scoped_detected_issue() {
    let findings = audit_site_language("openblog.json", "  ");

    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::DocumentLanguageMissing);
    assert_eq!(findings[0].outcome, AuditOutcome::Detected);
    assert_eq!(findings[0].scope, AuditScope::Site);
    assert_eq!(findings[0].source.path, "openblog.json");
    assert_eq!(findings[0].source.field(), Some("language"));
    assert!(audit_site_language("openblog.json", "en-US").is_empty());
}

#[test]
fn finding_json_keeps_stable_codes_and_flat_optional_locations() {
    let finding = audit_document(DocumentAuditInput {
        path: "posts/example.md",
        markdown: "[](/destination)\n",
        body_line: 4,
        embeds_enabled: true,
        cover_alt: None,
    })
    .remove(0);
    let json = serde_json::to_value(finding).unwrap();

    assert_eq!(json["code"], "link-name-empty");
    assert_eq!(json["outcome"], "detected");
    assert_eq!(json["scope"], "content");
    assert_eq!(json["source"]["path"], "posts/example.md");
    assert_eq!(json["source"]["line"], 4);
    assert_eq!(json["source"]["column"], 1);
    assert!(json["source"]["field"].is_null());
}

#[test]
fn site_model_collects_site_and_document_findings_without_mixing_warnings() {
    let mut config = SiteConfig::default();
    config.language.clear();
    let site = Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: "posts/example.md".into(),
                contents:
                    "---\ntitle: Example post\ndate: 2026-10-23\n---\nIntro.\n\n[](/destination)\n"
                        .into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();

    assert_eq!(site.accessibility.len(), 2);
    assert_eq!(
        site.accessibility[0].code,
        FindingCode::DocumentLanguageMissing
    );
    assert_eq!(site.accessibility[1].code, FindingCode::LinkNameEmpty);
    assert_eq!(site.accessibility[1].source.path, "posts/example.md");
    assert_eq!(site.accessibility[1].source.line(), Some(7));
    assert!(!site
        .warnings
        .iter()
        .any(|warning| warning.contains("accessible name")));
}

#[test]
fn site_model_audits_page_and_series_markdown_too() {
    let site = Site::load(
        SiteConfig::default(),
        Sources {
            series: vec![SourceFile {
                path: "series/guide.md".into(),
                contents: "---\nname: Guide\n---\n[](/series-link)\n".into(),
            }],
            pages: vec![SourceFile {
                path: "pages/about.md".into(),
                contents: "---\ntitle: About\n---\n[](/page-link)\n".into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap();

    let paths: Vec<_> = site
        .accessibility
        .iter()
        .map(|finding| finding.source.path.as_str())
        .collect();
    assert_eq!(paths, ["series/guide.md", "pages/about.md"]);
    assert!(site
        .accessibility
        .iter()
        .all(|finding| finding.code == FindingCode::LinkNameEmpty));
}

#[test]
fn a_reflection_arrangement_frame_is_not_custom_markup_but_stray_html_still_is() {
    use openblog_core::reflection::{compose, ComposedTurn, Placement, ReflectionLayout};
    let names = ["Ann", "Bo", "Cy"];
    let turns = names
        .iter()
        .enumerate()
        .map(|(i, name)| ComposedTurn {
            round: 0,
            round_prompt: (i == 0).then_some("Around the table"),
            display_name: name,
            label: None,
            placement: Placement { lane: i, lanes: 3 },
            body: format!("Words of {name}.\n"),
        })
        .collect::<Vec<_>>();
    let framed = compose(ReflectionLayout::Roundtable, &turns);
    let audit = |markdown: &str| {
        audit_document(DocumentAuditInput {
            path: "posts/shared-0a1b2c3d4e5f.md",
            markdown,
            body_line: 1,
            embeds_enabled: true,
            cover_alt: None,
        })
    };
    assert!(audit(&framed).is_empty(), "{:?}", audit(&framed));
    // Anything outside the closed grammar is not the frame, so it is reviewed as before.
    let stray = format!("{framed}\n<div onclick=\"x()\">Mine</div>\n");
    let findings = audit(&stray);
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::RawHtmlReview);
}

fn moments_block() -> String {
    use openblog_core::published_moment::{
        block_markdown, PublicMoment, PublicMomentLink, PublicQuotation,
    };
    block_markdown(&[PublicMoment {
        location: "The Art of Noticing (Video), from 1:02 to 1:10".into(),
        noted_by: "Ann".into(),
        quotation: Some(PublicQuotation {
            text: "Look again".into(),
            language: Some("fr".into()),
            attribution: "The host, in The Art of Noticing (Video), from 1:02 to 1:10".into(),
        }),
        observation: Some("I *noticed* [this](https://example.org/a).".into()),
        link: Some(PublicMomentLink {
            href: "https://www.youtube.com/watch?v=abcdefghijk&t=62s".into(),
            label: "Open The Art of Noticing at 1:02".into(),
        }),
    }])
}

fn audit_shared(markdown: &str) -> Vec<openblog_core::accessibility::AccessibilityFinding> {
    audit_document(DocumentAuditInput {
        path: "posts/shared-0a1b2c3d4e5f.md",
        markdown,
        body_line: 1,
        embeds_enabled: true,
        cover_alt: None,
    })
}

#[test]
fn a_moments_frame_is_not_custom_markup_but_stray_html_before_it_still_is() {
    let body = format!("Ann words.\n\n---\n\n{}", moments_block());
    assert!(audit_shared(&body).is_empty(), "{:?}", audit_shared(&body));
    let stray = format!(
        "Ann <b onclick=\"x()\">words</b>.\n\n---\n\n{}",
        moments_block()
    );
    let findings = audit_shared(&stray);
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::RawHtmlReview);
    assert_eq!(findings[0].source.line(), Some(1));
}

#[test]
fn an_arranged_reflection_with_a_conversation_and_moments_keeps_its_exemption() {
    use openblog_core::reflection::{compose, ComposedTurn, Placement, ReflectionLayout};
    let names = ["Ann", "Bo"];
    let turns = names
        .iter()
        .enumerate()
        .map(|(i, name)| ComposedTurn {
            round: 0,
            round_prompt: None,
            display_name: name,
            label: None,
            placement: Placement { lane: i, lanes: 2 },
            body: format!("Words of {name}.\n"),
        })
        .collect::<Vec<_>>();
    let framed = compose(ReflectionLayout::Roundtable, &turns);
    let body = format!(
        "{framed}\n\n---\n\n## Conversation\n\nAnn: a reply.\n\n---\n\n{}",
        moments_block()
    );
    assert!(audit_shared(&body).is_empty(), "{:?}", audit_shared(&body));
    // HTML in the conversation, before the moments, is still reviewed.
    let stray = body.replace("a reply.", "a <span>reply</span>.");
    let findings = audit_shared(&stray);
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].code, FindingCode::RawHtmlReview);
}
