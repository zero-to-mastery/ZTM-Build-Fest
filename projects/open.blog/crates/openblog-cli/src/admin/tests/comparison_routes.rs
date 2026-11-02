//! Admin comparison routes (ADR 0231, #89): deny by default, CSRF, stale
//! writes, atomic canonical writes, source mode, the approval action, evidence
//! states, privacy and hostile input.

use super::*;
use openblog_core::scholarly_comparison::MAX_FILE_BYTES;

const UNAPPROVED: &str = "UNAPPROVED-AI-TEXT-7";

fn file(f: &Fixture, slug: &str) -> PathBuf {
    f.dir
        .join("content/comparisons")
        .join(format!("{slug}.json"))
}

fn stored(f: &Fixture, slug: &str) -> Option<String> {
    fs::read_to_string(file(f, slug)).ok()
}

fn site(tag: &str) -> Fixture {
    let f = fixture_with_sources(&format!("cmp-{tag}"));
    // One approved claim with one approved link on the library's source, and
    // the site publishes claim evidence: that link and source are public.
    let claims = f.dir.join(crate::claims_store::CLAIMS_FILE);
    fs::write(
        &claims,
        r#"{"version":1,"claims":[{"id":"c1","post":"cave","statement":"S","visibility":"approved"}],
            "links":[{"id":"public-link","claim":"c1","relation":"supports","visibility":"approved","evidence":{"source":"plato"}},
                     {"id":"private-link","claim":"c1","relation":"supports","visibility":"private","evidence":{"source":"slings"}}]}"#,
    )
    .unwrap();
    let config = f.dir.join("openblog.json");
    let mut value: Json = serde_json::from_str(&fs::read_to_string(&config).unwrap()).unwrap();
    value["claimEvidence"] = json!({"publish": true});
    fs::write(&config, value.to_string()).unwrap();
    f
}

fn named(id: &str, statement: &str) -> Json {
    json!({"id": id, "attribution": {"kind": "named", "name": format!("Reader {id}")}, "statement": statement})
}

fn ai(mut item: Json) -> Json {
    item["origin"] = json!({"kind": "ai-draft", "tool": "an assistant"});
    item
}

fn body_of(slug: &str, status: &str, interpretations: Json, explanations: Json) -> Json {
    json!({"slug": slug, "comparison": {
        "title": "The cave", "subject": "Readings of the cave", "status": status,
        "interpretations": interpretations, "explanations": explanations}})
}

fn two() -> Json {
    json!([
        named("one", "The first reading."),
        named("two", "The second reading.")
    ])
}

fn create(f: &Fixture, s: &(String, String), body: Json) -> (u16, Json) {
    source_call(f, s, "POST", "/admin/api/comparisons", body)
}

fn update(f: &Fixture, s: &(String, String), mut body: Json, revision: &Json) -> (u16, Json) {
    body["revision"] = revision.clone();
    source_call(f, s, "PUT", "/admin/api/comparisons", body)
}

fn decide(f: &Fixture, s: &(String, String), what: &str, body: Json) -> (u16, Json) {
    source_call(
        f,
        s,
        "POST",
        &format!("/admin/api/comparisons/{what}"),
        body,
    )
}

fn state_of<'a>(v: &'a Json, id: &str) -> &'a Json {
    v["states"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .unwrap()
}

#[test]
fn every_route_requires_a_session_and_every_write_a_csrf_token() {
    let f = site("auth");
    for (method, path) in [
        ("GET", "/admin/api/comparisons"),
        ("GET", "/admin/api/comparisons/references"),
        ("GET", "/admin/api/comparisons/item?slug=x"),
        ("POST", "/admin/api/comparisons"),
        ("PUT", "/admin/api/comparisons"),
        ("DELETE", "/admin/api/comparisons?slug=x&revision=y"),
        ("POST", "/admin/api/comparisons/preview"),
        ("POST", "/admin/api/comparisons/approve"),
        ("POST", "/admin/api/comparisons/revoke"),
    ] {
        assert_eq!(
            handle(&f.state, &req(method, path)).status,
            401,
            "{method} {path}"
        );
    }
    let s = login_ok(&f);
    for (method, path) in [
        ("POST", "/admin/api/comparisons"),
        ("PUT", "/admin/api/comparisons"),
        ("DELETE", "/admin/api/comparisons?slug=x&revision=y"),
        ("POST", "/admin/api/comparisons/preview"),
        ("POST", "/admin/api/comparisons/approve"),
        ("POST", "/admin/api/comparisons/revoke"),
    ] {
        let r = handle(
            &f.state,
            &authed(
                json_req(method, path, body_of("x", "draft", two(), json!([]))),
                &s,
                false,
            ),
        );
        assert_eq!(r.status, 403, "{method} {path} without a CSRF token");
    }
    for (method, path) in [
        ("GET", "/admin/api/comparisons/nope"),
        ("PATCH", "/admin/api/comparisons"),
        ("DELETE", "/admin/api/comparisons/references"),
    ] {
        let r = handle(
            &f.state,
            &authed(json_req(method, path, json!({})), &s, true),
        );
        assert!(
            r.status == 404 || r.status == 405,
            "{method} {path}: {}",
            r.status
        );
    }
    assert!(
        !f.dir.join("content/comparisons").exists(),
        "a refused call writes nothing"
    );
}

#[test]
fn a_comparison_is_created_listed_edited_and_written_canonically() {
    let f = site("create");
    let s = login_ok(&f);
    let (status, created) = create(&f, &s, body_of("cave", "draft", two(), json!([])));
    assert_eq!(status, 201, "{created}");
    let text = stored(&f, "cave").unwrap();
    assert_eq!(created["source"], text.as_str());
    assert!(text.starts_with("{\n  \"format\": \"openblog-interpretation-comparison\""));
    assert!(text.ends_with("}\n") && !text.contains('\r'));
    let names: Vec<_> = fs::read_dir(f.dir.join("content/comparisons"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["cave.json"]);
    // A second create of the same slug is refused and changes nothing.
    let (again, _) = create(&f, &s, body_of("cave", "draft", two(), json!([])));
    assert_eq!(again, 409);
    assert_eq!(stored(&f, "cave").unwrap(), text);
    let list = handle(
        &f.state,
        &authed(req("GET", "/admin/api/comparisons"), &s, false),
    );
    let list = body_json(&list);
    assert_eq!(list["items"][0]["slug"], "cave");
    assert_eq!(list["items"][0]["interpretations"], 2);
    // An edit is a fixed point: the response's source saves to the same bytes.
    let (status, edited) = update(
        &f,
        &s,
        json!({"slug": "cave", "source": created["source"]}),
        &created["revision"],
    );
    assert_eq!(status, 200, "{edited}");
    assert_eq!(edited["revision"], created["revision"]);
    assert_eq!(stored(&f, "cave").unwrap(), text);
}

#[test]
fn source_mode_keeps_unknown_fields_and_refuses_what_the_contract_refuses() {
    let f = site("source");
    let s = login_ok(&f);
    let mut body = body_of("cave", "draft", two(), json!([]));
    body["comparison"]["x-note"] = json!("kept as written");
    let (status, created) = create(&f, &s, body);
    assert_eq!(status, 201, "{created}");
    assert!(stored(&f, "cave").unwrap().contains("x-note"));
    // A verdict field is refused, and the file is unchanged.
    let before = stored(&f, "cave").unwrap();
    let mut with_verdict = created["comparison"].clone();
    with_verdict["interpretations"][0]["verdict"] = json!("correct");
    let (status, refused) = update(
        &f,
        &s,
        json!({"slug": "cave", "comparison": with_verdict}),
        &created["revision"],
    );
    assert_eq!(status, 422, "{refused}");
    assert_eq!(stored(&f, "cave").unwrap(), before);
}

#[test]
fn every_interpretation_needs_an_attribution_and_nothing_is_written_without_one() {
    let f = site("attribution");
    let s = login_ok(&f);
    let unattributed = json!([{"id": "one", "statement": "A reading."}, named("two", "Another.")]);
    let (status, refused) = create(&f, &s, body_of("cave", "draft", unattributed, json!([])));
    assert_eq!(status, 422, "{refused}");
    assert!(
        refused["problems"][0]["item"] == "one"
            || refused["error"].as_str().unwrap().contains("one")
    );
    assert!(!file(&f, "cave").exists());
    // An explicit "unknown" is an honest attribution.
    let anonymous = json!([
        {"id": "one", "attribution": {"kind": "anonymous", "description": "An unknown commentator"}, "statement": "A reading."},
        named("two", "Another.")
    ]);
    assert_eq!(
        create(&f, &s, body_of("cave", "draft", anonymous, json!([]))).0,
        201
    );
}

#[test]
fn an_ai_draft_stays_a_draft_until_the_approve_action_and_a_save_cannot_forge_it() {
    let f = site("approve");
    let s = login_ok(&f);
    let explanations = json!([ai(
        json!({"id": "easy", "level": "beginner", "text": UNAPPROVED})
    )]);
    let (status, created) = create(&f, &s, body_of("cave", "draft", two(), explanations));
    assert_eq!(status, 201, "{created}");
    assert_eq!(state_of(&created, "easy")["standing"], "awaiting-approval");
    // The preview shows the comparison as published: the AI text is not in it.
    let public = created["projection"]["public"].to_string();
    assert!(!public.contains(UNAPPROVED), "{public}");
    assert!(created["projection"]["leftOut"]
        .to_string()
        .contains("awaiting-approval"));
    // A published comparison cannot hold an unapproved AI draft.
    let (status, _) = update(
        &f,
        &s,
        body_of(
            "cave",
            "published",
            two(),
            json!([ai(
                json!({"id": "easy", "level": "beginner", "text": UNAPPROVED})
            )]),
        ),
        &created["revision"],
    );
    assert_eq!(status, 422);
    // A save that carries an invented approval is refused.
    let digest = state_of(&created, "easy")["digest"].clone();
    let mut forged = created["comparison"].clone();
    forged["explanations"][0]["approval"] =
        json!({"by": "Someone", "at": "2026-10-27T10:00:00Z", "digest": digest});
    let before = stored(&f, "cave").unwrap();
    let (status, refused) = update(
        &f,
        &s,
        json!({"slug": "cave", "comparison": forged}),
        &created["revision"],
    );
    assert_eq!(status, 422, "{refused}");
    assert!(refused["problems"][0]["item"] == "easy");
    assert_eq!(stored(&f, "cave").unwrap(), before);
    // Approving the text that was shown stamps the signed-in user.
    let (status, approved) = decide(
        &f,
        &s,
        "approve",
        json!({"slug": "cave", "revision": created["revision"], "kind": "explanation", "id": "easy", "digest": digest}),
    );
    assert_eq!(status, 200, "{approved}");
    assert_eq!(state_of(&approved, "easy")["standing"], "approved");
    let approval = &approved["comparison"]["explanations"][0]["approval"];
    assert_eq!(approval["by"], "mikey");
    assert_eq!(approval["digest"], digest);
    assert!(approved["projection"]["public"]
        .to_string()
        .contains(UNAPPROVED));
    // Now it can be published, and a save keeps the approval it already has.
    let (status, published) = update(
        &f,
        &s,
        json!({"slug": "cave", "comparison": {
            "title": "The cave", "subject": "Readings of the cave", "status": "published",
            "interpretations": two(), "explanations": approved["comparison"]["explanations"]}}),
        &approved["revision"],
    );
    assert_eq!(status, 200, "{published}");
    assert_eq!(
        published["comparison"]["explanations"][0]["approval"],
        *approval
    );
}

#[test]
fn approving_text_that_changed_is_refused_and_editing_withdraws_the_approval() {
    let f = site("stale");
    let s = login_ok(&f);
    let (_, created) = create(
        &f,
        &s,
        body_of(
            "cave",
            "draft",
            two(),
            json!([ai(
                json!({"id": "easy", "level": "beginner", "text": "First wording."})
            )]),
        ),
    );
    let shown = state_of(&created, "easy")["digest"].clone();
    // Another tab edits the text; approving what this tab showed is refused.
    let (_, edited) = update(
        &f,
        &s,
        body_of(
            "cave",
            "draft",
            two(),
            json!([ai(
                json!({"id": "easy", "level": "beginner", "text": "Second wording."})
            )]),
        ),
        &created["revision"],
    );
    let (status, refused) = decide(
        &f,
        &s,
        "approve",
        json!({"slug": "cave", "revision": edited["revision"], "kind": "explanation", "id": "easy", "digest": shown}),
    );
    assert_eq!(status, 422, "{refused}");
    assert_eq!(refused["stale"], true);
    assert!(!stored(&f, "cave").unwrap().contains("approval"));
    // An out-of-date revision is a conflict and changes nothing.
    let before = stored(&f, "cave").unwrap();
    let (status, conflict) = decide(
        &f,
        &s,
        "approve",
        json!({"slug": "cave", "revision": created["revision"], "kind": "explanation", "id": "easy", "digest": shown}),
    );
    assert_eq!((status, conflict["conflict"].clone()), (409, json!(true)));
    assert_eq!(stored(&f, "cave").unwrap(), before);
    // Approve the current text, then edit it: the approval is withdrawn and said so.
    let digest = state_of(&edited, "easy")["digest"].clone();
    let (_, approved) = decide(
        &f,
        &s,
        "approve",
        json!({"slug": "cave", "revision": edited["revision"], "kind": "explanation", "id": "easy", "digest": digest}),
    );
    let mut changed = approved["comparison"].clone();
    changed["explanations"][0]["text"] = json!("Third wording.");
    let (status, resaved) = update(
        &f,
        &s,
        json!({"slug": "cave", "comparison": changed}),
        &approved["revision"],
    );
    assert_eq!(status, 200, "{resaved}");
    assert_eq!(resaved["approvalsWithdrawn"], json!(["easy"]));
    assert_eq!(state_of(&resaved, "easy")["standing"], "awaiting-approval");
    assert!(!stored(&f, "cave").unwrap().contains("\"approval\""));
}

#[test]
fn text_you_wrote_needs_no_approval_and_ai_off_workflows_work() {
    let f = site("authored");
    let s = login_ok(&f);
    let (_, created) = create(
        &f,
        &s,
        body_of(
            "cave",
            "published",
            two(),
            json!([{"id": "own", "level": "student", "text": "My own words."}]),
        ),
    );
    assert_eq!(state_of(&created, "own")["standing"], "authored");
    assert!(created["projection"]["public"]["explanations"][0]["text"] == "My own words.");
    let (status, refused) = decide(
        &f,
        &s,
        "approve",
        json!({"slug": "cave", "revision": created["revision"], "kind": "explanation", "id": "own", "digest": state_of(&created, "own")["digest"]}),
    );
    assert_eq!(status, 422, "{refused}");
    assert_eq!(refused["notAi"], true);
}

#[test]
fn revoking_an_approval_returns_text_to_draft_and_a_published_comparison_must_say_so() {
    let f = site("revoke");
    let s = login_ok(&f);
    let (_, created) = create(
        &f,
        &s,
        body_of(
            "cave",
            "draft",
            two(),
            json!([ai(
                json!({"id": "easy", "level": "beginner", "text": "Wording."})
            )]),
        ),
    );
    let digest = state_of(&created, "easy")["digest"].clone();
    let (_, approved) = decide(
        &f,
        &s,
        "approve",
        json!({"slug": "cave", "revision": created["revision"], "kind": "explanation", "id": "easy", "digest": digest}),
    );
    let (_, published) = update(
        &f,
        &s,
        json!({"slug": "cave", "comparison": {
            "title": "The cave", "subject": "Readings of the cave", "status": "published",
            "interpretations": two(), "explanations": approved["comparison"]["explanations"]}}),
        &approved["revision"],
    );
    let before = stored(&f, "cave").unwrap();
    let ask = |unpublish: bool, revision: &Json| {
        decide(
            &f,
            &s,
            "revoke",
            json!({"slug": "cave", "revision": revision, "kind": "explanation", "id": "easy", "unpublish": unpublish}),
        )
    };
    let (status, refused) = ask(false, &published["revision"]);
    assert_eq!(
        (status, refused["needsUnpublish"].clone()),
        (422, json!(true))
    );
    assert_eq!(
        stored(&f, "cave").unwrap(),
        before,
        "a refused revoke changes nothing"
    );
    let (status, revoked) = ask(true, &published["revision"]);
    assert_eq!(status, 200, "{revoked}");
    assert_eq!(revoked["comparison"]["status"], "draft");
    assert_eq!(state_of(&revoked, "easy")["standing"], "awaiting-approval");
    assert!(!stored(&f, "cave").unwrap().contains("\"approval\""));
    // Nothing left to withdraw.
    assert_eq!(ask(false, &revoked["revision"]).0, 422);
}

#[test]
fn missing_evidence_is_shown_without_blocking_honest_uncertainty() {
    let f = site("evidence");
    let s = login_ok(&f);
    let mut with_evidence = named("one", "The first reading.");
    with_evidence["evidence"] = json!([
        {"link": "public-link"}, {"link": "private-link"}, {"link": "ghost"},
        {"source": "plato", "locator": "514a"}
    ]);
    let bare = named("two", "No evidence yet.");
    let (status, created) = create(
        &f,
        &s,
        body_of("cave", "draft", json!([with_evidence, bare]), json!([])),
    );
    assert_eq!(status, 201, "{created}");
    let states: Vec<_> = state_of(&created, "one")["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["state"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(states, ["public", "private", "missing", "public"]);
    assert_eq!(state_of(&created, "two")["noEvidence"], true);
    assert_eq!(
        created["notes"].as_array().unwrap().len(),
        1,
        "{}",
        created["notes"]
    );
    assert!(created["notes"][0]["item"] == "one");
    // The preview drops what the build does not publish and never names it.
    let public = created["projection"]["public"].to_string();
    assert!(
        public.contains("public-link")
            && !public.contains("private-link")
            && !public.contains("ghost")
    );
}

#[test]
fn a_stale_save_is_a_conflict_and_leaves_the_file_unchanged() {
    let f = site("conflict");
    let s = login_ok(&f);
    let (_, created) = create(&f, &s, body_of("cave", "draft", two(), json!([])));
    let (_, newer) = update(
        &f,
        &s,
        body_of(
            "cave",
            "draft",
            json!([named("one", "Changed elsewhere."), named("two", "B.")]),
            json!([]),
        ),
        &created["revision"],
    );
    let before = stored(&f, "cave").unwrap();
    let (status, conflict) = update(
        &f,
        &s,
        body_of(
            "cave",
            "draft",
            json!([named("one", "Mine."), named("two", "B.")]),
            json!([]),
        ),
        &created["revision"],
    );
    assert_eq!(status, 409, "{conflict}");
    assert_eq!(conflict["conflict"], true);
    assert_eq!(conflict["revision"], newer["revision"]);
    assert_eq!(stored(&f, "cave").unwrap(), before);
    assert_eq!(
        update(
            &f,
            &s,
            body_of("none", "draft", two(), json!([])),
            &json!("x")
        )
        .0,
        404
    );
}

#[test]
fn hostile_input_is_refused_without_echo_and_without_writing() {
    let f = site("hostile");
    let s = login_ok(&f);
    for slug in ["../escape", "a/b", "CON", "", "UPPER"] {
        let (status, _) = create(&f, &s, body_of(slug, "draft", two(), json!([])));
        assert_eq!(status, 400, "slug {slug:?}");
    }
    let (status, _) = create(
        &f,
        &s,
        body_of(
            "big",
            "draft",
            json!([
                named("one", &"x".repeat(MAX_FILE_BYTES + 1)),
                named("two", "B.")
            ]),
            json!([]),
        ),
    );
    assert!(status == 413 || status == 422, "{status}");
    let (status, refused) = create(
        &f,
        &s,
        body_of(
            "html",
            "draft",
            json!([
                named("one", "<script>alert(1)</script> \u{202e}reversed"),
                named("two", "B.")
            ]),
            json!([]),
        ),
    );
    // Markup is stored as text and escaped by every renderer; direction
    // overrides are refused by the contract.
    assert!(status == 422 || status == 201, "{status}");
    if status == 422 {
        assert!(!refused.to_string().contains("alert(1)"), "{refused}");
    }
    let mut unsafe_link = named("one", "A reading.");
    unsafe_link["evidence"] = json!([{"link": "javascript:alert(1)"}]);
    let (status, refused) = create(
        &f,
        &s,
        body_of(
            "link",
            "draft",
            json!([unsafe_link, named("two", "B.")]),
            json!([]),
        ),
    );
    assert_eq!(status, 422, "{refused}");
    assert!(
        !refused.to_string().contains("javascript:alert"),
        "{refused}"
    );
    assert!(!file(&f, "link").exists());
    let (status, _) = source_call(
        &f,
        &s,
        "POST",
        "/admin/api/comparisons",
        json!({"slug": "src", "source": "{not json"}),
    );
    assert_eq!(status, 422);
    assert!(!file(&f, "src").exists());
}

#[test]
fn a_comparison_is_moved_to_the_trash_never_destroyed() {
    let f = site("delete");
    let s = login_ok(&f);
    let (_, created) = create(&f, &s, body_of("cave", "draft", two(), json!([])));
    let stale = handle(
        &f.state,
        &authed(
            req("DELETE", "/admin/api/comparisons?slug=cave&revision=nope"),
            &s,
            true,
        ),
    );
    assert_eq!(stale.status, 409);
    assert!(file(&f, "cave").exists());
    let revision = created["revision"].as_str().unwrap();
    let gone = handle(
        &f.state,
        &authed(
            req(
                "DELETE",
                &format!("/admin/api/comparisons?slug=cave&revision={revision}"),
            ),
            &s,
            true,
        ),
    );
    assert_eq!(gone.status, 200);
    assert!(!file(&f, "cave").exists());
    let trashed = body_json(&gone)["trashedTo"].as_str().unwrap().to_string();
    assert!(f.dir.join(".openblog/trash").join(trashed).exists());
}

#[test]
fn editing_the_uncertainty_or_attribution_of_an_approved_ai_reading_withdraws_the_approval() {
    let f = site("whole-item");
    let s = login_ok(&f);
    let mut reading = ai(named("one", "An AI-worded reading."));
    reading["uncertainty"] = json!("Some doubt.");
    let interpretations = json!([reading, named("two", "The second reading.")]);
    let (_, created) = create(&f, &s, body_of("cave", "draft", interpretations, json!([])));
    let digest = state_of(&created, "one")["digest"].clone();
    let (status, approved) = decide(
        &f,
        &s,
        "approve",
        json!({"slug": "cave", "revision": created["revision"], "kind": "interpretation", "id": "one", "digest": digest}),
    );
    assert_eq!(status, 200, "{approved}");
    let mut revision = approved["revision"].clone();
    let mut comparison = approved["comparison"].clone();
    for edit in ["uncertainty", "attribution"] {
        let mut changed = comparison.clone();
        if edit == "uncertainty" {
            changed["interpretations"][0]["uncertainty"] = json!("No doubt at all.");
        } else {
            changed["interpretations"][0]["attribution"]["name"] = json!("Someone else");
        }
        let (status, resaved) = update(
            &f,
            &s,
            json!({"slug": "cave", "comparison": changed}),
            &revision,
        );
        assert_eq!(status, 200, "{resaved}");
        assert_eq!(resaved["approvalsWithdrawn"], json!(["one"]), "{edit}");
        assert_eq!(state_of(&resaved, "one")["standing"], "awaiting-approval");
        assert!(!stored(&f, "cave").unwrap().contains("\"approval\""));
        // Approve the edited item again so the next edit has an approval to lose.
        let digest = state_of(&resaved, "one")["digest"].clone();
        let (status, again) = decide(
            &f,
            &s,
            "approve",
            json!({"slug": "cave", "revision": resaved["revision"], "kind": "interpretation", "id": "one", "digest": digest}),
        );
        assert_eq!(status, 200, "{again}");
        revision = again["revision"].clone();
        comparison = again["comparison"].clone();
    }
}

#[test]
fn an_explanation_cannot_cite_evidence_its_interpretation_does_not() {
    let f = site("evidence-subset");
    let s = login_ok(&f);
    let mut cited = named("one", "The first reading.");
    cited["evidence"] = json!([{"source": "commentary"}]);
    let interpretations = json!([cited, named("two", "The second reading.")]);
    let (status, refused) = create(
        &f,
        &s,
        body_of(
            "cave",
            "draft",
            interpretations,
            json!([{"id": "x", "level": "beginner", "about": "two", "text": "Plain words.",
                    "evidence": [{"source": "commentary"}]}]),
        ),
    );
    assert_eq!(status, 422, "{refused}");
    assert!(refused.to_string().contains("adds no evidence of its own"));
}
