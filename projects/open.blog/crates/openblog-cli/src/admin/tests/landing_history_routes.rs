//! Landing page history routes (ADR 0264, #337): every save keeps a version in private storage,
//! the list is bounded, a restore is an atomic, conflict-safe save that never loses the current
//! page, and nothing here reaches the content folder, the built site or Git.

use super::*;
use crate::landing_history::MAX_VERSIONS;

fn landing_file(f: &Fixture) -> PathBuf {
    f.dir.join("content/landing.json")
}

fn page(heading: &str) -> Json {
    json!({"sections": [
        {"id": "hello", "type": "welcome", "heading": heading},
        {"id": "latest", "type": "latest-posts", "heading": "Latest"}
    ]})
}

fn save(f: &Fixture, session: &(String, String), heading: &str, revision: &Json) -> Json {
    let body = if revision.is_null() {
        json!({"page": page(heading)})
    } else {
        json!({"page": page(heading), "revision": revision})
    };
    let (status, answer) = source_call(f, session, "PUT", "/admin/api/landing", body);
    assert!(status == 200 || status == 201, "{status}: {answer}");
    answer
}

fn history(f: &Fixture, session: &(String, String)) -> Json {
    let r = handle(
        &f.state,
        &authed(req("GET", "/admin/api/landing/history"), session, false),
    );
    assert_eq!(r.status, 200);
    body_json(&r)
}

fn restore(f: &Fixture, session: &(String, String), body: Json) -> (u16, Json) {
    source_call(
        f,
        session,
        "POST",
        "/admin/api/landing/history/restore",
        body,
    )
}

fn item(f: &Fixture, session: &(String, String), id: u64) -> Response {
    handle(
        &f.state,
        &authed(
            req("GET", &format!("/admin/api/landing/history/item?id={id}")),
            session,
            false,
        ),
    )
}

fn id_at(list: &Json, index: usize) -> u64 {
    list["versions"][index]["id"].as_u64().unwrap()
}

#[test]
fn each_save_is_kept_with_a_plain_summary_and_the_newest_is_marked_current() {
    let f = fixture("history-keep");
    let session = login_ok(&f);
    let first = save(&f, &session, "First", &Json::Null);
    assert_eq!(first["history"]["kept"], true);
    let second = save(&f, &session, "Second", &first["revision"]);
    let list = history(&f, &session);
    let versions = list["versions"].as_array().unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0]["summary"], "Changed 1 section");
    assert_eq!(versions[1]["summary"], "First saved version, 2 sections");
    assert_eq!(versions[0]["current"], true);
    assert_eq!(versions[1]["current"], false);
    assert_eq!(versions[0]["sections"], 2);
    assert!(versions[0]["savedAt"].as_str().unwrap().contains('T'));
    assert_eq!(list["max"], MAX_VERSIONS);
    assert!(
        versions[0].get("page").is_none(),
        "the list carries no page"
    );
    // One version, with its page, to preview.
    let shown = item(&f, &session, id_at(&list, 1));
    assert_eq!(shown.status, 200);
    assert_eq!(body_json(&shown)["page"]["sections"][0]["heading"], "First");
    assert_eq!(second["history"]["kept"], true);
    for bad in ["", "?id=x", "?id=-1", "?id=999999"] {
        let r = handle(
            &f.state,
            &authed(
                req("GET", &format!("/admin/api/landing/history/item{bad}")),
                &session,
                false,
            ),
        );
        assert!(r.status == 400 || r.status == 404, "{bad}: {}", r.status);
    }
}

#[test]
fn restoring_is_a_new_version_that_never_loses_the_current_one() {
    let f = fixture("history-restore");
    let session = login_ok(&f);
    let first = save(&f, &session, "First", &Json::Null);
    let second = save(&f, &session, "Second", &first["revision"]);
    let list = history(&f, &session);
    let oldest = id_at(&list, 1);
    let (status, restored) = restore(
        &f,
        &session,
        json!({"id": oldest, "revision": second["revision"]}),
    );
    assert_eq!(status, 200, "{restored}");
    assert_eq!(restored["page"]["sections"][0]["heading"], "First");
    assert_eq!(restored["history"]["kept"], true);
    assert_eq!(restored["build"]["ok"], true);
    let text = fs::read_to_string(landing_file(&f)).unwrap();
    assert!(text.contains("\"First\"") && !text.contains("\"Second\""));
    // Three versions now: the restore is the newest, and "Second" is still kept.
    let after = history(&f, &session);
    assert_eq!(after["versions"].as_array().unwrap().len(), 3, "{after}");
    assert!(after["versions"][0]["summary"]
        .as_str()
        .unwrap()
        .starts_with("Restored the version from "));
    assert_eq!(after["versions"][0]["current"], true);
    let kept = item(&f, &session, id_at(&after, 1));
    assert_eq!(body_json(&kept)["page"]["sections"][0]["heading"], "Second");
}

#[test]
fn a_stale_or_unknown_restore_changes_nothing() {
    let f = fixture("history-conflict");
    let session = login_ok(&f);
    let first = save(&f, &session, "First", &Json::Null);
    let second = save(&f, &session, "Second", &first["revision"]);
    let before = fs::read_to_string(landing_file(&f)).unwrap();
    let list = history(&f, &session);
    let versions_before = list["versions"].as_array().unwrap().len();
    let oldest = id_at(&list, 1);
    // The page changed under the owner: a conflict that carries the current page.
    let (status, conflict) = restore(
        &f,
        &session,
        json!({"id": oldest, "revision": first["revision"]}),
    );
    assert_eq!(status, 409, "{conflict}");
    assert_eq!(conflict["conflict"], true);
    assert_eq!(conflict["revision"], second["revision"]);
    for body in [
        json!({"id": 424_242, "revision": second["revision"]}),
        json!({"revision": second["revision"]}),
        json!({"id": "1", "revision": second["revision"]}),
        json!({"id": oldest, "revision": 7}),
    ] {
        let (status, _) = restore(&f, &session, body.clone());
        assert!(status == 400 || status == 404, "{status} for {body}");
    }
    assert_eq!(fs::read_to_string(landing_file(&f)).unwrap(), before);
    assert_eq!(
        history(&f, &session)["versions"].as_array().unwrap().len(),
        versions_before,
        "a refused restore keeps nothing"
    );
}

#[test]
fn the_history_is_bounded_and_the_oldest_versions_go_first() {
    let f = fixture("history-bound");
    let session = login_ok(&f);
    let mut revision = Json::Null;
    for n in 0..(MAX_VERSIONS + 5) {
        revision = save(&f, &session, &format!("Version {n}"), &revision)["revision"].clone();
    }
    let list = history(&f, &session);
    assert_eq!(list["versions"].as_array().unwrap().len(), MAX_VERSIONS);
    assert_eq!(list["versions"][0]["current"], true);
    let files = fs::read_dir(f.dir.join(".openblog/private/landing-history"))
        .unwrap()
        .count();
    assert_eq!(files, MAX_VERSIONS);
}

#[test]
fn a_page_edited_outside_admin_is_kept_before_the_next_change_replaces_it() {
    let f = fixture("history-outside");
    let session = login_ok(&f);
    let first = save(&f, &session, "First", &Json::Null);
    // Someone edits the file by hand.
    let by_hand = fs::read_to_string(landing_file(&f))
        .unwrap()
        .replace("First", "Edited by hand");
    fs::write(landing_file(&f), &by_hand).unwrap();
    let current = body_json(&handle(
        &f.state,
        &authed(req("GET", "/admin/api/landing"), &session, false),
    ));
    assert_ne!(current["revision"], first["revision"]);
    save(&f, &session, "Third", &current["revision"]);
    let list = history(&f, &session);
    let count = list["versions"].as_array().unwrap().len();
    let seen: Vec<String> = (0..count)
        .map(|index| {
            let shown = item(&f, &session, id_at(&list, index));
            body_json(&shown)["page"]["sections"][0]["heading"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(seen, ["Third", "Edited by hand", "First"]);
}

#[test]
fn history_never_reaches_the_content_folder_the_built_site_or_git() {
    let f = fixture("history-private");
    fs::create_dir_all(f.dir.join(".git")).unwrap();
    let session = login_ok(&f);
    let first = save(&f, &session, "OLDVERSIONMARKERzq", &Json::Null);
    save(&f, &session, "Newer words", &first["revision"]);
    // Only landing.json is beside the content; the old words are nowhere in the built site.
    assert!(!f.dir.join("content/landing-history").exists());
    fn scan(dir: &Path, marker: &str, hits: &mut Vec<String>) {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan(&path, marker, hits);
            } else if let Ok(text) = fs::read_to_string(&path) {
                if text.contains(marker) {
                    hits.push(path.display().to_string());
                }
            }
        }
    }
    for folder in ["dist", "content"] {
        let mut hits = Vec::new();
        if f.dir.join(folder).exists() {
            scan(&f.dir.join(folder), "OLDVERSIONMARKERzq", &mut hits);
        }
        assert!(hits.is_empty(), "{folder}: {hits:?}");
    }
    let ignore = fs::read_to_string(f.dir.join(".gitignore")).unwrap_or_default();
    assert!(
        ignore
            .lines()
            .any(|line| line.trim() == "/.openblog/private/" || line.trim() == "/.openblog"),
        "{ignore:?}"
    );
    assert!(f.dir.join(".openblog/private/landing-history").is_dir());
}

#[test]
fn a_page_written_by_a_newer_release_is_never_overwritten_by_a_restore() {
    let f = fixture("history-newer");
    let session = login_ok(&f);
    let first = save(&f, &session, "First", &Json::Null);
    save(&f, &session, "Second", &first["revision"]);
    let newer = r#"{"format":"openblog-landing","version":3,"sections":[]}"#;
    fs::write(landing_file(&f), newer).unwrap();
    let current = body_json(&handle(
        &f.state,
        &authed(req("GET", "/admin/api/landing"), &session, false),
    ));
    let oldest = id_at(&history(&f, &session), 1);
    let (status, answer) = restore(
        &f,
        &session,
        json!({"id": oldest, "revision": current["revision"]}),
    );
    assert_eq!(status, 409, "{answer}");
    assert_eq!(answer["newerVersion"], true);
    assert_eq!(fs::read_to_string(landing_file(&f)).unwrap(), newer);
}

#[test]
fn a_failed_backup_aborts_the_save_and_leaves_the_page_unchanged() {
    let f = fixture("history-backup-fails");
    let session = login_ok(&f);
    let first = save(&f, &session, "First", &Json::Null);
    let by_hand = fs::read_to_string(landing_file(&f))
        .unwrap()
        .replace("First", "By hand");
    fs::write(landing_file(&f), &by_hand).unwrap();
    // The history folder cannot be made: a file stands where it should be.
    let folder = f.dir.join(".openblog/private/landing-history");
    fs::remove_dir_all(&folder).unwrap();
    fs::write(&folder, "in the way").unwrap();
    let current = body_json(&handle(
        &f.state,
        &authed(req("GET", "/admin/api/landing"), &session, false),
    ));
    assert_ne!(current["revision"], first["revision"]);
    let (status, answer) = source_call(
        &f,
        &session,
        "PUT",
        "/admin/api/landing",
        json!({"page": page("Third"), "revision": current["revision"]}),
    );
    assert_eq!(status, 500, "{answer}");
    assert_eq!(fs::read_to_string(landing_file(&f)).unwrap(), by_hand);
}

#[test]
fn an_unparseable_page_is_kept_as_raw_bytes_before_it_is_replaced() {
    let f = fixture("history-raw");
    let session = login_ok(&f);
    save(&f, &session, "First", &Json::Null);
    let broken = "{ this is not json";
    fs::write(landing_file(&f), broken).unwrap();
    let current = body_json(&handle(
        &f.state,
        &authed(req("GET", "/admin/api/landing"), &session, false),
    ));
    save(&f, &session, "Fresh", &current["revision"]);
    let folder = f.dir.join(".openblog/private/landing-history");
    let raw: Vec<_> = fs::read_dir(&folder)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".bak"))
        .collect();
    assert_eq!(raw.len(), 1);
    assert_eq!(fs::read_to_string(raw[0].path()).unwrap(), broken);
}
