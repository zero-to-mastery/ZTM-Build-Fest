// tests/api/metadata_stub.rs

//! Stub responses shaped like the real MusicBrainz and Cover Art Archive.
//!
//! Every body here is trimmed from a live capture, so a change in the real
//! services' shape shows up here as a test failure rather than as a mystery at
//! runtime.
//!
//! **Two servers, not one.** Both services' URLs start with `/release/`, and the
//! search endpoint differs from the cover endpoint only by having a query string.
//! Pointing both base URLs at one `MockServer` makes that distinction the *only*
//! thing keeping the mocks apart, which is far too fragile. Two servers means
//! the routing is unambiguous by construction.

use wiremock::matchers::{method, path, path_regex, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// The two stub servers backing one app, plus convenience registration.
pub struct MetadataStubs {
    pub musicbrainz: MockServer,
    pub cover_art: MockServer,
}

impl MetadataStubs {
    /// Start both servers with no mocks registered.
    pub async fn start() -> Self {
        Self {
            musicbrainz: MockServer::start().await,
            cover_art: MockServer::start().await,
        }
    }

    /// Start both servers with the happy path registered.
    pub async fn full_hit(mb_id: &str) -> Self {
        let stubs = Self::start().await;
        stubs.expect_full_hit(mb_id).await;
        stubs
    }

    /// Start both servers with the search returning nothing.
    pub async fn miss() -> Self {
        let stubs = Self::start().await;
        stubs.expect_miss().await;
        stubs
    }

    /// Start both servers with every request erroring.
    pub async fn failure() -> Self {
        let stubs = Self::start().await;
        stubs.expect_failure().await;
        stubs
    }

    /// The album exists and the archive has a front cover.
    pub async fn expect_full_hit(&self, mb_id: &str) {
        album_found(mb_id).expect(1).mount(&self.musicbrainz).await;
        cover_found(mb_id).expect(1).mount(&self.cover_art).await;
    }

    /// The album exists but the archive has no art for it.
    pub async fn expect_no_art(&self, mb_id: &str) {
        album_found(mb_id).expect(1).mount(&self.musicbrainz).await;
        cover_missing(mb_id).expect(1).mount(&self.cover_art).await;
    }

    /// Nothing matches, so nothing is fetched.
    pub async fn expect_miss(&self) {
        album_missing().mount(&self.musicbrainz).await;
    }

    /// Every request errors — the case that must never block a save.
    pub async fn expect_failure(&self) {
        service_unavailable().mount(&self.musicbrainz).await;
        service_unavailable().mount(&self.cover_art).await;
    }
}

// ---------------------------------------------------------------------------
// MusicBrainz
// ---------------------------------------------------------------------------

/// A release search returning one exact-match album.
///
/// `date` is the full ISO date the real service returns; the client takes the
/// year from the first four characters.
pub fn album_found(mb_id: &str) -> Mock {
    Mock::given(method("GET"))
        // `path_regex` matches only `url.path()`, which never includes the query
        // string — so `^/release/\?` could never match. Match the path, then
        // assert on a query parameter separately.
        .and(path("/release/"))
        .and(query_param("fmt", "json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "created": "2026-10-04T04:15:31.833Z",
            "count": 1,
            "offset": 0,
            "releases": [{
                "id": mb_id,
                "score": 100,
                "status": "Official",
                "title": "Attero Dominatus",
                "artist-credit": [{
                    "name": "Sabaton",
                    "artist": { "id": "39a31de6-763d-48b6-a45c-f7cfad58ffd8", "name": "Sabaton" }
                }],
                "release-group": {
                    "id": "9ca804b8-afbe-3599-b581-e3a3238961a0",
                    "primary-type": "Album",
                    "title": "Attero Dominatus"
                },
                "date": "2006-07-28",
                "country": "SE",
                "track-count": 9
            }]
        })))
}

/// The search matched nothing at all.
pub fn album_missing() -> Mock {
    Mock::given(method("GET"))
        .and(path("/release/"))
        .and(query_param("fmt", "json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "created": "2026-10-04T04:15:31.833Z",
            "count": 0,
            "offset": 0,
            "releases": []
        })))
}

// ---------------------------------------------------------------------------
// Cover Art Archive
// ---------------------------------------------------------------------------

/// Cover art for a release, including a back cover so the front-cover filter is
/// genuinely exercised.
pub fn cover_found(mb_id: &str) -> Mock {
    Mock::given(method("GET"))
        .and(path_regex(format!(r"^/release/{mb_id}/?$")))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "images": [
                {
                    "front": false,
                    "types": ["Back"],
                    "image": "http://coverartarchive.org/back.jpg",
                    "thumbnails": { "250": "http://coverartarchive.org/back-250.jpg" }
                },
                {
                    "front": true,
                    "types": ["Front"],
                    "image": "http://coverartarchive.org/front.jpg",
                    "thumbnails": {
                        "250": format!("http://coverartarchive.org/release/{mb_id}/front-250.jpg"),
                        "500": format!("http://coverartarchive.org/release/{mb_id}/front-500.jpg")
                    }
                }
            ]
        })))
}

/// The archive has no art for this release — common for bootlegs.
pub fn cover_missing(mb_id: &str) -> Mock {
    Mock::given(method("GET"))
        .and(path_regex(format!(r"^/release/{mb_id}/?$")))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "images": []
        })))
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/// The service is unavailable.
pub fn service_unavailable() -> Mock {
    Mock::given(method("GET")).respond_with(ResponseTemplate::new(503))
}
