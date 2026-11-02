//! Admin voice routes (ADR 0266 to 0268, ADR 0271, #444): deny by default, CSRF and origin, bounds,
//! the server-side deadline, the lock and its grace, revision-checked polished saves, a rough draft
//! that nothing changes, visibility moves, and responses that carry no absolute path and no
//! sample text in an error.

use super::*;
use crate::voice_store::SESSION_PATH;

const MARKER: &str = "PRIVATE-SAMPLE-MARKER-4821";

fn call(f: &Fixture, s: &(String, String), method: &str, path: &str, body: Json) -> (u16, Json) {
    source_call(f, s, method, path, body)
}

fn get(f: &Fixture, s: &(String, String), path: &str) -> (u16, Json) {
    let r = handle(&f.state, &authed(req("GET", path), s, false));
    (r.status, body_json(&r))
}

fn start(f: &Fixture, s: &(String, String), prompt: &str) -> Json {
    let (status, body) = call(
        f,
        s,
        "POST",
        "/admin/api/voice/session/start",
        json!({ "promptId": prompt }),
    );
    assert_eq!(status, 201, "{body}");
    body
}

fn first_prompt(f: &Fixture, s: &(String, String)) -> String {
    let (_, catalog) = get(f, s, "/admin/api/voice/catalog");
    catalog["packs"][0]["prompts"][0]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Move the open session's deadline so it began `ago` seconds ago.
fn age_session(f: &Fixture, ago: i64) {
    let path = f.dir.join(SESSION_PATH);
    let mut record: Json = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let limit = record["timeLimitSeconds"].as_i64().unwrap();
    // Only the deadline moves, so the session keeps its identity.
    let deadline = clock::now().unix() - ago + limit;
    record["deadline"] = json!(DateTime::from_unix(deadline).rfc3339());
    fs::write(&path, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
}

fn lock(f: &Fixture, s: &(String, String), session: &Json, text: &str) -> (u16, Json) {
    call(
        f,
        s,
        "POST",
        "/admin/api/voice/session/lock",
        json!({ "sessionId": session["sessionId"], "text": text }),
    )
}

#[test]
fn every_route_requires_a_session_and_a_write_the_csrf_token_and_the_same_origin() {
    let f = fixture("voice-auth");
    let routes: &[(&str, &str, bool)] = &[
        ("GET", "/admin/api/voice/catalog", false),
        ("GET", "/admin/api/voice/status", false),
        ("POST", "/admin/api/voice/draw", true),
        ("GET", "/admin/api/voice/session", false),
        ("DELETE", "/admin/api/voice/session", true),
        ("POST", "/admin/api/voice/session/start", true),
        ("PUT", "/admin/api/voice/session/draft", true),
        ("POST", "/admin/api/voice/session/lock", true),
        ("GET", "/admin/api/voice/erase", false),
        ("POST", "/admin/api/voice/erase", true),
        ("GET", "/admin/api/voice/guide/move?to=private", false),
        ("POST", "/admin/api/voice/guide/move", true),
        ("GET", "/admin/api/voice/samples", false),
        ("POST", "/admin/api/voice/samples", true),
        ("GET", "/admin/api/voice/samples/2026-10-28-a-rough", false),
        (
            "PUT",
            "/admin/api/voice/samples/2026-10-28-a-polished",
            true,
        ),
        (
            "POST",
            "/admin/api/voice/samples/2026-10-28-a-rough/visibility",
            true,
        ),
        (
            "POST",
            "/admin/api/voice/samples/2026-10-28-a-rough/promote",
            true,
        ),
    ];
    let session = login_ok(&f);
    for &(method, path, writes) in routes {
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
        let no_token = authed(json_req(method, path, json!({})), &session, false);
        assert_eq!(
            handle(&f.state, &no_token).status,
            403,
            "{method} {path} no token"
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
    }
    // Deny by default: other verbs and names are not routes, and nothing was created.
    for (method, path) in [
        ("DELETE", "/admin/api/voice/samples"),
        ("PATCH", "/admin/api/voice/catalog"),
        ("GET", "/admin/api/voice/other"),
        ("POST", "/admin/api/voice/samples/2026-10-28-a-rough/erase"),
        ("DELETE", "/admin/api/voice/samples/2026-10-28-a-rough"),
        ("GET", "/admin/api/voice/samples/..%2F..%2Fsecret"),
        ("GET", "/admin/api/voice/samples/Bad_Name"),
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
    assert!(!f.dir.join(".openblog/private/voice").exists());
}

#[test]
fn the_body_limits_are_set_before_any_body_is_read() {
    let f = fixture("voice-bounds");
    let s = login_ok(&f);
    let limit = |method: &str, path: &str| {
        preflight(&f.state, &authed(req(method, path), &s, false)).unwrap()
    };
    assert_eq!(limit("PUT", "/admin/api/voice/session/draft"), 256 * 1024);
    assert_eq!(limit("POST", "/admin/api/voice/session/lock"), 256 * 1024);
    assert_eq!(limit("POST", "/admin/api/voice/samples"), 256 * 1024);
    assert_eq!(
        limit("PUT", "/admin/api/voice/samples/2026-10-28-a-polished"),
        256 * 1024
    );
    assert_eq!(limit("POST", "/admin/api/voice/draw"), 4 * 1024);
    assert_eq!(limit("POST", "/admin/api/voice/erase"), 4 * 1024);
    assert_eq!(limit("POST", "/admin/api/voice/session/start"), 4 * 1024);
    assert_eq!(
        limit("POST", "/admin/api/voice/samples/x/visibility"),
        4 * 1024
    );
}

#[test]
fn the_catalog_and_the_draw_give_three_different_prompts_and_a_redraw_avoids_the_last() {
    let f = fixture("voice-draw");
    let s = login_ok(&f);
    let (status, catalog) = get(&f, &s, "/admin/api/voice/catalog");
    assert_eq!(status, 200);
    assert!(catalog["packs"].as_array().unwrap().len() >= 10);
    assert!(catalog["rule"]
        .as_str()
        .unwrap()
        .contains("the way you would say it"));
    assert_eq!(catalog["limits"]["defaultSeconds"], 180);
    let (status, first) = call(&f, &s, "POST", "/admin/api/voice/draw", json!({}));
    assert_eq!(status, 200);
    let ids = |v: &Json| -> Vec<String> {
        v["prompts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].as_str().unwrap().to_string())
            .collect()
    };
    let first_ids = ids(&first);
    assert_eq!(first_ids.len(), 3);
    assert!(first["prompts"][0]["invitation"].as_str().unwrap().len() > 10);
    let (_, again) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/draw",
        json!({ "exclude": first_ids }),
    );
    let again_ids = ids(&again);
    assert_eq!(again_ids.len(), 3);
    assert!(
        again_ids.iter().all(|id| !first_ids.contains(id)),
        "{first_ids:?} {again_ids:?}"
    );
    // A draw restricted to one pack stays in it; an unknown pack is not a pack.
    let pack = catalog["packs"][2]["id"].as_str().unwrap();
    let (_, in_pack) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/draw",
        json!({ "pack": pack }),
    );
    assert!(in_pack["prompts"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["pack"] == pack));
    assert_eq!(
        call(
            &f,
            &s,
            "POST",
            "/admin/api/voice/draw",
            json!({ "pack": "nope" })
        )
        .0,
        404
    );
    assert_eq!(
        call(
            &f,
            &s,
            "POST",
            "/admin/api/voice/draw",
            json!({ "exclude": [1] })
        )
        .0,
        400
    );
    assert_eq!(
        call(
            &f,
            &s,
            "POST",
            "/admin/api/voice/draw",
            json!({ "exclude": ["Not Kebab"] })
        )
        .0,
        400
    );
    assert!(
        !f.dir.join(".openblog/private/voice").exists(),
        "drawing creates nothing"
    );
}

#[test]
fn a_session_starts_saves_locks_and_keeps_the_rough_draft_exactly_as_written() {
    let f = fixture("voice-flow");
    let s = login_ok(&f);
    let prompt = first_prompt(&f, &s);
    let session = start(&f, &s, &prompt);
    assert_eq!(session["state"], "active");
    assert_eq!(session["remainingSeconds"], 180);
    assert_eq!(session["visibility"], "private");
    // A second session is refused and says why.
    let (status, again) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/session/start",
        json!({ "promptId": prompt }),
    );
    assert_eq!((status, again["alreadyOpen"].clone()), (409, json!(true)));
    let (status, saved) = call(
        &f,
        &s,
        "PUT",
        "/admin/api/voice/session/draft",
        json!({ "sessionId": session["sessionId"], "text": "first words" }),
    );
    assert_eq!(status, 200, "{saved}");
    let (_, resumed) = get(&f, &s, "/admin/api/voice/session");
    assert_eq!(resumed["state"], "active");
    assert_eq!(resumed["draft"], "first words");
    let text = format!("  {MARKER}  teh  quick\r\n\r\n  brown   fox ");
    let (status, locked) = lock(&f, &s, &session, &text);
    assert_eq!(status, 200, "{locked}");
    assert_eq!(locked["state"], "locked");
    assert_eq!(locked["sample"]["readOnly"], true);
    assert_eq!(locked["sample"]["stage"], "rough");
    // Only line endings changed; spelling, spacing and blank lines are the author's.
    assert_eq!(
        locked["sample"]["body"],
        format!("  {MARKER}  teh  quick\n\n  brown   fox ")
    );
    let path = locked["sample"]["path"].as_str().unwrap();
    assert!(
        path.starts_with(".openblog/private/context/voice/"),
        "{path}"
    );
    // The session is gone: another draft save, or another lock, is a plain refusal.
    let (status, late) = call(
        &f,
        &s,
        "PUT",
        "/admin/api/voice/session/draft",
        json!({ "sessionId": session["sessionId"], "text": "changed" }),
    );
    assert_eq!((status, late["noSession"].clone()), (409, json!(true)));
    assert_eq!(lock(&f, &s, &session, "again").0, 409);
    assert_eq!(get(&f, &s, "/admin/api/voice/session").1["state"], "none");
    // The listing shows it with a revision, newest first, and the coverage counts it.
    let (_, list) = get(&f, &s, "/admin/api/voice/samples");
    assert_eq!(list["samples"].as_array().unwrap().len(), 1);
    let pack = session["pack"].as_str().unwrap();
    let covered = list["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == pack)
        .unwrap();
    assert_eq!(covered["withRough"], 1);
    assert_eq!(covered["withPolished"], 0);
    assert!(covered["prompts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["id"] == prompt.as_str() && p["rough"] == true));
}

#[test]
fn a_draft_for_another_session_is_never_saved_into_this_one() {
    let f = fixture("voice-other-session");
    let s = login_ok(&f);
    let prompt = first_prompt(&f, &s);
    let session = start(&f, &s, &prompt);
    let (status, body) = call(
        &f,
        &s,
        "PUT",
        "/admin/api/voice/session/draft",
        json!({ "sessionId": "some-other@2020-01-01T00:00:00Z", "text": MARKER }),
    );
    assert_eq!((status, body["otherSession"].clone()), (409, json!(true)));
    assert!(!body.to_string().contains(MARKER));
    let (_, resumed) = get(&f, &s, "/admin/api/voice/session");
    assert_eq!(resumed["draft"], "");
    assert_eq!(resumed["sessionId"], session["sessionId"]);
}

#[test]
fn the_deadline_is_enforced_on_the_server_a_late_draft_is_refused_and_the_lock_has_ten_seconds_of_grace(
) {
    let f = fixture("voice-deadline");
    let s = login_ok(&f);
    let prompt = first_prompt(&f, &s);
    let session = start(&f, &s, &prompt);
    let id = session["sessionId"].clone();
    let save = |text: &str| {
        call(
            &f,
            &s,
            "PUT",
            "/admin/api/voice/session/draft",
            json!({ "sessionId": id, "text": text }),
        )
    };
    assert_eq!(save("saved while open").0, 200);
    // Two seconds past the deadline: new text is refused outright, with no grace.
    age_session(&f, 182);
    let (status, refused) = save("too late");
    assert_eq!((status, refused["timeUp"].clone()), (409, json!(true)));
    // The lock accepts the text on screen within the grace.
    let (status, locked) = lock(&f, &s, &session, "final words handed over at zero");
    assert_eq!(status, 200, "{locked}");
    assert_eq!(locked["sample"]["body"], "final words handed over at zero");
    assert_eq!(locked["expired"], true);

    // Past the grace the last saved text is what is locked.
    let f = fixture("voice-deadline-late");
    let s = login_ok(&f);
    let prompt = first_prompt(&f, &s);
    let session = start(&f, &s, &prompt);
    assert_eq!(
        call(
            &f,
            &s,
            "PUT",
            "/admin/api/voice/session/draft",
            json!({ "sessionId": session["sessionId"], "text": "saved text" })
        )
        .0,
        200
    );
    age_session(&f, 180 + 11);
    let (status, locked) = lock(&f, &s, &session, "text typed long after the deadline");
    assert_eq!(status, 200, "{locked}");
    assert_eq!(locked["sample"]["body"], "saved text");
}

#[test]
fn resuming_after_the_time_ran_out_locks_from_the_saved_text_and_never_grants_more_time() {
    let f = fixture("voice-expiry");
    let s = login_ok(&f);
    let prompt = first_prompt(&f, &s);
    let session = start(&f, &s, &prompt);
    assert_eq!(
        call(
            &f,
            &s,
            "PUT",
            "/admin/api/voice/session/draft",
            json!({ "sessionId": session["sessionId"], "text": "what I had" })
        )
        .0,
        200
    );
    age_session(&f, 400);
    let (status, resumed) = get(&f, &s, "/admin/api/voice/session");
    assert_eq!(status, 200);
    assert_eq!(resumed["state"], "locked");
    assert_eq!(resumed["expired"], true);
    assert_eq!(resumed["sample"]["body"], "what I had");
    assert_eq!(get(&f, &s, "/admin/api/voice/session").1["state"], "none");

    // An expired session with nothing written is discarded, not locked empty.
    let f = fixture("voice-expiry-empty");
    let s = login_ok(&f);
    let prompt = first_prompt(&f, &s);
    start(&f, &s, &prompt);
    age_session(&f, 400);
    assert_eq!(
        get(&f, &s, "/admin/api/voice/session").1["state"],
        "discarded"
    );
    assert!(get(&f, &s, "/admin/api/voice/samples").1["samples"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn locking_nothing_is_a_plain_refusal_and_a_scrap_writes_nothing() {
    let f = fixture("voice-empty");
    let s = login_ok(&f);
    let prompt = first_prompt(&f, &s);
    let session = start(&f, &s, &prompt);
    let (status, body) = lock(&f, &s, &session, "   \n  ");
    assert_eq!((status, body["empty"].clone()), (409, json!(true)));
    // A scrap must name the session: an unnamed one leaves it alone.
    let (status, body) = call(&f, &s, "DELETE", "/admin/api/voice/session", json!({}));
    assert_eq!((status, body["otherSession"].clone()), (409, json!(true)));
    let (status, body) = call(
        &f,
        &s,
        "DELETE",
        "/admin/api/voice/session",
        json!({ "sessionId": "a-mistake-i-made@2000-01-01T00:00:00Z" }),
    );
    assert_eq!((status, body["otherSession"].clone()), (409, json!(true)));
    assert_ne!(get(&f, &s, "/admin/api/voice/session").1["state"], "none");
    let (status, _) = call(
        &f,
        &s,
        "DELETE",
        "/admin/api/voice/session",
        json!({ "sessionId": session["sessionId"] }),
    );
    assert_eq!(status, 200);
    assert_eq!(get(&f, &s, "/admin/api/voice/session").1["state"], "none");
    assert!(get(&f, &s, "/admin/api/voice/samples").1["samples"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn draft_and_lock_sizes_are_bounded() {
    let f = fixture("voice-size");
    let s = login_ok(&f);
    let prompt = first_prompt(&f, &s);
    let session = start(&f, &s, &prompt);
    let big = "x".repeat(61 * 1024);
    let (status, body) = call(
        &f,
        &s,
        "PUT",
        "/admin/api/voice/session/draft",
        json!({ "sessionId": session["sessionId"], "text": big }),
    );
    assert_eq!(status, 413);
    assert!(!body.to_string().contains("xxxx"));
    assert_eq!(lock(&f, &s, &session, &big).0, 413);
    let mut huge = json_req("PUT", "/admin/api/voice/session/draft", json!({}));
    huge.body = vec![b' '; 300 * 1024];
    let reply = handle(&f.state, &authed(huge, &s, true));
    assert_eq!(reply.status, 413);
    // Bad shapes are 400s, not panics.
    for body in [
        json!({ "sessionId": session["sessionId"], "text": 5 }),
        json!({ "text": "x" }),
        json!([]),
    ] {
        assert_eq!(
            call(&f, &s, "PUT", "/admin/api/voice/session/draft", body).0,
            400
        );
    }
    let (status, _) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/session/start",
        json!({ "promptId": "no-such", "visibility": "public" }),
    );
    assert_eq!(status, 400);
}

fn locked_sample(f: &Fixture, s: &(String, String), visibility: &str) -> (Json, Json) {
    let prompt = first_prompt(f, s);
    let (status, session) = call(
        f,
        s,
        "POST",
        "/admin/api/voice/session/start",
        json!({ "promptId": prompt, "visibility": visibility }),
    );
    assert_eq!(status, 201);
    let (status, locked) = lock(f, s, &session, "the rough words\nsecond line");
    assert_eq!(status, 200, "{locked}");
    (session, locked["sample"].clone())
}

#[test]
fn a_polished_draft_is_created_beside_its_rough_draft_and_saves_are_revision_checked() {
    let f = fixture("voice-polished");
    let s = login_ok(&f);
    let (_, rough) = locked_sample(&f, &s, "portable");
    let rough_file = rough["file"].as_str().unwrap();
    assert!(rough["path"]
        .as_str()
        .unwrap()
        .starts_with("assistant/context/voice/"));
    let rough_bytes = fs::read(f.dir.join(rough["path"].as_str().unwrap())).unwrap();

    let (status, created) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/samples",
        json!({ "roughOf": rough_file, "title": "My Better Title", "body": "The polished words." }),
    );
    assert_eq!(status, 201, "{created}");
    assert_eq!(created["stage"], "polished");
    assert_eq!(created["roughOf"], rough_file);
    assert_eq!(created["visibility"], "portable");
    assert_eq!(created["slug"], "my-better-title");
    assert_eq!(created["words"], 3);
    let polished_id = created["id"].as_str().unwrap().to_string();
    // A second create is a conflict, not a replacement.
    let (status, again) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/samples",
        json!({ "roughOf": rough_file, "title": "x", "body": "y" }),
    );
    assert_eq!((status, again["conflict"].clone()), (409, json!(true)));

    let url = format!("/admin/api/voice/samples/{polished_id}");
    let (status, saved) = call(
        &f,
        &s,
        "PUT",
        &url,
        json!({ "revision": created["revision"], "body": "Polished again, with more." }),
    );
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["body"], "Polished again, with more.");
    assert_ne!(saved["revision"], created["revision"]);
    // A stale revision is refused, says what is stored, and writes nothing.
    let (status, stale) = call(
        &f,
        &s,
        "PUT",
        &url,
        json!({ "revision": created["revision"], "body": format!("{MARKER} lost edit") }),
    );
    assert_eq!(status, 409);
    assert_eq!(stale["conflict"], true);
    assert_eq!(stale["revision"], saved["revision"]);
    assert_eq!(stale["current"]["body"], "Polished again, with more.");
    assert!(!stale["error"].as_str().unwrap().contains(MARKER));
    let (_, read) = get(&f, &s, &url);
    assert_eq!(read["body"], "Polished again, with more.");
    assert_eq!(read["partner"]["file"], rough_file);
    // The rough draft is byte-for-byte what was locked.
    assert_eq!(
        fs::read(f.dir.join(rough["path"].as_str().unwrap())).unwrap(),
        rough_bytes
    );
    // An invalid save says which field and writes nothing.
    let (status, invalid) = call(
        &f,
        &s,
        "PUT",
        &url,
        json!({ "revision": saved["revision"], "body": "   " }),
    );
    assert_eq!(status, 422);
    assert!(invalid["error"].as_str().unwrap().contains("no text"));
    // A polished draft needs a rough one, in the same folder.
    let (status, orphan) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/samples",
        json!({ "roughOf": "2020-01-01-no-such-prompt-rough.md", "title": "x", "body": "y" }),
    );
    assert_eq!(status, 404, "{orphan}");
    assert_eq!(
        call(
            &f,
            &s,
            "POST",
            "/admin/api/voice/samples",
            json!({ "roughOf": "x-polished.md", "body": "y" })
        )
        .0,
        400
    );
}

#[test]
fn a_rough_draft_has_no_route_that_changes_it() {
    let f = fixture("voice-rough-readonly");
    let s = login_ok(&f);
    let (_, rough) = locked_sample(&f, &s, "private");
    let file = rough["path"].as_str().unwrap();
    let before = fs::read(f.dir.join(file)).unwrap();
    let id = rough["id"].as_str().unwrap();
    let (status, body) = call(
        &f,
        &s,
        "PUT",
        &format!("/admin/api/voice/samples/{id}"),
        json!({ "revision": rough["revision"], "body": format!("{MARKER} rewritten"), "title": "x" }),
    );
    assert_eq!(status, 409);
    assert_eq!(body["readOnly"], true);
    assert!(!body.to_string().contains(MARKER));
    assert_eq!(fs::read(f.dir.join(file)).unwrap(), before);
    // Reading it says it is read-only.
    let (_, read) = get(&f, &s, &format!("/admin/api/voice/samples/{id}"));
    assert_eq!(read["readOnly"], true);
    assert_eq!(read["stage"], "rough");
    // A polished draft cannot be saved over a rough file name by any other route either.
    let (status, _) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/samples",
        json!({ "roughOf": rough["file"], "title": "t", "body": "polished" }),
    );
    assert_eq!(status, 201);
    assert_eq!(fs::read(f.dir.join(file)).unwrap(), before);
}

#[test]
fn a_pair_moves_between_the_folders_together_and_unchanged() {
    let f = fixture("voice-visibility");
    let s = login_ok(&f);
    let (_, rough) = locked_sample(&f, &s, "private");
    let rough_path = rough["path"].as_str().unwrap().to_string();
    let rough_bytes = fs::read(f.dir.join(&rough_path)).unwrap();
    let (_, polished) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/samples",
        json!({ "roughOf": rough["file"], "title": "T", "body": "polished" }),
    );
    let id = rough["id"].as_str().unwrap();
    let url = format!("/admin/api/voice/samples/{id}/visibility");
    let (status, same) = call(&f, &s, "POST", &url, json!({ "visibility": "private" }));
    assert_eq!((status, same["refused"].clone()), (409, json!(true)));
    assert_eq!(
        call(&f, &s, "POST", &url, json!({ "visibility": "everyone" })).0,
        400
    );
    assert_eq!(call(&f, &s, "POST", &url, json!({})).0, 400);
    let (status, moved) = call(&f, &s, "POST", &url, json!({ "visibility": "portable" }));
    assert_eq!(status, 200, "{moved}");
    assert_eq!(moved["moved"].as_array().unwrap().len(), 2);
    assert!(!f.dir.join(&rough_path).exists());
    let new_path = rough_path.replace(".openblog/private/context/voice", "assistant/context/voice");
    assert_eq!(fs::read(f.dir.join(&new_path)).unwrap(), rough_bytes);
    assert!(f
        .dir
        .join(
            polished["path"]
                .as_str()
                .unwrap()
                .replace(".openblog/private/context/voice", "assistant/context/voice")
        )
        .exists());
    // Moving the polished draft by its own id moves the pair back.
    let (status, _) = call(
        &f,
        &s,
        "POST",
        &format!(
            "/admin/api/voice/samples/{}/visibility",
            polished["id"].as_str().unwrap()
        ),
        json!({ "visibility": "private" }),
    );
    assert_eq!(status, 200);
    assert_eq!(fs::read(f.dir.join(&rough_path)).unwrap(), rough_bytes);
    assert_eq!(
        call(
            &f,
            &s,
            "POST",
            "/admin/api/voice/samples/2020-01-01-nope-rough/visibility",
            json!({ "visibility": "portable" })
        )
        .0,
        404
    );
}

#[test]
fn an_invalid_file_is_listed_with_guidance_and_responses_hold_no_absolute_path_or_sample_text() {
    let f = fixture("voice-privacy");
    let s = login_ok(&f);
    let directory = f.dir.join(".openblog/private/context/voice");
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join("2026-10-27-broken-prompt-rough.md"),
        format!("not a sample {MARKER}"),
    )
    .unwrap();
    let (_, rough) = locked_sample(&f, &s, "private");
    let (_, list) = get(&f, &s, "/admin/api/voice/samples");
    let broken = list["samples"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["valid"] == false)
        .expect("the invalid file is listed");
    assert!(broken["guidance"].as_str().unwrap().len() > 10);
    // Neither the guidance nor any other response repeats the file's text or where the project is.
    let root = f.dir.display().to_string();
    let root_slashes = root.replace('\\', "/");
    let mut everything = vec![list.to_string(), rough.to_string()];
    for path in [
        "/admin/api/voice/catalog",
        "/admin/api/voice/status",
        "/admin/api/voice/session",
    ] {
        everything.push(get(&f, &s, path).1.to_string());
    }
    for text in &everything {
        assert!(!text.contains(MARKER), "{text}");
        assert!(
            !text.contains(&root) && !text.contains(&root_slashes),
            "{text}"
        );
    }
    // The broken file cannot be opened as a sample either, and its text stays out of the answer.
    let (status, opened) = get(
        &f,
        &s,
        "/admin/api/voice/samples/2026-10-27-broken-prompt-rough",
    );
    assert_eq!(status, 200);
    assert_eq!(opened["valid"], false);
    assert!(!opened.to_string().contains(MARKER));
}

#[test]
fn the_status_reports_an_open_session_and_the_number_of_samples_without_changing_anything() {
    let f = fixture("voice-status");
    let s = login_ok(&f);
    let (_, empty) = get(&f, &s, "/admin/api/voice/status");
    assert_eq!(empty, json!({ "session": { "open": false }, "samples": 0 }));
    let prompt = first_prompt(&f, &s);
    start(&f, &s, &prompt);
    assert_eq!(
        get(&f, &s, "/admin/api/voice/status").1["session"]["open"],
        true
    );
    age_session(&f, 400);
    let (_, expired) = get(&f, &s, "/admin/api/voice/status");
    assert_eq!(expired["session"]["expired"], true);
    assert!(
        f.dir.join(SESSION_PATH).exists(),
        "reading the status does not lock"
    );
}

#[test]
fn the_voice_scripts_are_served_to_the_admin_page_and_are_the_embedded_ones() {
    let f = fixture("voice-assets");
    for (path, marker) in [
        ("/admin/voice.js", "createCountdown"),
        ("/admin/voice-session.js", "ROUGH_ATTRIBUTES"),
        ("/admin/voice-polished.js", "createPolishedEditor"),
        ("/admin/voice-library.js", "createVoiceLibrary"),
    ] {
        let response = handle(&f.state, &req("GET", path));
        assert_eq!(response.status, 200, "{path}");
        assert!(
            String::from_utf8_lossy(&response.body).contains(marker),
            "{path}"
        );
        assert!(response
            .headers
            .iter()
            .any(|(k, v)| k == "Content-Type" && v.starts_with("text/javascript")));
    }
}

#[test]
fn dismissing_the_voice_invitation_is_a_saved_preference_that_changes_nothing_else() {
    let f = fixture("voice-invitation");
    let s = login_ok(&f);
    let (_, initial) = get(&f, &s, "/admin/api/preferences");
    // An admin that never dismissed it has no such key: the stored shape is unchanged.
    assert!(initial["preferences"]
        .get("voiceInvitationDismissed")
        .is_none());
    let mut preferences = initial["preferences"].clone();
    preferences["voiceInvitationDismissed"] = json!(true);
    let (status, saved) = call(
        &f,
        &s,
        "PUT",
        "/admin/api/preferences",
        json!({ "etag": initial["etag"], "preferences": preferences }),
    );
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["preferences"]["voiceInvitationDismissed"], true);
    assert_eq!(
        saved["preferences"]["preset"],
        initial["preferences"]["preset"]
    );
    // It comes back on the next read, and it is in the admin's own private file only.
    let (_, again) = get(&f, &s, "/admin/api/preferences");
    assert_eq!(again["preferences"]["voiceInvitationDismissed"], true);
    let config = fs::read_to_string(f.dir.join("openblog.json")).unwrap();
    assert!(!config.contains("voiceInvitation"));
    // Saving it as false removes the key again, and the other preferences stay as they were.
    let mut undone = again["preferences"].clone();
    undone["voiceInvitationDismissed"] = json!(false);
    let (status, back) = call(
        &f,
        &s,
        "PUT",
        "/admin/api/preferences",
        json!({ "etag": again["etag"], "preferences": undone }),
    );
    assert_eq!(status, 200);
    assert!(back["preferences"]
        .get("voiceInvitationDismissed")
        .is_none());
    // The file still refuses keys it does not know.
    let mut bad = back["preferences"].clone();
    bad["voiceInvitationDismisse"] = json!(true);
    let (status, _) = call(
        &f,
        &s,
        "PUT",
        "/admin/api/preferences",
        json!({ "etag": back["etag"], "preferences": bad }),
    );
    assert_eq!(status, 400);
}

#[test]
fn a_polished_draft_becomes_a_post_draft_and_a_rough_draft_or_a_taken_slug_is_refused() {
    let f = fixture("voice-promote");
    let s = login_ok(&f);
    let (_, rough) = locked_sample(&f, &s, "private");
    let rough_id = rough["id"].as_str().unwrap().to_string();
    let rough_path = rough["path"].as_str().unwrap().to_string();
    let rough_bytes = fs::read(f.dir.join(&rough_path)).unwrap();
    let rough_url = format!("/admin/api/voice/samples/{rough_id}/promote");
    let (status, refused) = call(&f, &s, "POST", &rough_url, json!({}));
    assert_eq!(status, 409, "{refused}");
    assert!(
        refused["error"].as_str().unwrap().contains("polished"),
        "{refused}"
    );
    assert_eq!(
        call(
            &f,
            &s,
            "POST",
            &rough_url.replace(&rough_id, "2020-01-01-nope-polished"),
            json!({})
        )
        .0,
        404
    );

    let (_, polished) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/samples",
        json!({ "roughOf": rough["file"], "title": "My Promoted Title", "body": "polished words" }),
    );
    let url = format!(
        "/admin/api/voice/samples/{}/promote",
        polished["id"].as_str().unwrap()
    );
    assert_eq!(
        call(&f, &s, "POST", &url, json!({ "dir": "../outside" })).0,
        409
    );
    assert_eq!(call(&f, &s, "POST", &url, json!({ "dir": 7 })).0, 400);
    let (status, made) = call(&f, &s, "POST", &url, json!({}));
    assert_eq!(status, 201, "{made}");
    let path = made["path"].as_str().unwrap();
    assert!(
        !path.contains('\\') && !path.starts_with('/') && !path.contains(':'),
        "{path}"
    );
    let edit = made["editPath"].as_str().unwrap();
    assert!(edit.starts_with("posts/") && path.ends_with(edit), "{made}");
    let text = fs::read_to_string(f.dir.join(path)).unwrap();
    assert!(
        text.contains("draft: \"true\"") && text.contains("polished words"),
        "{text}"
    );
    // The samples were not touched, and promoting again hits the slug the first one took.
    assert_eq!(fs::read(f.dir.join(&rough_path)).unwrap(), rough_bytes);
    let (status, taken) = call(&f, &s, "POST", &url, json!({}));
    assert_eq!(status, 409, "{taken}");
    let dir = f.dir.to_string_lossy().replace('\\', "/");
    assert!(!taken.to_string().contains(&dir), "{taken}");
}

#[test]
fn a_session_lock_that_lost_a_race_reads_back_as_no_session() {
    let f = fixture("voice-race");
    let s = login_ok(&f);
    let prompt = first_prompt(&f, &s);
    let session = start(&f, &s, &prompt);
    call(
        &f,
        &s,
        "PUT",
        "/admin/api/voice/session/draft",
        json!({ "sessionId": session["sessionId"], "text": "words" }),
    );
    age_session(&f, 500);
    let (status, first) = get(&f, &s, "/admin/api/voice/session");
    assert_eq!(
        (status, first["state"].as_str()),
        (200, Some("locked")),
        "{first}"
    );
    let (status, second) = get(&f, &s, "/admin/api/voice/session");
    assert_eq!(
        (status, second["state"].as_str()),
        (200, Some("none")),
        "{second}"
    );
}

#[test]
fn erase_lists_first_needs_the_typed_word_and_removes_everything_with_a_post_check() {
    let f = fixture("voice-erase");
    let s = login_ok(&f);
    let (status, none) = get(&f, &s, "/admin/api/voice/erase");
    assert_eq!((status, none["items"].clone()), (200, json!([])));

    let (_, rough) = locked_sample(&f, &s, "private");
    let (_, _) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/samples",
        json!({ "roughOf": rough["file"], "title": "T", "body": MARKER }),
    );
    fs::create_dir_all(f.dir.join(SESSION_PATH).parent().unwrap()).unwrap();
    fs::write(f.dir.join(SESSION_PATH), "{}").unwrap();
    fs::create_dir_all(f.dir.join("assistant/context")).unwrap();
    fs::write(f.dir.join("assistant/context/voice.md"), "guide").unwrap();
    fs::write(f.dir.join("assistant/context/author.md"), "keep").unwrap();

    let (status, plan) = get(&f, &s, "/admin/api/voice/erase");
    assert_eq!(status, 200);
    let kinds: Vec<&str> = plan["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["kind"].as_str().unwrap())
        .collect();
    for kind in ["sample", "session record", "voice guide"] {
        assert!(kinds.contains(&kind), "{kinds:?}");
    }
    let listed = plan.to_string();
    assert!(!listed.contains(MARKER) && !listed.contains(&f.dir.display().to_string()));

    // Without the typed word nothing happens.
    for body in [
        json!({}),
        json!({ "confirm": "yes" }),
        json!({ "confirm": true }),
    ] {
        let (status, _) = call(&f, &s, "POST", "/admin/api/voice/erase", body);
        assert!(status == 409 || status == 400, "{status}");
    }
    assert_eq!(
        get(&f, &s, "/admin/api/voice/erase").1["items"],
        plan["items"]
    );

    let (status, done) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/erase",
        json!({ "confirm": "Erase" }),
    );
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["clean"], json!(true));
    assert_eq!(done["remaining"], json!([]));
    assert_eq!(done["erased"], plan["items"]);
    assert_eq!(get(&f, &s, "/admin/api/voice/erase").1["items"], json!([]));
    assert!(!f.dir.join("assistant/context/voice.md").exists());
    assert_eq!(
        fs::read_to_string(f.dir.join("assistant/context/author.md")).unwrap(),
        "keep"
    );
    assert!(!f.dir.join(SESSION_PATH).exists());
}

#[test]
fn a_project_served_from_the_current_folder_keeps_its_sentences_and_hides_its_path() {
    let root = std::path::Path::new(".");
    let refusal = "Only a polished draft can be saved this way. A rough draft is never rewritten.";
    assert_eq!(super::voice::scrub_root(root, refusal), refusal);
    let canonical = std::fs::canonicalize(root).unwrap();
    let plain = canonical.display().to_string();
    let plain = plain.strip_prefix(r"\\?\").unwrap_or(&plain).to_string();
    for spelling in [
        canonical.display().to_string(),
        plain.clone(),
        plain.replace('\\', "/"),
    ] {
        let failure = format!(
            "cannot create {spelling}{}private{}voice: denied.",
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR
        );
        let scrubbed = super::voice::scrub_root(root, &failure);
        assert!(
            scrubbed.starts_with("cannot create the project"),
            "{scrubbed}"
        );
        assert!(!scrubbed.contains(&plain), "{scrubbed}");
        assert!(scrubbed.ends_with(": denied."), "{scrubbed}");
    }
}

// ---- moving the voice guide (ADR 0289) ---------------------------------------------------------

#[test]
fn the_guide_move_is_previewed_then_done_in_one_step_and_reversed() {
    let f = fixture("voice-guide-move");
    let s = login_ok(&f);
    let guide = "# Voice guide\n<!-- openblog:voice-provenance sources=portable -->\n\n- Mine\n";
    fs::create_dir_all(f.dir.join("assistant/context")).unwrap();
    fs::write(f.dir.join("assistant/context/voice.md"), guide).unwrap();

    let (status, plan) = get(&f, &s, "/admin/api/voice/guide/move?to=private");
    assert_eq!(status, 200, "{plan}");
    assert_eq!(plan["move"]["fromPath"], "assistant/context/voice.md");
    assert_eq!(plan["move"]["toPath"], ".openblog/private/context/voice.md");
    assert!(!f.dir.join(".openblog/private/context/voice.md").exists());
    assert_eq!(
        get(&f, &s, "/admin/api/voice/guide/move?to=elsewhere").0,
        400
    );

    let (status, moved) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/guide/move",
        json!({ "to": "private" }),
    );
    assert_eq!(status, 200, "{moved}");
    assert!(!f.dir.join("assistant/context/voice.md").exists());
    assert_eq!(
        fs::read_to_string(f.dir.join(".openblog/private/context/voice.md")).unwrap(),
        guide
    );
    // Moving again the same way finds nothing to move.
    let (status, refused) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/guide/move",
        json!({ "to": "private" }),
    );
    assert_eq!(status, 409);
    assert_eq!(refused["refused"], true);
    let (status, _) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/guide/move",
        json!({ "to": "portable" }),
    );
    assert_eq!(status, 200);
    assert_eq!(
        fs::read_to_string(f.dir.join("assistant/context/voice.md")).unwrap(),
        guide
    );
    assert!(!f.dir.join(".openblog/private/context/voice.md").exists());
}

#[test]
fn the_guide_move_is_refused_while_a_content_write_holds_the_lock() {
    let f = fixture("voice-guide-move-locked");
    let s = login_ok(&f);
    fs::create_dir_all(f.dir.join("assistant/context")).unwrap();
    fs::write(f.dir.join("assistant/context/voice.md"), "# Voice guide\n").unwrap();
    let held = crate::transaction::ContentTransactionLock::acquire(&f.dir).unwrap();
    let (status, _) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/guide/move",
        json!({ "to": "private" }),
    );
    assert_eq!(status, 409);
    assert!(f.dir.join("assistant/context/voice.md").exists());
    drop(held);
    let (status, _) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/guide/move",
        json!({ "to": "private" }),
    );
    assert_eq!(status, 200);
}
