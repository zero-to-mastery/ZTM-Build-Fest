//! Admin business facts routes (ADR 0307, #508): deny by default, CSRF, validation in plain words,
//! stale writes, bounded bodies, and a write that changes only the `business` member of
//! `openblog.json` without reordering anything else.

use super::*;

const PATH: &str = "/admin/api/business";

/// Deliberately not alphabetical, with its own spacing: a save must keep all of it.
const CONFIG: &str = "{\n  \"url\": \"https://example.com\",\n  \"title\": \"Maple Falls Flooring\",\n  \"extraTrades\": [\"fencing\"],\n  \"nav\": [ { \"label\": \"About\", \"href\": \"/about/\" } ],\n  \"description\": \"Floors.\"\n}\n";

fn config_path(f: &Fixture) -> PathBuf {
    f.dir.join(site::CONFIG_FILE)
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

fn keys(text: &str) -> Vec<String> {
    let value: Json = serde_json::from_str(text).unwrap();
    // Key order is read from the text itself: serde_json would sort it.
    let mut found = Vec::new();
    for key in value.as_object().unwrap().keys() {
        found.push((text.find(&format!("\"{key}\"")).unwrap(), key.clone()));
    }
    found.sort();
    found.into_iter().map(|(_, key)| key).collect()
}

fn fixture_with_config(name: &str) -> Fixture {
    let f = fixture(name);
    fs::write(config_path(&f), CONFIG).unwrap();
    f
}

#[test]
fn the_business_routes_deny_by_default_and_require_csrf() {
    let f = fixture_with_config("business-auth");
    assert_eq!(handle(&f.state, &req("GET", PATH)).status, 401);
    assert_eq!(
        handle(&f.state, &json_req("PUT", PATH, json!({}))).status,
        401
    );
    let session = login_ok(&f);
    let body = json!({"etag": get(&f, &session)["etag"], "business": {"insured": true}});
    let no_csrf = handle(
        &f.state,
        &authed(json_req("PUT", PATH, body.clone()), &session, false),
    );
    assert_eq!(no_csrf.status, 403);
    assert_eq!(fs::read_to_string(config_path(&f)).unwrap(), CONFIG);
    assert_eq!(
        handle(&f.state, &authed(req("DELETE", PATH), &session, true)).status,
        404
    );
}

#[test]
fn reading_describes_the_block_and_the_choices() {
    let f = fixture_with_config("business-read");
    let session = login_ok(&f);
    let described = get(&f, &session);
    assert_eq!(described["business"], json!({}));
    assert_eq!(described["problems"], json!([]));
    assert_eq!(described["weekdays"].as_array().unwrap().len(), 7);
    assert_eq!(described["weekdays"][0]["id"], "monday");
    assert_eq!(described["paymentMethods"].as_array().unwrap().len(), 7);
    let trades = described["trades"].as_array().unwrap();
    assert!(trades.contains(&json!("flooring")) && trades.contains(&json!("fencing")));
}

#[test]
fn a_save_changes_only_the_business_member_and_keeps_every_other_key_where_it_was() {
    let f = fixture_with_config("business-save");
    let session = login_ok(&f);
    let etag = get(&f, &session)["etag"].clone();
    let response = put(
        &f,
        &session,
        json!({"etag": etag, "business": {
            "displayName": "Maple Falls Flooring",
            "phone": "(360) 555-0142",
            "trade": "flooring",
            "licenseNumber": "MAPLEF*123",
            "insured": true,
            "paymentMethods": ["cash", "check"],
            "hours": {"monday": {"open": "08:00", "close": "17:00"}, "sunday": {"closed": true}},
            "email": "",
            "legalName": "  "
        }}),
    );
    assert_eq!(
        response.status,
        200,
        "{}",
        String::from_utf8_lossy(&response.body)
    );
    let saved = body_json(&response);
    assert_eq!(saved["business"]["phone"], "+13605550142");
    assert_eq!(saved["buildError"], Json::Null);
    let text = fs::read_to_string(config_path(&f)).unwrap();
    assert!(
        text.starts_with(CONFIG.trim_end().trim_end_matches('}').trim_end()),
        "{text}"
    );
    assert_eq!(
        keys(&text),
        [
            "url",
            "title",
            "extraTrades",
            "nav",
            "description",
            "business"
        ]
    );
    assert!(text.contains("\"nav\": [ { \"label\": \"About\", \"href\": \"/about/\" } ],"));
    assert!(!text.contains("legalName") && !text.contains("\"email\""));
    // The public site now carries the facts.
    let home = fs::read_to_string(f.dir.join("dist/index.html")).unwrap();
    assert!(home.contains("(360) 555-0142") && home.contains("Licensed and insured"));

    // Saving again with the new revision keeps the order, and clearing removes only the member.
    let again = put(
        &f,
        &session,
        json!({"etag": saved["etag"], "business": {"displayName": "Maple Falls"}}),
    );
    assert_eq!(again.status, 200);
    let cleared = put(
        &f,
        &session,
        json!({"etag": body_json(&again)["etag"], "business": {}}),
    );
    assert_eq!(cleared.status, 200);
    assert_eq!(fs::read_to_string(config_path(&f)).unwrap(), CONFIG);
}

#[test]
fn bad_facts_fail_with_plain_messages_and_write_nothing() {
    let f = fixture_with_config("business-invalid");
    let session = login_ok(&f);
    let etag = get(&f, &session)["etag"].clone();
    let response = put(
        &f,
        &session,
        json!({"etag": etag, "business": {
            "phone": "call us",
            "email": "nope",
            "foundedYear": 1066,
            "paymentMethods": ["bitcoin"],
            "hours": {"monday": {"open": "18:00", "close": "09:00"}}
        }}),
    );
    assert_eq!(response.status, 422);
    let body = body_json(&response);
    let problems = body["problems"].as_array().unwrap();
    let fields: Vec<&str> = problems
        .iter()
        .map(|p| p["field"].as_str().unwrap())
        .collect();
    for field in ["phone", "email", "foundedYear", "paymentMethods", "hours"] {
        assert!(fields.contains(&field), "{field}: {body}");
    }
    let hours = problems.iter().find(|p| p["field"] == "hours").unwrap();
    assert_eq!(hours["day"], "monday");
    assert!(!body.to_string().contains("call us"), "{body}");
    assert_eq!(fs::read_to_string(config_path(&f)).unwrap(), CONFIG);

    // A trade the site does not know is refused without repeating it.
    let unknown = put(
        &f,
        &session,
        json!({"etag": etag, "business": {"trade": "wizardry"}}),
    );
    assert_eq!(unknown.status, 422);
    let text = String::from_utf8_lossy(&unknown.body).to_string();
    assert!(
        text.contains("\"field\":\"trade\"") && !text.contains("wizardry"),
        "{text}"
    );
    assert_eq!(fs::read_to_string(config_path(&f)).unwrap(), CONFIG);
}

#[test]
fn a_stale_save_conflicts_and_an_unrelated_save_does_not() {
    let f = fixture_with_config("business-stale");
    let session = login_ok(&f);
    let first = get(&f, &session);
    let saved = put(
        &f,
        &session,
        json!({"etag": first["etag"], "business": {"insured": true}}),
    );
    assert_eq!(saved.status, 200);
    let stale = put(
        &f,
        &session,
        json!({"etag": first["etag"], "business": {"insured": false, "displayName": "X"}}),
    );
    assert_eq!(stale.status, 409);
    let body = body_json(&stale);
    assert_eq!(body["business"]["insured"], true);
    assert!(body["error"].as_str().unwrap().contains("changed"));
    // An edit made elsewhere in the file does not make the block stale.
    let text = fs::read_to_string(config_path(&f)).unwrap();
    fs::write(config_path(&f), text.replace("Floors.", "Better floors.")).unwrap();
    let after = put(
        &f,
        &session,
        json!({"etag": body["etag"], "business": {"insured": true, "displayName": "Y"}}),
    );
    assert_eq!(
        after.status,
        200,
        "{}",
        String::from_utf8_lossy(&after.body)
    );
    assert!(fs::read_to_string(config_path(&f))
        .unwrap()
        .contains("Better floors."));
}

#[test]
fn fields_a_newer_release_wrote_survive_a_save() {
    let f = fixture_with_config("business-extra");
    let session = login_ok(&f);
    let text = fs::read_to_string(config_path(&f)).unwrap();
    let with = text.replace(
        "\"description\"",
        "\"business\": {\"version\": 1, \"insured\": true, \"x-future\": {\"keep\": 1}},\n  \"description\"",
    );
    fs::write(config_path(&f), with).unwrap();
    let described = get(&f, &session);
    let saved = put(
        &f,
        &session,
        json!({"etag": described["etag"], "business": {"insured": true, "displayName": "Z"}}),
    );
    assert_eq!(saved.status, 200);
    assert_eq!(
        body_json(&saved)["business"]["x-future"],
        json!({"keep": 1})
    );
}

#[test]
fn an_oversized_body_is_refused_before_it_is_read() {
    let f = fixture_with_config("business-bounds");
    let session = login_ok(&f);
    let allowed = preflight(&f.state, &authed(req("PUT", PATH), &session, true)).unwrap();
    assert_eq!(allowed, business::MAX_REQUEST_BYTES);
    let big = "x".repeat(business::MAX_REQUEST_BYTES + 1);
    let response = put(
        &f,
        &session,
        json!({"etag": "a", "business": {"displayName": big}}),
    );
    assert_eq!(response.status, 413);
    assert_eq!(fs::read_to_string(config_path(&f)).unwrap(), CONFIG);
}
