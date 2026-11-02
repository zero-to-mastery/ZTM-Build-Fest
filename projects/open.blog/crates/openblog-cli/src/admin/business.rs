//! Admin routes for the business facts (ADR 0307, #508): `GET` and `PUT /admin/api/business`.
//!
//! Both sit behind the session and, for the write, the CSRF and same-origin checks in `api`; the
//! body is bounded before it is read. A save is validated by the core, compared with the revision
//! the editor started from, and changes only the `business` member of `openblog.json`: the file is
//! edited as text (`config_text::set_member`), so every other key keeps its place and spelling.
//! The revision is a digest of the stored block alone, so a save elsewhere in the file neither
//! conflicts with nor is lost to a save here.

use openblog_core::business::{
    normalize_phone_input, BusinessConfig, PaymentMethod, Weekday, BUSINESS_VERSION,
};
use openblog_core::SiteConfig;

use super::*;
use crate::config_text;

/// The largest request body. A full block is well under 2 KiB; this leaves room for preserved fields.
pub(super) const MAX_REQUEST_BYTES: usize = 8 * 1024;

const FIELDS: [&str; 11] = [
    "legalName",
    "displayName",
    "trade",
    "phone",
    "email",
    "hours",
    "licenseNumber",
    "licenseIssuer",
    "insured",
    "paymentMethods",
    "foundedYear",
];

/// A digest of the stored block, so it changes only when the block does.
fn revision(stored: &Json) -> String {
    etag_bytes(stored.to_string().as_bytes())
}

/// The `business` member of a parsed `openblog.json`, or `{}` when there is none.
fn stored_business(config: &Json) -> Json {
    match config.get("business") {
        Some(Json::Object(object)) => Json::Object(object.clone()),
        _ => json!({}),
    }
}

/// One problem as the screen shows it: the field it is about, a plain message, and the weekday when
/// the message is about one row of the hours.
fn problem(message: &str) -> Json {
    let message = message.strip_prefix("business: ").unwrap_or(message);
    let message = message.strip_prefix("business.").unwrap_or(message);
    let field = message
        .split([' ', ':'])
        .next()
        .filter(|word| FIELDS.contains(word))
        .unwrap_or("");
    let message = if field == "trade" {
        "trade must be one of the trades in the list"
    } else {
        message
    };
    let day = Weekday::ALL
        .iter()
        .find(|day| field == "hours" && message.contains(day.label()))
        .map(|day| day.id());
    json!({ "field": field, "day": day, "message": message })
}

/// Every problem with a stored or submitted block, for the whole config it would sit in.
fn problems_for(value: &Json, config_text: Option<&str>) -> Vec<Json> {
    let mut problems: Vec<Json> = match BusinessConfig::from_value(value) {
        Ok(_) => Vec::new(),
        Err(errors) => errors.iter().map(|message| problem(message)).collect(),
    };
    if problems.is_empty() {
        if let Some(text) = config_text {
            if let Err(error) = SiteConfig::from_json(text) {
                let message = error
                    .strip_prefix("invalid openblog.json: ")
                    .unwrap_or(&error);
                problems.push(problem(message));
            }
        }
    }
    problems
}

/// What the screen needs: the stored block as written, its problems if it has any, and the choices.
fn describe(bytes: &[u8]) -> Result<Json, String> {
    let source = std::str::from_utf8(bytes).map_err(|error| error.to_string())?;
    let raw: Json = serde_json::from_str(source)
        .map_err(|_| "openblog.json must contain a valid JSON object".to_string())?;
    let stored = stored_business(&raw);
    let extra: Vec<String> = raw
        .get("extraTrades")
        .and_then(Json::as_array)
        .map(|all| {
            all.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let problems = match BusinessConfig::from_value(&stored) {
        Ok(_) => Vec::new(),
        Err(errors) => errors.iter().map(|message| problem(message)).collect(),
    };
    Ok(json!({
        "version": BUSINESS_VERSION,
        "business": stored,
        "etag": revision(&stored),
        "problems": problems,
        "trades": openblog_core::job::known_trades(&extra),
        "paymentMethods": PaymentMethod::ALL
            .iter()
            .map(|method| json!({ "id": method.id(), "label": method.label() }))
            .collect::<Vec<_>>(),
        "weekdays": Weekday::ALL
            .iter()
            .map(|day| json!({ "id": day.id(), "label": day.label() }))
            .collect::<Vec<_>>(),
    }))
}

pub(super) fn get_business(state: &AppState) -> Response {
    let _transaction = match content_transaction(state) {
        Ok(lock) => lock,
        Err(response) => return response,
    };
    match fs::read(state.root.join(site::CONFIG_FILE))
        .map_err(|error| format!("cannot read openblog.json: {error}"))
        .and_then(|bytes| describe(&bytes))
    {
        Ok(business) => Response::json(200, &business),
        Err(error) => Response::error(500, &error),
    }
}

/// The submitted block as the core will read it: typed phones become E.164 and a field left empty is
/// a field not stated. Anything else is left for the core to judge.
fn tidy(submitted: &Json) -> Json {
    let Json::Object(object) = submitted else {
        return submitted.clone();
    };
    let mut out = Map::new();
    for (key, value) in object {
        match value {
            Json::Null => {}
            Json::String(text) if text.trim().is_empty() => {}
            Json::Bool(false) if key == "insured" => {}
            Json::Array(items) if items.is_empty() => {}
            Json::Object(days) if key == "hours" && days.is_empty() => {}
            Json::String(text) if key == "phone" => {
                out.insert(key.clone(), json!(normalize_phone_input(text)));
            }
            other => {
                out.insert(key.clone(), other.clone());
            }
        }
    }
    Json::Object(out)
}

pub(super) fn save_business(state: &AppState, req: &Request) -> Response {
    if let Err(response) = require_json(req) {
        return response;
    }
    if req.body.len() > MAX_REQUEST_BYTES {
        return Response::error(413, "The business facts are too large");
    }
    let body: Json = match serde_json::from_slice(&req.body) {
        Ok(Json::Object(body)) => Json::Object(body),
        _ => return Response::error(400, "Invalid JSON"),
    };
    let Some(etag) = body.get("etag").and_then(Json::as_str) else {
        return Response::error(422, "etag is required");
    };
    let mut submitted = match body.get("business") {
        Some(value @ Json::Object(_)) => tidy(value),
        Some(Json::Null) | None => json!({}),
        Some(_) => return Response::error(422, "business must be an object"),
    };
    // Nothing is read or written before the core has judged the block on its own.
    let checked = match BusinessConfig::from_value(&submitted) {
        Ok(checked) => checked,
        Err(errors) => {
            return unprocessable(&errors.iter().map(|m| problem(m)).collect::<Vec<_>>())
        }
    };

    let mut build = lock(&state.build);
    let _transaction = match content_transaction(state) {
        Ok(lock) => lock,
        Err(response) => return response,
    };
    let path = state.root.join(site::CONFIG_FILE);
    let current = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => return Response::error(500, &format!("cannot read openblog.json: {error}")),
    };
    let Ok(current_text) = String::from_utf8(current.clone()) else {
        return Response::error(500, "openblog.json must be UTF-8 text");
    };
    let config: Json = match serde_json::from_str(&current_text) {
        Ok(Json::Object(object)) => Json::Object(object),
        _ => return Response::error(500, "openblog.json must contain a valid JSON object"),
    };
    let stored = stored_business(&config);
    if revision(&stored) != etag {
        // Hand back the current block so the editor can reload and decide.
        let mut conflict = describe(&current).unwrap_or_else(|_| json!({}));
        conflict["error"] =
            json!("The business facts changed since you opened them; reload before saving");
        return Response::json(409, &conflict);
    }

    // Keep fields this engine does not know, as the core does for a stored block.
    if let (Some(known), Json::Object(target)) = (stored.as_object(), &mut submitted) {
        if !checked.is_default() {
            for (key, value) in known {
                if !FIELDS.contains(&key.as_str()) && key != "version" {
                    target.entry(key.clone()).or_insert_with(|| value.clone());
                }
            }
        }
    }
    let value = match BusinessConfig::from_value(&submitted) {
        Ok(business) => business.to_value(),
        Err(errors) => {
            return unprocessable(&errors.iter().map(|m| problem(m)).collect::<Vec<_>>())
        }
    };
    let member = match &value {
        Json::Object(object) if object.is_empty() => None,
        other => Some(other),
    };
    let candidate = match config_text::set_member(&current_text, "business", member) {
        Ok(text) => text,
        Err(error) => return Response::error(500, &error),
    };
    // The whole file must still load: the trade is checked against the site's own trades here.
    let problems = problems_for(&value, Some(&candidate));
    if !problems.is_empty() {
        return unprocessable(&problems);
    }
    if let Err(error) = write_atomic(&path, &candidate) {
        return Response::error(500, &error);
    }
    let mut described = match describe(candidate.as_bytes()) {
        Ok(described) => described,
        Err(error) => return Response::error(500, &error),
    };
    // Report the saved revision even when an unrelated content error blocks rebuilding.
    described["buildError"] = match state.rebuild_locked(&mut build) {
        Ok(_) => Json::Null,
        Err(error) => Json::String(error),
    };
    Response::json(200, &described)
}

fn unprocessable(problems: &[Json]) -> Response {
    let message = problems
        .iter()
        .filter_map(|p| p["message"].as_str())
        .collect::<Vec<_>>()
        .join("; ");
    Response::json(422, &json!({ "error": message, "problems": problems }))
}
