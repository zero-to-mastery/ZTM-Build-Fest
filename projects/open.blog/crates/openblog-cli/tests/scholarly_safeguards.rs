//! The scholarly-safeguard regression corpus through the real command line
//! (#195, ADR 0151): compact invented projects, each failing one distinction
//! on its own, run through `openblog check --json` and `openblog build`.
//!
//! `tests/fixtures/scholarly-safeguards/corpus.json` is the data. Every case is
//! an overlay on one clean project (files, folders and settings for
//! `openblog.json`) and names exactly the findings (`validator: code`) the
//! real emitters report for it; a case whose findings differ in either
//! direction fails. Nothing here is an authoritative dataset, a real excerpt
//! or a judgement about any real scholarship.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

const CORPUS: &str = include_str!("../../../tests/fixtures/scholarly-safeguards/corpus.json");

fn corpus() -> Value {
    serde_json::from_str(CORPUS).expect("the corpus is JSON")
}

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

fn write(root: &Path, files: &Value) {
    let Some(files) = files.as_object() else {
        return;
    };
    for (path, content) in files {
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        match content {
            Value::String(text) => fs::write(target, text).unwrap(),
            other => fs::write(target, other.to_string()).unwrap(),
        }
    }
}

/// The clean project, then one case's files, folders and settings over it.
fn project(corpus: &Value, tag: &str, case: &Value) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "openblog-scholarly-{tag}-{}-{}",
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
    // The example's own post is replaced: the corpus holds the only research.
    fs::write(
        root.join("content/posts/portable-lesson.md"),
        "---\ntitle: A plain post\ndate: 2026-10-24\n---\n\nJust an article.\n",
    )
    .unwrap();
    write(&root, &corpus["base"]["files"]);
    write(&root, &case["files"]);
    for directory in case["dirs"].as_array().into_iter().flatten() {
        let path = root.join(directory.as_str().unwrap());
        // A folder stands where the file would be.
        let _ = fs::remove_file(&path);
        fs::create_dir_all(path).unwrap();
    }
    let config_path = root.join("openblog.json");
    let mut config: Value =
        serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
    for settings in [&corpus["base"]["config"], &case["config"]] {
        if let Some(settings) = settings.as_object() {
            for (key, value) in settings {
                config[key] = value.clone();
            }
        }
    }
    fs::write(config_path, config.to_string()).unwrap();
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

fn strings(value: &Value) -> BTreeSet<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| item.as_str().unwrap().to_string())
        .collect()
}

/// The `validator: code` of every finding of a `check --json` report.
fn rows(report: &Value) -> BTreeSet<String> {
    report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|finding| {
            format!(
                "{}: {}",
                finding["validator"].as_str().unwrap(),
                finding["code"].as_str().unwrap()
            )
        })
        .collect()
}

fn cli_cases(corpus: &Value) -> Vec<&Value> {
    corpus["cases"].as_array().unwrap().iter().collect()
}

/// Every file under the project with its bytes, so a command can be shown to
/// have changed nothing.
fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, dir: &Path, into: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
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

/// The authored words a case keeps private: statements, rationales,
/// uncertainty notes, notes and excerpts in the private research files,
/// never the words of a post (which are public once published).
fn private_words(case: &Value) -> BTreeSet<String> {
    fn collect(value: &Value, under_anchor: bool, into: &mut BTreeSet<String>) {
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    let anchor = under_anchor || key == "anchor";
                    if !anchor
                        && matches!(
                            key.as_str(),
                            "statement" | "rationale" | "uncertainty" | "note" | "text"
                        )
                    {
                        if let Some(words) = child.as_str() {
                            into.insert(words.to_string());
                        }
                    }
                    collect(child, anchor, into);
                }
            }
            Value::Array(items) => items
                .iter()
                .for_each(|item| collect(item, under_anchor, into)),
            _ => {}
        }
    }
    let mut words = BTreeSet::new();
    for (path, content) in case["files"].as_object().into_iter().flatten() {
        if path.starts_with(".openblog/private/") {
            collect(content, false, &mut words);
        }
    }
    words
}

#[test]
fn every_case_reports_exactly_the_findings_it_names_and_changes_nothing() {
    let corpus = corpus();
    for case in cli_cases(&corpus) {
        let id = case["id"].as_str().unwrap();
        let root = project(&corpus, "check", case);
        let before = snapshot(&root);
        let first = run(&root, &["check", "--json"]);
        let second = run(&root, &["check", "--json"]);
        assert_eq!(
            first.stdout, second.stdout,
            "{id}: the report is deterministic"
        );
        let report: Value = serde_json::from_slice(&first.stdout)
            .unwrap_or_else(|error| panic!("{id}: no JSON ({error}): {}", text(&first.stderr)));
        assert_eq!(rows(&report), strings(&case["emits"]), "{id}");

        // Only a failure of a file the build reads refuses it; nothing else changes the exit.
        let blocking = report["groups"]
            .as_array()
            .unwrap()
            .iter()
            .any(|group| group["name"] == "blocking");
        assert_eq!(
            first.status.success(),
            !blocking,
            "{id}: exit status; {}",
            report["error"]
        );
        assert_eq!(report["error"].is_null(), !blocking, "{id}: error field");

        // Nothing is silently left unreviewed: a part that could not run is stated.
        let unreadable = strings(&case["emits"])
            .iter()
            .any(|row| row.starts_with("source-library: ") || row.starts_with("notebook: "));
        assert_eq!(
            report["notReviewed"].as_array().map(Vec::len),
            Some(usize::from(unreadable)),
            "{id}: {}",
            report["notReviewed"]
        );

        // Every finding is scoped to the one object it is about.
        for finding in report["findings"].as_array().unwrap() {
            let scope = &finding["scope"];
            assert!(scope["object"].is_string(), "{id}: {finding}");
            let whole_file = matches!(
                scope["object"].as_str().unwrap(),
                "source-library"
                    | "notebook"
                    | "atlas"
                    | "claims-file"
                    | "alignments-file"
                    | "selections-file"
            );
            assert!(
                whole_file
                    || scope["id"].is_string()
                    || scope["path"].is_string()
                    || scope["field"].is_string(),
                "{id}: {finding}"
            );
            assert!(
                finding["message"].as_str().is_some_and(|m| !m.is_empty())
                    && finding["repair"].as_str().is_some_and(|m| !m.is_empty()),
                "{id}: {finding}"
            );
        }

        // Nothing private is printed, and nothing was written or repaired.
        let printed = format!("{}{}", text(&first.stdout), text(&first.stderr));
        for words in private_words(case) {
            assert!(
                !printed.contains(&words),
                "{id} printed private words: {words}"
            );
        }
        assert_eq!(snapshot(&root), before, "{id}: check changed a file");
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn the_terminal_lists_what_the_json_lists_for_every_case() {
    let corpus = corpus();
    for case in cli_cases(&corpus) {
        let id = case["id"].as_str().unwrap();
        let root = project(&corpus, "terminal", case);
        let report: Value =
            serde_json::from_slice(&run(&root, &["check", "--json"]).stdout).unwrap();
        let terminal = text(&run(&root, &["check"]).stderr);
        let printed: BTreeSet<String> = terminal
            .lines()
            .filter(|line| line.starts_with("research ") && line.ends_with(']'))
            .filter_map(|line| {
                let start = line.rfind('[')?;
                Some(line[start + 1..line.len() - 1].to_string())
            })
            .collect();
        assert_eq!(printed, rows(&report), "{id}");
        fs::remove_dir_all(root).unwrap();
    }
}

/// Every file of a built site as text, to scan for words that must not be there.
fn built_text(out: &Path) -> String {
    let mut all = String::new();
    for (path, bytes) in snapshot(out) {
        all.push_str(&path);
        all.push('\n');
        all.push_str(&String::from_utf8_lossy(&bytes));
    }
    all
}

/// The words a case keeps private even when it approves something: the
/// statement, rationale, uncertainty, note, text and label of each item that
/// is not itself approved. What an approved item says of itself is published
/// on purpose, so a sentence an approved item also says is left out.
fn unapproved_words(case: &Value) -> BTreeSet<String> {
    /// The passages an approved comparison quotes: published on purpose.
    fn quoted(value: &Value, into: &mut BTreeSet<String>) {
        match value {
            Value::Object(map) => {
                if map.get("visibility").is_some_and(|v| v == "approved") {
                    for member in map
                        .get("members")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        if let Some(passage) = member["passage"].as_str() {
                            into.insert(passage.to_string());
                        }
                    }
                }
                map.values().for_each(|child| quoted(child, into));
            }
            Value::Array(items) => items.iter().for_each(|item| quoted(item, into)),
            _ => {}
        }
    }
    fn collect(
        value: &Value,
        quoted: &BTreeSet<String>,
        under_anchor: bool,
        into: &mut (BTreeSet<String>, BTreeSet<String>),
    ) {
        match value {
            Value::Object(map) => {
                let approved = map.get("visibility").is_some_and(|v| v == "approved")
                    || (map.contains_key("excerpt")
                        && map
                            .get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| quoted.contains(id)));
                for (key, child) in map {
                    let anchor = under_anchor || key == "anchor";
                    let said = matches!(
                        key.as_str(),
                        "statement" | "rationale" | "uncertainty" | "note" | "text" | "label"
                    );
                    if !anchor && said {
                        if let Some(words) = child.as_str() {
                            let side = if approved { &mut into.1 } else { &mut into.0 };
                            side.insert(words.to_string());
                        }
                    }
                    // The excerpt of a quoted passage is that passage's own words.
                    if !(key == "excerpt" && approved) {
                        collect(child, quoted, anchor, into);
                    }
                }
            }
            Value::Array(items) => items
                .iter()
                .for_each(|item| collect(item, quoted, under_anchor, into)),
            _ => {}
        }
    }
    let mut words = (BTreeSet::new(), BTreeSet::new());
    let mut quoted_passages = BTreeSet::new();
    for (path, content) in case["files"].as_object().into_iter().flatten() {
        if path.starts_with(".openblog/private/") {
            quoted(content, &mut quoted_passages);
        }
    }
    for (path, content) in case["files"].as_object().into_iter().flatten() {
        if path.starts_with(".openblog/private/") {
            collect(content, &quoted_passages, false, &mut words);
        }
    }
    let (private, public) = words;
    private.difference(&public).cloned().collect()
}

#[test]
fn a_build_never_publishes_what_a_case_keeps_private() {
    let corpus = corpus();
    let mut approving = 0;
    for case in cli_cases(&corpus) {
        let id = case["id"].as_str().unwrap();
        // A case that approves something publishes that on purpose; what it
        // leaves unapproved, and every rationale, uncertainty and note, stays out.
        let approves = serde_json::to_string(&case["files"])
            .unwrap()
            .contains("\"approved\"");
        let words = if approves {
            approving += 1;
            unapproved_words(case)
        } else {
            private_words(case)
        };
        let root = project(&corpus, "build", case);
        let out = root.join("scholarly-out");
        let built = run(&root, &["build", "--out", out.to_str().unwrap()]);
        // A refused build writes nothing; a build that ran prints no private word.
        if built.status.success() {
            let site = built_text(&out);
            for word in &words {
                assert!(!site.contains(word), "{id} published private words: {word}");
            }
        } else {
            assert!(!out.exists(), "{id}: a refused build wrote files");
        }
        let printed = format!("{}{}", text(&built.stdout), text(&built.stderr));
        for word in &words {
            assert!(
                !printed.contains(word),
                "{id} printed private words: {word}"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
    assert!(
        approving >= 4,
        "the cases that approve something are scanned too"
    );
}

#[test]
fn each_distinction_can_fail_independently_and_can_pass() {
    let corpus = corpus();
    let distinctions = strings(&corpus["distinctions"]);
    assert!(distinctions.len() >= 13, "{distinctions:?}");
    let cases: Vec<&Value> = corpus["cases"].as_array().unwrap().iter().collect();
    for distinction in &distinctions {
        let of: Vec<&Value> = cases
            .iter()
            .copied()
            .filter(|case| strings(&case["distinction"]).contains(distinction))
            .collect();
        assert!(
            of.iter()
                .any(|case| !case["emits"].as_array().unwrap().is_empty()),
            "{distinction} has no case that fails"
        );
        assert!(
            of.iter()
                .any(|case| case["emits"].as_array().unwrap().is_empty()),
            "{distinction} has no case that passes"
        );
    }
    // A case that tags one distinction fails within that distinction alone: the
    // findings it names come from the validators that own it, and no other.
    let owners = owners();
    for distinction in &distinctions {
        assert!(
            owners.contains_key(distinction.as_str()),
            "{distinction} has no owner"
        );
        let single: Vec<&&Value> = of_one(&cases, distinction);
        assert!(
            single
                .iter()
                .any(|case| !case["emits"].as_array().unwrap().is_empty()),
            "{distinction} has no failing case that tags it alone"
        );
    }
    for case in &cases {
        let tags = strings(&case["distinction"]);
        for tag in &tags {
            assert!(
                distinctions.contains(tag),
                "{} names an unknown distinction {tag}",
                case["id"]
            );
        }
        if tags.len() != 1 {
            continue;
        }
        let owned = &owners[tags.iter().next().unwrap().as_str()];
        for row in strings(&case["emits"]) {
            let validator = row.split(": ").next().unwrap();
            assert!(
                owned.contains(&validator),
                "{} fails only {tags:?} but names {row}, which {owned:?} do not own",
                case["id"]
            );
        }
    }
}

/// The cases that tag exactly one distinction.
fn of_one<'a>(cases: &'a [&'a Value], distinction: &str) -> Vec<&'a &'a Value> {
    cases
        .iter()
        .filter(|case| strings(&case["distinction"]) == BTreeSet::from([distinction.to_string()]))
        .collect()
}

/// The validators that report on each distinction, by the name each finding
/// carries. A distinction fails on its own when its findings come from these
/// alone.
fn owners() -> BTreeMap<&'static str, Vec<&'static str>> {
    BTreeMap::from([
        (
            "original-work",
            vec!["research-profile", "source-review", "source-library"],
        ),
        (
            "edition",
            vec![
                "source-review",
                "citation-review",
                "source-library",
                "comparison-projection",
            ],
        ),
        (
            "translation",
            vec!["source-review", "source-library", "comparison-projection"],
        ),
        ("witness", vec!["source-review", "source-library"]),
        ("reference", vec!["citation-review", "research-profile"]),
        ("citation", vec!["citation-review", "source-review"]),
        (
            "source-location",
            vec![
                "citation-review",
                "source-review",
                "claim-review",
                "alignments",
            ],
        ),
        (
            "research-note",
            vec!["source-review", "notebook", "alignments"],
        ),
        ("claim", vec!["claim-review", "claims"]),
        ("evidence", vec!["claim-review", "claims"]),
        (
            "interpretation",
            vec!["source-library", "claim-review", "alignments"],
        ),
        (
            "contextual-entry",
            vec!["atlas", "chronology-index", "publication-context"],
        ),
        (
            "scholarly-disagreement",
            vec!["atlas", "claim-review", "claims"],
        ),
    ])
}

#[test]
fn no_case_implies_influence_from_similarity_alone() {
    let corpus = corpus();
    let case = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "similarity-is-not-influence")
        .expect("the similarity case");
    // The passages read alike, and nothing relates the works.
    let files = case["files"].as_object().unwrap();
    let atlas = &files[".openblog/private/research/atlas.json"];
    assert_eq!(atlas["relationships"], serde_json::json!([]));
    let notebook = &files[".openblog/private/research/notebook.json"];
    let excerpts: BTreeSet<&str> = notebook["passages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|passage| passage["excerpt"]["text"].as_str().unwrap())
        .collect();
    assert_eq!(excerpts.len(), 1, "the two passages read exactly alike");

    // Every relationship any case records that claims influence cites evidence.
    for case in corpus["cases"].as_array().unwrap() {
        for (path, content) in case["files"].as_object().into_iter().flatten() {
            if !path.ends_with("atlas.json") {
                continue;
            }
            for relationship in content["relationships"].as_array().into_iter().flatten() {
                if relationship["kind"] == "influenced" {
                    assert!(
                        relationship["evidence"]
                            .as_array()
                            .is_some_and(|e| !e.is_empty()),
                        "{}: an influence is recorded with its evidence",
                        case["id"]
                    );
                }
            }
        }
    }

    // And nothing the build publishes from it says one work influenced another.
    let root = project(&corpus, "similarity", case);
    let out = root.join("scholarly-out");
    let built = run(&root, &["build", "--out", out.to_str().unwrap()]);
    assert!(built.status.success(), "{}", text(&built.stderr));
    let site = built_text(&out).to_lowercase();
    assert!(
        !site.contains("influenc"),
        "a built page speaks of influence"
    );
    let report: Value = serde_json::from_slice(&run(&root, &["check", "--json"]).stdout).unwrap();
    assert!(
        !report.to_string().to_lowercase().contains("influenc"),
        "no finding speaks of influence"
    );
    fs::remove_dir_all(root).unwrap();
}
