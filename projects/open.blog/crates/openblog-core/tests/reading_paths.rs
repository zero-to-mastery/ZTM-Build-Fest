//! Reading-path contracts (ADR 0207 to 0212, #76): ordering, the branches
//! policy, cycles, deleted content, unknown fields, series coexistence,
//! round trips and privacy.

use std::collections::BTreeMap;

use openblog_core::atlas_publication::PublicAtlas;
use openblog_core::knowledge_atlas::{Atlas, Links};
use openblog_core::reading_path::{
    load_paths, DiagnosticKind, PublicPaths, PublishedTargets, ReadingPath, Relationship, Status,
    MAX_FILE_BYTES, MAX_PATHS, MAX_STEPS,
};
use openblog_core::research_notes::Notebook;
use openblog_core::source_library::SourceLibrary;
use openblog_core::{
    generate, DateTime, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};
use serde_json::{json, Value};

const GOLDEN: &str = include_str!("fixtures/reading-path.json");
const PRIVATE: &str = "PRIVATE-PATH-MARKER";

fn public_atlas() -> PublicAtlas {
    let library = SourceLibrary::parse(
        &json!({"version": 1, "sources": [{"id": "book", "kind": "work", "title": "A book"}]})
            .to_string(),
        &BTreeMap::new(),
    )
    .unwrap();
    let notebook = Notebook::parse(
        &json!({"version": 1, "passages": [], "notes": []}).to_string(),
        &library,
    )
    .unwrap();
    let edge = |id: &str, kind: &str, from: &str, to: &str| {
        json!({"id": id, "kind": kind, "from": from, "to": to,
            "assertedBy": {"kind": "author"}, "confidence": "plausible",
            "evidence": [{"source": "book"}], "visibility": "approved"})
    };
    let atlas = Atlas::parse(
        &json!({"version": 1,
            "entries": [
                {"id": "plato", "kind": "person", "label": "Plato", "visibility": "approved"},
                {"id": "stoics", "kind": "movement", "label": "The Stoics", "visibility": "approved"},
                {"id": "secret", "kind": "concept", "label": format!("{PRIVATE} label"),
                 "visibility": "private"}],
            "relationships": [
                edge("r-influence", "influenced", "plato", "stoics"),
                edge("r-related", "related-to", "plato", "stoics")]})
        .to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    )
    .unwrap();
    PublicAtlas::project(&atlas, &library).unwrap()
}

fn targets() -> PublishedTargets {
    let mut t = PublishedTargets::default();
    t.add_post("the-cave", "The cave", "/posts/the-cave/");
    t.add_post("other", "Other", "/posts/other/");
    t.add_atlas(&public_atlas());
    t
}

fn path_file(name: &str, value: Value) -> SourceFile {
    SourceFile {
        path: format!("paths/{name}.json"),
        contents: value.to_string(),
    }
}

fn parse(value: Value) -> Result<ReadingPath, Vec<String>> {
    ReadingPath::parse("paths/p.json", &value.to_string())
        .map_err(|e| e.iter().map(|p| p.to_string()).collect())
}

fn doc(steps: Value) -> Value {
    json!({"format": "openblog-reading-path", "version": 1, "title": "P",
        "status": "published", "steps": steps})
}

fn draft(steps: Value) -> Value {
    let mut d = doc(steps);
    d["status"] = json!("draft");
    d
}

fn post_step(id: &str, slug: &str) -> Value {
    json!({"id": id, "target": {"kind": "post", "slug": slug}})
}

fn with_next(mut step: Value) -> Value {
    step["transition"] = json!({"relationship": "next", "why": "It continues the thread."});
    step
}

fn errors(value: Value) -> String {
    parse(value).unwrap_err().join("\n")
}

#[test]
fn the_golden_file_round_trips_byte_for_byte() {
    let path = ReadingPath::parse("paths/golden.json", GOLDEN).expect("golden parses");
    assert_eq!(path.to_canonical_json(), GOLDEN);
    assert!(!GOLDEN.contains('\r'));
    let again = ReadingPath::parse("paths/golden.json", &path.to_canonical_json()).unwrap();
    assert_eq!(again, path);
}

#[test]
fn a_reordered_or_reformatted_file_is_written_canonically() {
    let messy = r#"{"steps":[{"id":"a","target":{"kind":"post","slug":"the-cave"}},{"transition":{"why":"w","relationship":"next"},"target":{"slug":"other","kind":"post"},"id":"b"}],"status":"draft","title":"T","version":1,"format":"openblog-reading-path"}"#;
    let path = ReadingPath::parse("paths/p.json", messy).unwrap();
    let text = path.to_canonical_json();
    assert!(text.starts_with("{\n  \"format\""));
    assert_eq!(
        ReadingPath::parse("paths/p.json", &text)
            .unwrap()
            .to_canonical_json(),
        text
    );
}

#[test]
fn steps_keep_the_authors_order_and_resolve_in_it() {
    let a = parse(doc(json!([
        post_step("one", "other"),
        with_next(post_step("two", "the-cave")),
    ])))
    .unwrap();
    let out = PublicPaths::resolve(&[a], &targets());
    let steps = &out.paths.paths[0].steps;
    assert_eq!(
        steps
            .iter()
            .map(|s| (s.target.as_str(), s.position))
            .collect::<Vec<_>>(),
        [("other", 1), ("the-cave", 2)]
    );
    assert_eq!(
        steps[1].transition.as_ref().unwrap().relationship,
        Relationship::Next
    );
    assert!(out.diagnostics.is_empty());
}

#[test]
fn paths_are_sorted_by_slug_and_output_is_deterministic() {
    let mk = |slug: &str| {
        let text = doc(json!([
            post_step("a", "other"),
            with_next(post_step("b", "the-cave"))
        ]));
        ReadingPath::parse(&format!("paths/{slug}.json"), &text.to_string()).unwrap()
    };
    let one = PublicPaths::resolve(&[mk("zeta"), mk("alpha")], &targets());
    let two = PublicPaths::resolve(&[mk("alpha"), mk("zeta")], &targets());
    assert_eq!(one.paths.to_json(), two.paths.to_json());
    assert_eq!(one.paths.paths[0].slug, "alpha");
    assert_eq!(one.paths.paths[0].url, "/paths/alpha/");
}

#[test]
fn there_are_no_branches_and_a_path_never_returns_to_a_step() {
    let e = errors(doc(json!([
        post_step("a", "other"),
        with_next(post_step("b", "the-cave")),
        with_next(post_step("c", "other")),
    ])));
    assert!(
        e.contains("step `c`") && e.contains("same post as step `a`"),
        "{e}"
    );
    // A step cannot name a path, so one path cannot lead into another.
    let e = errors(doc(json!([
        post_step("a", "other"),
        {"id": "b", "target": {"kind": "path", "slug": "x"},
         "transition": {"relationship": "next", "why": "w"}},
    ])));
    assert!(
        e.contains("step `b`") && e.contains("`target.kind` must be `post` or `atlas`"),
        "{e}"
    );
    // A `next` field is kept as an unread extra, so it never makes a branch:
    // the list is the order.
    let p = parse(doc(json!([
        post_step("a", "other"),
        {"id": "b", "target": {"kind": "post", "slug": "the-cave"},
         "next": ["c"], "transition": {"relationship": "next", "why": "w"}},
    ])))
    .unwrap();
    let out = PublicPaths::resolve(&[p], &targets());
    assert_eq!(out.paths.paths[0].steps.len(), 2);
    assert!(!out.paths.to_json().contains("\"next\":[\"c"));
}

#[test]
fn a_repeated_step_id_is_refused_and_ids_scope_every_message() {
    let e = errors(doc(json!([
        post_step("a", "other"),
        with_next(post_step("a", "the-cave")),
    ])));
    assert!(
        e.contains("paths/p.json: step `a`: `id` is used by an earlier step"),
        "{e}"
    );
}

#[test]
fn every_transition_explains_why_and_has_no_default_relationship() {
    let e = errors(doc(json!([
        post_step("a", "other"),
        post_step("b", "the-cave")
    ])));
    assert!(
        e.contains("step `b`") && e.contains("add a transition"),
        "{e}"
    );
    let mut blank = post_step("b", "the-cave");
    blank["transition"] = json!({"relationship": "next", "why": "   "});
    assert!(errors(doc(json!([post_step("a", "other"), blank])))
        .contains("`transition.why` is required"));
    let mut none = post_step("b", "the-cave");
    none["transition"] = json!({"why": "because"});
    let e = errors(doc(json!([post_step("a", "other"), none])));
    assert!(e.contains("`transition.relationship` is required"), "{e}");
    let first = with_next(post_step("a", "other"));
    assert!(errors(doc(json!([first, post_step("b", "the-cave")]))).contains("no transition"));
}

#[test]
fn a_draft_may_be_incomplete_but_never_malformed() {
    let d = draft(json!([post_step("a", "other"), post_step("b", "the-cave")]));
    let p = parse(d.clone()).expect("an unfinished draft is kept");
    assert_eq!(p.status, Status::Draft);
    let mut bad = d;
    bad["steps"][1]["id"] = json!("Bad Id");
    assert!(parse(bad).is_err());
    let golden_draft = GOLDEN.replace("\"published\"", "\"draft\"");
    let p = ReadingPath::parse("paths/d.json", &golden_draft).unwrap();
    assert!(PublicPaths::resolve(&[p], &targets())
        .paths
        .paths
        .is_empty());
}

#[test]
fn influence_needs_a_published_relationship_and_chronology_is_never_enough() {
    let mut s = post_step("b", "the-cave");
    s["transition"] = json!({"relationship": "influenced", "why": "It came earlier."});
    let e = errors(doc(json!([post_step("a", "other"), s])));
    assert!(e.contains("`influenced` needs `basis`"), "{e}");
}

fn atlas_step(id: &str, entry: &str) -> Value {
    json!({"id": id, "target": {"kind": "atlas", "id": entry}})
}

fn influenced(mut step: Value, basis: &str) -> Value {
    step["transition"] =
        json!({"relationship": "influenced", "why": "The atlas says so.", "basis": basis});
    step
}

#[test]
fn influence_is_kept_only_with_a_published_influence_in_the_stated_direction() {
    let path = ReadingPath::parse("paths/golden.json", GOLDEN).unwrap();
    let out = PublicPaths::resolve(std::slice::from_ref(&path), &targets());
    let stoics = &out.paths.paths[0].steps[2];
    let t = stoics.transition.as_ref().unwrap();
    assert_eq!(
        (t.relationship, t.basis.as_deref(), t.follows),
        (Relationship::Influenced, Some("r-influence"), 2)
    );
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);

    // Reversed: the relationship runs plato to stoics, and this path asks the
    // opposite. The whole path is withheld, never softened or shown with a gap.
    let reversed = parse(doc(json!([
        post_step("a", "other"),
        with_next(atlas_step("s", "stoics")),
        influenced(atlas_step("p", "plato"), "r-influence"),
    ])))
    .unwrap();
    let out = PublicPaths::resolve(&[reversed], &targets());
    assert!(out.paths.paths.is_empty());
    assert!(out
        .diagnostics
        .iter()
        .any(|d| d.kind == DiagnosticKind::TransitionDropped));
    assert!(out
        .diagnostics
        .iter()
        .any(|d| d.kind == DiagnosticKind::PathWithheld));

    // A basis that is not an influence, or does not exist.
    for basis in ["r-related", "nope"] {
        let mut p = path.clone();
        p.steps[2].transition.as_mut().unwrap().basis = Some(basis.into());
        let out = PublicPaths::resolve(&[p], &targets());
        assert!(out.paths.paths.is_empty(), "{basis}");
    }
}

#[test]
fn influence_joins_two_atlas_entries_and_never_a_post() {
    // post -> post, atlas -> post and post -> atlas are all refused when read.
    let cases = [
        (
            post_step("a", "other"),
            influenced(post_step("b", "the-cave"), "r-influence"),
        ),
        (
            atlas_step("a", "plato"),
            influenced(post_step("b", "the-cave"), "r-influence"),
        ),
        (
            post_step("a", "the-cave"),
            influenced(atlas_step("b", "stoics"), "r-influence"),
        ),
    ];
    for (first, second) in cases {
        let e = errors(draft(json!([first, second])));
        assert!(
            e.contains("step `b`") && e.contains("`influenced` joins two atlas entries"),
            "{e}"
        );
    }
    // Atlas to atlas is read.
    assert!(parse(doc(json!([
        atlas_step("a", "plato"),
        influenced(atlas_step("b", "stoics"), "r-influence"),
    ])))
    .is_ok());
}

#[test]
fn a_basis_belongs_to_influenced_alone() {
    let mut s = atlas_step("b", "stoics");
    s["transition"] = json!({"relationship": "builds-on", "why": "w", "basis": "r-influence"});
    let e = errors(draft(json!([atlas_step("a", "plato"), s])));
    assert!(
        e.contains("`transition.basis` belongs to `influenced` only"),
        "{e}"
    );
}

#[test]
fn a_contested_influence_is_not_published_as_one() {
    let mut t = targets();
    // The same ids, but the relationship is contested by someone.
    let library = SourceLibrary::parse(
        &json!({"version": 1, "sources": [{"id": "book", "kind": "work", "title": "A book"}]})
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
        &json!({"version": 1,
            "entries": [
                {"id": "plato", "kind": "person", "label": "Plato", "visibility": "approved"},
                {"id": "stoics", "kind": "movement", "label": "The Stoics", "visibility": "approved"}],
            "relationships": [{"id": "r-contested", "kind": "influenced", "from": "plato", "to": "stoics",
                "assertedBy": {"kind": "author"}, "confidence": "plausible",
                "evidence": [{"source": "book"}], "visibility": "approved",
                "contestedBy": [{"by": {"kind": "named", "name": "A later editor"},
                    "note": "Disputed."}]}]})
        .to_string(),
        Links {
            library: &library,
            notebook: &notebook,
        },
    );
    let atlas = atlas.expect("a contested relationship parses");
    t.add_atlas(&PublicAtlas::project(&atlas, &library).unwrap());
    let p = parse(doc(json!([
        atlas_step("a", "plato"),
        influenced(atlas_step("b", "stoics"), "r-contested"),
    ])))
    .unwrap();
    let out = PublicPaths::resolve(&[p], &t);
    assert!(out.paths.paths.is_empty());
    assert!(out
        .diagnostics
        .iter()
        .any(|d| d.message.contains("contested")));
}

#[test]
fn a_missing_required_step_withholds_the_path_and_never_shows_a_gap() {
    let path = parse(doc(json!([
        post_step("a", "other"),
        with_next(post_step("gone", "deleted-post")),
        with_next(post_step("c", "the-cave")),
    ])))
    .unwrap();
    let out = PublicPaths::resolve(&[path], &targets());
    assert!(out.paths.paths.is_empty());
    let kinds: Vec<_> = out
        .diagnostics
        .iter()
        .map(|d| (d.step.as_deref(), d.kind))
        .collect();
    assert_eq!(
        kinds,
        [
            (Some("gone"), DiagnosticKind::StepUnavailable),
            (Some("c"), DiagnosticKind::TransitionDropped),
            (None, DiagnosticKind::PathWithheld),
        ]
    );
    assert_eq!(
        out.diagnostics[0].to_string(),
        "reading path `p`, step `gone`: post `deleted-post` is not published, so the step is left out"
    );
    // A missing first step leaves the second one starting the path mid-way.
    let path = parse(doc(json!([
        post_step("gone", "deleted-post"),
        with_next(post_step("b", "the-cave")),
        with_next(post_step("c", "other")),
    ])))
    .unwrap();
    assert!(PublicPaths::resolve(&[path], &targets())
        .paths
        .paths
        .is_empty());
}

#[test]
fn a_missing_optional_or_last_step_leaves_no_trace() {
    let mut t = targets();
    t.add_post("other-2", "Other 2", "/posts/other-2/");
    let mut optional = with_next(post_step("gone", "deleted-post"));
    optional["optional"] = json!(true);
    let path = parse(doc(json!([
        post_step("a", "other"),
        optional,
        with_next(post_step("c", "the-cave")),
        with_next(post_step("d", "other-2")),
        with_next(post_step("tail", "deleted-too")),
    ])))
    .unwrap();
    let out = PublicPaths::resolve(&[path], &t);
    let steps = &out.paths.paths[0].steps;
    assert_eq!(
        steps.iter().map(|s| s.target.as_str()).collect::<Vec<_>>(),
        ["other", "the-cave", "other-2"]
    );
    assert_eq!(
        steps.iter().map(|s| s.position).collect::<Vec<_>>(),
        [1, 2, 3]
    );
    // `c` follows `a`, the nearest required step, which is shown.
    assert_eq!(steps[1].transition.as_ref().unwrap().follows, 1);
    assert_eq!(out.diagnostics.len(), 2);
    // The author's ids never reach the public value.
    let json = out.paths.to_json();
    for id in ["\"gone\"", "\"tail\"", "\"id\""] {
        assert!(!json.contains(id), "{id}");
    }
}

#[test]
fn every_shown_step_after_the_first_has_a_transition_or_the_path_is_withheld() {
    // Every combination of which of five steps are published; steps 1 and 3
    // are optional. Whatever is shown, no step is left without its transition.
    for mask in 0u32..32 {
        let slugs = ["s0", "s1", "s2", "s3", "s4"];
        let mut t = PublishedTargets::default();
        for (i, slug) in slugs.iter().enumerate() {
            if mask & (1 << i) != 0 {
                t.add_post(slug, slug, &format!("/{slug}/"));
            }
        }
        let steps: Vec<Value> = slugs
            .iter()
            .enumerate()
            .map(|(i, slug)| {
                let mut s = post_step(&format!("id{i}"), slug);
                if i > 0 {
                    s = with_next(s);
                }
                if i == 1 || i == 3 {
                    s["optional"] = json!(true);
                }
                s
            })
            .collect();
        let p = parse(doc(json!(steps))).unwrap();
        let out = PublicPaths::resolve(&[p], &t);
        for path in &out.paths.paths {
            assert!(path.steps.len() >= 2, "{mask}");
            for (i, step) in path.steps.iter().enumerate() {
                assert_eq!(step.position, i + 1, "{mask}");
                match &step.transition {
                    None => assert_eq!(i, 0, "step {i} lost its transition with mask {mask:05b}"),
                    Some(tr) => assert!(tr.follows >= 1 && tr.follows <= i, "{mask}"),
                }
            }
        }
    }
}

#[test]
fn the_first_step_is_never_optional_and_a_skipped_optional_step_keeps_the_path_coherent() {
    let mut first = post_step("a", "other");
    first["optional"] = json!(true);
    let e = errors(draft(json!([first, with_next(post_step("b", "the-cave"))])));
    assert!(
        e.contains("step `a`") && e.contains("cannot be optional"),
        "{e}"
    );

    // Two optional steps in a row both follow the same required step, so
    // skipping either leaves the next one's transition true.
    let mut o1 = with_next(post_step("o1", "the-cave"));
    o1["optional"] = json!(true);
    let mut o2 = with_next(post_step("o2", "other-2"));
    o2["optional"] = json!(true);
    let mut t = targets();
    t.add_post("other-2", "Other 2", "/posts/other-2/");
    t.add_post("last", "Last", "/posts/last/");
    let p = parse(doc(json!([
        post_step("a", "other"),
        o1,
        o2,
        with_next(post_step("z", "last")),
    ])))
    .unwrap();
    let out = PublicPaths::resolve(&[p], &t);
    let follows: Vec<usize> = out.paths.paths[0]
        .steps
        .iter()
        .skip(1)
        .map(|s| s.transition.as_ref().unwrap().follows)
        .collect();
    assert_eq!(follows, [1, 1, 1]);
}

#[test]
fn a_path_is_listed_unless_the_author_says_otherwise() {
    let mut d = doc(json!([
        post_step("a", "other"),
        with_next(post_step("b", "the-cave"))
    ]));
    let listed = parse(d.clone()).unwrap();
    assert!(listed.listed);
    assert!(!listed.to_canonical_json().contains("listed"));
    d["listed"] = json!(false);
    let unlisted = parse(d).unwrap();
    assert!(!unlisted.listed);
    assert!(unlisted.to_canonical_json().contains("\"listed\": false"));
    let out = PublicPaths::resolve(&[unlisted], &targets());
    assert!(!out.paths.paths[0].listed);
}

#[test]
fn a_path_with_fewer_than_two_published_steps_is_withheld() {
    let path = parse(doc(json!([
        post_step("a", "other"),
        with_next(post_step("b", "unpublished")),
    ])))
    .unwrap();
    let out = PublicPaths::resolve(&[path], &targets());
    assert!(out.paths.paths.is_empty());
    assert!(out
        .diagnostics
        .iter()
        .any(|d| d.kind == DiagnosticKind::PathWithheld));
}

#[test]
fn unpublished_targets_never_leak_and_are_not_told_apart_from_missing_ones() {
    // `secret` is a private atlas entry; `draft-post` is not a published post.
    let path = parse(doc(json!([
        post_step("a", "other"),
        with_next(json!({"id": "s", "target": {"kind": "atlas", "id": "secret"}})),
        with_next(post_step("d", "draft-post")),
        with_next(post_step("e", "the-cave")),
    ])))
    .unwrap();
    let out = PublicPaths::resolve(&[path], &targets());
    let json = out.paths.to_json();
    assert!(!json.contains(PRIVATE) && !json.contains("secret") && !json.contains("draft-post"));
    let messages: String = out.diagnostics.iter().map(|d| d.to_string()).collect();
    assert!(!messages.contains(PRIVATE));
    // The same message for a private entry and for an id that never existed.
    let unknown = parse(doc(json!([
        post_step("a", "other"),
        with_next(json!({"id": "s", "target": {"kind": "atlas", "id": "nothing"}})),
        with_next(post_step("e", "the-cave")),
    ])))
    .unwrap();
    let again = PublicPaths::resolve(&[unknown], &targets());
    assert_eq!(
        out.diagnostics[0].message.replace("secret", "X"),
        again.diagnostics[0].message.replace("nothing", "X")
    );
}

#[test]
fn unknown_fields_are_kept_losslessly_and_unknown_versions_are_refused() {
    // An older release reads a newer file's known fields and writes the rest back.
    let mut d = draft(json!([
        {"id": "a", "target": {"kind": "post", "slug": "x", "z-extra": [1]}, "mood": 1,
         "transition": null}
    ]));
    d["steps"][0].as_object_mut().unwrap().remove("transition");
    d["notes"] = json!("private thought");
    let p = parse(d).unwrap();
    let text = p.to_canonical_json();
    let again = ReadingPath::parse("paths/p.json", &text).unwrap();
    assert_eq!(again, p);
    assert_eq!(again.to_canonical_json(), text);
    assert!(text.contains("\"notes\": \"private thought\""));
    assert!(text.contains("\"mood\": 1") && text.contains("\"z-extra\""));
    // Extras are inert: never read, never public.
    let mut published = p.clone();
    published.status = Status::Published;
    let out = PublicPaths::resolve(&[published], &targets());
    assert!(!out.paths.to_json().contains("private thought"));
    // Defined fields used wrongly are refused, naming the field only.
    let mut d = draft(json!([post_step("a", "other")]));
    d["summary"] = json!(7);
    assert!(errors(d).contains("`summary` must be text"));
    let mut d = doc(json!([]));
    d["version"] = json!(2);
    assert!(errors(d).contains("version 2"));
    let mut d = doc(json!([]));
    d["format"] = json!("openblog-atlas");
    assert!(errors(d).contains("`format` must be"));
    let mut d = doc(json!([post_step("a", "other")]));
    d["status"] = json!("public");
    let e = errors(d);
    assert!(e.contains("`status` must be `draft` or `published`"), "{e}");
    assert!(!e.contains("public"), "{e}");
}

#[test]
fn a_repeated_key_is_refused_and_a_serde_message_never_echoes_a_value() {
    let dup =
        r#"{"format":"openblog-reading-path","version":1,"title":"A","title":"B","steps":[]}"#;
    let e = ReadingPath::parse("paths/p.json", dup).unwrap_err();
    assert!(e[0].message.contains("repeats the field `title`"), "{e:?}");
    let nested = r#"{"format":"openblog-reading-path","version":1,"title":"A","steps":[{"id":"a","id":"b","target":{"kind":"post","slug":"x"}}]}"#;
    let e = ReadingPath::parse("paths/p.json", nested).unwrap_err();
    assert!(e[0].message.contains("repeats the field `id`"), "{e:?}");
    let hostile = format!(
        r#"{{"format":"openblog-reading-path","version":1,"title":"A","steps":[],"{k}":1,"{k}":2}}"#,
        k = "<script>alert(1)</script>"
    );
    let e = ReadingPath::parse("paths/p.json", &hostile).unwrap_err();
    assert!(!e[0].message.contains("script"), "{e:?}");

    // Wrong types name the field and never repeat what was written.
    const SECRET: &str = "SECRET-VALUE-9";
    let mut s = post_step("a", "other");
    s["optional"] = json!(SECRET);
    s["difficulty"] = json!(SECRET);
    s["rationale"] = json!(5);
    s["target"]["slug"] = json!([SECRET]);
    let mut d = draft(json!([s]));
    d["title"] = json!({"k": SECRET});
    d["listed"] = json!(SECRET);
    let e = errors(d);
    assert!(!e.contains(SECRET), "{e}");
    for field in [
        "`title`",
        "`listed`",
        "`optional`",
        "`difficulty`",
        "`rationale`",
        "`target.slug`",
    ] {
        assert!(e.contains(field), "{field}: {e}");
    }
    let bad_json = format!("{{\"title\": \"{SECRET}\" oops");
    let e = ReadingPath::parse("paths/p.json", &bad_json).unwrap_err();
    assert!(!e[0].message.contains(SECRET), "{e:?}");
}

#[test]
fn hostile_and_oversized_input_is_refused_with_scoped_messages() {
    let long = "x".repeat(601);
    let mut s = post_step("b", "the-cave");
    s["transition"] = json!({"relationship": "next", "why": long});
    let e = errors(doc(json!([post_step("a", "other"), s])));
    assert!(e.contains("`transition.why` is over 600 characters"), "{e}");
    assert!(!e.contains("xxxx"));
    for (field, bad) in [
        ("rationale", "line\nbreak"),
        ("rationale", "evil\u{202e}text"),
        ("prerequisites", "see [x](atlas:plato)"),
    ] {
        let mut s = post_step("a", "other");
        s[field] = json!(bad);
        assert!(
            errors(draft(json!([s]))).contains(&format!("`{field}`")),
            "{field}"
        );
    }
    let e = errors(draft(json!([post_step("a", "../etc/passwd")])));
    assert!(e.contains("not a post slug"), "{e}");
    let e = errors(draft(json!([
        {"id": "a", "target": {"kind": "atlas", "id": "Not An Id"}}
    ])));
    assert!(e.contains("not an atlas entry id"), "{e}");
    assert!(ReadingPath::parse("paths/p.json", "{not json").is_err());
    let big = " ".repeat(MAX_FILE_BYTES + 1);
    assert!(ReadingPath::parse("paths/p.json", &big).unwrap_err()[0]
        .message
        .contains("bytes"));
    let many: Vec<Value> = (0..=MAX_STEPS)
        .map(|i| post_step(&format!("s{i}"), "other"))
        .collect();
    assert!(errors(draft(json!(many))).contains("at most"));
    for bad in [
        "paths/../x.json",
        "paths/Up.json",
        "posts/p.json",
        "paths/a b.json",
        "paths/.json",
    ] {
        assert!(ReadingPath::parse(bad, GOLDEN).is_err(), "{bad}");
    }
}

#[test]
fn script_in_text_is_data_and_is_escaped_in_the_json_embed() {
    let mut s = with_next(post_step("b", "the-cave"));
    s["transition"]["why"] = json!("</script><img src=x onerror=alert(1)> & more");
    let p = parse(doc(json!([post_step("a", "other"), s]))).unwrap();
    let out = PublicPaths::resolve(&[p], &targets());
    let json = out.paths.to_json();
    assert!(!json.contains('<') && !json.contains('>') && !json.contains('&'));
    assert!(json.contains("\\u003c/script\\u003e"));
}

#[test]
fn one_bad_file_leaves_the_others_and_nothing_is_written() {
    let good = |name: &str| {
        path_file(
            name,
            doc(json!([
                post_step("a", "other"),
                with_next(post_step("b", "the-cave"))
            ])),
        )
    };
    let mut bad = good("broken");
    bad.contents = bad.contents.replace("\"version\":1", "\"version\":9");
    let files = [
        good("zeta"),
        bad,
        good("alpha"),
        SourceFile {
            path: "paths/.gitkeep".into(),
            contents: String::new(),
        },
        SourceFile {
            path: "posts/x.md".into(),
            contents: "ignored".into(),
        },
    ];
    let loaded = load_paths(&files);
    assert_eq!(
        loaded
            .paths
            .iter()
            .map(|p| p.slug.as_str())
            .collect::<Vec<_>>(),
        ["alpha", "zeta"]
    );
    assert_eq!(loaded.problems.len(), 1);
    assert!(loaded.problems[0]
        .to_string()
        .starts_with("paths/broken.json: is version 9"));
    assert!(load_paths(&[]).paths.is_empty());
}

#[test]
fn too_many_path_files_are_cut_with_a_message() {
    let files: Vec<SourceFile> = (0..=MAX_PATHS)
        .map(|i| path_file(&format!("p{i:03}"), draft(json!([]))))
        .collect();
    let loaded = load_paths(&files);
    assert_eq!(loaded.paths.len(), MAX_PATHS);
    assert!(loaded.problems[0].message.contains("at most"));
}

fn series_site() -> Site {
    let config = SiteConfig::from_json(
        r#"{"title": "S", "url": "https://example.com", "author": {"name": "A"}}"#,
    )
    .unwrap();
    let post = |name: &str, extra: &str| SourceFile {
        path: format!("posts/{name}.md"),
        contents: format!("---\ntitle: {name}\ndate: 2026-10-20\nseries: guide\n{extra}---\nBody."),
    };
    Site::load(
        config,
        Sources {
            posts: vec![
                post("alpha", "seriesOrder: 2\n"),
                post("bravo", "seriesOrder: 1\n"),
                post("draft-one", "draft: true\n"),
            ],
            series: vec![SourceFile {
                path: "series/guide.md".into(),
                contents: "---\nname: Guide\n---\nA guide.".into(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .expect("site")
}

fn built(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .map(|f| (f.path, f.contents))
        .collect()
}

#[test]
fn a_path_coexists_with_a_series_and_leaves_it_and_the_build_unchanged() {
    let site = series_site();
    let before = built(&site);
    let series_order = site.series_by_slug("guide").unwrap().posts.clone();

    // The path reads the series' posts in the opposite order, and names a draft.
    let path = parse(doc(json!([
        post_step("one", "alpha"),
        with_next(post_step("two", "bravo")),
        with_next(post_step("three", "draft-one")),
    ])))
    .unwrap();
    let out = PublicPaths::resolve(&[path], &PublishedTargets::from_site(&site));
    let order: Vec<_> = out.paths.paths[0]
        .steps
        .iter()
        .map(|s| s.target.as_str())
        .collect();
    assert_eq!(order, ["alpha", "bravo"]);
    assert_eq!(out.diagnostics.len(), 1);
    assert_eq!(out.diagnostics[0].step.as_deref(), Some("three"));

    assert_eq!(site.series_by_slug("guide").unwrap().posts, series_order);
    assert_eq!(before, built(&site));
    assert!(before.keys().all(|p| !p.contains("paths")));
}

fn visibility_site(include_drafts: bool) -> Site {
    let config = SiteConfig::from_json(
        r#"{"title": "S", "url": "https://example.com", "author": {"name": "A"}}"#,
    )
    .unwrap();
    let post = |name: &str, date: &str, extra: &str| SourceFile {
        path: format!("posts/{name}.md"),
        contents: format!(
            "---
title: {name}
date: {date}
{extra}---
Body."
        ),
    };
    Site::load(
        config,
        Sources {
            posts: vec![
                post("live", "2026-10-01", ""),
                post(
                    "drafty",
                    "2026-10-01",
                    "draft: true
",
                ),
                post("later", "2027-01-01", ""),
            ],
            ..Default::default()
        },
        LoadOptions {
            include_drafts,
            now: Some(DateTime::parse("2026-10-22T00:00:00Z").unwrap()),
            ..Default::default()
        },
    )
    .expect("site")
}

#[test]
fn targets_from_a_site_loaded_with_drafts_still_use_production_visibility() {
    let site = visibility_site(true);
    // The Admin load holds the draft and the scheduled post as posts...
    assert!(site.posts.iter().any(|p| p.slug == "drafty"));
    // ...but a path may not name them.
    let targets = PublishedTargets::from_site(&site);
    let names: Vec<_> = targets.posts().map(|(slug, _)| slug.to_string()).collect();
    assert_eq!(names, ["live"], "{names:?}");
    assert_eq!(
        PublishedTargets::from_site(&visibility_site(false))
            .posts()
            .count(),
        1
    );
}

#[test]
fn paths_reserve_their_address_only_when_the_switch_is_on() {
    let build = |on: bool| {
        let mut config = SiteConfig::from_json(
            r#"{"title": "S", "url": "https://example.com", "author": {"name": "A"}}"#,
        )
        .unwrap();
        config.reading_paths.publish = on;
        let site = Site::load(
            config,
            Sources {
                pages: vec![SourceFile {
                    path: "pages/paths.md".into(),
                    contents: "---
title: Paths
---
Mine."
                        .into(),
                }],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .expect("site");
        generate(&site, &ThemeSet::new())
    };
    assert!(
        build(false).is_ok(),
        "off: an existing /paths/ page keeps working"
    );
    let e = build(true).unwrap_err();
    assert!(e.contains("paths") && e.contains("reserved"), "{e}");
}

#[test]
fn a_hostile_step_id_is_named_by_position_and_never_echoed() {
    let e = errors(draft(json!([
        post_step("<script>alert(1)</script>", "other"),
        post_step("b", "other"),
    ])));
    assert!(e.contains("step `#1`") && !e.contains("script"), "{e}");
    assert!(
        e.contains("step `b`: points at the same post as step `#1`"),
        "{e}"
    );
}

#[test]
fn a_windows_device_name_cannot_name_a_path_file() {
    use openblog_core::reading_path::valid_path_slug;
    for name in ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"] {
        assert!(!valid_path_slug(name), "{name}");
    }
    for name in [
        "com0",
        "com10",
        "console",
        "auxiliary",
        "lpt",
        "plato-route",
    ] {
        assert!(valid_path_slug(name), "{name}");
    }
    let file = doc(json!([
        post_step("a", "other"),
        with_next(post_step("b", "the-cave"))
    ]));
    let refused = ReadingPath::parse("paths/con.json", &file.to_string());
    assert!(refused.is_err());
    // A step id is never a file name, so it keeps its old rule.
    assert!(ReadingPath::parse(
        "paths/ok.json",
        &doc(json!([
            post_step("aux", "other"),
            with_next(post_step("nul", "the-cave"))
        ]))
        .to_string()
    )
    .is_ok());
}

#[test]
fn an_unknown_number_is_written_back_with_every_digit() {
    let mut file = doc(json!([
        post_step("a", "other"),
        with_next(post_step("b", "the-cave"))
    ]));
    let text = file
        .to_string()
        .replacen('{', "{\"x-ratio\": 0.30000000000000004,", 1);
    file = serde_json::from_str(&text).unwrap();
    let path = ReadingPath::parse("paths/p.json", &file.to_string()).unwrap();
    assert!(path.to_canonical_json().contains("0.30000000000000004"));
}
