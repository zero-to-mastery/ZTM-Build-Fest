//! The development and self-hosting server: serves the built site, rebuilds
//! when files change, publishes scheduled posts on time, and (with `--admin`)
//! serves the login-protected editor. Plain `std::net`, no async runtime.

use std::collections::HashMap;
use std::fs;
use std::net::{IpAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::admin::{self, AppState};
use crate::fsutil;
use crate::http::{self, Conn, Request, Response};
use crate::site;
use openblog_core::accessibility::{AccessibilityFinding, FindingLocation};
use openblog_core::research::EvidenceFinding;
use openblog_core::source_review::SourceReviewFinding;

/// Concurrent connections served at once; extras are dropped, so a flood of
/// slow clients cannot exhaust threads.
const MAX_CONNECTIONS: usize = 64;
/// Concurrent connections from one address, so a single client cannot take
/// every slot. Browsers open at most six or so per host.
const MAX_PER_IP: usize = 16;

/// Holds one connection slot and releases it on drop, even if the handler panics.
struct SlotGuard {
    active: Arc<AtomicUsize>,
    per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
    ip: IpAddr,
}

impl SlotGuard {
    fn acquire(
        active: &Arc<AtomicUsize>,
        per_ip: &Arc<Mutex<HashMap<IpAddr, usize>>>,
        ip: IpAddr,
        exempt_from_per_ip: bool,
    ) -> Option<Self> {
        if active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            active.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        {
            let mut map = per_ip.lock().unwrap_or_else(|e| e.into_inner());
            let count = map.entry(ip).or_insert(0);
            // A reverse proxy funnels every reader through one address; only the global cap applies to it.
            if !exempt_from_per_ip && *count >= MAX_PER_IP {
                active.fetch_sub(1, Ordering::SeqCst);
                return None;
            }
            *count += 1;
        }
        Some(Self {
            active: Arc::clone(active),
            per_ip: Arc::clone(per_ip),
            ip,
        })
    }
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
        let mut map = self.per_ip.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = map.get_mut(&self.ip) {
            *count -= 1;
            if *count == 0 {
                map.remove(&self.ip);
            }
        }
    }
}

pub struct ServeOptions {
    pub include_drafts: bool,
    pub host: String,
    pub port: u16,
    pub admin: bool,
}

pub fn run(root: &Path, options: &ServeOptions) -> Result<(), String> {
    let workspace = crate::workspace::Workspace::restore_from_env(root)?;
    let mut state = AppState::new(
        root.to_path_buf(),
        None,
        options.include_drafts,
        options.admin,
    );
    state.workspace_enabled = workspace.is_some();
    state.workspace = Mutex::new(workspace);
    let state = Arc::new(state);
    admin::register(&state);
    let report = state.rebuild()?;
    print_report(&report);
    let mut last_readiness = readiness_text(&report);
    let out_dir = report.out_dir.clone();

    let config = site::load_config(root)?;
    if options.admin {
        let users = crate::auth::Users::load(&root.join(&config.admin.users_file))?;
        if users.users.is_empty() {
            println!("\nNo admin users yet. Create one with:  openblog user add <name>");
        }
        let loopback = matches!(options.host.as_str(), "127.0.0.1" | "localhost" | "::1");
        if !loopback && !config.admin.secure_cookies {
            eprintln!(
                "\nwarning: the admin is reachable from the network but `admin.secureCookies` is false.\n\
                 Put it behind HTTPS (a reverse proxy) and set `admin.secureCookies: true`; otherwise\n\
                 passwords and sessions cross the network unencrypted."
            );
        }
    }

    // Rebuild when files change on disk.
    let watched = site::watched_paths(root, &config);
    let watch_state = Arc::clone(&state);
    thread::spawn(move || {
        let mut last = fsutil::fingerprint(&watched);
        loop {
            thread::sleep(Duration::from_millis(500));
            let now = fsutil::fingerprint(&watched);
            if now != last {
                last = now;
                match watch_state.rebuild() {
                    Ok(r) => {
                        println!("rebuilt: {} posts, {} files", r.posts, r.files);
                        if let Some(text) = changed_readiness(&mut last_readiness, &r) {
                            eprint!("{text}");
                        }
                    }
                    Err(e) => eprintln!("build failed (still serving the previous build):\n{e}"),
                }
            }
        }
    });

    // Persist view counts shortly after they change.
    let flush_state = Arc::clone(&state);
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(5));
        if let Err(e) = flush_state.flush_analytics() {
            eprintln!("analytics: {e}");
        }
        match flush_state.backup_analytics(false) {
            Ok(Some(id)) => println!("analytics backed up to the branch ({id})"),
            Ok(None) => {}
            Err(e) => eprintln!("analytics backup: {e}"),
        }
    });

    // Publish scheduled posts the moment they are due.
    let schedule_state = Arc::clone(&state);
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(5));
        if let Some(result) = schedule_state.tick_scheduler() {
            match result {
                Ok(r) => println!(
                    "scheduled posts published; {} live, {} still waiting",
                    r.posts, r.scheduled
                ),
                Err(e) => eprintln!("scheduled build failed:\n{e}"),
            }
        }
    });

    let listener = TcpListener::bind((options.host.as_str(), options.port))
        .map_err(|e| format!("cannot listen on {}:{}: {e}", options.host, options.port))?;
    println!(
        "\nServing {} at http://{}:{}{}/  (Ctrl+C to stop)",
        out_dir.display(),
        display_host(&options.host),
        options.port,
        state.base_path
    );
    if options.admin {
        println!(
            "Admin editor:  http://{}:{}/admin",
            display_host(&options.host),
            options.port
        );
    }

    let active = Arc::new(AtomicUsize::new(0));
    let per_ip: Arc<Mutex<HashMap<IpAddr, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    for stream in listener.incoming().flatten() {
        let Ok(peer) = stream.peer_addr() else {
            continue;
        };
        let proxied = state
            .trusted_proxies
            .iter()
            .any(|p| p.trim() == "*" || p.trim() == peer.ip().to_string());
        let Some(guard) = SlotGuard::acquire(&active, &per_ip, peer.ip(), proxied) else {
            continue;
        };
        let state = Arc::clone(&state);
        let out = out_dir.clone();
        thread::spawn(move || {
            let _guard = guard;
            let _ = handle(&stream, &state, &out);
        });
    }
    Ok(())
}

fn display_host(host: &str) -> &str {
    if host == "127.0.0.1" {
        "localhost"
    } else {
        host
    }
}

pub fn print_report(report: &site::BuildReport) {
    println!(
        "Built {} posts, {} series, {} tags, {} pages ({} generated files) -> {}",
        report.posts,
        report.series,
        report.tags,
        report.pages,
        report.files,
        report.out_dir.display()
    );
    if let Some(summary) = report.boundary.summary() {
        println!("{summary}");
    }
    if report.scheduled > 0 {
        let next = report
            .next_due
            .map(|d| format!(", next on {}", d.rfc3339()))
            .unwrap_or_default();
        println!("{} scheduled post(s) waiting{next}.", report.scheduled);
    }
    for w in &report.warnings {
        eprintln!("warning: {w}");
    }
    print_accessibility_findings(&report.accessibility);
    // The research report lists every evidence and source-review finding with
    // the same codes, so a site that has one prints them there, once.
    match &report.readiness {
        Some(readiness) => eprint!("{}", readiness.text()),
        None => {
            print_evidence_findings(&report.evidence);
            print_source_review_findings(&report.source_review);
        }
    }
}

/// The research report as the terminal prints it, empty when the build has none.
pub(crate) fn readiness_text(report: &site::BuildReport) -> String {
    report
        .readiness
        .as_ref()
        .map(|readiness| readiness.text())
        .unwrap_or_default()
}

/// The report to print after a rebuild, only when it differs from the last one
/// printed, so an unchanged report is not repeated on every save (ADR 0150).
pub(crate) fn changed_readiness(last: &mut String, report: &site::BuildReport) -> Option<String> {
    let text = readiness_text(report);
    if text == *last {
        return None;
    }
    last.clone_from(&text);
    (!text.is_empty()).then_some(text)
}

/// Source-review findings (ADR 0148), one line each in the shape evidence
/// findings use: outcome, place, message, repair and code.
pub fn print_source_review_findings(findings: &[SourceReviewFinding]) {
    for finding in findings {
        eprintln!("{}", source_review_line(finding));
    }
}

pub(crate) fn source_review_line(finding: &SourceReviewFinding) -> String {
    format!("source review {}: {finding}", finding.outcome)
}

pub fn print_evidence_findings(findings: &[EvidenceFinding]) {
    for finding in findings {
        eprintln!("{}", evidence_line(finding));
    }
}

fn evidence_line(finding: &EvidenceFinding) -> String {
    let location = if let Some(line) = finding.source.line {
        format!(
            "{}:{line}:{}",
            finding.source.path,
            finding.source.column.unwrap_or(1)
        )
    } else if let Some(field) = &finding.source.field {
        format!("{} ({field})", finding.source.path)
    } else {
        finding.source.path.clone()
    };
    format!(
        "evidence {}: {location}: {} Repair: {} [{}]",
        finding.outcome, finding.message, finding.repair, finding.code
    )
}

pub fn print_accessibility_findings(findings: &[AccessibilityFinding]) {
    for finding in findings {
        eprintln!("{}", accessibility_line(finding));
    }
}

fn accessibility_line(finding: &AccessibilityFinding) -> String {
    let location = match &finding.source.location {
        FindingLocation::Markdown { line, column } => {
            format!("{}:{line}:{column}", finding.source.path)
        }
        FindingLocation::Field { field } => format!("{} ({field})", finding.source.path),
    };
    format!(
        "accessibility {}: {location}: {} Repair: {} [{}]",
        finding.outcome, finding.message, finding.repair, finding.code
    )
}

fn handle(stream: &TcpStream, state: &AppState, out_dir: &Path) -> std::io::Result<()> {
    let mut conn = Conn::new(stream);
    let mut req = match conn.read_head() {
        Ok(r) => r,
        Err(e) => return http::write_response(stream, &Response::text(e.status, e.message), false),
    };
    let head_only = req.method == "HEAD";
    // Authorise from the headers alone, then read the body only up to what this route allows.
    let max_body = match admin::preflight(state, &req) {
        Ok(max) => max,
        Err(response) => return http::write_response(stream, &response, head_only),
    };
    if let Err(e) = conn.read_body(&mut req, max_body) {
        return http::write_response(stream, &Response::text(e.status, e.message), false);
    }
    let response = route(state, &req, out_dir);
    http::write_response(stream, &response, head_only)
}

pub(crate) fn route(state: &AppState, req: &Request, out_dir: &Path) -> Response {
    if req.path == "/admin"
        || req.path.starts_with("/admin/")
        || req.path == admin::CODE_RUNNER_LANGUAGE_PATH
    {
        return admin::handle(state, req);
    }
    // For load balancers, container health checks, and keep-awake pings.
    if req.path == "/health" && req.is_read_only() {
        return Response::json(
            200,
            &serde_json::json!({ "ok": true, "service": "open.blog", "version": env!("CARGO_PKG_VERSION") }),
        )
        .with_header("Cache-Control", "no-store");
    }
    if state.analytics_enabled {
        if req.path == "/api/hit" {
            return crate::analytics::hit(state, req, out_dir);
        }
        if req.path == "/api/views" {
            if req.method != "GET" && req.method != "HEAD" {
                return Response::error(405, "Use GET");
            }
            return crate::analytics::views(state, req, out_dir);
        }
    }
    if req.method != "GET" && req.method != "HEAD" {
        return Response::text(405, "Method Not Allowed");
    }
    // A site built for https://host/base/ is previewed at http://localhost/base/.
    let path = if state.base_path.is_empty() {
        req.path.as_str()
    } else if req.path == state.base_path {
        "/"
    } else if let Some(rest) = req.path.strip_prefix(&format!("{}/", state.base_path)) {
        &req.path[req.path.len() - rest.len() - 1..]
    } else if state.admin && state.cdn.is_asset_path(&req.path) {
        // The admin lives at `/admin` even when the published site has a base
        // path. Let its root-relative styles and images use the same built
        // assets without weakening the public site's base-path routing.
        req.path.as_str()
    } else {
        return Response::new(
            404,
            "text/html; charset=utf-8",
            format!(
                "<p>This site is served under <a href=\"{0}/\">{0}/</a>.</p>",
                state.base_path
            )
            .into_bytes(),
        );
    };
    match resolve(out_dir, path) {
        Some(file) => match fs::read(&file) {
            Ok(bytes) => {
                let is_page = file.file_name().is_some_and(|name| name == "index.html");
                let is_discovery_file = file.extension().is_some_and(|extension| {
                    matches!(extension.to_str(), Some("txt" | "xml" | "json" | "html"))
                });
                if state.analytics_enabled && (is_page || is_discovery_file) {
                    let public_path = if is_page {
                        if path == "/" {
                            "/".to_string()
                        } else {
                            format!("{}/", path.trim_end_matches('/'))
                        }
                    } else {
                        path.to_string()
                    };
                    crate::analytics::record_agent_request(state, req, &public_path);
                }
                // Assets may be cached by browsers and CDNs; pages always revalidate.
                // Only versioned asset URLs (`?v=`) may be cached long: an
                // unversioned one (such as a module imported by another script)
                // must revalidate, or a deploy would leave readers on stale code.
                let versioned = req.query.contains_key("v");
                let cache = if versioned && state.cdn.max_age > 0 && state.cdn.is_asset_path(path) {
                    format!("public, max-age={}", state.cdn.max_age)
                } else {
                    "no-cache".to_string()
                };
                let mut response =
                    Response::new(200, mime(&file), bytes).with_header("Cache-Control", &cache);
                // Public data files may be read by scripts on other sites (a "latest posts" list).
                if matches!(
                    path,
                    "/api/blog.json" | "/feed.json" | "/rss.xml" | "/search.json"
                ) || state.cdn.is_asset_path(path)
                {
                    response = response.with_header("Access-Control-Allow-Origin", "*");
                }
                response
            }
            Err(_) => Response::text(500, "Read error"),
        },
        None => {
            let body = fs::read(out_dir.join("404.html")).unwrap_or_else(|_| b"Not found".to_vec());
            Response::new(404, "text/html; charset=utf-8", body)
        }
    }
}

pub(crate) fn resolve(out_dir: &Path, url_path: &str) -> Option<PathBuf> {
    let rel = Path::new(url_path.trim_start_matches('/'));
    let mut clean = PathBuf::new();
    for component in rel.components() {
        match component {
            Component::Normal(c) => clean.push(c),
            Component::CurDir => {}
            // Reject `..`, drive prefixes and absolute components outright.
            _ => return None,
        }
    }
    let candidate = out_dir.join(&clean);
    if candidate.is_dir() {
        let index = candidate.join("index.html");
        return index.is_file().then_some(index);
    }
    if candidate.is_file() {
        // Never serve our own bookkeeping file.
        if candidate.file_name().is_some_and(|n| n == fsutil::MARKER) {
            return None;
        }
        return Some(candidate);
    }
    // `/about` -> `/about/index.html`, like most static hosts.
    let index = candidate.join("index.html");
    index.is_file().then_some(index)
}

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openblog_core::accessibility::{audit_document, audit_site_language, DocumentAuditInput};
    use openblog_core::{frontmatter, research};

    #[test]
    fn accessibility_output_names_outcome_location_code_and_repair() {
        let finding = audit_document(DocumentAuditInput {
            path: "posts/example.md",
            markdown: "[](/destination)\n",
            body_line: 4,
            embeds_enabled: true,
            cover_alt: None,
        })
        .remove(0);

        assert_eq!(
            accessibility_line(&finding),
            "accessibility detected: posts/example.md:4:1: This link has no accessible name. Repair: Add link text that identifies its destination or action. [link-name-empty]"
        );
    }

    #[test]
    fn accessibility_output_names_front_matter_or_config_fields() {
        let finding = audit_site_language("openblog.json", "").remove(0);

        assert_eq!(
            accessibility_line(&finding),
            "accessibility detected: openblog.json (language): Generated pages have no configured default language. Repair: Set `language` in openblog.json to the site's BCP 47 language tag. [document-language-missing]"
        );
    }

    #[test]
    fn evidence_output_names_outcome_location_code_and_repair() {
        let document = frontmatter::parse(
            "---\ntitle: Study\nprofile: research\ndoi:\n---\nA note.[^missing]",
        )
        .unwrap();
        let findings = research::audit_document(
            "posts/study.md",
            &document.front_matter,
            &document.body,
            document.body_line,
        );

        assert_eq!(
            evidence_line(&findings[0]),
            "evidence detected: posts/study.md (doi): The DOI does not have a valid prefix, separator, and suffix. Repair: Use a DOI name such as `10.1234/example` or its `https://doi.org/` URL. [doi-invalid]"
        );
        let unresolved = evidence_line(findings.last().unwrap());
        assert!(
            unresolved.starts_with("evidence detected: posts/study.md:6:8:"),
            "{unresolved}"
        );
    }

    #[test]
    fn slots_are_capped_globally_and_per_address_and_released_on_drop() {
        let active = Arc::new(AtomicUsize::new(0));
        let per_ip = Arc::new(Mutex::new(HashMap::new()));
        let a: IpAddr = "10.0.0.1".parse().unwrap();
        let b: IpAddr = "10.0.0.2".parse().unwrap();
        let mut held = Vec::new();
        for _ in 0..MAX_PER_IP {
            held.push(
                SlotGuard::acquire(&active, &per_ip, a, false).expect("under the per-IP cap"),
            );
        }
        assert!(
            SlotGuard::acquire(&active, &per_ip, a, false).is_none(),
            "one address cannot take more"
        );
        assert!(
            SlotGuard::acquire(&active, &per_ip, b, false).is_some(),
            "other addresses still get in"
        );
        assert_eq!(
            active.load(Ordering::SeqCst),
            MAX_PER_IP,
            "a refused acquire leaves no slot behind"
        );
        held.clear();
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert!(per_ip.lock().unwrap().is_empty());
        assert!(SlotGuard::acquire(&active, &per_ip, a, false).is_some());
        for _ in 0..MAX_PER_IP + 4 {
            held.push(
                SlotGuard::acquire(&active, &per_ip, b, true)
                    .expect("a trusted proxy is not capped per address"),
            );
        }
    }

    #[test]
    fn resolves_directories_and_rejects_traversal() {
        let dir = std::env::temp_dir().join(format!("ob-serve-{}", std::process::id()));
        fs::create_dir_all(dir.join("about")).unwrap();
        fs::write(dir.join("about/index.html"), "x").unwrap();
        fs::write(dir.join("a.css"), "x").unwrap();
        fs::write(dir.join(fsutil::MARKER), "x").unwrap();
        assert!(resolve(&dir, "/about/").is_some());
        assert!(resolve(&dir, "/about").is_some());
        assert!(resolve(&dir, "/a.css").is_some());
        assert!(resolve(&dir, "/nope").is_none());
        assert!(resolve(&dir, "/../secret").is_none());
        assert!(resolve(&dir, "/about/../../x").is_none());
        assert!(resolve(&dir, "/.openblog-output").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn base_path_assets_are_cacheable_and_cors_readable_for_sandboxed_previews() {
        let dir = std::env::temp_dir().join(format!("ob-serve-base-assets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("dist/assets")).unwrap();
        fs::write(
            dir.join("openblog.json"),
            r#"{"url":"https://example.com/blog/","cdn":{"maxAge":86400}}"#,
        )
        .unwrap();
        fs::write(dir.join("dist/assets/theme.js"), "export {};").unwrap();
        let state = AppState::new(dir.clone(), None, false, false);
        let mut request = Request {
            method: "GET".into(),
            path: "/blog/assets/theme.js".into(),
            ..Default::default()
        };
        request.query.insert("v".into(), "preview".into());
        let response = route(&state, &request, &dir.join("dist"));
        assert_eq!(response.status, 200);
        assert!(response
            .headers
            .iter()
            .any(|(name, value)| name == "Access-Control-Allow-Origin" && value == "*"));
        assert!(response
            .headers
            .iter()
            .any(|(name, value)| { name == "Cache-Control" && value == "public, max-age=86400" }));
        let _ = fs::remove_dir_all(&dir);
    }
}
