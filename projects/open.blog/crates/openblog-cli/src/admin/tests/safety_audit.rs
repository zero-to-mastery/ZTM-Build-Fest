//! The landing, look and piece routes under one audit (ADR 0263, #336): every route denies by
//! default, writes need the CSRF token and a same-origin request, every body is bounded before it
//! is read, hostile and malformed payloads fail without a partial write, and errors repeat nothing
//! the caller sent. The single Admin role is the existing policy: a signed-in owner may change the
//! page; there is no second role to grant.

use super::*;
use openblog_core::landing::MAX_FILE_BYTES;

/// Every route this story's features add, as (method, path, writes).
const ROUTES: &[(&str, &str, bool)] = &[
    ("GET", "/admin/api/landing", false),
    ("PUT", "/admin/api/landing", true),
    ("POST", "/admin/api/landing/preview", true),
    ("GET", "/admin/api/landing/history", false),
    ("GET", "/admin/api/landing/history/item", false),
    ("POST", "/admin/api/landing/history/restore", true),
    ("GET", "/admin/api/business", false),
    ("PUT", "/admin/api/business", true),
    ("GET", "/admin/api/look", false),
    ("PUT", "/admin/api/look", true),
    ("POST", "/admin/api/look/preview", true),
    ("POST", "/admin/api/pieces", true),
];

fn landing_file(f: &Fixture) -> PathBuf {
    f.dir.join("content/landing.json")
}

fn page() -> Json {
    json!({"sections": [{"id": "hello", "type": "welcome", "heading": "Hello"}]})
}

#[test]
fn every_route_denies_by_default_and_a_write_needs_a_session_the_csrf_token_and_the_same_origin() {
    let f = fixture("audit-auth");
    let session = login_ok(&f);
    for &(method, path, writes) in ROUTES {
        // Not signed in: refused before anything else, with no body read.
        assert_eq!(
            handle(&f.state, &json_req(method, path, json!({}))).status,
            401,
            "{method} {path} without a session"
        );
        assert!(
            preflight(&f.state, &req(method, path)).is_err(),
            "{method} {path} is refused before its body is buffered"
        );
        if !writes {
            continue;
        }
        // Signed in without the CSRF token, with a forged one, from another origin or site.
        let no_token = authed(json_req(method, path, json!({})), &session, false);
        assert_eq!(
            handle(&f.state, &no_token).status,
            403,
            "{method} {path} no token"
        );
        let mut forged = authed(json_req(method, path, json!({})), &session, false);
        forged.headers.insert("x-csrf-token".into(), "nope".into());
        assert_eq!(
            handle(&f.state, &forged).status,
            403,
            "{method} {path} forged"
        );
        let mut cross = authed(json_req(method, path, json!({})), &session, true);
        cross
            .headers
            .insert("origin".into(), "https://evil.example".into());
        assert_eq!(
            handle(&f.state, &cross).status,
            403,
            "{method} {path} cross-origin"
        );
        let mut site = authed(json_req(method, path, json!({})), &session, true);
        site.headers
            .insert("sec-fetch-site".into(), "cross-site".into());
        assert_eq!(
            handle(&f.state, &site).status,
            403,
            "{method} {path} cross-site"
        );
        // A write must say it is JSON.
        let plain = authed(req(method, path), &session, true);
        assert_eq!(
            handle(&f.state, &plain).status,
            415,
            "{method} {path} not JSON"
        );
    }
    // Other verbs are not routes (deny by default).
    for path in [
        "landing",
        "landing/preview",
        "landing/history",
        "landing/history/restore",
        "business",
        "look",
        "look/preview",
        "pieces",
    ] {
        for method in ["PATCH", "DELETE", "TRACE"] {
            let r = handle(
                &f.state,
                &authed(
                    json_req(method, &format!("/admin/api/{path}"), json!({})),
                    &session,
                    true,
                ),
            );
            assert!(
                r.status == 404 || r.status == 405,
                "{method} {path}: {}",
                r.status
            );
        }
    }
    assert!(
        !landing_file(&f).exists(),
        "nothing was written by any refused request"
    );
}

#[test]
fn every_body_is_bounded_before_it_is_read() {
    let f = fixture("audit-bounds");
    let session = login_ok(&f);
    for (path, limit) in [
        ("/admin/api/landing", landing::MAX_REQUEST_BYTES),
        ("/admin/api/landing/preview", landing::MAX_REQUEST_BYTES),
        (
            "/admin/api/landing/history/restore",
            landing::MAX_RESTORE_BYTES,
        ),
        ("/admin/api/business", business::MAX_REQUEST_BYTES),
        ("/admin/api/look", look::MAX_REQUEST_BYTES),
        ("/admin/api/look/preview", look::MAX_REQUEST_BYTES),
        ("/admin/api/pieces", MAX_PIECE_REQUEST_BYTES),
    ] {
        let allowed = preflight(&f.state, &authed(req("PUT", path), &session, true)).unwrap();
        assert_eq!(allowed, limit, "{path}");
        assert!(
            allowed <= 512 * 1024,
            "{path} may not buffer a general-purpose body"
        );
    }
    // The handlers check again, for a body that reached them some other way.
    let big = "x".repeat(MAX_PIECE_REQUEST_BYTES + 1);
    let r = handle(
        &f.state,
        &authed(
            json_req(
                "POST",
                "/admin/api/pieces",
                json!({"kind": "button", "values": [["label", big]]}),
            ),
            &session,
            true,
        ),
    );
    assert_eq!(r.status, 413);
    let many: Vec<Json> = (0..=MAX_PIECE_VALUES)
        .map(|i| json!([format!("f{i}"), "x"]))
        .collect();
    let r = handle(
        &f.state,
        &authed(
            json_req(
                "POST",
                "/admin/api/pieces",
                json!({"kind": "button", "values": many}),
            ),
            &session,
            true,
        ),
    );
    assert_eq!(r.status, 413);
    for path in ["/admin/api/landing", "/admin/api/landing/preview"] {
        let method = if path.ends_with("preview") {
            "POST"
        } else {
            "PUT"
        };
        let r = handle(
            &f.state,
            &authed(
                json_req(
                    method,
                    path,
                    json!({"page": {"sections": [], "pad": "x".repeat(landing::MAX_REQUEST_BYTES)}}),
                ),
                &session,
                true,
            ),
        );
        assert_eq!(r.status, 413, "{path}");
    }
    assert!(!landing_file(&f).exists());
}

#[test]
fn unknown_malformed_and_hostile_payloads_fail_without_a_partial_write_or_an_echo() {
    let f = fixture("audit-payloads");
    let session = login_ok(&f);
    let put = |body: Json| source_call(&f, &session, "PUT", "/admin/api/landing", body);
    let (status, created) = put(json!({"page": page()}));
    assert_eq!(status, 201, "{created}");
    let before = fs::read_to_string(landing_file(&f)).unwrap();
    let revision = created["revision"].clone();
    let hostile = "<script>alert(\"SECRET-MARKER\")</script>";
    let cases = [
        // An unknown section type next to a good section writes neither.
        json!({"revision": revision, "page": {"sections": [
            {"id": "ok", "type": "welcome", "heading": "Fine"},
            {"id": "bad", "type": "html", "markup": hostile}
        ]}}),
        json!({"revision": revision, "page": {"sections": [{"id": hostile, "type": "welcome", "heading": "x"}]}}),
        json!({"revision": revision, "page": {"sections": "not a list"}}),
        json!({"revision": revision, "page": {"sections": [7, null, [], hostile]}}),
        json!({"revision": revision, "page": {"sections": [{"id": "a", "type": ["welcome"]}]}}),
        json!({"revision": revision, "page": [hostile]}),
        json!({"revision": revision, "page": hostile}),
        json!({"revision": [hostile], "page": page()}),
    ];
    for body in cases {
        let (status, answer) = put(body.clone());
        assert!(
            status == 422 || status == 400,
            "{status} for {body}: {answer}"
        );
        assert!(
            !answer.to_string().contains("SECRET-MARKER"),
            "a refusal repeated the payload: {answer}"
        );
        assert_eq!(
            fs::read_to_string(landing_file(&f)).unwrap(),
            before,
            "partial write for {body}"
        );
    }
    // Not JSON, not UTF-8, and nested far deeper than any page.
    for raw in [
        b"{ not json".to_vec(),
        vec![0xff, 0xfe, 0xfd],
        format!("{}1{}", "[".repeat(5000), "]".repeat(5000)).into_bytes(),
    ] {
        let mut r = authed(
            json_req("PUT", "/admin/api/landing", json!({})),
            &session,
            true,
        );
        r.body = raw;
        let answer = handle(&f.state, &r);
        assert_eq!(
            answer.status,
            400,
            "{}",
            String::from_utf8_lossy(&answer.body)
        );
        assert_eq!(fs::read_to_string(landing_file(&f)).unwrap(), before);
    }
    // A preview of a bad page builds nothing and writes nothing.
    let (status, answer) = source_call(
        &f,
        &session,
        "POST",
        "/admin/api/landing/preview",
        json!({"page": {"sections": [{"id": "bad", "type": "html", "markup": hostile}]}}),
    );
    assert_eq!(status, 422);
    assert!(!answer.to_string().contains("SECRET-MARKER"));
    assert_eq!(fs::read_to_string(landing_file(&f)).unwrap(), before);
    // A piece the engine refuses says what to fix without repeating what was sent.
    let (status, answer) = source_call(
        &f,
        &session,
        "POST",
        "/admin/api/pieces",
        json!({"kind": "button", "values": [["label", hostile], ["href", "javascript:alert(1)"]]}),
    );
    assert_eq!(status, 422);
    assert!(!answer.to_string().contains("SECRET-MARKER"), "{answer}");
    let (status, _) = source_call(
        &f,
        &session,
        "POST",
        "/admin/api/pieces",
        json!({"kind": hostile, "values": []}),
    );
    assert!(status == 422 || status == 400);
}

#[test]
fn a_look_with_markup_or_css_is_refused_and_changes_nothing() {
    let f = fixture("audit-look");
    let session = login_ok(&f);
    let config_before = fs::read_to_string(f.dir.join("openblog.json")).unwrap();
    let read = handle(
        &f.state,
        &authed(req("GET", "/admin/api/look"), &session, false),
    );
    let etag = body_json(&read)["etag"].clone();
    for look in [
        json!({"accent": "red;} body{display:none}"}),
        json!({"accent": "url(javascript:alert(1))"}),
        json!({"fontStyle": "Arial; background:url(x)"}),
        json!({"palette": "<style>x</style>"}),
        json!({"textSize": {"nested": "<script>"}}),
    ] {
        let (status, answer) = source_call(
            &f,
            &session,
            "PUT",
            "/admin/api/look",
            json!({"etag": etag, "look": look}),
        );
        assert!(status == 400 || status == 422, "{status}: {look} {answer}");
        for echoed in [
            "display:none",
            "background:url",
            "<style>",
            "<script>",
            "javascript:",
        ] {
            assert!(
                !answer.to_string().contains(echoed),
                "a refusal repeated {echoed}: {answer}"
            );
        }
        assert_eq!(
            fs::read_to_string(f.dir.join("openblog.json")).unwrap(),
            config_before
        );
    }
    // A field this release does not know is kept for a newer one (ADR 0248) but is never compiled:
    // no stylesheet holds it.
    let (status, answer) = source_call(
        &f,
        &session,
        "PUT",
        "/admin/api/look",
        json!({"etag": etag, "look": {"roundness": "round", "css": "body{display:none}", "font": "x;y"}}),
    );
    assert_eq!(status, 200, "{answer}");
    let tokens = fs::read_to_string(f.dir.join("dist/themes/base/tokens.css")).unwrap();
    assert!(
        !tokens.contains("display:none") && !tokens.contains("x;y"),
        "{tokens}"
    );
}

#[test]
fn the_page_size_bound_is_the_documented_one() {
    // The request bound leaves room for the wrapper around a page and no more.
    assert_eq!(landing::MAX_REQUEST_BYTES, MAX_FILE_BYTES * 2);
    const { assert!(look::MAX_REQUEST_BYTES <= 4 * 1024) };
}
