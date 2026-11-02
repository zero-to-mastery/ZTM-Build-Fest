//! The research readiness report through the real command line (#194,
//! ADR 0150): `openblog check`, `openblog check --json` and `openblog build`
//! show one report with one set of codes in one order; the machine-readable
//! output is deterministic; a failure of a private file the build reads stops
//! the build before any public file changes; and a site without research
//! prints exactly what it always printed.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::{json, Value};

const LIBRARY_FILE: &str = ".openblog/private/research/sources.json";
const ATLAS_FILE: &str = ".openblog/private/research/atlas.json";
const LEAK: &str = "ZqxLeak readiness sentinel words kept private";
const LEAK_WORD: &str = "ZqxLeakReadinessSegmentSentinelAbcdef";

fn copy(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn project(tag: &str, research: bool) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "openblog-readiness-cli-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    copy(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/portable-publishing"),
        &root,
    );
    if !research {
        // The example's own post uses the Research profile; a site without
        // research has an ordinary article.
        fs::write(
            root.join("content/posts/portable-lesson.md"),
            "---\ntitle: A plain post\ndate: 2026-10-24\n---\n\nJust an article.\n",
        )
        .unwrap();
    }
    if research {
        let write = |file: &str, value: Value| {
            let path = root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, value.to_string()).unwrap();
        };
        write(
            LIBRARY_FILE,
            json!({"version": 1, "sources": [
                {"id": "plato", "kind": "work", "title": "Politeia"},
                {"id": "slings", "kind": "edition", "of": "plato", "title": "Slings edition",
                    "rights": {"status": "publicDomain", "note": LEAK},
                    "identifiers": [{"scheme": "url", "value": format!("http://files.internal/{LEAK_WORD}")}]}
            ]}),
        );
        write(
            ATLAS_FILE,
            json!({"version": 2, "entries": [
                {"id": "plato-person", "kind": "person", "label": "Plato", "visibility": "approved"},
                {"id": "the-good", "kind": "concept", "label": LEAK}
            ], "relationships": []}),
        );
        fs::write(
            root.join("content/posts/cave.md"),
            "---\ntitle: Cave\ndate: 2026-10-01\nprofile: research\ncitations: notes\n---\n\nThe cave educates [@slings, page 514].\n\nSee [the Good](/atlas/the-good/).\n",
        )
        .unwrap();
        let config_path = root.join("openblog.json");
        let mut config: Value =
            serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        config["knowledgeAtlas"] = json!({"publish": true});
        fs::write(config_path, config.to_string()).unwrap();
    }
    root
}

fn run(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_openblog"))
        .args(args)
        .arg("--root")
        .arg(root)
        .output()
        .expect("run openblog")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).replace("\r\n", "\n")
}

/// Every file under the project with its bytes, so a command can be shown to
/// have changed nothing.
fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, dir: &Path, into: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                walk(base, &path, into);
            } else {
                into.insert(
                    path.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                    fs::read(&path).unwrap(),
                );
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(root, root, &mut files);
    files
}

fn listed_codes(view: &Value) -> Vec<String> {
    let findings = view["findings"].as_array().unwrap();
    view["groups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|group| group["findings"].as_array().unwrap())
        .map(|position| {
            let finding = &findings[position.as_u64().unwrap() as usize];
            format!(
                "{}: {}",
                finding["validator"].as_str().unwrap(),
                finding["code"].as_str().unwrap()
            )
        })
        .collect()
}

fn printed_codes(report: &str) -> Vec<String> {
    report
        .lines()
        .filter(|line| line.starts_with("research ") && line.ends_with(']'))
        .filter_map(|line| {
            let start = line.rfind('[')?;
            Some(line[start + 1..line.len() - 1].to_string())
        })
        .collect()
}

#[test]
fn check_json_is_deterministic_and_lists_the_codes_the_terminal_lists_in_the_same_order() {
    let root = project("parity", true);
    let before = snapshot(&root);
    let first = run(&root, &["check", "--json"]);
    assert!(first.status.success(), "{}", text(&first.stderr));
    let second = run(&root, &["check", "--json"]);
    assert_eq!(first.stdout, second.stdout, "the report is deterministic");
    let view: Value =
        serde_json::from_slice(&first.stdout).expect("JSON and nothing else on stdout");
    assert_eq!(view["applies"], true);
    let codes = listed_codes(&view);
    for expected in [
        "publication-context: context-link-unpublished",
        "citation-review: citation-identifier-unpublished",
    ] {
        assert!(
            codes.iter().any(|code| code == expected),
            "{expected} in {codes:?}"
        );
    }

    let terminal = run(&root, &["check"]);
    assert!(terminal.status.success(), "{}", text(&terminal.stderr));
    assert_eq!(printed_codes(&text(&terminal.stderr)), codes);

    // Reading changes nothing, and nothing private is printed.
    assert_eq!(snapshot(&root), before);
    for output in [&first, &terminal] {
        assert!(!text(&output.stdout).contains("ZqxLeak"));
        assert!(!text(&output.stderr).contains("ZqxLeak"));
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_failure_of_a_file_the_build_reads_is_reported_by_check_and_stops_build_before_it_writes() {
    let root = project("blocking", true);
    let built = run(&root, &["build"]);
    assert!(built.status.success(), "{}", text(&built.stderr));
    assert!(
        printed_codes(&text(&built.stderr))
            .iter()
            .any(|code| code == "publication-context: context-link-unpublished"),
        "build prints the same report: {}",
        text(&built.stderr)
    );
    fs::write(root.join(ATLAS_FILE), "{ not json").unwrap();
    let before = snapshot(&root);

    let json = run(&root, &["check", "--json"]);
    assert!(
        !json.status.success(),
        "a blocking finding exits with an error"
    );
    let view: Value = serde_json::from_slice(&json.stdout).expect("the report is still printed");
    let blocking = view["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["name"] == "blocking")
        .expect("the damaged atlas blocks");
    let entry = &view["findings"][blocking["findings"][0].as_u64().unwrap() as usize];
    assert_eq!(entry["scope"]["object"], "atlas");
    assert_eq!(entry["gate"], "refuses");
    let terminal = run(&root, &["check"]);
    assert!(!terminal.status.success());
    assert!(
        text(&terminal.stderr).contains("research blocking"),
        "{}",
        text(&terminal.stderr)
    );

    let refused = run(&root, &["build"]);
    assert!(!refused.status.success());
    let refusal = text(&refused.stderr);
    assert!(
        refusal.contains("research blocking") && refusal.contains("[atlas: "),
        "a refused build prints the report beside the error: {refusal}"
    );
    assert_eq!(
        snapshot(&root),
        before,
        "neither check nor a refused build changed a file"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_site_without_research_prints_exactly_what_it_always_printed() {
    let root = project("legacy", false);
    let checked = run(&root, &["check"]);
    assert!(checked.status.success(), "{}", text(&checked.stderr));
    assert!(
        text(&checked.stdout).starts_with("OK: "),
        "{}",
        text(&checked.stdout)
    );
    assert!(
        !text(&checked.stderr)
            .lines()
            .any(|line| line.starts_with("research ")),
        "{}",
        text(&checked.stderr)
    );
    let built = run(&root, &["build"]);
    assert!(built.status.success(), "{}", text(&built.stderr));
    assert!(
        !text(&built.stderr).contains("research "),
        "{}",
        text(&built.stderr)
    );
    let again = run(&root, &["build"]);
    assert_eq!(text(&built.stdout), text(&again.stdout));
    let json = run(&root, &["check", "--json"]);
    let view: Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(view["applies"], false);
    assert_eq!(view["findings"], json!([]));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_research_site_with_nothing_to_report_says_so_and_a_site_without_research_stays_silent() {
    let root = project("quiet", false);
    fs::create_dir_all(root.join(".openblog/private/research")).unwrap();
    fs::write(root.join(LIBRARY_FILE), r#"{"version": 1, "sources": []}"#).unwrap();
    for args in [&["check"][..], &["build"][..]] {
        let output = run(&root, args);
        assert!(output.status.success(), "{}", text(&output.stderr));
        assert!(
            text(&output.stderr)
                .lines()
                .any(|line| line == "Research checks: nothing to review"),
            "{args:?}: {}",
            text(&output.stderr)
        );
    }
    let json = run(&root, &["check", "--json"]);
    let view: Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(view["applies"], true);
    assert_eq!(view["findings"], json!([]));
    assert_eq!(view["error"], Value::Null);
    fs::remove_dir_all(&root).unwrap();

    let plain = project("quiet-plain", false);
    for args in [&["check"][..], &["build"][..]] {
        let output = run(&plain, args);
        assert!(output.status.success());
        assert!(
            !text(&output.stderr).contains("Research checks"),
            "{}",
            text(&output.stderr)
        );
    }
    fs::remove_dir_all(&plain).unwrap();
}

#[test]
fn check_json_always_prints_one_envelope_and_exits_as_check_does() {
    // A site that cannot be loaded: JSON with an error, nothing else, and a failing exit.
    let root = project("envelope", true);
    fs::write(
        root.join("content/posts/broken.md"),
        "---\ntitle: [unclosed\n---\n\nbody\n",
    )
    .unwrap();
    let plain = run(&root, &["check"]);
    assert!(!plain.status.success());
    let json = run(&root, &["check", "--json"]);
    assert_eq!(
        json.status.code(),
        plain.status.code(),
        "check's exit status"
    );
    let view: Value = serde_json::from_slice(&json.stdout).expect("JSON and nothing else");
    assert_eq!(view["applies"], false);
    assert_eq!(view["findings"], json!([]));
    assert!(
        view["error"].as_str().unwrap().contains("broken.md"),
        "{view}"
    );
    assert_eq!(
        run(&root, &["check", "--json"]).stdout,
        json.stdout,
        "deterministic"
    );
    fs::remove_dir_all(&root).unwrap();

    // A site that loads but whose checks fail: the report and the error together.
    let root = project("envelope-blocking", true);
    fs::write(root.join(ATLAS_FILE), "{ not json").unwrap();
    let plain = run(&root, &["check"]);
    let json = run(&root, &["check", "--json"]);
    assert_eq!(json.status.code(), plain.status.code());
    assert!(!json.status.success());
    let view: Value = serde_json::from_slice(&json.stdout).unwrap();
    assert!(view["error"].is_string(), "{view}");
    assert!(!view["findings"].as_array().unwrap().is_empty());
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn check_and_build_print_each_finding_once_on_a_research_site() {
    let root = project("once", true);
    for args in [&["check"][..], &["build"][..]] {
        let output = run(&root, args);
        let stderr = text(&output.stderr);
        assert!(
            stderr.lines().any(|line| line.starts_with("research ")),
            "{stderr}"
        );
        assert!(
            !stderr
                .lines()
                .any(|line| line.starts_with("evidence ") || line.contains("source-review ")),
            "{args:?} repeats a finding the report already lists: {stderr}"
        );
        let listed: Vec<&str> = stderr
            .lines()
            .filter(|line| line.starts_with("research "))
            .collect();
        let mut unique = listed.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(listed.len(), unique.len(), "{listed:?}");
    }
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_site_report_names_the_claims_of_the_site_not_of_a_post() {
    let root = project("scope-wording", true);
    let config_path = root.join("openblog.json");
    let mut config: Value =
        serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
    config["knowledgeAtlas"] = json!({"publish": false});
    fs::write(&config_path, config.to_string()).unwrap();
    // Claims are stored, the site does not publish them, and the notebook cannot be read.
    fs::write(
        root.join(".openblog/private/research/claims.json"),
        r#"{"version": 1, "claims": [], "links": []}"#,
    )
    .unwrap();
    fs::write(
        root.join(".openblog/private/research/notebook.json"),
        "{ not json",
    )
    .unwrap();
    let json = run(&root, &["check", "--json"]);
    let view: Value = serde_json::from_slice(&json.stdout).unwrap();
    let notes = view["notReviewed"].to_string();
    assert!(!notes.contains("This post's claims"), "{notes}");
    assert!(notes.contains("The claims were not reviewed"), "{notes}");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn an_unreadable_claims_file_is_in_the_site_report_and_refuses_the_build() {
    let root = project("claims-unreadable", true);
    let config_path = root.join("openblog.json");
    let mut config: Value =
        serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
    config["knowledgeAtlas"] = json!({"publish": false});
    config["claimEvidence"] = json!({"publish": true});
    fs::write(&config_path, config.to_string()).unwrap();
    // A folder stands where the claims file would be.
    fs::create_dir_all(root.join(".openblog/private/research/claims.json")).unwrap();
    let before = snapshot(&root);

    let json = run(&root, &["check", "--json"]);
    assert!(!json.status.success(), "the next build would refuse");
    let view: Value = serde_json::from_slice(&json.stdout).unwrap();
    assert!(
        listed_codes(&view)
            .iter()
            .any(|code| code == "claims: file-unreadable"),
        "{view}"
    );
    assert!(view["error"].is_string(), "{view}");
    let terminal = text(&run(&root, &["check"]).stderr);
    assert!(terminal.contains("file-unreadable"), "{terminal}");
    assert!(
        !terminal.contains("nothing to review"),
        "a failure is never reported as nothing to review: {terminal}"
    );

    let out = root.join("claims-out");
    let built = run(&root, &["build", "--out", out.to_str().unwrap()]);
    assert!(!built.status.success());
    assert!(text(&built.stderr).contains("file-unreadable"));
    assert!(!out.exists(), "a refused build writes nothing");
    assert_eq!(snapshot(&root), before, "nothing was repaired or written");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn the_error_envelope_has_the_full_empty_report_shape() {
    let ok = project("shape-ok", false);
    let ok_view: Value = serde_json::from_slice(&run(&ok, &["check", "--json"]).stdout).unwrap();
    let root = project("shape-error", false);
    fs::write(
        root.join("content/posts/broken.md"),
        "---
title: [unclosed
---

body
",
    )
    .unwrap();
    let view: Value = serde_json::from_slice(&run(&root, &["check", "--json"]).stdout).unwrap();
    let keys =
        |value: &Value| -> Vec<String> { value.as_object().unwrap().keys().cloned().collect() };
    assert_eq!(keys(&view), keys(&ok_view), "the same fields as any report");
    for key in ["version", "counts", "scope", "acknowledgements"] {
        assert!(!view[key].is_null(), "{key}: {view}");
    }
    assert!(view["error"].is_string(), "{view}");
    assert_eq!(view["findings"], json!([]));
    assert_eq!(view["applies"], false);
    fs::remove_dir_all(&root).unwrap();
    fs::remove_dir_all(&ok).unwrap();
}

#[test]
fn a_production_build_counts_findings_in_unpublished_posts_and_never_names_them() {
    let root = project("unpublished", true);
    fs::write(
        root.join("content/posts/wip.md"),
        "---\ntitle: Work in progress\ndate: 2026-10-02\nprofile: research\ncitations: notes\ndraft: true\n---\n\nAn unfinished thought [@nobody].\n",
    )
    .unwrap();
    let build = |args: &[&str]| {
        let output = run(&root, args);
        assert!(output.status.success(), "{}", text(&output.stderr));
        text(&output.stderr)
    };

    let production = build(&["build"]);
    assert!(
        !production
            .lines()
            .any(|line| line.starts_with("research") && line.contains("wip")),
        "the research report of a production build never names a draft: {production}"
    );
    assert!(
        production.contains("finding(s) in posts not yet published; see `openblog check`"),
        "{production}"
    );
    assert!(
        production.contains("posts/cave.md"),
        "a published post's findings stay: {production}"
    );

    let check = build(&["check"]);
    assert!(check.contains("posts/wip.md"), "check lists it: {check}");
    assert!(!check.contains("not yet published"), "{check}");

    let preview = build(&["build", "--drafts"]);
    assert!(
        preview.contains("posts/wip.md"),
        "a preview that holds drafts lists them: {preview}"
    );
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_library_the_build_reads_but_a_full_check_refuses_is_stated_not_dropped() {
    // The build reads the sources it publishes; a reading with no source is
    // refused only by the full check, so the report says the library was not
    // reviewed rather than saying nothing.
    let root = project("library-interpretation", true);
    let mut library: Value =
        serde_json::from_str(&fs::read_to_string(root.join(LIBRARY_FILE)).unwrap()).unwrap();
    library["interpretations"] = json!([{"id": "my-reading", "kind": "reading", "text": "Words kept private.",
            "interpreters": [{"name": "The author"}]}]);
    fs::write(root.join(LIBRARY_FILE), library.to_string()).unwrap();
    let output = run(&root, &["check", "--json"]);
    assert!(!output.status.success(), "check refuses the library");
    let view: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(view["applies"], true);
    let not_reviewed = view["notReviewed"].to_string();
    assert!(
        not_reviewed.contains("source-review") && not_reviewed.contains("cannot be read"),
        "{not_reviewed}"
    );
    let terminal = text(&run(&root, &["check"]).stderr);
    assert!(
        terminal.contains("research not reviewed:") && !terminal.contains("nothing to review"),
        "{terminal}"
    );
    fs::remove_dir_all(&root).unwrap();
}
