//! Recruiter Evidence v1: bounded, deterministic project evidence and ordering.
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeSet;

pub const RECRUITER_EVIDENCE_VERSION: u32 = 1;
pub const MAX_BYTES: usize = 1_000_000;
pub const MAX_REPOSITORIES: usize = 512;
pub const MAX_COMMITS_PER_REPOSITORY: usize = 4096;
pub const MAX_EVENTS_PER_REPOSITORY: usize = 4096;
const DAY_MS: i64 = 86_400_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    version: u32,
    #[serde(default)]
    reference: i64,
    #[serde(default)]
    account: String,
    #[serde(default)]
    repositories: Vec<Repository>,
    #[serde(default)]
    ordering_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repository {
    id: String,
    full_name: String,
    #[serde(default)]
    pushed_at: Option<i64>,
    #[serde(default)]
    role: String,
    #[serde(default = "default_priority")]
    priority: i64,
    #[serde(default)]
    snapshot: Option<Snapshot>,
    #[serde(default)]
    commits: Vec<Commit>,
    #[serde(default)]
    events: Vec<Event>,
    #[serde(default)]
    organization: Option<Organization>,
}

fn default_priority() -> i64 {
    9999
}

#[derive(Deserialize)]
struct Snapshot {
    partial: Option<bool>,
    #[serde(default)]
    diagnostic: bool,
}

#[derive(Deserialize)]
struct Commit {
    date: i64,
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
struct Event {
    date: i64,
    kind: EventKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum EventKind {
    Push,
    PullRequest,
    Release,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Organization {
    complete: bool,
    logins: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    id: String,
    months: usize,
    complete: bool,
    band: u8,
    latest: i64,
    unknown_recency: bool,
    role: String,
    others: Option<usize>,
    contributor_partial: bool,
    external: bool,
    contributed: bool,
    quarters: Vec<bool>,
    featured: bool,
}

#[derive(Serialize)]
struct Output {
    version: u32,
    projects: Vec<Evidence>,
    order: Vec<String>,
}

#[derive(Serialize)]
struct OrderingOutput {
    version: u32,
    order: Vec<String>,
}

fn error(code: &str, message: &str) -> String {
    serde_json::json!({"code": code, "message": message}).to_string()
}

fn valid_text(value: &str) -> bool {
    value.len() <= 512 && !value.chars().any(char::is_control)
}

// Howard Hinnant's civil-from-days algorithm, with Unix epoch offset.
fn civil_from_millis(milliseconds: i64) -> (i64, u8, u8) {
    let z = milliseconds.div_euclid(DAY_MS) + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month as u8, day as u8)
}

fn month_key(milliseconds: i64) -> (i64, u8) {
    let (year, month, _) = civil_from_millis(milliseconds);
    (year, month)
}

fn quarter(milliseconds: i64) -> i64 {
    let (year, month, _) = civil_from_millis(milliseconds);
    year * 4 + i64::from((month - 1) / 3)
}

fn role_rank(role: &str) -> u8 {
    match role {
        "featured" => 0,
        "supporting" => 1,
        "experimental" => 2,
        "historical" => 3,
        _ => 4,
    }
}

// GitHub IDs are ASCII. The deterministic contract compares case-insensitively,
// then places lowercase before uppercase at the first otherwise-equal case tie.
fn ascii_name_cmp(a: &str, b: &str) -> Ordering {
    let lower = a
        .bytes()
        .map(|c| c.to_ascii_lowercase())
        .cmp(b.bytes().map(|c| c.to_ascii_lowercase()));
    if lower != Ordering::Equal {
        return lower;
    }
    for (left, right) in a.bytes().zip(b.bytes()) {
        if left != right {
            if left.eq_ignore_ascii_case(&right) {
                return right.cmp(&left);
            }
            return left.cmp(&right);
        }
    }
    a.len().cmp(&b.len())
}

fn analyze_project(repo: &Repository, account: &str, reference: i64) -> Evidence {
    let commits: Vec<_> = repo
        .commits
        .iter()
        .filter(|item| item.date <= reference)
        .collect();
    let events: Vec<_> = repo
        .events
        .iter()
        .filter(|item| item.date <= reference)
        .collect();
    let dates = commits
        .iter()
        .map(|item| item.date)
        .chain(events.iter().map(|item| item.date));
    let months: BTreeSet<_> = dates.clone().map(month_key).collect();
    let latest = dates
        .chain(repo.pushed_at.filter(|date| *date <= reference))
        .max()
        .unwrap_or(0);
    let age_days = (latest != 0).then(|| (reference - latest) as f64 / DAY_MS as f64);
    let band = match age_days {
        Some(age) if age < 30.0 => 0,
        Some(age) if age < 183.0 => 1,
        _ => 2,
    };
    let complete = repo
        .snapshot
        .as_ref()
        .is_some_and(|item| item.partial == Some(false) && !item.diagnostic);
    let account = account.to_ascii_lowercase();
    let owner = repo
        .full_name
        .split('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let external = owner != account;
    let logins = repo.organization.as_ref().map(|organization| {
        organization
            .logins
            .iter()
            .map(|login| login.to_ascii_lowercase())
            .filter(|login| !login.is_empty())
            .collect::<BTreeSet<_>>()
    });
    let others = logins
        .as_ref()
        .map(|items| items.iter().filter(|login| **login != account).count());
    let contributed = external
        && (logins
            .as_ref()
            .is_some_and(|items| items.contains(&account))
            || commits
                .iter()
                .any(|commit| commit.login.eq_ignore_ascii_case(&account))
            || events
                .iter()
                .any(|event| matches!(event.kind, EventKind::Push | EventKind::PullRequest)));
    let current_quarter = quarter(reference);
    let active: BTreeSet<_> = commits.iter().map(|commit| quarter(commit.date)).collect();
    let quarters = if complete && !commits.is_empty() {
        (0..12)
            .map(|index| active.contains(&(current_quarter - 11 + index)))
            .collect()
    } else {
        Vec::new()
    };
    Evidence {
        id: repo.id.clone(),
        months: months.len(),
        complete,
        band,
        latest,
        unknown_recency: age_days.is_none(),
        role: if repo.role.is_empty() {
            "unassigned".into()
        } else {
            repo.role.clone()
        },
        others,
        contributor_partial: repo
            .organization
            .as_ref()
            .is_some_and(|item| !item.complete),
        external,
        contributed,
        quarters,
        featured: repo.role == "featured",
    }
}

pub fn analyze(json: &str) -> Result<String, String> {
    if json.len() > MAX_BYTES {
        return Err(error(
            "input-too-large",
            "Recruiter Evidence input exceeds 1 MiB",
        ));
    }
    let input: Input = serde_json::from_str(json).map_err(|cause| {
        error(
            "invalid-json",
            &format!("Invalid Recruiter Evidence input: {cause}"),
        )
    })?;
    if input.version != RECRUITER_EVIDENCE_VERSION {
        return Err(error(
            "unsupported-version",
            "Recruiter Evidence version must be 1",
        ));
    }
    if input.repositories.len() > MAX_REPOSITORIES {
        return Err(error(
            "too-many-repositories",
            "Recruiter Evidence repository limit exceeded",
        ));
    }
    if !valid_text(&input.account)
        || input.repositories.iter().any(|repo| {
            !valid_text(&repo.id)
                || repo.id.is_empty()
                || !valid_text(&repo.full_name)
                || repo.full_name.is_empty()
        })
    {
        return Err(error(
            "invalid-identifier",
            "Recruiter Evidence identifiers are invalid",
        ));
    }
    if input
        .repositories
        .iter()
        .any(|repo| repo.commits.len() > MAX_COMMITS_PER_REPOSITORY)
    {
        return Err(error(
            "too-many-commits",
            "Recruiter Evidence commit limit exceeded",
        ));
    }
    if input
        .repositories
        .iter()
        .any(|repo| repo.events.len() > MAX_EVENTS_PER_REPOSITORY)
    {
        return Err(error(
            "too-many-events",
            "Recruiter Evidence event limit exceeded",
        ));
    }
    let mut ordered: Vec<_> = input.repositories.iter().collect();
    ordered.sort_by(|a, b| {
        role_rank(&a.role)
            .cmp(&role_rank(&b.role))
            .then(a.priority.cmp(&b.priority))
            .then(b.pushed_at.unwrap_or(0).cmp(&a.pushed_at.unwrap_or(0)))
            .then_with(|| ascii_name_cmp(&a.full_name, &b.full_name))
    });
    if input.ordering_only {
        return serde_json::to_string(&OrderingOutput {
            version: RECRUITER_EVIDENCE_VERSION,
            order: ordered.into_iter().map(|repo| repo.id.clone()).collect(),
        })
        .map_err(|cause| error("serialization-failed", &cause.to_string()));
    }
    let output = Output {
        version: RECRUITER_EVIDENCE_VERSION,
        projects: input
            .repositories
            .iter()
            .map(|repo| analyze_project(repo, &input.account, input.reference))
            .collect(),
        order: ordered.into_iter().map(|repo| repo.id.clone()).collect(),
    };
    serde_json::to_string(&output)
        .map_err(|cause| error("serialization-failed", &cause.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(repositories: &str, reference: i64) -> serde_json::Value {
        serde_json::from_str(&analyze(&format!(r#"{{"version":1,"reference":{reference},"account":"alice","repositories":{repositories}}}"#)).unwrap()).unwrap()
    }
    fn ms(value: &str) -> i64 {
        // Test-only fixed dates expressed through known epoch arithmetic.
        match value {
            "2024-01-01" => 1_704_067_200_000,
            "2024-02-29" => 1_709_164_800_000,
            "2024-03-01" => 1_709_251_200_000,
            "2024-04-01" => 1_711_929_600_000,
            "2025-01-01" => 1_735_689_600_000,
            _ => unreachable!(),
        }
    }
    #[test]
    fn computes_every_evidence_field_and_honesty_flag() {
        let repos = format!(
            r#"[{{"id":"x","fullName":"other/x","pushedAt":{},"role":"featured","priority":2,"snapshot":{{"partial":false,"diagnostic":false}},"commits":[{{"date":{},"login":"alice"}}],"events":[{{"date":{},"kind":"release"}}],"organization":{{"complete":false,"logins":["alice","bob","BOB"]}}}}]"#,
            ms("2024-03-01"),
            ms("2024-02-29"),
            ms("2024-04-01")
        );
        let value = run(&repos, ms("2025-01-01"));
        let p = &value["projects"][0];
        assert_eq!(p["months"], 2);
        assert_eq!(p["complete"], true);
        assert_eq!(p["latest"], ms("2024-04-01"));
        assert_eq!(p["role"], "featured");
        assert_eq!(p["featured"], true);
        assert_eq!(p["others"], 1);
        assert_eq!(p["contributorPartial"], true);
        assert_eq!(p["external"], true);
        assert_eq!(p["contributed"], true);
        assert_eq!(p["quarters"].as_array().unwrap().len(), 12);
    }
    #[test]
    fn band_thresholds_are_exact() {
        let reference = ms("2025-01-01");
        for (days, band) in [(29, 0), (30, 1), (182, 1), (183, 2)] {
            let value = run(
                &format!(
                    r#"[{{"id":"x","fullName":"a/x","pushedAt":{}}}]"#,
                    reference - days * DAY_MS
                ),
                reference,
            );
            assert_eq!(value["projects"][0]["band"], band);
        }
    }
    #[test]
    fn civil_dates_cover_rollovers_and_leap_day() {
        assert_eq!(month_key(ms("2024-01-01") - DAY_MS), (2023, 12));
        assert_eq!(month_key(ms("2024-02-29")), (2024, 2));
        assert_eq!(month_key(ms("2024-03-01")), (2024, 3));
        assert_ne!(quarter(ms("2024-03-01")), quarter(ms("2024-04-01")));
    }
    #[test]
    fn ordering_uses_role_priority_date_and_explicit_case_tie_break() {
        let value = run(
            r#"[{"id":"u","fullName":"alice/z","pushedAt":9},{"id":"h","fullName":"alice/h","role":"historical"},{"id":"upper","fullName":"alice/A","role":"featured","priority":1},{"id":"lower","fullName":"alice/a","role":"featured","priority":1},{"id":"new","fullName":"alice/new","role":"featured","priority":2,"pushedAt":10},{"id":"old","fullName":"alice/old","role":"featured","priority":2,"pushedAt":1}]"#,
            ms("2025-01-01"),
        );
        assert_eq!(
            value["order"],
            serde_json::json!(["lower", "upper", "new", "old", "h", "u"])
        );
    }

    #[test]
    fn ordering_uses_pinned_ascii_punctuation_order() {
        let result: serde_json::Value = serde_json::from_str(
            &analyze(r#"{"version":1,"orderingOnly":true,"repositories":[{"id":"plain","fullName":"alice/myapp"},{"id":"underscore","fullName":"alice/my_app"},{"id":"dot","fullName":"alice/my.app"},{"id":"dash","fullName":"alice/my-app"}]}"#).unwrap(),
        ).unwrap();
        assert_eq!(
            result["order"],
            serde_json::json!(["dash", "dot", "underscore", "plain"])
        );
    }
    #[test]
    fn rejects_malformed_version_and_all_limits() {
        assert!(analyze("{").unwrap_err().contains("invalid-json"));
        assert!(analyze(r#"{"version":2,"reference":0}"#)
            .unwrap_err()
            .contains("unsupported-version"));
        assert!(analyze(&" ".repeat(MAX_BYTES + 1))
            .unwrap_err()
            .contains("input-too-large"));
        let repositories = vec![r#"{"id":"x","fullName":"a/x"}"#; MAX_REPOSITORIES + 1].join(",");
        assert!(analyze(&format!(
            r#"{{"version":1,"reference":0,"repositories":[{repositories}]}}"#
        ))
        .unwrap_err()
        .contains("too-many-repositories"));
        let commits = vec![r#"{"date":0}"#; MAX_COMMITS_PER_REPOSITORY + 1].join(",");
        assert!(analyze(&format!(r#"{{"version":1,"reference":0,"repositories":[{{"id":"x","fullName":"a/x","commits":[{commits}]}}]}}"#)).unwrap_err().contains("too-many-commits"));
        let events = vec![r#"{"date":0,"kind":"push"}"#; MAX_EVENTS_PER_REPOSITORY + 1].join(",");
        assert!(analyze(&format!(r#"{{"version":1,"reference":0,"repositories":[{{"id":"x","fullName":"a/x","events":[{events}]}}]}}"#)).unwrap_err().contains("too-many-events"));
    }
}
