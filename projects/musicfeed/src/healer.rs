// src/healer.rs
//
// The missing-metadata healer: a background pass that finds entries saved
// without cover art or a release year, re-runs the lookup that failed when
// they were posted, and writes back whatever it finds.
//
// Two design facts worth keeping in one place:
//
// 1. Execution. The worker is spawned once, at process startup, and holds its
//    own timer: one pass immediately (a waking process is a healing process —
//    the blog widget's GET is the de facto scheduler), then a pass every
//    `interval_secs`. It dies with the process; a pass cut off by a restart is
//    simply redone on the next one.
//
// 2. Failure path. Entries the lookup cannot resolve (bootlegs, releases with
//    no artwork anywhere) must not be retried forever: every total miss
//    increments `heal_attempts`, and the candidate query excludes entries at
//    the cap. Success resets the counter — a later pass can always try a
//    formerly-hopeless entry again if it ever re-enters the candidate set.

use crate::database::{DatabaseBackend, DatabaseError};
use crate::metadata::{AlbumQuery, MetadataClient};
use std::time::Duration;

/// What one healing pass accomplished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HealReport {
    pub healed: u32,
    pub missed: u32,
}

/// One healing pass over up to `per_pass` candidates.
///
/// A lookup "hits" if it returns a cover *or* a year — partial finds are
/// written (NULL overwritten by NULL is a no-op) and the attempt counter
/// resets. A total miss increments the counter.
pub async fn heal_once(
    database: &dyn DatabaseBackend,
    metadata: &MetadataClient,
    max_attempts: u32,
    per_pass: usize,
) -> Result<HealReport, DatabaseError> {
    let candidates = database
        .list_incomplete(max_attempts, per_pass as i64)
        .await?;
    let mut report = HealReport {
        healed: 0,
        missed: 0,
    };

    for entry in candidates {
        let query = AlbumQuery::new(&entry.artist, &entry.album);
        let found = metadata.lookup_best_effort(&query).await;

        if found.cover.is_some() || found.year.is_some() {
            database
                .update_metadata(entry.id, found.cover, found.year)
                .await?;
            report.healed += 1;
            tracing::info!(
                entry = entry.id,
                artist = %entry.artist,
                album = %entry.album,
                "healed rotation entry"
            );
        } else {
            database.record_heal_failure(entry.id).await?;
            report.missed += 1;
            tracing::warn!(
                entry = entry.id,
                artist = %entry.artist,
                album = %entry.album,
                attempts = "incremented",
                "heal lookup found nothing"
            );
        }
    }

    Ok(report)
}

/// Start the healer alongside the server: one pass immediately (the process
/// waking is the first trigger), then a pass every `interval_secs`.
///
/// Detached by design — the task dies with the process, and a pass interrupted
/// by a restart is redone on the next one.
pub fn spawn_healer(state: crate::AppState, settings: crate::configuration::HealingSettings) {
    if !settings.enabled {
        tracing::info!("metadata healer disabled by configuration");
        return;
    }

    tokio::spawn(async move {
        loop {
            match heal_once(
                state.database.as_ref(),
                &state.metadata,
                settings.max_attempts,
                settings.per_pass as usize,
            )
            .await
            {
                Ok(report) if report.healed + report.missed > 0 => {
                    tracing::info!(
                        healed = report.healed,
                        missed = report.missed,
                        "heal pass complete"
                    );
                }
                Ok(_) => {}
                Err(error) => tracing::error!(error = ?error, "heal pass failed"),
            }

            tokio::time::sleep(Duration::from_secs(settings.interval_secs)).await;
        }
    });
}
