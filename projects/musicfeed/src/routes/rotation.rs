// src/routes/rotation.rs

use crate::database::DatabaseError;
use crate::domain::{NewRotationEntry, RotationEntry};
use crate::metadata::AlbumQuery;
use crate::state::AppState;
use crate::utils::{compact_html, error_chain_fmt};
use axum::response::{
    IntoResponse, Response,
    sse::{Event, Sse},
};
use axum::{extract::State, http::StatusCode};
use axum_macros::debug_handler;
use chrono::Local;
use datastar::{axum::ReadSignals, prelude::*};
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use tera::Context;

#[derive(thiserror::Error)]
pub enum RotationEntryError {
    #[error("rotation entry not found")]
    NotFound,
    #[error("database operation failed")]
    Database(#[from] DatabaseError),
    #[error("template rendering failed")]
    Template(#[from] tera::Error),
}

impl std::fmt::Debug for RotationEntryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        error_chain_fmt(self, f)
    }
}

impl IntoResponse for RotationEntryError {
    fn into_response(self) -> Response {
        tracing::error!(error = ?self, "request failed");
        let status = match self {
            RotationEntryError::NotFound => StatusCode::NOT_FOUND,
            RotationEntryError::Database(_) | RotationEntryError::Template(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        (status, "Something went wrong.").into_response()
    }
}

/// What the form sends. `cover` and `year` are absent by design — they are looked
/// up, not typed. `id` and `listened_date` are absent because the app controls
/// them, so a client cannot forge either.
#[derive(Clone, Deserialize, Serialize)]
pub struct RawRotationEntry {
    artist: String,
    album: String,
    note: String,
}

/// Signal used to tell the user the lookup failed without discarding the entry.
const METADATA_STATUS: &str = "metadata_status";
const LOOKUP_FAILED: &str = "Could not look that up - saved without a cover or year";

/// Render a single rotation entry fragment via Tera.
///
/// This is the single source of truth for the `<li>` markup: `index.html` includes
/// the same partial for the server-rendered page, so the initial render and the SSE
/// patch can never disagree. Routing both through Tera also means user input is
/// escaped by the same rules on both paths - do not hand-build this HTML.
fn render_rotation(state: &AppState, entry: &RotationEntry) -> Result<String, RotationEntryError> {
    let mut context = Context::new();
    context.insert("rotation_entry", entry);
    Ok(compact_html(
        &state.templates.render("rotation.html", &context)?,
    ))
}

#[debug_handler]
pub async fn post_rotation_entry_ds(
    State(state): State<AppState>,
    ReadSignals(raw_rotation_entry): ReadSignals<RawRotationEntry>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, RotationEntryError> {
    // Look the album up before anything else. This never blocks the save: a
    // miss and a failure both come back as empty metadata, and the user is told
    // which happened via the status signal below.
    let query = AlbumQuery::new(&raw_rotation_entry.artist, &raw_rotation_entry.album);
    let looked_up = state.metadata.lookup(&query).await;

    let lookup_failed = looked_up.is_err();
    let metadata = looked_up.unwrap_or_default();

    // The store assigns the id — the database is the counter, so a slow or
    // failed lookup burns nothing and a client cannot forge one.
    let new_entry = NewRotationEntry {
        listened_date: Local::now().date_naive(),
        artist: raw_rotation_entry.artist,
        album: raw_rotation_entry.album,
        cover: metadata.cover,
        year: metadata.year,
        note: (!raw_rotation_entry.note.is_empty()).then_some(raw_rotation_entry.note),
    };
    let entry = state.database.insert(new_entry).await?;

    // Render after insert. The old in-memory code rendered before pushing so a
    // template failure could not leave a half-added entry; with a store as the
    // source of truth the risk inverts — a render failure after a successful
    // insert leaves the entry saved but unpatched, recoverable on the next
    // page load, which beats losing a logged album to a template hiccup.
    let rendered = render_rotation(&state, &entry)?;

    let patch = PatchElements::new(rendered)
        .selector("#rotation-list")
        .mode(ElementPatchMode::Append)
        .write_as_axum_sse_event();

    // The empty-state message is rendered inside `#rotation-list`, so the append
    // above would otherwise leave it sitting below the new entry. Remove it now
    // that there is something to show. Removing an element that is already gone
    // is a no-op, so this is safe on every subsequent post as well as the first.
    let clear_empty = PatchElements::new_remove("#rotation-empty").write_as_axum_sse_event();

    // Reset the bound signals so the form is ready for the next entry.
    //
    // Every value pushed back must be something the next request can actually
    // deserialize. All three fields are `String`, so "" is safe for all of them -
    // which is precisely why `year` is not bound here any more. It is looked up,
    // not typed, so there is nothing for the user to clear.
    let clear = PatchSignals::new(format!(
        r#"{{"artist":"","album":"","note":"","{METADATA_STATUS}":""}}"#
    ))
    .write_as_axum_sse_event();

    let mut events = vec![Ok(patch), Ok(clear_empty), Ok(clear)];

    // Option 2: the entry is saved either way, but a failed lookup is surfaced
    // rather than silently dropping the cover the user expected to get.
    if lookup_failed {
        let status = PatchSignals::new(format!(r#"{{"{METADATA_STATUS}":"{LOOKUP_FAILED}"}}"#))
            .write_as_axum_sse_event();
        events.push(Ok(status));
    }

    let sse_event = Sse::new(tokio_stream::iter(events));

    Ok(sse_event)
}

#[debug_handler]
pub async fn get_rotation_entry(
    State(state): State<AppState>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, RotationEntryError> {
    // Pick a random entry to hand back.
    //
    // The empty-rotation 404 contract lives in the store now: `LIMIT 1` over
    // an empty table yields no row, and `random` answers `NotFound`. The
    // route only translates that into the response the blog island expects.
    let entry = state.database.random().await.map_err(|error| match error {
        DatabaseError::NotFound => RotationEntryError::NotFound,
        other => RotationEntryError::Database(other),
    })?;

    let rendered = render_rotation(&state, &entry)?;

    let patch = PatchElements::new(rendered)
        .selector("#rotation-list")
        .mode(ElementPatchMode::Append)
        .write_as_axum_sse_event();

    let sse_event = Sse::new(tokio_stream::iter(vec![Ok(patch)]));

    Ok(sse_event)
}
