// src/domain.rs

use chrono::NaiveDate;

#[derive(Clone, Debug, serde::Serialize)]
pub struct RotationEntry {
    pub id: u64,
    pub listened_date: NaiveDate,
    pub artist: String,
    pub album: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    /// Release year, looked up rather than typed. Optional because a miss is
    /// ordinary — bootlegs and regional compilations often have no reliable
    /// date. `0` is not a year, which is why this is `Option` and not a plain
    /// integer with a sentinel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// What a caller supplies to store a new entry. `id` and any derived fields
/// are deliberately absent: the store assigns the id — the database is the
/// counter now — so a caller cannot forge or collide with one.
#[derive(Clone, Debug)]
pub struct NewRotationEntry {
    pub listened_date: NaiveDate,
    pub artist: String,
    pub album: String,
    pub cover: Option<String>,
    pub year: Option<i32>,
    pub note: Option<String>,
}
