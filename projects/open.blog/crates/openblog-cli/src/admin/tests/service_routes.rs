//! Admin service routes (ADR 0313, #511): services are edited through the same document routes posts, pages
//! and series use, behind the same session and CSRF checks, with the build's own validation in plain words.

use super::*;

fn call(f: &Fixture, session: &(String, String), method: &str, path: &str, body: Json) -> Response {
    handle(
        &f.state,
        &authed(json_req(method, path, body), session, true),
    )
}

fn service_fields() -> Json {
    json!({
        "version": "1",
        "id": "hardwood-install",
        "name": "Hardwood installation",
        "summary": "Solid oak or maple floors, nailed and finished on site.",
        "includes": ["Removing the old floor", "Two coats of finish"],
        "priceBand": "2k-10k",
        "typicalTimeline": "2 to 4 days",
        "faq.1.question": "Can you match my floor?",
        "faq.1.answer": "Usually: we bring samples.",
        "faq.2.question": "Do I have to move out?",
        "faq.2.answer": "No.",
        "future": "kept"
    })
}

fn create(f: &Fixture, session: &(String, String), fields: Json, body: &str) -> Response {
    call(
        f,
        session,
        "POST",
        "/admin/api/document",
        json!({ "kind": "services", "fields": fields, "body": body }),
    )
}

fn service_path(f: &Fixture, name: &str) -> PathBuf {
    f.dir.join("content/services").join(name)
}

#[test]
fn the_service_routes_need_a_session_and_the_csrf_token() {
    let f = fixture("services-auth");
    assert_eq!(
        handle(&f.state, &req("GET", "/admin/api/documents?kind=services")).status,
        401
    );
    let session = login_ok(&f);
    let body = json!({ "kind": "services", "fields": service_fields(), "body": "" });
    let no_csrf = authed(
        json_req("POST", "/admin/api/document", body),
        &session,
        false,
    );
    assert_eq!(handle(&f.state, &no_csrf).status, 403);
    assert!(!service_path(&f, "hardwood-install.md").exists());
}

#[test]
fn a_service_is_created_listed_read_back_and_written_as_a_faq_block() {
    let f = fixture("services-roundtrip");
    let session = login_ok(&f);
    let created = create(&f, &session, service_fields(), "Long text.\n");
    assert_eq!(
        created.status,
        201,
        "{}",
        String::from_utf8_lossy(&created.body)
    );
    let saved = body_json(&created);
    assert_eq!(saved["path"], "services/hardwood-install.md");

    let text = fs::read_to_string(service_path(&f, "hardwood-install.md")).unwrap();
    assert!(
        text.contains("faq:\n  - question: Can you match my floor?\n    answer: \"Usually: we bring samples.\"\n  - question: Do I have to move out?\n    answer: \"No.\"\n")
            || text.contains("faq:\n  - question: Can you match my floor?\n    answer: \"Usually: we bring samples.\"\n  - question: Do I have to move out?\n    answer: No.\n"),
        "{text}"
    );
    assert!(text.contains("future: kept") && text.contains("version: 1"));

    let listed = handle(
        &f.state,
        &authed(
            req("GET", "/admin/api/documents?kind=services"),
            &session,
            false,
        ),
    );
    let items = body_json(&listed)["items"].clone();
    assert_eq!(items[0]["path"], "services/hardwood-install.md");
    assert_eq!(items[0]["title"], "Hardwood installation");
    assert_eq!(items[0]["status"], "published");

    let read = handle(
        &f.state,
        &authed(
            req(
                "GET",
                "/admin/api/document?path=services/hardwood-install.md",
            ),
            &session,
            false,
        ),
    );
    let document = body_json(&read);
    assert_eq!(document["kind"], "services");
    assert_eq!(document["fields"]["faq.2.answer"], "No.");
    assert_eq!(document["fields"]["includes"][1], "Two coats of finish");
    assert_eq!(document["body"].as_str().unwrap().trim(), "Long text.");
}

#[test]
fn an_edit_replaces_the_questions_and_a_stale_write_is_refused() {
    let f = fixture("services-edit");
    let session = login_ok(&f);
    let saved = body_json(&create(&f, &session, service_fields(), ""));
    let mut fields = service_fields();
    fields.as_object_mut().unwrap().remove("faq.2.question");
    fields.as_object_mut().unwrap().remove("faq.2.answer");
    let edited = call(
        &f,
        &session,
        "PUT",
        "/admin/api/document?path=services/hardwood-install.md",
        json!({ "kind": "services", "fields": fields, "body": "", "etag": saved["etag"] }),
    );
    assert_eq!(
        edited.status,
        200,
        "{}",
        String::from_utf8_lossy(&edited.body)
    );
    let text = fs::read_to_string(service_path(&f, "hardwood-install.md")).unwrap();
    assert!(text.contains("Can you match my floor?") && !text.contains("move out"));

    let stale = call(
        &f,
        &session,
        "PUT",
        "/admin/api/document?path=services/hardwood-install.md",
        json!({ "kind": "services", "fields": service_fields(), "body": "", "etag": saved["etag"] }),
    );
    assert_eq!(stale.status, 409);
}

#[test]
fn problems_are_said_in_the_builds_words_and_nothing_is_written() {
    let f = fixture("services-problems");
    let session = login_ok(&f);
    let mut fields = service_fields();
    fields["summary"] = json!("");
    fields["priceBand"] = json!("cheap");
    fields["faq.2.answer"] = json!("");
    let refused = create(&f, &session, fields, "");
    assert_eq!(refused.status, 422);
    let problems = body_json(&refused)["problems"].to_string();
    for expected in [
        "summary: add the service's summary",
        "priceBand: `cheap` is not a price band",
        "faq entry 2: add an answer",
    ] {
        assert!(problems.contains(expected), "{expected} in {problems}");
    }
    assert!(!service_path(&f, "hardwood-install.md").exists());

    let mut no_id = service_fields();
    no_id.as_object_mut().unwrap().remove("id");
    assert_eq!(create(&f, &session, no_id, "").status, 422);
}

#[test]
fn a_draft_service_saves_unfinished_and_is_listed_as_a_draft() {
    let f = fixture("services-draft");
    let session = login_ok(&f);
    let created = create(
        &f,
        &session,
        json!({ "version": "1", "id": "gutters", "name": "Gutters", "draft": "true" }),
        "",
    );
    assert_eq!(
        created.status,
        201,
        "{}",
        String::from_utf8_lossy(&created.body)
    );
    let listed = handle(
        &f.state,
        &authed(
            req("GET", "/admin/api/documents?kind=services"),
            &session,
            false,
        ),
    );
    assert_eq!(body_json(&listed)["items"][0]["status"], "draft");
}

#[test]
fn a_job_naming_an_unknown_service_is_refused_once_the_site_has_services() {
    let f = fixture("services-jobs");
    let session = login_ok(&f);
    let job = |service: &str| {
        json!({ "kind": "posts", "fields": {
            "title": "Oak floor", "date": "2026-10-16", "profile": "job",
            "job.trade": "flooring", "job.service": service,
            "job.place.town": "Bend", "job.place.region": "OR",
            "job.started": "2026-10-14", "job.finished": "2026-10-16"
        }, "body": "Done." })
    };
    // No services yet: any id is fine, as before.
    assert_eq!(
        call(&f, &session, "POST", "/admin/api/document", job("anything")).status,
        201
    );
    assert_eq!(create(&f, &session, service_fields(), "").status, 201);
    let refused = call(&f, &session, "POST", "/admin/api/document", {
        let mut other = job("hardwod-install");
        other["fields"]["title"] = json!("Second floor");
        other
    });
    // The first job now names an id that is not a service, so the whole site is refused for it only when
    // the edited file is that job; this one is its own unknown service.
    assert_eq!(refused.status, 422);
    assert!(
        body_json(&refused)["problems"]
            .to_string()
            .contains("known service ids are hardwood-install"),
        "{}",
        String::from_utf8_lossy(&refused.body)
    );
    let mut fine = job("hardwood-install");
    fine["fields"]["title"] = json!("Third floor");
    assert_eq!(
        call(&f, &session, "POST", "/admin/api/document", fine).status,
        201
    );
}

#[test]
fn the_job_form_is_offered_the_published_service_ids() {
    let f = fixture("services-meta");
    let session = login_ok(&f);
    assert_eq!(create(&f, &session, service_fields(), "").status, 201);
    let draft = create(
        &f,
        &session,
        json!({ "version": "1", "id": "gutters", "name": "Gutters", "draft": "true" }),
        "",
    );
    assert_eq!(draft.status, 201);
    let meta = handle(
        &f.state,
        &authed(req("GET", "/admin/api/meta"), &session, false),
    );
    assert_eq!(
        body_json(&meta)["job"]["services"],
        json!(["hardwood-install"])
    );
}

#[test]
fn only_the_flattened_faq_keys_may_be_dotted_and_the_body_stays_bounded() {
    let f = fixture("services-bounds");
    let session = login_ok(&f);
    let mut fields = service_fields();
    fields["faq.x.question"] = json!("nope");
    assert_eq!(create(&f, &session, fields, "").status, 422);
    let mut deep = service_fields();
    deep["faq.1.question.extra"] = json!("nope");
    assert_eq!(create(&f, &session, deep, "").status, 422);
    let too_big = "x".repeat(MAX_DOCUMENT_BYTES + 1);
    let oversize = create(&f, &session, service_fields(), &too_big);
    assert!(
        matches!(oversize.status, 413),
        "{}",
        String::from_utf8_lossy(&oversize.body)
    );
    assert!(!service_path(&f, "hardwood-install.md").exists());
}
