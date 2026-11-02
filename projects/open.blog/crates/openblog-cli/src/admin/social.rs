//! Admin routes for connected social accounts (ADR 0301, epic #353 story #355).
//!
//! Social publishing is optional and off by default. Admin reaches the hosted social function
//! only from this server: the browser never holds a key, never talks to Supabase and never talks
//! to the function. The function's address and the Admin key come from the environment of the
//! process running Admin (`OPENBLOG_SOCIAL_ENDPOINT`, `OPENBLOG_SOCIAL_ADMIN_KEY`), never from
//! `openblog.json`, the repository or a response. Unset, or invalid, and every route here but the
//! status one is a 404 and nothing is sent anywhere.
//!
//! Every route sits behind the session and, for a write, the CSRF check (`api`), and the body is
//! bounded before it is read (`preflight`). The signed-in user is named to the function as the
//! social actor (ADR 0293). What the function answers is not forwarded: each reply is rebuilt
//! from the fields Admin shows, so a token that a faulty or hostile function included would
//! still be dropped, and an authorization address is accepted only for LinkedIn or Facebook.

use std::time::Duration;

use super::*;

/// The largest request body any social route takes.
pub(super) const MAX_SOCIAL_REQUEST_BYTES: usize = 4 * 1024;
const MAX_REPLY_BYTES: usize = 1024 * 1024;
const MIN_KEY_CHARS: usize = 32;
const PROVIDERS: [&str; 2] = ["linkedin", "facebook"];
const AUTHORIZE_HOSTS: [&str; 2] = ["www.linkedin.com", "www.facebook.com"];

/// Where the hosted function is and how Admin proves who it is. Built only from the environment.
pub(super) struct SocialConfig {
    endpoint: String,
    key: String,
}

impl SocialConfig {
    pub(super) fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub(super) fn key(&self) -> &str {
        &self.key
    }
}

pub(super) enum Configured {
    /// Neither setting is present: the feature does not exist here.
    Off,
    /// Something is set but wrong; the names, never the values.
    Invalid(Vec<&'static str>),
    On(SocialConfig),
}

fn loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

/// `https://` (or `http://` to a loopback address, for local development), no credentials, query
/// or fragment. Returns the address without a trailing slash.
fn valid_endpoint(value: &str) -> Option<String> {
    let url = url::Url::parse(value.trim()).ok()?;
    let host = url.host_str()?;
    let secure = url.scheme() == "https" || (url.scheme() == "http" && loopback(host));
    if !secure
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url.as_str().trim_end_matches('/').to_string())
}

pub(super) fn configuration(env: &dyn Fn(&str) -> Option<String>) -> Configured {
    let endpoint = env("OPENBLOG_SOCIAL_ENDPOINT").unwrap_or_default();
    let key = env("OPENBLOG_SOCIAL_ADMIN_KEY").unwrap_or_default();
    if endpoint.trim().is_empty() && key.is_empty() {
        return Configured::Off;
    }
    let mut problems = Vec::new();
    let endpoint = valid_endpoint(&endpoint);
    if endpoint.is_none() {
        problems.push("OPENBLOG_SOCIAL_ENDPOINT");
    }
    if key.chars().count() < MIN_KEY_CHARS || key.chars().any(char::is_whitespace) {
        problems.push("OPENBLOG_SOCIAL_ADMIN_KEY");
    }
    match (endpoint, problems.is_empty()) {
        (Some(endpoint), true) => Configured::On(SocialConfig { endpoint, key }),
        _ => Configured::Invalid(problems),
    }
}

/// Whether Admin has any social settings, valid or not. Only then does the navigation show the page.
pub(super) fn is_configured() -> bool {
    !matches!(configuration(&process_env), Configured::Off)
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn is_uuid(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.len() == 5
        && [8usize, 4, 4, 4, 12]
            .iter()
            .zip(&groups)
            .all(|(len, group)| {
                group.len() == *len
                    && group
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
}

/// A short, printable string from the hosted function; anything else is dropped.
fn text(value: &Json, max: usize) -> Option<String> {
    let value = value.as_str()?;
    (value.chars().count() <= max && !value.chars().any(char::is_control))
        .then(|| value.to_string())
}

fn slug(value: &Json) -> Option<String> {
    let value = value.as_str()?;
    (!value.is_empty()
        && value.len() <= 40
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
    .then(|| value.to_string())
}

fn optional_text(value: &Json, key: &str, max: usize) -> Json {
    value
        .get(key)
        .and_then(|v| text(v, max))
        .map(Json::String)
        .unwrap_or(Json::Null)
}

fn strings(value: &Json, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Json::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| text(item, 120))
                .take(40)
                .collect()
        })
        .unwrap_or_default()
}

fn provider_name(value: &Json) -> Option<String> {
    let name = value.as_str()?;
    PROVIDERS.contains(&name).then(|| name.to_string())
}

fn project_credential(value: &Json) -> Json {
    if !value.is_object() {
        return Json::Null;
    }
    json!({
        "status": value.get("status").and_then(slug),
        "accessExpiresAt": optional_text(value, "accessExpiresAt", 40),
        "refreshExpiresAt": optional_text(value, "refreshExpiresAt", 40),
        "lastRefreshedAt": optional_text(value, "lastRefreshedAt", 40),
        "scopes": strings(value, "scopes"),
    })
}

fn project_account(value: &Json) -> Option<Json> {
    let id = text(value.get("id")?, 36).filter(|id| is_uuid(id))?;
    Some(json!({
        "id": id,
        "provider": provider_name(value.get("provider")?)?,
        "kind": slug(value.get("kind")?)?,
        "externalId": text(value.get("externalId")?, 200)?,
        "displayName": text(value.get("displayName")?, 200)?,
        "status": slug(value.get("status")?)?,
        "health": slug(value.get("health")?)?,
        "connectedBy": optional_text(value, "connectedBy", 32),
        "createdAt": optional_text(value, "createdAt", 40),
        "updatedAt": optional_text(value, "updatedAt", 40),
        "disconnectedAt": optional_text(value, "disconnectedAt", 40),
        "credential": project_credential(value.get("credential").unwrap_or(&Json::Null)),
    }))
}

fn project_destination(value: &Json) -> Option<Json> {
    Some(json!({
        "id": text(value.get("id")?, 200)?,
        "kind": slug(value.get("kind")?)?,
        "name": text(value.get("name")?, 200)?,
        "eligible": value.get("eligible")?.as_bool()?,
        "reason": value.get("reason").and_then(slug),
    }))
}

fn project_connection(value: &Json) -> Option<Json> {
    let id = text(value.get("id")?, 36).filter(|id| is_uuid(id))?;
    let destinations: Vec<Json> = value
        .get("destinations")
        .and_then(Json::as_array)
        .map(|list| {
            list.iter()
                .filter_map(project_destination)
                .take(50)
                .collect()
        })
        .unwrap_or_default();
    let notes: Vec<Json> = value
        .get("notes")
        .and_then(Json::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|note| {
                    Some(json!({"code": slug(note.get("code")?)?, "text": text(note.get("text")?, 600)?}))
                })
                .take(10)
                .collect()
        })
        .unwrap_or_default();
    Some(json!({
        "id": id,
        "provider": provider_name(value.get("provider")?)?,
        "status": slug(value.get("status")?)?,
        "expiresAt": optional_text(value, "expiresAt", 40),
        "createdAt": optional_text(value, "createdAt", 40),
        "createdBy": optional_text(value, "createdBy", 32),
        "reauthAccountId": value.get("reauthAccountId").and_then(|v| text(v, 36)).filter(|id| is_uuid(id)),
        "requestedScopes": strings(value, "requestedScopes"),
        "grantedScopes": strings(value, "grantedScopes"),
        "errorCode": value.get("errorCode").and_then(slug),
        "message": optional_text(value, "message", 600),
        "destinations": destinations,
        "notes": notes,
    }))
}

fn project_provider(value: &Json) -> Option<Json> {
    Some(json!({
        "provider": provider_name(value.get("provider")?)?,
        "label": text(value.get("label")?, 40)?,
        "redirectUri": text(value.get("redirectUri")?, 500)?,
        "version": text(value.get("version")?, 20)?,
        "scopes": strings(value, "scopes"),
        "requiredScopes": strings(value, "requiredScopes"),
        "organizations": value.get("organizations").and_then(Json::as_bool).unwrap_or(false),
        "pkce": value.get("pkce").and_then(Json::as_bool).unwrap_or(false),
    }))
}

/// The address the author's browser is sent to. Only the two providers' own hosts are accepted.
fn authorize_url(value: &Json) -> Option<String> {
    let value = value.as_str()?;
    if value.len() > 2000 {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url
            .host_str()
            .is_some_and(|host| AUTHORIZE_HOSTS.contains(&host)))
    .then(|| url.to_string())
}

fn list_of(value: &Json, key: &str, project: fn(&Json) -> Option<Json>) -> Json {
    let list: Vec<Json> = value
        .get(key)
        .and_then(Json::as_array)
        .map(|items| items.iter().filter_map(project).take(200).collect())
        .unwrap_or_default();
    json!({ key: list })
}

fn bad_reply() -> Response {
    Response::error(502, "The social function sent a reply Admin could not use")
}

/// The function's own refusal, reduced to a status Admin may pass on and a short plain message.
/// Only a refusal about the request itself is forwarded; anything else (including a failure whose
/// text could echo something it should not) becomes a fixed message.
fn refusal(status: u16, body: &Json) -> Response {
    let code = body.get("error").and_then(slug);
    if matches!(status, 400 | 404 | 409 | 413 | 429) {
        let message = body
            .get("message")
            .and_then(|m| text(m, 300))
            .unwrap_or_else(|| "The social function refused the request".to_string());
        return Response::json(status, &json!({ "error": message, "code": code }));
    }
    let message = if matches!(code.as_deref(), Some("unauthorized" | "forbidden")) {
        "The social function did not accept Admin's key; check OPENBLOG_SOCIAL_ADMIN_KEY"
    } else {
        "The social function failed; try again"
    };
    Response::json(502, &json!({ "error": message }))
}

fn hosted(
    config: &SocialConfig,
    method: &str,
    path: &str,
    body: Option<&Json>,
    actor: &str,
) -> Result<Json, Response> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .max_redirects(0)
        .http_status_as_error(false)
        .user_agent(concat!("open.blog-admin/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let url = format!("{}/{}", config.endpoint, path);
    let authorization = format!("Bearer {}", config.key);
    let result = if method == "GET" {
        agent
            .get(&url)
            .header("Authorization", &authorization)
            .header("X-OpenBlog-Actor", actor)
            .call()
    } else {
        let bytes = body.map(Json::to_string).unwrap_or_else(|| "{}".into());
        agent
            .post(&url)
            .header("Authorization", &authorization)
            .header("X-OpenBlog-Actor", actor)
            .header("Content-Type", "application/json")
            .send(bytes.as_bytes())
    };
    let mut response = match result {
        Ok(response) => response,
        Err(ureq::Error::Timeout(_)) => {
            return Err(Response::error(504, "The social function timed out"))
        }
        Err(_) => {
            return Err(Response::error(
                502,
                "The social function could not be reached",
            ))
        }
    };
    let status = response.status().as_u16();
    let bytes = response
        .body_mut()
        .with_config()
        .limit(MAX_REPLY_BYTES as u64)
        .read_to_vec()
        .map_err(|_| bad_reply())?;
    let value: Json = serde_json::from_slice(&bytes).map_err(|_| bad_reply())?;
    if status >= 300 {
        return Err(refusal(status, &value));
    }
    Ok(value)
}

fn object_body(req: &Request, allowed: &[&str]) -> Result<Json, Response> {
    if req.body.is_empty() {
        return Ok(json!({}));
    }
    let body: Json = serde_json::from_slice(&req.body)
        .map_err(|_| Response::error(400, "The request is not valid JSON"))?;
    let Some(object) = body.as_object() else {
        return Err(Response::error(400, "The request must be a JSON object"));
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(Response::error(
            400,
            "The request has a field this route does not take",
        ));
    }
    Ok(body)
}

/// Handles `social/...` for a signed-in user. `name` is the part after `social/`.
pub(super) fn route(req: &Request, user: &str, name: &str) -> Response {
    route_with(&process_env, req, user, name)
}

pub(super) fn route_with(
    env: &dyn Fn(&str) -> Option<String>,
    req: &Request,
    user: &str,
    name: &str,
) -> Response {
    let configured = configuration(env);
    if name == "status" && req.method == "GET" {
        return status(configured, user);
    }
    let Configured::On(config) = configured else {
        return Response::error(404, "Social publishing is not set up");
    };
    if req.method != "GET" {
        if let Err(response) = require_json(req) {
            return response;
        }
    }
    let parts: Vec<&str> = name.split('/').collect();
    let result = match (req.method.as_str(), parts.as_slice()) {
        ("GET", ["accounts"]) => hosted(&config, "GET", "accounts", None, user)
            .map(|reply| list_of(&reply, "accounts", project_account)),
        ("GET", ["connections"]) => hosted(&config, "GET", "connections", None, user)
            .map(|reply| list_of(&reply, "connections", project_connection)),
        ("POST", ["connections"]) => start(req, &config, user),
        ("POST", ["connections", id, "select"]) if is_uuid(id) => select(req, &config, user, id),
        ("POST", ["connections", id, "cancel"]) if is_uuid(id) => empty_body_call(
            req,
            &config,
            user,
            &format!("connections/{id}/cancel"),
            "connection",
            project_connection,
        ),
        ("POST", ["accounts", id, "reconnect"]) if is_uuid(id) => reconnect(req, &config, user, id),
        ("POST", ["accounts", id, "disconnect"]) if is_uuid(id) => empty_body_call(
            req,
            &config,
            user,
            &format!("accounts/{id}/disconnect"),
            "account",
            project_account,
        ),
        _ => return Response::error(404, "Unknown API route"),
    };
    match result {
        Ok(value) => Response::json(200, &value),
        Err(response) => response,
    }
}

fn status(configured: Configured, user: &str) -> Response {
    match configured {
        Configured::Off => Response::json(200, &json!({ "enabled": false, "state": "off" })),
        Configured::Invalid(problems) => Response::json(
            200,
            &json!({ "enabled": false, "state": "invalid", "problems": problems }),
        ),
        Configured::On(config) => match hosted(&config, "GET", "status", None, user) {
            Ok(reply) => {
                let providers: Vec<Json> = reply
                    .get("providers")
                    .and_then(Json::as_array)
                    .map(|list| list.iter().filter_map(project_provider).collect())
                    .unwrap_or_default();
                let problems = strings(&reply, "problems");
                Response::json(
                    200,
                    &json!({ "enabled": true, "state": "on", "providers": providers, "problems": problems }),
                )
            }
            Err(response) if response.status == 404 => Response::json(
                200,
                &json!({ "enabled": false, "state": "unavailable", "message": "The social function says social publishing is not enabled; set OPENBLOG_SOCIAL_ENABLED=true there." }),
            ),
            Err(response) => response,
        },
    }
}

fn start(req: &Request, config: &SocialConfig, user: &str) -> Result<Json, Response> {
    let body = object_body(req, &["provider"])?;
    let Some(provider) = body.get("provider").and_then(provider_name) else {
        return Err(Response::error(400, "Choose LinkedIn or Facebook"));
    };
    let reply = hosted(
        config,
        "POST",
        "connections",
        Some(&json!({ "provider": provider })),
        user,
    )?;
    let connection = reply.get("connection").and_then(project_connection);
    let url = reply.get("authorizeUrl").and_then(authorize_url);
    match (connection, url) {
        (Some(connection), Some(url)) => {
            Ok(json!({ "connection": connection, "authorizeUrl": url }))
        }
        _ => Err(bad_reply()),
    }
}

fn reconnect(req: &Request, config: &SocialConfig, user: &str, id: &str) -> Result<Json, Response> {
    object_body(req, &[])?;
    let reply = hosted(
        config,
        "POST",
        &format!("accounts/{id}/reconnect"),
        Some(&json!({})),
        user,
    )?;
    let connection = reply.get("connection").and_then(project_connection);
    let url = reply.get("authorizeUrl").and_then(authorize_url);
    match (connection, url) {
        (Some(connection), Some(url)) => {
            Ok(json!({ "connection": connection, "authorizeUrl": url }))
        }
        _ => Err(bad_reply()),
    }
}

fn select(req: &Request, config: &SocialConfig, user: &str, id: &str) -> Result<Json, Response> {
    let body = object_body(req, &["destination"])?;
    let Some(destination) = body
        .get("destination")
        .and_then(|d| text(d, 200))
        .filter(|d| !d.is_empty())
    else {
        return Err(Response::error(400, "Choose a destination from the list"));
    };
    let reply = hosted(
        config,
        "POST",
        &format!("connections/{id}/select"),
        Some(&json!({ "destination": destination })),
        user,
    )?;
    match reply.get("account").and_then(project_account) {
        Some(account) => Ok(json!({ "account": account })),
        None => Err(bad_reply()),
    }
}

fn empty_body_call(
    req: &Request,
    config: &SocialConfig,
    user: &str,
    path: &str,
    key: &str,
    project: fn(&Json) -> Option<Json>,
) -> Result<Json, Response> {
    object_body(req, &[])?;
    let reply = hosted(config, "POST", path, Some(&json!({})), user)?;
    match reply.get(key).and_then(project) {
        Some(value) => Ok(json!({ key: value })),
        None => Err(bad_reply()),
    }
}
