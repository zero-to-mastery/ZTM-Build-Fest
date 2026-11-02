//! The published reference and citation-preview data contract (ADR 0059):
//! every citation resolves to a visible reference, versions and locations
//! stay distinct, legacy posts are unchanged, output is deterministic,
//! script-safe and holds nothing private.

use std::collections::BTreeMap;

use openblog_core::bibliography::{
    CitationLocale, CitationPlacement, CitationStyle, CitationSummary,
};
use openblog_core::citations::PublicReference;
use openblog_core::model::LibrarySource;
use openblog_core::reader_references::{ReaderReferences, READER_REFERENCES_VERSION};
use openblog_core::{LoadOptions, Site, SiteConfig, SourceFile, Sources};

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
     "csl": {"publisher": "Oxford University Press", "note": "PRIVATE-MARKER csl note"}},
    {"id": "hostile", "kind": "work",
     "title": "</script><script>alert(1)</script> & \u2028 more",
     "identifiers": [{"scheme": "url", "value": "https://example.org/a_(b)?q=1"}]},
    {"id": "never-cited", "kind": "work", "title": "PRIVATE-MARKER uncited title"}
  ]
}"#;

fn site(post: &str, with_library: bool) -> Site {
    load(post, with_library.then_some(LIBRARY))
}

fn site_with(post: &str, library: &str) -> Site {
    load(post, Some(library))
}

fn load(post: &str, library: Option<&str>) -> Site {
    let config = SiteConfig::from_json(
        r#"{"title": "T", "url": "https://example.test", "author": {"name": "A"}}"#,
    )
    .unwrap();
    let sources = Sources {
        posts: vec![SourceFile {
            path: "content/posts/cave.md".into(),
            contents: post.into(),
        }],
        source_library: library.map(|text| {
            LibrarySource::Text(SourceFile {
                path: ".openblog/private/research/sources.json".into(),
                contents: text.into(),
            })
        }),
        ..Default::default()
    };
    Site::load(config, sources, LoadOptions::default()).expect("site loads")
}

fn post(style: &str) -> String {
    format!(
        "---
title: The cave
date: 2026-10-20
citations: {style}
---
The cave [@republic-slings-2003, page 514 to 520; line 3].
Again [@republic-slings-2003, page 514 to 520; line 3], the work [@plato-republic, canonical 514a],
and the edition elsewhere [@republic-slings-2003, page 521] then [@hostile].
"
    )
}

fn data(style: &str) -> ReaderReferences {
    site(&post(style), true).posts[0]
        .reader_references()
        .expect("published citations")
}

#[test]
fn every_citation_resolves_to_a_reference_and_a_visible_note() {
    for style in ["notes", "bibliography"] {
        let site = site(&post(style), true);
        let post = &site.posts[0];
        let data = post.reader_references().unwrap();
        data.validate().unwrap();
        data.check_page(&post.html).unwrap();
        assert_eq!(data.version, READER_REFERENCES_VERSION);
        assert_eq!(data.style, style);
        assert_eq!(data.citations.len(), 5, "{style}");
        let ids: Vec<_> = data.references.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["republic-slings-2003", "plato-republic", "hostile"]);
        for citation in &data.citations {
            assert!(ids.contains(&citation.reference.as_str()));
        }
    }
}

#[test]
fn identical_citations_share_a_note_and_markers_stay_unique() {
    let pairs = |data: &ReaderReferences| -> Vec<(String, String)> {
        data.citations
            .iter()
            .map(|c| (c.marker.clone(), c.note.clone()))
            .collect()
    };
    let pair = |marker: &str, note: &str| (marker.to_string(), note.to_string());
    assert_eq!(
        pairs(&data("notes")),
        [
            pair("cite-1-ref-1", "cite-1"),
            pair("cite-1-ref-2", "cite-1"),
            pair("cite-2-ref-1", "cite-2"),
            pair("cite-3-ref-1", "cite-3"),
            pair("cite-4-ref-1", "cite-4"),
        ]
    );
    // In a bibliography the note is the reference's: the three citations of
    // the edition share note 1 and keep distinct markers.
    assert_eq!(
        pairs(&data("bibliography")),
        [
            pair("cite-1-ref-1", "cite-1"),
            pair("cite-1-ref-2", "cite-1"),
            pair("cite-2-ref-1", "cite-2"),
            pair("cite-1-ref-3", "cite-1"),
            pair("cite-3-ref-1", "cite-3"),
        ]
    );
}

#[test]
fn version_identity_and_location_are_distinct() {
    let data = data("notes");
    let work = data
        .references
        .iter()
        .find(|r| r.id == "plato-republic")
        .unwrap();
    let edition = data
        .references
        .iter()
        .find(|r| r.id == "republic-slings-2003")
        .unwrap();
    assert_eq!(work.preview.kind, "work");
    assert_eq!(edition.preview.kind, "edition");
    assert_ne!(work.id, edition.id);
    let pages: Vec<Vec<&str>> = data
        .citations
        .iter()
        .filter(|c| c.reference == edition.id)
        .map(|c| c.locators.iter().map(|l| l.value.as_str()).collect())
        .collect();
    assert_eq!(pages, [vec!["514", "3"], vec!["514", "3"], vec!["521"]]);
    assert!(
        !data.to_json().contains("\"of\""),
        "relationships stay private"
    );
}

#[test]
fn preview_fields_come_from_the_allowlist_only() {
    let data = data("notes");
    let json = data.to_json();
    for private in [
        "PRIVATE-MARKER",
        "secretPlan",
        "my-drive",
        "never-cited",
        "archived",
    ] {
        assert!(!json.contains(private), "{private}");
    }
    let edition = &data.references[0];
    assert_eq!(edition.link.as_deref(), Some("https://doi.org/10.1000/xyz"));
    assert_eq!(
        edition.preview.csl.get("publisher").unwrap(),
        "Oxford University Press"
    );
    assert!(edition.formatted.contains("Platonis Rempublicam"));
}

#[test]
fn embedded_json_cannot_close_the_script_and_parses_identically() {
    let data = data("notes");
    let embedded = data.to_embedded_json();
    for unsafe_text in ["<", ">", "&", "\u{2028}"] {
        assert!(!embedded.contains(unsafe_text), "{unsafe_text:?}");
    }
    let plain: serde_json::Value = serde_json::from_str(&data.to_json()).unwrap();
    let safe: serde_json::Value = serde_json::from_str(&embedded).unwrap();
    assert_eq!(plain, safe);
    assert!(plain.to_string().contains("</script>"));
    let element = data.to_script_element();
    assert_eq!(element.matches("</script>").count(), 1);
    assert!(element.starts_with("<script type=\"application/json\" id=\"ob-references\">"));
}

#[test]
fn web_addresses_link_only_when_plain_http() {
    let data = data("notes");
    let hostile = data.references.iter().find(|r| r.id == "hostile").unwrap();
    assert_eq!(
        hostile.link.as_deref(),
        Some("https://example.org/a_(b)?q=1")
    );
}

#[test]
fn output_is_deterministic() {
    assert_eq!(data("notes").to_json(), data("notes").to_json());
    assert_eq!(data("notes"), data("notes"));
}

#[test]
fn legacy_and_non_opted_in_posts_have_no_reference_data() {
    let legacy = "---\ntitle: Old\ndate: 2026-10-20\n---\nPlain [@plato-republic] text.\n";
    assert!(site(legacy, true).posts[0].reader_references().is_none());
    assert!(site(legacy, false).posts[0].reader_references().is_none());
    let none_cited = "---\ntitle: Old\ndate: 2026-10-20\ncitations: notes\n---\nNothing cited.\n";
    assert!(site(none_cited, true).posts[0]
        .reader_references()
        .is_none());
}

#[test]
fn an_author_footnote_named_like_ours_moves_the_anchors_and_the_page_agrees() {
    let text = "---
title: Clash
date: 2026-10-20
citations: notes
---
Mine[^cite-1] and [@plato-republic].

[^cite-1]: author note
";
    let site = site(text, true);
    let data = site.posts[0].reader_references().unwrap();
    assert_eq!(data.citations[0].note, "cite2-1");
    data.check_page(&site.posts[0].html).unwrap();
}

#[test]
fn validation_rejects_dangling_duplicate_and_unused_data() {
    let mut dangling = data("notes");
    dangling.citations[0].reference = "missing".into();
    assert!(dangling.validate().unwrap_err().contains("missing"));
    let mut duplicate = data("notes");
    duplicate.citations[1].marker = duplicate.citations[0].marker.clone();
    assert!(duplicate.validate().is_err());
    let mut unused = data("notes");
    unused.citations.retain(|c| c.reference != "hostile");
    assert!(unused.validate().unwrap_err().contains("never cited"));
    let site = site(&post("notes"), true);
    let mut gone = site.posts[0].reader_references().unwrap();
    gone.citations[0].marker = "cite-99-ref-1".into();
    assert!(gone.check_page(&site.posts[0].html).is_err());
}

#[test]
fn reference_links_resolve_every_stored_doi_form() {
    let library = r#"{
  "version": 1,
  "sources": [
    {"id": "prefixed", "kind": "work", "title": "Prefixed",
     "identifiers": [{"scheme": "doi", "value": "doi:10.1000/prefixed"}]},
    {"id": "resolver", "kind": "work", "title": "Resolver",
     "identifiers": [{"scheme": "doi", "value": "https://doi.org/10.1000/resolver"}]}
  ]
}"#;
    let text = "---\ntitle: DOIs\ndate: 2026-10-20\ncitations: notes\n---\nA [@prefixed] and [@resolver].\n";
    let data = site_with(text, library).posts[0]
        .reader_references()
        .unwrap();
    let links: Vec<_> = data.references.iter().map(|r| r.link.as_deref()).collect();
    assert_eq!(
        links,
        [
            Some("https://doi.org/10.1000/prefixed"),
            Some("https://doi.org/10.1000/resolver"),
        ]
    );
}

#[test]
fn a_reference_with_nothing_but_its_key_previews_as_its_key() {
    // The library requires a title of a work, so the bare reference is built
    // directly, as a summary the projection could be handed.
    let bare = PublicReference {
        key: "bare-source".into(),
        kind: "work",
        title: None,
        creators: Vec::new(),
        issued: None,
        language: None,
        identifiers: Vec::new(),
        csl: BTreeMap::new(),
    };
    let summary = CitationSummary {
        style: CitationStyle::Notes,
        locale: CitationLocale::En,
        citations: 1,
        notes: 1,
        references: vec![bare],
        prefix: "cite-".into(),
        placements: vec![CitationPlacement {
            reference: 1,
            note: 1,
            locators: Vec::new(),
        }],
    };
    let data = ReaderReferences::from_summary(&summary).unwrap();
    let reference = &data.references[0];
    assert_eq!(reference.formatted, "bare-source");
    assert_eq!(reference.link, None);
    let json: serde_json::Value = serde_json::from_str(&data.to_json()).unwrap();
    let entry = &json["references"][0];
    assert!(entry.get("link").is_none(), "{entry}");
    // No field is present but empty: no "", [], {} or null anywhere.
    fn no_empty(value: &serde_json::Value, path: &str) {
        match value {
            serde_json::Value::Null => panic!("{path} is null"),
            serde_json::Value::String(text) => assert!(!text.is_empty(), "{path} is empty"),
            serde_json::Value::Array(items) => {
                assert!(!items.is_empty(), "{path} is empty");
                for (index, item) in items.iter().enumerate() {
                    no_empty(item, &format!("{path}[{index}]"));
                }
            }
            serde_json::Value::Object(fields) => {
                assert!(!fields.is_empty(), "{path} is empty");
                for (name, field) in fields {
                    no_empty(field, &format!("{path}.{name}"));
                }
            }
            _ => {}
        }
    }
    no_empty(entry, "references[0]");
}

#[test]
fn each_citation_carries_its_locators_as_readers_see_them() {
    let notes = data("notes");
    let formatted: Vec<Option<&str>> = notes
        .citations
        .iter()
        .map(|citation| citation.formatted.as_deref())
        .collect();
    assert_eq!(
        formatted,
        [
            Some("pp. 514\u{2013}520, l. 3"),
            Some("pp. 514\u{2013}520, l. 3"),
            Some("514a"),
            Some("p. 521"),
            None,
        ]
    );
    // In the notes' locale, and absent from the JSON when there are none.
    let german = post("notes").replace("citations: notes", "citations: notes\ncitationLocale: de");
    let german = site(&german, true).posts[0].reader_references().unwrap();
    assert_eq!(
        german.citations[0].formatted.as_deref(),
        Some("S. 514\u{2013}520, Z. 3")
    );
    let json: serde_json::Value = serde_json::from_str(&notes.to_json()).unwrap();
    assert_eq!(
        json["citations"][0]["formatted"],
        "pp. 514\u{2013}520, l. 3"
    );
    assert!(json["citations"][4].get("formatted").is_none());
}
