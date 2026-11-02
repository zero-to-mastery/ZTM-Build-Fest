//! Admin social announcement routes (ADR 0309, story #356): deny by default, the session and CSRF
//! seams, off unless configured, the site (not the browser) decides what is announced and where it
//! links, the hosted function is called with the admin key and the signed-in user, and nothing
//! secret or foreign reaches the browser. The hosted function is a fake here, plus one real
//! loopback server that proves the wire request.

use super::*;
use crate::admin::announcements::{self as social, Call, Hosted};
use std::sync::Mutex as StdMutex;

const KEY: &str = "adm_socialroutes11111111111111111111111111";
const ACCOUNT: &str = "11111111-1111-4111-8111-111111111111";
const ANNOUNCEMENT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

fn social_site(tag: &str) -> Fixture {
    let f = fixture(&format!("social-{tag}"));
    fs::write(
        f.dir.join("openblog.json"),
        r#"{"title":"Lantern","url":"https://blog.example.org"}"#,
    )
    .unwrap();
    let posts = [
        ("2026-01-02-hello", "title: Hello\ndate: 2026-01-02\n"),
        (
            "2026-01-03-secret",
            "title: SECRET-DRAFT-TITLE\ndate: 2026-01-03\ndraft: true\n",
        ),
        ("2099-01-01-later", "title: Later\ndate: 2099-01-01\n"),
        (
            "2026-01-04-away",
            "title: Away\ndate: 2026-01-04\ncanonical: https://dev.to/me/away\n",
        ),
    ];
    for (name, front) in posts {
        fs::write(
            f.dir.join("content/posts").join(format!("{name}.md")),
            format!("---\n{front}---\nBody.\n"),
        )
        .unwrap();
    }
    f
}

fn hosted() -> Hosted {
    Hosted::new("https://blog.example.org/.netlify/functions/social", KEY).unwrap()
}

type Calls = StdMutex<Vec<(String, String, Vec<(String, String)>, String, Option<Json>)>>;

/// A fake hosted function that records what it was asked and answers `reply`.
fn fake(
    calls: &Calls,
    status: u16,
    reply: Json,
) -> impl Fn(&Call) -> Result<(u16, Json), &'static str> + '_ {
    move |call: &Call| {
        calls.lock().unwrap().push((
            call.method.to_string(),
            call.route.clone(),
            call.query.clone(),
            call.actor.clone(),
            call.body.clone(),
        ));
        Ok((status, reply.clone()))
    }
}

fn call(
    f: &Fixture,
    transport: &dyn social::Transport,
    method: &str,
    path: &str,
    body: Option<Json>,
) -> (u16, Json) {
    let name = path
        .strip_prefix("/admin/api/social/")
        .unwrap()
        .split('?')
        .next()
        .unwrap();
    let request = match body {
        Some(body) => json_req(method, path, body),
        None => req(method, path),
    };
    let response = social::route(
        &f.state,
        &request,
        "mikey",
        name,
        Some(&hosted()),
        transport,
    );
    (response.status, body_json(&response))
}

/// A moment `days` ahead of the Admin's clock, written in a zone `offset` hours from UTC, and the
/// same instant in UTC.
fn when(days: i64, offset: i64) -> (String, String) {
    let at = clock::now().unix() + days * 86_400;
    let utc = DateTime::from_unix(at).rfc3339();
    let shifted = DateTime::from_unix(at + offset * 3600).rfc3339();
    let local = format!(
        "{}{}{:02}:00",
        shifted.trim_end_matches('Z'),
        if offset < 0 { "-" } else { "+" },
        offset.abs()
    );
    (local, utc)
}

fn draft(overrides: Json) -> Json {
    let mut body = json!({
        "accountId": ACCOUNT,
        "work": "/posts/hello/",
        "caption": "A new post is live.",
        "scheduledFor": when(3, 2).0,
        "timeZone": "Europe/Athens",
        "idempotencyKey": "composer-key-0000001",
    });
    for (name, value) in overrides.as_object().unwrap() {
        body[name] = value.clone();
    }
    body
}

fn announcement() -> Json {
    json!({"id": ANNOUNCEMENT, "status": "scheduled", "version": 1, "caption": "A new post is live."})
}

#[test]
fn every_route_needs_a_session_and_every_write_a_csrf_token() {
    let f = social_site("auth");
    let routes = [
        ("GET", "status"),
        ("GET", "posts"),
        ("POST", "preview"),
        ("GET", "destinations"),
        ("GET", "announcements"),
        ("POST", "announcements"),
        ("PATCH", "announcements"),
        ("POST", "announcements/reschedule"),
        ("POST", "announcements/cancel"),
        ("POST", "announcements/retry"),
        ("POST", "announcements/resolve"),
        ("GET", "announcements/attempts"),
    ];
    for (method, name) in routes {
        let path = format!("/admin/api/social/{name}");
        assert_eq!(
            handle(&f.state, &req(method, &path)).status,
            401,
            "{method} {path}"
        );
    }
    let session = login_ok(&f);
    for (method, name) in routes.iter().filter(|(method, _)| *method != "GET") {
        let path = format!("/admin/api/social/{name}");
        let without = handle(
            &f.state,
            &authed(json_req(method, &path, json!({})), &session, false),
        );
        assert_eq!(without.status, 403, "{method} {path} without a CSRF token");
    }
}

#[test]
fn the_feature_does_not_exist_until_it_is_configured() {
    let f = social_site("off");
    let session = login_ok(&f);
    // The environment of a test process sets none of the social settings.
    let status = handle(
        &f.state,
        &authed(req("GET", "/admin/api/social/status"), &session, false),
    );
    assert_eq!(status.status, 200);
    assert_eq!(body_json(&status)["enabled"], false);
    for (method, name) in [
        ("GET", "posts"),
        ("GET", "destinations"),
        ("GET", "announcements"),
        ("POST", "announcements"),
    ] {
        let response = handle(
            &f.state,
            &authed(
                json_req(
                    method,
                    &format!("/admin/api/social/{name}"),
                    draft(json!({})),
                ),
                &session,
                true,
            ),
        );
        assert_eq!(response.status, 404, "{method} {name}");
        assert!(!String::from_utf8_lossy(&response.body).contains(KEY));
    }
    // Half set is off: a short key, an insecure remote endpoint, a credentialed endpoint.
    assert!(Hosted::new("https://x.example.org/f", "short").is_none());
    assert!(Hosted::new("http://x.example.org/f", KEY).is_none());
    assert!(Hosted::new("https://user:pw@x.example.org/f", KEY).is_none());
    assert!(Hosted::new("https://x.example.org/f?key=1", KEY).is_none());
    assert!(Hosted::new("http://127.0.0.1:8888/f", KEY).is_some());
}

#[test]
fn the_composer_lists_posts_with_the_reason_a_post_cannot_be_announced() {
    let f = social_site("posts");
    let calls = Calls::default();
    let (status, body) = call(
        &f,
        &fake(&calls, 200, json!({})),
        "GET",
        "/admin/api/social/posts",
        None,
    );
    assert_eq!(status, 200);
    let posts = body["posts"].as_array().unwrap();
    let find = |title: &str| posts.iter().find(|p| p["title"] == title).unwrap();
    assert_eq!(find("Hello")["eligible"], true);
    assert_eq!(
        find("Hello")["canonicalUrl"],
        "https://blog.example.org/posts/hello/"
    );
    assert_eq!(
        find("SECRET-DRAFT-TITLE")["reason"]["code"],
        "post-not-published"
    );
    assert_eq!(find("Later")["reason"]["code"], "post-not-yet-public");
    assert_eq!(find("Away")["reason"]["code"], "canonical-elsewhere");
    assert!(
        calls.lock().unwrap().is_empty(),
        "listing posts never calls the hosted function"
    );
}

#[test]
fn a_preview_reports_every_problem_at_once_and_stores_nothing() {
    let f = social_site("preview");
    let calls = Calls::default();
    let (local, utc) = when(3, 2);
    let ok = call(
        &f,
        &fake(&calls, 200, json!({})),
        "POST",
        "/admin/api/social/preview",
        Some(
            json!({"provider": "linkedin", "caption": "  Hello  ", "work": "/posts/hello/",
            "scheduledFor": local, "timeZone": "Europe/Athens"}),
        ),
    );
    assert_eq!(ok.0, 200);
    assert_eq!(ok.1["ok"], true);
    assert_eq!(ok.1["caption"], "Hello");
    assert_eq!(ok.1["characters"], 5);
    assert_eq!(ok.1["limit"], 3000);
    assert_eq!(ok.1["scheduledFor"], utc.as_str());
    assert_eq!(ok.1["link"], "https://blog.example.org/posts/hello/");
    let bad = call(
        &f,
        &fake(&calls, 200, json!({})),
        "POST",
        "/admin/api/social/preview",
        Some(
            json!({"provider": "threads", "caption": "x", "work": "/posts/2099/",
            "scheduledFor": "2020-01-01T00:00:00Z", "timeZone": "../x"}),
        ),
    );
    assert_eq!(bad.1["ok"], false);
    let fields: Vec<&str> = bad.1["problems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["field"].as_str().unwrap())
        .collect();
    assert_eq!(fields, ["destination", "scheduledFor", "timeZone", "work"]);
    let long = call(
        &f,
        &fake(&calls, 200, json!({})),
        "POST",
        "/admin/api/social/preview",
        Some(json!({"provider": "facebook", "caption": "a".repeat(3001)})),
    );
    assert_eq!(long.1["problems"][0]["code"], "caption-too-long");
    assert_eq!(long.1["characters"], 3001);
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn a_create_is_checked_against_the_site_then_sent_with_the_actor_and_the_sites_own_address() {
    let f = social_site("create");
    let calls = Calls::default();
    let transport = fake(
        &calls,
        201,
        json!({"announcement": announcement(), "replayed": false, "leak": KEY}),
    );
    let (local, utc) = when(3, 2);
    let (status, body) = call(
        &f,
        &transport,
        "POST",
        "/admin/api/social/announcements",
        Some(draft(json!({"scheduledFor": local}))),
    );
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["announcement"]["id"], ANNOUNCEMENT);
    assert!(
        body.get("leak").is_none(),
        "only the allow-listed fields reach the browser"
    );
    let recorded = calls.lock().unwrap();
    assert_eq!(recorded.len(), 1);
    let (method, route, _, actor, sent) = &recorded[0];
    assert_eq!(
        (method.as_str(), route.as_str(), actor.as_str()),
        ("POST", "announcements", "mikey")
    );
    let sent = sent.as_ref().unwrap();
    assert_eq!(
        sent["canonicalUrl"],
        "https://blog.example.org/posts/hello/"
    );
    assert_eq!(sent["scheduledFor"], utc.as_str(), "sent as UTC");
    assert_eq!(sent["accountId"], ACCOUNT);
    assert!(sent.get("site_id").is_none() && sent.get("siteId").is_none());
}

#[test]
fn a_site_under_a_folder_lists_previews_and_creates_by_the_site_relative_path() {
    let f = social_site("folder");
    fs::write(
        f.dir.join("openblog.json"),
        r#"{"title":"Lantern","url":"https://user.github.io/blog"}"#,
    )
    .unwrap();
    let calls = Calls::default();
    let transport = fake(&calls, 201, json!({"announcement": announcement()}));
    let (_, listed) = call(&f, &transport, "GET", "/admin/api/social/posts", None);
    let hello = listed["posts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["title"] == "Hello")
        .unwrap();
    assert_eq!(hello["work"], "/posts/hello/");
    assert_eq!(
        hello["canonicalUrl"],
        "https://user.github.io/blog/posts/hello/"
    );
    let (status, body) = call(
        &f,
        &transport,
        "POST",
        "/admin/api/social/announcements",
        Some(draft(json!({"work": hello["work"]}))),
    );
    assert_eq!(status, 201, "{body}");
    let recorded = calls.lock().unwrap();
    let sent = recorded[0].4.as_ref().unwrap();
    assert_eq!(sent["work"], "/posts/hello/");
    assert_eq!(
        sent["canonicalUrl"],
        "https://user.github.io/blog/posts/hello/"
    );
}

#[test]
fn a_retry_whose_time_has_come_close_still_reaches_the_hosted_function() {
    let f = social_site("retry");
    let calls = Calls::default();
    let transport = fake(
        &calls,
        200,
        json!({"announcement": announcement(), "replayed": true}),
    );
    let soon = DateTime::from_unix(clock::now().unix() + 10).rfc3339();
    let (status, body) = call(
        &f,
        &transport,
        "POST",
        "/admin/api/social/announcements",
        Some(draft(json!({"scheduledFor": soon}))),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        calls.lock().unwrap().len(),
        1,
        "the hosted function decides"
    );
    // A time that is not a time at all is still refused here.
    let (status, _) = call(
        &f,
        &transport,
        "POST",
        "/admin/api/social/announcements",
        Some(draft(json!({"scheduledFor": "tomorrow"}))),
    );
    assert_eq!(status, 422);
}

#[test]
fn a_create_the_site_cannot_stand_behind_never_reaches_the_hosted_function() {
    let f = social_site("refuse");
    let calls = Calls::default();
    let transport = fake(&calls, 201, json!({"announcement": announcement()}));
    let code = |overrides: Json| {
        let (status, body) = call(
            &f,
            &transport,
            "POST",
            "/admin/api/social/announcements",
            Some(draft(overrides)),
        );
        (status, body["code"].as_str().unwrap_or("").to_string())
    };
    assert_eq!(
        code(json!({"work": "/posts/secret/"})),
        (422, "post-not-published".into())
    );
    assert_eq!(
        code(json!({"work": "/posts/later/"})),
        (422, "post-not-yet-public".into())
    );
    assert_eq!(
        code(json!({"work": "/posts/away/"})),
        (422, "canonical-elsewhere".into())
    );
    assert_eq!(
        code(json!({"work": "/posts/missing/"})),
        (422, "post-not-published".into())
    );
    assert_eq!(code(json!({"caption": " "})), (422, "caption-empty".into()));
    assert_eq!(
        code(json!({"caption": "a".repeat(3001)})),
        (422, "caption-too-long".into())
    );
    assert_eq!(
        code(json!({"scheduledFor": "2099-01-01T10:00:00"})),
        (422, "time-needs-zone".into())
    );
    assert_eq!(
        code(json!({"idempotencyKey": "x"})),
        (422, "key-invalid".into())
    );
    assert_eq!(
        code(json!({"timeZone": "a b"})),
        (422, "time-zone-invalid".into())
    );
    // A browser may not choose the link, the site, the status or any other field.
    for field in ["canonicalUrl", "siteId", "site_id", "status", "createdBy"] {
        assert_eq!(
            code(json!({ field: "https://evil.example/" })).0,
            400,
            "{field}"
        );
    }
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn edits_reschedules_and_cancels_name_the_version_and_the_announcement() {
    let f = social_site("change");
    let calls = Calls::default();
    let transport = fake(&calls, 200, json!({"announcement": announcement()}));
    let id_path = |tail: &str| format!("/admin/api/social/{tail}?id={ANNOUNCEMENT}");
    let (edit_local, edit_utc) = when(5, 0);
    let (move_local, move_utc) = when(6, -5);

    let (s, _) = call(
        &f,
        &transport,
        "PATCH",
        &id_path("announcements"),
        Some(json!({"version": 1, "caption": " New words ", "scheduledFor": edit_local})),
    );
    assert_eq!(s, 200);
    let (s, _) = call(
        &f,
        &transport,
        "POST",
        &id_path("announcements/reschedule"),
        Some(json!({"version": 2, "scheduledFor": move_local})),
    );
    assert_eq!(s, 200);
    let (s, _) = call(
        &f,
        &transport,
        "POST",
        &id_path("announcements/cancel"),
        Some(json!({"version": 3})),
    );
    assert_eq!(s, 200);

    let recorded = calls.lock().unwrap();
    assert_eq!(recorded[0].0, "PATCH");
    assert_eq!(
        recorded[0].2,
        vec![("id".to_string(), ANNOUNCEMENT.to_string())]
    );
    assert_eq!(recorded[0].4.as_ref().unwrap()["caption"], "New words");
    assert_eq!(recorded[0].4.as_ref().unwrap()["version"], 1);
    assert_eq!(
        recorded[0].4.as_ref().unwrap()["scheduledFor"],
        edit_utc.as_str()
    );
    assert_eq!(recorded[1].1, "announcements/reschedule");
    assert_eq!(
        recorded[1].4.as_ref().unwrap()["scheduledFor"],
        move_utc.as_str()
    );
    assert_eq!(recorded[2].1, "announcements/cancel");
    assert_eq!(recorded[2].4, Some(json!({"version": 3})));
    drop(recorded);

    let n = calls.lock().unwrap().len();
    for (method, tail, body) in [
        ("PATCH", "announcements", json!({"version": 1})),
        (
            "PATCH",
            "announcements",
            json!({"version": 1, "caption": "x", "status": "published"}),
        ),
        ("PATCH", "announcements", json!({"caption": "x"})),
        (
            "POST",
            "announcements/reschedule",
            json!({"version": 1, "scheduledFor": "tomorrow"}),
        ),
        (
            "POST",
            "announcements/reschedule",
            json!({"version": 1, "scheduledFor": when(4, 0).0, "caption": "x"}),
        ),
        ("POST", "announcements/cancel", json!({"version": "1"})),
        (
            "POST",
            "announcements/cancel",
            json!({"version": 1, "siteId": "other"}),
        ),
    ] {
        let (s, _) = call(&f, &transport, method, &id_path(tail), Some(body.clone()));
        assert!(s == 400 || s == 422, "{method} {tail} {body}: {s}");
    }
    for bad in ["x", "AAAAAAAA-AAAA-4AAA-8AAA-000000000001", "../../etc"] {
        let path = format!("/admin/api/social/announcements/cancel?id={bad}");
        let (s, b) = call(&f, &transport, "POST", &path, Some(json!({"version": 1})));
        assert_eq!((s, b["code"].as_str()), (400, Some("invalid-id")), "{bad}");
    }
    assert_eq!(calls.lock().unwrap().len(), n, "nothing refused was sent");
}

#[test]
fn the_list_passes_only_known_filters() {
    let f = social_site("list");
    let calls = Calls::default();
    let transport = fake(&calls, 200, json!({"announcements": []}));
    let (s, b) = call(
        &f,
        &transport,
        "GET",
        "/admin/api/social/announcements?status=scheduled&limit=20&site_id=other&x=1",
        None,
    );
    assert_eq!((s, b["announcements"].clone()), (200, json!([])));
    let recorded = calls.lock().unwrap();
    let mut query = recorded[0].2.clone();
    query.sort();
    assert_eq!(
        query,
        vec![
            ("limit".into(), "20".into()),
            ("status".into(), "scheduled".into())
        ]
    );
}

#[test]
fn hosted_answers_become_useful_errors_and_never_a_session_or_secret_problem() {
    let f = social_site("answers");
    let calls = Calls::default();
    let post = |status: u16, reply: Json| {
        call(
            &f,
            &fake(&calls, status, reply),
            "POST",
            "/admin/api/social/announcements",
            Some(draft(json!({}))),
        )
    };
    // The function's own refusals keep their code and message, and the version to reload from.
    let (s, b) = post(
        409,
        json!({"error": "This announcement changed since you opened it.", "code": "stale", "version": 4, "claimed_by": "@worker"}),
    );
    assert_eq!(
        (s, b["code"].clone(), b["version"].clone()),
        (409, json!("stale"), json!(4))
    );
    assert!(b.get("claimed_by").is_none());
    let (s, b) = post(
        404,
        json!({"error": "That destination is not connected to this site.", "code": "destination-not-found"}),
    );
    assert_eq!(
        (s, b["code"].clone()),
        (404, json!("destination-not-found"))
    );
    // A rejected key is a setup problem, shown as a 502: a 401 would look like an expired session.
    for rejected in [401, 403] {
        let (s, b) = post(rejected, json!({"error": "Not authorized."}));
        assert_eq!((s, b["code"].clone()), (502, json!("hosted-key-rejected")));
        assert!(!b.to_string().contains(KEY));
    }
    // A disabled function answers a bare 404.
    let (s, b) = post(404, json!({"error": "Not found."}));
    assert_eq!((s, b["code"].clone()), (502, json!("hosted-unavailable")));
    // A failure keeps what the function said to itself, including anything that looks like a secret.
    let (s, b) = post(
        500,
        json!({"error": format!("boom {KEY}"), "code": "internal"}),
    );
    assert_eq!((s, b["code"].clone()), (502, json!("hosted-failed")));
    assert!(!b.to_string().contains(KEY));
    let (s, b) = post(
        409,
        json!({"error": format!("<script>{KEY}"), "code": "conflict"}),
    );
    assert_eq!(
        (s, b["error"].clone()),
        (409, json!("The request was refused."))
    );
    // An unexpected success is not passed on as one.
    let (s, _) = post(200, json!({"surprise": true}));
    assert_eq!(s, 502);
    // An unreachable function is a fixed message.
    let down = |_: &Call| {
        Err::<(u16, Json), &'static str>("The hosted social function could not be reached.")
    };
    let (s, b) = call(&f, &down, "GET", "/admin/api/social/destinations", None);
    assert_eq!(
        (s, b["error"].as_str()),
        (
            502,
            Some("The hosted social function could not be reached.")
        )
    );
}

/// One real HTTP exchange on the loopback interface, to prove the wire request: the admin key as a
/// bearer, the signed-in user as the actor, the route, the query and a JSON body.
#[test]
fn the_wire_request_carries_the_admin_key_and_the_actor_and_nothing_else_secret() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let mut stream = accept_provider_call(&listener);
        stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
        let mut request = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = stream.read(&mut chunk).unwrap_or(0);
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&request[..end]).to_lowercase();
                let length = head
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
        }
        let body = r#"{"announcement":{"id":"x"},"replayed":false}"#;
        let response = format!(
            "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).unwrap();
        String::from_utf8_lossy(&request).to_string()
    });
    let f = social_site("wire");
    let endpoint = format!("http://{address}/social");
    let hosted = Hosted::new(&endpoint, KEY).unwrap();
    let request = json_req("POST", "/admin/api/social/announcements", draft(json!({})));
    let response = social::route_with_hosted(&f.state, &request, "mikey", "announcements", &hosted);
    assert_eq!(
        response.status,
        201,
        "{}",
        String::from_utf8_lossy(&response.body)
    );
    let seen = server.join().unwrap();
    let lower = seen.to_lowercase();
    assert!(
        seen.starts_with("POST /social/announcements HTTP/1.1"),
        "{seen}"
    );
    assert!(lower.contains(&format!("authorization: bearer {}", KEY.to_lowercase())));
    assert!(lower.contains("x-openblog-actor: mikey"));
    assert!(seen.contains("\"canonicalUrl\":\"https://blog.example.org/posts/hello/\""));
    assert!(
        !seen.contains("csrf") && !lower.contains("cookie"),
        "the browser's session never travels on"
    );
}

#[test]
fn recovery_routes_relay_only_what_they_check() {
    let f = social_site("recovery");
    let calls = Calls::default();
    let transport = fake(&calls, 200, json!({"announcement": announcement()}));
    let id_path = |tail: &str| format!("/admin/api/social/{tail}?id={ANNOUNCEMENT}");

    let (s, _) = call(
        &f,
        &transport,
        "POST",
        &id_path("announcements/retry"),
        Some(json!({"version": 4})),
    );
    assert_eq!(s, 200);
    let (s, _) = call(
        &f,
        &transport,
        "POST",
        &id_path("announcements/resolve"),
        Some(json!({"version": 3, "outcome": "published", "providerPostId": "urn:li:share:7"})),
    );
    assert_eq!(s, 200);
    let (s, _) = call(
        &f,
        &transport,
        "POST",
        &id_path("announcements/resolve"),
        Some(json!({"version": 3, "outcome": "not-posted"})),
    );
    assert_eq!(s, 200);
    let attempts = fake(
        &calls,
        200,
        json!({"attempts": [{"attemptNo": 1}], "extra": "dropped"}),
    );
    let (s, b) = call(
        &f,
        &attempts,
        "GET",
        &id_path("announcements/attempts"),
        None,
    );
    assert_eq!(s, 200);
    assert_eq!(b["attempts"][0]["attemptNo"], 1);
    assert!(b.get("extra").is_none());

    let recorded = calls.lock().unwrap();
    assert_eq!(recorded[0].1, "announcements/retry");
    assert_eq!(recorded[0].4, Some(json!({"version": 4})));
    assert_eq!(
        recorded[1].4,
        Some(json!({"version": 3, "outcome": "published", "providerPostId": "urn:li:share:7"}))
    );
    assert_eq!(
        recorded[2].4,
        Some(json!({"version": 3, "outcome": "not-posted"}))
    );
    assert_eq!(recorded[3].0, "GET");
    assert_eq!(recorded[3].3, "mikey");
    drop(recorded);

    let n = calls.lock().unwrap().len();
    for (tail, body) in [
        (
            "announcements/retry",
            json!({"version": 1, "status": "scheduled"}),
        ),
        ("announcements/retry", json!({})),
        ("announcements/resolve", json!({"version": 1})),
        (
            "announcements/resolve",
            json!({"version": 1, "outcome": "done"}),
        ),
        (
            "announcements/resolve",
            json!({"version": 1, "outcome": "published"}),
        ),
        (
            "announcements/resolve",
            json!({"version": 1, "outcome": "published", "providerPostId": "has space"}),
        ),
        (
            "announcements/resolve",
            json!({"version": 1, "outcome": "published", "providerPostId": "x".repeat(301)}),
        ),
        (
            "announcements/resolve",
            json!({"version": 1, "outcome": "not-posted", "providerPostId": "urn:li:share:7"}),
        ),
        (
            "announcements/resolve",
            json!({"version": 1, "outcome": "not-posted", "siteId": "other"}),
        ),
    ] {
        let (s, _) = call(&f, &transport, "POST", &id_path(tail), Some(body.clone()));
        assert_eq!(s, 400, "{tail} {body}");
    }
    for bad in ["x", "../../etc"] {
        let path = format!("/admin/api/social/announcements/attempts?id={bad}");
        let (s, b) = call(&f, &transport, "GET", &path, None);
        assert_eq!((s, b["code"].as_str()), (400, Some("invalid-id")), "{bad}");
    }
    assert_eq!(calls.lock().unwrap().len(), n, "nothing refused was sent");

    // A refusal from the hosted function reaches the author as a plain code and message.
    let refused = fake(
        &calls,
        409,
        json!({"error": "This may already be posted. Check the account, then say whether it was posted.", "code": "needs-resolution", "status": "unknown", "version": 3, "secret": "dropped"}),
    );
    let (s, b) = call(
        &f,
        &refused,
        "POST",
        &id_path("announcements/retry"),
        Some(json!({"version": 3})),
    );
    assert_eq!((s, b["code"].as_str()), (409, Some("needs-resolution")));
    assert_eq!(b["status"], "unknown");
    assert!(b.get("secret").is_none());
}
