//! The Admin voice journey and a security matrix over every voice route (epic #410, task #468):
//! one signed-in author goes from a draw to an erased library through the API, and every route
//! is probed for the same refusals (no session, no CSRF token, a body over its limit, a hostile
//! id or field, an attempt on a rough draft, a late save, and a private to portable leak).
//! The provider is the local fake; no sample text may appear in an error.

use super::*;

use crate::voice_assistant::test_support::write_rough;
use crate::voice_store::{Visibility, SESSION_PATH};

const MARK: &str = "QUINCEFOX-7731";
const GUIDE: &str = "/admin/api/assistant/voice-guide";

fn call(f: &Fixture, s: &(String, String), method: &str, path: &str, body: Json) -> (u16, Json) {
    source_call(f, s, method, path, body)
}

fn get(f: &Fixture, s: &(String, String), path: &str) -> (u16, Json) {
    let r = handle(&f.state, &authed(req("GET", path), s, false));
    (r.status, body_json(&r))
}

fn post(f: &Fixture, s: &(String, String), path: &str, body: Json) -> Response {
    handle(&f.state, &authed(json_req("POST", path, body), s, true))
}

/// Every file under the project (relative path, bytes) except the Admin's own session store.
fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if path.is_dir() {
                walk(base, &path, out);
            } else if name.starts_with("assistant/")
                || name.starts_with("content/")
                || name.starts_with(".openblog/private/context")
                || name.starts_with(".openblog/private/voice")
                || name == "openblog.json"
            {
                out.push((name, fs::read(&path).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

fn age_session(f: &Fixture, ago: i64) {
    let path = f.dir.join(SESSION_PATH);
    let mut record: Json = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let limit = record["timeLimitSeconds"].as_i64().unwrap();
    let deadline = clock::now().unix() - ago + limit;
    record["deadline"] = json!(DateTime::from_unix(deadline).rfc3339());
    fs::write(&path, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
}

fn guide_json(file: &str) -> String {
    json!({
        "sections": [{ "id": "diction", "traits": [
            { "statement": "Starts with so", "quote": "so i deleted", "sample": file, "oneSample": true }
        ]}],
        "unknown": []
    })
    .to_string()
}

fn write_guide_skill(f: &Fixture) {
    fs::create_dir_all(f.dir.join("assistant/skills")).unwrap();
    fs::write(
        f.dir.join("assistant/skills/voice-guide.md"),
        "---\nid: voice-guide\nname: Voice guide\ndescription: Folds samples into a guide.\nversion: 1.0.0\nscopes: [document]\noutput: voice-guide\noverride: voice-guide\n---\nFold the samples into the guide.\n",
    )
    .unwrap();
}

#[test]
fn an_author_goes_from_a_draw_to_an_erased_library_through_the_admin_api() {
    let _env = quiz_env();
    let _key = EnvRestore::capture("OPENBLOG_LESSONS_API_KEY");
    let f = fixture("voice-journey");
    let s = login_ok(&f);
    write_guide_skill(&f);
    std::env::set_var("OPENBLOG_LESSONS_API_KEY", "journey-secret");

    // Draw three prompts, start one, save a draft, and lock it.
    let (status, drawn) = call(&f, &s, "POST", "/admin/api/voice/draw", json!({}));
    assert_eq!(status, 200);
    let prompt = drawn["prompts"][0]["id"].as_str().unwrap().to_string();
    let (status, session) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/session/start",
        json!({ "promptId": prompt }),
    );
    assert_eq!(status, 201, "{session}");
    assert_eq!(
        get(&f, &s, "/admin/api/voice/status").1["session"]["open"],
        true
    );
    let text = format!("so i deleted the wrong folder {MARK}");
    assert_eq!(
        call(
            &f,
            &s,
            "PUT",
            "/admin/api/voice/session/draft",
            json!({ "sessionId": session["sessionId"], "text": "so i deleted" })
        )
        .0,
        200
    );
    let (status, locked) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/session/lock",
        json!({ "sessionId": session["sessionId"], "text": text }),
    );
    assert_eq!(status, 200, "{locked}");
    let rough = locked["sample"].clone();
    let rough_file = rough["file"].as_str().unwrap().to_string();
    let rough_id = rough["id"].as_str().unwrap().to_string();
    assert_eq!(rough["visibility"], "private", "private by default");
    assert!(rough["path"]
        .as_str()
        .unwrap()
        .starts_with(".openblog/private/context/voice/"));
    let rough_path = f.dir.join(rough["path"].as_str().unwrap());
    let rough_bytes = fs::read(&rough_path).unwrap();
    assert!(
        !f.dir.join(SESSION_PATH).exists(),
        "the session record is closed"
    );

    // Polish a copy and promote it to a post draft; the rough draft never changes.
    let (status, polished) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/samples",
        json!({ "roughOf": rough_file, "title": "The folder", "body": "I deleted the wrong folder." }),
    );
    assert_eq!(status, 201, "{polished}");
    let (status, promoted) = call(
        &f,
        &s,
        "POST",
        &format!(
            "/admin/api/voice/samples/{}/promote",
            polished["id"].as_str().unwrap()
        ),
        json!({}),
    );
    assert_eq!(status, 201, "{promoted}");
    assert_eq!(fs::read(&rough_path).unwrap(), rough_bytes);
    let posts = fs::read_dir(f.dir.join("content/posts")).unwrap();
    assert!(posts
        .flatten()
        .any(|e| e.file_name().to_string_lossy().ends_with("the-folder.md")));

    // The library lists the pair; the Assistant catalog offers both as context by id.
    let (_, list) = get(&f, &s, "/admin/api/voice/samples");
    assert!(list.to_string().contains(&rough_file));
    let (_, context) = get(&f, &s, "/admin/api/assistant/context");
    let ids: Vec<String> = context["voiceSamples"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap().to_string())
        .collect();
    assert!(
        ids.contains(&format!("voice:private:{rough_file}")),
        "{ids:?}"
    );
    assert!(
        !context.to_string().contains(MARK),
        "no text in the listing"
    );

    // The voice guide is proposed from the private sample: nothing is written, the provider saw
    // the text only as untrusted data, and the result cannot be saved as portable.
    let (endpoint, captured, provider) = capturing_provider(guide_json(&rough_file));
    set_quiz_endpoint(&f, &endpoint);
    let before = tree(&f.dir);
    let response = post(
        &f,
        &s,
        GUIDE,
        json!({ "sampleIds": [format!("voice:private:{rough_file}")] }),
    );
    assert_eq!(
        response.status,
        200,
        "{}",
        String::from_utf8_lossy(&response.body)
    );
    provider.join().unwrap();
    let outbound = captured.recv().unwrap();
    assert!(outbound["untrustedData"]["context"][0]["content"]
        .as_str()
        .unwrap()
        .contains(MARK));
    assert!(!String::from_utf8_lossy(&response.body).contains("journey-secret"));
    assert_eq!(tree(&f.dir), before);
    let proposal = body_json(&response);
    assert_eq!(proposal["portableAllowed"], false);
    let markdown = proposal["markdown"].as_str().unwrap().to_string();
    let put_guide = |visibility: &str| {
        handle(
            &f.state,
            &authed(
                json_req(
                    "PUT",
                    "/admin/api/assistant/context",
                    json!({ "contextType": "voice", "visibility": visibility, "content": markdown, "etag": null }),
                ),
                &s,
                true,
            ),
        )
    };
    assert_eq!(put_guide("portable").status, 422);
    assert!(!f.dir.join("assistant/context/voice.md").exists());
    assert_eq!(put_guide("private").status, 200);

    // A review that selects the sample and the guide cites them; the browser's own copy of the
    // text is ignored and the findings carry no secret.
    let (endpoint, captured, provider) = capturing_provider(
        json!({ "findings": [
            { "id": "f1", "skillId": "voice-review", "skillVersion": "1.1.0", "category": "voice", "severity": "low",
              "title": "Stiff opening", "explanation": format!("Reads stiffer than {rough_file}."),
              "range": { "start": 2, "end": 7 }, "evidence": "draft", "sources": [], "verification": "supplied-context" },
            { "id": "f2", "skillId": "voice-review", "skillVersion": "1.1.0", "category": "voice", "severity": "low",
              "title": "Sounds off", "explanation": "This does not sound like you.",
              "range": { "start": 8, "end": 12 }, "evidence": "body", "sources": [], "verification": "supplied-context" }
        ] })
        .to_string(),
    );
    set_quiz_endpoint(&f, &endpoint);
    let review = post(
        &f,
        &s,
        "/admin/api/assistant/review",
        json!({
            "source": { "title": "T", "metadata": { "draft": "true" }, "markdown": "A draft body." },
            "skillIds": ["voice-review"],
            "contextIds": [format!("voice:private:{rough_file}"), "private:voice"],
            "voiceSamples": [{ "id": format!("voice:private:{rough_file}"), "content": "FORGED" }],
        }),
    );
    assert_eq!(
        review.status,
        200,
        "{}",
        String::from_utf8_lossy(&review.body)
    );
    provider.join().unwrap();
    let findings = body_json(&review);
    let verification = |n: usize| findings["findings"][n]["verification"].clone();
    assert_eq!(verification(0), "supplied-context", "{findings}");
    assert_eq!(
        verification(1),
        "unverified-advice",
        "advice that names no sample is marked unverified"
    );
    let outbound = captured.recv().unwrap();
    assert!(outbound.to_string().contains(MARK));
    assert!(!outbound.to_string().contains("FORGED"));
    assert!(!String::from_utf8_lossy(&review.body).contains("journey-secret"));

    // Moving the pair to portable and back is explicit and byte-preserving.
    let url = format!("/admin/api/voice/samples/{rough_id}/visibility");
    assert_eq!(
        call(&f, &s, "POST", &url, json!({ "visibility": "portable" })).0,
        200
    );
    assert!(f
        .dir
        .join("assistant/context/voice")
        .join(&rough_file)
        .exists());
    assert_eq!(
        call(&f, &s, "POST", &url, json!({ "visibility": "private" })).0,
        200
    );
    assert_eq!(fs::read(&rough_path).unwrap(), rough_bytes);

    // Erase: listed, confirmed with the typed word, then checked again.
    let (_, plan) = get(&f, &s, "/admin/api/voice/erase");
    assert!(!plan["items"].as_array().unwrap().is_empty());
    assert!(!plan.to_string().contains(MARK));
    let (status, done) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/erase",
        json!({ "confirm": "erase" }),
    );
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["clean"], true);
    assert_eq!(done["remaining"], json!([]));
    assert_eq!(get(&f, &s, "/admin/api/voice/erase").1["items"], json!([]));
    assert_eq!(
        get(&f, &s, "/admin/api/voice/samples").1["samples"],
        json!([])
    );
    let (_, context) = get(&f, &s, "/admin/api/assistant/context");
    assert_eq!(context["voiceSamples"], json!([]));
    // The post made from the polished draft is the author's own and stays.
    let left: Vec<String> = tree(&f.dir)
        .into_iter()
        .filter(|(name, bytes)| {
            (name.starts_with("assistant/") || name.starts_with(".openblog"))
                && String::from_utf8_lossy(bytes).contains(MARK)
        })
        .map(|(name, _)| name)
        .collect();
    assert!(left.is_empty(), "{left:?}");
}

/// Every voice route with the method, a path and whether it writes.
fn routes(id: &str) -> Vec<(&'static str, String, bool)> {
    let sample = format!("/admin/api/voice/samples/{id}");
    vec![
        ("GET", "/admin/api/voice/catalog".into(), false),
        ("GET", "/admin/api/voice/status".into(), false),
        ("POST", "/admin/api/voice/draw".into(), true),
        ("GET", "/admin/api/voice/session".into(), false),
        ("DELETE", "/admin/api/voice/session".into(), true),
        ("POST", "/admin/api/voice/session/start".into(), true),
        ("PUT", "/admin/api/voice/session/draft".into(), true),
        ("POST", "/admin/api/voice/session/lock".into(), true),
        ("GET", "/admin/api/voice/erase".into(), false),
        ("POST", "/admin/api/voice/erase".into(), true),
        (
            "GET",
            "/admin/api/voice/guide/move?to=private".into(),
            false,
        ),
        ("POST", "/admin/api/voice/guide/move".into(), true),
        ("GET", "/admin/api/voice/samples".into(), false),
        ("POST", "/admin/api/voice/samples".into(), true),
        ("GET", sample.clone(), false),
        ("PUT", sample.clone(), true),
        ("POST", format!("{sample}/visibility"), true),
        ("POST", format!("{sample}/promote"), true),
        ("GET", "/admin/api/assistant/context".into(), false),
        ("POST", GUIDE.into(), true),
        ("POST", "/admin/api/assistant/review".into(), true),
        ("POST", "/admin/api/assistant/complete".into(), true),
    ]
}

#[test]
fn every_voice_route_denies_unauthenticated_and_tokenless_calls_and_changes_nothing() {
    let f = fixture("voice-matrix-auth");
    let s = login_ok(&f);
    let (_, rough) = {
        let (status, session) = call(
            &f,
            &s,
            "POST",
            "/admin/api/voice/session/start",
            json!({ "promptId": "a-mistake-i-made" }),
        );
        assert_eq!(status, 201, "{session}");
        call(
            &f,
            &s,
            "POST",
            "/admin/api/voice/session/lock",
            json!({ "sessionId": session["sessionId"], "text": format!("words {MARK}") }),
        )
    };
    let id = rough["sample"]["id"].as_str().unwrap().to_string();
    let before = tree(&f.dir);
    for (method, path, writes) in routes(&id) {
        let bare = handle(&f.state, &json_req(method, &path, json!({ "x": MARK })));
        assert_eq!(bare.status, 401, "{method} {path} without a session");
        assert!(!String::from_utf8_lossy(&bare.body).contains(MARK));
        if !writes {
            continue;
        }
        let no_token = handle(
            &f.state,
            &authed(json_req(method, &path, json!({ "x": MARK })), &s, false),
        );
        assert_eq!(no_token.status, 403, "{method} {path} without a token");
        for (header, value) in [
            ("origin", "https://evil.example"),
            ("sec-fetch-site", "cross-site"),
        ] {
            let mut forged = authed(json_req(method, &path, json!({})), &s, true);
            forged.headers.insert(header.into(), value.into());
            assert_eq!(
                handle(&f.state, &forged).status,
                403,
                "{method} {path} {header}"
            );
        }
    }
    assert_eq!(tree(&f.dir), before, "a refused call changes nothing");
}

#[test]
fn a_body_over_its_limit_is_refused_on_every_writing_voice_route_before_it_is_parsed() {
    let f = fixture("voice-matrix-size");
    let s = login_ok(&f);
    let id = "2026-10-28-a-polished";
    let before = tree(&f.dir);
    for (method, path, writes) in routes(id) {
        if !writes || method == "DELETE" {
            continue;
        }
        let limit = preflight(&f.state, &authed(req(method, &path), &s, false));
        let Ok(limit) = limit else { continue };
        // The declared limit is small and fixed, never unbounded.
        assert!(limit <= 4 * 1024 * 1024, "{method} {path}: {limit}");
        let mut huge = json_req(method, &path, json!({}));
        huge.body = format!("{{\"text\":\"{}\"}}", "q".repeat(limit + 1)).into_bytes();
        let reply = handle(&f.state, &authed(huge, &s, true));
        assert!(
            reply.status == 413 || reply.status == 400,
            "{method} {path}: {}",
            reply.status
        );
        assert!(!String::from_utf8_lossy(&reply.body).contains("qqqq"));
    }
    assert_eq!(tree(&f.dir), before);
}

#[test]
fn hostile_ids_and_fields_never_leave_the_voice_folders() {
    let f = fixture("voice-matrix-ids");
    let s = login_ok(&f);
    let outside = f.dir.join("openblog.json");
    let config = fs::read(&outside).unwrap();
    let hostile = [
        "..",
        "..%2f..%2fopenblog.json",
        "..%5c..%5copenblog.json",
        "%2e%2e",
        "a%2fb",
        "a/b",
        "a\\b",
        "x%00",
        "Upper-Case",
        "dot.dot",
        &"a".repeat(161),
    ];
    let before = tree(&f.dir);
    for id in hostile {
        for (method, path, writes) in routes(id) {
            if !path.contains("/samples/") {
                continue;
            }
            let reply = handle(
                &f.state,
                &authed(
                    json_req(
                        method,
                        &path,
                        json!({ "visibility": "private", "dir": "../x" }),
                    ),
                    &s,
                    writes,
                ),
            );
            assert!(
                reply.status == 404 || reply.status == 405 || reply.status == 400,
                "{method} {path}: {}",
                reply.status
            );
            assert!(!String::from_utf8_lossy(&reply.body).contains(MARK));
        }
    }
    // Hostile values in bodies: a prompt, the rough draft a polish names, a folder to promote
    // into, a visibility, and Assistant context ids.
    let (status, session) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/session/start",
        json!({ "promptId": "../../openblog" }),
    );
    assert!((400..500).contains(&status), "{status} {session}");
    for rough_of in [
        "../openblog-rough.md",
        "..\\openblog-rough.md",
        "nothing-rough.md",
        "",
    ] {
        let (status, body) = call(
            &f,
            &s,
            "POST",
            "/admin/api/voice/samples",
            json!({ "roughOf": rough_of, "title": MARK, "body": MARK }),
        );
        assert!((400..500).contains(&status), "{rough_of}: {status}");
        assert!(!body.to_string().contains(MARK));
    }
    for bad in [
        "voice:private:../../openblog.json",
        "voice:portable:..%2f..%2fopenblog.json",
        "voice:private:a/b-rough.md",
        "voice:../private:x-rough.md",
    ] {
        for path in [
            "/admin/api/assistant/review",
            "/admin/api/assistant/complete",
            GUIDE,
        ] {
            let body = if path == GUIDE {
                json!({ "sampleIds": [bad] })
            } else {
                json!({
                    "source": { "title": "T", "metadata": {}, "markdown": "x", "prefix": "x", "suffix": "", "editorMode": "markdown" },
                    "skillIds": ["voice-review"],
                    "contextIds": [bad],
                })
            };
            let reply = post(&f, &s, path, body);
            assert_eq!(reply.status, 400, "{path} {bad}");
        }
    }
    assert_eq!(fs::read(&outside).unwrap(), config);
    assert_eq!(tree(&f.dir), before, "no hostile call wrote anything");
}

#[test]
fn a_rough_draft_cannot_be_changed_replaced_or_moved_over_by_any_route() {
    let f = fixture("voice-matrix-rough");
    let s = login_ok(&f);
    let (status, session) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/session/start",
        json!({ "promptId": "a-mistake-i-made" }),
    );
    assert_eq!(status, 201);
    let (_, locked) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/session/lock",
        json!({ "sessionId": session["sessionId"], "text": "original rough words" }),
    );
    let rough = locked["sample"].clone();
    let file = rough["file"].as_str().unwrap().to_string();
    let id = rough["id"].as_str().unwrap().to_string();
    let path = f.dir.join(rough["path"].as_str().unwrap());
    let bytes = fs::read(&path).unwrap();
    let url = format!("/admin/api/voice/samples/{id}");

    // Writes by every verb the route knows, with and without a revision.
    for body in [
        json!({ "body": MARK }),
        json!({ "revision": rough["revision"], "body": MARK }),
        json!({ "revision": rough["revision"], "body": MARK, "title": MARK, "stage": "polished" }),
        json!({ "revision": rough["revision"], "text": MARK }),
    ] {
        let (status, reply) = call(&f, &s, "PUT", &url, body);
        assert!((400..500).contains(&status), "{status} {reply}");
        assert!(!reply.to_string().contains(MARK));
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    assert!((400..500).contains(&call(&f, &s, "DELETE", &url, json!({})).0));
    // A second session on the same prompt cannot replace it, nor can a polished create name it.
    let (_, again) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/session/start",
        json!({ "promptId": "a-mistake-i-made" }),
    );
    let (status, second) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/session/lock",
        json!({ "sessionId": again["sessionId"], "text": format!("replacement {MARK}") }),
    );
    assert_eq!(fs::read(&path).unwrap(), bytes, "{status} {second}");
    // A polished draft of this rough draft, then a polished create naming the polished draft.
    let (status, polished) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/samples",
        json!({ "roughOf": file, "title": "T", "body": "polished" }),
    );
    assert_eq!(status, 201);
    let polished_file = polished["file"].as_str().unwrap();
    let (status, _) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/samples",
        json!({ "roughOf": polished_file, "title": "T", "body": "chain" }),
    );
    assert!((400..500).contains(&status), "{status}");
    // A visibility move onto a different file of the same name in the other folder is refused.
    fs::create_dir_all(f.dir.join("assistant/context/voice")).unwrap();
    let blocker = f.dir.join("assistant/context/voice").join(&file);
    fs::write(&blocker, "someone else's file").unwrap();
    let (status, moved) = call(
        &f,
        &s,
        "POST",
        &format!("{url}/visibility"),
        json!({ "visibility": "portable" }),
    );
    assert!((400..500).contains(&status), "{status} {moved}");
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(fs::read(&blocker).unwrap(), b"someone else's file");
    // A rough draft is not a post.
    assert!((400..500).contains(&call(&f, &s, "POST", &format!("{url}/promote"), json!({})).0));
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn a_late_save_never_reaches_the_rough_draft_and_other_sessions_ids_are_ignored() {
    let f = fixture("voice-matrix-deadline");
    let s = login_ok(&f);
    let (_, session) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/session/start",
        json!({ "promptId": "a-mistake-i-made" }),
    );
    let id = session["sessionId"].clone();
    let save = |session_id: &Json, text: &str| {
        call(
            &f,
            &s,
            "PUT",
            "/admin/api/voice/session/draft",
            json!({ "sessionId": session_id, "text": text }),
        )
    };
    assert_eq!(save(&id, "in time").0, 200);
    let stored = |f: &Fixture| fs::read_to_string(f.dir.join(SESSION_PATH)).unwrap();
    // A forged or stale session id changes nothing.
    let before = stored(&f);
    for forged in [json!("nope"), json!(""), json!(null), json!(7)] {
        let (status, body) = save(&forged, &format!("forged {MARK}"));
        assert!((400..500).contains(&status), "{status}");
        assert!(!body.to_string().contains(MARK));
    }
    assert_eq!(stored(&f), before);
    // Past the deadline a draft is refused, the record keeps the earlier text, and a lock past
    // the grace keeps the saved text, not what arrives with the request.
    age_session(&f, 400);
    let (status, late) = save(&id, &format!("late {MARK}"));
    assert_eq!(status, 409, "{late}");
    assert!(!late.to_string().contains(MARK));
    assert!(!stored(&f).contains(MARK));
    let (status, locked) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/session/lock",
        json!({ "sessionId": id, "text": format!("typed after the end {MARK}") }),
    );
    assert_eq!(status, 200, "{locked}");
    assert_eq!(locked["sample"]["body"], "in time");
    assert!(fs::read_dir(f.dir.join(".openblog/private/context/voice"))
        .unwrap()
        .flatten()
        .all(|e| !fs::read_to_string(e.path()).unwrap().contains(MARK)));
}

#[test]
fn a_guide_quoting_private_samples_never_reaches_a_portable_file_by_any_route() {
    let _env = quiz_env();
    let _key = EnvRestore::capture("OPENBLOG_LESSONS_API_KEY");
    let f = fixture("voice-matrix-leak");
    let s = login_ok(&f);
    write_guide_skill(&f);
    std::env::set_var("OPENBLOG_LESSONS_API_KEY", "leak-secret");
    let file = write_rough(
        &f.dir,
        Visibility::Private,
        "a-mistake-i-made",
        "stories",
        "2026-10-28",
        &format!("so i deleted the wrong folder {MARK}"),
    );
    let (endpoint, _captured, provider) = capturing_provider(guide_json(&file));
    set_quiz_endpoint(&f, &endpoint);
    let response = post(
        &f,
        &s,
        GUIDE,
        json!({ "sampleIds": [format!("voice:private:{file}")] }),
    );
    assert_eq!(response.status, 200);
    provider.join().unwrap();
    let markdown = body_json(&response)["markdown"]
        .as_str()
        .unwrap()
        .to_string();
    // Saving as portable, with or without a revision. (The guard reads the provenance comment;
    // an author who deletes that line by hand is editing their own file.)
    {
        let content = markdown.clone();
        for etag in [json!(null), json!("stale")] {
            let reply = handle(
                &f.state,
                &authed(
                    json_req(
                        "PUT",
                        "/admin/api/assistant/context",
                        json!({ "contextType": "voice", "visibility": "portable", "content": content, "etag": etag }),
                    ),
                    &s,
                    true,
                ),
            );
            let landed = f.dir.join("assistant/context/voice.md").exists();
            assert!(
                reply.status != 200 || !landed || !content.contains("so i deleted"),
                "a private quote reached the portable guide: {}",
                reply.status
            );
        }
    }
    // Saved as private, the guide cannot be moved to portable either (ADR 0289).
    let saved = handle(
        &f.state,
        &authed(
            json_req(
                "PUT",
                "/admin/api/assistant/context",
                json!({ "contextType": "voice", "visibility": "private", "content": markdown, "etag": null }),
            ),
            &s,
            true,
        ),
    );
    assert_eq!(saved.status, 200);
    let (status, _) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/guide/move",
        json!({ "to": "portable" }),
    );
    assert_eq!(status, 409);
    assert!(f.dir.join(".openblog/private/context/voice.md").exists());
    // The private sample itself moves to portable only by the explicit move, and then the
    // portable guide is allowed to quote it.
    assert!(
        !f.dir.join("assistant/context/voice.md").exists()
            || !fs::read_to_string(f.dir.join("assistant/context/voice.md"))
                .unwrap()
                .contains(MARK)
    );
    assert!(!String::from_utf8_lossy(&response.body).contains("leak-secret"));
}

#[test]
fn errors_from_every_voice_route_carry_no_sample_text_and_no_absolute_path() {
    let f = fixture("voice-matrix-quiet");
    let s = login_ok(&f);
    let (_, session) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/session/start",
        json!({ "promptId": "a-mistake-i-made" }),
    );
    let (_, locked) = call(
        &f,
        &s,
        "POST",
        "/admin/api/voice/session/lock",
        json!({ "sessionId": session["sessionId"], "text": format!("secret words {MARK}") }),
    );
    let id = locked["sample"]["id"].as_str().unwrap().to_string();
    let dir = f.dir.display().to_string();
    let dir_slash = dir.replace('\\', "/");
    let mut replies: Vec<(String, u16, String)> = Vec::new();
    for (method, path, writes) in routes(&id) {
        for body in [
            json!({}),
            json!([]),
            json!({ "text": MARK, "body": MARK, "revision": MARK, "sessionId": MARK, "roughOf": MARK, "promptId": MARK, "confirm": MARK, "visibility": MARK, "sampleIds": [MARK], "contextIds": [MARK] }),
        ] {
            let reply = handle(&f.state, &authed(json_req(method, &path, body), &s, writes));
            replies.push((
                format!("{method} {path}"),
                reply.status,
                String::from_utf8_lossy(&reply.body).into_owned(),
            ));
        }
    }
    for (label, status, body) in replies {
        if status >= 400 {
            // The sample text we stored must never come back in an error. What the caller sent
            // in the same request (the marker in their own body) is theirs to see, but the
            // stored words are not.
            assert!(!body.contains("secret words"), "{label} {status}: {body}");
            assert!(
                !body.contains(&dir) && !body.contains(&dir_slash),
                "{label}: {body}"
            );
        }
    }
}

/// A sample written at the terminal is the Admin's sample too (#428): the session the CLI runs
/// (surface `cli`, the same session and store calls `openblog voice` makes) is listed, offered as
/// context and used by the voice-guide proposal, with no Admin session involved.
#[test]
fn a_sample_written_at_the_terminal_is_listed_and_used_by_the_admin() {
    let _env = quiz_env();
    let _key = EnvRestore::capture("OPENBLOG_LESSONS_API_KEY");
    let f = fixture("voice-cli-to-admin");
    let s = login_ok(&f);
    write_guide_skill(&f);
    std::env::set_var("OPENBLOG_LESSONS_API_KEY", "journey-secret");

    // What `openblog voice a-mistake-i-made --stdin` does: start, save as it goes, lock.
    let catalog = crate::voice_store::load_catalog(&f.dir);
    let session = crate::voice_session::start(
        &f.dir,
        &catalog,
        "a-mistake-i-made",
        "cli",
        Visibility::Private,
        180,
        clock::now(),
    )
    .unwrap();
    let text = format!("so i deleted the wrong folder {MARK}");
    crate::voice_session::save_draft(&f.dir, Some(&session.id()), &text, clock::now()).unwrap();
    let locked = crate::voice_session::lock(
        &f.dir,
        Some(&session.id()),
        &catalog,
        Some(&text),
        None,
        clock::now(),
    )
    .unwrap();
    let file = locked.written.file;

    assert_eq!(get(&f, &s, "/admin/api/voice/session").1["state"], "none");
    let (_, list) = get(&f, &s, "/admin/api/voice/samples");
    let listed = list["samples"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["file"] == file.as_str())
        .cloned()
        .unwrap_or_else(|| panic!("{list}"));
    assert_eq!(listed["stage"], "rough");
    assert_eq!(listed["visibility"], "private");
    let (status, opened) = get(
        &f,
        &s,
        &format!(
            "/admin/api/voice/samples/{}",
            listed["id"].as_str().unwrap()
        ),
    );
    assert_eq!(status, 200, "{opened}");
    assert_eq!(opened["body"], text.as_str());
    assert_eq!(opened["readOnly"], true);

    let id = format!("voice:private:{file}");
    let (_, context) = get(&f, &s, "/admin/api/assistant/context");
    assert!(context["voiceSamples"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["id"] == id.as_str()));

    let (endpoint, captured, provider) = capturing_provider(guide_json(&file));
    set_quiz_endpoint(&f, &endpoint);
    let response = post(&f, &s, GUIDE, json!({ "sampleIds": [id] }));
    assert_eq!(
        response.status,
        200,
        "{}",
        String::from_utf8_lossy(&response.body)
    );
    provider.join().unwrap();
    let outbound = captured.recv().unwrap();
    assert!(outbound["untrustedData"]["context"][0]["content"]
        .as_str()
        .unwrap()
        .contains(MARK));
    assert_eq!(body_json(&response)["portableAllowed"], false);
}
