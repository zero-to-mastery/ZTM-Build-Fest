//! Concept links in an article (ADR 0172, #73): `[label](atlas:id)` is resolved
//! at build time against the public atlas alone. A published entry becomes an
//! ordinary link to its page; an unknown, private, withdrawn or malformed id,
//! or any link while the atlas is off, becomes the label as plain text and a
//! warning scoped to the post and the id. Prose is preserved, repeated terms
//! need not all be linked, copies that leave the site keep the words, the
//! boundary manifest lists what is linked, the atlas-off build is what it was,
//! and output is deterministic.

use std::collections::BTreeMap;

use openblog_core::atlas_publication::PublicAtlas;
use openblog_core::concept_links::{entry_id, plain_markdown};
use openblog_core::knowledge_atlas::{valid_id, Atlas, Links};
use openblog_core::markdown::{render, RenderOptions};
use openblog_core::portability::PortableProjection;
use openblog_core::publication_boundary::{
    BoundaryInputs, BoundaryManifest, ItemKind, Projection, Reason, Switches,
};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};
use serde_json::{json, Value};

const PRIVATE: &str = "PRIVATE-CONCEPT-MARKER";

fn public_atlas() -> PublicAtlas {
    let library = SourceLibrary::parse(
        &json!({"version": 1, "sources": [
            {"id": "plato-republic", "kind": "work", "title": "Politeia"}]})
        .to_string(),
        &BTreeMap::new(),
    )
    .unwrap();
    let notebook = Notebook::parse(
        &json!({"version": 1, "passages": [], "notes": []}).to_string(),
        &library,
    )
    .unwrap();
    let entry = |id: &str, kind: &str, label: &str, visibility: &str| json!({"id": id, "kind": kind, "label": label, "visibility": visibility});
    let atlas = Atlas::parse(
        &json!({"version": 1, "entries": [
            entry("plato", "person", "Plato", "approved"),
            entry("allegory-of-the-cave", "concept", "Allegory of the cave", "approved"),
            entry("secret", "concept", &format!("{PRIVATE} label"), "private"),
            entry("withdrawn", "concept", "A withdrawn idea", "private")],
            "relationships": []})
        .to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .expect("a valid atlas");
    PublicAtlas::project(&atlas, &library).expect("a projection")
}

fn config(url: &str, atlas_on: bool) -> SiteConfig {
    let mut config = SiteConfig::from_json(&format!(
        r#"{{"title": "Concepts", "url": "{url}", "author": {{"name": "Site Author"}}}}"#
    ))
    .unwrap();
    config.knowledge_atlas.publish = atlas_on;
    config
}

fn site_with(body: &str, atlas: Option<PublicAtlas>, url: &str) -> Site {
    let mut site = Site::load(
        config(url, atlas.is_some()),
        Sources {
            posts: vec![SourceFile {
                path: "posts/cave.md".into(),
                contents: format!("---\ntitle: The cave\ndate: 2026-10-20\n---\n{body}"),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .expect("site");
    site.atlas = atlas;
    site.link_concepts();
    site
}

fn built(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .expect("a build")
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

const BODY: &str =
    "In the [allegory of the cave](atlas:allegory-of-the-cave), [Plato](atlas:plato) \
imagines prisoners. Plato returns later, and the allegory of the cave again, unlinked.";

/// The version the pages name the query file by: the first eight bytes of the
/// BLAKE2s hash of the file's own contents, in hex.
fn query_version(out: &BTreeMap<String, String>) -> String {
    use blake2::{Blake2s256, Digest};
    let mut hasher = Blake2s256::new();
    hasher.update(out["atlas-query.json"].as_bytes());
    hasher
        .finalize()
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn concept_warnings(site: &Site) -> Vec<&String> {
    site.warnings
        .iter()
        .filter(|w| w.contains(": concept link `"))
        .collect()
}

#[test]
fn a_published_entry_becomes_an_ordinary_link_and_the_prose_is_kept() {
    let site = site_with(BODY, Some(public_atlas()), "https://example.com");
    let html = &site.posts[0].html;
    assert!(
        html.contains(
            "<a class=\"ob-concept\" href=\"/atlas/allegory-of-the-cave/\" data-atlas-entry=\"allegory-of-the-cave\" data-atlas-kind=\"concept\">allegory of the cave<span class=\"ob-visually-hidden\"> (atlas entry)</span></a>"
        ),
        "{html}"
    );
    assert!(html.contains(
        "<a class=\"ob-concept\" href=\"/atlas/plato/\" data-atlas-entry=\"plato\" data-atlas-kind=\"person\">Plato<span class=\"ob-visually-hidden\"> (atlas entry)</span></a>"
    ));
    // The words are the author's, in order, with and without the links.
    assert!(!html.contains("atlas:") && !html.contains("ob-concept data-id"));
    assert_eq!(
        site.posts[0].text,
        "In the allegory of the cave, Plato imagines prisoners. Plato returns later, and the allegory of the cave again, unlinked."
    );
    assert!(concept_warnings(&site).is_empty(), "{:?}", site.warnings);
    // Repeated terms are linked only where the author linked them.
    assert_eq!(html.matches("<a class=\"ob-concept\"").count(), 2);
    assert!(html.contains("Plato returns later, and the allegory of the cave again, unlinked."));
    // And the page is the post with working, script-free links to real pages.
    let out = built(&site);
    let page = &out["posts/cave/index.html"];
    assert!(page.contains("href=\"/atlas/plato/\""));
    assert!(out.contains_key("atlas/plato/index.html"));
    assert!(out.contains_key("atlas/allegory-of-the-cave/index.html"));
}

#[test]
fn an_unknown_private_withdrawn_or_malformed_id_is_plain_text_and_a_scoped_warning() {
    let body = "A [secret thing](atlas:secret), a [lost idea](atlas:withdrawn), a [missing one](atlas:nobody), \
a [shouty](atlas:Plato), an [empty]( atlas:), a [slashed](atlas:a/b) and a [real one](atlas:plato).";
    let site = site_with(body, Some(public_atlas()), "https://example.com");
    let html = &site.posts[0].html;
    for label in [
        "secret thing",
        "lost idea",
        "missing one",
        "shouty",
        "slashed",
    ] {
        assert!(html.contains(label), "{label}");
    }
    assert_eq!(html.matches("<a class=\"ob-concept\"").count(), 1, "{html}");
    for gone in ["atlas:", "atlas/secret", "atlas/withdrawn", "atlas/nobody"] {
        assert!(!html.contains(gone), "{gone}: {html}");
    }
    let warnings = concept_warnings(&site);
    for id in ["secret", "withdrawn", "nobody"] {
        assert!(
            warnings.iter().any(|w| w.starts_with(&format!(
                "posts/cave.md: concept link `atlas:{id}` is shown as plain text: the published atlas has no entry with that id"
            ))),
            "{id}: {warnings:?}"
        );
    }
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("`atlas:Plato`") && w.contains("not `atlas:` and an entry id")),
        "{warnings:?}"
    );
    // A warning never repeats an entry's label or any private text.
    assert!(warnings.iter().all(|w| !w.contains(PRIVATE)));
    assert_eq!(warnings.len(), 6, "{warnings:?}");
    // Nothing in any output says a private or withdrawn entry exists.
    let out = built(&site);
    for (path, contents) in &out {
        assert!(
            !contents.contains(PRIVATE) && !contents.contains("atlas:secret"),
            "{path}"
        );
        if path.starts_with("posts/") || path.ends_with(".xml") || path.ends_with(".json") {
            assert!(!contents.contains("atlas/secret"), "{path}");
            assert!(!contents.contains("atlas/withdrawn"), "{path}");
        }
    }
}

#[test]
fn with_the_atlas_off_every_link_is_text_and_a_post_without_them_is_unchanged() {
    let off = site_with(BODY, None, "https://example.com");
    assert!(!off.posts[0].html.contains("<a "), "{}", off.posts[0].html);
    assert!(off.posts[0].html.contains("allegory of the cave"));
    let warnings = concept_warnings(&off);
    assert_eq!(warnings.len(), 2, "{warnings:?}");
    assert!(warnings[0].contains("`knowledgeAtlas.publish` is off"));
    assert!(!built(&off).keys().any(|path| path.contains("atlas")));

    // A post that never uses the syntax is byte for byte what it was: the
    // same HTML with the option on or off, whatever the atlas, plain links
    // included.
    let plain = "A [site](https://example.com/atlas:x), a [page](/atlas/plato/) and `[code](atlas:plato)`.\n\n```\n[x](atlas:plato)\n```\n";
    let on = RenderOptions {
        concept_links: true,
        ..RenderOptions::default()
    };
    assert_eq!(
        render(plain, on).html,
        render(plain, RenderOptions::default()).html
    );
    let with_atlas = site_with(plain, Some(public_atlas()), "https://example.com");
    let without = site_with(plain, None, "https://example.com");
    assert_eq!(with_atlas.posts[0].html, without.posts[0].html);
    assert_eq!(
        with_atlas.posts[0].html,
        render(plain, RenderOptions::default()).html
    );
    assert!(concept_warnings(&with_atlas).is_empty());
    assert!(with_atlas.posts[0].html.contains("[code](atlas:plato)"));
    // Outside a post an atlas link is never an `atlas:` address: it is its label.
    let outside = render(BODY, RenderOptions::default()).html;
    assert!(!outside.contains("atlas:plato"), "{outside}");
}

#[test]
fn a_hostile_label_or_a_forged_mark_cannot_make_a_link_or_markup() {
    let body = "A [Tom & \"Jerry\" <3 &lt;b&gt;](atlas:plato). <ob-concept data-id=\"secret\">forged</ob-concept> <ob-concept data-id=\"plato\">forged but public</ob-concept> [a *nested* label](atlas:plato).";
    let site = site_with(body, Some(public_atlas()), "https://example.com");
    let html = &site.posts[0].html;
    assert!(
        html.contains("data-atlas-kind=\"person\">Tom &amp; \"Jerry\" &lt;3 &lt;b&gt;<span class=\"ob-visually-hidden\"> (atlas entry)</span></a>"),
        "{html}"
    );
    assert!(!html.contains("atlas/secret") && html.contains("forged"));
    // A forged mark resolves only to what is public, as a real link would.
    assert!(html.contains("data-atlas-kind=\"person\">forged but public<span class=\"ob-visually-hidden\"> (atlas entry)</span></a>"));
    assert!(html.contains(
        "<em>nested</em> label<span class=\"ob-visually-hidden\"> (atlas entry)</span></a>"
    ));
    assert!(!html.contains("ob-concept data-id") && !html.contains("</ob-concept>"));
    // Nothing a label says reaches an attribute.
    assert_eq!(html.matches("data-atlas-entry=").count(), 3);
}

#[test]
fn headings_search_text_and_the_table_of_contents_keep_the_words() {
    let body = "## About [Plato](atlas:plato)\n\nText.\n\n## [Plato](atlas:plato) again\n\nMore.\n";
    let site = site_with(body, Some(public_atlas()), "https://example.com");
    let post = &site.posts[0];
    let headings: Vec<(&str, &str)> = post
        .headings
        .iter()
        .map(|h| (h.id.as_str(), h.text.as_str()))
        .collect();
    assert_eq!(
        headings,
        [
            ("about-plato", "About Plato"),
            ("plato-again", "Plato again")
        ]
    );
    assert!(post.text.contains("About Plato Text. Plato again More."));
    assert!(post
        .html
        .contains("<h2 id=\"about-plato\">About <a class=\"ob-concept\""));
}

#[test]
fn a_copy_that_leaves_the_site_keeps_the_words_and_never_the_syntax() {
    let site = site_with(BODY, Some(public_atlas()), "https://example.com");
    let post = &site.posts[0];
    let expected = "In the allegory of the cave, Plato imagines prisoners. Plato returns later, and the allegory of the cave again, unlinked.";
    let projection = PortableProjection::from_post(post, &site.config).unwrap();
    let html = projection.portable_html().unwrap().html;
    assert!(html.contains(expected), "{html}");
    assert!(
        !html.contains("atlas:") && !html.contains("atlas/"),
        "{html}"
    );
    let markdown = projection
        .representation(openblog_core::portability::RepresentationFormat::Markdown)
        .to_string();
    assert!(markdown.contains(expected), "{markdown}");
    assert!(!markdown.contains("atlas:") && !markdown.contains("]("));
    // The authored source is untouched: the author's syntax is still there.
    assert!(post.authored_markdown().contains("(atlas:plato)"));
    // The feeds are copies too.
    let out = built(&site);
    for path in ["feed.xml", "feed.json"] {
        if let Some(feed) = out.get(path) {
            assert!(!feed.contains("atlas:"), "{path}");
        }
    }
    // A post with no concept link is copied exactly as before.
    assert_eq!(plain_markdown("Nothing here."), None);
    let plain = site_with(
        "Nothing [here](https://example.com).",
        None,
        "https://example.com",
    );
    assert_eq!(
        plain.posts[0].portable_markdown(),
        plain.posts[0].publication_markdown()
    );
}

fn manifest_of(site: &Site) -> BoundaryManifest {
    let base_path = site.config.base_path();
    BoundaryManifest::post(
        &BoundaryInputs {
            switches: Switches::of(&site.config),
            posts: &site.posts,
            public_atlas: site.atlas.as_ref(),
            atlas_blocked: None,
            public_comparisons: None,
            comparisons_blocked: None,
            public_paths: None,
            public_interpretations: None,
            claims_blocked: None,
            library: None,
            notebook: None,
            atlas: None,
            claims: None,
            alignments: None,
            stale_comparisons: None,
            curation: None,
            acknowledgements: None,
            unavailable: &[],
            author: &site.config.author.name,
            base_path: &base_path,
        },
        &site.posts[0],
    )
}

#[test]
fn the_boundary_manifest_lists_what_a_post_links_and_what_it_could_not() {
    let body = "[Plato](atlas:plato) [again](atlas:plato) [cave](atlas:allegory-of-the-cave) [x](atlas:secret) [y](atlas:Plato)";
    let site = site_with(body, Some(public_atlas()), "https://example.com");
    let manifest = manifest_of(&site);
    let report = manifest
        .projections
        .iter()
        .find(|report| report.projection == Projection::ContextLinks)
        .unwrap();
    assert!(report.enabled);
    assert_eq!(
        manifest.published_ids(Projection::ContextLinks, ItemKind::AtlasPage),
        std::collections::BTreeSet::from(["allegory-of-the-cave", "plato"]),
        "each linked entry once, however often it is linked"
    );
    let plato = report.published.iter().find(|i| i.id == "plato").unwrap();
    assert_eq!(plato.url.as_deref(), Some("/atlas/plato/"));
    assert_eq!(plato.posts, ["cave"]);
    assert_eq!(report.withheld.len(), 1, "{:?}", report.withheld);
    let withheld = &report.withheld[0];
    assert_eq!(withheld.id, "secret");
    assert_eq!(withheld.reason, Reason::PageNotPublished);
    assert!(
        withheld.message.contains("plain text of its label") && !withheld.message.contains(PRIVATE),
        "{}",
        withheld.message
    );
    // The same listing with the atlas off: nothing is published, the
    // links are listed as withheld.
    let off = site_with(body, None, "https://example.com");
    let off_manifest = manifest_of(&off);
    assert!(off_manifest
        .published_ids(Projection::ContextLinks, ItemKind::AtlasPage)
        .is_empty());
}

#[test]
fn links_follow_the_base_path_and_output_is_deterministic() {
    let site = site_with(BODY, Some(public_atlas()), "https://example.com/blog");
    let out = built(&site);
    assert!(out["posts/cave/index.html"].contains("href=\"/blog/atlas/plato/\""));
    assert!(!out["posts/cave/index.html"].contains("href=\"/atlas/plato/\""));
    let again = built(&site_with(
        BODY,
        Some(public_atlas()),
        "https://example.com/blog",
    ));
    assert_eq!(out, again);
    // Resolving again changes nothing and does not repeat a warning.
    let mut twice = site_with(
        "A [x](atlas:nobody).",
        Some(public_atlas()),
        "https://example.com",
    );
    let first = twice.warnings.clone();
    twice.link_concepts();
    twice.link_concepts();
    assert_eq!(twice.warnings, first);
    assert_eq!(concept_warnings(&twice).len(), 1);
    // And it follows the atlas as it is now.
    twice.atlas = None;
    twice.link_concepts();
    assert!(concept_warnings(&twice)[0].contains("is off"));
}

#[test]
fn the_syntax_is_one_set_of_cases_for_rust_and_the_browser() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/concept-links.json"))
            .expect("fixtures");
    let ids = fixtures["destinations"].as_array().unwrap();
    assert!(ids.len() >= 10);
    for case in ids {
        let destination = case["destination"].as_str().unwrap();
        assert_eq!(
            entry_id(destination),
            case["id"].as_str(),
            "{}",
            case["name"]
        );
        if let Some(id) = case["id"].as_str() {
            assert!(valid_id(id));
        }
    }
    for case in fixtures["plain"].as_array().unwrap() {
        assert_eq!(
            plain_markdown(case["markdown"].as_str().unwrap()).as_deref(),
            case["plain"].as_str(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn a_concept_link_inside_an_image_description_leaks_nothing_and_warns() {
    let body = "![A [hidden](atlas:secret) and [Plato](atlas:plato)](/cave.png)\n\nAnd [Plato](atlas:plato) outside.";
    for atlas in [Some(public_atlas()), None] {
        let site = site_with(body, atlas, "https://example.com");
        let html = &site.posts[0].html;
        assert!(
            html.contains("alt=\"A hidden and Plato\""),
            "the alt text is the plain labels: {html}"
        );
        for leak in ["atlas:", "secret", "ob-concept data-id", "&lt;ob-concept"] {
            assert!(!html.contains(leak), "{leak}: {html}");
        }
        // The link outside the image is unaffected.
        assert!(html.contains("And "), "{html}");
        let warnings = concept_warnings(&site);
        for id in ["secret", "plato"] {
            assert!(
                warnings.iter().any(|w| w.contains(&format!("`atlas:{id}`"))
                    && w.contains("inside an image")
                    || w.contains(&format!("`atlas:{id}`")) && w.contains("image's description")),
                "{id}: {warnings:?}"
            );
        }
        let out = built(&site);
        assert!(out["posts/cave/index.html"].contains("alt=\"A hidden and Plato\""));
        assert!(!out["posts/cave/index.html"].contains("atlas:secret"));
    }
    // The copy that leaves the site keeps the words too.
    let site = site_with(body, Some(public_atlas()), "https://example.com");
    assert!(!site.posts[0].portable_markdown().contains("atlas:"));
}

fn full_site(intro: &str) -> Site {
    let mut config = config("https://example.com", true);
    config.home.intro = intro.to_string();
    Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: "posts/cave.md".into(),
                contents: "---\ntitle: The cave\ndate: 2026-10-20\n---\nBody.".into(),
            }],
            pages: vec![SourceFile {
                path: "pages/about.md".into(),
                contents:
                    "---\ntitle: About\n---\nAbout [Plato](atlas:plato) and [x](atlas:secret).\n"
                        .into(),
            }],
            series: vec![SourceFile {
                path: "series/greeks.md".into(),
                contents: "---\nname: Greeks\n---\nA series on [Plato](atlas:plato).\n".into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .expect("site")
}

#[test]
fn atlas_links_in_pages_series_and_the_home_intro_are_text_with_a_warning() {
    let mut site = full_site("Welcome to [the atlas](atlas:plato).");
    site.atlas = Some(public_atlas());
    site.link_concepts();
    assert_eq!(
        site.pages[0].html, "<p>About Plato and x.</p>\n",
        "{}",
        site.pages[0].html
    );
    assert!(site.series[0]
        .description_html
        .contains("A series on Plato."));
    // The warnings survive the resolution of the posts.
    for source in [
        "pages/about.md",
        "series/greeks.md",
        "openblog.json (home.intro)",
    ] {
        assert!(
            site.warnings.iter().any(|w| w.starts_with(source)
                && w.contains("atlas link `atlas:")
                && w.contains("posts only")),
            "{source}: {:?}",
            site.warnings
        );
    }
    let out = built(&site);
    for (path, contents) in &out {
        if path.ends_with(".html") {
            assert!(
                !contents.contains("href=\"atlas:") && !contents.contains("ob-concept data-id"),
                "{path}"
            );
        }
    }
    let home = out
        .iter()
        .find(|(path, _)| path.as_str() == "index.html")
        .map(|(_, contents)| contents)
        .unwrap_or_else(|| panic!("no home page in {:?}", out.keys().collect::<Vec<_>>()));
    assert!(home.contains("Welcome to the atlas."));
    // A site that does not use the syntax outside a post is unchanged.
    let plain = full_site("Welcome.");
    assert!(plain
        .warnings
        .iter()
        .all(|w| !w.starts_with("openblog.json (home.intro)")));
}

#[test]
fn unicode_labels_stay_whole_and_the_warning_prints_the_raw_id() {
    let body = "[Plátōn — 柏拉图 🏛️](atlas:plato) and [cafe\u{301}](atlas:allegory-of-the-cave).";
    let site = site_with(body, Some(public_atlas()), "https://example.com");
    let html = &site.posts[0].html;
    assert!(html.contains(">Plátōn — 柏拉图 🏛️<span"), "{html}");
    assert!(html.contains(">cafe\u{301}<span"), "{html}");
    assert_eq!(
        site.posts[0].portable_markdown(),
        "Plátōn — 柏拉图 🏛️ and cafe\u{301}."
    );

    // A malformed id is printed as written, never HTML-escaped, and a long
    // one is cut by characters, never through an entity or a character.
    let long = format!("{}&'\"{}", "a".repeat(37), "é".repeat(10));
    let body = format!(
        "[x](atlas:a&b) [y](atlas:caf\u{e9}) [z](<atlas:{long}>) [q](atlas:{}) .",
        "柏".repeat(60)
    );
    let site = site_with(&body, Some(public_atlas()), "https://example.com");
    let warnings = concept_warnings(&site);
    assert!(
        warnings.iter().any(|w| w.contains("`atlas:a&b`")),
        "{warnings:?}"
    );
    assert!(
        warnings.iter().any(|w| w.contains("`atlas:café`")),
        "{warnings:?}"
    );
    for warning in &warnings {
        assert!(
            !warning.contains("&amp;") && !warning.contains("&lt;") && !warning.contains("&#"),
            "{warning}"
        );
        assert!(!warning.contains('\u{FFFD}'), "{warning}");
    }
    let cut = warnings
        .iter()
        .find(|w| w.contains("aaaaaaaa"))
        .expect("cut");
    assert!(
        cut.contains(&format!("`atlas:{}&'\"", "a".repeat(37))),
        "{cut}"
    );
    assert!(warnings
        .iter()
        .any(|w| w.contains(&format!("`atlas:{}`", "柏".repeat(40)))));
}

#[test]
fn an_unclosed_or_block_spanning_mark_never_links_the_rest_of_the_post() {
    let body = "Start <ob-concept data-id=\"plato\">unclosed\n\nA later paragraph.\n\nAnd [Plato](atlas:plato) linked.";
    let site = site_with(body, Some(public_atlas()), "https://example.com");
    let html = &site.posts[0].html;
    assert_eq!(html.matches("<a ").count(), 1, "only the real link: {html}");
    assert!(html.contains("Start unclosed"), "{html}");
    assert!(html.contains("<p>A later paragraph.</p>"), "{html}");
    assert!(!html.contains("ob-concept data-id") && !html.contains("</ob-concept>"));
    // A closing tag in a later block does not close an earlier mark.
    let body = "Start <ob-concept data-id=\"plato\">open\n\nMiddle.\n\nEnd</ob-concept> done.";
    let site = site_with(body, Some(public_atlas()), "https://example.com");
    let html = &site.posts[0].html;
    assert!(!html.contains("<a "), "{html}");
    assert!(html.contains("<p>Middle.</p>"), "{html}");
}

// ---- Concept previews (ADR 0174, #74) --------------------------------------

fn rich_atlas() -> PublicAtlas {
    let library = SourceLibrary::parse(
        &json!({"version": 1, "sources": [
            {"id": "plato-republic", "kind": "work", "title": "Politeia"}]})
        .to_string(),
        &BTreeMap::new(),
    )
    .unwrap();
    let notebook = Notebook::parse(
        &json!({"version": 1, "passages": [], "notes": []}).to_string(),
        &library,
    )
    .unwrap();
    let atlas = Atlas::parse(
        &json!({"version": 1, "entries": [
            {"id": "plato", "kind": "person", "label": "Plato", "visibility": "approved",
             "aliases": ["Aristocles"], "summary": "An Athenian philosopher.\n\nHe wrote dialogues."},
            {"id": "republic", "kind": "work", "label": "Republic", "visibility": "approved",
             "source": "plato-republic"}],
            "relationships": [{"id": "r-authored", "kind": "authored", "from": "plato",
             "to": "republic", "assertedBy": {"kind": "author"}, "confidence": "plausible",
             "evidence": [{"source": "plato-republic",
                           "locators": [{"kind": "canonical", "value": "514a"}]}],
             "uncertainty": "The dating is unsettled.",
             "contestedBy": [{"by": {"kind": "named", "name": "A later editor"},
                              "note": "Dates it later.", "evidence": [{"source": "plato-republic"}]}],
             "visibility": "approved"}]})
        .to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .expect("a valid atlas");
    PublicAtlas::project(&atlas, &library).expect("a projection")
}

#[test]
fn the_preview_component_reads_only_fields_the_query_file_really_writes() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/concept-previews.json"
    ))
    .expect("fixtures");
    let query = openblog_core::atlas_query::AtlasQuery::project(&rich_atlas(), "Site Author", "")
        .expect("a query");
    let real: Value = serde_json::from_str(&query.to_json()).expect("json");
    let keys = |value: &Value| -> std::collections::BTreeSet<String> {
        value.as_object().unwrap().keys().cloned().collect()
    };
    let wanted = |name: &str| -> Vec<String> {
        fixtures["contract"][name]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key.as_str().unwrap().to_string())
            .collect()
    };
    // Every key the component reads is written, on a maximal item.
    let top = keys(&real);
    for key in wanted("top") {
        assert!(top.contains(&key), "top-level `{key}`");
    }
    let mut entry_keys = std::collections::BTreeSet::new();
    for entry in real["entries"].as_array().unwrap() {
        entry_keys.extend(keys(entry));
    }
    // `moreOut` and `moreIn` are only written when relationships were left out.
    entry_keys.insert("moreOut".to_string());
    entry_keys.insert("moreIn".to_string());
    for key in wanted("entry") {
        assert!(entry_keys.contains(&key), "entry `{key}`");
    }
    let edge = &real["edges"][0];
    // `uncertaintyClipped` is only written when the uncertainty was clipped.
    let mut edge_keys = keys(edge);
    edge_keys.insert("uncertaintyClipped".to_string());
    for key in wanted("edge") {
        assert!(edge_keys.contains(&key), "relationship `{key}`");
    }
    for key in wanted("evidence") {
        assert!(
            keys(&edge["evidence"][0]).contains(&key),
            "evidence `{key}`"
        );
    }
    for key in wanted("source") {
        assert!(keys(&real["sources"][0]).contains(&key), "source `{key}`");
    }
    // And the fixture's own query uses no key the real file does not write.
    let fixture = &fixtures["query"];
    for entry in fixture["entries"].as_array().unwrap() {
        for key in keys(entry) {
            assert!(entry_keys.contains(&key), "the fixture's entry key `{key}`");
        }
    }
    for key in keys(&fixture["edges"][0]) {
        assert!(edge_keys.contains(&key), "the fixture's edge key `{key}`");
    }
    // The wording the component shows is the file's: nothing to rebuild.
    assert_eq!(edge["assertedByText"], "Site Author (the site author)");
    assert_eq!(edge["confidenceText"], "Plausible");
    assert!(edge["evidence"][0]["text"]
        .as_str()
        .unwrap()
        .starts_with("Politeia"));
    assert_eq!(real["entries"][0]["kindLabel"], "Person");
}

#[test]
fn only_a_post_with_a_resolved_concept_link_loads_the_previews_and_it_reads_one_file() {
    let script = "/assets/components/ob-concept-previews.js";
    let site = site_with(BODY, Some(public_atlas()), "https://example.com");
    let out = built(&site);
    // The address carries the file's content hash, so it is never stale.
    let element = format!(
        "<ob-concept-previews src=\"/atlas-query.json?v={}\" data-bytes=\"{}\"></ob-concept-previews>",
        query_version(&out),
        out["atlas-query.json"].len()
    );
    let element = element.as_str();
    let page = &out["posts/cave/index.html"];
    assert_eq!(page.matches(element).count(), 1, "{page}");
    assert!(page.contains(script));
    // The element follows the article, inside the main region, and carries no data of its own.
    assert!(page.find(element).unwrap() > page.find("</article>").unwrap());
    assert!(page.find(element).unwrap() < page.find("</main>").unwrap());
    for (path, contents) in &out {
        if path != "posts/cave/index.html" {
            assert!(!contents.contains("ob-concept-previews"), "{path}");
        }
    }
    // The page still has its ordinary links without the component.
    assert!(page.contains("href=\"/atlas/plato/\""));

    // No resolved link, no component: unavailable ids, the atlas off, and posts
    // that do not use the syntax are written exactly as before.
    let plain_only = site_with(
        "A [x](atlas:secret).",
        Some(public_atlas()),
        "https://example.com",
    );
    let off = site_with(BODY, None, "https://example.com");
    let none = site_with("No links.", Some(public_atlas()), "https://example.com");
    for site in [&plain_only, &off, &none] {
        let page = built(site)["posts/cave/index.html"].clone();
        assert!(!page.contains("ob-concept-previews"), "{page}");
    }

    // A base path moves the file the component reads with every other address.
    let blog = site_with(BODY, Some(public_atlas()), "https://example.com/blog");
    let out = built(&blog);
    assert!(out["posts/cave/index.html"].contains(&format!(
        "<ob-concept-previews src=\"/blog/atlas-query.json?v={}\" data-bytes=\"{}\"></ob-concept-previews>",
        query_version(&out),
        out["atlas-query.json"].len()
    )));
    assert!(out["posts/cave/index.html"].contains("/blog/assets/components/ob-concept-previews.js"));
    assert!(out.contains_key("atlas-query.json"));
    // Deterministic.
    assert_eq!(
        out,
        built(&site_with(
            BODY,
            Some(public_atlas()),
            "https://example.com/blog"
        ))
    );
}

#[test]
fn a_query_that_is_not_written_means_no_previews_and_ordinary_links() {
    // An atlas over the query's bounds is left out of the build (ADR 0169); the
    // links are still links, and no component waits for a file that is not there.
    let entries: Vec<Value> = (0..2_001)
        .map(|n| json!({"id": format!("e-{n}"), "kind": "concept", "label": format!("Entry {n}"), "visibility": "approved"}))
        .collect();
    let library = SourceLibrary::parse(
        &json!({"version": 1, "sources": []}).to_string(),
        &BTreeMap::new(),
    )
    .unwrap();
    let notebook = Notebook::parse(
        &json!({"version": 1, "passages": [], "notes": []}).to_string(),
        &library,
    )
    .unwrap();
    let atlas = Atlas::parse(
        &json!({"version": 1, "entries": entries, "relationships": []}).to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .expect("a valid atlas");
    let public = PublicAtlas::project(&atlas, &library).expect("a projection");
    let site = site_with("A [one](atlas:e-1).", Some(public), "https://example.com");
    let out = built(&site);
    assert!(!out.contains_key("atlas-query.json"));
    let page = &out["posts/cave/index.html"];
    assert!(page.contains("href=\"/atlas/e-1/\""), "{page}");
    assert!(!page.contains("ob-concept-previews"), "{page}");
}

#[test]
fn a_link_in_a_heading_is_described_by_one_hint_and_keeps_the_headings_name() {
    let body = "## About [Plato](atlas:plato)\n\nAnd [Plato](atlas:plato) in prose.";
    let site = site_with(body, Some(public_atlas()), "https://example.com");
    let html = &site.posts[0].html;
    // The heading's link has no inline hidden words; it points at the one hint.
    assert!(
        html.contains("data-atlas-kind=\"person\" aria-describedby=\"ob-concept-hint\">Plato</a>"),
        "{html}"
    );
    // The prose link keeps its inline hint, and the hint exists exactly once.
    assert!(html.contains("Plato<span class=\"ob-visually-hidden\"> (atlas entry)</span></a>"));
    assert_eq!(html.matches("id=\"ob-concept-hint\"").count(), 1, "{html}");
    assert!(html.contains("hidden>Atlas entry</span>"));
    // A post with no link in a heading carries no hint element.
    let prose = site_with(
        "[Plato](atlas:plato) only.",
        Some(public_atlas()),
        "https://example.com",
    );
    assert!(!prose.posts[0].html.contains("ob-concept-hint"));
}

#[test]
fn a_raw_mark_that_is_dropped_is_never_silent() {
    let body = "A <ob-concept data-id=\"plato\">never closed.\n\nNext <ob-concept data-id=\"plato\">paragraph</ob-concept> is fine. And <ob-concept data-id=\"incomplete";
    let site = site_with(body, Some(public_atlas()), "https://example.com");
    let html = &site.posts[0].html;
    assert!(!html.to_lowercase().contains("<ob-concept"), "{html}");
    let warnings: Vec<_> = concept_warnings(&site);
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("is not closed in its own paragraph")),
        "{warnings:?}"
    );
}

#[test]
fn a_warning_never_carries_text_that_reorders_or_hides_other_text() {
    let id = "a\u{202E}b\u{2066}c\u{2069}d\u{200F}e\u{061C}f\u{FEFF}g\u{2028}h\u{0007}i";
    let body = format!("A [x](<atlas:{id}>) and ![y](<atlas:{id}>).");
    let site = site_with(&body, Some(public_atlas()), "https://example.com");
    let warnings = concept_warnings(&site);
    assert!(!warnings.is_empty());
    for warning in warnings {
        for c in warning.chars() {
            assert!(
                !matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{FEFF}' | '\u{2028}' | '\u{0007}'),
                "{warning:?}"
            );
        }
    }
}

#[test]
fn the_query_files_address_changes_with_its_content_and_is_the_same_otherwise() {
    let root = built(&site_with(
        BODY,
        Some(public_atlas()),
        "https://example.com",
    ));
    let blog = built(&site_with(
        BODY,
        Some(public_atlas()),
        "https://example.com/blog",
    ));
    assert_ne!(query_version(&root), query_version(&blog));
    assert_eq!(
        query_version(&root),
        query_version(&built(&site_with(
            BODY,
            Some(public_atlas()),
            "https://example.com"
        )))
    );
}

#[test]
fn no_heading_can_take_the_id_of_the_concept_hint() {
    // A heading whose slug is the hint's id, and one that writes it.
    let body = "## About [Plato](atlas:plato)\n\n## Ob concept hint\n\n## Another {#ob-concept-hint}\n\nProse.";
    let site = site_with(body, Some(public_atlas()), "https://example.com");
    let html = &site.posts[0].html;
    assert_eq!(html.matches("id=\"ob-concept-hint\"").count(), 1, "{html}");
    assert!(html.contains("id=\"ob-concept-hint-2\""), "{html}");
    assert!(
        html.contains("<span id=\"ob-concept-hint\" hidden>"),
        "{html}"
    );
}
