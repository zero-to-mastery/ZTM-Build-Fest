// src/state.rs

use crate::configuration::{BasicAuthSettings, DatabaseSettings, MetadataSettings};
use crate::database::{DatabaseBackend, SqliteRepository};
use crate::metadata::MetadataClient;
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
}

impl AppState {
    /// Connects to the store and runs migrations, so the schema is at head
    /// before the first request. Async and fallible now: the pool is a real
    /// resource, not a mutex over a Vec.
    pub async fn new(
        metadata_settings: &MetadataSettings,
        basicauth_settings: &BasicAuthSettings,
        database_settings: &DatabaseSettings,
    ) -> anyhow::Result<Self> {
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
        })
    }
}
