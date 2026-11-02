//! Admin reading-path routes (ADR 0213, #77): deny by default, CSRF, stale
//! writes, the content lock, atomic canonical writes, source mode, published
//! targets only, privacy and hostile input.

use super::*;
use openblog_core::reading_path::MAX_FILE_BYTES;
use std::collections::BTreeMap;

const SECRET: &str = "SECRET-DRAFT-TITLE-7";

fn path_file(f: &Fixture, slug: &str) -> PathBuf {
    f.dir.join("content/paths").join(format!("{slug}.json"))
}

fn write_post(f: &Fixture, name: &str, front: &str) {
    fs::write(
        f.dir.join("content/posts").join(format!("{name}.md")),
        format!("---\ntitle: {name}\n{front}---\nBody of {name}.\n"),
    )
    .unwrap();
}

fn site_with_posts(tag: &str) -> Fixture {
    let f = fixture(&format!("paths-{tag}"));
    write_post(
        &f,
        "alpha",
        "date: 2026-01-01
",
    );
    write_post(
        &f,
        "bravo",
        "date: 2026-01-02
",
    );
    write_post(
        &f,
        "charlie",
        "date: 2026-01-03
",
    );
    fs::write(
        f.dir.join("content/posts/drafty.md"),
        format!(
            "---
title: {SECRET}
date: 2026-01-04
draft: true
---
Hidden.
"
        ),
    )
    .unwrap();
    fs::write(
        f.dir.join("content/posts/later.md"),
        format!(
            "---
title: {SECRET} later
date: 2099-01-01
---
Hidden.
"
        ),
    )
    .unwrap();
    f
}

fn step(id: &str, slug: &str, with_transition: bool) -> Json {
    let mut s = json!({"id": id, "target": {"kind": "post", "slug": slug}});
    if with_transition {
        s["transition"] = json!({"relationship": "next", "why": "It continues the thread."});
    }
    s
}

fn body_of(slug: &str, title: &str, status: &str, steps: Json) -> Json {
    json!({"slug": slug, "path": {"title": title, "status": status, "steps": steps}})
}

fn get_path(f: &Fixture, session: &(String, String), slug: &str) -> (u16, Json) {
    let r = handle(
        &f.state,
        &authed(
            req("GET", &format!("/admin/api/reading-paths/path?slug={slug}")),
            session,
            false,
        ),
    );
    (r.status, body_json(&r))
}

fn create(f: &Fixture, session: &(String, String), body: Json) -> (u16, Json) {
    source_call(f, session, "POST", "/admin/api/reading-paths", body)
}

fn update(f: &Fixture, session: &(String, String), mut body: Json, revision: &Json) -> (u16, Json) {
    body["revision"] = revision.clone();
    source_call(f, session, "PUT", "/admin/api/reading-paths", body)
}

fn stored(f: &Fixture, slug: &str) -> Option<String> {
    fs::read_to_string(path_file(f, slug)).ok()
}

fn three_steps() -> Json {
    json!([
        step("one", "alpha", false),
        step("two", "bravo", true),
        step("three", "charlie", true)
    ])
}

#[test]
fn every_route_requires_a_session_and_every_write_a_csrf_token() {
    let f = site_with_posts("every_route_requires_a_session");
    for (method, path) in [
        ("GET", "/admin/api/reading-paths"),
        ("GET", "/admin/api/reading-paths/targets"),
        ("GET", "/admin/api/reading-paths/path?slug=x"),
        ("POST", "/admin/api/reading-paths"),
        ("PUT", "/admin/api/reading-paths"),
        ("DELETE", "/admin/api/reading-paths?slug=x&revision=y"),
        ("POST", "/admin/api/reading-paths/preview"),
        ("POST", "/admin/api/reading-paths/reorder"),
    ] {
        assert_eq!(
            handle(&f.state, &req(method, path)).status,
            401,
            "{method} {path}"
        );
    }
    let session = login_ok(&f);
    for (method, path) in [
        ("POST", "/admin/api/reading-paths"),
        ("PUT", "/admin/api/reading-paths"),
        ("DELETE", "/admin/api/reading-paths?slug=x&revision=y"),
        ("POST", "/admin/api/reading-paths/preview"),
        ("POST", "/admin/api/reading-paths/reorder"),
    ] {
        let without = handle(
            &f.state,
            &authed(
                json_req(method, path, body_of("x", "T", "draft", json!([]))),
                &session,
                false,
            ),
        );
        assert_eq!(without.status, 403, "{method} {path} without a CSRF token");
    }
    // Deny by default: a name no route owns is not found, and so is another verb.
    for (method, path) in [
        ("GET", "/admin/api/reading-paths/nope"),
        ("PATCH", "/admin/api/reading-paths"),
        ("DELETE", "/admin/api/reading-paths/targets"),
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
    assert!(
        !f.dir.join("content/paths").exists(),
        "a refused call writes nothing"
    );
}

#[test]
fn a_path_is_created_listed_edited_and_written_canonically() {
    let f = site_with_posts("a_path_is_created_listed_edite");
    let session = login_ok(&f);
    let (status, created) = create(
        &f,
        &session,
        body_of("tour", "A tour", "draft", three_steps()),
    );
    assert_eq!(status, 201, "{created}");
    assert_eq!(created["valid"], true);
    let text = stored(&f, "tour").expect("the file is written");
    assert_eq!(
        created["source"],
        text.as_str(),
        "the response carries what was written"
    );
    assert!(text.starts_with("{\n  \"format\": \"openblog-reading-path\""));
    assert!(text.ends_with("}\n") && !text.contains('\r'));
    // Nothing else is left beside it.
    let names: Vec<_> = fs::read_dir(f.dir.join("content/paths"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["tour.json"]);

    let list = handle(
        &f.state,
        &authed(req("GET", "/admin/api/reading-paths"), &session, false),
    );
    let list = body_json(&list);
    assert_eq!(list["publish"], false);
    assert_eq!(list["items"][0]["slug"], "tour");
    assert_eq!(list["items"][0]["steps"], 3);
    assert_eq!(list["items"][0]["shown"], true);

    // Creating the same slug again is refused and changes nothing.
    let (status, again) = create(
        &f,
        &session,
        body_of("tour", "Other", "draft", three_steps()),
    );
    assert_eq!(status, 409, "{again}");
    assert_eq!(stored(&f, "tour").unwrap(), text);

    // Edit: publish it. The revision is the stored bytes' hash.
    let mut edited = body_of("tour", "A better tour", "published", three_steps());
    edited["path"]["summary"] = json!("Three posts.");
    let (status, saved) = update(&f, &session, edited, &created["revision"]);
    assert_eq!(status, 200, "{saved}");
    assert_ne!(saved["revision"], created["revision"]);
    assert_eq!(saved["path"]["title"], "A better tour");
    assert_eq!(saved["projection"]["asPublished"], false);
    assert_eq!(
        saved["projection"]["public"]["steps"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn a_stale_save_is_refused_with_the_newer_copy_and_changes_nothing() {
    let f = site_with_posts("a_stale_save_is_refused_with_t");
    let session = login_ok(&f);
    let (_, created) = create(
        &f,
        &session,
        body_of("tour", "A tour", "draft", three_steps()),
    );
    let (status, first) = update(
        &f,
        &session,
        body_of("tour", "First edit", "draft", three_steps()),
        &created["revision"],
    );
    assert_eq!(status, 200);
    let before = stored(&f, "tour").unwrap();
    // A second tab still holds the first revision.
    let (status, stale) = update(
        &f,
        &session,
        body_of("tour", "Stale edit", "draft", three_steps()),
        &created["revision"],
    );
    assert_eq!(status, 409, "{stale}");
    assert_eq!(stale["conflict"], true);
    assert_eq!(stale["revision"], first["revision"]);
    assert_eq!(stale["current"]["path"]["title"], "First edit");
    assert_eq!(stored(&f, "tour").unwrap(), before);
    // A hand edit on disk is a stale write too.
    fs::write(
        path_file(&f, "tour"),
        before.replace("First edit", "Hand edit"),
    )
    .unwrap();
    let (status, _) = update(
        &f,
        &session,
        body_of("tour", "Mine", "draft", three_steps()),
        &first["revision"],
    );
    assert_eq!(status, 409);
    assert!(stored(&f, "tour").unwrap().contains("Hand edit"));
    // Updating a path that has no file is not found, and writes no file.
    let (status, _) = update(
        &f,
        &session,
        body_of("ghost", "Ghost", "draft", json!([])),
        &json!("0"),
    );
    assert_eq!(status, 404);
    assert!(!path_file(&f, "ghost").exists());
}

#[test]
fn a_held_content_lock_refuses_the_write_and_leaves_the_file_alone() {
    let f = site_with_posts("a_held_content_lock_refuses_th");
    let session = login_ok(&f);
    let (_, created) = create(
        &f,
        &session,
        body_of("tour", "A tour", "draft", three_steps()),
    );
    let before = stored(&f, "tour").unwrap();
    let _held = crate::transaction::ContentTransactionLock::acquire(&f.dir).unwrap();
    let (status, body) = update(
        &f,
        &session,
        body_of("tour", "Edit", "draft", three_steps()),
        &created["revision"],
    );
    assert_eq!(status, 409, "{body}");
    assert_eq!(stored(&f, "tour").unwrap(), before);
    let (status, _) = create(&f, &session, body_of("other", "O", "draft", json!([])));
    assert_eq!(status, 409);
    assert!(!path_file(&f, "other").exists());
}

#[test]
fn source_mode_round_trips_losslessly_and_saves_canonically() {
    let f = site_with_posts("source_mode_round_trips_lossle");
    let session = login_ok(&f);
    // Messy source with a field this release does not define, in odd order.
    let source = r#"{"steps":[{"id":"one","target":{"slug":"alpha","kind":"post","x-t":1},"note":"keep me"},
        {"transition":{"why":"w","relationship":"next"},"target":{"kind":"post","slug":"bravo"},"id":"two"}],
        "title":"Source","status":"draft","version":1,"format":"openblog-reading-path","x-future":{"b":2,"a":1}}"#;
    let (status, created) = create(&f, &session, json!({"slug": "src", "source": source}));
    assert_eq!(status, 201, "{created}");
    let text = stored(&f, "src").unwrap();
    assert!(
        text.contains("\"x-future\"") && text.contains("keep me") && text.contains("\"x-t\": 1")
    );
    // The canonical text is a fixed point: saving what source mode shows changes nothing.
    let (status, saved) = update(
        &f,
        &session,
        json!({"slug": "src", "source": created["source"]}),
        &created["revision"],
    );
    assert_eq!(status, 200, "{saved}");
    assert_eq!(stored(&f, "src").unwrap(), text);
    assert_eq!(
        saved["revision"], created["revision"],
        "same bytes, same revision"
    );
    // The form model carries the unknown fields too, so a form save keeps them.
    let (_, got) = get_path(&f, &session, "src");
    let (status, form) = update(
        &f,
        &session,
        json!({"slug": "src", "path": got["path"]}),
        &got["revision"],
    );
    assert_eq!(status, 200, "{form}");
    assert_eq!(stored(&f, "src").unwrap(), text);
    // Invalid source is refused with scoped problems and the file is unchanged.
    let (status, bad) = update(
        &f,
        &session,
        json!({"slug": "src", "source": "{\"title\": \"x\" nope"}),
        &got["revision"],
    );
    assert_eq!(status, 422, "{bad}");
    assert_eq!(stored(&f, "src").unwrap(), text);
}

#[test]
fn a_step_needs_its_why_and_a_relationship_and_failures_are_step_scoped() {
    let f = site_with_posts("a_step_needs_its_why_and_a_rel");
    let session = login_ok(&f);
    let (status, body) = create(
        &f,
        &session,
        body_of(
            "tour",
            "T",
            "draft",
            json!([step("one", "alpha", false), step("two", "bravo", false)]),
        ),
    );
    assert_eq!(status, 422, "{body}");
    assert_eq!(body["problems"][0]["step"], "two");
    assert!(body["problems"][0]["message"]
        .as_str()
        .unwrap()
        .contains("say why"));
    let mut blank = step("two", "bravo", true);
    blank["transition"]["why"] = json!("   ");
    let (status, body) = create(
        &f,
        &session,
        body_of(
            "tour",
            "T",
            "draft",
            json!([step("one", "alpha", false), blank]),
        ),
    );
    assert_eq!(status, 422, "{body}");
    let mut none = step("two", "bravo", false);
    none["transition"] = json!({"why": "because"});
    let (status, body) = create(
        &f,
        &session,
        body_of(
            "tour",
            "T",
            "draft",
            json!([step("one", "alpha", false), none]),
        ),
    );
    assert_eq!(status, 422, "{body}");
    assert!(body["problems"][0]["message"]
        .as_str()
        .unwrap()
        .contains("`transition.relationship` is required"));
    assert!(!path_file(&f, "tour").exists());
}

#[test]
fn only_published_posts_and_public_entries_can_be_picked_and_unpublished_steps_are_flagged() {
    let f = site_with_posts("only_published_posts_and_publi");
    let session = login_ok(&f);
    let r = handle(
        &f.state,
        &authed(
            req("GET", "/admin/api/reading-paths/targets"),
            &session,
            false,
        ),
    );
    let targets = body_json(&r);
    let slugs: Vec<&str> = targets["posts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["slug"].as_str().unwrap())
        .collect();
    assert!(
        slugs.contains(&"alpha") && slugs.contains(&"hello-world"),
        "{slugs:?}"
    );
    assert!(
        !slugs.contains(&"drafty") && !slugs.contains(&"later"),
        "{slugs:?}"
    );
    assert!(!String::from_utf8_lossy(&r.body).contains(SECRET));
    assert_eq!(targets["entries"], json!([]), "no atlas is published");

    // A path that names a draft, a scheduled post, a missing post and an
    // atlas entry that is not public is saved, and each is flagged.
    let steps = json!([
        step("one", "alpha", false),
        step("two", "drafty", true),
        step("three", "later", true),
        step("four", "no-such-post", true),
        step("five", "bravo", true),
    ]);
    let (status, saved) = create(&f, &session, body_of("flags", "Flags", "published", steps));
    assert_eq!(status, 201, "{saved}");
    let states: Vec<(&str, &str)> = saved["states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["id"].as_str().unwrap(), s["state"].as_str().unwrap()))
        .collect();
    assert_eq!(
        states,
        [
            ("one", "published"),
            ("two", "draft"),
            ("three", "scheduled"),
            ("four", "missing"),
            ("five", "published")
        ]
    );
    // A required step is missing, so the public path is withheld whole and
    // the author is told why; the projection never names the draft's title.
    assert_eq!(saved["projection"]["withheld"], true);
    assert!(saved["projection"]["public"].is_null());
    let projection = saved["projection"].to_string();
    assert!(!projection.contains(SECRET), "{projection}");
    assert!(saved["projection"]["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["kind"] == "PathWithheld"));
    // The list reports it is not shown.
    let list = body_json(&handle(
        &f.state,
        &authed(req("GET", "/admin/api/reading-paths"), &session, false),
    ));
    assert_eq!(list["items"][0]["shown"], false);
}

#[test]
fn preview_shows_the_public_projection_of_unsaved_work_and_writes_nothing() {
    let f = site_with_posts("preview_shows_the_public_proje");
    let session = login_ok(&f);
    let (status, preview) = source_call(
        &f,
        &session,
        "POST",
        "/admin/api/reading-paths/preview",
        body_of("draft-view", "Preview me", "draft", three_steps()),
    );
    assert_eq!(status, 200, "{preview}");
    assert_eq!(preview["valid"], true);
    assert_eq!(preview["projection"]["asPublished"], true);
    let steps = preview["projection"]["public"]["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 3);
    assert_eq!(steps[1]["transition"]["follows"], 1);
    assert_eq!(steps[0]["title"], "alpha");
    assert!(steps[0].get("id").is_none(), "no author step id is public");
    // Problems are reported, not refused, so the editor can show them live.
    let (status, preview) = source_call(
        &f,
        &session,
        "POST",
        "/admin/api/reading-paths/preview",
        body_of(
            "draft-view",
            "T",
            "draft",
            json!([step("a", "alpha", false), step("b", "bravo", false)]),
        ),
    );
    assert_eq!(status, 200);
    assert_eq!(preview["valid"], false);
    assert!(!f.dir.join("content/paths").exists());
}

#[test]
fn reorder_moves_steps_keeps_their_text_and_never_silently_drops_a_transition() {
    let f = site_with_posts("reorder_moves_steps_keeps_thei");
    let session = login_ok(&f);
    let (_, created) = create(&f, &session, body_of("tour", "T", "draft", three_steps()));
    // Moving the last step up one keeps every step's own words.
    let (status, moved) = source_call(
        &f,
        &session,
        "POST",
        "/admin/api/reading-paths/reorder",
        json!({"slug": "tour", "revision": created["revision"], "order": ["one", "three", "two"]}),
    );
    assert_eq!(status, 200, "{moved}");
    let ids: Vec<&str> = moved["path"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["one", "three", "two"]);
    assert_eq!(
        moved["path"]["steps"][1]["transition"]["why"],
        "It continues the thread."
    );
    // Moving a step with a transition to the front asks first.
    let before = stored(&f, "tour").unwrap();
    let (status, ask) = source_call(
        &f,
        &session,
        "POST",
        "/admin/api/reading-paths/reorder",
        json!({"slug": "tour", "revision": moved["revision"], "order": ["three", "one", "two"]}),
    );
    assert_eq!(status, 422, "{ask}");
    assert_eq!(ask["needsConfirmation"], true);
    assert_eq!(stored(&f, "tour").unwrap(), before);
    // The old first step has no transition, so moving it down needs one the
    // author supplies; nothing is invented for it.
    let (status, needs) = source_call(
        &f,
        &session,
        "POST",
        "/admin/api/reading-paths/reorder",
        json!({"slug": "tour", "revision": moved["revision"],
            "order": ["three", "one", "two"], "clearTransition": true}),
    );
    assert_eq!(status, 422, "{needs}");
    assert_eq!(needs["problems"][0]["step"], "one");
    assert_eq!(stored(&f, "tour").unwrap(), before);
    let (status, done) = source_call(
        &f,
        &session,
        "POST",
        "/admin/api/reading-paths/reorder",
        json!({"slug": "tour", "revision": moved["revision"],
            "order": ["three", "one", "two"], "clearTransition": true,
            "transitions": {"one": {"relationship": "builds-on", "why": "It builds on the new start."}}}),
    );
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["clearedTransitions"], json!(["three"]));
    assert_eq!(
        done["path"]["steps"][1]["transition"]["relationship"],
        "builds-on"
    );
    // A wrong list, a stale revision and unknown ids change nothing.
    let after = stored(&f, "tour").unwrap();
    for order in [
        json!(["one", "two"]),
        json!(["one", "two", "two"]),
        json!(["x", "y", "z"]),
    ] {
        let (status, _) = source_call(
            &f,
            &session,
            "POST",
            "/admin/api/reading-paths/reorder",
            json!({"slug": "tour", "revision": done["revision"], "order": order}),
        );
        assert_eq!(status, 422);
    }
    let (status, _) = source_call(
        &f,
        &session,
        "POST",
        "/admin/api/reading-paths/reorder",
        json!({"slug": "tour", "revision": created["revision"], "order": ["three", "one", "two"]}),
    );
    assert_eq!(status, 409);
    assert_eq!(stored(&f, "tour").unwrap(), after);
}

#[test]
fn delete_moves_the_file_to_the_trash_and_refuses_a_stale_revision() {
    let f = site_with_posts("delete_moves_the_file_to_the_t");
    let session = login_ok(&f);
    let (_, created) = create(&f, &session, body_of("tour", "T", "draft", three_steps()));
    let stale = handle(
        &f.state,
        &authed(
            req("DELETE", "/admin/api/reading-paths?slug=tour&revision=0000"),
            &session,
            true,
        ),
    );
    assert_eq!(stale.status, 409);
    assert!(path_file(&f, "tour").exists());
    let ok = handle(
        &f.state,
        &authed(
            req(
                "DELETE",
                &format!(
                    "/admin/api/reading-paths?slug=tour&revision={}",
                    created["revision"].as_str().unwrap()
                ),
            ),
            &session,
            true,
        ),
    );
    assert_eq!(ok.status, 200, "{}", String::from_utf8_lossy(&ok.body));
    assert!(!path_file(&f, "tour").exists());
    let trashed: Vec<_> = fs::read_dir(f.dir.join(".openblog/trash"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        trashed.iter().any(|n| n.contains("paths_tour")),
        "{trashed:?}"
    );
    let gone = handle(
        &f.state,
        &authed(
            req("DELETE", "/admin/api/reading-paths?slug=tour&revision=0000"),
            &session,
            true,
        ),
    );
    assert_eq!(gone.status, 404);
}

#[test]
fn hostile_input_is_refused_without_echo_and_writes_nothing() {
    let f = site_with_posts("hostile_input_is_refused_witho");
    let session = login_ok(&f);
    // Traversal and odd slugs.
    for slug in ["../x", "a/b", "A", "", "-x", "x--y", &"a".repeat(65)] {
        let (status, _) = create(&f, &session, body_of(slug, "T", "draft", json!([])));
        assert_eq!(status, 400, "slug {slug:?}");
    }
    let r = handle(
        &f.state,
        &authed(
            req("GET", "/admin/api/reading-paths/path?slug=..%2Fx"),
            &session,
            false,
        ),
    );
    assert_eq!(r.status, 400);
    // Wrong content type, bad JSON, oversize.
    let mut plain = authed(req("POST", "/admin/api/reading-paths"), &session, true);
    plain.body = b"{}".to_vec();
    assert_eq!(handle(&f.state, &plain).status, 415);
    let mut broken = authed(req("POST", "/admin/api/reading-paths"), &session, true);
    broken
        .headers
        .insert("content-type".into(), "application/json".into());
    broken.body = b"{nope".to_vec();
    assert_eq!(handle(&f.state, &broken).status, 400);
    let big = "x".repeat(MAX_FILE_BYTES * 2 + 1);
    let (status, _) = create(&f, &session, json!({"slug": "big", "source": big}));
    assert_eq!(status, 413);
    // A duplicate key and wrong types never echo what was written.
    const ECHO: &str = "ECHO-ME-12345";
    let dup = format!(
        r#"{{"format":"openblog-reading-path","version":1,"title":"{ECHO}","title":"B","steps":[]}}"#
    );
    let (status, body) = create(&f, &session, json!({"slug": "dup", "source": dup}));
    assert_eq!(status, 422, "{body}");
    assert!(!body.to_string().contains(ECHO), "{body}");
    let mut wrong = body_of("wrong", "T", "draft", json!([step("a", "alpha", false)]));
    wrong["path"]["status"] = json!(ECHO);
    wrong["path"]["steps"][0]["optional"] = json!(ECHO);
    let (status, body) = create(&f, &session, wrong);
    assert_eq!(status, 422, "{body}");
    assert!(!body.to_string().contains(ECHO), "{body}");
    // A hostile step id is named by position, never echoed.
    let hostile = body_of(
        "hid",
        "T",
        "draft",
        json!([step("<script>alert(1)</script>", "alpha", false)]),
    );
    let (status, body) = create(&f, &session, hostile);
    assert_eq!(status, 422, "{body}");
    assert!(!body.to_string().contains("script"), "{body}");
    // Both a path and source, or neither.
    let (status, _) = create(
        &f,
        &session,
        json!({"slug": "both", "source": "{}", "path": {"title": "T"}}),
    );
    assert_eq!(status, 422);
    assert!(!f.dir.join("content/paths").exists(), "nothing was written");
}

#[test]
fn an_unreadable_file_is_listed_with_its_problem_and_never_stops_the_others() {
    let f = site_with_posts("an_unreadable_file_is_listed_w");
    let session = login_ok(&f);
    create(
        &f,
        &session,
        body_of("good", "Good", "draft", three_steps()),
    );
    fs::write(path_file(&f, "broken"), "{ not json").unwrap();
    let list = body_json(&handle(
        &f.state,
        &authed(req("GET", "/admin/api/reading-paths"), &session, false),
    ));
    let items = list["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let broken = items.iter().find(|i| i["slug"] == "broken").unwrap();
    assert_eq!(broken["valid"], false);
    assert!(broken["firstProblem"].as_str().unwrap().contains("broken"));
    let (status, got) = get_path(&f, &session, "broken");
    assert_eq!(status, 200);
    assert_eq!(got["valid"], false);
    assert_eq!(
        got["source"], "{ not json",
        "source mode shows the bytes to repair"
    );
    assert_eq!(stored(&f, "broken").unwrap(), "{ not json");
}

#[test]
fn paths_never_change_the_built_site_and_a_site_without_them_is_byte_identical() {
    let f = site_with_posts("paths_never_change_the_built_s");
    let session = login_ok(&f);
    let build = |f: &Fixture| -> BTreeMap<String, String> {
        let (mut site, themes) = site::load_site(&f.dir, false, None).unwrap();
        site::generate_site(&f.dir, &mut site, &themes)
            .unwrap()
            .into_iter()
            .map(|file| (file.path, file.contents))
            .collect()
    };
    let before = build(&f);
    let (status, _) = create(
        &f,
        &session,
        body_of("tour", "T", "published", three_steps()),
    );
    assert_eq!(status, 201);
    assert_eq!(before, build(&f), "a stored path changes no generated file");
    assert!(before.keys().all(|p| !p.contains("paths")));
}

#[test]
fn preview_and_saves_are_deterministic() {
    let f = site_with_posts("preview_and_saves_are_determin");
    let session = login_ok(&f);
    let call = || {
        source_call(
            &f,
            &session,
            "POST",
            "/admin/api/reading-paths/preview",
            body_of("p", "T", "published", three_steps()),
        )
        .1
    };
    assert_eq!(call(), call());
}

fn atlas_site(tag: &str, publish: bool) -> Fixture {
    let f = site_with_posts(tag);
    let write = |relative: &str, value: Json| {
        let path = f.dir.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value.to_string()).unwrap();
    };
    write(
        crate::source_store::LIBRARY_FILE,
        json!({"version": 1, "sources": [{"id": "book", "kind": "work", "title": "A book"}]}),
    );
    write(
        crate::atlas_store::ATLAS_FILE,
        json!({"version": 1, "entries": [
            {"id": "plato", "kind": "person", "label": "Plato", "visibility": "approved"},
            {"id": "stoics", "kind": "movement", "label": "The Stoics", "visibility": "approved"},
            {"id": "secret", "kind": "concept", "label": "SECRET-ATLAS-LABEL", "visibility": "private"}],
        "relationships": [{"id": "r-influence", "kind": "influenced", "from": "plato", "to": "stoics",
            "assertedBy": {"kind": "author"}, "confidence": "plausible",
            "evidence": [{"source": "book"}], "visibility": "approved"}]}),
    );
    let config_path = f.dir.join(site::CONFIG_FILE);
    let mut config: Json = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    if publish {
        config["knowledgeAtlas"] = json!({"publish": true});
    }
    fs::write(&config_path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
    f
}

#[test]
fn public_atlas_entries_are_pickable_and_private_ones_are_not() {
    let f = atlas_site("atlas_pick", true);
    let session = login_ok(&f);
    let r = handle(
        &f.state,
        &authed(
            req("GET", "/admin/api/reading-paths/targets"),
            &session,
            false,
        ),
    );
    let targets = body_json(&r);
    let ids: Vec<&str> = targets["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["plato", "stoics"]);
    assert!(!String::from_utf8_lossy(&r.body).contains("SECRET-ATLAS-LABEL"));
    // An influenced step on a published relationship resolves; a private entry is flagged.
    let mut influenced = json!({"id": "two", "target": {"kind": "atlas", "id": "stoics"},
        "transition": {"relationship": "influenced", "why": "The atlas says so.", "basis": "r-influence"}});
    let steps = json!([
        {"id": "one", "target": {"kind": "atlas", "id": "plato"}},
        influenced.take(),
        {"id": "three", "target": {"kind": "atlas", "id": "secret"},
         "transition": {"relationship": "next", "why": "Then."}, "optional": true}
    ]);
    let (status, saved) = create(&f, &session, body_of("ideas", "Ideas", "published", steps));
    assert_eq!(status, 201, "{saved}");
    let states: Vec<&str> = saved["states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["state"].as_str().unwrap())
        .collect();
    assert_eq!(states, ["published", "published", "unpublished"]);
    let public = &saved["projection"]["public"];
    assert_eq!(
        public["steps"].as_array().unwrap().len(),
        2,
        "the private optional step is left out"
    );
    assert_eq!(public["steps"][1]["transition"]["basis"], "r-influence");
    assert!(!saved["projection"]
        .to_string()
        .contains("SECRET-ATLAS-LABEL"));
    // A post step may not be influenced.
    let bad = json!([
        {"id": "one", "target": {"kind": "post", "slug": "alpha"}},
        {"id": "two", "target": {"kind": "atlas", "id": "stoics"},
         "transition": {"relationship": "influenced", "why": "w", "basis": "r-influence"}}
    ]);
    let (status, body) = create(&f, &session, body_of("bad", "Bad", "draft", bad));
    assert_eq!(status, 422, "{body}");
    assert!(body.to_string().contains("joins two atlas entries"));
}

#[test]
fn with_the_atlas_unpublished_no_entry_is_public() {
    let f = atlas_site("atlas_off", false);
    let session = login_ok(&f);
    let targets = body_json(&handle(
        &f.state,
        &authed(
            req("GET", "/admin/api/reading-paths/targets"),
            &session,
            false,
        ),
    ));
    assert_eq!(targets["entries"], json!([]));
}
