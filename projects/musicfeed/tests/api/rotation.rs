// tests/api/rotation.rs

use crate::helpers::{spawn_app, spawn_app_against};

use base64::Engine;
use reqwest::StatusCode;

/// Only what the form actually sends. `cover` and `year` are looked up, not typed.
fn payload() -> serde_json::Value {
    serde_json::json!({
        "artist": "Sabaton",
        "album": "Attero Dominatus",
        "note": "A co-worker turned me on to Sabaton in early 2022."
    })
}

#[tokio::test]
async fn post_rotation_entry_returns_append_patch_and_clears_signals() {
    // Arrange
    let app = spawn_app().await;

    // Act
    let response = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&payload())
        .send()
        .await
        .expect("Failed to execute request.");

    // Assert
    assert!(response.status().is_success());
    let body = response.text().await.unwrap();
    assert!(body.contains("event: datastar-patch-elements"));
    assert!(body.contains("data: selector #rotation-list"));
    assert!(body.contains("data: mode append"));
    // the app stamps id 0 for the first entry and the date itself
    assert!(
        body.contains(r#"class="rotation-artist""#),
        "body was: {body}"
    );
    assert!(body.contains("Sabaton"));
    assert!(body.contains("Attero Dominatus"));
    // and every bound signal is reset so the form is ready for the next entry
    assert!(body.contains("event: datastar-patch-signals"));
    assert!(body.contains(r#""artist":"""#));
    assert!(body.contains(r#""album":"""#));
}

#[tokio::test]
async fn cleared_signals_must_be_deserializable() {
    // Arrange
    let app = spawn_app().await;

    // Act — read the clear patch the server actually sends, then push its values
    // straight back into the next submission, exactly as the browser would.
    let first = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&payload())
        .send()
        .await
        .expect("Failed to execute request.")
        .text()
        .await
        .unwrap();

    let signals: serde_json::Value = first
        .lines()
        .find_map(|line| line.strip_prefix("data: signals "))
        .expect("stream carried no signals patch")
        .parse()
        .expect("signals patch was not valid JSON");

    // Merge the cleared values over a complete payload, as the form's bound
    // signals would be when the user submits again.
    let mut second = payload();
    for (key, value) in signals.as_object().unwrap() {
        second[key.as_str()] = value.clone();
    }

    let response = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&second)
        .send()
        .await
        .expect("Failed to execute request.");

    // Assert — the previous submission's own reset must not poison the next one.
    // Clearing `year` to `""` made this a 400 and silently added nothing.
    assert!(
        response.status().is_success(),
        "cleared signals were rejected on resubmit ({}): {second}",
        response.status()
    );

    // And it must be the *second* entry, proving the first was not re-sent.
    let body = response.text().await.unwrap();
    assert!(
        body.contains(r#"class="rotation-artist""#),
        "expected the second entry, got: {body}"
    );
}
#[tokio::test]
async fn posted_entry_appears_in_index_list() {
    // Arrange — a stubbed hit, so the entry has a year to assert on
    let mb_id = "b4974b0b-305e-4f98-b16d-04112f3cced2";
    let stubs = crate::metadata_stub::MetadataStubs::full_hit(mb_id).await;
    let app = spawn_app_against(stubs).await;

    // Act
    let _response = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&payload())
        .send()
        .await
        .expect("Failed to execute request.");

    let body = app
        .api_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();

    // Assert — the shared partial supplies the id and the fields on both paths
    assert!(
        body.contains(r#"class="rotation-artist""#),
        "body was: {body}"
    );
    assert!(body.contains("Sabaton"));
    assert!(body.contains("2006"));
}

#[tokio::test]
async fn an_empty_note_is_omitted_rather_than_rendered_empty() {
    // Arrange — a blank note is legitimate, so it must not become an empty
    // paragraph on the page. `cover` and `year` are looked up, not sent, so
    // there is nothing for them here.
    let app = spawn_app().await;
    let mut body = payload();
    body["note"] = serde_json::json!("");

    // Act
    let response = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&body)
        .send()
        .await
        .expect("Failed to execute request.");

    // Assert — the entry still saves, it just carries no note markup
    assert!(response.status().is_success());
    let sse_body = response.text().await.unwrap();
    assert!(sse_body.contains("Sabaton"));
    assert!(!sse_body.contains("rotation-note"), "sse was: {sse_body}");
}

#[tokio::test]
async fn cover_and_year_cannot_be_supplied_by_the_client() {
    // Arrange
    let app = spawn_app().await;
    let mut body = payload();
    // Both are app-controlled now. A client that sends them must not win.
    body["cover"] = serde_json::json!("/static/images/covers/someone-elses-choice.jpg");
    body["year"] = serde_json::json!(1066);

    // Act
    let response = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&body)
        .send()
        .await
        .expect("Failed to execute request.");

    // Assert — the entry is saved, but the forged values are ignored entirely.
    assert!(response.status().is_success());
    let page = app
        .api_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();
    assert!(
        !page.contains("someone-elses-choice"),
        "a client-supplied cover was accepted:\n{page}"
    );
    assert!(
        !page.contains("1066"),
        "a client-supplied year was accepted:\n{page}"
    );
}

#[tokio::test]
async fn a_successful_lookup_fills_in_the_cover_and_year() {
    // Arrange — a stubbed MusicBrainz hit, including a back cover so the
    // front-cover filter is genuinely exercised.
    let mb_id = "b4974b0b-305e-4f98-b16d-04112f3cced2";
    let stubs = crate::metadata_stub::MetadataStubs::full_hit(mb_id).await;
    let app = spawn_app_against(stubs).await;

    // Act
    let response = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&payload())
        .send()
        .await
        .expect("Failed to execute request.");

    // Assert — the entry carries the looked-up year and cover
    assert!(response.status().is_success());
    let page = app
        .api_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();
    assert!(
        page.contains("rotation-widget"),
        "the cover was not rendered:\n{page}"
    );
    assert!(
        page.contains("front-250.jpg"),
        "the wrong thumbnail was chosen:\n{page}"
    );
    assert!(
        page.contains(r#"class="rotation-year">2006<"#),
        "the looked-up year is missing:\n{page}"
    );
}

#[tokio::test]
async fn a_cover_is_absent_when_the_release_has_no_art() {
    // Arrange — the release exists but the archive has nothing for it.
    let mb_id = "bootleg-0001";
    let stubs = crate::metadata_stub::MetadataStubs::start().await;
    stubs.expect_no_art(mb_id).await;
    let app = spawn_app_against(stubs).await;

    // Act
    let response = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&payload())
        .send()
        .await
        .expect("Failed to execute request.");

    // Assert — still saved, with the year but no image
    assert!(response.status().is_success());
    let page = app
        .api_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();
    assert!(
        page.contains(r#"class="rotation-year">2006<"#),
        "the year should still land:\n{page}"
    );
    assert!(
        !page.contains(r#"src="""#),
        "a missing cover rendered an empty src:\n{page}"
    );
    assert!(
        !page.contains("<img"),
        "an image was rendered for a release with no art:\n{page}"
    );
}

#[tokio::test]
async fn a_failing_service_saves_the_entry_and_reports_it() {
    // Arrange — every request errors. The entry must still be saved, and the
    // user must be told why it arrived bare.
    let stubs = crate::metadata_stub::MetadataStubs::failure().await;
    let app = spawn_app_against(stubs).await;

    // Act
    let response = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&payload())
        .send()
        .await
        .expect("Failed to execute request.");

    // Assert — saved...
    assert!(
        response.status().is_success(),
        "a failing metadata service must not block the save"
    );
    let body = response.text().await.unwrap();
    let page = app
        .api_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();
    assert!(
        page.contains("Sabaton"),
        "the entry should be saved:\n{page}"
    );

    // ...and the user is told, via a signal patch
    assert!(
        body.contains("Could not look that up"),
        "no status signal was sent:\n{body}"
    );
    assert!(
        !body.contains(r#""year":0"#),
        "a failed lookup produced a zero year:\n{body}"
    );
}

#[tokio::test]
async fn a_miss_is_silent_because_it_is_not_a_failure() {
    // Arrange — nothing found. Different from an error, so no status message.
    let stubs = crate::metadata_stub::MetadataStubs::miss().await;
    let app = spawn_app_against(stubs).await;

    // Act
    let response = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&payload())
        .send()
        .await
        .expect("Failed to execute request.");
    let saved = response.status().is_success();
    let body = response.text().await.unwrap();

    // Assert — saved, and no scary status message
    assert!(saved);
    assert!(
        !body.contains("Could not look that up"),
        "a plain miss should not raise a status message:\n{body}"
    );
}

#[tokio::test]
async fn a_lookup_that_finds_nothing_still_saves_the_entry_bare() {
    // Arrange — a stubbed miss. No network, no live service.
    let stubs = crate::metadata_stub::MetadataStubs::miss().await;
    let app = spawn_app_against(stubs).await;

    // Act
    let response = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&serde_json::json!({
            "artist": "Zzz Nonexistent Artist Zzz",
            "album": "Zzz Nonexistent Album Zzz",
            "note": ""
        }))
        .send()
        .await
        .expect("Failed to execute request.");

    // Assert — saved, just without a cover or year.
    assert!(response.status().is_success());
    let page = app
        .api_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();
    assert!(
        page.contains("Zzz Nonexistent Artist Zzz"),
        "the entry should save even when the lookup finds nothing:\n{page}"
    );
    // A missing cover must never render an empty src.
    assert!(
        !page.contains(r#"src="""#),
        "a missing cover rendered an empty src:\n{page}"
    );
    // And no year at all — never zero.
    assert!(
        !page.contains("(0)"),
        "a missing year rendered as zero:\n{page}"
    );
}

#[tokio::test]
async fn empty_state_is_shown_only_when_there_are_no_entries() {
    // Arrange
    let app = spawn_app().await;

    // Act — first look at an empty app
    let empty = app
        .api_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();

    // Assert — visible, because nothing is spinning yet
    assert!(
        empty.contains(r#"<li id="rotation-empty" class="rotation-empty" >"#),
        "empty state should render when the list is empty: {empty}"
    );

    // Act — add an entry, then look again
    app.api_client
        .post(format!("{}/rotation", app.address))
        .json(&payload())
        .send()
        .await
        .expect("Failed to execute request.");
    let filled = app
        .api_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();

    // Assert — hidden, because there is now something to show
    assert!(
        filled.contains(r#"<li id="rotation-empty" class="rotation-empty" hidden>"#),
        "empty state should be hidden once entries exist: {filled}"
    );
}
#[tokio::test]
async fn sse_removes_the_empty_state_message() {
    // Arrange
    let app = spawn_app().await;

    // Act
    let body = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&payload())
        .send()
        .await
        .expect("Failed to execute request.")
        .text()
        .await
        .unwrap();

    // Assert — the empty-state message lives inside `#rotation-list`, so the append
    // alone leaves it sitting below the new entry. The stream must carry an explicit
    // removal, or "Nothing spinning yet" survives until a full page reload.
    assert!(
        body.contains("data: selector #rotation-empty"),
        "stream did not target the empty state:\n{body}"
    );
    assert!(
        body.contains("data: mode remove"),
        "stream did not remove the empty state:\n{body}"
    );
    // And the removal must come after the append, or the message is gone before it matters.
    let append_at = body.find("data: selector #rotation-list").unwrap();
    let remove_at = body.find("data: selector #rotation-empty").unwrap();
    assert!(
        append_at < remove_at,
        "removal should follow the append:\n{body}"
    );
}

#[tokio::test]
async fn sse_patch_is_a_single_data_elements_field() {
    // Arrange
    let app = spawn_app().await;

    // Act
    let body = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&payload())
        .send()
        .await
        .expect("Failed to execute request.")
        .text()
        .await
        .unwrap();

    // Assert — the HTML for one entry must arrive as ONE `data: elements` field.
    // A multi-line template makes the encoder emit a `data: elements` prefix per
    // line, and Datastar then patches with fragments instead of the whole entry,
    // so only part of the entry lands in the DOM.
    let element_fields = body
        .lines()
        .filter(|line| line.starts_with("data: elements"))
        .count();
    assert_eq!(
        element_fields, 1,
        "expected exactly one `data: elements` field, got {element_fields}:\n{body}"
    );
}

#[tokio::test]
async fn every_posted_entry_appears_in_the_index_list() {
    // Arrange
    let app = spawn_app().await;

    // Act — post three different entries
    for (artist, album) in [
        ("Sabaton", "Attero Dominatus"),
        ("Alestorm", "Cocoon"),
        ("Alice Cooper", "Special Forces"),
    ] {
        app.api_client
            .post(format!("{}/rotation", app.address))
            .json(&serde_json::json!({
                "artist": artist, "album": album, "note": ""
            }))
            .send()
            .await
            .expect("Failed to execute request.");
    }

    let page = app
        .api_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();

    // Assert — all three are present, each with its own id
    for artist in ["Sabaton", "Alestorm", "Alice Cooper"] {
        assert!(page.contains(artist), "{artist} missing from:\n{page}");
    }
    // Each entry renders its own widget.
    assert_eq!(
        page.matches("rotation-artist").count(),
        3,
        "expected three rendered widgets:\n{page}"
    );
}

#[tokio::test]
async fn entry_text_is_escaped_in_the_sse_patch() {
    // Arrange
    let app = spawn_app().await;
    let mut body = payload();
    body["note"] = serde_json::json!("<img src=x onerror=alert(1)>");

    // Act
    let response = app
        .api_client
        .post(format!("{}/rotation", app.address))
        .json(&body)
        .send()
        .await
        .expect("Failed to execute request.");
    let sse_body = response.text().await.unwrap();

    // Assert — the patch carries escaped text, never raw markup. The SSE path and the
    // server-rendered page must agree, or a stored payload runs for whoever loads the page.
    assert!(
        !sse_body.contains("<img src=x onerror=alert(1)>"),
        "raw payload leaked into the SSE patch: {sse_body}"
    );
    assert!(sse_body.contains("&lt;img src=x onerror=alert(1)&gt;"));

    // And the server-rendered page escapes it identically.
    let page = app
        .api_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();
    assert!(
        !page.contains("<img src=x onerror=alert(1)>"),
        "raw payload leaked into the page: {page}"
    );
    assert!(page.contains("&lt;img src=x onerror=alert(1)&gt;"));
}
#[tokio::test]
async fn random_entry_with_no_entries_returns_404() {
    // Arrange — a fresh app has nothing in its rotation
    let app = spawn_app().await;

    // Assert — a 404, not a dropped connection.
    //
    // Uses the unauthenticated client on purpose: the blog island fetches this
    // route from a static site, so it must stay open. A regression that gates it
    // would show up here as a 401 instead.
    //
    // This is also the case that catches a missing emptiness guard: drawing a random
    // index from an empty range panics, so the request is killed mid-response and the
    // client sees a transport error rather than any status at all.
    let response = app
        .unauthenticated_client
        .get(format!("{}/rotation", app.address))
        .send()
        .await
        .expect("Failed to execute request.");

    assert_eq!(
        response.status(),
        StatusCode::NOT_FOUND,
        "an empty rotation should be a 404, not a dropped connection"
    );

    // And the server must still be healthy afterwards — a panic in a handler would
    // leave the app unable to serve the next request.
    let health = app
        .api_client
        .get(format!("{}/health_check", app.address))
        .send()
        .await
        .expect("app did not survive the empty-rotation request");
    assert!(health.status().is_success());
}

#[tokio::test]
async fn random_entry_is_one_of_the_entered_entries() {
    // Arrange — enter three entries
    let app = spawn_app().await;
    for artist in ["Sabaton", "Alestorm", "Alice Cooper"] {
        app.api_client
            .post(format!("{}/rotation", app.address))
            .json(&serde_json::json!({
                "artist": artist, "album": "X", "note": ""
            }))
            .send()
            .await
            .unwrap();
    }

    // Act — ask for one, sending no credentials: the island needs this open.
    let response = app
        .unauthenticated_client
        .get(format!("{}/rotation", app.address))
        .send()
        .await
        .unwrap();

    // Assert — 200 without credentials, because the island must stay readable.
    assert!(response.status().is_success());
    let body = response.text().await.unwrap();
    assert!(
        body.contains("rotation-artist"),
        "expected a rendered entry, got: {body}"
    );
}

#[tokio::test]
async fn posting_without_credentials_is_rejected() {
    // The blog island can read, but only the owner should be able to write.
    // A POST with no Authorization header must get a 401 — and specifically a
    // 401 carrying WWW-Authenticate, which is what makes a browser render its
    // native login box rather than showing a blank error.
    let app = spawn_app().await;

    let response = app
        .unauthenticated_client
        .post(format!("{}/rotation", app.address))
        .json(&payload())
        .send()
        .await
        .expect("Failed to execute request.");

    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "an unauthenticated POST must not reach the handler"
    );
    let challenge = response
        .headers()
        .get("www-authenticate")
        .expect("401 must carry WWW-Authenticate or no browser login box appears")
        .to_str()
        .unwrap();
    assert!(
        challenge.starts_with("Basic"),
        "expected a Basic challenge, got: {challenge}"
    );
}

#[tokio::test]
async fn posting_with_wrong_credentials_is_rejected() {
    // Presence of a header is not enough — the comparison must actually compare.
    // This is the test that catches an implementation that decodes and forgets
    // to check, which would accept any well-formed credentials.
    let app = spawn_app().await;

    let encoded = base64::engine::general_purpose::STANDARD.encode("test:wrongpass");
    let response = app
        .unauthenticated_client
        .post(format!("{}/rotation", app.address))
        .header("Authorization", format!("Basic {encoded}"))
        .json(&payload())
        .send()
        .await
        .expect("Failed to execute request.");

    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "wrong credentials must be rejected, got {}",
        response.status()
    );
}

#[tokio::test]
async fn the_index_page_stays_open() {
    // The form lives on `/` and is fetched before any login happens. It is not
    // gated — the browser will challenge on the first POST instead — so a GET
    // with no credentials must still render the page.
    let app = spawn_app().await;

    let response = app
        .unauthenticated_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request");

    assert_eq!(
        response.status(),
        StatusCode::OK,
        "the form page should load before authentication"
    );
}
