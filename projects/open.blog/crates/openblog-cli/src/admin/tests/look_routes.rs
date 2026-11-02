//! Admin look routes (ADR 0248, #349): deny by default, CSRF, validation, stale writes, bounded
//! bodies, an atomic write that touches only `appearance`, and the rebuilt site.

use super::*;

const PATH: &str = "/admin/api/look";

fn read_config(f: &Fixture) -> Json {
    serde_json::from_str(&fs::read_to_string(f.dir.join(site::CONFIG_FILE)).unwrap()).unwrap()
}

fn get(f: &Fixture, session: &(String, String)) -> Json {
    let response = handle(&f.state, &authed(req("GET", PATH), session, false));
    assert_eq!(
        response.status,
        200,
        "{}",
        String::from_utf8_lossy(&response.body)
    );
    body_json(&response)
}

fn put(f: &Fixture, session: &(String, String), body: Json) -> Response {
    handle(
        &f.state,
        &authed(json_req("PUT", PATH, body), session, true),
    )
}

fn tokens(f: &Fixture) -> String {
    fs::read_to_string(f.dir.join("dist/themes/base/tokens.css")).unwrap()
}

#[test]
fn the_look_routes_deny_by_default_and_require_csrf() {
    let f = fixture("look-auth");
    assert_eq!(handle(&f.state, &req("GET", PATH)).status, 401);
    assert_eq!(
        handle(&f.state, &json_req("PUT", PATH, json!({}))).status,
        401
    );
    let session = login_ok(&f);
    let body = json!({"etag": get(&f, &session)["etag"], "look": {"roundness": "round"}});
    // A session without the CSRF token cannot write.
    let no_csrf = handle(
        &f.state,
        &authed(json_req("PUT", PATH, body.clone()), &session, false),
    );
    assert_eq!(no_csrf.status, 403);
    assert!(read_config(&f).get("appearance").is_none());
    // A cross-site style request (wrong token) is also refused.
    let mut forged = authed(json_req("PUT", PATH, body), &session, false);
    forged
        .headers
        .insert("x-csrf-token".into(), "not-the-token".into());
    assert_eq!(handle(&f.state, &forged).status, 403);
    assert!(read_config(&f).get("appearance").is_none());
    // Other methods are not routes.
    assert_eq!(
        handle(&f.state, &authed(req("DELETE", PATH), &session, true)).status,
        404
    );
}

#[test]
fn reading_the_look_describes_what_the_theme_honors() {
    let f = fixture("look-read");
    let session = login_ok(&f);
    let look = get(&f, &session);
    assert_eq!(look["version"], 1);
    assert_eq!(look["look"], json!({}));
    assert!(look["etag"].as_str().is_some_and(|e| e.len() == 16));
    assert_eq!(look["honored"].as_array().unwrap().len(), 8);
    assert!(look["note"].is_null());
    assert_eq!(look["looks"].as_array().unwrap().len(), 8);
    assert!(look["choices"]["textSize"]
        .as_array()
        .unwrap()
        .contains(&json!("extra-large")));

    // A theme that honors only some controls says so, kindly.
    let dir = f.dir.join("themes/plain");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("theme.json"),
        r#"{"label":"Plain","extends":"base","customizable":["accent","roundness"]}"#,
    )
    .unwrap();
    let mut config = read_config(&f);
    config["theme"] = json!("plain");
    fs::write(
        f.dir.join(site::CONFIG_FILE),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .unwrap();
    let limited = get(&f, &session);
    assert_eq!(limited["honored"], json!(["accent", "roundness"]));
    assert!(limited["note"].as_str().unwrap().contains("Plain"));
    let hidden: Vec<&str> = limited["controls"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["honored"] == false)
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert!(hidden.contains(&"fontStyle") && !hidden.contains(&"accent"));
}

#[test]
fn a_save_changes_only_appearance_and_rebuilds_the_site() {
    let f = fixture("look-save");
    let session = login_ok(&f);
    let before_tokens = tokens(&f);
    let before_home = fs::read_to_string(f.dir.join("dist/index.html")).unwrap();
    let mut config = read_config(&f);
    config["futureSetting"] = json!({"keep": true});
    fs::write(
        f.dir.join(site::CONFIG_FILE),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .unwrap();
    let before = read_config(&f);

    let current = get(&f, &session);
    let saved = put(
        &f,
        &session,
        json!({
            "etag": current["etag"],
            "look": {"version": 1, "accent": "#B5451B", "roundness": "square", "textSize": "large"}
        }),
    );
    assert_eq!(
        saved.status,
        200,
        "{}",
        String::from_utf8_lossy(&saved.body)
    );
    let result = body_json(&saved);
    assert!(result["buildError"].is_null());
    assert_ne!(result["etag"], current["etag"]);
    assert_eq!(result["look"]["accent"], "#b5451b");

    // Everything but `appearance` is exactly as it was.
    let mut after = read_config(&f);
    let appearance = after.as_object_mut().unwrap().remove("appearance").unwrap();
    assert_eq!(after, before);
    assert_eq!(appearance["roundness"], "square");
    assert_eq!(appearance["version"], 1);
    assert!(site::load_config(&f.dir).is_ok());
    assert!(!f.dir.join("openblog.md.tmp").exists() && !f.dir.join("openblog.json.tmp").exists());

    // The built site carries the look, and the page links its hashed stylesheet.
    let after_tokens = tokens(&f);
    assert!(after_tokens.starts_with(&before_tokens));
    assert!(
        after_tokens.contains("--ob-radius: 0;")
            && after_tokens.contains("--ob-text-scale: 1.125;")
    );
    let home = fs::read_to_string(f.dir.join("dist/index.html")).unwrap();
    let marker = "/themes/base/tokens.css?v=";
    let at = home
        .find(marker)
        .expect("the page links the hashed stylesheet")
        + marker.len();
    assert!(home[at..at + 16].bytes().all(|b| b.is_ascii_hexdigit()));
    assert_ne!(home, before_home);

    // Resetting removes the key and returns the site to exactly what it was.
    let reset = put(&f, &session, json!({"etag": result["etag"], "look": null}));
    assert_eq!(reset.status, 200);
    assert_eq!(read_config(&f), before);
    assert_eq!(tokens(&f), before_tokens);
    let home = fs::read_to_string(f.dir.join("dist/index.html")).unwrap();
    assert_eq!(
        home, before_home,
        "a reset page is byte-identical to the original"
    );
}

#[test]
fn invalid_looks_are_refused_with_plain_messages_and_change_nothing() {
    let f = fixture("look-invalid");
    let session = login_ok(&f);
    let etag = get(&f, &session)["etag"].clone();
    let bytes = fs::read(f.dir.join(site::CONFIG_FILE)).unwrap();
    for look in [
        json!({"accent": "red;}"}),
        json!({"accent": "url(https://evil.test/x)"}),
        json!({"roundness": "blob"}),
        json!({"textSize": 3}),
        json!({"palette": "neon"}),
        json!({"version": 2}),
        json!("calm"),
        json!(["calm"]),
    ] {
        let refused = put(&f, &session, json!({"etag": etag, "look": look}));
        assert_eq!(refused.status, 422, "{look}");
        let message = body_json(&refused)["error"].as_str().unwrap().to_string();
        assert!(!message.is_empty() && message.len() < 400, "{message}");
    }
    assert_eq!(
        put(&f, &session, json!({"look": {"spacing": "airy"}})).status,
        422,
        "an etag is required"
    );
    assert_eq!(fs::read(f.dir.join(site::CONFIG_FILE)).unwrap(), bytes);
    // Not JSON, or the wrong type.
    let mut text = authed(req("PUT", PATH), &session, true);
    text.headers
        .insert("content-type".into(), "text/plain".into());
    text.body = b"{}".to_vec();
    assert_eq!(handle(&f.state, &text).status, 415);
    let garbage = authed(
        {
            let mut r = req("PUT", PATH);
            r.headers
                .insert("content-type".into(), "application/json".into());
            r.body = b"{nope".to_vec();
            r
        },
        &session,
        true,
    );
    assert_eq!(handle(&f.state, &garbage).status, 400);
    assert_eq!(fs::read(f.dir.join(site::CONFIG_FILE)).unwrap(), bytes);
}

#[test]
fn oversized_bodies_are_rejected() {
    let f = fixture("look-size");
    let session = login_ok(&f);
    let etag = get(&f, &session)["etag"].clone();
    // The listener refuses to read more than the route allows...
    assert_eq!(
        preflight(&f.state, &authed(req("PUT", PATH), &session, true)).unwrap(),
        look::MAX_REQUEST_BYTES
    );
    // ...and the handler checks again.
    let big = "x".repeat(look::MAX_REQUEST_BYTES);
    let response = put(
        &f,
        &session,
        json!({"etag": etag, "look": {"padding": big}}),
    );
    assert_eq!(response.status, 413);
    assert!(read_config(&f).get("appearance").is_none());
}

#[test]
fn a_stale_write_conflicts_and_returns_the_current_revision() {
    let f = fixture("look-stale");
    let session = login_ok(&f);
    let first = get(&f, &session);
    let saved = body_json(&put(
        &f,
        &session,
        json!({"etag": first["etag"], "look": {"spacing": "airy"}}),
    ));
    // A second editor still holding the first revision loses cleanly.
    let stale = put(
        &f,
        &session,
        json!({"etag": first["etag"], "look": {"spacing": "compact"}}),
    );
    assert_eq!(stale.status, 409);
    let conflict = body_json(&stale);
    assert_eq!(conflict["etag"], saved["etag"]);
    assert_eq!(conflict["look"]["spacing"], "airy");
    assert_eq!(read_config(&f)["appearance"]["spacing"], "airy");
}

#[test]
fn unrelated_saves_do_not_conflict_and_unknown_look_fields_survive() {
    let f = fixture("look-merge");
    let session = login_ok(&f);
    // A newer engine's field inside `appearance` is kept through a save.
    let mut config = read_config(&f);
    config["appearance"] = json!({"version": 1, "futureKnob": {"a": 1}, "roundness": "soft"});
    fs::write(
        f.dir.join(site::CONFIG_FILE),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .unwrap();
    let current = get(&f, &session);
    // Another part of the file changes (for example a landing section saved elsewhere).
    let mut config = read_config(&f);
    config["home"]["heading"] = json!("Changed elsewhere");
    fs::write(
        f.dir.join(site::CONFIG_FILE),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .unwrap();
    let saved = put(
        &f,
        &session,
        json!({"etag": current["etag"], "look": {"roundness": "round"}}),
    );
    assert_eq!(
        saved.status,
        200,
        "{}",
        String::from_utf8_lossy(&saved.body)
    );
    let after = read_config(&f);
    assert_eq!(after["home"]["heading"], "Changed elsewhere");
    assert_eq!(after["appearance"]["roundness"], "round");
    assert_eq!(after["appearance"]["futureKnob"], json!({"a": 1}));
}

#[test]
fn a_save_that_would_break_the_site_leaves_the_file_untouched() {
    let f = fixture("look-atomic");
    let session = login_ok(&f);
    let etag = get(&f, &session)["etag"].clone();
    // The theme disappears after the editor loaded: the candidate no longer loads, so nothing is written.
    let mut config = read_config(&f);
    config["theme"] = json!("gone");
    fs::write(
        f.dir.join(site::CONFIG_FILE),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .unwrap();
    let bytes = fs::read(f.dir.join(site::CONFIG_FILE)).unwrap();
    let refused = put(
        &f,
        &session,
        json!({"etag": etag, "look": {"accent": "#336699"}}),
    );
    assert_eq!(refused.status, 422);
    assert_eq!(fs::read(f.dir.join(site::CONFIG_FILE)).unwrap(), bytes);
}

#[test]
fn a_look_preview_is_built_from_the_unsaved_look_and_writes_nothing() {
    let f = fixture("look-preview");
    let session = login_ok(&f);
    let before = fs::read_to_string(f.dir.join(site::CONFIG_FILE)).unwrap();
    let preview = |body: Json| {
        handle(
            &f.state,
            &authed(
                json_req("POST", "/admin/api/look/preview", body),
                &session,
                true,
            ),
        )
    };
    // Denied without a session or without the CSRF token.
    let path = "/admin/api/look/preview";
    assert_eq!(
        handle(&f.state, &json_req("POST", path, json!({}))).status,
        401
    );
    let no_csrf = handle(
        &f.state,
        &authed(json_req("POST", path, json!({})), &session, false),
    );
    assert_eq!(no_csrf.status, 403);
    // A bad look is refused in plain words and builds nothing.
    assert_eq!(
        preview(json!({"look": {"roundness": "pointy"}})).status,
        422
    );
    assert_eq!(preview(json!({"look": {}, "mode": "purple"})).status, 422);
    let ok = preview(json!({"look": {"roundness": "round", "accent": "#aa2222"}, "mode": "dark"}));
    assert_eq!(ok.status, 200, "{}", String::from_utf8_lossy(&ok.body));
    let answer = body_json(&ok);
    assert!(answer["previewUrl"]
        .as_str()
        .unwrap()
        .starts_with("/admin/api/preview/"));
    assert_eq!(answer["refused"], false);
    let document = handle(
        &f.state,
        &authed(
            req("GET", answer["previewUrl"].as_str().unwrap()),
            &session,
            false,
        ),
    );
    let html = String::from_utf8_lossy(&document.body).to_string();
    assert!(html.contains("data-theme=\"dark\""), "{html}");
    assert!(html.contains("<style>"));
    assert!(!html.contains("/themes/base/tokens.css"));
    // Nothing was saved and the stored look is untouched.
    assert_eq!(
        fs::read_to_string(f.dir.join(site::CONFIG_FILE)).unwrap(),
        before
    );
    assert!(read_config(&f).get("appearance").is_none());
}
