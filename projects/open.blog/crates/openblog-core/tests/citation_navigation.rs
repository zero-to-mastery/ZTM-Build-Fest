//! Accessible citation anchors and no-JavaScript reference navigation
//! (#65): the native page of a post that publishes citations carries its
//! reader reference data, wraps its notes in a labelled endnotes region whose
//! notes take focus, links every marker to its note and back, prints whole,
//! and fails the build, naming the post, when its anchors and its data
//! disagree. Every other page is byte-for-byte what it was before. Set
//! `OPENBLOG_UPDATE_GOLDEN=1` to rewrite the legacy golden pages.

use std::collections::BTreeMap;

use openblog_core::model::LibrarySource;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};

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
       {"scheme": "doi", "value": "doi:10.1000/xyz"},
       {"scheme": "my-drive", "value": "C:/PRIVATE-MARKER/scan.pdf"}
     ],
     "csl": {"publisher": "Oxford University Press", "note": "PRIVATE-MARKER csl note"}},
    {"id": "hostile", "kind": "work",
     "title": "</script><script>alert(1)</script> & \u2028 more",
     "identifiers": [{"scheme": "url", "value": "https://example.org/a_(b)?q=1"}]}
  ]
}"#;

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/citation_navigation"
);

/// Posts that do not publish citations, in every profile that has its own
/// page furniture, plus one that opts in but cites nothing.
const LEGACY: &[(&str, &str)] = &[
    ("posts/article.md", "---\ntitle: Article\ndate: 2026-09-01\ntags: [a]\n---\nA claim[^1] and a handle [@someone] and `[@code]`.\n\n## Section\n\nText.\n\n[^1]: A note [@inside].\n"),
    ("posts/research.md", "---\ntitle: Study\ndate: 2026-09-02\nprofile: research\ndoi: 10.1234/study\n---\n## Abstract\n\nSummary [@plato-republic].\n\n## References\n\n1. [Prior work](https://doi.org/10.1000/prior)\n"),
    ("posts/recipe.md", "---\ntitle: Soup\ndate: 2026-09-03\nprofile: recipe\n---\n## Ingredients\n\n- Water [@plato-republic]\n\n## Steps\n\n1. Boil.\n"),
    ("posts/opted-but-uncited.md", "---\ntitle: Quiet\ndate: 2026-09-04\ncitations: notes\n---\nNo citations here, only a footnote[^a].\n\n[^a]: Plain.\n"),
];

fn config() -> SiteConfig {
    SiteConfig::from_json(
        r#"{"title": "T", "url": "https://example.test", "author": {"name": "A"}}"#,
    )
    .unwrap()
}

fn load(posts: &[(&str, &str)], library: Option<&str>) -> Result<Site, Vec<String>> {
    let sources = Sources {
        posts: posts
            .iter()
            .map(|(path, contents)| SourceFile {
                path: (*path).into(),
                contents: (*contents).into(),
            })
            .collect(),
        source_library: library.map(|text| {
            LibrarySource::Text(SourceFile {
                path: ".openblog/private/research/sources.json".into(),
                contents: text.into(),
            })
        }),
        ..Default::default()
    };
    Site::load(config(), sources, LoadOptions::default())
}

fn build(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

/// The generated file of a post.
fn page_path(post: &openblog_core::model::Post) -> String {
    format!("{}index.html", post.url.trim_start_matches('/'))
}

#[test]
fn pages_without_published_citations_are_byte_for_byte_unchanged() {
    for library in [None, Some(LIBRARY)] {
        let site = load(LEGACY, library).unwrap();
        let files = build(&site);
        assert_eq!(site.posts.len(), LEGACY.len());
        for post in &site.posts {
            let slug = &post.slug;
            let page = &files[&page_path(post)];
            let golden = format!("{FIXTURES}/{slug}.html");
            if std::env::var_os("OPENBLOG_UPDATE_GOLDEN").is_some() {
                std::fs::write(&golden, page).unwrap();
            }
            let expected = std::fs::read_to_string(&golden)
                .unwrap_or_else(|_| panic!("missing golden {golden}"))
                .replace("\r\n", "\n");
            assert_eq!(page, &expected, "{slug} changed");
            assert!(!page.contains("ob-references"), "{slug}");
            assert!(!page.contains("doc-endnotes"), "{slug}");
        }
    }
}

/// A post that cites an edition twice at the same place, a work, and a
/// source with hostile text, and has its own heading named like the
/// generated one and its own footnote.
const CITED: &str = "---
title: The cave
date: 2026-10-20
citations: notes
---
The cave [@republic-slings-2003, page 514 to 520; line 3].
Again [@republic-slings-2003, page 514 to 520; line 3], the work [@plato-republic, canonical 514a],
then [@hostile].

## Notes

My own heading named like the generated one, and a footnote[^own].

[^own]: The author's note.
";

fn cited(body: &str) -> (Site, String) {
    let site = load(&[("posts/cave.md", body)], Some(LIBRARY)).unwrap();
    let page = build(&site).remove(&page_path(&site.posts[0])).unwrap();
    (site, page)
}

/// Every value of an attribute on the page, in order.
fn attribute_values<'p>(page: &'p str, name: &str) -> Vec<&'p str> {
    let needle = format!(" {name}=\"");
    page.match_indices(&needle)
        .map(|(at, _)| {
            let rest = &page[at + needle.len()..];
            &rest[..rest.find('"').unwrap()]
        })
        .collect()
}

#[test]
fn an_opted_in_page_carries_its_reference_data_once_in_the_head() {
    let (site, page) = cited(CITED);
    let opening = "<script type=\"application/json\" id=\"ob-references\">";
    assert_eq!(page.matches(opening).count(), 1, "{page}");
    let at = page.find(opening).unwrap();
    assert!(at < page.find("</head>").unwrap(), "data sits in the head");
    let data = site.posts[0].reader_references().unwrap();
    assert!(page.contains(&format!("{}\n", data.to_script_element())));
    // The element parses to the same document, and hostile text in it can
    // neither close it nor reach the page as markup.
    let start = at + opening.len();
    let json = &page[start..start + page[start..].find("</script>").unwrap()];
    let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
    let expected: serde_json::Value = serde_json::from_str(&data.to_json()).unwrap();
    assert_eq!(parsed, expected);
    assert!(!page.contains("<script>alert"), "{page}");
    assert!(!page.contains("PRIVATE-MARKER") && !page.contains("my-drive"));
    // Only the post's page carries it: indexes, feeds and search do not.
    for (path, contents) in build(&site) {
        if path != page_path(&site.posts[0]) {
            assert!(!contents.contains("ob-references"), "{path}");
        }
    }
}

#[test]
fn markers_and_notes_name_the_citation_and_its_destination() {
    let (_, page) = cited(CITED);
    // Each marker is a note reference named "Citation N".
    assert!(page.contains(
        "<a href=\"#cite-1\" id=\"cite-1-ref-1\" role=\"doc-noteref\"><span class=\"ob-visually-hidden\">Citation </span>1</a>"
    ), "{page}");
    assert_eq!(page.matches("role=\"doc-noteref\"").count(), 4);
    // The generated notes are one endnotes region named by their own heading,
    // never by the author's heading of the same name.
    assert_eq!(page.matches("role=\"doc-endnotes\"").count(), 1);
    assert!(page.contains(
        "<section class=\"ob-citation-notes\" role=\"doc-endnotes\" aria-labelledby=\"notes-2\">\n<h2 id=\"notes-2\">Notes"
    ), "{page}");
    let region_start = page.find("<section class=\"ob-citation-notes\"").unwrap();
    let region_end = region_start + page[region_start..].find("</section>").unwrap();
    let region = &page[region_start..region_end];
    // Each note takes focus when its marker is followed; the author's own
    // note is outside the region and unchanged.
    for note in ["cite-1", "cite-2", "cite-3"] {
        assert!(
            region.contains(&format!(
                "<div class=\"footnote-definition ob-citation-note\" id=\"{note}\" tabindex=\"-1\">"
            )),
            "{note}: {region}"
        );
    }
    assert!(!region.contains("id=\"own\""));
    assert!(page.contains(
        "<div class=\"footnote-definition\" id=\"own\"><sup class=\"footnote-definition-label\">4</sup>"
    ));
    // Each way back is a back link named after the citation it returns to.
    assert!(region.contains(
        "<a class=\"ob-citation-back\" href=\"#cite-1-ref-2\" role=\"doc-backlink\"><span aria-hidden=\"true\">\u{21a9}\u{fe0e}</span><span class=\"ob-visually-hidden\">Back to citation 1 (2)</span></a>"
    ), "{region}");
    assert_eq!(region.matches("role=\"doc-backlink\"").count(), 4);
    // The region closes straight after the last note.
    assert!(page[region_end..].starts_with("</section>\n</div></ob-code>"));
}

#[test]
fn repeated_citations_have_distinct_stable_return_targets() {
    for style in ["notes", "bibliography"] {
        let body = CITED.replace("citations: notes", &format!("citations: {style}"));
        let (site, page) = cited(&body);
        let data = site.posts[0].reader_references().unwrap();
        let ids = attribute_values(&page, "id");
        let hrefs = attribute_values(&page, "href");
        for citation in &data.citations {
            assert_eq!(
                ids.iter().filter(|id| **id == citation.marker).count(),
                1,
                "{style}: {}",
                citation.marker
            );
            let back = format!("#{}", citation.marker);
            assert_eq!(
                hrefs.iter().filter(|href| **href == back).count(),
                1,
                "{style}: one way back to {}",
                citation.marker
            );
        }
        // Rebuilding gives the same targets.
        assert_eq!(cited(&body).1, page, "{style}");
    }
}

#[test]
fn every_in_page_link_resolves_without_javascript() {
    for style in ["notes", "bibliography"] {
        let (_, page) = cited(&CITED.replace("citations: notes", &format!("citations: {style}")));
        let ids = attribute_values(&page, "id");
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), ids.len(), "{style}: duplicate ids");
        for href in attribute_values(&page, "href") {
            if let Some(fragment) = href.strip_prefix('#') {
                assert!(
                    ids.contains(&fragment),
                    "{style}: #{fragment} has no target"
                );
            }
        }
    }
}

#[test]
fn a_bibliography_and_another_locale_name_their_own_region() {
    let (_, page) = cited(&CITED.replace("citations: notes", "citations: bibliography"));
    assert!(page.contains(
        "role=\"doc-endnotes\" aria-labelledby=\"references\">\n<h2 id=\"references\">References"
    ), "{page}");
    let (_, page) =
        cited(&CITED.replace("citations: notes", "citations: notes\ncitationLocale: de"));
    assert!(page.contains(
        "role=\"doc-endnotes\" aria-labelledby=\"anmerkungen\">\n<h2 id=\"anmerkungen\">Anmerkungen"
    ), "{page}");
    assert!(page.contains("Zurück zum Beleg 1 (2)"));
}

#[test]
fn the_admin_preview_and_any_theme_render_the_same_navigation() {
    let site = load(&[("posts/cave.md", CITED)], Some(LIBRARY)).unwrap();
    let themes = ThemeSet::new();
    let built = build(&site).remove(&page_path(&site.posts[0])).unwrap();
    let preview = openblog_core::generate_document(&site, &themes, "posts/cave.md").unwrap();
    assert_eq!(preview.contents, built);

    let mut themes = ThemeSet::new();
    themes.insert(
        "loud",
        openblog_core::ThemeFile::from_json(
            r#"{"extends":"base","options":{"headingCodeLabels":true,"headingWrapper":"x-type"}}"#,
        )
        .unwrap(),
    );
    let themed = CITED.replace("citations: notes", "citations: notes\ntheme: loud");
    let site = load(&[("posts/cave.md", &themed)], Some(LIBRARY)).unwrap();
    let page = generate(&site, &themes)
        .unwrap()
        .into_iter()
        .find(|file| file.path == page_path(&site.posts[0]))
        .unwrap()
        .contents;
    assert!(
        page.contains("data-ob-theme=\"loud\""),
        "the post uses the theme"
    );
    assert!(page.contains("id=\"ob-references\""));
    assert!(page.contains("role=\"doc-endnotes\""));
    site.posts[0]
        .reader_references()
        .unwrap()
        .check_page(&page)
        .unwrap();
}

#[test]
fn print_keeps_every_note_and_hides_only_the_ways_back() {
    let css = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/base.css"))
        .unwrap()
        .replace("\r\n", "\n");
    let print = &css[css.find("@media print {").unwrap()..];
    let print = &print[..print.find("\n}\n").unwrap()];
    assert!(print
        .contains(".ob-citation-back,\n  .ob-citation-preview {\n    display: none !important;"));
    assert!(print.contains(".ob-citation-note {\n    break-inside: avoid;"));
    for kept in [
        ".ob-citation-notes",
        ".ob-citation {",
        ".footnote-definition",
    ] {
        assert!(!print.contains(kept), "{kept} must print");
    }
    // Arrival is marked on screen, and long addresses wrap at high zoom.
    assert!(css.contains(".ob-citation-note:target,\n.ob-citation a:target {"));
    assert!(css.contains(".ob-citation-note {\n  overflow-wrap: anywhere;"));
}

#[test]
fn anchors_that_disagree_with_the_data_stop_the_build_naming_the_post() {
    // Raw HTML that repeats a generated id would make a marker or a way back
    // ambiguous; the build refuses it with a diagnostic naming the post.
    for (clash, id) in [
        ("<span id=\"cite-1-ref-2\"></span>", "cite-1-ref-2"),
        ("<p id=\"cite-2\">x</p>", "cite-2"),
        // Ids in any case, spacing or quoting are the same id to a browser.
        ("<span ID=\"cite-1\"></span>", "cite-1"),
        ("<span id = \"cite-1-ref-1\"></span>", "cite-1-ref-1"),
        ("<span	id='cite-3'></span>", "cite-3"),
        ("<em class=x id=cite-2-ref-1>x</em>", "cite-2-ref-1"),
        (
            "<span
  id=\"cite-3-ref-1\"></span>",
            "cite-3-ref-1",
        ),
    ] {
        let body = format!("{CITED}\n{clash}\n");
        let site = load(&[("posts/cave.md", &body)], Some(LIBRARY)).unwrap();
        let error = generate(&site, &ThemeSet::new()).unwrap_err();
        assert!(error.starts_with("posts/cave.md: "), "{error}");
        assert!(
            error.contains(&format!("more than one element with id `{id}`")),
            "{error}"
        );
        assert!(
            error.contains(&format!("rename the other `id=\"{id}\"` in the post")),
            "{error}"
        );
        assert!(!error.contains("PRIVATE-MARKER"));
        let preview = openblog_core::generate_document(&site, &ThemeSet::new(), "posts/cave.md");
        assert!(preview.unwrap_err().starts_with("posts/cave.md: "));
    }
    // Other posts are not the problem and do not appear in it.
    let clashing = format!("{CITED}\n<b id=\"cite-3\">x</b>\n");
    let site = load(&[("posts/cave.md", &clashing), LEGACY[0]], Some(LIBRARY)).unwrap();
    let error = generate(&site, &ThemeSet::new()).unwrap_err();
    assert!(!error.contains("article"), "{error}");
}

#[test]
fn the_page_check_rejects_malformed_destinations() {
    let (site, page) = cited(CITED);
    let data = site.posts[0].reader_references().unwrap();
    data.check_page(&page).unwrap();
    let broken = |from: &str, to: &str| {
        assert!(page.contains(from), "{from}");
        data.check_page(&page.replacen(from, to, 1)).unwrap_err()
    };
    // A note that is missing.
    assert!(broken(" id=\"cite-2\"", " id=\"elsewhere\"").contains("no element with id `cite-2`"));
    // A marker that links somewhere else.
    assert!(broken(
        "<a href=\"#cite-2\" id=\"cite-2-ref-1\"",
        "<a href=\"#nowhere\" id=\"cite-2-ref-1\""
    )
    .contains("does not link to its note"));
    // No way back to a marker.
    assert!(broken(" href=\"#cite-3-ref-1\"", " href=\"#top\"").contains("links back"));
    // An attribute that merely ends in `id` is not an id.
    let lookalike = page.replacen(" id=\"cite-3\"", " data-id=\"cite-3\"", 1);
    assert!(data
        .check_page(&lookalike)
        .unwrap_err()
        .contains("`cite-3`"));
    // Nor is text inside another attribute's value or a comment.
    for quiet in [
        "<p title=' id=\"cite-3\"'>x</p>",
        "<!-- <span id=\"cite-3\"> -->",
    ] {
        let page = page.replacen("</main>", &format!("{quiet}</main>"), 1);
        data.check_page(&page).unwrap();
    }
}

#[test]
fn raw_html_ids_in_any_case_or_quoting_move_the_notes_heading_aside() {
    for written in [
        "<span ID=\"notes\"></span>",
        "<span id = \"notes\"></span>",
        "<span id='notes'></span>",
        "<span id=notes></span>",
        "<div
  id=\"notes\">
x
</div>",
        "Inline <b	Id=notes>x</b>.",
    ] {
        let body = CITED.replace(
            "## Notes

My own heading",
            &format!(
                "{written}

My own heading"
            ),
        );
        let (site, page) = cited(&body);
        assert!(
            page.contains(
                "aria-labelledby=\"notes-2\">
<h2 id=\"notes-2\">"
            ),
            "{written}: {page}"
        );
        site.posts[0]
            .reader_references()
            .unwrap()
            .check_page(&page)
            .unwrap();
    }
}

#[test]
fn the_notes_region_is_named_by_its_own_heading_whatever_the_author_wrote() {
    // The author's footnote `[^notes]` is an element with id `notes`, and so
    // is raw HTML; the generated heading moves aside rather than share it.
    let body = CITED.replace(
        "a footnote[^own].\n\n[^own]: The author's note.\n",
        "a footnote[^own] and[^notes].\n\n[^own]: The author's note.\n\n[^notes]: Named like the region.\n\n<span id=\"notes-3\"></span>\n",
    );
    let (site, page) = cited(&body);
    assert!(
        page.contains("<div class=\"footnote-definition\" id=\"notes\">"),
        "{page}"
    );
    // The author's own `## Notes` keeps `notes`, as it would without
    // citations; `notes-3` is the raw span.
    assert!(page.contains("<h2 id=\"notes\">Notes<a "), "{page}");
    assert!(
        page.contains(
            "role=\"doc-endnotes\" aria-labelledby=\"notes-2\">
<h2 id=\"notes-2\">Notes"
        ),
        "{page}"
    );
    let data = site.posts[0].reader_references().unwrap();
    data.check_page(&page).unwrap();
    // A page whose region label is carried twice, or not at all, is refused.
    let twice = page.replacen(
        "<div class=\"footnote-definition\" id=\"notes\">",
        "<div class=\"footnote-definition\" id=\"notes-2\">",
        1,
    );
    let error = data.check_page(&twice).unwrap_err();
    assert!(
        error.contains("more than one element with id `notes-2`"),
        "{error}"
    );
    assert!(error.contains("heading"), "{error}");
    let missing = page.replacen("<h2 id=\"notes-2\"", "<h2 id=\"elsewhere\"", 1);
    assert!(data
        .check_page(&missing)
        .unwrap_err()
        .contains("labelled by `notes-2`"));
}

/// The ids of the page's headings, in order.
fn page_heading_ids(page: &str) -> Vec<&str> {
    page.match_indices("<h")
        .filter_map(|(at, _)| {
            let rest = &page[at + 2..];
            let level = rest.as_bytes().first()?;
            let rest = rest.get(1..)?.strip_prefix(" id=\"")?;
            (b'1'..=b'6')
                .contains(level)
                .then(|| &rest[..rest.find('"').unwrap()])
        })
        .collect()
}

#[test]
fn turning_citations_on_never_moves_the_authors_heading_ids() {
    // Inbound links such as `#step-2` reach the same heading whether or not
    // the post publishes citations, however the post's own ids collide.
    let body = CITED.replace(
        "## Notes\n",
        concat!(
            "## Step\n\n## Step\n\n<span id=\"step-2\"></span>\n\n",
            "## Intro {#background}\n\n## Background\n\nSee[^step].\n\n[^step]: A note.\n\n",
            "<p ID='notes'>x</p>\n\n## Notes\n",
        ),
    );
    let (site, with) = cited(&body);
    let (_, without) = cited(&body.replace(
        "citations: notes
",
        "",
    ));
    assert!(!without.contains("doc-endnotes"));
    let region = attribute_values(&with, "aria-labelledby")
        .into_iter()
        .find(|id| id.starts_with("notes"))
        .unwrap();
    let mut authored = page_heading_ids(&with);
    let generated = authored.iter().rposition(|id| *id == region).unwrap();
    assert_eq!(authored.remove(generated), region);
    assert_eq!(authored, page_heading_ids(&without));
    assert!(authored.contains(&"step-2") && authored.contains(&"notes"));
    // Only the generated heading steps aside from the written ids.
    assert_eq!(region, "notes-2");
    site.posts[0]
        .reader_references()
        .unwrap()
        .check_page(&with)
        .unwrap();
}

#[test]
fn headings_named_like_generated_ids_move_the_generated_ids_aside() {
    for headings in [
        "## Cite 1\n\nText.\n",
        "## Cite 1 ref 1\n\nText.\n",
        "## Cite 2 ref 1\n\n## Cite\n\n## Cite\n",
        "## Intro {#cite-3}\n\nText.\n",
    ] {
        let body = CITED.replace("## Notes\n", &format!("{headings}\n## Notes\n"));
        let (site, page) = cited(&body);
        let data = site.posts[0].reader_references().unwrap();
        data.check_page(&page).unwrap();
        assert!(data.citations[0].note.starts_with("cite2-"), "{headings}");
        let ids = attribute_values(&page, "id");
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), ids.len(), "{headings}: duplicate ids");
    }
}

#[test]
fn only_a_page_with_reference_data_loads_the_preview_component() {
    let script =
        "<script type=\"module\" src=\"/assets/components/ob-citation-previews.js\"></script>";
    let (site, page) = cited(CITED);
    assert_eq!(page.matches(script).count(), 1, "{page}");
    let head = &page[..page.find("</head>").unwrap()];
    assert!(head.find(script).unwrap() > head.find("id=\"ob-references\"").unwrap());
    // One host element in the main content, after the article, with the
    // localized words of its link to the note.
    let host = "<ob-citation-previews note-label=\"Go to note\"></ob-citation-previews>\n</main>";
    assert_eq!(page.matches("<ob-citation-previews").count(), 1);
    assert!(page.contains(host), "{page}");
    let (_, page) = cited(&CITED.replace("citations: notes", "citations: bibliography"));
    assert!(page.contains("note-label=\"Go to reference\""));
    let (_, page) =
        cited(&CITED.replace("citations: notes", "citations: notes\ncitationLocale: de"));
    assert!(page.contains("note-label=\"Zur Anmerkung\""));
    // No other page loads it or carries the element.
    for (path, contents) in build(&site) {
        if path != page_path(&site.posts[0]) {
            assert!(!contents.contains("ob-citation-previews"), "{path}");
        }
    }
    for library in [None, Some(LIBRARY)] {
        let site = load(LEGACY, library).unwrap();
        for (path, contents) in build(&site) {
            assert!(!contents.contains("ob-citation-previews"), "{path}");
        }
    }
}
