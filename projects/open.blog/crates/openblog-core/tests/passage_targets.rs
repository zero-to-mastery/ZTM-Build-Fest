//! Passage targets (ADRs 0076 and 0077): the shared fixtures the browser
//! module also reads (duplicate text, Unicode, moved, deleted and renumbered
//! passages, versions), the passage text a post publishes, bounds and
//! escaping, and failures that stay with the one target that caused them.

use openblog_core::passage_target::{
    is_passage_revision, PassageDocument, PassageSelector, PassageTarget, Resolution,
    TargetErrorCode, MAX_TARGET_JSON_BYTES,
};
use openblog_core::{LoadOptions, Site, SiteConfig, SourceFile, Sources};
use serde_json::{json, Value};

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/passage-targets.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("fixture JSON")
}

fn document(fixture: &Value, name: &str) -> PassageDocument {
    let sections = fixture["documents"][name]["sections"]
        .as_array()
        .expect("sections")
        .iter()
        .map(|section| {
            (
                section["anchor"].as_str().map(str::to_string),
                section["text"].as_str().expect("text").to_string(),
            )
        })
        .collect();
    PassageDocument::from_sections(sections)
}

fn code(code: TargetErrorCode) -> Value {
    serde_json::to_value(code).unwrap()
}

#[test]
fn fixture_documents_have_the_revisions_and_digests_the_build_computes() {
    let fixture = fixture();
    let mut computed = serde_json::Map::new();
    for name in fixture["documents"].as_object().unwrap().keys() {
        computed.insert(
            name.clone(),
            serde_json::to_value(document(&fixture, name)).unwrap(),
        );
    }
    let computed = Value::Object(computed);
    assert_eq!(
        computed,
        fixture["documents"],
        "documents as computed:\n{}",
        serde_json::to_string_pretty(&json!({ "documents": computed })).unwrap()
    );
    for document in computed.as_object().unwrap().values() {
        assert!(is_passage_revision(document["revision"].as_str().unwrap()));
    }
}

#[test]
fn fixture_targets_resolve_or_are_explicitly_stale() {
    let fixture = fixture();
    for case in fixture["resolve"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let doc = document(&fixture, case["document"].as_str().unwrap());
        let seen = match (case["seenDocument"].as_str(), case["seenRevision"].as_str()) {
            (Some(other), _) => Some(document(&fixture, other).revision),
            (_, Some(revision)) => Some(revision.to_string()),
            _ => None,
        };
        let target = PassageTarget::from_value(&case["target"])
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let before = doc.clone();
        let resolution = doc.resolve(&target, seen.as_deref());
        assert_eq!(
            serde_json::to_value(&resolution).unwrap(),
            case["expect"],
            "{name}"
        );
        assert_eq!(doc, before, "{name}: resolving never changes the document");
        // A resolved target points at exactly the text it quoted.
        if let (Some(location), PassageSelector::Quote(quote)) =
            (resolution.location(), &target.selector)
        {
            assert_eq!(
                doc.text_at(location).as_deref(),
                Some(quote.exact.as_str()),
                "{name}"
            );
        }
    }
}

#[test]
fn fixture_selections_become_bounded_targets() {
    let fixture = fixture();
    for case in fixture["create"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let doc = document(&fixture, case["document"].as_str().unwrap());
        let index = case["section"].as_u64().unwrap() as usize;
        let start = case["start"].as_u64().unwrap() as usize;
        let end = case["end"].as_u64().unwrap() as usize;
        match doc.quote(index, start, end) {
            Ok(target) => {
                assert_eq!(target.to_value(), case["expect"]["target"], "{name}");
                assert!(
                    matches!(
                        doc.resolve(&target, Some(&doc.revision)),
                        Resolution::Current(_)
                    ),
                    "{name}: a fresh target is current"
                );
            }
            Err(error) => assert_eq!(code(error.code), case["expect"]["error"], "{name}"),
        }
    }
}

#[test]
fn fixture_targets_are_validated_without_repair() {
    let fixture = fixture();
    for case in fixture["invalid"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let result = match case["raw"].as_str() {
            Some(raw) => PassageTarget::from_json(raw),
            None => PassageTarget::from_value(&case["target"]),
        };
        match (&result, case["error"].as_str()) {
            (Ok(target), None) => {
                let again = PassageTarget::from_json(&target.to_json()).unwrap();
                assert_eq!(&again, target, "{name}: round trip");
            }
            (Err(error), Some(expected)) => {
                assert_eq!(code(error.code), json!(expected), "{name}");
            }
            _ => panic!("{name}: unexpected {result:?}"),
        }
    }
}

#[test]
fn errors_name_the_field_and_never_repeat_the_text() {
    let secret = "<script>alert(1)</script>\u{202E}";
    let error = PassageTarget::from_value(&json!({
        "version": 1, "kind": "quote", "exact": secret, "prefix": "", "suffix": "", "start": 0
    }))
    .unwrap_err();
    assert_eq!(error.code, TargetErrorCode::ForbiddenCharacter);
    assert!(!error.message.contains("script"), "{}", error.message);
    let error = PassageTarget::from_value(&json!({
        "version": 1, "kind": "quote", "exact": "x", "prefix": "", "suffix": "", "start": 0,
        "secret-field-name": 1
    }))
    .unwrap_err();
    assert!(!error.message.contains("secret"), "{}", error.message);
}

#[test]
fn oversized_input_is_refused_before_it_is_parsed() {
    let padding = " ".repeat(MAX_TARGET_JSON_BYTES);
    let error = PassageTarget::from_json(&format!("{{{padding}}}")).unwrap_err();
    assert_eq!(error.code, TargetErrorCode::TooLarge);
}

#[test]
fn quoted_context_is_escaped_for_html() {
    let doc = PassageDocument::from_sections(vec![(
        Some("x".into()),
        "Before <b onclick=\"go()\">bold</b> & 'after'".into(),
    )]);
    let target = doc.quote(0, 7, 34).unwrap();
    let html = target.context_html().unwrap();
    assert_eq!(
        html,
        "<span class=\"ob-passage-context\">Before <mark>&lt;b onclick=&quot;go()&quot;&gt;bold&lt;/b&gt;</mark> &amp; &#39;after&#39;</span>"
    );
    // The canonical JSON keeps the text as data and escapes what JSON must.
    let parsed: Value = serde_json::from_str(&target.to_json()).unwrap();
    assert_eq!(parsed["exact"], "<b onclick=\"go()\">bold</b>");
    assert!(doc.section_target(0).unwrap().context_html().is_none());
}

#[test]
fn a_long_selection_is_refused_rather_than_cut() {
    let doc = PassageDocument::from_sections(vec![(None, "word ".repeat(200))]);
    let error = doc.quote(0, 0, 501).unwrap_err();
    assert_eq!(error.code, TargetErrorCode::QuoteTooLong);
    assert!(doc.quote(0, 0, 500).is_ok());
}

#[test]
fn passage_text_is_the_text_the_page_shows() {
    let markdown = "Lead with *emphasis* and `code`.\n\n\
        ## The Claim\n\nA claim[^1] with ![alt text](a.png) an image.\n\n\
        ```rust\nfn hidden() {}\n```\n\n\
        <div>raw html</div>\n\n\
        - one\n- two\n\n\
        | a | b |\n|---|---|\n| c | d |\n\n\
        ### Deeper {#custom-id}\n\nInline <em>kept</em> text.\n\n\
        ## The Claim\n\nAgain.\n\n\
        [^1]: An author's footnote.\n";
    let doc = PassageDocument::from_markdown(markdown, false);
    let sections: Vec<(Option<&str>, &str)> = doc
        .sections
        .iter()
        .map(|section| (section.anchor.as_deref(), section.text.as_str()))
        .collect();
    assert_eq!(
        sections,
        vec![
            (None, "Lead with emphasis and code."),
            (
                Some("the-claim"),
                "The Claim A claim with an image. one two a b c d"
            ),
            (Some("custom-id"), "Deeper Inline kept text."),
            (
                Some("the-claim-2"),
                "The Claim Again. An author's footnote."
            ),
        ]
    );
    // Smart punctuation changes the text the page shows, so it changes the
    // passage text and its revision.
    let smart = PassageDocument::from_markdown("## A\n\n\"Quoted\" -- yes", true);
    assert_eq!(
        smart.sections[0].text,
        "A \u{201c}Quoted\u{201d} \u{2013} yes"
    );
    assert_ne!(
        smart.revision,
        PassageDocument::from_markdown("## A\n\n\"Quoted\" -- yes", false).revision
    );
}

#[test]
fn heading_ids_are_the_page_heading_ids() {
    let markdown = "## Café au lait\n\nText.\n\n## Café au lait\n\nMore.\n\n# Top {#top}\n";
    let doc = PassageDocument::from_markdown(markdown, false);
    let anchors: Vec<_> = doc.sections.iter().map(|s| s.anchor.clone()).collect();
    assert_eq!(
        anchors,
        vec![
            Some("café-au-lait".to_string()),
            Some("café-au-lait-2".to_string()),
            Some("top".to_string())
        ]
    );
    let site = load(&[(
        "posts/a.md",
        &format!("---\ntitle: A\ndate: 2026-01-01\n---\n{markdown}"),
    )]);
    let html = &site.posts[0].html;
    for anchor in anchors.into_iter().flatten() {
        assert!(html.contains(&format!("id=\"{anchor}\"")), "{anchor}");
    }
}

fn load(files: &[(&str, &str)]) -> Site {
    let mut sources = Sources::default();
    for (path, content) in files {
        sources.add(SourceFile {
            path: path.to_string(),
            contents: content.to_string(),
        });
    }
    Site::load(SiteConfig::default(), sources, LoadOptions::default()).expect("site loads")
}

#[test]
fn a_post_without_opt_in_features_is_unchanged_and_its_passages_are_its_prose() {
    let source =
        "---\ntitle: Plain\ndate: 2026-01-01\n---\nIntro text.\n\n## Part one\n\nBody text.\n";
    let site = load(&[("posts/plain.md", source)]);
    let post = &site.posts[0];
    let html_before = post.html.clone();
    let doc = PassageDocument::of_post(post, &site.config);
    assert_eq!(doc.sections.len(), 2);
    assert_eq!(doc.sections[1].text, "Part one Body text.");
    assert_eq!(post.html, html_before);
    assert_eq!(
        doc,
        PassageDocument::of_post(post, &site.config),
        "deterministic"
    );
}

const LIBRARY: &str = r#"{
  "version": 1,
  "sources": [
    {"id": "plato-republic", "kind": "work", "title": "Republic",
     "creators": [{"name": "Plato", "role": "author"}]}
  ]
}"#;

fn cited(style: &str) -> Site {
    let config = SiteConfig::from_json(
        r#"{"title": "T", "url": "https://example.test", "author": {"name": "A"}}"#,
    )
    .unwrap();
    let sources = Sources {
        posts: vec![SourceFile {
            path: "content/posts/cave.md".into(),
            contents: format!(
                "---\ntitle: The cave\ndate: 2026-10-20\ncitations: {style}\n---\n\
                 ## The cave\n\nShadows on a wall [@plato-republic, canonical 514a].\n"
            ),
        }],
        source_library: Some(openblog_core::model::LibrarySource::Text(SourceFile {
            path: ".openblog/private/research/sources.json".into(),
            contents: LIBRARY.into(),
        })),
        ..Default::default()
    };
    Site::load(config, sources, LoadOptions::default()).expect("site loads")
}

#[test]
fn generated_citation_notes_are_not_passage_text() {
    let notes = cited("notes");
    let doc = PassageDocument::of_post(&notes.posts[0], &notes.config);
    let texts: Vec<_> = doc.sections.iter().map(|s| s.text.as_str()).collect();
    // The marker is generated, and the notes region is left out entirely.
    assert_eq!(texts, vec!["The cave Shadows on a wall ."]);
    assert!(notes.posts[0].html.contains("Republic"));

    // The bibliography style writes the locator into the prose itself, so
    // readers see it and can quote it.
    let bibliography = cited("bibliography");
    let doc = PassageDocument::of_post(&bibliography.posts[0], &bibliography.config);
    assert_eq!(doc.sections.len(), 1);
    assert!(doc.sections[0]
        .text
        .starts_with("The cave Shadows on a wall ("));
}

#[test]
fn one_bad_target_fails_alone() {
    let doc = PassageDocument::from_markdown(
        "## A\n\nFirst passage here.\n\n## B\n\nSecond one.\n",
        false,
    );
    let good = doc.quote(0, 2, 7).unwrap().to_json();
    let inputs = [good.as_str(), "{\"version\":9}", "not json", good.as_str()];
    let results: Vec<_> = inputs
        .iter()
        .map(|input| PassageTarget::from_json(input).map(|t| doc.resolve(&t, Some(&doc.revision))))
        .collect();
    assert!(matches!(results[0], Ok(Resolution::Current(_))));
    assert_eq!(
        results[1].as_ref().unwrap_err().code,
        TargetErrorCode::UnsupportedVersion
    );
    assert_eq!(
        results[2].as_ref().unwrap_err().code,
        TargetErrorCode::Malformed
    );
    assert_eq!(results[0], results[3]);
}

/// The page's visible text: tags dropped, with the content of iframes,
/// scripts and styles left out, whitespace collapsed.
fn page_text(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        rest = &rest[open..];
        let close = rest.find('>').map_or(rest.len(), |close| close + 1);
        let tag = rest[..close].to_ascii_lowercase();
        rest = &rest[close..];
        for hidden in ["script", "style", "iframe"] {
            if tag.starts_with(&format!("<{hidden}")) {
                let end = format!("</{hidden}>");
                rest = rest.find(&end).map_or("", |at| &rest[at + end.len()..]);
            }
        }
        out.push(' ');
    }
    out.push_str(rest);
    openblog_core::passage_target::normalize_passage_text(&out)
}

fn embedding(embeds: bool) -> Site {
    let config = SiteConfig::from_json(&format!(
        r#"{{"title": "T", "url": "https://example.test", "author": {{"name": "A"}},
            "markdown": {{"embeds": {embeds}}}}}"#
    ))
    .unwrap();
    let sources = Sources {
        posts: vec![SourceFile {
            path: "content/posts/mixed.md".into(),
            contents: "---\ntitle: Mixed\ndate: 2026-10-20\n---\n\
                ## Section\n\nBefore the embed.\n\n\
                https://www.youtube.com/watch?v=dQw4w9WgXcQ\n\n\
                | alpha | beta |\n|---|---|\n| gamma | delta |\n\n\
                <div>raw block</div>\n\nAfter.\n"
                .into(),
        }],
        ..Default::default()
    };
    Site::load(config, sources, LoadOptions::default()).expect("site loads")
}

/// What the build's passage text holds, set against the rendered page. The
/// browser never derives passage text from the DOM (ADR 0076): the build
/// publishes it, so the page may show more than the passage text does, but
/// everything in the passage text is on the page.
#[test]
fn passage_text_against_the_rendered_page_for_a_table_an_embed_and_a_raw_block() {
    let site = embedding(true);
    let post = &site.posts[0];
    let doc = PassageDocument::of_post(post, &site.config);
    assert_eq!(doc.sections.len(), 1);
    let build = doc.sections[0].text.as_str();
    let page = page_text(&post.html);
    assert!(post.html.contains("ob-embed"), "the embed is on the page");

    // Prose and table cells are in both, in the same order.
    assert_eq!(
        build,
        "Section Before the embed. alpha beta gamma delta After."
    );
    for part in ["Before the embed.", "alpha beta gamma delta", "After."] {
        assert!(page.contains(part), "{part}: {page}");
    }
    // The embed paragraph is not passage text, and neither is its frame
    // caption, which the page generates.
    assert!(!build.contains("youtube"));
    assert!(
        page.to_lowercase().contains("youtube"),
        "the caption names the provider"
    );
    // A raw HTML block is the author's markup, not prose a reader can
    // quote, so the build leaves it out although the page shows it.
    assert!(!build.contains("raw block"));
    assert!(page.contains("raw block"));
    // Every word of the passage text is a word on the page.
    for word in build.split(' ') {
        assert!(page.contains(word), "{word}");
    }
}

#[test]
fn an_embed_link_is_passage_text_only_while_embeds_are_off() {
    let on = embedding(true);
    let off = embedding(false);
    let with = PassageDocument::of_post(&on.posts[0], &on.config);
    let without = PassageDocument::of_post(&off.posts[0], &off.config);
    assert!(!off.posts[0].html.contains("ob-embed"));
    assert!(!with.sections[0].text.contains("youtube"));
    assert!(without.sections[0].text.contains("youtube"));
    assert!(page_text(&off.posts[0].html).contains("youtube"));
    assert_ne!(with.revision, without.revision);
}
