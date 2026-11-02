//! Relationship trails on an atlas entry page (ADR 0175, #75). The page holds
//! a static, complete trail: the bounded walk of ADR 0170 as an ordered list
//! of steps, each one published relationship in the direction it was stated
//! with its type, which way the walk crossed it, who asserts it, how firmly,
//! its evidence and its uncertainty. A cycle ends the trail and is said in
//! words. Nothing private appears, output is deterministic, and a site that
//! does not publish its atlas is unchanged.

use std::collections::BTreeMap;

use openblog_core::atlas_publication::PublicAtlas;
use openblog_core::knowledge_atlas::{Atlas, Links};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};
use serde_json::{json, Value};

const PRIVATE: &str = "PRIVATE-TRAIL-MARKER";

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/atlas-trail.json"))
        .expect("fixtures")
}

fn public_atlas(library: &Value, atlas: &Value) -> PublicAtlas {
    let library = SourceLibrary::parse(&library.to_string(), &BTreeMap::new()).expect("a library");
    let notebook = Notebook::parse(
        &json!({"version": 1, "passages": [], "notes": []}).to_string(),
        &library,
    )
    .unwrap();
    let atlas = Atlas::parse(
        &atlas.to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .expect("a valid atlas");
    PublicAtlas::project(&atlas, &library).expect("a projection")
}

fn site(atlas: Option<PublicAtlas>, url: &str) -> Site {
    let mut config = SiteConfig::from_json(&format!(
        r#"{{"title": "Trails", "url": "{url}", "author": {{"name": "Site Author"}}}}"#
    ))
    .unwrap();
    config.knowledge_atlas.publish = atlas.is_some();
    let mut site = Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: "posts/cave.md".into(),
                contents: "---\ntitle: The cave\ndate: 2026-10-20\n---\nBody.".into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .expect("site");
    site.atlas = atlas;
    site
}

fn built(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .expect("a build")
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

fn fixture_site() -> Site {
    let f = fixtures();
    site(
        Some(public_atlas(&f["library"], &f["atlas"])),
        "https://example.com",
    )
}

/// The attribute `name` of an opening tag written as `<li id="..." ...>`.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let needle = format!(" {name}=\"");
    let at = tag.find(&needle)? + needle.len();
    Some(tag[at..at + tag[at..].find('"')?].to_string())
}

/// Every step's opening tag on a page, in order.
fn step_tags(page: &str) -> Vec<&str> {
    page.match_indices("<li id=\"atlas-trail-")
        .map(|(at, _)| &page[at..at + page[at..].find('>').unwrap() + 1])
        .collect()
}

#[test]
fn the_pages_steps_are_the_bounded_walk_and_the_shared_fixture() {
    let f = fixtures();
    let out = built(&fixture_site());
    let page = &out["atlas/plato/index.html"];
    let tags = step_tags(page);
    let wanted = f["steps"].as_array().unwrap();
    assert_eq!(tags.len(), wanted.len(), "{page}");
    for (tag, step) in tags.iter().zip(wanted) {
        let id = step["id"].as_str().unwrap();
        assert_eq!(
            attribute(tag, "id").as_deref(),
            Some(format!("atlas-trail-{id}").as_str())
        );
        assert_eq!(
            attribute(tag, "data-depth").unwrap(),
            step["depth"].to_string(),
            "{id}"
        );
        assert_eq!(
            attribute(tag, "data-kind").unwrap(),
            step["kind"].as_str().unwrap()
        );
        assert_eq!(
            attribute(tag, "data-direction").unwrap(),
            step["direction"].as_str().unwrap()
        );
        assert_eq!(
            attribute(tag, "data-standing").unwrap() == "contested",
            step["contested"].as_bool().unwrap(),
            "{id}"
        );
        assert_eq!(
            attribute(tag, "data-uncertain").unwrap() == "true",
            step["uncertain"].as_bool().unwrap(),
            "{id}"
        );
        assert_eq!(
            attribute(tag, "data-again").unwrap() == "true",
            step["again"].as_bool().unwrap(),
            "{id}"
        );
        // The Type entry is the words the component filters by.
        let kind_label = step["kindLabel"].as_str().unwrap();
        assert_eq!(
            attribute(tag, "data-kind-label").as_deref(),
            Some(kind_label)
        );
        if step["depth"] == 1 {
            assert!(
                page.contains(&format!("<dt>Type</dt><dd>{kind_label}</dd>")),
                "{id}: {kind_label}"
            );
        }
    }
    // The same walk, from the real query.
    let query = openblog_core::atlas_query::AtlasQuery::project(
        &public_atlas(&f["library"], &f["atlas"]),
        "Site Author",
        "",
    )
    .unwrap();
    let trail = query.trail("plato", 3);
    let ids: Vec<&str> = trail
        .steps
        .iter()
        .map(|step| step.edge.id.as_str())
        .collect();
    let fixture_ids: Vec<&str> = wanted.iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert_eq!(ids, fixture_ids);
    for (step, wanted) in trail.steps.iter().zip(wanted) {
        assert_eq!(step.reached, wanted["reached"].as_str().unwrap());
        assert_eq!(step.depth as u64, wanted["depth"].as_u64().unwrap());
    }
}

#[test]
fn every_step_shows_its_type_direction_evidence_and_uncertainty() {
    let out = built(&fixture_site());
    let page = &out["atlas/plato/index.html"];
    let section =
        &page[page.find("<ob-atlas-trail>").unwrap()..page.find("</ob-atlas-trail>").unwrap()];
    // Stated direction, and which way the walk crossed it.
    assert!(section.contains(
        "Stated from Plato to Republic. This step follows it forward, in the direction it was stated, from Plato to Republic."
    ));
    assert!(section.contains(
        "Stated from Allegory of the cave to Plato. This step follows it backward, against the direction it was stated, from Plato to Allegory of the cave."
    ));
    // A relationship that reads the same both ways says so, and never "against".
    assert!(section.contains(
        "Stated between Socrates and Plato; this kind of relationship reads the same in both directions."
    ));
    // The sentence is always the stated one, from the stated side.
    assert!(section
        .contains("<strong>Plato</strong> authored <a href=\"/atlas/republic/\">Republic</a>."));
    assert!(section.contains(
        "<a href=\"/atlas/cave/\">Allegory of the cave</a> influenced <strong>Plato</strong>."
    ));
    // Evidence, confidence, who asserts it and standing.
    assert!(section.contains("<dt>Evidence</dt><dd><ul><li><cite>Politeia"));
    assert!(section.contains("<dt>Asserted by</dt><dd>Site Author (the site author)</dd>"));
    assert!(section.contains(
        "Plausible: how firmly the asserting party holds it, not how widely it is accepted."
    ));
    assert!(section.contains("Contested: 1 recorded dissent."));
    assert!(section.contains("<strong>Contested:</strong> "));
    // Uncertainty is shown when stated, and its absence is not a claim of certainty.
    assert!(section.contains("<dt>Uncertainty</dt><dd>The dating is unsettled."));
    assert!(section.contains("None stated. That is not a claim that it is certain."));
    // Nothing infers influence: the walk is explained, and the words never claim a chain.
    assert!(section.contains("It is not a line of influence"));
    assert!(section.contains("<a href=\"#atlas-trail-end\">Skip the trail</a>"));
    // The trail is an ordered list of ordered lists under headings.
    assert!(section.contains("<ol class=\"ob-trail-depths\">"));
    assert!(section.contains("<h3 id=\"atlas-trail-depth-1\">One step from Plato</h3>"));
    assert!(section.contains("<h3 id=\"atlas-trail-depth-2\">Two steps from Plato</h3>"));
    assert_eq!(section.matches("<ol class=\"ob-trail-steps\">").count(), 2);
    // Each step links to the relationship in full and to its end.
    assert!(section
        .contains("<a href=\"/atlas/plato/#atlas-r-r-authored\">The relationship in full</a>"));
}

#[test]
fn a_cycle_ends_the_trail_and_is_said_in_words() {
    let out = built(&fixture_site());
    let page = &out["atlas/plato/index.html"];
    // plato -> republic -> cave -> plato is a cycle, and plato -> cave twice is a second way in.
    let tags = step_tags(page);
    let ids: Vec<String> = tags
        .iter()
        .map(|tag| attribute(tag, "id").unwrap())
        .collect();
    let mut unique = ids.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(ids.len(), unique.len(), "a relationship is shown once");
    let again = tags
        .iter()
        .filter(|tag| attribute(tag, "data-again").unwrap() == "true")
        .count();
    assert_eq!(again, 2);
    assert_eq!(
        page.matches(
            "That entry is already on this trail, so the trail does not continue from it again."
        )
        .count(),
        2
    );
    // The page never reaches back to the start as if it were new: its own page continues.
    assert!(page.contains("its own page continues the trail from there"));
    // Every entry the trail reaches has a page with its own trail, so navigation always moves on.
    for entry in ["republic", "cave", "socrates"] {
        let other = &out[&format!("atlas/{entry}/index.html")];
        assert!(other.contains("id=\"atlas-section-trail\""), "{entry}");
        assert!(
            other.contains("<a href=\"/atlas/plato/\">Plato</a>"),
            "{entry}"
        );
    }
}

#[test]
fn nothing_private_is_in_a_trail_and_an_entry_with_no_relationship_has_none() {
    let out = built(&fixture_site());
    for (path, contents) in &out {
        assert!(!contents.contains(PRIVATE), "{path}");
    }
    // An entry whose only relationship is private has no trail and no section.
    let f = fixtures();
    let mut atlas = f["atlas"].clone();
    atlas["entries"].as_array_mut().unwrap().push(
        json!({"id": "alone", "kind": "concept", "label": "Alone", "visibility": "approved"}),
    );
    atlas["entries"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "hidden-link", "kind": "concept", "label": "Hidden link", "visibility": "approved"}));
    atlas["relationships"].as_array_mut().unwrap().push(json!({
        "id": "r-hidden", "kind": "influenced", "from": "hidden-link", "to": "secret",
        "visibility": "private", "assertedBy": {"kind": "author"}, "confidence": "plausible",
        "evidence": [{"source": "plato-republic"}]
    }));
    let out = built(&site(
        Some(public_atlas(&f["library"], &atlas)),
        "https://example.com",
    ));
    for entry in ["alone", "hidden-link"] {
        let page = &out[&format!("atlas/{entry}/index.html")];
        assert!(!page.contains("atlas-section-trail"), "{entry}");
        assert!(!page.contains("ob-atlas-trail"), "{entry}");
        assert!(page.contains("None published."), "{entry}");
    }
}

#[test]
fn the_script_loads_only_where_there_is_a_trail() {
    let out = built(&fixture_site());
    let script = "/assets/components/ob-atlas-trail.js";
    for (path, contents) in &out {
        let has_trail = path.starts_with("atlas/")
            && path.ends_with("/index.html")
            && contents.contains("<ob-atlas-trail>");
        assert_eq!(contents.contains(script), has_trail, "{path}");
    }
    assert!(out["atlas/plato/index.html"].contains(script));
    assert!(!out["atlas/index.html"].contains(script));
}

#[test]
fn a_site_that_does_not_publish_its_atlas_has_no_trail_and_is_unchanged() {
    let off = built(&site(None, "https://example.com"));
    for (path, contents) in &off {
        assert!(!contents.contains("ob-atlas-trail"), "{path}");
        assert!(!contents.contains("atlas-trail"), "{path}");
    }
    assert!(!off.keys().any(|path| path.starts_with("atlas/")));
    // And the same site twice is the same bytes.
    assert_eq!(off, built(&site(None, "https://example.com")));
}

#[test]
fn output_is_deterministic_and_follows_the_base_path() {
    assert_eq!(built(&fixture_site()), built(&fixture_site()));
    let f = fixtures();
    let blog = built(&site(
        Some(public_atlas(&f["library"], &f["atlas"])),
        "https://example.com/blog",
    ));
    let page = &blog["atlas/plato/index.html"];
    assert!(
        page.contains("<a href=\"/blog/atlas/republic/\">Republic</a>"),
        "{page}"
    );
    assert!(page.contains(
        "<a href=\"/blog/atlas/plato/#atlas-r-r-authored\">The relationship in full</a>"
    ));
    assert!(page.contains("/blog/assets/components/ob-atlas-trail.js"));
}

#[test]
fn hostile_labels_and_notes_are_text_and_escaped_once() {
    let f = fixtures();
    let mut atlas = f["atlas"].clone();
    atlas["entries"][0]["label"] = json!("Plato & <img src=x onerror=alert(1)>");
    atlas["relationships"][0]["uncertainty"] = json!("Doubt <script>alert(1)</script> & more");
    let out = built(&site(
        Some(public_atlas(&f["library"], &atlas)),
        "https://example.com",
    ));
    let page = &out["atlas/republic/index.html"];
    assert!(!page.contains("<img src=x"), "{page}");
    assert!(!page.contains("<script>alert"), "{page}");
    // Escaped once, never twice.
    assert!(page.contains("Plato &amp; &lt;img src=x onerror=alert(1)&gt;"));
    assert!(!page.contains("&amp;amp;"));
    assert!(page.contains("Doubt &lt;script&gt;alert(1)&lt;/script&gt; &amp; more"));
}

/// A hub that 260 entries each relate to.
fn hub_atlas(f: &Value) -> PublicAtlas {
    let mut entries =
        vec![json!({"id": "hub", "kind": "concept", "label": "Hub", "visibility": "approved"})];
    let mut relationships = Vec::new();
    for n in 0..260 {
        entries.push(json!({"id": format!("leaf-{n:03}"), "kind": "concept", "label": format!("Leaf {n:03}"), "visibility": "approved"}));
        relationships.push(json!({
            "id": format!("r-{n:03}"), "kind": "influenced", "from": "hub", "to": format!("leaf-{n:03}"),
            "visibility": "approved", "assertedBy": {"kind": "author"}, "confidence": "plausible",
            "evidence": [{"source": "plato-republic"}],
            "uncertainty": "A stated doubt that is long enough to matter when it is repeated on every page of a very large graph."
        }));
    }
    let atlas = json!({"version": 1, "entries": entries, "relationships": relationships});
    public_atlas(&f["library"], &atlas)
}

fn total_size(out: &BTreeMap<String, String>) -> usize {
    out.values().map(String::len).sum()
}

#[test]
fn a_large_graph_is_bounded_and_says_where_it_stopped() {
    let f = fixtures();
    // The walk keeps its first 50 steps.
    let out = built(&site(Some(hub_atlas(&f)), "https://example.com"));
    let page = &out["atlas/hub/index.html"];
    assert_eq!(step_tags(page).len(), 50);
    assert!(
        page.contains("The trail stops after 50 relationships; more exist."),
        "truncated"
    );
    assert!(page.contains("This trail has 50 relationships across 51 entries"));
    // A leaf's own page starts from its one relationship, reaches the hub in one step and is bounded too.
    let leaf = &out["atlas/leaf-000/index.html"];
    assert_eq!(step_tags(leaf).len(), 50);
    assert!(leaf.contains("<h3 id=\"atlas-trail-depth-1\">One step from Leaf 000</h3>"));
    assert!(leaf.contains("The trail stops after 50 relationships"));
    // The whole built site stays small: before the bound this graph took
    // 56.8 MB of output; it now takes a fraction of it.
    let size = total_size(&out);
    println!("260-leaf hub: total output {size} bytes");
    assert!(size < 8 * 1024 * 1024, "{size} bytes");
}

#[test]
fn steps_beyond_the_first_are_compact_and_the_first_keep_every_fact() {
    let f = fixtures();
    let out = built(&site(Some(hub_atlas(&f)), "https://example.com"));
    let leaf = &out["atlas/leaf-000/index.html"];
    let tags = step_tags(leaf);
    assert_eq!(attribute(tags[0], "data-depth").as_deref(), Some("1"));
    // Depth 1: the facts, once. Depth 2 and more: the sentence and the link.
    assert_eq!(
        leaf.matches("<dt>Evidence</dt>").count(),
        1 + 1,
        "one trail step and one relationship section"
    );
    let second = &leaf[leaf.find(tags[1]).unwrap()..];
    let second = &second[..second.find("</li>").unwrap()];
    assert!(second.contains("ob-trail-statement"), "{second}");
    assert!(second.contains("The relationship in full"), "{second}");
    assert!(!second.contains("<dl"), "{second}");
    assert!(
        second.contains("data-uncertain=\"true\""),
        "filters still read it: {second}"
    );
    assert!(
        second.contains("data-kind-label=\"influenced\""),
        "{second}"
    );
    // The relationship's own page still says everything.
    assert!(out["atlas/hub/index.html"].contains("A stated doubt that is long enough"));
}

#[test]
fn a_site_over_the_trail_budget_shows_every_trail_one_step_deep_and_says_so() {
    let f = fixtures();
    let site = site(Some(hub_atlas(&f)), "https://example.com");
    // A tiny budget stands in for the 20 MB one.
    let out: BTreeMap<String, String> =
        openblog_core::render::generate_with_trail_budget(&site, &ThemeSet::new(), 64 * 1024)
            .expect("a build")
            .into_iter()
            .map(|file| (file.path, file.contents))
            .collect();
    for path in ["atlas/hub/index.html", "atlas/leaf-000/index.html"] {
        let page = &out[path];
        assert!(
            step_tags(page)
                .iter()
                .all(|tag| attribute(tag, "data-depth").as_deref() == Some("1")),
            "{path}"
        );
        assert!(page.contains("up to 1 relationships away"), "{path}");
    }
    let warning = openblog_core::render::atlas_trail_warning_with_budget(&site, 64 * 1024)
        .expect("a warning");
    assert!(warning.contains("relationship trails"), "{warning}");
    assert!(warning.contains("one step deep"), "{warning}");
    // Within the budget nothing changes and nothing is said.
    assert!(openblog_core::render::atlas_trail_warning(&site).is_none());
    assert!(
        built(&site)["atlas/leaf-000/index.html"].contains("data-depth=\"2\""),
        "the real budget leaves full depth"
    );
}

#[test]
fn a_symmetric_relationship_says_symmetric_and_is_never_followed_against_anything() {
    let out = built(&fixture_site());
    let page = &out["atlas/plato/index.html"];
    let related = step_tags(page)
        .into_iter()
        .find(|tag| tag.contains("atlas-trail-r-related"))
        .expect("the symmetric step");
    assert_eq!(
        attribute(related, "data-direction").as_deref(),
        Some("symmetric")
    );
    let start = page.find(related).unwrap();
    let step = &page[start..start + page[start..].find("</li>").unwrap()];
    assert!(step.contains("reads the same in both directions"), "{step}");
    assert!(
        !step.contains("against the direction it was stated"),
        "{step}"
    );
}

#[test]
fn a_long_chain_stops_at_three_steps_and_does_not_claim_the_rest() {
    let f = fixtures();
    let mut entries = Vec::new();
    let mut relationships = Vec::new();
    for n in 0..8 {
        entries.push(json!({"id": format!("c-{n}"), "kind": "concept", "label": format!("Chain {n}"), "visibility": "approved"}));
        if n > 0 {
            relationships.push(json!({
                "id": format!("r-{n}"), "kind": "influenced", "from": format!("c-{}", n - 1), "to": format!("c-{n}"),
                "visibility": "approved", "assertedBy": {"kind": "author"}, "confidence": "plausible",
                "evidence": [{"source": "plato-republic"}]
            }));
        }
    }
    let atlas = json!({"version": 1, "entries": entries, "relationships": relationships});
    let out = built(&site(
        Some(public_atlas(&f["library"], &atlas)),
        "https://example.com",
    ));
    let page = &out["atlas/c-0/index.html"];
    assert_eq!(step_tags(page).len(), 3);
    assert!(page.contains("atlas-trail-depth-3"));
    assert!(!page.contains("atlas-trail-depth-4"));
    assert!(
        !page.contains("Chain 4"),
        "an entry past the bound is not named"
    );
    assert!(page.contains("To go further, follow an entry's link"));
    assert!(!page.contains("ob-trail-truncated"));
}

#[test]
fn a_query_that_is_not_written_means_entry_pages_without_a_trail() {
    let f = fixtures();
    // Over the query's bound of 2000 entries: the atlas pages stay, the trail needs the projection.
    let entries: Vec<Value> = (0..2_001)
        .map(|n| json!({"id": format!("e-{n}"), "kind": "concept", "label": format!("Entry {n}"), "visibility": "approved"}))
        .collect();
    let relationships = vec![json!({
        "id": "r-0", "kind": "influenced", "from": "e-0", "to": "e-1", "visibility": "approved",
        "assertedBy": {"kind": "author"}, "confidence": "plausible",
        "evidence": [{"source": "plato-republic"}]
    })];
    let atlas = json!({"version": 1, "entries": entries, "relationships": relationships});
    let out = built(&site(
        Some(public_atlas(&f["library"], &atlas)),
        "https://example.com",
    ));
    assert!(!out.contains_key("atlas-query.json"));
    let page = &out["atlas/e-0/index.html"];
    assert!(page.contains("Relationships from this entry"));
    assert!(!page.contains("atlas-section-trail"));
    assert!(!page.contains("ob-atlas-trail"));
}
