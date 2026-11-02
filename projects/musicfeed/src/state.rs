// src/state.rs

use crate::configuration::{BasicAuthSettings, CorsSettings, DatabaseSettings, MetadataSettings};
use crate::database::{DatabaseBackend, SqliteRepository};
use crate::metadata::MetadataClient;
use anyhow::Context;
use axum::http::HeaderValue;
use std::sync::Arc;
use tera::Tera;

#[derive(Clone)]
pub struct AppState {
    pub templates: Tera,
    /// The persistence boundary. Routes code against the trait; which backend
    /// sits behind it is a startup decision, not a type decision. `Debug` was
    /// dropped from this struct along with the in-memory Vec: a trait object
    /// is not Debug, and nothing ever printed the app state.
    pub database: Arc<dyn DatabaseBackend>,
    /// Held here rather than constructed per request so the underlying
    /// connection pool is reused. Cheap to clone, no global state.
    pub metadata: MetadataClient,
    pub basicauth: BasicAuthSettings,
    /// Parsed at construction, so a malformed origin fails startup rather
    /// than quietly locking the blog out.
    pub cors_origins: Vec<HeaderValue>,
}

impl AppState {
    /// Connects to the store and runs migrations, so the schema is at head
    /// before the first request. Async and fallible now: the pool is a real
    /// resource, not a mutex over a Vec.
    pub async fn new(
        metadata_settings: &MetadataSettings,
        basicauth_settings: &BasicAuthSettings,
        database_settings: &DatabaseSettings,
        cors_settings: &CorsSettings,
    ) -> anyhow::Result<Self> {
        let cors_origins = cors_settings
            .allowed_origins
            .iter()
            .map(|origin| {
                HeaderValue::from_str(origin)
                    .with_context(|| format!("invalid CORS origin in configuration: {origin:?}"))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;

        let mut tera = Tera::default();
        tera.load_from_glob("templates/**/*.html")
            .expect("Unable to load the Tera templates.");

        let database: Arc<dyn DatabaseBackend> =
            Arc::new(SqliteRepository::new(database_settings).await?);

        Ok(Self {
            templates: tera,
            database,
            metadata: MetadataClient::with_base_urls(
                metadata_settings.musicbrainz_base_url.clone(),
                metadata_settings.cover_art_base_url.clone(),
            ),
            basicauth: basicauth_settings.to_owned(),
            cors_origins,
        })
    }
}
