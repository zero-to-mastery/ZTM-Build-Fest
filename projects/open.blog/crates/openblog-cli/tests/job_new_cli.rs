//! `openblog new --profile job` through the real command line (ADR 0287): the same front matter and
//! headings Admin's Job mode writes, checked by the job profile in core, always a draft.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use openblog_core::{frontmatter, job};

fn project(tag: &str, extra_trades: &[&str]) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "openblog-job-new-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(root.join("content/posts")).unwrap();
    let trades: Vec<String> = extra_trades.iter().map(|t| format!("{t:?}")).collect();
    fs::write(
        root.join("openblog.json"),
        format!(
            "{{\"title\":\"Shop\",\"url\":\"https://shop.example.org\",\"extraTrades\":[{}]}}",
            trades.join(",")
        ),
    )
    .unwrap();
    root
}

fn run(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_openblog"))
        .args(args)
        .arg("--root")
        .arg(root)
        .env_remove("OPENBLOG_WORKSPACE")
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn only_post(root: &Path) -> String {
    let mut files: Vec<_> = fs::read_dir(root.join("content/posts"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1, "{files:?}");
    fs::read_to_string(files.remove(0)).unwrap()
}

#[test]
fn a_job_starts_as_a_draft_with_the_job_front_matter_and_the_four_headings() {
    let root = project("full", &["fencing"]);
    let output = run(
        &root,
        &[
            "new",
            "Oak floor in Maple Falls",
            "--profile",
            "job",
            "--trade",
            "Fencing",
            "--service",
            "post-and-rail",
            "--town",
            "Maple Falls",
            "--region",
            "WA",
            "--tags",
            "fencing",
        ],
    );
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert!(text(&output.stdout).contains("created content/posts/"));

    let source = only_post(&root);
    let document = frontmatter::parse(&source).unwrap();
    let fm = &document.front_matter;
    assert_eq!(fm.get("profile"), Some("job"));
    assert_eq!(fm.get("draft"), Some("true"));
    assert_eq!(fm.get("job.trade"), Some("fencing"));
    assert_eq!(fm.get("job.place.town"), Some("Maple Falls"));
    let metadata = job::from_front_matter(fm, &["fencing".to_string()]).expect("a complete job");
    assert_eq!(metadata.service, "post-and-rail");
    assert_eq!(metadata.started, metadata.finished);
    let headings: Vec<&str> = document
        .body
        .lines()
        .filter(|l| l.starts_with("## "))
        .collect();
    assert_eq!(
        headings,
        [
            "## Problem",
            "## What we found",
            "## What we did",
            "## Result"
        ]
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_job_with_no_answers_is_a_draft_that_check_reports_as_unfinished() {
    let root = project("bare", &[]);
    let output = run(&root, &["new", "Brake job", "--profile", "job"]);
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert!(text(&output.stdout).contains("draft"));
    let source = only_post(&root);
    let fm = frontmatter::parse(&source).unwrap().front_matter;
    assert_eq!(fm.get("draft"), Some("true"));
    assert!(
        job::from_front_matter(&fm, &[]).is_err(),
        "trade, service and town are still blank"
    );
    let check = run(&root, &["check"]);
    assert!(
        check.status.success(),
        "a draft job never stops a build: {}",
        text(&check.stderr)
    );
    let report = format!("{}{}", text(&check.stdout), text(&check.stderr));
    assert!(report.contains("job not ready to publish"), "{report}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_unknown_trade_lists_the_bundled_and_the_site_trades_and_writes_nothing() {
    let root = project("trade", &["fencing"]);
    let output = run(
        &root,
        &["new", "A job", "--profile", "job", "--trade", "welding"],
    );
    assert!(!output.status.success());
    let error = text(&output.stderr);
    assert!(error.contains("`welding` is not a known trade"), "{error}");
    assert!(
        error.contains("general-contractor") && error.contains("hvac"),
        "{error}"
    );
    assert!(error.contains("this site's own trades: fencing"), "{error}");
    assert_eq!(fs::read_dir(root.join("content/posts")).unwrap().count(), 0);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_town_is_never_an_address_and_a_service_is_an_id() {
    let root = project("place", &[]);
    let address = run(
        &root,
        &[
            "new",
            "A job",
            "--profile",
            "job",
            "--town",
            "12 Elm St, Bend",
        ],
    );
    assert!(!address.status.success());
    assert!(text(&address.stderr).contains("job.place.town"));
    let service = run(
        &root,
        &["new", "A job", "--profile", "job", "--service", "two words"],
    );
    assert!(!service.status.success());
    assert!(text(&service.stderr).contains("job.service"));
    assert_eq!(fs::read_dir(root.join("content/posts")).unwrap().count(), 0);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn other_profiles_and_stray_job_options_are_refused_and_plain_new_is_unchanged() {
    let root = project("other", &[]);
    let odd = run(&root, &["new", "A post", "--profile", "video"]);
    assert!(!odd.status.success());
    assert!(text(&odd.stderr).contains("article, recipe, job or service"));
    let stray = run(&root, &["new", "A post", "--trade", "flooring"]);
    assert!(!stray.status.success());
    assert!(text(&stray.stderr).contains("--profile job"));

    let plain = run(&root, &["new", "A post"]);
    assert!(plain.status.success(), "{}", text(&plain.stderr));
    let source = only_post(&root);
    assert!(!source.contains("job") && !source.contains("profile"));
    assert!(source.contains("Write your post here."));
    let _ = fs::remove_dir_all(&root);
}
