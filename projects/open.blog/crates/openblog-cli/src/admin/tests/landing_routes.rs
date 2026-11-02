//! Admin landing page routes (ADR 0246, #323): deny by default, CSRF, origin,
//! stale writes, the size limit, atomic canonical writes, and no other file
//! changing.

use super::*;
use openblog_core::landing::MAX_FILE_BYTES;

fn landing_file(f: &Fixture) -> PathBuf {
    f.dir.join("content/landing.json")
}

fn page() -> Json {
    json!({"sections": [
        {"id": "hello", "type": "welcome", "heading": "Hello", "subheading": "Welcome in"},
        {"id": "latest", "type": "latest-posts", "heading": "Latest"}
    ]})
}

fn put(f: &Fixture, session: &(String, String), body: Json) -> (u16, Json) {
    source_call(f, session, "PUT", "/admin/api/landing", body)
}

fn get(f: &Fixture, session: &(String, String)) -> (u16, Json) {
    let r = handle(
        &f.state,
        &authed(req("GET", "/admin/api/landing"), session, false),
    );
    (r.status, body_json(&r))
}

#[test]
fn every_route_requires_a_session_and_the_write_a_csrf_token_and_same_origin() {
    let f = fixture("landing-auth");
    assert_eq!(
        handle(&f.state, &req("GET", "/admin/api/landing")).status,
        401
    );
    assert_eq!(
        handle(&f.state, &req("PUT", "/admin/api/landing")).status,
        401
    );
    let session = login_ok(&f);
    let body = json!({"page": page()});
    let no_csrf = handle(
        &f.state,
        &authed(
            json_req("PUT", "/admin/api/landing", body.clone()),
            &session,
            false,
        ),
    );
    assert_eq!(no_csrf.status, 403);
    let mut cross = authed(
        json_req("PUT", "/admin/api/landing", body.clone()),
        &session,
        true,
    );
    cross
        .headers
        .insert("origin".into(), "https://evil.example".into());
    cross.headers.insert("host".into(), "localhost:3000".into());
    assert_eq!(handle(&f.state, &cross).status, 403);
    let mut site = authed(json_req("PUT", "/admin/api/landing", body), &session, true);
    site.headers
        .insert("sec-fetch-site".into(), "cross-site".into());
    assert_eq!(handle(&f.state, &site).status, 403);
    // Deny by default: other verbs and names are not routes.
    for (method, path) in [
        ("POST", "/admin/api/landing"),
        ("DELETE", "/admin/api/landing"),
        ("PATCH", "/admin/api/landing"),
        ("GET", "/admin/api/landing/other"),
    ] {
        let r = handle(
            &f.state,
            &authed(json_req(method, path, json!({})), &session, true),
        );
        assert!(
            r.status == 404 || r.status == 405,
            "{method} {path}: {}",
            r.status
        );
    }
    assert!(!landing_file(&f).exists(), "a refused call writes nothing");
}

#[test]
fn a_business_facts_section_is_stored_as_version_two_and_other_pages_stay_version_one() {
    let f = fixture("landing-business-version");
    let session = login_ok(&f);
    let (status, saved) = put(&f, &session, json!({"page": page()}));
    assert_eq!(status, 201, "{saved}");
    assert!(fs::read_to_string(landing_file(&f))
        .unwrap()
        .contains("\"version\": 1"));
    let mut with = page();
    with["sections"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "facts", "type": "business-facts", "heading": "Find us"}));
    let (status, updated) = put(
        &f,
        &session,
        json!({"page": with, "revision": saved["revision"]}),
    );
    assert_eq!(status, 200, "{updated}");
    assert!(fs::read_to_string(landing_file(&f))
        .unwrap()
        .contains("\"version\": 2"));
}

#[test]
fn a_missing_file_reads_as_no_page_with_the_default_layout() {
    let f = fixture("landing-missing");
    let session = login_ok(&f);
    let (status, view) = get(&f, &session);
    assert_eq!(status, 200);
    assert_eq!(view["exists"], false);
    assert_eq!(view["page"], Json::Null);
    assert_eq!(view["revision"], Json::Null);
    assert_eq!(view["legacy"]["sections"].as_array().unwrap().len(), 3);
}

#[test]
fn a_page_is_created_then_edited_with_its_revision_and_written_canonically() {
    let f = fixture("landing-save");
    let session = login_ok(&f);
    let config_before = fs::read_to_string(f.dir.join("openblog.json")).unwrap();
    let (status, created) = put(&f, &session, json!({"page": page()}));
    assert_eq!(status, 201, "{created}");
    let text = fs::read_to_string(landing_file(&f)).unwrap();
    assert_eq!(created["source"], text.as_str());
    assert!(text.starts_with("{\n  \"format\": \"openblog-landing\""));
    assert!(text.ends_with("}\n") && !text.contains('\r'));
    // Saving a section never rewrites unrelated configuration.
    assert_eq!(
        fs::read_to_string(f.dir.join("openblog.json")).unwrap(),
        config_before
    );
    let names: Vec<_> = fs::read_dir(f.dir.join("content"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with('.') || n.ends_with(".tmp"))
        .collect();
    assert!(names.is_empty(), "{names:?}");

    // The same create again has no revision to name and conflicts.
    let (status, again) = put(&f, &session, json!({"page": page()}));
    assert_eq!(status, 409, "{again}");

    let mut edited = page();
    edited["sections"][0]["heading"] = json!("Hello again");
    let (status, saved) = put(
        &f,
        &session,
        json!({"page": edited, "revision": created["revision"]}),
    );
    assert_eq!(status, 200, "{saved}");
    assert_ne!(saved["revision"], created["revision"]);
    assert_eq!(saved["page"]["sections"][0]["heading"], "Hello again");
    let (_, read) = get(&f, &session);
    assert_eq!(read["revision"], saved["revision"]);
    assert_eq!(read["valid"], true);
}

#[test]
fn a_stale_write_is_a_conflict_that_carries_the_current_revision() {
    let f = fixture("landing-stale");
    let session = login_ok(&f);
    let (_, created) = put(&f, &session, json!({"page": page()}));
    let mut first = page();
    first["sections"][0]["heading"] = json!("First");
    let (status, second) = put(
        &f,
        &session,
        json!({"page": first, "revision": created["revision"]}),
    );
    assert_eq!(status, 200);
    let before = fs::read_to_string(landing_file(&f)).unwrap();
    let mut stale = page();
    stale["sections"][0]["heading"] = json!("Stale");
    let (status, conflict) = put(
        &f,
        &session,
        json!({"page": stale, "revision": created["revision"]}),
    );
    assert_eq!(status, 409, "{conflict}");
    assert_eq!(conflict["conflict"], true);
    assert_eq!(conflict["revision"], second["revision"]);
    assert_eq!(
        conflict["current"]["page"]["sections"][0]["heading"],
        "First"
    );
    assert_eq!(fs::read_to_string(landing_file(&f)).unwrap(), before);
}

#[test]
fn an_invalid_page_is_refused_with_actionable_problems_and_nothing_is_written() {
    let f = fixture("landing-invalid");
    let session = login_ok(&f);
    let bad = json!({"sections": [
        {"id": "x", "type": "html", "markup": "<script>alert(1)</script>"},
        {"id": "y", "type": "image", "src": "javascript:alert(1)", "alt": ""}
    ]});
    let (status, refused) = put(&f, &session, json!({"page": bad}));
    assert_eq!(status, 422, "{refused}");
    assert!(!refused["problems"].as_array().unwrap().is_empty());
    assert!(
        !refused.to_string().contains("alert(1)"),
        "bad input is not echoed back"
    );
    let (status, refused) = put(
        &f,
        &session,
        json!({"page": {"sections": [{"id": "y", "type": "image", "src": "javascript:x", "alt": ""}]}}),
    );
    assert_eq!(status, 422, "{refused}");
    assert!(!landing_file(&f).exists());
    for bad_body in [
        json!({"page": "text"}),
        json!({}),
        json!({"page": page(), "revision": 5}),
    ] {
        assert_eq!(put(&f, &session, bad_body).0, 400);
    }
    // A client cannot claim another version.
    let mut newer = page();
    newer["version"] = json!(9);
    let (status, saved) = put(&f, &session, json!({"page": newer}));
    assert_eq!(status, 201, "{saved}");
    assert!(fs::read_to_string(landing_file(&f))
        .unwrap()
        .contains("\"version\": 1"));
}

#[test]
fn an_oversized_request_is_rejected_before_it_is_read() {
    let f = fixture("landing-big");
    let session = login_ok(&f);
    let huge = "x".repeat(MAX_FILE_BYTES * 2 + 1);
    let (status, _) = put(&f, &session, json!({"page": {"sections": [], "pad": huge}}));
    assert_eq!(status, 413);
    // Under the request bound but over the file bound: refused as invalid.
    let big = "x".repeat(MAX_FILE_BYTES + 10);
    let (status, _) = put(&f, &session, json!({"page": {"sections": [], "pad": big}}));
    assert_eq!(status, 422);
    assert!(!landing_file(&f).exists());
}

#[test]
fn a_file_from_a_newer_release_reads_as_invalid_and_is_never_overwritten() {
    let f = fixture("landing-newer");
    let session = login_ok(&f);
    let newer = r#"{"format":"openblog-landing","version":3,"sections":[],"x":1}"#;
    fs::write(landing_file(&f), newer).unwrap();
    let (status, view) = get(&f, &session);
    assert_eq!(status, 200);
    assert_eq!(view["valid"], false);
    assert!(view["problems"][0]["message"]
        .as_str()
        .unwrap()
        .contains("newer"));
    let (status, refused) = put(
        &f,
        &session,
        json!({"page": page(), "revision": view["revision"]}),
    );
    assert_eq!(status, 409, "{refused}");
    assert_eq!(refused["newerVersion"], true);
    assert_eq!(fs::read_to_string(landing_file(&f)).unwrap(), newer);
}

fn preview(f: &Fixture, session: &(String, String), body: Json) -> (u16, Json) {
    source_call(f, session, "POST", "/admin/api/landing/preview", body)
}

fn preview_html(f: &Fixture, session: &(String, String), url: &str) -> String {
    let r = handle(&f.state, &authed(req("GET", url), session, false));
    assert_eq!(r.status, 200);
    String::from_utf8_lossy(&r.body).into_owned()
}

#[test]
fn a_preview_builds_the_home_page_from_unsaved_sections_and_writes_nothing() {
    let f = fixture("landing-preview");
    let session = login_ok(&f);
    // Not a route without a session or a CSRF token.
    assert_eq!(
        handle(&f.state, &req("POST", "/admin/api/landing/preview")).status,
        401
    );
    let no_csrf = handle(
        &f.state,
        &authed(
            json_req(
                "POST",
                "/admin/api/landing/preview",
                json!({"page": page()}),
            ),
            &session,
            false,
        ),
    );
    assert_eq!(no_csrf.status, 403);
    let before = fs::read_dir(f.dir.join("content")).unwrap().count();
    let (status, shown) = preview(
        &f,
        &session,
        json!({"page": {"sections": [
            {"id": "hi", "type": "welcome", "heading": "Preview heading <b>x</b>"},
            {"id": "gone", "type": "callout", "body": "Hidden note", "hidden": true}
        ]}}),
    );
    assert_eq!(status, 200, "{shown}");
    assert_eq!(shown["visible"], 1);
    let html = preview_html(&f, &session, shown["previewUrl"].as_str().unwrap());
    assert!(
        html.contains("Preview heading &lt;b&gt;x&lt;/b&gt;"),
        "{html}"
    );
    assert!(!html.contains("Hidden note"));
    assert!(html.contains("<base target=\"_blank\">"));
    // Nothing was saved: no landing file and no new file in the content folder.
    assert!(!landing_file(&f).exists());
    assert_eq!(fs::read_dir(f.dir.join("content")).unwrap().count(), before);
    assert_eq!(get(&f, &session).1["exists"], false);
}

#[test]
fn a_preview_refuses_an_invalid_page_with_the_same_problems_a_save_gives() {
    let f = fixture("landing-preview-invalid");
    let session = login_ok(&f);
    let (status, refused) = preview(
        &f,
        &session,
        json!({"page": {"sections": [{"id": "hi", "type": "welcome", "heading": ""}]}}),
    );
    assert_eq!(status, 422, "{refused}");
    assert_eq!(refused["problems"][0]["section"], "hi");
    assert!(!landing_file(&f).exists());
    let (status, _) = preview(&f, &session, json!({"nothing": true}));
    assert_eq!(status, 400);
}

#[test]
fn a_preview_does_not_change_a_stored_page() {
    let f = fixture("landing-preview-stored");
    let session = login_ok(&f);
    let (_, saved) = put(&f, &session, json!({"page": page()}));
    let bytes = fs::read(landing_file(&f)).unwrap();
    let (status, shown) = preview(
        &f,
        &session,
        json!({"page": {"sections": [{"id": "x", "type": "series", "heading": "Other"}]}}),
    );
    assert_eq!(status, 200);
    let html = preview_html(&f, &session, shown["previewUrl"].as_str().unwrap());
    assert!(!html.contains("Welcome in"));
    assert_eq!(fs::read(landing_file(&f)).unwrap(), bytes);
    assert_eq!(get(&f, &session).1["revision"], saved["revision"]);
}

#[test]
fn a_save_rebuilds_the_served_site_and_a_preview_does_not() {
    let f = fixture("landing-rebuild");
    let session = login_ok(&f);
    let home = f.dir.join("dist/index.html");
    let (status, _) = preview(
        &f,
        &session,
        json!({"page": {"sections": [{"id": "p", "type": "series", "heading": "Previewed only"}]}}),
    );
    assert_eq!(status, 200);
    let after_preview = fs::read_to_string(&home).unwrap_or_default();
    assert!(!after_preview.contains("Previewed only"));
    let (status, saved) = put(&f, &session, json!({"page": page()}));
    assert_eq!(status, 201, "{saved}");
    assert_eq!(saved["build"]["ok"], true, "{saved}");
    assert!(fs::read_to_string(&home).unwrap().contains("Welcome in"));
}
