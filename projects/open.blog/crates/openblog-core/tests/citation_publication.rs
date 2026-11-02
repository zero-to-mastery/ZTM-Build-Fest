//! Opt-in publication of citations as notes or a bibliography (ADR 0048 and
//! ADR 0049): golden output, determinism, legacy byte equality, every public
//! representation, accessible anchors, privacy and source-scoped failures.

use std::collections::BTreeMap;

use openblog_core::model::{self, LibrarySource};
use openblog_core::portability::PortableProjection;
use openblog_core::source_library::SourceLibrary;
use openblog_core::{
    feeds, generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};

const PRIVATE: &str = "PRIVATE-MARKER";

const LIBRARY: &str = r#"{
  "version": 1,
  "sources": [
    {"id": "plato-republic", "kind": "work", "title": "Πολιτεία",
     "creators": [{"name": "Plato", "role": "author"}],
     "secretPlan": "PRIVATE-MARKER unknown field"},
    {"id": "republic-slings-2003", "kind": "edition", "of": "plato-republic",
     "title": "Platonis Rempublicam", "issued": "2003",
     "creators": [{"name": "S. R. Slings", "role": "editor"}],
     "identifiers": [
       {"scheme": "doi", "value": "10.1000/xyz"},
       {"scheme": "my-drive", "value": "C:/PRIVATE-MARKER/scan.pdf"}
     ],
     "csl": {"publisher": "Oxford University Press", "publisher-place": "Oxford",
             "note": "PRIVATE-MARKER csl note"}},
    {"id": "hostile", "kind": "work",
     "title": "<script>alert(1)</script> *bold* [x](javascript:alert(1)) & more",
     "creators": [{"name": "1984. Collective", "role": "author"}],
     "identifiers": [{"scheme": "url", "value": "https://example.org/a_(b)?q=1"}]},
    {"id": "paris-gr-1807", "kind": "witness", "of": "plato-republic", "archived": true,
     "title": "Paris gr. 1807"},
    {"id": "never-cited", "kind": "work", "title": "PRIVATE-MARKER uncited title"}
  ]
}"#;

fn config(language: &str) -> SiteConfig {
    SiteConfig::from_json(&format!(
        r#"{{
            "title": "Citations",
            "url": "https://example.test",
            "language": "{language}",
            "author": {{ "name": "Site Author" }},
            "feeds": {{ "fullContent": true, "llms": true }}
        }}"#
    ))
    .unwrap()
}

fn library() -> SourceLibrary {
    SourceLibrary::parse(LIBRARY, &BTreeMap::new()).expect("valid library")
}

fn post(path: &str, contents: &str) -> SourceFile {
    SourceFile {
        path: path.into(),
        contents: contents.into(),
    }
}

fn sources(posts: Vec<SourceFile>, library: Option<&str>) -> Sources {
    Sources {
        posts,
        source_library: library.map(|text| {
            LibrarySource::Text(SourceFile {
                path: ".openblog/private/research/sources.json".into(),
                contents: text.into(),
            })
        }),
        ..Default::default()
    }
}

fn load(
    language: &str,
    posts: Vec<SourceFile>,
    library: Option<&str>,
) -> Result<Site, Vec<String>> {
    Site::load(
        config(language),
        sources(posts, library),
        LoadOptions::default(),
    )
}

fn build(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

const CITED: &str = "---
title: The cave
date: 2026-10-20
citations: notes
---
The cave [@republic-slings-2003, page 514 to 520; line 3].
Again [@republic-slings-2003, page 514 to 520; line 3] and the work [@plato-republic, canonical 514a].
A hostile title [@hostile], then [@republic-slings-2003, page 521].
";

const CITED_NOTES: &str = "The cave [^cite-1].
Again [^cite-1] and the work [^cite-2].
A hostile title [^cite-3], then [^cite-4].

## Notes

[^cite-1]: Platonis Rempublicam. S. R. Slings (ed.). Oxford: Oxford University Press. 2003. [doi:10.1000/xyz](https://doi.org/10.1000/xyz), pp. 514–520, l. 3.

[^cite-2]: Plato. Πολιτεία, 514a.

[^cite-3]: 1984\\. Collective. \\<script\\>alert(1)\\</script\\> \\*bold\\* \\[x\\](javascript:alert(1)) \\& more. [https://example.org/a\\_(b)?q=1](https://example.org/a_%28b%29?q=1).

[^cite-4]: Platonis Rempublicam. S. R. Slings (ed.). Oxford: Oxford University Press. 2003. [doi:10.1000/xyz](https://doi.org/10.1000/xyz), p. 521.
";

/// The generated file of the site's first post.
fn page(site: &Site) -> String {
    format!("{}index.html", site.posts[0].url.trim_start_matches('/'))
}

fn cited_site(body: &str) -> Site {
    load("en", vec![post("posts/cave.md", body)], Some(LIBRARY))
        .unwrap_or_else(|errors| panic!("{errors:?}"))
}

#[test]
fn notes_are_numbered_by_first_citation_and_repeat_for_identical_citations() {
    let site = cited_site(CITED);
    assert_eq!(site.posts[0].publication_markdown(), CITED_NOTES);
    // The authored body is untouched; only the published copy changes.
    assert!(site.posts[0]
        .authored_markdown()
        .contains("[@plato-republic, canonical 514a]"));
}

#[test]
fn a_bibliography_lists_each_reference_once_and_keeps_locators_in_the_text() {
    let site = cited_site(&CITED.replace("citations: notes", "citations: bibliography"));
    let published = site.posts[0].publication_markdown();
    let expected_text = "The cave [^cite-1] (pp. 514–520, l. 3).
Again [^cite-1] (pp. 514–520, l. 3) and the work [^cite-2] (514a).
A hostile title [^cite-3], then [^cite-1] (p. 521).

## References

[^cite-1]: Platonis Rempublicam. S. R. Slings (ed.). Oxford: Oxford University Press. 2003. [doi:10.1000/xyz](https://doi.org/10.1000/xyz).

[^cite-2]: Plato. Πολιτεία.
";
    assert!(published.starts_with(expected_text), "{published}");
    assert_eq!(published.matches("\n[^cite-").count(), 3, "{published}");
}

#[test]
fn generation_is_deterministic_and_offline() {
    let first = build(&cited_site(CITED));
    for _ in 0..3 {
        assert_eq!(build(&cited_site(CITED)), first);
    }
    let reordered = load(
        "en",
        vec![
            post(
                "posts/other.md",
                "---\ntitle: Other\ndate: 2026-10-01\n---\nBody.\n",
            ),
            post("posts/cave.md", CITED),
        ],
        Some(LIBRARY),
    )
    .unwrap();
    // Another post around it changes neither the published body nor its notes.
    let alone = cited_site(CITED);
    let cave = reordered.posts.iter().find(|p| p.slug == "cave").unwrap();
    assert_eq!(cave.html, alone.posts[0].html);
    assert_eq!(
        cave.publication_markdown(),
        alone.posts[0].publication_markdown()
    );
    assert!(first.contains_key(&page(&alone)));
}

#[test]
fn locale_and_style_are_selected_by_the_post_or_the_site() {
    let german = cited_site(&CITED.replace(
        "citations: notes",
        "citations: notes\ncitationLocale: de-AT",
    ));
    let published = german.posts[0].publication_markdown();
    assert!(published.contains("\n## Anmerkungen\n"), "{published}");
    assert!(published.contains("S. R. Slings (Hrsg.)"), "{published}");
    assert!(published.contains("S. 514–520, Z. 3."), "{published}");
    assert!(german.posts[0]
        .html
        .contains("<span class=\"ob-visually-hidden\">Beleg </span>"));

    let french = load(
        "fr-CA",
        vec![post(
            "posts/cave.md",
            &CITED.replace("citations: notes", "citations: bibliography"),
        )],
        Some(LIBRARY),
    )
    .unwrap();
    assert!(french.posts[0]
        .publication_markdown()
        .contains("\n## Références\n"));

    let errors = load(
        "en",
        vec![post(
            "posts/cave.md",
            &CITED.replace("citations: notes", "citations: notes\ncitationLocale: tlh"),
        )],
        Some(LIBRARY),
    )
    .unwrap_err();
    assert!(
        errors[0].starts_with("posts/cave.md: ") && errors[0].contains("citationLocale"),
        "{errors:?}"
    );
    let errors = load(
        "en",
        vec![post(
            "posts/cave.md",
            &CITED.replace("citations: notes", "citations: chicago"),
        )],
        Some(LIBRARY),
    )
    .unwrap_err();
    assert!(
        errors[0].contains("`citations` must be `notes` or `bibliography`"),
        "{errors:?}"
    );
}

const LEGACY: &[(&str, &str)] = &[
    ("posts/article.md", "---\ntitle: Article\ndate: 2026-09-01\n---\nA claim[^1] and a handle [@someone] and `[@code]`.\n\n[^1]: A note [@inside].\n"),
    ("posts/research.md", "---\ntitle: Study\ndate: 2026-09-02\nprofile: research\ndoi: 10.1234/study\n---\n## Abstract\n\nSummary [@plato-republic].\n\n## References\n\n1. [Prior work](https://doi.org/10.1000/prior)\n"),
    ("posts/recipe.md", "---\ntitle: Soup\ndate: 2026-09-03\nprofile: recipe\n---\n## Ingredients\n\n- Water [@plato-republic]\n\n## Steps\n\n1. Boil.\n"),
    ("posts/opted-but-uncited.md", "---\ntitle: Quiet\ndate: 2026-09-04\ncitations: notes\n---\nNo citations here, only a footnote[^a].\n\n[^a]: Plain.\n"),
];

#[test]
fn posts_without_citations_publish_byte_for_byte_as_before() {
    let posts = || {
        LEGACY
            .iter()
            .map(|(path, contents)| post(path, contents))
            .collect::<Vec<_>>()
    };
    let without = build(&load("en", posts(), None).unwrap());
    let with = build(&load("en", posts(), Some(LIBRARY)).unwrap());
    assert_eq!(
        with, without,
        "a stored library changes nothing for posts that do not cite"
    );
    let broken = build(&load("en", posts(), Some("{ not json")).unwrap());
    assert_eq!(
        broken, without,
        "a broken library refuses only posts that need it"
    );

    // An opted-in post with no citation renders as if it had not opted in.
    let site = load("en", posts(), Some(LIBRARY)).unwrap();
    let quiet = site
        .posts
        .iter()
        .find(|p| p.slug == "opted-but-uncited")
        .unwrap();
    assert_eq!(quiet.publication_markdown(), quiet.authored_markdown());
    let plain = load(
        "en",
        vec![post(
            "posts/opted-but-uncited.md",
            &LEGACY[3].1.replace("citations: notes\n", ""),
        )],
        None,
    )
    .unwrap();
    assert_eq!(quiet.html, plain.posts[0].html);
    // Non-opted posts keep `[@...]` as literal text.
    let article = site.posts.iter().find(|p| p.slug == "article").unwrap();
    assert!(article.html.contains("[@someone]") && article.html.contains("[@inside]"));
    assert!(!article.html.contains("ob-citation"));
}

#[test]
fn every_public_representation_carries_the_same_notes() {
    let site = cited_site(CITED);
    let config = config("en");
    let files = build(&site);
    let native = &files[&page(&site)];
    let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
    let html = projection.portable_html().unwrap().html;
    let markdown = projection.portable_markdown().unwrap();
    let text = projection.portable_text().unwrap();
    let llms = feeds::llms_full(&site).unwrap();
    for (name, output) in [
        ("native", native.as_str()),
        ("portable html", html.as_str()),
        ("portable markdown", markdown.as_str()),
        ("portable text", text.as_str()),
        ("rss", files["rss.xml"].as_str()),
        ("json feed", files["feed.json"].as_str()),
        ("llms-full", llms.as_str()),
    ] {
        assert!(output.contains("Platonis Rempublicam"), "{name}: {output}");
        assert!(output.contains("514"), "{name}");
        assert!(output.contains("Oxford University Press"), "{name}");
        assert!(
            !output.contains("[@republic-slings-2003"),
            "{name} kept raw citation syntax"
        );
    }
    assert!(
        markdown.contains("[^cite-1]: Platonis Rempublicam."),
        "{markdown}"
    );
    assert!(
        html.contains("<a href=\"https://example.test/posts/cave/#cite-1\">1</a>"),
        "{html}"
    );
    assert!(html.contains("id=\"cite-1\""), "{html}");
    assert!(text.contains("[cite-1]: Platonis Rempublicam."), "{text}");
}

#[test]
fn native_citation_anchors_are_accessible_and_link_back() {
    let site = cited_site(CITED);
    let html = &site.posts[0].html;
    assert!(html.contains(
        "<sup class=\"footnote-reference ob-citation\"><a href=\"#cite-1\" id=\"cite-1-ref-1\" role=\"doc-noteref\"><span class=\"ob-visually-hidden\">Citation </span>1</a></sup>"
    ), "{html}");
    assert!(
        html.contains("id=\"cite-1-ref-2\""),
        "the repeated citation has its own anchor"
    );
    assert!(html.contains("<h2 id=\"notes\">Notes"), "{html}");
    assert!(html.contains(
        "<a class=\"ob-citation-back\" href=\"#cite-1-ref-2\" role=\"doc-backlink\"><span aria-hidden=\"true\">\u{21a9}\u{fe0e}</span><span class=\"ob-visually-hidden\">Back to citation 1 (2)</span></a>"
    ), "{html}");
    assert!(
        html.contains("<span class=\"ob-visually-hidden\">Back to citation 2</span>"),
        "{html}"
    );
    // Every id is unique on the page.
    let mut ids: Vec<&str> = html
        .split("id=\"")
        .skip(1)
        .map(|rest| &rest[..rest.find('"').unwrap()])
        .collect();
    let count = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), count, "{html}");
    // Hostile reference text is text, never markup.
    assert!(
        !html.contains("<script>") && !html.contains("href=\"javascript"),
        "{html}"
    );
    assert!(
        html.contains(
            "&lt;script&gt;alert(1)&lt;/script&gt; *bold* [x](javascript:alert(1)) &amp; more"
        ),
        "{html}"
    );
}

#[test]
fn authors_footnotes_keep_their_labels_numbers_and_markup() {
    let body = "---\ntitle: Mixed\ndate: 2026-10-20\ncitations: notes\n---\nOwn[^cite-1] then cited [@plato-republic] and own again[^x].\n\n[^cite-1]: The author's own note.\n\n[^x]: Another.\n";
    let site = load("en", vec![post("posts/mixed.md", body)], Some(LIBRARY)).unwrap();
    let published = site.posts[0].publication_markdown();
    assert!(published.contains("cited [^cite2-1]"), "{published}");
    assert!(published.contains("[^cite-1]: The author's own note."));
    let html = &site.posts[0].html;
    assert!(
        html.contains("Own<sup class=\"footnote-reference\"><a href=\"#cite-1\">1</a></sup>"),
        "{html}"
    );
    assert!(html.contains("<a href=\"#cite2-1\" id=\"cite2-1-ref-1\" role=\"doc-noteref\"><span class=\"ob-visually-hidden\">Citation </span>2</a>"), "{html}");
    assert!(
        html.contains("again<sup class=\"footnote-reference\"><a href=\"#x\">3</a></sup>"),
        "{html}"
    );
    assert!(html.contains("<div class=\"footnote-definition\" id=\"cite-1\"><sup class=\"footnote-definition-label\">1</sup>"), "{html}");
}

#[test]
fn markers_never_join_following_text_into_a_link_or_definition() {
    let body = "---\ntitle: Edges\ndate: 2026-10-20\ncitations: notes\n---\n[@plato-republic]: not a definition.\n\nA [@plato-republic](see also) and [@plato-republic][@hostile] and \\[@literal].\n";
    let site = load("en", vec![post("posts/edges.md", body)], Some(LIBRARY)).unwrap();
    let published = site.posts[0].publication_markdown();
    assert!(published.starts_with("[^cite-1]\\: not a definition.\n\nA [^cite-1]\\(see also) and [^cite-1][^cite-2] and \\[@literal].\n"), "{published}");
    let html = &site.posts[0].html;
    assert_eq!(html.matches("role=\"doc-noteref\"").count(), 4, "{html}");
    assert!(html.contains("[@literal]"));
}

#[test]
fn an_interpretation_naming_a_removed_contributor_never_breaks_a_citing_build() {
    // The site's registry is empty, so `ada` was removed after she was named.
    let with_interpretation = LIBRARY.replacen(
        "\"sources\": [",
        r#""interpretations": [
    {"id": "cave-mine", "kind": "reading", "source": "republic-slings-2003",
     "text": "PRIVATE-MARKER interpretation text",
     "interpreters": [{"contributor": "ada"}]}
  ],
  "sources": ["#,
        1,
    );
    assert!(
        SourceLibrary::parse(&with_interpretation, &BTreeMap::new()).is_err(),
        "Admin, the store, and check still refuse the unresolved interpreter"
    );
    let site = load(
        "en",
        vec![post("posts/cave.md", CITED)],
        Some(&with_interpretation),
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"));
    let files = build(&site);
    assert_eq!(files, build(&cited_site(CITED)), "the build is unchanged");
    for output in files.values() {
        assert!(!output.contains("interpretation text"));
        assert!(!output.contains("cave-mine"));
    }
}

#[test]
fn private_library_data_never_reaches_any_output() {
    let site = cited_site(CITED);
    let config = config("en");
    let projection = PortableProjection::from_post(&site.posts[0], &config).unwrap();
    let mut outputs: Vec<String> = build(&site).into_values().collect();
    outputs.push(projection.portable_html().unwrap().html);
    outputs.push(projection.portable_markdown().unwrap());
    outputs.push(projection.portable_text().unwrap());
    outputs.push(site.posts[0].publication_markdown().to_string());
    for output in &outputs {
        for leaked in [
            PRIVATE,
            "my-drive",
            "secretPlan",
            "Paris gr. 1807",
            "never-cited",
        ] {
            assert!(!output.contains(leaked), "{leaked} leaked");
        }
    }
}

#[test]
fn a_missing_or_ambiguous_reference_blocks_only_with_source_scoped_guidance() {
    let unknown = CITED.replace("[@hostile]", "[@nobody-knows]");
    let errors = load(
        "en",
        vec![
            post("posts/cave.md", &unknown),
            post(
                "posts/ok.md",
                "---\ntitle: Ok\ndate: 2026-10-01\n---\nFine.\n",
            ),
        ],
        Some(LIBRARY),
    )
    .unwrap_err();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(
        errors[0].starts_with("posts/cave.md: line 8: citation `nobody-knows`: "),
        "{errors:?}"
    );
    assert!(
        errors[0].contains("(unknown-key)") && errors[0].contains("add the source to the library"),
        "{errors:?}"
    );

    let ambiguous = CITED.replace(
        "[@plato-republic, canonical 514a]",
        "[@plato-republic, page 5]",
    );
    let errors = load("en", vec![post("posts/cave.md", &ambiguous)], Some(LIBRARY)).unwrap_err();
    assert!(
        errors[0].contains("line 7: citation `plato-republic`")
            && errors[0].contains("(ambiguous-locator)"),
        "{errors:?}"
    );

    let malformed = CITED.replace("[@hostile]", "[@Bad Key]");
    let errors = load("en", vec![post("posts/cave.md", &malformed)], Some(LIBRARY)).unwrap_err();
    assert!(
        errors[0].contains("line 8: ")
            && errors[0].contains("(invalid-key)")
            && errors[0].contains("\\[@"),
        "{errors:?}"
    );

    let errors = load("en", vec![post("posts/cave.md", CITED)], None).unwrap_err();
    assert!(
        errors[0].contains("there is no source library"),
        "{errors:?}"
    );

    let errors = load("en", vec![post("posts/cave.md", CITED)], Some(r#"{"version":1,"sources":[{"id":"x","kind":"edition","of":"PRIVATE-MARKER","title":"t"}]}"#)).unwrap_err();
    assert!(
        errors[0].contains("has 1 problem(s); run `openblog check`")
            && !errors[0].contains(PRIVATE),
        "{errors:?}"
    );

    let unclosed = format!("{CITED}\n```\nan unclosed fence\n");
    let errors = load("en", vec![post("posts/cave.md", &unclosed)], Some(LIBRARY)).unwrap_err();
    assert!(errors[0].contains("close any code block"), "{errors:?}");
}

#[test]
fn a_metadata_read_leaves_citations_as_text_and_load_post_cited_publishes_them() {
    let file = post("posts/cave.md", CITED);
    let config = config("en");
    let plain = model::load_post(&file, &config, config.render_options()).unwrap();
    assert_eq!(plain.publication_markdown(), plain.authored_markdown());
    let library = library();
    let cited =
        model::load_post_cited(&file, &config, config.render_options(), Some(&library)).unwrap();
    assert_eq!(cited.publication_markdown(), CITED_NOTES);
    assert!(cited
        .capabilities
        .iter()
        .any(|capability| capability.id == "citations" && capability.has_portable_fallback()));
}

const OK_POST: &str = "---\ntitle: Ok\ndate: 2026-10-01\n---\nFine.\n";
const NOT_YET: &str =
    "---\ntitle: Not yet\ndate: 2026-10-02\ndraft: true\ncitations: notes\n---\nSoon [@not-yet].\n";

#[test]
fn a_drafts_citation_problem_is_a_warning_and_blocks_nothing() {
    for include_drafts in [false, true] {
        let site = Site::load(
            config("en"),
            sources(
                vec![
                    post("posts/not-yet.md", NOT_YET),
                    post("posts/ok.md", OK_POST),
                ],
                Some(LIBRARY),
            ),
            LoadOptions {
                include_drafts,
                ..LoadOptions::default()
            },
        )
        .unwrap_or_else(|errors| panic!("{errors:?}"));
        let warning = site
            .warnings
            .iter()
            .find(|warning| {
                warning.starts_with(
                    "posts/not-yet.md: citations are not published while the post is a draft",
                )
            })
            .unwrap_or_else(|| panic!("{:?}", site.warnings));
        assert!(warning.contains("line 7: citation `not-yet`"), "{warning}");
        if include_drafts {
            // An included draft renders with its citations as authored text.
            let draft = site.posts.iter().find(|p| p.slug == "not-yet").unwrap();
            assert_eq!(draft.publication_markdown(), draft.authored_markdown());
            assert!(draft.html.contains("[@not-yet]"), "{}", draft.html);
        } else {
            assert_eq!(site.posts.len(), 1);
        }
    }

    // A post held back until its date warns too; it must resolve before then.
    let scheduled = NOT_YET
        .replace("draft: true\n", "")
        .replace("2026-10-02", "2099-01-01");
    let site = Site::load(
        config("en"),
        sources(
            vec![
                post("posts/not-yet.md", &scheduled),
                post("posts/ok.md", OK_POST),
            ],
            Some(LIBRARY),
        ),
        LoadOptions {
            now: openblog_core::DateTime::parse("2026-10-25"),
            ..LoadOptions::default()
        },
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"));
    assert_eq!(site.scheduled.len(), 1);
    assert!(
        site.warnings.iter().any(|warning| warning
            .starts_with("posts/not-yet.md: citations are not published until the post is due")),
        "{:?}",
        site.warnings
    );

    // Published, the same citation still refuses the post.
    let published = NOT_YET.replace("draft: true\n", "");
    let errors = load(
        "en",
        vec![
            post("posts/not-yet.md", &published),
            post("posts/ok.md", OK_POST),
        ],
        Some(LIBRARY),
    )
    .unwrap_err();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(
        errors[0].starts_with("posts/not-yet.md: line 6: citation `not-yet`"),
        "{errors:?}"
    );
}

#[test]
fn a_preview_fails_only_for_the_previewed_documents_own_citations() {
    let broken = NOT_YET.replace("draft: true\n", "");
    let preview = |target: &str, draft: &str| {
        Site::load(
            config("en"),
            sources(
                vec![post("posts/broken.md", &broken), post("posts/ok.md", draft)],
                Some(LIBRARY),
            ),
            LoadOptions {
                preview_source: Some(target.into()),
                ..LoadOptions::default()
            },
        )
    };
    // Another post's bad citation does not break this preview.
    let site = preview("posts/ok.md", OK_POST).unwrap_or_else(|errors| panic!("{errors:?}"));
    assert!(site.posts.iter().any(|p| p.source == "posts/ok.md"));
    assert!(
        site.warnings.iter().any(|warning| warning
            .starts_with("posts/broken.md: citations are not published in this preview")),
        "{:?}",
        site.warnings
    );
    // A previewed draft with an unresolved citation previews with it as text.
    let site = preview("posts/ok.md", NOT_YET).unwrap_or_else(|errors| panic!("{errors:?}"));
    assert!(site.posts.iter().any(|p| p.source == "posts/ok.md"));
    // The previewed published document's own problem still refuses.
    let errors = preview("posts/broken.md", OK_POST).unwrap_err();
    assert!(
        errors[0].starts_with("posts/broken.md: line 6: citation `not-yet`"),
        "{errors:?}"
    );
}

#[test]
fn an_authors_literal_cite_label_moves_the_generated_prefix() {
    for literal in ["[^cite-1]", "[^CITE-1]"] {
        let body = format!(
            "---\ntitle: Literal\ndate: 2026-10-20\ncitations: notes\n---\nText {literal} and [@plato-republic].\n"
        );
        let site = cited_site(&body);
        let published = site.posts[0].publication_markdown();
        assert!(
            published.starts_with(&format!("Text {literal} and [^cite2-1].")),
            "{published}"
        );
        assert!(published.contains("\n[^cite2-1]: Plato."), "{published}");
        // The author's literal stays text instead of turning into a marker.
        assert!(
            site.posts[0].html.contains(literal),
            "{}",
            site.posts[0].html
        );
    }
}

#[test]
fn the_library_is_read_only_when_an_opted_in_post_cites_something() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    let load_counting = |posts: Vec<SourceFile>| {
        let reads = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&reads);
        let reader = model::LibraryReader::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(Some(SourceFile {
                path: ".openblog/private/research/sources.json".into(),
                contents: LIBRARY.into(),
            }))
        });
        let result = Site::load(
            config("en"),
            Sources {
                posts,
                source_library: Some(LibrarySource::Deferred(reader)),
                ..Default::default()
            },
            LoadOptions::default(),
        );
        (result, reads.load(Ordering::SeqCst))
    };
    // No post opts in, or one opts in and cites nothing: never read.
    let (site, reads) = load_counting(vec![
        post("posts/ok.md", OK_POST),
        post(
            "posts/handle.md",
            "---\ntitle: Handle\ndate: 2026-10-03\n---\nPing [@handle].\n",
        ),
        post(
            "posts/empty.md",
            "---\ntitle: Empty\ndate: 2026-10-04\ncitations: notes\n---\nNo citations.\n",
        ),
    ]);
    assert!(site.is_ok());
    assert_eq!(reads, 0);
    // Two citing posts read it once.
    let second = CITED.replace("title: The cave", "title: Again");
    let (site, reads) = load_counting(vec![
        post("posts/cave.md", CITED),
        post("posts/again.md", &second),
    ]);
    assert!(site.is_ok());
    assert_eq!(reads, 1);
    // A reader that fails is reported to the citing post only, without detail.
    let failing = Sources {
        posts: vec![post("posts/cave.md", CITED), post("posts/ok.md", OK_POST)],
        source_library: Some(LibrarySource::Deferred(model::LibraryReader::new(|| {
            Err("refusing a symlink".into())
        }))),
        ..Default::default()
    };
    let errors = Site::load(config("en"), failing, LoadOptions::default()).unwrap_err();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(
        errors[0].starts_with(
            "posts/cave.md: the private source library cannot be read (refusing a symlink)"
        ),
        "{errors:?}"
    );
}

#[test]
fn a_generated_bibliography_satisfies_the_research_references_check_in_any_locale() {
    let research = "---
title: The cave
date: 2026-10-20
profile: research
citations: bibliography
---
## Abstract
Summary.

The cave [@republic-slings-2003, page 514].
";
    for (extra, heading) in [
        ("", "## References"),
        ("citationLocale: de\n", "## Literatur"),
    ] {
        let body = research.replace(
            "citations: bibliography\n",
            &format!("citations: bibliography\n{extra}"),
        );
        let site = cited_site(&body);
        let published = site.posts[0].publication_markdown();
        assert!(published.contains(&format!("\n{heading}\n")), "{published}");
        assert!(
            !site
                .evidence
                .iter()
                .any(|finding| finding.code
                    == openblog_core::research::EvidenceCode::ReferencesMissing),
            "{extra}: {:?}",
            site.evidence
        );
    }
}

/// DOIs are stored as a bare name, `doi:10.x/y` or a resolver address; each
/// is published once as its name, linking to one resolver address.
const DOI_FORMS_LIBRARY: &str = r#"{
  "version": 1,
  "sources": [
    {"id": "prefixed", "kind": "work", "title": "Prefixed",
     "identifiers": [{"scheme": "doi", "value": "doi:10.1000/prefixed"}]},
    {"id": "resolver", "kind": "work", "title": "Resolver",
     "identifiers": [{"scheme": "doi", "value": "https://doi.org/10.1000/resolver"}]},
    {"id": "legacy-resolver", "kind": "work", "title": "Legacy resolver",
     "identifiers": [{"scheme": "doi", "value": "http://dx.doi.org/10.1000/legacy"}]}
  ]
}"#;

#[test]
fn every_stored_doi_form_links_to_one_resolver_address() {
    let site = load(
        "en",
        vec![post(
            "posts/doi.md",
            "---\ntitle: DOIs\ndate: 2026-10-20\ncitations: notes\n---\nA [@prefixed], B [@resolver], C [@legacy-resolver].\n",
        )],
        Some(DOI_FORMS_LIBRARY),
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"));
    let published = site.posts[0].publication_markdown();
    for (number, title, name) in [
        (1, "Prefixed", "10.1000/prefixed"),
        (2, "Resolver", "10.1000/resolver"),
        (3, "Legacy resolver", "10.1000/legacy"),
    ] {
        let note = format!("[^cite-{number}]: {title}. [doi:{name}](https://doi.org/{name}).\n");
        assert!(published.contains(&note), "{note}\n{published}");
    }
    assert!(!published.contains("doi.org/http"), "{published}");
    assert!(!published.contains("doi:doi:"), "{published}");
    assert!(!site.posts[0].html.contains("doi.org/http"));
}

const STRONGER: &str = "---
title: Justice
date: 2026-10-20
citations: notes
---
Justice is the interest of the stronger [@plato-republic, canonical 338c].
";

#[test]
fn a_description_and_word_count_come_from_the_posts_own_prose_not_its_generated_notes() {
    let site = cited_site(STRONGER);
    let post = &site.posts[0];
    let expected = "Justice is the interest of the stronger.";
    assert_eq!(post.description, expected);
    assert_eq!(post.word_count, 7);
    assert_eq!(post.reading_minutes, 1);
    // Search keeps the notes, like an author's footnotes.
    assert!(
        post.text.contains("Notes Plato. Πολιτεία, 338c."),
        "{}",
        post.text
    );
    assert!(post.text.contains("stronger. Notes"), "{}", post.text);

    let files = build(&site);
    let page = &files[&page(&site)];
    let meta = format!("<meta name=\"description\" content=\"{expected}\">");
    let og = format!("<meta property=\"og:description\" content=\"{expected}\">");
    assert!(page.contains(&meta), "{page}");
    assert!(page.contains(&og), "{page}");
    let ld = format!("\"description\": \"{expected}\"");
    let ld_compact = format!("\"description\":\"{expected}\"");
    assert!(page.contains(&ld) || page.contains(&ld_compact), "{page}");
    assert!(
        page.contains("\"wordCount\": 7") || page.contains("\"wordCount\":7"),
        "{page}"
    );
    let rss = &files["rss.xml"];
    assert!(
        rss.contains(&format!("<description>{expected}</description>")),
        "{rss}"
    );
    assert!(!rss.contains("stronger . Notes"), "{rss}");
}

#[test]
fn a_bibliography_post_describes_itself_without_its_references() {
    let site = cited_site(&STRONGER.replace("citations: notes", "citations: bibliography"));
    let post = &site.posts[0];
    assert_eq!(
        post.description,
        "Justice is the interest of the stronger (338c)."
    );
    assert_eq!(post.word_count, 8);
    assert!(!post.description.contains("References"));
}

#[test]
fn an_authored_description_is_kept_as_written() {
    let site = cited_site(&STRONGER.replace(
        "citations: notes",
        "citations: notes\ndescription: My own summary .",
    ));
    assert_eq!(site.posts[0].description, "My own summary .");
    assert_eq!(site.posts[0].word_count, 7);
}

#[test]
fn an_opted_in_post_citing_nothing_keeps_its_description_text_and_counts() {
    let body = "---
title: Quiet
date: 2026-10-20
citations: notes
---
A plain sentence , with spacing quirks.

Another paragraph.
";
    let quiet = cited_site(body);
    let plain = cited_site(&body.replace("citations: notes\n", ""));
    let (quiet, plain) = (&quiet.posts[0], &plain.posts[0]);
    assert_eq!(quiet.description, plain.description);
    assert_eq!(quiet.text, plain.text);
    assert_eq!(quiet.word_count, plain.word_count);
    assert_eq!(
        quiet.description,
        "A plain sentence , with spacing quirks. Another paragraph."
    );
}
