//! The towns a business serves, stored once under `serviceAreas` in `openblog.json` (ADR 0314).
//!
//! An area is a town and a region and, optionally, a short note such as "within 30 miles". Nothing
//! finer than a town is ever stored, so nothing finer can be published. Pure validation and
//! derivation: the list is the only input, so the same list always gives the same addresses.
//!
//! The stored object is `{ "version": 1, "areas": [ { "town", "region", "note" } ] }`. A bare list of
//! areas is read as version 1. A site without the member builds exactly as before.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Map, Value};

/// The only stored version this release reads or writes.
pub const SERVICE_AREAS_VERSION: u64 = 1;
/// The first address segment of the index and of every area page.
pub const AREAS_DIR: &str = "areas";
/// The address of the service-area index.
pub const AREAS_URL: &str = "/areas/";
pub const MAX_AREAS: usize = 100;
pub const MAX_NOTE: usize = 120;

/// Regions the build can format: a stored region is the short code, and a full name is read as its
/// code. A region not listed here is kept as written.
const REGIONS: &[(&str, &str)] = &[
    ("AL", "Alabama"),
    ("AK", "Alaska"),
    ("AZ", "Arizona"),
    ("AR", "Arkansas"),
    ("CA", "California"),
    ("CO", "Colorado"),
    ("CT", "Connecticut"),
    ("DE", "Delaware"),
    ("DC", "District of Columbia"),
    ("FL", "Florida"),
    ("GA", "Georgia"),
    ("HI", "Hawaii"),
    ("ID", "Idaho"),
    ("IL", "Illinois"),
    ("IN", "Indiana"),
    ("IA", "Iowa"),
    ("KS", "Kansas"),
    ("KY", "Kentucky"),
    ("LA", "Louisiana"),
    ("ME", "Maine"),
    ("MD", "Maryland"),
    ("MA", "Massachusetts"),
    ("MI", "Michigan"),
    ("MN", "Minnesota"),
    ("MS", "Mississippi"),
    ("MO", "Missouri"),
    ("MT", "Montana"),
    ("NE", "Nebraska"),
    ("NV", "Nevada"),
    ("NH", "New Hampshire"),
    ("NJ", "New Jersey"),
    ("NM", "New Mexico"),
    ("NY", "New York"),
    ("NC", "North Carolina"),
    ("ND", "North Dakota"),
    ("OH", "Ohio"),
    ("OK", "Oklahoma"),
    ("OR", "Oregon"),
    ("PA", "Pennsylvania"),
    ("RI", "Rhode Island"),
    ("SC", "South Carolina"),
    ("SD", "South Dakota"),
    ("TN", "Tennessee"),
    ("TX", "Texas"),
    ("UT", "Utah"),
    ("VT", "Vermont"),
    ("VA", "Virginia"),
    ("WA", "Washington"),
    ("WV", "West Virginia"),
    ("WI", "Wisconsin"),
    ("WY", "Wyoming"),
    ("AB", "Alberta"),
    ("BC", "British Columbia"),
    ("MB", "Manitoba"),
    ("NB", "New Brunswick"),
    ("NL", "Newfoundland and Labrador"),
    ("NS", "Nova Scotia"),
    ("NT", "Northwest Territories"),
    ("NU", "Nunavut"),
    ("ON", "Ontario"),
    ("PE", "Prince Edward Island"),
    ("QC", "Quebec"),
    ("SK", "Saskatchewan"),
    ("YT", "Yukon"),
];

fn collapse(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn known_region(value: &str) -> Option<(&'static str, &'static str)> {
    let value = collapse(value);
    REGIONS
        .iter()
        .find(|(code, name)| code.eq_ignore_ascii_case(&value) || name.eq_ignore_ascii_case(&value))
        .copied()
}

/// A region as the build writes it: the short code when the bundled list knows it, else as written.
pub fn format_region(value: &str) -> String {
    match known_region(value) {
        Some((code, _)) => code.to_string(),
        None => collapse(value),
    }
}

/// The full name of a region the bundled list knows, else the region as written.
fn region_name(value: &str) -> String {
    match known_region(value) {
        Some((_, name)) => name.to_string(),
        None => collapse(value),
    }
}

/// How a town is compared: whitespace collapsed, case ignored.
fn town_key(value: &str) -> String {
    collapse(value).to_lowercase()
}

/// How a region is compared, so `Washington`, `wa` and `WA` are one place.
fn region_key(value: &str) -> String {
    format_region(value).to_lowercase()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceArea {
    pub town: String,
    /// Formatted by [`format_region`].
    pub region: String,
    /// What the owner says about the reach, as one plain line; may be empty.
    pub note: String,
}

impl ServiceArea {
    /// "Bend, OR".
    pub fn label(&self) -> String {
        format!("{}, {}", self.town, self.region)
    }

    /// Whether a job's place is this area: same town and region, ignoring case and region spelling.
    pub fn covers(&self, town: &str, region: &str) -> bool {
        town_key(&self.town) == town_key(town) && region_key(&self.region) == region_key(region)
    }

    /// `areaServed` for this area, from the configured town and region only.
    pub fn area_served(&self) -> Value {
        json!({
            "@type": "City",
            "name": self.town,
            "containedInPlace": { "@type": "AdministrativeArea", "name": region_name(&self.region) },
        })
    }
}

/// An area with its derived address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedArea<'a> {
    pub area: &'a ServiceArea,
    pub slug: String,
    pub url: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ServiceAreasConfig {
    pub areas: Vec<ServiceArea>,
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "nothing",
        Value::Bool(_) => "true or false",
        Value::Number(_) => "a number",
        Value::String(_) => "text",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

impl ServiceAreasConfig {
    /// True when no area is stated: nothing is emitted and nothing is written back.
    pub fn is_default(&self) -> bool {
        self.areas.is_empty()
    }

    /// Validate a stored or submitted `serviceAreas` value. Every problem is reported, in plain words.
    pub fn from_value(value: &Value) -> Result<ServiceAreasConfig, Vec<String>> {
        let mut errors = Vec::new();
        let items = match value {
            Value::Null => return Ok(ServiceAreasConfig::default()),
            Value::Array(items) => items,
            Value::Object(object) => {
                match object.get("version") {
                    None | Some(Value::Null) => {}
                    Some(Value::Number(n)) if n.as_u64() == Some(SERVICE_AREAS_VERSION) => {}
                    Some(Value::Number(n))
                        if n.as_u64().is_some_and(|v| v > SERVICE_AREAS_VERSION) =>
                    {
                        return Err(vec![
                            "serviceAreas was saved by a newer version of open.blog; update before editing it"
                                .into(),
                        ])
                    }
                    Some(_) => errors.push(format!(
                        "serviceAreas: version must be {SERVICE_AREAS_VERSION}"
                    )),
                }
                for key in object.keys() {
                    if key != "version" && key != "areas" {
                        errors.push(format!(
                            "serviceAreas: `{key}` is not a setting this release knows; use `version` and `areas`"
                        ));
                    }
                }
                match object.get("areas") {
                    None | Some(Value::Null) => return finish(errors, Vec::new()),
                    Some(Value::Array(items)) => items,
                    Some(other) => {
                        errors.push(format!(
                            "serviceAreas: areas must be a list, not {}",
                            kind(other)
                        ));
                        return Err(errors);
                    }
                }
            }
            other => {
                return Err(vec![format!(
                    "serviceAreas must be a list of towns, not {}",
                    kind(other)
                )])
            }
        };
        if items.len() > MAX_AREAS {
            errors.push(format!(
                "serviceAreas: list at most {MAX_AREAS} towns; a page for every town in a region is thin content"
            ));
            return Err(errors);
        }
        let mut areas: Vec<ServiceArea> = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let at = index + 1;
            let Some(object) = item.as_object() else {
                errors.push(format!(
                    "serviceAreas entry {at}: write each area as an object with a town and a region, not {}",
                    kind(item)
                ));
                continue;
            };
            if let Some(area) = area_from_object(at, object, &mut errors) {
                match areas
                    .iter()
                    .position(|other| other.covers(&area.town, &area.region))
                {
                    Some(first) => errors.push(format!(
                        "serviceAreas entry {at}: {} is already listed as entry {}; list each town once",
                        areas[first].label(),
                        first + 1
                    )),
                    None => areas.push(area),
                }
            }
        }
        finish(errors, areas)
    }

    /// The stored form, always the versioned object.
    pub fn to_value(&self) -> Value {
        let areas: Vec<Value> = self
            .areas
            .iter()
            .map(|area| {
                let mut object = Map::new();
                object.insert("town".into(), area.town.clone().into());
                object.insert("region".into(), area.region.clone().into());
                if !area.note.is_empty() {
                    object.insert("note".into(), area.note.clone().into());
                }
                Value::Object(object)
            })
            .collect();
        json!({ "version": SERVICE_AREAS_VERSION, "areas": areas })
    }

    /// Areas in the order pages and links list them (town, then region), each with its address.
    /// The address is the town's slug; a town that appears in more than one region gets the region
    /// added, and anything still equal gets a number, so the result does not depend on list order.
    pub fn plan(&self) -> Vec<PlannedArea<'_>> {
        let mut sorted: Vec<&ServiceArea> = self.areas.iter().collect();
        sorted.sort_by_key(|area| (town_key(&area.town), region_key(&area.region)));
        let base = |area: &ServiceArea| {
            let slug = crate::slug::limit(&crate::slug::slugify(&area.town), 60);
            if slug.is_empty() {
                "area".to_string()
            } else {
                slug
            }
        };
        let bases: Vec<String> = sorted.iter().map(|area| base(area)).collect();
        let mut slugs: Vec<String> = Vec::with_capacity(sorted.len());
        for (index, area) in sorted.iter().enumerate() {
            let shared = bases.iter().filter(|other| **other == bases[index]).count() > 1;
            let mut slug = if shared {
                let region = crate::slug::slugify(&area.region);
                if region.is_empty() {
                    bases[index].clone()
                } else {
                    format!("{}-{region}", bases[index])
                }
            } else {
                bases[index].clone()
            };
            let stem = slug.clone();
            let mut number = 2;
            while slugs.contains(&slug) {
                slug = format!("{stem}-{number}");
                number += 1;
            }
            slugs.push(slug);
        }
        sorted
            .into_iter()
            .zip(slugs)
            .map(|(area, slug)| PlannedArea {
                url: format!("{AREAS_URL}{slug}/"),
                area,
                slug,
            })
            .collect()
    }

    /// `areaServed` for the whole business: one node per area, in plan order. `None` when none are set.
    pub fn area_served(&self) -> Option<Value> {
        if self.areas.is_empty() {
            return None;
        }
        Some(Value::Array(
            self.plan()
                .iter()
                .map(|planned| planned.area.area_served())
                .collect(),
        ))
    }
}

/// Indices into `Site::posts` of the newest jobs whose place is this area, newest first, at most
/// `limit`. Read from the jobs archive plan (ADR 0286), so a job is here exactly when the archives
/// list it; only the job's town and region are compared and nothing else of its place exists.
pub fn recent_jobs(
    plan: &[crate::job_archive::JobArchive],
    site: &crate::model::Site,
    area: &ServiceArea,
    limit: usize,
) -> Vec<usize> {
    plan.iter()
        .find(|archive| archive.kind == crate::job_archive::JobArchiveKind::All)
        .map(|all| {
            all.posts
                .iter()
                .copied()
                .filter(|&index| {
                    site.posts[index]
                        .job
                        .as_ref()
                        .is_some_and(|job| area.covers(&job.town, &job.region))
                })
                .take(limit)
                .collect()
        })
        .unwrap_or_default()
}

/// Structured data for an area's page: the business (or the site title as an organization) with
/// `areaServed` for this town only. Built from configuration and nothing else; the caller escapes it
/// for a `<script>`.
pub fn json_ld(site: &crate::model::Site, area: &ServiceArea) -> String {
    let c = &site.config;
    let mut node = if c.business.has_public_facts() {
        let name = if c.business.name().is_empty() {
            c.title.as_str()
        } else {
            c.business.name()
        };
        json!({ "@type": c.business.schema_type(), "@id": c.absolute("/#business"), "name": name, "url": c.absolute("/") })
    } else {
        json!({ "@type": "Organization", "name": c.title, "url": c.absolute("/") })
    };
    node["areaServed"] = area.area_served();
    json!({ "@context": "https://schema.org", "@graph": [node] }).to_string()
}

fn finish(errors: Vec<String>, areas: Vec<ServiceArea>) -> Result<ServiceAreasConfig, Vec<String>> {
    if errors.is_empty() {
        Ok(ServiceAreasConfig { areas })
    } else {
        Err(errors)
    }
}

fn area_from_object(
    at: usize,
    object: &Map<String, Value>,
    errors: &mut Vec<String>,
) -> Option<ServiceArea> {
    let before = errors.len();
    for key in object.keys() {
        if !matches!(key.as_str(), "town" | "region" | "note") {
            errors.push(format!(
                "serviceAreas entry {at}: `{key}` is not a setting this release knows; use `town`, `region` and `note`"
            ));
        }
    }
    let mut place = |key: &str| -> String {
        let field = format!("serviceAreas entry {at}: {key}");
        let raw = match object.get(key) {
            Some(Value::String(text)) => collapse(text),
            None | Some(Value::Null) => String::new(),
            Some(other) => {
                errors.push(format!("{field} must be text, not {}", kind(other)));
                return String::new();
            }
        };
        if raw.is_empty() {
            errors.push(format!("{field} is missing; add the {key} name"));
            return raw;
        }
        match crate::job::normalize_place(&raw, &field) {
            Ok(value) => value,
            Err(problem) => {
                errors.push(problem);
                raw
            }
        }
    };
    let town = place("town");
    let region = place("region");
    let note = match object.get("note") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.chars().any(char::is_control) || trimmed.chars().count() > MAX_NOTE {
                errors.push(format!(
                    "serviceAreas entry {at}: note must be one line of plain text, at most {MAX_NOTE} characters"
                ));
            }
            trimmed.to_string()
        }
        Some(other) => {
            errors.push(format!(
                "serviceAreas entry {at}: note must be text, not {}",
                kind(other)
            ));
            String::new()
        }
    };
    if errors.len() > before {
        return None;
    }
    Some(ServiceArea {
        town,
        region: format_region(&region),
        note,
    })
}

impl Serialize for ServiceAreasConfig {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ServiceAreasConfig {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        ServiceAreasConfig::from_value(&value)
            .map_err(|errors| serde::de::Error::custom(errors.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Result<ServiceAreasConfig, Vec<String>> {
        ServiceAreasConfig::from_value(&serde_json::from_str(json).unwrap())
    }

    #[test]
    fn nothing_stated_is_the_default() {
        assert!(parse("null").unwrap().is_default());
        assert!(parse("[]").unwrap().is_default());
        assert!(parse(r#"{"version":1}"#).unwrap().is_default());
    }

    #[test]
    fn regions_are_formatted_from_the_bundled_list() {
        let config = parse(
            r#"[{"town":"  Bend ","region":"oregon"},{"town":"Hope","region":"British  Columbia"},{"town":"Elsewhere","region":"Narnia"}]"#,
        )
        .unwrap();
        let regions: Vec<&str> = config.areas.iter().map(|a| a.region.as_str()).collect();
        assert_eq!(regions, ["OR", "BC", "Narnia"]);
        assert_eq!(config.areas[0].town, "Bend");
        assert!(config.areas[0].covers("bend", "Oregon"));
    }

    #[test]
    fn duplicates_are_rejected_ignoring_case_and_region_spelling() {
        let errors = parse(r#"[{"town":"Bend","region":"OR"},{"town":"BEND","region":"Oregon"}]"#)
            .unwrap_err();
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(
            errors[0].contains("entry 2")
                && errors[0].contains("Bend, OR is already listed as entry 1"),
            "{errors:?}"
        );
        assert!(parse(r#"[{"town":"Bend","region":"OR"},{"town":"Bend","region":"ID"}]"#).is_ok());
    }

    #[test]
    fn problems_are_plain_and_all_reported() {
        let errors = parse(
            r#"[{"town":"12 Oak St, Bend","region":""},{"town":"Bend"},{"town":"Hope","region":"BC","note":"a\nb","extra":1},"Bend",{"region":"OR"}]"#,
        )
        .unwrap_err();
        let all = errors.join("\n");
        assert!(
            all.contains("entry 1: town") && all.contains("not an address"),
            "{all}"
        );
        assert!(all.contains("entry 1: region is missing"), "{all}");
        assert!(all.contains("entry 2: region is missing"), "{all}");
        assert!(all.contains("entry 3: note must be one line"), "{all}");
        assert!(all.contains("entry 3: `extra` is not a setting"), "{all}");
        assert!(
            all.contains("entry 4: write each area as an object"),
            "{all}"
        );
        assert!(all.contains("entry 5: town is missing"), "{all}");
    }

    #[test]
    fn the_count_is_bounded() {
        let many: Vec<Value> = (0..=MAX_AREAS)
            .map(|n| json!({"town": format!("Town{}", "x".repeat(n % 7)), "region": "OR"}))
            .collect();
        let errors = ServiceAreasConfig::from_value(&Value::Array(many)).unwrap_err();
        assert!(errors[0].contains("at most 100 towns"), "{errors:?}");
    }

    #[test]
    fn a_newer_version_is_refused_and_other_shapes_are_explained() {
        let newer = parse(r#"{"version":2,"areas":[]}"#).unwrap_err();
        assert!(newer[0].contains("newer version of open.blog"), "{newer:?}");
        let text = parse(r#""Bend""#).unwrap_err();
        assert!(text[0].contains("must be a list of towns"), "{text:?}");
        let unknown = parse(r#"{"areas":[],"radius":5}"#).unwrap_err();
        assert!(
            unknown[0].contains("`radius` is not a setting"),
            "{unknown:?}"
        );
    }

    #[test]
    fn slugs_are_derived_without_depending_on_order() {
        let forward = parse(
            r#"[{"town":"Portland","region":"OR"},{"town":"Portland","region":"ME"},{"town":"Bend","region":"OR"},{"town":"!!!","region":"OR"}]"#,
        )
        .unwrap();
        let mut reversed = forward.clone();
        reversed.areas.reverse();
        let slugs = |config: &ServiceAreasConfig| -> Vec<(String, String)> {
            config
                .plan()
                .iter()
                .map(|p| (p.area.label(), p.url.clone()))
                .collect()
        };
        assert_eq!(slugs(&forward), slugs(&reversed));
        let urls: Vec<String> = slugs(&forward).into_iter().map(|(_, url)| url).collect();
        assert_eq!(
            urls,
            [
                "/areas/area/",
                "/areas/bend/",
                "/areas/portland-me/",
                "/areas/portland-or/"
            ]
        );
    }

    #[test]
    fn the_stored_form_round_trips_and_only_states_what_is_set() {
        let config = parse(r#"[{"town":"Bend","region":"Oregon","note":"within 30 miles"},{"town":"Sisters","region":"OR"}]"#)
            .unwrap();
        let value = config.to_value();
        assert_eq!(value["version"], 1);
        assert_eq!(value["areas"][0]["region"], "OR");
        assert!(value["areas"][1].get("note").is_none());
        assert_eq!(ServiceAreasConfig::from_value(&value).unwrap(), config);
        let served = config.area_served().unwrap();
        assert_eq!(served[0]["containedInPlace"]["name"], "Oregon");
        assert!(ServiceAreasConfig::default().area_served().is_none());
    }
}
