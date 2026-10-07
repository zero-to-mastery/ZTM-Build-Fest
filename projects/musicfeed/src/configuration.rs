// src/configuration.rs

use serde::Deserialize;

#[derive(Deserialize)]
pub struct Settings {
    pub application: ApplicationSettings,
    pub metadata: MetadataSettings,
    pub basicauth: BasicAuthSettings,
    pub database: DatabaseSettings,
    pub healing: HealingSettings,
}

#[derive(Deserialize)]
pub struct ApplicationSettings {
    pub host: String,
    pub port: u16,
}

#[derive(Deserialize)]
pub struct MetadataSettings {
    /// Overridable so a test can point both services at a local stub.
    pub musicbrainz_base_url: String,
    pub cover_art_base_url: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BasicAuthSettings {
    pub username: String,
    pub password: String,
}

/// Borrowed from the metallian-photos database layer: a file path plus an
/// optional pool cap. `max_connections` stays optional so tests can use the
/// sqlx default while production pins a small pool.
#[derive(Clone, Debug, Deserialize)]
pub struct DatabaseSettings {
    pub path: String,
    pub max_connections: Option<u32>,
}

/// The background healer's tuning. `enabled` can be flipped from the Railway
/// environment (`APP_HEALING__ENABLED=false`) without a redeploy.
#[derive(Clone, Debug, Deserialize)]
pub struct HealingSettings {
    pub enabled: bool,
    pub interval_secs: u64,
    pub max_attempts: u32,
    pub per_pass: u32,
}

pub fn get_configuration() -> Result<Settings, config::ConfigError> {
    let base_path = std::env::current_dir().expect("Failed to determine the current directory");
    let configuration_directory = base_path.join("configuration");

    // Detect the running environment.
    // Default to `local` if unspecified.
    let environment: Environment = std::env::var("APP_ENVIRONMENT")
        .unwrap_or_else(|_| "local".into())
        .try_into()
        .expect("Failed to parse APP_ENVIRONMENT.");
    let environment_filename = format!("{}.toml", environment.as_str());
    let settings = config::Config::builder()
        .add_source(config::File::from(
            configuration_directory.join("base.toml"),
        ))
        .add_source(config::File::from(
            configuration_directory.join(environment_filename),
        ))
        // Add in settings from environment variables (with a prefix of APP and '__' as separator)
        // E.g. `APP_APPLICATION__PORT=5001 would set `Settings.application.port`
        .add_source(
            config::Environment::with_prefix("APP")
                .prefix_separator("_")
                .separator("__"),
        )
        .build()?;

    settings.try_deserialize::<Settings>()
}

pub enum Environment {
    Local,
    Production,
}

impl Environment {
    fn as_str(&self) -> &'static str {
        match self {
            Environment::Local => "local",
            Environment::Production => "production",
        }
    }
}

impl TryFrom<String> for Environment {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.to_lowercase().as_str() {
            "local" => Ok(Environment::Local),
            "production" => Ok(Environment::Production),
            other => Err(format!(
                "{other} is not a supported environment. Use either `local` or `production`."
            )),
        }
    }
}
