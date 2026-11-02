//! A cookie-free page view counter.
//!
//! What is stored, in `.openblog/analytics.json`: per day, views and unique
//! visitors per page, a count per referring host, and aggregate requests from
//! explicitly identified AI agents; plus an all-time total per page. What is
//! never stored: addresses, raw user agents, or anything that
//! identifies a visitor. Uniques are counted with a hash of (daily random
//! salt, address, user agent) that lives in memory only and is thrown away at
//! midnight, so two visits on one day collapse into one visitor and nothing
//! can be linked across days.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

use openblog_core::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};

use crate::http::{Request, Response};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct DayStats {
    #[serde(default)]
    views: BTreeMap<String, u64>,
    #[serde(default)]
    uniques: BTreeMap<String, u64>,
    #[serde(default)]
    referrers: BTreeMap<String, u64>,
    /// Stable agent label -> requested public path -> count. Labels come from
    /// a bounded classifier; raw user-agent strings are never persisted.
    #[serde(default)]
    agents: BTreeMap<String, BTreeMap<String, u64>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Agent {
    pub name: &'static str,
    pub category: &'static str,
}

const AGENT_REGISTRY: &[(&str, Agent)] = &[
    (
        "oai-searchbot",
        Agent {
            name: "OAI-SearchBot",
            category: "search",
        },
    ),
    (
        "gptbot",
        Agent {
            name: "GPTBot",
            category: "training",
        },
    ),
    (
        "chatgpt-user",
        Agent {
            name: "ChatGPT-User",
            category: "user",
        },
    ),
    (
        "oai-adsbot",
        Agent {
            name: "OAI-AdsBot",
            category: "other",
        },
    ),
    (
        "claude-searchbot",
        Agent {
            name: "Claude-SearchBot",
            category: "search",
        },
    ),
    (
        "claude-user",
        Agent {
            name: "Claude-User",
            category: "user",
        },
    ),
    (
        "claudebot",
        Agent {
            name: "ClaudeBot",
            category: "training",
        },
    ),
    (
        "perplexity-user",
        Agent {
            name: "Perplexity-User",
            category: "user",
        },
    ),
    (
        "perplexitybot",
        Agent {
            name: "PerplexityBot",
            category: "search",
        },
    ),
];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
struct Data {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    days: BTreeMap<String, DayStats>,
    #[serde(default)]
    totals: BTreeMap<String, u64>,
    /// Counts pulled from other counters, keyed by source name. Each pull
    /// replaces that source, so pulling twice never double counts.
    #[serde(default)]
    sources: BTreeMap<String, SourceData>,
}

/// What an external counter exports: the same per-day and total shapes.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct SourceData {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub days: BTreeMap<String, DayStats>,
    #[serde(default)]
    pub totals: BTreeMap<String, u64>,
}

pub struct Store {
    data: Data,
    dirty: bool,
    /// The day the in-memory unique set belongs to.
    day: String,
    salt: u64,
    seen: HashSet<u64>,
    /// Per-address hit counts for the current minute, to stop a script from
    /// inflating counts (the data is not valuable enough to lock anyone out).
    minute: i64,
    rate: HashMap<String, u32>,
    retention_days: u32,
}

/// Hits one address may record per minute.
const MAX_HITS_PER_MINUTE: u32 = 30;
const MAX_PATH_LEN: usize = 200;
const MAX_TRACKED_PATHS: usize = 5000;
/// Distinct visitor fingerprints kept in memory per day.
const MAX_UNIQUES_PER_DAY: usize = 200_000;
/// Distinct addresses tracked by the rate limiter per minute.
const MAX_RATE_ENTRIES: usize = 20_000;

/// The rate-limit key for an address: the address itself for IPv4, the /64
/// prefix for IPv6.
fn rate_key(address: &str) -> String {
    if let Ok(std::net::IpAddr::V6(v6)) = address.parse::<std::net::IpAddr>() {
        let s = v6.segments();
        return format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3]);
    }
    address.to_string()
}

impl Store {
    pub fn load(path: &Path, retention_days: u32) -> Store {
        let data = fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str::<Data>(&t).ok())
            .unwrap_or_default();
        Store {
            data,
            dirty: false,
            day: String::new(),
            salt: 0,
            seen: HashSet::new(),
            minute: 0,
            rate: HashMap::new(),
            retention_days,
        }
    }

    /// Serialise the data if anything changed. The caller writes it to disk
    /// *after* releasing the lock, so hits are never blocked by file I/O.
    pub fn snapshot(&mut self) -> Result<Option<String>, String> {
        if !self.dirty {
            return Ok(None);
        }
        self.prune();
        self.data.version = 2;
        let text = serde_json::to_string(&self.data).map_err(|e| e.to_string())?;
        self.dirty = false;
        Ok(Some(text))
    }

    /// Write a snapshot atomically.
    pub fn write_snapshot(path: &Path, text: &str) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        crate::fsutil::replace_file(&tmp, path)
            .map_err(|e| format!("cannot replace {}: {e}", path.display()))
    }

    /// Persist if anything changed. The server uses `snapshot` + `write_snapshot`
    /// so the lock is not held during I/O; this is the one-call form for tests.
    pub fn save(&mut self, path: &Path) -> Result<(), String> {
        match self.snapshot()? {
            Some(text) => Self::write_snapshot(path, &text),
            None => Ok(()),
        }
    }

    fn prune(&mut self) {
        let keep = self.retention_days.max(1) as usize;
        while self.data.days.len() > keep {
            let oldest = self.data.days.keys().next().cloned();
            if let Some(k) = oldest {
                self.data.days.remove(&k);
            }
        }
    }

    fn roll_day(&mut self, now: DateTime) -> Result<(), String> {
        let today = now.ymd();
        if self.day != today {
            self.day = today;
            self.seen.clear();
            let bytes: [u8; 8] = crate::auth::random_bytes()?;
            self.salt = u64::from_le_bytes(bytes);
        }
        Ok(())
    }

    /// Record one view. `visitor` is the address and user agent joined; it is
    /// hashed with the daily salt and never stored. Returns the page's total.
    pub fn record(
        &mut self,
        now: DateTime,
        path: &str,
        referrer_host: Option<&str>,
        visitor: &str,
    ) -> Result<u64, String> {
        self.roll_day(now)?;
        // Caps apply to every map a client can add keys to, including the all-time totals.
        let new_total = !self.data.totals.contains_key(path);
        if new_total && self.data.totals.len() >= MAX_TRACKED_PATHS {
            return Ok(0);
        }
        let day = self.data.days.entry(self.day.clone()).or_default();
        if !day.views.contains_key(path) && day.views.len() >= MAX_TRACKED_PATHS {
            return Ok(self.data.totals.get(path).copied().unwrap_or(0));
        }
        *day.views.entry(path.to_string()).or_insert(0) += 1;
        let fingerprint = fnv64(self.salt, visitor.as_bytes())
            ^ fnv64(self.salt.rotate_left(17), path.as_bytes());
        // Past the cap, new visitors are still counted as views but not as uniques.
        if self.seen.len() < MAX_UNIQUES_PER_DAY && self.seen.insert(fingerprint) {
            *day.uniques.entry(path.to_string()).or_insert(0) += 1;
        }
        if let Some(host) = referrer_host {
            if day.referrers.len() < 500 || day.referrers.contains_key(host) {
                *day.referrers.entry(host.to_string()).or_insert(0) += 1;
            }
        }
        let total = self.data.totals.entry(path.to_string()).or_insert(0);
        *total += 1;
        self.dirty = true;
        Ok(*total)
    }

    /// Record a successful public request from a classified AI user agent.
    /// This is deliberately separate from human views and uniques.
    pub fn record_agent(&mut self, now: DateTime, path: &str, agent: Agent) -> Result<(), String> {
        self.roll_day(now)?;
        let day = self.data.days.entry(self.day.clone()).or_default();
        let paths = day.agents.entry(agent.name.to_string()).or_default();
        if paths.len() < MAX_TRACKED_PATHS || paths.contains_key(path) {
            *paths.entry(path.to_string()).or_insert(0) += 1;
            self.dirty = true;
        }
        Ok(())
    }

    pub fn views(&self, path: &str) -> u64 {
        self.data.totals.get(path).copied().unwrap_or(0)
            + self
                .data
                .sources
                .values()
                .map(|src| src.totals.get(path).copied().unwrap_or(0))
                .sum::<u64>()
    }

    /// All-time totals per page across the local counter and every source.
    pub fn all_totals(&self) -> BTreeMap<String, u64> {
        let mut out = self.data.totals.clone();
        for src in self.data.sources.values() {
            for (path, n) in &src.totals {
                *out.entry(path.clone()).or_insert(0) += n;
            }
        }
        out
    }

    /// Per-day statistics with every source added in.
    fn merged_days(&self) -> BTreeMap<String, DayStats> {
        let mut out = self.data.days.clone();
        for src in self.data.sources.values() {
            for (day, stats) in &src.days {
                let entry = out.entry(day.clone()).or_default();
                for (k, v) in &stats.views {
                    *entry.views.entry(k.clone()).or_insert(0) += v;
                }
                for (k, v) in &stats.uniques {
                    *entry.uniques.entry(k.clone()).or_insert(0) += v;
                }
                for (k, v) in &stats.referrers {
                    *entry.referrers.entry(k.clone()).or_insert(0) += v;
                }
                for (agent, paths) in &stats.agents {
                    let target = entry.agents.entry(agent.clone()).or_default();
                    for (path, count) in paths {
                        *target.entry(path.clone()).or_insert(0) += count;
                    }
                }
            }
        }
        out
    }

    /// Replace the data of a named external source (idempotent).
    pub fn import_source(&mut self, name: &str, data: SourceData) {
        self.data.sources.insert(name.to_string(), data);
        self.dirty = true;
    }

    /// The whole store as JSON, for the backup branch. Unlike `snapshot` this
    /// does not clear the dirty flag.
    pub fn export_json(&self) -> String {
        serde_json::to_string(&self.data).unwrap_or_default()
    }

    /// Replace everything with a previously exported store, keeping whichever
    /// side has more for each counter so a restore never loses local hits.
    pub fn restore_from_json(&mut self, json: &str) -> Result<(), String> {
        let other: Data =
            serde_json::from_str(json).map_err(|e| format!("invalid analytics backup: {e}"))?;
        for (day, stats) in other.days {
            let entry = self.data.days.entry(day).or_default();
            for (k, v) in stats.views {
                let e = entry.views.entry(k).or_insert(0);
                *e = (*e).max(v);
            }
            for (k, v) in stats.uniques {
                let e = entry.uniques.entry(k).or_insert(0);
                *e = (*e).max(v);
            }
            for (k, v) in stats.referrers {
                let e = entry.referrers.entry(k).or_insert(0);
                *e = (*e).max(v);
            }
            for (agent, paths) in stats.agents {
                let target = entry.agents.entry(agent).or_default();
                for (path, count) in paths {
                    let e = target.entry(path).or_insert(0);
                    *e = (*e).max(count);
                }
            }
        }
        for (k, v) in other.totals {
            let e = self.data.totals.entry(k).or_insert(0);
            *e = (*e).max(v);
        }
        for (name, src) in other.sources {
            self.data.sources.entry(name).or_insert(src);
        }
        self.dirty = true;
        Ok(())
    }

    /// `true` when this address may record another hit this minute. IPv6
    /// clients are keyed by their /64, since one subscriber controls all of it.
    pub fn allow_hit(&mut self, now: DateTime, address: &str) -> bool {
        let minute = now.unix() / 60;
        if minute != self.minute {
            self.minute = minute;
            self.rate.clear();
        }
        let key = rate_key(address);
        if !self.rate.contains_key(&key) && self.rate.len() >= MAX_RATE_ENTRIES {
            return false;
        }
        let count = self.rate.entry(key).or_insert(0);
        *count += 1;
        *count <= MAX_HITS_PER_MINUTE
    }

    /// The admin dashboard's numbers for the last `days` days.
    pub fn summary(&self, now: DateTime, days: u32) -> Json {
        let days = days.clamp(1, 366);
        let merged = self.merged_days();
        let totals = self.all_totals();
        let start = DateTime::from_unix(now.unix() - i64::from(days - 1) * 86_400).ymd();
        let mut series = Vec::new();
        let mut views_total = 0u64;
        let mut uniques_total = 0u64;
        let mut per_path: BTreeMap<&str, (u64, u64)> = BTreeMap::new();
        let mut referrers: BTreeMap<&str, u64> = BTreeMap::new();
        let mut agents: BTreeMap<&str, u64> = BTreeMap::new();
        let mut agent_paths: BTreeMap<&str, (u64, HashSet<&str>)> = BTreeMap::new();
        for offset in 0..days {
            let day = DateTime::from_unix(now.unix() - i64::from(days - 1 - offset) * 86_400).ymd();
            let (v, u) = match merged.get(&day) {
                Some(stats) => (
                    stats.views.values().sum::<u64>(),
                    stats.uniques.values().sum::<u64>(),
                ),
                None => (0, 0),
            };
            views_total += v;
            uniques_total += u;
            series.push(json!({ "day": day, "views": v, "uniques": u }));
        }
        for (day, stats) in merged.range(start.clone()..) {
            let _ = day;
            for (path, v) in &stats.views {
                let entry = per_path.entry(path.as_str()).or_insert((0, 0));
                entry.0 += v;
                entry.1 += stats.uniques.get(path).copied().unwrap_or(0);
            }
            for (host, n) in &stats.referrers {
                *referrers.entry(host.as_str()).or_insert(0) += n;
            }
            for (agent, paths) in &stats.agents {
                for (path, count) in paths {
                    *agents.entry(agent.as_str()).or_insert(0) += count;
                    let entry = agent_paths.entry(path.as_str()).or_default();
                    entry.0 += count;
                    entry.1.insert(agent.as_str());
                }
            }
        }
        let mut top: Vec<(&str, (u64, u64))> = per_path.into_iter().collect();
        top.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then_with(|| a.0.cmp(b.0)));
        let mut refs: Vec<(&str, u64)> = referrers.into_iter().collect();
        refs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        let mut agent_list: Vec<(&str, u64)> = agents.into_iter().collect();
        agent_list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        let mut agent_page_list: Vec<(&str, (u64, HashSet<&str>))> =
            agent_paths.into_iter().collect();
        agent_page_list.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then_with(|| a.0.cmp(b.0)));
        let agent_requests: u64 = agent_list.iter().map(|(_, count)| count).sum();
        let all_time: u64 = totals.values().sum();
        json!({
            "days": days,
            "from": start,
            "to": now.ymd(),
            "views": views_total,
            "uniques": uniques_total,
            "allTimeViews": all_time,
            "firstDay": merged.keys().next(),
            "series": series,
            "topPosts": top.iter().take(25).map(|(p, (v, u))| json!({ "path": p, "views": v, "uniques": u, "allTime": totals.get(*p).copied().unwrap_or(0) })).collect::<Vec<_>>(),
            "referrers": refs.iter().take(25).map(|(h, n)| json!({ "host": h, "views": n })).collect::<Vec<_>>(),
            "agentRequests": agent_requests,
            "agents": agent_list.iter().map(|(name, requests)| json!({
                "name": name,
                "category": agent_category(name),
                "requests": requests,
            })).collect::<Vec<_>>(),
            "agentPages": agent_page_list.iter().take(25).map(|(path, (requests, names))| {
                let mut names = names.iter().copied().collect::<Vec<_>>();
                names.sort_unstable();
                json!({
                    "path": path,
                    "requests": requests,
                    "agents": names,
                })
            }).collect::<Vec<_>>(),
        })
    }
}

/// Classify only provider-documented AI user-agent tokens. This reports what
/// the request claims to be; callers must verify provider IP ranges separately
/// when authenticated bot identity matters.
pub fn classify_agent(user_agent: &str) -> Option<Agent> {
    let ua = user_agent.to_ascii_lowercase();
    AGENT_REGISTRY
        .iter()
        .find_map(|(token, agent)| ua.contains(token).then_some(*agent))
}

pub fn record_agent_request(state: &crate::admin::AppState, req: &Request, public_path: &str) {
    let Some(agent) = req.header("user-agent").and_then(classify_agent) else {
        return;
    };
    let mut store = state.analytics.lock().unwrap_or_else(|e| e.into_inner());
    // Analytics must never turn a successful public response into an error.
    let _ = store.record_agent(crate::clock::now(), public_path, agent);
}

fn agent_category(name: &str) -> &'static str {
    AGENT_REGISTRY
        .iter()
        .find_map(|(_, agent)| (agent.name == name).then_some(agent.category))
        .unwrap_or("other")
}

fn fnv64(seed: u64, bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ seed;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// The host part of a referrer URL, lower-cased and cleaned, or `None` for
/// empty, same-site, or malformed values. Nothing else from the referrer is kept.
pub fn referrer_host(referrer: &str, own_host: &str) -> Option<String> {
    let rest = referrer
        .trim()
        .strip_prefix("https://")
        .or_else(|| referrer.trim().strip_prefix("http://"))?;
    let host = rest
        .split(['/', '?', '#'])
        .next()?
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    let clean: String = host
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
        .take(100)
        .collect();
    if clean.is_empty() || clean == own_host.trim_start_matches("www.").to_ascii_lowercase() {
        return None;
    }
    Some(clean)
}

/// Normalise a client-supplied page path and make sure it is a page this site
/// actually serves, so junk paths cannot bloat the data.
pub fn public_path(out_dir: &Path, raw: &str) -> Option<String> {
    if raw.len() > MAX_PATH_LEN || !raw.starts_with('/') || raw.contains("//") {
        return None;
    }
    // One spelling per page: every segment is a plain lowercase slug, so
    // `/posts//x/`, `/./posts/x/`, `/Posts/X/` and `/posts/x/index.html` can
    // never become separate keys for the same page.
    let trimmed = raw.trim_matches('/');
    let mut segments: Vec<&str> = Vec::new();
    if !trimmed.is_empty() {
        for segment in trimmed.split('/') {
            let ok = !segment.is_empty()
                && segment.len() <= 100
                && !segment.starts_with('.')
                && !segment.ends_with('.')
                && segment.chars().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.')
                })
                && segment != "index.html";
            if !ok {
                return None;
            }
            segments.push(segment);
        }
    }
    // The page must exist as a directory index, which is how every page is written.
    let mut dir = out_dir.to_path_buf();
    for segment in &segments {
        dir.push(segment);
    }
    if !dir.is_dir() || !dir.join("index.html").is_file() {
        return None;
    }
    Some(if segments.is_empty() {
        "/".to_string()
    } else {
        format!("/{}/", segments.join("/"))
    })
}

/// `POST /api/hit` with `{ "path": "/posts/x/", "referrer": "https://..." }`.
pub fn hit(state: &crate::admin::AppState, req: &Request, out_dir: &Path) -> Response {
    if req.method != "POST" {
        return Response::error(405, "Use POST");
    }
    // Only our own pages may record hits: a JSON content type forces a CORS
    // preflight (which this server never answers), and a browser-supplied
    // Origin or Sec-Fetch-Site must be same-origin.
    if !req.header("content-type").is_some_and(|t| {
        t.trim()
            .to_ascii_lowercase()
            .starts_with("application/json")
    }) {
        return Response::error(415, "Content-Type must be application/json");
    }
    if let Err(r) = crate::admin::check_origin(req) {
        return r;
    }
    let body: Json = match serde_json::from_slice(&req.body) {
        Ok(b) => b,
        Err(_) => return Response::error(400, "Invalid JSON"),
    };
    let Some(path) = body["path"].as_str().and_then(|p| public_path(out_dir, p)) else {
        return Response::error(404, "Not a page on this site");
    };
    let config = crate::site::load_config(&state.root).unwrap_or_default();
    let opted_out = req.header("dnt") == Some("1") || req.header("sec-gpc") == Some("1");
    if opted_out {
        // Count nothing, but still answer with the total so the page can show it.
        let store = state.analytics.lock().unwrap_or_else(|e| e.into_inner());
        return Response::json(
            200,
            &json!({ "views": store.views(&path), "counted": false }),
        );
    }
    let own_host = config
        .url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
        .to_string();
    let referrer = body["referrer"]
        .as_str()
        .and_then(|r| referrer_host(r, &own_host));
    let client = crate::admin::client_ip(&config, req);
    let visitor = format!("{client}|{}", req.header("user-agent").unwrap_or(""));
    let now = crate::clock::now();
    let mut store = state.analytics.lock().unwrap_or_else(|e| e.into_inner());
    if !store.allow_hit(now, &client) {
        return Response::error(429, "Too many hits").with_header("Retry-After", "60");
    }
    match store.record(now, &path, referrer.as_deref(), &visitor) {
        Ok(views) => Response::json(200, &json!({ "views": views })),
        Err(e) => Response::error(500, &e),
    }
}

/// `GET /api/views?path=/posts/x/`
pub fn views(state: &crate::admin::AppState, req: &Request, out_dir: &Path) -> Response {
    let Some(path) = req.query.get("path").and_then(|p| public_path(out_dir, p)) else {
        return Response::error(404, "Not a page on this site");
    };
    let store = state.analytics.lock().unwrap_or_else(|e| e.into_inner());
    Response::json(200, &json!({ "views": store.views(&path) }))
        .with_header("Cache-Control", "no-store")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime {
        DateTime::parse(s).unwrap()
    }

    #[test]
    fn counts_views_uniques_and_referrers_per_day() {
        let mut s = Store::load(Path::new("/nonexistent/analytics.json"), 400);
        let d1 = at("2026-10-22T10:00:00Z");
        assert_eq!(
            s.record(d1, "/a/", Some("news.ycombinator.com"), "1.1.1.1|ua")
                .unwrap(),
            1
        );
        assert_eq!(s.record(d1, "/a/", None, "1.1.1.1|ua").unwrap(), 2);
        assert_eq!(
            s.record(d1, "/a/", Some("news.ycombinator.com"), "2.2.2.2|ua")
                .unwrap(),
            3
        );
        assert_eq!(s.record(d1, "/b/", None, "1.1.1.1|ua").unwrap(), 1);
        let sum = s.summary(d1, 7);
        assert_eq!(sum["views"], 4);
        assert_eq!(
            sum["uniques"], 3,
            "same visitor on the same page counts once per day"
        );
        assert_eq!(sum["topPosts"][0]["path"], "/a/");
        assert_eq!(sum["topPosts"][0]["uniques"], 2);
        assert_eq!(sum["referrers"][0]["host"], "news.ycombinator.com");
        assert_eq!(sum["referrers"][0]["views"], 2);
        assert_eq!(sum["series"].as_array().unwrap().len(), 7);
        // Next day the same visitor is unique again, and yesterday is untouched.
        let d2 = at("2026-10-23T00:00:01Z");
        s.record(d2, "/a/", None, "1.1.1.1|ua").unwrap();
        let sum = s.summary(d2, 2);
        assert_eq!(sum["series"][0]["views"], 4);
        assert_eq!(sum["series"][1]["uniques"], 1);
        assert_eq!(s.views("/a/"), 4);
        assert_eq!(s.summary(d2, 1)["views"], 1);
    }

    #[test]
    fn classifies_and_aggregates_documented_ai_agents_without_human_views() {
        assert_eq!(
            classify_agent("Mozilla/5.0; compatible; OAI-SearchBot/1.4"),
            Some(Agent {
                name: "OAI-SearchBot",
                category: "search"
            })
        );
        assert_eq!(
            classify_agent("Mozilla/5.0; compatible; Perplexity-User/1.0")
                .unwrap()
                .category,
            "user"
        );
        assert_eq!(classify_agent("Googlebot/2.1"), None);

        let now = at("2026-10-22T10:00:00Z");
        let mut store = Store::load(Path::new("/nonexistent"), 400);
        store
            .record_agent(
                now,
                "/posts/a/",
                classify_agent("OAI-SearchBot/1.4").unwrap(),
            )
            .unwrap();
        store
            .record_agent(
                now,
                "/posts/a/",
                classify_agent("ChatGPT-User/1.0").unwrap(),
            )
            .unwrap();
        let summary = store.summary(now, 1);
        assert_eq!(summary["views"], 0);
        assert_eq!(summary["agentRequests"], 2);
        assert_eq!(summary["agentPages"][0]["path"], "/posts/a/");
        assert_eq!(
            summary["agentPages"][0]["agents"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn external_sources_merge_without_double_counting() {
        let mut s = Store::load(Path::new("/nonexistent"), 400);
        let d = at("2026-10-22T10:00:00Z");
        s.record(d, "/a/", None, "x").unwrap();
        let worker: SourceData = serde_json::from_str(r#"{"version":1,"days":{"2026-10-22":{"views":{"/a/":5,"/b/":2},"uniques":{"/a/":3,"/b/":1},"referrers":{"lobste.rs":1}}},"totals":{"/a/":5,"/b/":2}}"#).unwrap();
        s.import_source("worker", worker.clone());
        s.import_source("worker", worker);
        assert_eq!(s.views("/a/"), 6, "local 1 + worker 5, pulled twice");
        assert_eq!(s.views("/b/"), 2);
        let sum = s.summary(d, 1);
        assert_eq!(sum["views"], 8);
        assert_eq!(sum["topPosts"][0]["path"], "/a/");
        assert_eq!(sum["topPosts"][0]["allTime"], 6);
        assert_eq!(s.all_totals()["/b/"], 2);
        // A backup restore keeps the larger counter on each side.
        let exported = s.export_json();
        let mut fresh = Store::load(Path::new("/nonexistent"), 400);
        fresh.record(d, "/a/", None, "y").unwrap();
        fresh.record(d, "/a/", None, "z").unwrap();
        fresh.restore_from_json(&exported).unwrap();
        assert_eq!(fresh.views("/a/"), 7, "local 2 (kept, larger) + worker 5");
        assert!(fresh.restore_from_json("not json").is_err());
    }

    #[test]
    fn saves_and_reloads_without_visitor_data() {
        let dir = std::env::temp_dir().join(format!("ob-analytics-{}", std::process::id()));
        let path = dir.join("analytics.json");
        let mut s = Store::load(&path, 400);
        s.record(
            at("2026-10-22"),
            "/a/",
            Some("example.org"),
            "9.9.9.9|Mozilla",
        )
        .unwrap();
        s.save(&path).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("9.9.9.9") && !text.contains("Mozilla"),
            "no visitor data on disk: {text}"
        );
        let again = Store::load(&path, 400);
        assert_eq!(again.views("/a/"), 1);
        assert_eq!(
            again.summary(at("2026-10-22"), 1)["referrers"][0]["host"],
            "example.org"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prunes_old_days_and_limits_hit_rate() {
        let mut s = Store::load(Path::new("/nonexistent"), 2);
        for day in ["2026-01-01", "2026-01-02", "2026-01-03"] {
            s.record(at(day), "/a/", None, "x").unwrap();
        }
        s.prune();
        assert_eq!(s.data.days.len(), 2);
        assert!(!s.data.days.contains_key("2026-01-01"));
        assert_eq!(s.views("/a/"), 3, "totals survive pruning");
        // Totals are capped too, so junk paths cannot grow the file forever.
        let now2 = at("2026-10-22");
        for i in 0..MAX_TRACKED_PATHS + 10 {
            s.record(now2, &format!("/p{i}/"), None, "x").unwrap();
        }
        assert!(s.data.totals.len() <= MAX_TRACKED_PATHS);
        assert_eq!(
            s.record(now2, "/a/", None, "x").unwrap(),
            4,
            "known pages still count past the cap"
        );
        let now = at("2026-10-22T10:00:00Z");
        for _ in 0..MAX_HITS_PER_MINUTE {
            assert!(s.allow_hit(now, "1.2.3.4"));
        }
        assert!(!s.allow_hit(now, "1.2.3.4"));
        assert!(s.allow_hit(now, "5.6.7.8"));
        assert!(
            s.allow_hit(DateTime::from_unix(now.unix() + 60), "1.2.3.4"),
            "a new minute resets"
        );
    }

    #[test]
    fn referrer_hosts_are_reduced_to_a_clean_host() {
        assert_eq!(
            referrer_host("https://www.Example.org/some/page?q=1", "t.dev"),
            Some("example.org".into())
        );
        assert_eq!(
            referrer_host("https://t.dev/other/", "t.dev"),
            None,
            "internal navigation is not a referrer"
        );
        assert_eq!(referrer_host("", "t.dev"), None);
        assert_eq!(referrer_host("javascript:alert(1)", "t.dev"), None);
        assert_eq!(
            referrer_host("http://evil.com/<script>", "t.dev"),
            Some("evil.com".into())
        );
    }

    #[test]
    fn only_real_pages_can_be_counted() {
        let dir = std::env::temp_dir().join(format!("ob-paths-{}", std::process::id()));
        fs::create_dir_all(dir.join("posts/x")).unwrap();
        fs::write(dir.join("posts/x/index.html"), "x").unwrap();
        fs::write(dir.join("rss.xml"), "x").unwrap();
        fs::write(dir.join("index.html"), "x").unwrap();
        assert_eq!(public_path(&dir, "/posts/x/"), Some("/posts/x/".into()));
        assert_eq!(public_path(&dir, "/posts/x"), Some("/posts/x/".into()));
        assert_eq!(public_path(&dir, "/"), Some("/".into()));
        assert_eq!(public_path(&dir, "/posts/x/?utm=1"), None);
        assert_eq!(public_path(&dir, "/rss.xml"), None, "only HTML pages");
        assert_eq!(public_path(&dir, "/nope/"), None);
        assert_eq!(public_path(&dir, "posts/x/"), None);
        assert_eq!(public_path(&dir, "/../x/"), None);
        assert_eq!(public_path(&dir, &format!("/{}/", "a".repeat(300))), None);
        for alias in [
            "/posts//x/",
            "/./posts/x/",
            "/posts/./x/",
            "/Posts/X/",
            "/posts/x/index.html",
            "/posts/x./",
            "/posts/x /",
            "//posts/x/",
        ] {
            assert_eq!(
                public_path(&dir, alias),
                None,
                "{alias:?} is not a canonical spelling"
            );
        }
        assert_eq!(
            rate_key("2001:db8:1:2:aaaa:bbbb:cccc:dddd"),
            "2001:db8:1:2::/64"
        );
        assert_eq!(rate_key("2001:db8:1:2:1:1:1:1"), "2001:db8:1:2::/64");
        assert_eq!(rate_key("203.0.113.9"), "203.0.113.9");
        let _ = fs::remove_dir_all(&dir);
    }
}
