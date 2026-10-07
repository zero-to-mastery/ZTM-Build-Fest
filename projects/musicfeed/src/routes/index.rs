// src/routes/index.rs

use crate::AppState;
use crate::database::DatabaseError;
use crate::utils::error_chain_fmt;
use axum::{
    extract::State,
    http::StatusCode,
    response::{Html, IntoResponse, Response},
};
use axum_macros::debug_handler;
use tera::Context;

#[derive(thiserror::Error)]
pub enum IndexError {
    #[error("database operation failed")]
    Database(#[from] DatabaseError),
    #[error("template rendering failed")]
    Template(#[from] tera::Error),
}

impl std::fmt::Debug for IndexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        error_chain_fmt(self, f)
    }
}

impl IntoResponse for IndexError {
    fn into_response(self) -> Response {
        tracing::error!(error = ?self, "index page failed");
        (StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong.").into_response()
    }
}

#[debug_handler]
pub async fn get_index_page(State(state): State<AppState>) -> Result<Html<String>, IndexError> {
    let rotation_entries = state.database.list().await?;
    let mut context = Context::new();
    context.insert("rotation_entries", &rotation_entries);

    let body = Html(state.templates.render("index.html", &context)?);

    Ok(body)
}
