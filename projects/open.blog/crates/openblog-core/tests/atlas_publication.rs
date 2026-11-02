//! The public Knowledge Atlas projection (ADR 0058): the field allowlist,
//! approval and withdrawal, contested standing, direction and provenance,
//! determinism, escaping, the reserved path, and sites that do not publish.

use std::collections::BTreeMap;

use openblog_core::atlas_publication::PublicAtlas;
use openblog_core::knowledge_atlas::{Atlas, Links};
use openblog_core::research_bundle::looks_like_private_research;
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};
use serde_json::{json, Value};

/// Every private value carries this marker; none may be published.
const PRIVATE: &str = "PRIVATE-ATLAS-MARKER";

fn library() -> SourceLibrary {
    let text = json!({"version": 1, "sources": [
        {"id": "plato-republic", "kind": "work", "title": "Politeia",
         "creators": [{"name": "Plato", "role": "author"}],
         "secretPlan": format!("{PRIVATE} source extra"),
         "identifiers": [{"scheme": "my-drive", "value": format!("C:/{PRIVATE}/scan.pdf")}]},
        {"id": "republic-slings", "kind": "edition", "of": "plato-republic",
         "title": "Platonis Rempublicam", "issued": "2003"},
        {"id": "scholar-book", "kind": "work", "title": "A study of the dialogues"},
        {"id": "never-used", "kind": "work", "title": format!("{PRIVATE} unused source")}
    ]})
    .to_string();
    SourceLibrary::parse(&text, &BTreeMap::new()).expect("library")
}

fn notebook(library: &SourceLibrary) -> Notebook {
    let text = json!({"version": 1,
        "passages": [{"id": "p-cave", "source": "republic-slings",
            "excerpt": {"text": format!("{PRIVATE} quoted")}}],
        "notes": [{"id": "n-1", "kind": "question", "text": format!("{PRIVATE} noted"),
            "concepts": ["allegory"]}]})
    .to_string();
    Notebook::parse(&text, library).expect("notebook")
}

fn atlas_value() -> Value {
    json!({"version": 1,
        "entries": [
            {"id": "plato", "kind": "person", "label": "Plato", "aliases": ["Aristocles"],
             "summary": "An Athenian philosopher.\n\nHe wrote dialogues.",
             "bounds": {"from": -428, "until": -348, "circa": format!("{PRIVATE} bounds extra")},
             "visibility": "approved", "shelf": format!("{PRIVATE} entry extra")},
            {"id": "republic", "kind": "work", "label": "Republic", "source": "plato-republic",
             "visibility": "approved"},
            {"id": "allegory", "kind": "concept", "label": "Allegory <script>alert(1)</script> & more",
             "visibility": "approved"},
            {"id": "stoics", "kind": "movement", "label": "The Stoics", "visibility": "approved"},
            {"id": "secret", "kind": "concept", "label": format!("{PRIVATE} private label"),
             "summary": format!("{PRIVATE} private summary"), "visibility": "private"}
        ],
        "relationships": [
            {"id": "r-authored", "kind": "authored", "from": "plato", "to": "republic",
             "assertedBy": {"kind": "source", "source": "scholar-book",
                 "why": format!("{PRIVATE} party extra")},
             "confidence": "plausible",
             "evidence": [{"source": "republic-slings",
                 "locators": [{"kind": "page", "value": "514", "to": "520",
                     "hint": format!("{PRIVATE} locator extra")}],
                 "margin": format!("{PRIVATE} evidence extra")}],
             "uncertainty": "The dating is unsettled.",
             "contestedBy": [{"by": {"kind": "named", "name": "A later editor"},
                 "note": "Dates it later.", "evidence": [{"source": "plato-republic"}],
                 "tag": format!("{PRIVATE} dissent extra")}],
             "visibility": "approved", "shelf": format!("{PRIVATE} relationship extra")},
            {"id": "r-discusses", "kind": "discusses", "from": "republic", "to": "allegory",
             "assertedBy": {"kind": "author"}, "confidence": "strong",
             "evidence": [{"source": "plato-republic",
                 "locators": [{"kind": "canonical", "value": "514a"}]}],
             "visibility": "approved"},
            {"id": "r-member", "kind": "member-of", "from": "plato", "to": "stoics",
             "assertedBy": {"kind": "author"}, "confidence": "tentative",
             "evidence": [{"source": "scholar-book"}], "visibility": "approved"},
            {"id": "r-private", "kind": "related-to", "from": "plato", "to": "stoics",
             "assertedBy": {"kind": "author"}, "evidence": [{"source": "scholar-book"}],
             "uncertainty": format!("{PRIVATE} private relationship"), "visibility": "private"},
            {"id": "r-to-secret", "kind": "discusses", "from": "republic", "to": "secret",
             "assertedBy": {"kind": "author"}, "evidence": [{"source": "plato-republic"}],
             "uncertainty": format!("{PRIVATE} private endpoint"), "visibility": "approved"},
            {"id": "r-passage", "kind": "related-to", "from": "plato", "to": "stoics",
             "assertedBy": {"kind": "named", "name": format!("{PRIVATE} passage party")},
             "evidence": [{"source": "republic-slings", "passage": "p-cave"}],
             "visibility": "private"},
            {"id": "r-unsourced", "kind": "influenced", "from": "stoics", "to": "allegory",
             "assertedBy": {"kind": "author"}, "unsourced": true,
             "uncertainty": format!("{PRIVATE} unsourced"), "visibility": "private"}
        ],
        "workspace": format!("{PRIVATE} top-level extra")})
}

fn project(value: &Value) -> PublicAtlas {
    let library = library();
    let notebook = notebook(&library);
    let atlas = Atlas::parse(
        &value.to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .expect("a valid atlas");
    PublicAtlas::project(&atlas, &library).expect("a projection")
}

fn ids<T>(items: &[T], id: impl Fn(&T) -> &str) -> Vec<&str> {
    items.iter().map(id).collect()
}

fn config(url: &str) -> SiteConfig {
    SiteConfig::from_json(&format!(
        r#"{{"title": "Atlas", "url": "{url}", "author": {{"name": "Site Author"}}}}"#
    ))
    .unwrap()
}

/// A site that publishes its atlas exactly when it is given a projection, as
/// a build does.
fn site(mut config: SiteConfig, pages: Vec<SourceFile>, atlas: Option<PublicAtlas>) -> Site {
    config.knowledge_atlas.publish = atlas.is_some();
    let mut site = Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: "posts/hello.md".into(),
                contents: "---\ntitle: Hello\ndate: 2026-10-20\n---\nHello.".into(),
            }],
            pages,
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .expect("site");
    site.atlas = atlas;
    site
}

fn build(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .expect("generated")
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

#[test]
fn only_approved_items_and_allowlisted_fields_are_published() {
    let atlas = project(&atlas_value());
    assert_eq!(
        ids(&atlas.entries, |e| &e.id),
        ["allegory", "plato", "republic", "stoics"]
    );
    assert_eq!(
        ids(&atlas.relationships, |r| &r.id),
        ["r-authored", "r-discusses", "r-member"],
        "a private relationship, one to a private entry, one with a passage and an unsourced draft stay out"
    );
    assert_eq!(
        ids(&atlas.sources, |s| &s.reference.key),
        ["plato-republic", "republic-slings", "scholar-book"],
        "only the sources published items use"
    );
    let text = atlas.to_json();
    for private in [
        PRIVATE,
        "p-cave",
        "\"visibility\"",
        "\"unsourced\"",
        "\"passage\"",
        "r-private",
        "secret",
    ] {
        assert!(!text.contains(private), "the artifact carries {private}");
    }
    assert!(
        !looks_like_private_research(text.as_bytes()),
        "the public artifact is never mistaken for the private atlas"
    );

    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["format"], "openblog-atlas-projection");
    assert_eq!(value["formatVersion"], 1);
    assert!(value.get("version").is_none());
    assert_eq!(
        value["entries"][1],
        json!({"id": "plato", "kind": "person", "label": "Plato", "aliases": ["Aristocles"],
            "summary": "An Athenian philosopher.\n\nHe wrote dialogues.",
            "url": "/atlas/plato/"}),
        "a version 1 `bounds` is now a private, unsourced dating and is not published"
    );
    assert_eq!(
        value["relationships"][1],
        json!({"id": "r-discusses", "kind": "discusses", "from": "republic", "to": "allegory",
            "label": "discusses", "inverseLabel": "discussed in",
            "assertedBy": {"kind": "author"}, "confidence": "strong",
            "evidence": [{"source": "plato-republic",
                "locators": [{"kind": "canonical", "value": "514a"}]}],
            "standing": "asserted"})
    );
    assert_eq!(
        value["relationships"][2],
        json!({"id": "r-member", "kind": "member-of", "from": "plato", "to": "stoics",
            "label": "member of", "inverseLabel": "has member",
            "assertedBy": {"kind": "author"}, "confidence": "tentative",
            "evidence": [{"source": "scholar-book"}],
            "standing": "asserted"}),
        "the label reads in words and the kind stays the machine value"
    );
    assert_eq!(
        value["sources"][0],
        json!({"key": "plato-republic", "kind": "work", "title": "Politeia",
            "creators": [{"name": "Plato", "role": "author"}],
            "text": "Plato. Politeia"}),
        "a source keeps only its public description"
    );
}

#[test]
fn a_contested_relationship_keeps_provenance_direction_and_every_dissenting_party() {
    let atlas = project(&atlas_value());
    let value: Value = serde_json::from_str(&atlas.to_json()).unwrap();
    assert_eq!(
        value["relationships"][0],
        json!({"id": "r-authored", "kind": "authored", "from": "plato", "to": "republic",
            "label": "authored", "inverseLabel": "authored by",
            "assertedBy": {"kind": "source", "source": "scholar-book"},
            "confidence": "plausible",
            "evidence": [{"source": "republic-slings",
                "locators": [{"kind": "page", "value": "514", "to": "520"}]}],
            "uncertainty": "The dating is unsettled.",
            "standing": "contested",
            "contestedBy": [{"by": {"kind": "named", "name": "A later editor"},
                "evidence": [{"source": "plato-republic"}], "note": "Dates it later."}]})
    );
    let text = atlas.to_json().to_lowercase();
    for word in ["consensus", "agreed", "established"] {
        assert!(!text.contains(word), "{word}");
    }

    let files = build(&site(config("https://example.test"), vec![], Some(atlas)));
    let plato = &files["atlas/plato/index.html"];
    assert!(
        plato.contains("<strong>Contested:</strong> <strong>Plato</strong> authored <a href=\"/atlas/republic/\">Republic</a>."),
        "the stored direction is read the same way on both pages"
    );
    assert!(plato.contains("data-standing=\"contested\""));
    assert!(plato.contains("Contested: 1 recorded dissent."));
    assert!(plato.contains("<dt>Disputed by</dt><dd><ul><li>A later editor: Dates it later.<ul><li><cite>Plato. Politeia</cite></li></ul></li></ul></dd>"));
    assert!(plato.contains("<dt>Asserted by</dt><dd>A study of the dialogues</dd>"));
    assert!(plato.contains("<cite>Platonis Rempublicam. 2003, pp. 514–520</cite>"));
    assert!(plato.contains("<dt>Uncertain</dt><dd>The dating is unsettled.</dd>"));
    assert!(plato.contains("Also known as Aristocles"));
    assert!(
        !plato.contains("BCE") && !plato.contains("348"),
        "migrated years are the author's private, unsourced draft"
    );
    let republic = &files["atlas/republic/index.html"];
    assert!(republic.contains("<strong>Contested:</strong> <a href=\"/atlas/plato/\">Plato</a> authored <strong>Republic</strong>."));
    assert!(republic.contains("data-standing=\"asserted\""));
    assert!(republic.contains("Site Author (the site author)"));
    assert!(republic.contains(
        "Asserted. No disagreement is recorded here; that is not a claim that it is agreed."
    ));
    assert!(
        republic.contains("As recorded in the author&#39;s sources: <cite>Plato. Politeia</cite>")
            || republic
                .contains("As recorded in the author's sources: <cite>Plato. Politeia</cite>")
    );
}

#[test]
fn withdrawing_approval_removes_an_entry_and_every_relationship_touching_it() {
    let mut value = atlas_value();
    value["entries"][0]["visibility"] = json!("private");
    let atlas = project(&value);
    assert_eq!(
        ids(&atlas.entries, |e| &e.id),
        ["allegory", "republic", "stoics"]
    );
    assert_eq!(ids(&atlas.relationships, |r| &r.id), ["r-discusses"]);
    assert_eq!(
        ids(&atlas.sources, |s| &s.reference.key),
        ["plato-republic"],
        "sources only the withdrawn items used go too"
    );
    let text = atlas.to_json();
    assert!(!text.contains(r#""label":"Plato""#) && !text.contains("A later editor"));

    let mut relationship_only = atlas_value();
    relationship_only["relationships"][0]["visibility"] = json!("private");
    let atlas = project(&relationship_only);
    assert_eq!(
        ids(&atlas.relationships, |r| &r.id),
        ["r-discusses", "r-member"]
    );
    assert_eq!(atlas.entries.len(), 4, "the entries stay published");

    let files = build(&site(config("https://example.test"), vec![], Some(atlas)));
    assert!(!files["atlas/plato/index.html"].contains("authored"));
    assert!(
        files["atlas/plato/index.html"].contains(
            "<strong>Plato</strong> member of <a href=\"/atlas/stoics/\">The Stoics</a>."
        ),
        "a page reads the relationship in words"
    );
}

#[test]
fn the_projection_is_deterministic_whatever_the_stored_order() {
    let value = atlas_value();
    let mut reversed = value.clone();
    for key in ["entries", "relationships"] {
        reversed[key].as_array_mut().unwrap().reverse();
    }
    let first = project(&value);
    assert_eq!(first, project(&reversed));
    assert_eq!(first.to_json(), project(&reversed).to_json());
    let a = build(&site(config("https://example.test"), vec![], Some(first)));
    let b = build(&site(
        config("https://example.test"),
        vec![],
        Some(project(&reversed)),
    ));
    assert_eq!(a, b);
}

#[test]
fn pages_and_the_artifact_come_from_the_one_projection_and_hold_nothing_private() {
    let atlas = project(&atlas_value());
    let files = build(&site(
        config("https://example.test"),
        vec![],
        Some(atlas.clone()),
    ));
    for path in [
        "atlas/index.html",
        "atlas/allegory/index.html",
        "atlas/plato/index.html",
        "atlas/republic/index.html",
        "atlas/stoics/index.html",
        "atlas.json",
    ] {
        assert!(files.contains_key(path), "{path}");
    }
    assert!(!files.contains_key("atlas/secret/index.html"));
    assert_eq!(files["atlas.json"], atlas.to_json());
    assert!(
        !files["atlas.json"].contains(['<', '>', '&']),
        "markup characters are escaped in the artifact"
    );
    let parsed: Value = serde_json::from_str(&files["atlas.json"]).unwrap();
    assert_eq!(
        parsed["entries"][0]["label"],
        "Allegory <script>alert(1)</script> & more"
    );
    for (path, contents) in &files {
        assert!(
            !contents.contains(PRIVATE),
            "{path} leaks private atlas data"
        );
        assert!(!contents.contains("p-cave"), "{path} leaks a passage id");
        assert!(!contents.contains("<script>alert"), "{path} is not escaped");
    }
    let index = &files["atlas/index.html"];
    assert!(index.contains("<h2 id=\"atlas-person\">People</h2>"));
    assert!(index.contains("<a href=\"/atlas/allegory/\">Allegory &lt;script&gt;alert(1)&lt;/script&gt; &amp; more</a> <span class=\"ob-meta\">1 relationship</span>"));
    assert!(index.contains("<a href=\"/atlas.json\" type=\"application/json\">atlas.json</a>"));
    let sitemap = &files["sitemap.xml"];
    assert!(sitemap.contains("https://example.test/atlas/</loc>"));
    assert!(sitemap.contains("https://example.test/atlas/plato/</loc>"));
    assert!(!sitemap.contains("/atlas/secret/"));
    for path in ["search.json", "feed.json", "rss.xml", "llms.txt"] {
        if let Some(contents) = files.get(path) {
            assert!(
                !contents.contains("/atlas/"),
                "{path} is unchanged by the atlas"
            );
        }
    }
}

#[test]
fn section_and_relationship_ids_never_collide() {
    let mut value = atlas_value();
    value["relationships"][0]["id"] = json!("from");
    value["relationships"][1]["id"] = json!("to");
    let files = build(&site(
        config("https://example.test"),
        vec![],
        Some(project(&value)),
    ));
    for page in ["atlas/plato/index.html", "atlas/republic/index.html"] {
        let html = &files[page];
        let ids: Vec<&str> = html
            .split(" id=\"")
            .skip(1)
            .map(|rest| &rest[..rest.find('"').unwrap()])
            .collect();
        let unique: std::collections::BTreeSet<&str> = ids.iter().copied().collect();
        assert_eq!(unique.len(), ids.len(), "{page} repeats an id: {ids:?}");
        assert!(html.contains("<h2 id=\"atlas-section-from\">"), "{page}");
        assert!(html.contains("<h2 id=\"atlas-section-to\">"), "{page}");
    }
    assert!(files["atlas/republic/index.html"].contains("<li id=\"atlas-r-from\""));
    assert!(files["atlas/republic/index.html"].contains("<li id=\"atlas-r-to\""));
}

#[test]
fn a_site_that_does_not_publish_its_atlas_is_unchanged() {
    let without = build(&site(config("https://example.test"), vec![], None));
    assert!(without.keys().all(|path| !path.contains("atlas")));
    assert!(!without["sitemap.xml"].contains("/atlas/"));

    // The `atlas` path is reserved only while the atlas is published.
    let page = SourceFile {
        path: "pages/atlas.md".into(),
        contents: "---\ntitle: My atlas\n---\nMaps.".into(),
    };
    let legacy = build(&site(
        config("https://example.test"),
        vec![page.clone()],
        None,
    ));
    assert!(legacy["atlas/index.html"].contains("Maps."));
    let error = generate(
        &site(
            config("https://example.test"),
            vec![page],
            Some(project(&atlas_value())),
        ),
        &ThemeSet::new(),
    )
    .unwrap_err();
    assert!(
        error.contains("pages/atlas.md") && error.contains("reserved"),
        "{error}"
    );
}

#[test]
fn an_empty_projection_publishes_an_empty_atlas_and_urls_follow_the_base_path() {
    let mut value = atlas_value();
    for entry in value["entries"].as_array_mut().unwrap() {
        entry["visibility"] = json!("private");
    }
    let empty = project(&value);
    assert!(empty.entries.is_empty() && empty.relationships.is_empty() && empty.sources.is_empty());
    let files = build(&site(config("https://example.test"), vec![], Some(empty)));
    assert!(files["atlas/index.html"].contains("No entries have been published yet."));
    assert_eq!(
        files["atlas.json"],
        r#"{"format":"openblog-atlas-projection","formatVersion":1,"entries":[],"relationships":[],"sources":[]}"#
    );

    let files = build(&site(
        config("https://user.github.io/blog"),
        vec![],
        Some(project(&atlas_value())),
    ));
    assert!(files["atlas.json"].contains(r#""url":"/blog/atlas/plato/""#));
    assert!(files["atlas/index.html"].contains("href=\"/blog/atlas/plato/\""));
}

#[test]
fn approved_datings_publish_through_the_allowlist_and_nothing_else_does() {
    let mut value = atlas_value();
    value["version"] = json!(2);
    value["entries"][0]
        .as_object_mut()
        .unwrap()
        .remove("bounds");
    value["entries"][0]["dates"] = json!([
        {"id": "plato-birth-public", "aspect": "birth",
         "date": {"notBefore": {"year": -428, "circa": true, "hint": format!("{PRIVATE} point extra")},
                  "notAfter": {"year": -427}, "fuzz": format!("{PRIVATE} date extra")},
         "assertedBy": {"kind": "source", "source": "scholar-book", "why": format!("{PRIVATE} party extra")},
         "evidence": [{"source": "republic-slings",
             "locators": [{"kind": "page", "value": "9", "hint": format!("{PRIVATE} locator extra")}],
             "margin": format!("{PRIVATE} evidence extra")}],
         "note": "Reckoned from the archon list.", "visibility": "approved",
         "shelf": format!("{PRIVATE} dating extra")},
        {"id": "plato-death-private-marker", "aspect": "death",
         "date": {"relative": {"order": "after", "entry": "republic", "aspect": "composition",
             "tag": format!("{PRIVATE} relative extra")}},
         "assertedBy": {"kind": "named", "name": format!("{PRIVATE} dating party")},
         "unsourced": true},
        {"id": "plato-cited-private-marker", "aspect": "death", "date": {"at": {"year": -347}},
         "assertedBy": {"kind": "author"}, "evidence": [{"source": "scholar-book"}],
         "note": format!("{PRIVATE} private dating note")},
        {"id": "plato-passage-marker", "aspect": "death", "date": {"at": {"year": -348}},
         "assertedBy": {"kind": "author"},
         "evidence": [{"source": "republic-slings", "passage": "p-cave"}],
         "note": format!("{PRIVATE} passage dating note")},
        {"id": "plato-to-secret-marker", "aspect": "death",
         "date": {"relative": {"order": "after", "entry": "secret", "aspect": "span"}},
         "assertedBy": {"kind": "author"}, "evidence": [{"source": "scholar-book"}],
         "note": format!("{PRIVATE} relative to a private entry"), "visibility": "approved"}
    ]);
    value["entries"][4]["dates"] = json!([
        {"id": "secret-span-marker", "aspect": "span", "date": {"at": {"century": -4}},
         "assertedBy": {"kind": "author"}, "evidence": [{"source": "scholar-book"}],
         "note": format!("{PRIVATE} dating of a private entry"), "visibility": "approved"}
    ]);
    value["relationships"][0]["dates"] = json!([
        {"id": "r-authored-held", "aspect": "span",
         "date": {"from": {"decade": -380}, "to": {"century": -4}},
         "assertedBy": {"kind": "author"}, "evidence": [{"source": "scholar-book"}],
         "visibility": "approved"}
    ]);
    value["relationships"][4]["dates"] = json!([
        {"id": "r-to-secret-held-marker", "aspect": "span", "date": {"at": {"year": -380}},
         "assertedBy": {"kind": "author"}, "evidence": [{"source": "scholar-book"}],
         "note": format!("{PRIVATE} dating of an unpublished relationship"), "visibility": "approved"}
    ]);
    let atlas = project(&value);
    assert_eq!(
        ids(&atlas.datings, |d| &d.id),
        ["plato-birth-public", "r-authored-held"],
        "only approved, cited datings of published items with no passage and no private target"
    );
    let parsed: Value = serde_json::from_str(&atlas.to_json()).unwrap();
    assert_eq!(
        parsed["datings"][0],
        json!({"id": "plato-birth-public", "owner": "plato", "ownerType": "entry",
            "aspect": "birth",
            "date": {"notBefore": {"year": -428, "circa": true}, "notAfter": {"year": -427}},
            "text": "between c. 428 BCE and 427 BCE", "placement": "dated",
            "startYear": -428, "endYear": -427,
            "assertedBy": {"kind": "source", "source": "scholar-book"},
            "confidence": "tentative",
            "evidence": [{"source": "republic-slings", "locators": [{"kind": "page", "value": "9"}]}],
            "note": "Reckoned from the archon list."}),
        "exactly the allowlisted fields"
    );
    assert_eq!(parsed["datings"][1]["ownerType"], "relationship");
    assert_eq!(
        parsed["datings"][1]["text"],
        "from the 380s BCE to 4th century BCE"
    );
    let files = build(&site(config("https://example.test"), vec![], Some(atlas)));
    for (path, contents) in &files {
        assert!(
            !contents.contains(PRIVATE),
            "{path} carries a private value"
        );
        assert!(
            !contents.contains("marker"),
            "{path} carries a private dating"
        );
        assert!(!contents.contains("p-cave"), "{path} carries a passage id");
    }
    let published: Vec<&String> = files
        .iter()
        .filter(|(_, contents)| contents.contains("Reckoned from the archon list."))
        .map(|(path, _)| path)
        .collect();
    assert_eq!(
        published,
        ["atlas.json", "atlas/index.html", "atlas/plato/index.html"],
        "a dating reaches only the atlas pages and atlas.json"
    );
}
