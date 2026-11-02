//! Publishing approved chronology (ADR 0099, ADR 0100): datings on entry
//! pages with attribution and evidence, competing datings side by side, the
//! progressive timeline on the atlas index, relative datings as navigable
//! trails, relationship datings, BCE written readably, determinism, escaping,
//! unique fragment ids, and sites without published datings left byte for
//! byte as they were.

use std::collections::{BTreeMap, BTreeSet};

use openblog_core::atlas_publication::PublicAtlas;
use openblog_core::knowledge_atlas::{Atlas, Links};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};
use serde_json::{json, Value};

const HOSTILE: &str = "<img src=x onerror=alert(1)> Πλάτων & co";

fn library() -> SourceLibrary {
    let text = json!({"version": 1, "sources": [
        {"id": "nails-2002", "kind": "work", "title": "The People of Plato"},
        {"id": "diogenes", "kind": "work", "title": "Lives of the Eminent Philosophers"},
        {"id": "kahn-1996", "kind": "work", "title": "Plato and the Socratic Dialogue"}
    ]})
    .to_string();
    SourceLibrary::parse(&text, &BTreeMap::new()).expect("library")
}

fn notebook(library: &SourceLibrary) -> Notebook {
    Notebook::parse(r#"{"version": 1, "passages": [], "notes": []}"#, library).expect("notebook")
}

/// An approved dating by `source`, citing it.
fn dating(id: &str, aspect: &str, date: Value, source: &str) -> Value {
    json!({"id": id, "aspect": aspect, "date": date,
        "assertedBy": {"kind": "source", "source": source}, "confidence": "plausible",
        "evidence": [{"source": source, "locators": [{"kind": "chapter", "value": "3"}]}],
        "visibility": "approved"})
}

fn atlas_value() -> Value {
    let mut named = dating(
        "plato-birth-named",
        "birth",
        json!({"at": {"year": -424, "circa": true}}),
        "nails-2002",
    );
    named["assertedBy"] = json!({"kind": "named", "name": "An <b>old</b> scholiast"});
    named["note"] = json!("Counts <script>alert(1)</script> & archons.");
    json!({"version": 2,
    "entries": [
        {"id": "plato", "kind": "person", "label": HOSTILE, "visibility": "approved", "dates": [
            dating("plato-birth-diogenes", "birth",
                json!({"notBefore": {"year": -428}, "notAfter": {"year": -427}}), "diogenes"),
            named,
            dating("plato-death", "death", json!({"at": {"year": -348, "circa": true}}), "diogenes"),
            dating("plato-active", "active", json!({"from": {"decade": -390}, "to": {"century": -4}}), "nails-2002")
        ]},
        {"id": "phaedo", "kind": "work", "label": "Phaedo", "visibility": "approved", "dates": [
            dating("phaedo-composition", "composition", json!({"notAfter": {"year": -360}}), "kahn-1996")
        ]},
        {"id": "republic", "kind": "work", "label": "Republic", "visibility": "approved", "dates": [
            dating("republic-after-phaedo", "composition",
                json!({"relative": {"order": "after", "entry": "phaedo", "aspect": "composition"}}), "kahn-1996"),
            dating("republic-publication", "publication", json!({"unknown": true}), "kahn-1996")
        ]},
        {"id": "academy", "kind": "movement", "label": "The Academy", "visibility": "approved"},
        {"id": "augustus", "kind": "person", "label": "Augustus", "visibility": "approved", "dates": [
            dating("augustus-death", "death",
                json!({"at": {"year": 14, "month": 8, "day": 19, "calendar": "julian"}}), "nails-2002")
        ]}
    ],
    "relationships": [
        {"id": "plato-member", "kind": "member-of", "from": "plato", "to": "academy",
         "assertedBy": {"kind": "author"}, "evidence": [{"source": "nails-2002"}],
         "visibility": "approved",
         "dates": [dating("plato-member-held", "span", json!({"from": {"year": -387}}), "nails-2002")]},
        {"id": "plato-authored", "kind": "authored", "from": "plato", "to": "republic",
         "assertedBy": {"kind": "author"}, "evidence": [{"source": "kahn-1996"}],
         "visibility": "approved"}
    ]})
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
    .unwrap_or_else(|diagnostics| panic!("valid atlas: {diagnostics:?}"));
    PublicAtlas::project(&atlas, &library).expect("a projection")
}

fn build(atlas: Option<PublicAtlas>) -> BTreeMap<String, String> {
    let mut config = SiteConfig::from_json(
        r#"{"title": "Atlas", "url": "https://example.test", "author": {"name": "Site Author"}}"#,
    )
    .unwrap();
    config.knowledge_atlas.publish = atlas.is_some();
    let mut site = Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: "posts/hello.md".into(),
                contents: "---\ntitle: Hello\ndate: 2026-10-20\n---\nHello.".into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .expect("site");
    site.atlas = atlas;
    generate(&site, &ThemeSet::new())
        .expect("generated")
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

fn ids_in(html: &str) -> Vec<&str> {
    html.split(" id=\"")
        .skip(1)
        .map(|rest| &rest[..rest.find('"').unwrap()])
        .collect()
}

/// The part of a page between two markers.
fn between<'a>(html: &'a str, start: &str, end: &str) -> &'a str {
    let from = html
        .find(start)
        .unwrap_or_else(|| panic!("{start} missing"));
    let to = html[from..].find(end).map_or(html.len(), |at| from + at);
    &html[from..to]
}

#[test]
fn entry_pages_show_every_dating_with_attribution_and_evidence_and_competing_ones_side_by_side() {
    let files = build(Some(project(&atlas_value())));
    let plato = &files["atlas/plato/index.html"];
    let dates = between(
        plato,
        "<h2 id=\"atlas-section-dates\">",
        "atlas-section-from",
    );
    assert!(dates.contains("<h3 id=\"atlas-dates-birth\">Birth</h3>\n<p class=\"ob-meta\">2 competing datings, side by side. None is preferred.</p>"));
    // Both births, in the one display order, each attributed and cited.
    let birth = between(dates, "atlas-dates-birth", "atlas-dates-death");
    let diogenes = birth.find("id=\"atlas-d-plato-birth-diogenes\"").unwrap();
    let named = birth.find("id=\"atlas-d-plato-birth-named\"").unwrap();
    assert!(diogenes < named, "the earlier window is listed first");
    assert!(birth.contains("<p class=\"ob-atlas-date\">between 428 BCE and 427 BCE</p>"));
    assert!(birth.contains("<p class=\"ob-atlas-date\">c. 424 BCE</p>"));
    assert!(birth.contains("<dt>Dated by</dt><dd>Lives of the Eminent Philosophers</dd>"));
    assert!(birth.contains("<dt>Dated by</dt><dd>An &lt;b&gt;old&lt;/b&gt; scholiast</dd>"));
    assert!(birth.contains("<dt>Confidence</dt><dd>Plausible: how firmly the dating party holds it, not how widely it is accepted.</dd>"));
    assert!(birth.contains(
        "<dt>Evidence</dt><dd><ul><li><cite>The People of Plato, ch. 3</cite></li></ul></dd>"
    ));
    assert!(birth.contains(
        "<dt>Note</dt><dd>Counts &lt;script&gt;alert(1)&lt;/script&gt; &amp; archons.</dd>"
    ));
    assert!(dates.contains("<h3 id=\"atlas-dates-death\">Death</h3>\n<p class=\"ob-meta\">1 dating; no competing dating is published.</p>"));
    assert!(dates.contains("<h3 id=\"atlas-dates-active\">Activity (floruit)</h3>"));
    assert!(dates.contains("from the 390s BCE to 4th century BCE"));
    // Nothing is resolved, preferred or averaged anywhere.
    for word in [
        "preferred date",
        "most likely",
        "consensus",
        "average",
        "accepted date",
    ] {
        assert!(!plato.contains(word), "{word}");
    }
    // A relationship's own datings say when it held, attributed and cited.
    let member = between(plato, "<li id=\"atlas-r-plato-member\"", "</li>\n</ul>");
    assert!(member
        .contains("<dt>When it held</dt><dd><p>1 dating; no competing dating is published.</p>"));
    assert!(member.contains("id=\"atlas-d-plato-member-held\""));
    assert!(member.contains("<p class=\"ob-atlas-date\">from 387 BCE</p>"));
    // A day in a named calendar is read back as stated, never converted.
    assert!(files["atlas/augustus/index.html"]
        .contains("<p class=\"ob-atlas-date\">19 Aug 14 CE (julian)</p>"));
    // An undated entry with nothing pointing at it has no dates section.
    assert!(!files["atlas/academy/index.html"].contains("atlas-section-dates"));
}

#[test]
fn relative_datings_are_trails_that_link_both_ways_and_infer_nothing() {
    let atlas = project(&atlas_value());
    let files = build(Some(atlas.clone()));
    let republic = &files["atlas/republic/index.html"];
    // The step out: an asserted order, linking to the other entry's datings.
    assert!(republic.contains("<p class=\"ob-atlas-date\">after the composition of <a href=\"/atlas/phaedo/#atlas-dates-composition\">Phaedo</a></p>"));
    assert!(republic.contains("<p class=\"ob-atlas-date\">unknown, as the dating party states</p>"));
    // The step back, on the other entry's page, to the dating in full.
    let phaedo = &files["atlas/phaedo/index.html"];
    let back = between(phaedo, "<h3 id=\"atlas-dates-relative-to\">", "</section>");
    assert!(back.contains("Composition of <a href=\"/atlas/republic/#atlas-d-republic-after-phaedo\">Republic</a>: after the composition of <strong>Phaedo</strong>"));
    assert!(back.contains("<dt>Dated by</dt><dd>Plato and the Socratic Dialogue</dd>"));
    assert!(
        !back.contains(" id=\"atlas-d-"),
        "the step back does not repeat the dating's anchor"
    );
    // A relative dating creates no relationship and no other dating.
    assert_eq!(atlas.relationships.len(), 2);
    assert!(
        atlas.relationships_of("phaedo").0.is_empty()
            && atlas.relationships_of("phaedo").1.is_empty()
    );
    assert_eq!(atlas.datings.len(), 9);
    // Every trail link lands on an id that exists on the page it names.
    let pages: BTreeMap<String, BTreeSet<String>> = files
        .iter()
        .filter(|(path, _)| path.starts_with("atlas/") && path.ends_with("index.html"))
        .map(|(path, html)| {
            let url = format!("/{}", path.trim_end_matches("index.html"));
            (url, ids_in(html).into_iter().map(str::to_string).collect())
        })
        .collect();
    for (path, html) in files.iter().filter(|(path, _)| path.starts_with("atlas/")) {
        for link in html.split("href=\"").skip(1) {
            let link = &link[..link.find('"').unwrap()];
            let (page, fragment) = match link.split_once('#') {
                Some(("", fragment)) => (
                    format!("/{}", path.trim_end_matches("index.html")),
                    fragment,
                ),
                Some((page, fragment)) if page.starts_with("/atlas/") => {
                    (page.to_string(), fragment)
                }
                _ => continue,
            };
            let ids = pages
                .get(&page)
                .unwrap_or_else(|| panic!("{path} links to a missing page {page}"));
            assert!(
                ids.contains(fragment),
                "{path} links to {page}#{fragment}, which is not there"
            );
        }
    }
}

#[test]
fn the_timeline_lists_the_complete_chronology_in_order_by_period_without_javascript() {
    let files = build(Some(project(&atlas_value())));
    let index = &files["atlas/index.html"];
    assert!(index.contains("<p class=\"ob-meta\">The <a href=\"#atlas-timeline\">timeline</a> lists 9 published datings in time order.</p>"));
    assert!(index.contains(
        "<script type=\"module\" src=\"/assets/components/ob-atlas-timeline.js\"></script>"
    ));
    let timeline = between(index, "<ob-atlas-timeline>", "</ob-atlas-timeline>");
    // Periods in order, BCE written out, the open start first.
    let periods: Vec<&str> = timeline
        .split("<h3 id=\"atlas-period-")
        .skip(1)
        .map(|rest| &rest[..rest.find('"').unwrap()])
        .collect();
    assert_eq!(periods, ["open", "bce-5", "bce-4", "ce-1"]);
    for heading in [
        ">No earliest year stated (open start)</h3>",
        ">5th century BCE</h3>",
        ">4th century BCE</h3>",
        ">1st century CE</h3>",
    ] {
        assert!(timeline.contains(heading), "{heading}");
    }
    // Every dating appears exactly once with its anchor, citations and notes.
    for id in [
        "phaedo-composition",
        "plato-birth-diogenes",
        "plato-birth-named",
        "plato-active",
        "plato-member-held",
        "plato-death",
        "augustus-death",
        "republic-after-phaedo",
        "republic-publication",
    ] {
        assert_eq!(
            timeline.matches(&format!("id=\"atlas-d-{id}\"")).count(),
            1,
            "{id}"
        );
    }
    assert_eq!(timeline.matches("<dt>Evidence</dt>").count(), 9);
    assert!(timeline.contains("Counts &lt;script&gt;alert(1)&lt;/script&gt; &amp; archons."));
    // Competing datings stay in one row.
    let birth = between(timeline, "data-aspect=\"birth\"", "</ul>\n</li>");
    assert!(birth.contains("data-datings=\"2\""));
    assert!(birth.contains("2 competing datings, side by side. None is preferred."));
    assert!(birth.contains("Birth of <a href=\"/atlas/plato/#atlas-dates-birth\">&lt;img src=x onerror=alert(1)&gt; Πλάτων &amp; co</a>"));
    // A relationship's dating names the relationship in its stored direction.
    assert!(timeline.contains("Span of <a href=\"/atlas/plato/#atlas-r-plato-member\">&lt;img src=x onerror=alert(1)&gt; Πλάτων &amp; co member of The Academy</a>"));
    // The order of rows follows the chronology: earliest first.
    let order: Vec<usize> = [
        "atlas-d-phaedo-composition",
        "atlas-d-plato-birth-diogenes",
        "atlas-d-plato-active",
        "atlas-d-plato-member-held",
        "atlas-d-plato-death",
        "atlas-d-augustus-death",
    ]
    .iter()
    .map(|id| timeline.find(id).unwrap())
    .collect();
    assert!(order.windows(2).all(|w| w[0] < w[1]), "{order:?}");
    // What cannot be placed in time is listed apart, and the relative
    // chronology again as attributed steps.
    let unplaced = between(timeline, "<h3 id=\"atlas-timeline-unplaced\"", "</section>");
    assert!(unplaced.contains("data-aspect=\"composition\""));
    assert!(unplaced.contains("data-aspect=\"publication\""));
    let relative = between(timeline, "<h3 id=\"atlas-timeline-relative\"", "</section>");
    assert!(relative.contains("Composition of <a href=\"/atlas/republic/#atlas-dates-composition\">Republic</a> after the composition of <a href=\"/atlas/phaedo/#atlas-dates-composition\">Phaedo</a>. <span class=\"ob-meta\">Dated by Plato and the Socratic Dialogue; plausible. <a href=\"#atlas-d-republic-after-phaedo\">Evidence and notes</a></span>"));
    assert!(timeline.contains("never means that one thing caused or influenced another"));
    // Unique fragment ids on every atlas page.
    for (path, html) in files.iter().filter(|(path, _)| path.starts_with("atlas/")) {
        let ids = ids_in(html);
        let unique: BTreeSet<&str> = ids.iter().copied().collect();
        assert_eq!(unique.len(), ids.len(), "{path} repeats an id");
    }
    // Entry pages never load the component; no page carries inline style.
    assert!(!files["atlas/plato/index.html"].contains("ob-atlas-timeline.js"));
    assert!(!index.contains("style=\""));
}

#[test]
fn the_chronology_is_deterministic_whatever_the_stored_order() {
    let value = atlas_value();
    let mut reversed = value.clone();
    for key in ["entries", "relationships"] {
        reversed[key].as_array_mut().unwrap().reverse();
    }
    for entry in reversed["entries"].as_array_mut().unwrap() {
        if let Some(dates) = entry.get_mut("dates").and_then(Value::as_array_mut) {
            dates.reverse();
        }
    }
    let (a, b) = (project(&value), project(&reversed));
    assert_eq!(a.to_json(), b.to_json());
    assert_eq!(build(Some(a)), build(Some(b)));
}

#[test]
fn a_site_without_published_datings_is_written_byte_for_byte_as_before() {
    let value = atlas_value();
    let mut undated = value.clone();
    for collection in ["entries", "relationships"] {
        for item in undated[collection].as_array_mut().unwrap() {
            item.as_object_mut().unwrap().remove("dates");
        }
    }
    let mut private = value.clone();
    for collection in ["entries", "relationships"] {
        for item in private[collection].as_array_mut().unwrap() {
            let dates = item.get_mut("dates").and_then(Value::as_array_mut);
            for dating in dates.into_iter().flatten() {
                dating["visibility"] = json!("private");
            }
        }
    }
    let before = build(Some(project(&undated)));
    let after = build(Some(project(&private)));
    assert_eq!(before, after, "private datings change nothing public");
    assert!(!before["atlas.json"].contains("\"datings\""));
    assert!(!before["atlas/index.html"].contains("timeline"));
    assert!(before.keys().all(|path| !path.contains("timeline")));
    // And a site that does not publish its atlas never mentions it.
    let without = build(None);
    assert!(without.keys().all(|path| !path.contains("atlas")));
}

#[test]
fn withdrawing_an_entry_withdraws_its_datings_and_the_relative_datings_that_point_at_it() {
    let mut value = atlas_value();
    value["entries"][1]["visibility"] = json!("private");
    let atlas = project(&value);
    let ids: Vec<&str> = atlas.datings.iter().map(|d| d.id.as_str()).collect();
    assert!(!ids.contains(&"phaedo-composition"));
    assert!(!ids.contains(&"republic-after-phaedo"), "{ids:?}");
    let files = build(Some(atlas));
    for (path, html) in &files {
        assert!(!html.contains("Phaedo"), "{path}");
    }
}
