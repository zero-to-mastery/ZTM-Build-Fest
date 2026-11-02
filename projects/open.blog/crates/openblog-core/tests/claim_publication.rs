//! Published claim evidence (ADR 0075): the site switch, the field allowlist,
//! contested evidence side by side, withdrawal, revision notes that outlive the
//! private file, fail-closed checks, determinism, and a leak corpus across
//! every public representation.

use std::collections::BTreeMap;

use openblog_core::claim_publication::{ClaimEvidence, ClaimEvidenceSource};
use openblog_core::claims::ClaimSet;
use openblog_core::knowledge_atlas::Links;
use openblog_core::portability::PortableProjection;
use openblog_core::research_bundle::looks_like_private_research;
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use openblog_core::{
    feeds, generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};
use serde_json::{json, Value};

/// Every value that must stay private carries this marker.
const PRIVATE: &str = "PRIVATE-CLAIM-MARKER";

const CAVE: &str = "---
title: The cave
date: 2026-10-20
evidenceRevisions:
  - \"2026-10-21 cave: Added the critic's contrary reading.\"
  - \"2026-10-20: First published with evidence.\"
---
The cave educates. Later the sun appears.
";

const PLAIN: &str = "---
title: Plain
date: 2026-10-19
---
Nothing claimed here.
";

fn library() -> SourceLibrary {
    library_with_critic("PUBLIC Critic <b>bold</b>")
}

fn library_with_critic(critic_title: &str) -> SourceLibrary {
    let text = json!({"version": 1, "sources": [
        {"id": "plato", "kind": "work", "title": "PUBLIC Politeia",
         "creators": [{"name": "Plato", "role": "author"}],
         "notes": format!("{PRIVATE} source note"),
         "identifiers": [{"scheme": "shelf", "value": format!("{PRIVATE} shelf")}]},
        {"id": "slings", "kind": "edition", "of": "plato", "title": "PUBLIC Slings", "issued": "2003"},
        {"id": "critic", "kind": "work", "title": critic_title},
        {"id": "unused", "kind": "work", "title": format!("{PRIVATE} unused source")}]})
    .to_string();
    SourceLibrary::parse(&text, &BTreeMap::new()).unwrap()
}

fn notebook(library: &SourceLibrary) -> Notebook {
    let text = json!({"version": 1, "passages": [{"id": "p-cave", "source": "slings",
        "excerpt": {"text": format!("{PRIVATE} quoted")}}]})
    .to_string();
    Notebook::parse(&text, library).unwrap()
}

fn claims() -> Value {
    json!({"version": 1,
        "claims": [
            {"id": "cave", "post": "cave", "statement": "PUBLIC The cave educates.",
             "uncertainty": "PUBLIC claim doubt", "visibility": "approved",
             "anchor": {"start": 0, "end": 18, "text": "The cave educates.", "hint": format!("{PRIVATE} anchor extra")},
             "recordedBy": {"kind": "named", "name": format!("{PRIVATE} recorder")},
             "shelf": format!("{PRIVATE} claim extra")},
            {"id": "sun", "post": "cave", "statement": "PUBLIC The sun appears.", "visibility": "approved"},
            {"id": "withheld-claim", "post": "cave", "statement": format!("{PRIVATE} private claim"),
             "uncertainty": format!("{PRIVATE} private doubt"), "visibility": "private"}],
        "links": [
            {"id": "s1", "claim": "cave", "relation": "supports", "visibility": "approved",
             "evidence": {"source": "slings", "locators": [{"kind": "page", "value": "514",
                 "hint": format!("{PRIVATE} locator extra")}], "margin": format!("{PRIVATE} evidence extra")},
             "rationale": "PUBLIC support rationale", "confidence": "plausible",
             "uncertainty": "PUBLIC support doubt", "reviewState": "reviewed",
             "recordedBy": {"kind": "named", "name": format!("{PRIVATE} link recorder")},
             "tag": format!("{PRIVATE} link extra")},
            {"id": "c1", "claim": "cave", "relation": "contradicts", "visibility": "approved",
             "evidence": {"source": "critic"}, "rationale": "PUBLIC contrary rationale",
             "confidence": "strong"},
            {"id": "ctx-private-link", "claim": "cave", "relation": "contextualizes", "visibility": "private",
             "evidence": {"source": "slings", "passage": "p-cave"},
             "rationale": format!("{PRIVATE} private rationale")},
            {"id": "h1", "claim": "withheld-claim", "relation": "supports", "visibility": "approved",
             "evidence": {"source": "plato"}, "rationale": format!("{PRIVATE} private endpoint")}],
        "workspace": format!("{PRIVATE} top-level extra")})
}

fn projection(value: &Value) -> ClaimEvidence {
    projection_in(value, library())
}

fn projection_in(value: &Value, library: SourceLibrary) -> ClaimEvidence {
    let notebook = notebook(&library);
    let set = ClaimSet::parse(
        &value.to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .expect("a valid claims file");
    ClaimEvidence::project(&set, &library).expect("a projection")
}

fn config(publish: bool) -> SiteConfig {
    let mut config = SiteConfig::from_json(
        r#"{"title": "Claims", "url": "https://example.test", "author": {"name": "Site Author"},
            "feeds": {"fullContent": true, "llms": true}}"#,
    )
    .unwrap();
    config.claim_evidence.publish = publish;
    config
}

fn post(path: &str, contents: &str) -> SourceFile {
    SourceFile {
        path: path.into(),
        contents: contents.into(),
    }
}

fn load(
    publish: bool,
    posts: Vec<SourceFile>,
    source: Option<ClaimEvidenceSource>,
    options: LoadOptions,
) -> Result<Site, Vec<String>> {
    Site::load(
        config(publish),
        Sources {
            posts,
            claim_evidence: source,
            ..Default::default()
        },
        options,
    )
}

fn site(publish: bool, value: &Value) -> Site {
    load(
        publish,
        vec![post("posts/cave.md", CAVE), post("posts/plain.md", PLAIN)],
        Some(ClaimEvidenceSource::Stored(projection(value))),
        LoadOptions::default(),
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"))
}

fn build(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

fn cave(site: &Site) -> &openblog_core::Post {
    site.posts.iter().find(|post| post.slug == "cave").unwrap()
}

#[test]
fn a_site_that_does_not_publish_builds_byte_for_byte_as_before() {
    let without = load(
        false,
        vec![post("posts/cave.md", CAVE), post("posts/plain.md", PLAIN)],
        None,
        LoadOptions::default(),
    )
    .unwrap();
    let off = site(false, &claims());
    assert_eq!(build(&off), build(&without), "the switch alone decides");
    assert!(off.posts.iter().all(|post| post.claim_evidence().is_none()));
    // Publishing on: a post with no claims and no notes is unchanged.
    let on = site(true, &claims());
    let (before, after) = (build(&without), build(&on));
    assert_eq!(
        before["posts/plain/index.html"],
        after["posts/plain/index.html"]
    );
    assert!(after.contains_key("claim-evidence.json"));
    assert!(!before.contains_key("claim-evidence.json"));
}

#[test]
fn every_representation_carries_the_same_section_and_nothing_private() {
    let site = site(true, &claims());
    let files = build(&site);
    let projection = PortableProjection::from_post(cave(&site), &config(true)).unwrap();
    let portable_html = projection.portable_html().unwrap().html;
    let portable_markdown = projection.portable_markdown().unwrap();
    let portable_text = projection.portable_text().unwrap();
    let llms = feeds::llms_full(&site).unwrap();
    let carriers = [
        ("native", files["posts/cave/index.html"].as_str()),
        ("portable html", portable_html.as_str()),
        ("portable markdown", portable_markdown.as_str()),
        ("portable text", portable_text.as_str()),
        ("rss", files["rss.xml"].as_str()),
        ("json feed", files["feed.json"].as_str()),
        ("llms-full", llms.as_str()),
        ("publication markdown", cave(&site).publication_markdown()),
    ];
    for (name, output) in carriers {
        for public in [
            "Claims and evidence",
            "PUBLIC The cave educates.",
            "PUBLIC claim doubt",
            "PUBLIC Slings",
            "PUBLIC support rationale",
            "PUBLIC support doubt",
            "PUBLIC contrary rationale",
            "Supporting evidence (1)",
            "Contradicting evidence (1)",
            "Contested:",
            "Added the critic",
            "Revision notes",
        ] {
            assert!(output.contains(public), "{name} lacks {public}");
        }
    }
    let json = &files["claim-evidence.json"];
    for public in [
        "PUBLIC The cave educates.",
        "PUBLIC contrary rationale",
        r#""standing":"contested""#,
        r#""url":"/posts/cave/#claim-1""#,
        "First published with evidence.",
    ] {
        assert!(json.contains(public), "the artifact lacks {public}: {json}");
    }
    // The leak corpus: every generated file and every portable copy.
    let mut outputs: Vec<(String, String)> = files.into_iter().collect();
    outputs.push(("portable html".into(), portable_html));
    outputs.push(("portable markdown".into(), portable_markdown));
    outputs.push(("portable text".into(), portable_text));
    outputs.push(("llms-full".into(), llms));
    for (name, output) in &outputs {
        for leaked in [
            PRIVATE,
            "p-cave",
            "reviewState",
            "recordedBy",
            "visibility",
            "withheld-claim",
            "ctx-private-link",
        ] {
            assert!(!output.contains(leaked), "{name} leaks {leaked}");
        }
        assert!(
            !looks_like_private_research(output.as_bytes()),
            "{name} looks like private research"
        );
    }
}

#[test]
fn contested_evidence_is_side_by_side_never_netted_and_needs_no_script() {
    let site = site(true, &claims());
    let html = build(&site)["posts/cave/index.html"].clone();
    let section = &html[html.rfind("<h2 id=\"claims-and-evidence\">").unwrap()..];
    // Up to the end of the post body, before the share links.
    let section = &section[..section.find("</div></ob-code>").unwrap()];
    assert!(section.contains("<strong>Contested:</strong> 1 piece of contradicting evidence and 1 piece of supporting evidence"));
    let support = section.find("Supporting evidence (1)").unwrap();
    let contrary = section.find("Contradicting evidence (1)").unwrap();
    assert!(support < contrary && contrary < section.find("Claim 2").unwrap());
    // The second claim has no published contradiction, and says only that.
    assert!(section.contains("No contradicting evidence is published for this claim. That is not a statement that none exists."));
    assert!(section.contains("Contradicting evidence (0)"));
    assert!(section.contains("In the post: \u{201c}The cave educates.\u{201d}"));
    assert!(section.contains("PUBLIC Critic &lt;b&gt;bold&lt;/b&gt;"));
    for absent in ["<script", "<ob-", "consensus", "verified", "score", "net "] {
        assert!(!section.to_lowercase().contains(absent), "{absent}");
    }
    assert!(section.contains("<h2 id=\"claims-and-evidence\">"));
    assert!(section.contains("<h3 id=\"claim-1\">"));
    assert!(section.contains("<ul>"));
}

#[test]
fn withdrawing_approval_removes_evidence_and_keeps_the_revision_notes() {
    // A contradicting link set back to private withdraws the support beside it.
    let mut withdrawn = claims();
    withdrawn["links"][1]["visibility"] = json!("private");
    let first = site(true, &withdrawn);
    let page = build(&first)["posts/cave/index.html"].clone();
    for gone in [
        "PUBLIC contrary rationale",
        "PUBLIC support rationale",
        "PUBLIC Slings",
        "Contested:",
    ] {
        assert!(!page.contains(gone), "{gone} is withdrawn");
    }
    assert!(page.contains("Supporting evidence (0)"));
    // Withdrawing the claim itself removes it; its revision note stays and no
    // longer names a claim that is not published.
    let mut withdrawn = claims();
    withdrawn["claims"][0]["visibility"] = json!("private");
    let second = site(true, &withdrawn);
    let files = build(&second);
    let page = &files["posts/cave/index.html"];
    assert!(!page.contains("PUBLIC The cave educates."));
    assert!(
        page.contains("2026-10-21: Added the critic"),
        "the note is never deleted"
    );
    assert!(!files["claim-evidence.json"].contains(r#""claim":"cave""#));
}

#[test]
fn without_a_claims_file_the_build_warns_and_still_publishes_revision_notes() {
    let site = load(
        true,
        vec![post("posts/cave.md", CAVE)],
        Some(ClaimEvidenceSource::Unstored {
            warning: "no claims file is stored".into(),
        }),
        LoadOptions::default(),
    )
    .unwrap();
    assert!(site
        .warnings
        .iter()
        .any(|warning| warning == "no claims file is stored"));
    let page = build(&site)["posts/cave/index.html"].clone();
    assert!(page.contains("No claims are published for this post at present."));
    assert!(page.contains("2026-10-20: First published with evidence."));
    assert!(page.contains("2026-10-21: Added the critic"));
}

#[test]
fn the_section_is_not_the_posts_prose_but_is_its_search_text() {
    let on = site(true, &claims());
    let off = site(false, &claims());
    let (with, without) = (cave(&on), cave(&off));
    assert!(with.publication_markdown().contains("Claims and evidence"));
    // The description, word count and reading time come from the author's
    // words only, as they would without the section.
    assert_eq!(
        with.description,
        "The cave educates. Later the sun appears."
    );
    assert_eq!(with.description, without.description);
    assert_eq!(with.word_count, 7);
    assert_eq!(with.word_count, without.word_count);
    assert_eq!(with.reading_minutes, without.reading_minutes);
    // Search still finds the section's words.
    assert!(with.text.contains("PUBLIC support rationale"));
}

#[test]
fn the_section_heading_words_later_in_the_section_do_not_refuse_a_portable_copy() {
    // A revision note and a cited source title that mention the heading's
    // words sit after the heading itself; every copy is still whole.
    let noted = CAVE.replace(
        "  - \"2026-10-20: First published with evidence.\"
",
        "  - \"2026-10-20: First published with evidence.\"
  - \"2026-10-22: Reworded the Claims and evidence introduction.\"
",
    );
    assert!(noted.contains("Reworded the Claims and evidence"));
    let titled = projection_in(
        &claims(),
        library_with_critic("PUBLIC Claims and evidence in the Republic"),
    );
    for (what, contents, source) in [
        ("a revision note", noted.as_str(), projection(&claims())),
        ("a source title", CAVE, titled),
    ] {
        let site = load(
            true,
            vec![post("posts/cave.md", contents)],
            Some(ClaimEvidenceSource::Stored(source)),
            LoadOptions::default(),
        )
        .unwrap_or_else(|errors| panic!("{what}: {errors:?}"));
        let published = cave(&site).publication_markdown();
        assert!(
            published.matches("Claims and evidence").count() > 1,
            "{what}: {published}"
        );
        let projection = PortableProjection::from_post(cave(&site), &config(true)).unwrap();
        projection
            .portable_html()
            .unwrap_or_else(|error| panic!("{what}: {error}"));
        projection
            .portable_markdown()
            .unwrap_or_else(|error| panic!("{what}: {error}"));
        projection
            .portable_text()
            .unwrap_or_else(|error| panic!("{what}: {error}"));
        build(&site);
    }
}

#[test]
fn an_unreadable_claims_file_is_reported_for_the_build_but_stops_no_load_or_render() {
    let site = load(
        true,
        vec![post("posts/cave.md", CAVE)],
        Some(ClaimEvidenceSource::Unreadable(
            "the private claims file .openblog/private/research/claims.json cannot be read".into(),
        )),
        LoadOptions::default(),
    )
    .expect("a load that only reads content is not stopped");
    let error = site.claim_evidence_error.as_deref().unwrap();
    assert!(error.contains("claims.json"), "{error}");
    // The full build refuses on it (`site::generate_site`); a validation
    // render such as an Admin save's is not stopped, and publishes no claim.
    let files = generate(&site, &ThemeSet::new()).expect("a validation render is not stopped");
    assert!(!files.iter().any(|file| file.contents.contains("PUBLIC")));
}

#[test]
fn a_post_that_would_swallow_the_section_is_refused_and_a_draft_only_warns() {
    let unclosed =
        "---\ntitle: The cave\ndate: 2026-10-20\n---\nThe cave educates.\n\n```\nnever closed\n";
    let source = || Some(ClaimEvidenceSource::Stored(projection(&claims())));
    let errors = load(
        true,
        vec![post("posts/cave.md", unclosed)],
        source(),
        LoadOptions::default(),
    )
    .unwrap_err();
    assert!(
        errors[0].contains("posts/cave.md") && errors[0].contains("code block"),
        "{errors:?}"
    );
    let draft = unclosed.replace("date: 2026-10-20", "date: 2026-10-20\ndraft: true");
    let site = load(
        true,
        vec![post("posts/cave.md", &draft)],
        source(),
        LoadOptions {
            include_drafts: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(site
        .warnings
        .iter()
        .any(|w| w.contains("claim evidence is not published while the post is a draft")));
    assert!(site.posts[0].claim_evidence().is_none());
    assert!(!site.posts[0]
        .publication_markdown()
        .contains("Claims and evidence"));
    // A malformed revision note names its item, for the post only.
    let bad = CAVE.replace("2026-10-20: First", "someday: First");
    let errors = load(
        true,
        vec![post("posts/cave.md", &bad)],
        source(),
        LoadOptions::default(),
    )
    .unwrap_err();
    assert!(
        errors[0].contains("posts/cave.md") && errors[0].contains("evidenceRevisions` item 2"),
        "{errors:?}"
    );
}

#[test]
fn citations_and_claim_evidence_share_one_publication_body() {
    let cited = "---\ntitle: The cave\ndate: 2026-10-20\ncitations: notes\nslug: cave\n---\nThe cave educates [@plato].\n";
    let library = library();
    let library_text = serde_json::to_string(&json!({"version": 1, "sources": [
        {"id": "plato", "kind": "work", "title": "PUBLIC Politeia"},
        {"id": "slings", "kind": "edition", "of": "plato", "title": "PUBLIC Slings"},
        {"id": "critic", "kind": "work", "title": "PUBLIC Critic"}]}))
    .unwrap();
    drop(library);
    let mut value = claims();
    value["claims"][0]["anchor"] = json!({"start": 0, "end": 8, "text": "The cave"});
    let site = Site::load(
        config(true),
        Sources {
            posts: vec![post("posts/cave.md", cited)],
            source_library: Some(openblog_core::model::LibrarySource::Text(post(
                ".openblog/private/research/sources.json",
                &library_text,
            ))),
            claim_evidence: Some(ClaimEvidenceSource::Stored(projection(&value))),
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"));
    let markdown = site.posts[0].publication_markdown();
    let evidence = markdown.find("## Claims and evidence").unwrap();
    let notes = markdown.find("## Notes").unwrap();
    assert!(
        evidence < notes,
        "the evidence comes before the citation notes"
    );
    assert!(markdown.contains("[^cite-1]: PUBLIC Politeia."));
    let html = build(&site)["posts/cave/index.html"].clone();
    assert!(html.contains("ob-citation-notes") && html.contains("Claims and evidence"));
}

#[test]
fn generation_is_deterministic() {
    assert_eq!(build(&site(true, &claims())), build(&site(true, &claims())));
}

/// A post that cites a source and holds, in a supplement, the headings a claim section and a note
/// list would otherwise be numbered around: `### Claim 1` and `## Cite 1`.
fn supplement_post(front: &str) -> String {
    format!(
        "---\ntitle: The cave\ndate: 2026-10-20\ncitations: notes\n{front}---\n\
The cave educates. Later the sun appears.[@slings]\n\n\
> [!supplement kind=context]\n> ### Claim 1\n> Words.\n>\n> ## Cite 1\n> More words.\n"
    )
}

fn supplement_site(front: &str) -> Site {
    let library = json!({"version": 1, "sources": [
        {"id": "plato", "kind": "work", "title": "PUBLIC Politeia"},
        {"id": "slings", "kind": "edition", "of": "plato", "title": "PUBLIC Slings", "issued": "2003"},
        {"id": "critic", "kind": "work", "title": "PUBLIC Critic"}]})
    .to_string();
    Site::load(
        config(true),
        Sources {
            posts: vec![post("posts/cave.md", &supplement_post(front))],
            claim_evidence: Some(ClaimEvidenceSource::Stored(projection(&claims()))),
            source_library: Some(openblog_core::model::LibrarySource::Text(SourceFile {
                path: ".openblog/private/research/sources.json".into(),
                contents: library,
            })),
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"))
}

#[test]
fn claim_and_citation_targets_follow_the_ids_an_opted_in_page_renders() {
    let id_of = |html: &str, tag: &str| -> Vec<String> {
        html.split(&format!("<{tag} "))
            .skip(1)
            .filter_map(|rest| rest.split("id=\"").nth(1))
            .map(|rest| rest.split('"').next().unwrap().to_string())
            .collect()
    };
    let urls = |site: &Site| -> Vec<String> {
        cave(site)
            .claim_evidence()
            .unwrap()
            .claims
            .iter()
            .map(|claim| claim.url.clone())
            .collect()
    };

    // Opted in: the supplement's headings are the supplement's own, so the claim section's
    // `Claim 1` heading takes the plain slug and the note list keeps the plain `cite-` prefix.
    let on = supplement_site("readingModes: true\n");
    let page = build(&on)["posts/cave/index.html"].clone();
    let headings = id_of(&page, "h3");
    assert!(headings.contains(&"claim-1".to_string()), "{headings:?}");
    assert!(
        headings.iter().any(|id| id.starts_with("ob-supplement-")),
        "{headings:?}"
    );
    assert_eq!(urls(&on)[0], "/posts/cave/#claim-1");
    assert_eq!(urls(&on)[1], "/posts/cave/#claim-2");
    for url in urls(&on) {
        let fragment = url.split('#').nth(1).unwrap();
        assert!(page.contains(&format!("id=\"{fragment}\"")), "{url}");
    }
    assert!(page.contains("id=\"cite-1\""), "{page}");
    assert!(!page.contains("cite2-"), "{page}");

    // The same body without the flag is read as before: the author's headings are ordinary
    // headings, take the plain slugs first, and the claim and the notes are numbered after them.
    let off = supplement_site("");
    let page = build(&off)["posts/cave/index.html"].clone();
    assert_eq!(urls(&off)[0], "/posts/cave/#claim-1-2");
    assert_eq!(urls(&off)[1], "/posts/cave/#claim-2");
    for url in urls(&off) {
        let fragment = url.split('#').nth(1).unwrap();
        assert!(page.contains(&format!("id=\"{fragment}\"")), "{url}");
    }
    assert!(page.contains("id=\"cite2-1\""), "{page}");
    assert!(!page.contains("ob-supplement-"), "{page}");
}
