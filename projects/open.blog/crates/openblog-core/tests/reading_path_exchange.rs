//! Reading-path export and import (ADR 0217, #79): deterministic export that
//! keeps rationale and relationships, and an import that plans without
//! writing and refuses as a whole.

use std::collections::BTreeMap;

use openblog_core::reading_path::ReadingPath;
use openblog_core::reading_path_exchange::{export, plan_import, Action, EXPORT_FORMAT};
use serde_json::{json, Value};

fn path(slug: &str, status: &str, why: &str) -> ReadingPath {
    ReadingPath::parse(
        &format!("paths/{slug}.json"),
        &json!({"format": "openblog-reading-path", "version": 1, "title": "T", "status": status,
            "x-extra": 1,
            "steps": [
                {"id": "a", "target": {"kind": "post", "slug": "one"}, "rationale": "Because."},
                {"id": "b", "target": {"kind": "post", "slug": "two"},
                 "transition": {"relationship": "responds-to", "why": why}}]})
        .to_string(),
    )
    .unwrap()
}

fn bundle(entries: Value) -> String {
    json!({"format": EXPORT_FORMAT, "version": 1, "paths": entries}).to_string()
}

#[test]
fn export_is_sorted_deterministic_lf_only_and_leaves_drafts_out_unless_asked() {
    let paths = vec![
        path("zeta", "published", "z"),
        path("alpha", "published", "a"),
        path("mid", "draft", "m"),
    ];
    let text = export(&paths, false);
    assert_eq!(text, export(&paths, false));
    assert!(!text.contains('\r') && text.ends_with("}\n"));
    assert!(text.find("alpha").unwrap() < text.find("zeta").unwrap());
    assert!(!text.contains("\"mid\""));
    assert!(export(&paths, true).contains("\"mid\""));
    // Rationale, relationship and unknown fields all travel.
    assert!(text.contains("Because.") && text.contains("responds-to") && text.contains("x-extra"));
    assert!(serde_json::from_str::<Value>(&text).is_ok());
    assert!(serde_json::from_str::<Value>(&export(&[], false)).is_ok());
}

#[test]
fn an_export_imports_as_unchanged_against_the_same_paths_and_as_creates_elsewhere() {
    let paths = vec![
        path("alpha", "published", "a"),
        path("zeta", "published", "z"),
    ];
    let text = export(&paths, false);
    let same: BTreeMap<String, Option<ReadingPath>> = paths
        .iter()
        .map(|p| (p.slug.clone(), Some(p.clone())))
        .collect();
    let plan = plan_import(&text, &same, false);
    assert!(plan.is_valid() && plan.writes().count() == 0);
    assert!(plan.paths.iter().all(|p| p.action == Action::Unchanged));
    let plan = plan_import(&text, &BTreeMap::new(), false);
    assert!(plan.is_valid());
    assert_eq!(
        plan.paths.iter().map(|p| p.action).collect::<Vec<_>>(),
        [Action::Create; 2]
    );
    // The imported path is the exported one, field for field.
    assert_eq!(plan.paths[0].path, paths[0]);
}

#[test]
fn every_problem_is_reported_and_none_echoes_the_input() {
    let good = serde_json::to_value(
        serde_json::from_str::<Value>(&path("good", "published", "ok").to_canonical_json())
            .unwrap(),
    )
    .unwrap();
    let mut bad = good.clone();
    bad["steps"][1]["transition"]["why"] = "SECRET\u{0007}-WORDS".into();
    let text = bundle(json!([
        {"slug": "good", "path": good},
        {"slug": "bad", "path": bad},
        {"slug": "good", "path": good},
        {"slug": "con", "path": good},
        {"slug": "Up", "path": good},
    ]));
    let plan = plan_import(&text, &BTreeMap::new(), false);
    assert!(!plan.is_valid());
    let all: String = plan.problems.iter().map(|p| format!("{p}\n")).collect();
    assert!(
        all.contains("paths/bad.json") && all.contains("more than once"),
        "{all}"
    );
    assert!(all.matches("not a valid path slug").count() == 2, "{all}");
    assert!(!all.contains("SECRET"), "{all}");
}

#[test]
fn a_conflict_needs_overwrite_and_an_unparseable_stored_file_is_never_replaced() {
    let stored = path("alpha", "published", "old");
    let text = export(&[path("alpha", "published", "new")], false);
    let existing = BTreeMap::from([("alpha".to_string(), Some(stored))]);
    assert!(!plan_import(&text, &existing, false).is_valid());
    let plan = plan_import(&text, &existing, true);
    assert!(plan.is_valid() && plan.paths[0].action == Action::Replace);
    let broken = BTreeMap::from([("alpha".to_string(), None)]);
    assert!(!plan_import(&text, &broken, true).is_valid());
}

#[test]
fn wrong_shapes_versions_and_sizes_are_refused_whole() {
    for text in [
        "".to_string(),
        "[]".to_string(),
        json!({"format": "other", "version": 1, "paths": []}).to_string(),
        json!({"format": EXPORT_FORMAT, "version": 2, "paths": []}).to_string(),
        // A duplicate key inside one path is refused as it is in a path file.
        format!(
            r#"{{"format":"{EXPORT_FORMAT}","version":1,"paths":[{{"slug":"a","path":{}}}]}}"#,
            r#"{"format":"openblog-reading-path","version":1,"title":"A","title":"B","steps":[]}"#
        ),
    ] {
        let plan = plan_import(&text, &BTreeMap::new(), false);
        assert!(!plan.is_valid(), "{text}");
        assert!(plan.writes().count() == 0);
    }
    let many: Vec<Value> = (0..201)
        .map(|i| json!({"slug": format!("p{i}"), "path": {}}))
        .collect();
    assert!(!plan_import(&bundle(Value::Array(many)), &BTreeMap::new(), false).is_valid());
}
