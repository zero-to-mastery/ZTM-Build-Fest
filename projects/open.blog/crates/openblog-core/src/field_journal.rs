//! Outdoor field-journal metadata with publish-time location privacy.

use crate::{frontmatter::FrontMatter, video::parse_duration_seconds};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LocationPrivacy {
    Exact,
    Trimmed,
    Approximate,
    #[default]
    Hidden,
}

impl LocationPrivacy {
    pub fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("exact") => Self::Exact,
            Some("trimmed") => Self::Trimmed,
            Some("approximate") => Self::Approximate,
            _ => Self::Hidden,
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Exact => "Exact route",
            Self::Trimmed => "Endpoints trimmed",
            Self::Approximate => "Approximate route",
            Self::Hidden => "Route hidden",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FieldJournalMetadata {
    pub activity: String,
    pub location: Option<String>,
    pub privacy: LocationPrivacy,
    pub distance_km: Option<String>,
    pub elevation_gain_m: Option<u32>,
    pub duration_seconds: Option<u32>,
    pub conditions: Option<String>,
    pub route_url: Option<String>,
    /// Privacy-filtered, normalized `x,y` pairs in a 1000 × 100 view box.
    pub route_shape: Option<String>,
    /// Normalized distance/elevation `x,y` pairs in a 1000 × 100 view box.
    pub elevation_profile: Option<String>,
}

impl FieldJournalMetadata {
    pub fn from_front_matter(fm: &FrontMatter) -> Self {
        let value = |key: &str| {
            fm.get(key)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        let privacy = LocationPrivacy::parse(fm.get("locationPrivacy"));
        let distance_km = value("distanceKm").filter(|value| {
            value
                .parse::<f64>()
                .is_ok_and(|number| number >= 0.0 && number.is_finite())
        });
        Self {
            activity: value("activity").unwrap_or_else(|| "Hike".to_string()),
            location: value("location"),
            privacy,
            distance_km,
            elevation_gain_m: fm.get_u32("elevationGainM"),
            duration_seconds: value("duration")
                .as_deref()
                .and_then(parse_duration_seconds),
            conditions: value("conditions"),
            route_url: (privacy == LocationPrivacy::Exact)
                .then(|| value("route").filter(|route| safe_track_url(route)))
                .flatten(),
            route_shape: (privacy != LocationPrivacy::Hidden)
                .then(|| value("routeShape").and_then(validate_points))
                .flatten(),
            elevation_profile: value("elevationProfile").and_then(validate_points),
        }
    }
}

fn safe_track_url(value: &str) -> bool {
    let Some(relative) = value.strip_prefix("/tracks/uploads/") else {
        return false;
    };
    !relative.is_empty()
        && relative.ends_with(".gpx")
        && !relative.contains("..")
        && relative
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
}

fn validate_points(value: String) -> Option<String> {
    let segments = value.split('|').collect::<Vec<_>>();
    let points = segments
        .iter()
        .flat_map(|segment| segment.split_whitespace())
        .collect::<Vec<_>>();
    if segments.is_empty()
        || segments
            .iter()
            .any(|segment| segment.split_whitespace().count() < 2)
        || !(2..=500).contains(&points.len())
    {
        return None;
    }
    let valid = points.iter().all(|point| {
        let Some((x, y)) = point.split_once(',') else {
            return false;
        };
        let (Ok(x), Ok(y)) = (x.parse::<u16>(), y.parse::<u16>()) else {
            return false;
        };
        x <= 1000 && y <= 100
    });
    valid.then(|| {
        segments
            .iter()
            .map(|segment| segment.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect::<Vec<_>>()
            .join("|")
    })
}
