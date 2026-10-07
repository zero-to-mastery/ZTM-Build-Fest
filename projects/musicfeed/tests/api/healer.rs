// tests/api/healer.rs
//
// The healer's pass, end to end: a real store, a stubbed metadata service, and
// `heal_once` in the middle. Written red first — the module did not exist when
// these were composed.

use musicfeed::database::{DatabaseBackend, SqliteRepository};
use musicfeed::domain::NewRotationEntry;
use musicfeed::healer::heal_once;
use musicfeed::metadata::MetadataClient;

use crate::metadata_stub::MetadataStubs;

async fn store() -> (tempfile::TempDir, SqliteRepository) {
    let dir = tempfile::tempdir().expect("temp dir");
    let settings = musicfeed::configuration::DatabaseSettings {
        path: dir.path().join("test.db").display().to_string(),
        max_connections: Some(1),
    };
    let repo = SqliteRepository::new(&settings)
        .await
        .expect("store connects and migrates");
    (dir, repo)
}

fn bare(artist: &str, album: &str) -> NewRotationEntry {
    NewRotationEntry {
        listened_date: chrono::NaiveDate::from_ymd_opt(2026, 10, 7).expect("valid date"),
        artist: artist.to_string(),
        album: album.to_string(),
        cover: None,
        year: None,
        note: None,
    }
}

async fn client_for(stubs: &MetadataStubs) -> MetadataClient {
    MetadataClient::with_base_urls(stubs.musicbrainz.uri(), stubs.cover_art.uri())
}

#[tokio::test]
async fn a_hit_fills_the_entry_and_clears_it_from_the_candidates() {
    let stubs = MetadataStubs::full_hit("9ca804b8-afbe-3599-b581-e3a3238961a0").await;
    let (_dir, repo) = store().await;
    let metadata = client_for(&stubs).await;

    repo.insert(bare("Sabaton", "Attero Dominatus"))
        .await
        .expect("insert");

    let report = heal_once(&repo, &metadata, 5, 3).await.expect("heal pass");

    assert_eq!(report.healed, 1, "the lookup hit: one entry healed");
    assert_eq!(report.missed, 0);

    let listed = repo.list().await.expect("list");
    assert_eq!(listed.len(), 1);
    assert!(
        listed[0].cover.is_some(),
        "cover was not written back: {:?}",
        listed[0].cover
    );
    assert_eq!(listed[0].year, Some(2006));

    let candidates = repo.list_incomplete(5, 10).await.expect("candidates");
    assert!(
        candidates.is_empty(),
        "a healed entry leaves the candidate set"
    );
}

#[tokio::test]
async fn a_total_miss_counts_as_a_failure_and_increments_attempts() {
    let stubs = MetadataStubs::miss().await;
    let (_dir, repo) = store().await;
    let metadata = client_for(&stubs).await;

    repo.insert(bare("Celtic Frost", "To Mega Therion"))
        .await
        .expect("insert");

    let report = heal_once(&repo, &metadata, 5, 3).await.expect("heal pass");

    assert_eq!(report.missed, 1, "a lookup that found nothing is a miss");
    assert_eq!(report.healed, 0);

    // attempts=1, cap 2 → still a candidate on the next pass
    let still_candidate = repo.list_incomplete(2, 10).await.expect("candidates");
    assert_eq!(still_candidate.len(), 1);
}

#[tokio::test]
async fn complete_entries_are_never_candidates() {
    let stubs = MetadataStubs::miss().await;
    let (_dir, repo) = store().await;
    let metadata = client_for(&stubs).await;

    let mut full = bare("Judas Priest", "Invincible Shield");
    full.cover = Some("http://coverartarchive.org/front.jpg".to_string());
    full.year = Some(2024);
    repo.insert(full).await.expect("insert");

    let report = heal_once(&repo, &metadata, 5, 3).await.expect("heal pass");

    assert_eq!(report.healed, 0, "nothing was incomplete");
    assert_eq!(report.missed, 0, "no lookup should have been issued");
}
