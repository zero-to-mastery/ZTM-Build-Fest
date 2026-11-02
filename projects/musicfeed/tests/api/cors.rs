// tests/api/cors.rs
//
// The CORS allow-list. These run under the `local` environment, so the origins
// in `configuration/local.toml` are the ones in force.

use crate::helpers::spawn_app;
use reqwest::header::{ACCESS_CONTROL_ALLOW_ORIGIN, ORIGIN};

const BLOG: &str = "https://crusty-metallian.net";
const BLOG_WWW: &str = "https://www.crusty-metallian.net";
const STRANGER: &str = "https://evil.example";

async fn allow_origin_for(origin: &str) -> Option<String> {
    let app = spawn_app().await;
    let response = app
        .unauthenticated_client
        .get(format!("{}/rotation", app.address))
        .header(ORIGIN, origin)
        .send()
        .await
        .expect("Failed to execute request.");

    response
        .headers()
        .get(ACCESS_CONTROL_ALLOW_ORIGIN)
        .map(|v| v.to_str().unwrap().to_owned())
}

#[tokio::test]
async fn the_blog_origin_is_echoed_back() {
    assert_eq!(allow_origin_for(BLOG).await.as_deref(), Some(BLOG));
}

#[tokio::test]
async fn the_www_blog_origin_is_echoed_back() {
    assert_eq!(allow_origin_for(BLOG_WWW).await.as_deref(), Some(BLOG_WWW));
}

#[tokio::test]
async fn an_unlisted_origin_gets_no_allow_origin_header() {
    // Absent, not `*` and not the stranger's own origin: the browser then
    // refuses the response to that site's script.
    assert_eq!(allow_origin_for(STRANGER).await, None);
}

#[tokio::test]
async fn a_preflight_from_the_blog_succeeds() {
    let app = spawn_app().await;
    let response = app
        .unauthenticated_client
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/rotation", app.address),
        )
        .header(ORIGIN, BLOG)
        .header("access-control-request-method", "GET")
        .header("access-control-request-headers", "datastar-request")
        .send()
        .await
        .expect("Failed to execute request.");

    assert!(response.status().is_success());
    assert_eq!(
        response
            .headers()
            .get(ACCESS_CONTROL_ALLOW_ORIGIN)
            .and_then(|v| v.to_str().ok()),
        Some(BLOG)
    );
}
