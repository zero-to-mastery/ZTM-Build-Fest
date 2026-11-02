// tests/api/persistence.rs
//
// The regression test for the project's oldest known issue: "storage is in
// memory, so every deploy empties the rotation." Two applications over the
// same database file must see the same rotation — the API-level shape of a
// Railway restart.
//
// Written against v0.4.0 this test fails by construction: an in-memory Vec
// cannot survive the first app, let alone the second. On this branch it is
// the lock that keeps the guarantee true.

use crate::helpers::spawn_app_at;

#[tokio::test]
async fn an_entry_outlives_the_application_that_created_it() {
    // Arrange — one app, one store file, one entry.
    let dir = tempfile::tempdir().expect("temp dir");
    let app = spawn_app_at(dir.path().join("test.db").display().to_string()).await;

    app.api_client
        .post(format!("{}/rotation", app.address))
        .json(&serde_json::json!({
            "artist": "Sabaton",
            "album": "Attero Dominatus",
            "note": "A co-worker turned me on to Sabaton in early 2022."
        }))
        .send()
        .await
        .expect("Failed to execute request.");

    // Sanity: the first app serves what was just posted.
    let index = app
        .api_client
        .get(format!("{}/", app.address))
        .send()
        .await
        .expect("Failed to execute request.")
        .text()
        .await
        .unwrap();
    assert!(index.contains("Attero Dominatus"), "body was: {index}");

    // Act — the first application goes away. Its server task and connection
    // pool die with it; only the file remains.
    drop(app);

    // Assert — a brand-new application over the same file serves the entry,
    // both on the index page and through the blog island's random endpoint.
    let second = spawn_app_at(dir.path().join("test.db").display().to_string()).await;

    let index = second
        .api_client
        .get(format!("{}/", second.address))
        .send()
        .await
        .expect("Failed to execute request.")
        .text()
        .await
        .unwrap();
    assert!(
        index.contains("Attero Dominatus"),
        "entry did not survive the restart; index body was: {index}"
    );

    let random = second
        .unauthenticated_client
        .get(format!("{}/rotation", second.address))
        .send()
        .await
        .expect("Failed to execute request.");
    assert_eq!(
        random.status(),
        200,
        "random draw after restart found nothing"
    );
    let body = random.text().await.unwrap();
    assert!(body.contains("Attero Dominatus"), "body was: {body}");
}
