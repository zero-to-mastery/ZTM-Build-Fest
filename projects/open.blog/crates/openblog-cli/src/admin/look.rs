//! Admin routes for the site look (ADR 0248, #349): `GET` and `PUT /admin/api/look`.
//!
//! Both sit behind the session and, for the write, the CSRF check in `api`; an unknown name is a
//! 404. A save is validated by the core, compared with the revision the editor started from, and
//! changes only the `appearance` key of `openblog.json` (written atomically), so no other setting is
//! touched. The revision is a digest of the stored look alone, so a save elsewhere in the file
//! (for example a landing page section) neither conflicts with nor is lost to a look save.

use openblog_core::look::{self, LookSettings, CONTROLS};
use openblog_core::look_presets;
use openblog_core::SiteConfig;

use super::*;

/// The largest request body. A full look is under 300 bytes; this leaves room for preserved fields.
pub(super) const MAX_REQUEST_BYTES: usize = 4 * 1024;

/// A digest of the stored look, so it changes only when the look does.
fn revision(stored: &Json) -> String {
    etag_bytes(stored.to_string().as_bytes())
}

/// The `appearance` value of a parsed `openblog.json`, or `{}` when there is none.
fn stored_look(config: &Json) -> Json {
    match config.get("appearance") {
        Some(Json::Object(object)) => Json::Object(object.clone()),
        _ => json!({}),
    }
}

/// Everything the Customize look screen needs: the stored look, what the active theme honors, the
/// plain-words note about the rest, the curated looks, the choices each control offers, and any
/// adjustment the readable-color model made.
fn describe(root: &Path, bytes: &[u8]) -> Result<Json, String> {
    let source = std::str::from_utf8(bytes).map_err(|error| error.to_string())?;
    let config = SiteConfig::from_json(source)?;
    let theme = site::load_themes(root, &config)?.resolve(&config.theme)?;
    let raw: Json = serde_json::from_str(source).map_err(|error| error.to_string())?;
    let stored = stored_look(&raw);
    let compiled = theme.clone().with_look(&config.appearance).look;
    let notes = compiled
        .as_ref()
        .map(|compiled| compiled.notes.clone())
        .unwrap_or_default();
    let refused = compiled.is_some_and(|compiled| compiled.refused);
    let controls: Vec<Json> = CONTROLS
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "label": look::control_label(id),
                "honored": theme.honors(id),
            })
        })
        .collect();
    Ok(json!({
        "version": look::LOOK_VERSION,
        "look": stored,
        "etag": revision(&stored),
        "theme": { "name": theme.name, "label": theme.label },
        "controls": controls,
        "honored": theme.customizable,
        "note": look::unhonored_note(&theme.label, &theme.customizable),
        "adjustments": notes,
        "refused": refused,
        "looks": look_presets::catalog_json(),
        "choices": {
            "fontStyle": look::FontStyle::ids(),
            "textSize": look::TextSize::ids(),
            "roundness": look::Roundness::ids(),
            "spacing": look::Spacing::ids(),
            "pageWidth": look::PageWidth::ids(),
            "headingWeight": look::HeadingWeight::ids(),
            "palette": look::PALETTE_IDS,
        },
    }))
}

pub(super) fn get_look(state: &AppState) -> Response {
    let _transaction = match content_transaction(state) {
        Ok(lock) => lock,
        Err(response) => return response,
    };
    match fs::read(state.root.join(site::CONFIG_FILE))
        .map_err(|error| format!("cannot read openblog.json: {error}"))
        .and_then(|bytes| describe(&state.root, &bytes))
    {
        Ok(look) => Response::json(200, &look),
        Err(error) => Response::error(500, &error),
    }
}

pub(super) fn save_look(state: &AppState, req: &Request) -> Response {
    if let Err(response) = require_json(req) {
        return response;
    }
    if req.body.len() > MAX_REQUEST_BYTES {
        return Response::error(413, "The look is too large");
    }
    let body: Json = match serde_json::from_slice(&req.body) {
        Ok(Json::Object(body)) => Json::Object(body),
        _ => return Response::error(400, "Invalid JSON"),
    };
    let Some(etag) = body.get("etag").and_then(Json::as_str) else {
        return Response::error(422, "etag is required");
    };
    // Validate before anything is read or written. `null` and `{}` both mean "the theme as it is".
    let submitted = match LookSettings::from_value(body.get("look").unwrap_or(&Json::Null)) {
        Ok(look) => look,
        Err(errors) => return Response::error(422, &errors.join("; ")),
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
    let mut config: Json = match serde_json::from_slice(&current) {
        Ok(Json::Object(object)) => Json::Object(object),
        _ => return Response::error(500, "openblog.json must contain a valid JSON object"),
    };
    let stored = stored_look(&config);
    if revision(&stored) != etag {
        // Hand back the current revision so the editor can reload and decide.
        let mut conflict = describe(&state.root, &current).unwrap_or_else(|_| json!({}));
        conflict["error"] = json!("The look changed since you opened it; reload before saving");
        return Response::json(409, &conflict);
    }

    // Preserve fields this engine does not know, as the core does for a stored look.
    let mut next = submitted;
    if let Ok(previous) = LookSettings::from_value(&stored) {
        for (key, value) in previous.extra {
            next.extra.entry(key).or_insert(value);
        }
    }
    let value = next.to_value();
    match &value {
        Json::Object(object) if object.is_empty() => {
            if let Some(map) = config.as_object_mut() {
                map.remove("appearance");
            }
        }
        _ => config["appearance"] = value,
    }
    let candidate = match serde_json::to_string_pretty(&config) {
        Ok(json) => format!("{json}\n"),
        Err(error) => {
            return Response::error(500, &format!("cannot serialize openblog.json: {error}"))
        }
    };
    // The whole file must still load, and the accent must be usable on the site's theme.
    let mut described = match describe(&state.root, candidate.as_bytes()) {
        Ok(described) => described,
        Err(error) => return Response::error(422, &error),
    };
    if described["refused"] == true {
        let reason = described["adjustments"]
            .as_array()
            .and_then(|all| all.last())
            .and_then(Json::as_str)
            .unwrap_or("That accent color cannot be made easy to read on this theme.");
        return Response::error(422, reason);
    }
    if let Err(error) = write_atomic(&path, &candidate) {
        return Response::error(500, &error);
    }
    // Report the saved revision even when an unrelated content error blocks rebuilding.
    described["buildError"] = match state.rebuild_locked(&mut build) {
        Ok(_) => Json::Null,
        Err(error) => Json::String(error),
    };
    Response::json(200, &described)
}

/// `POST look/preview`: the home page as it would be built with the look in the request, which is
/// not saved (ADR 0256). The look is validated as a save would validate it, the page is built in
/// memory by the production code, and the theme's whole stylesheet (with this look layered over it)
/// replaces the stylesheet link, so a control reset to the theme default really shows the default.
/// `mode` (`light` or `dark`) fixes the color scheme. The answer also carries the plain-words notes
/// on any color the readable-color model adjusted. No file is written and nothing is published.
pub(super) fn preview(state: &AppState, req: &Request) -> Response {
    if let Err(response) = require_json(req) {
        return response;
    }
    if req.body.len() > MAX_REQUEST_BYTES {
        return Response::error(413, "The look is too large");
    }
    let body: Json = match serde_json::from_slice(&req.body) {
        Ok(Json::Object(body)) => Json::Object(body),
        _ => return Response::error(400, "Invalid JSON"),
    };
    let submitted = match LookSettings::from_value(body.get("look").unwrap_or(&Json::Null)) {
        Ok(look) => look,
        Err(errors) => return Response::error(422, &errors.join("; ")),
    };
    let mode = match body.get("mode").and_then(Json::as_str) {
        None | Some("system") => None,
        Some(mode @ ("light" | "dark")) => Some(mode),
        Some(_) => return Response::error(422, "mode must be light, dark or system"),
    };
    let mut config = match site::load_config(&state.root) {
        Ok(config) => config,
        Err(error) => return Response::error(500, &error),
    };
    config.appearance = submitted.clone();
    // Owner-supplied scripts and analytics stay off in a preview, as in the landing preview.
    config.snippets = Default::default();
    config.analytics.builtin = false;
    config.analytics.show_views = false;
    config.analytics.endpoint.clear();
    config.engagement.enabled = false;
    let guard = lock(&state.build);
    let sources = match site::read_sources(&state.root, &config) {
        Ok(sources) => sources,
        Err(error) => return Response::error(500, &error),
    };
    let (preview_site, themes) = match site::load_site_from_sources_listing(
        &state.root,
        config,
        sources,
        LoadOptions {
            include_drafts: false,
            now: Some(clock::now()),
            preview_source: None,
        },
    ) {
        Ok(loaded) => loaded,
        Err(errors) => return Response::error(422, &site::content_problems(&errors)),
    };
    drop(guard);
    let document = match openblog_core::generate_home(&preview_site, &themes) {
        Ok(document) => document,
        Err(error) => return Response::error(422, &error),
    };
    let c = &preview_site.config;
    let theme = match themes.resolve(&c.theme) {
        Ok(theme) => theme.with_look(&submitted),
        Err(error) => return Response::error(422, &error),
    };
    let (notes, refused) = theme
        .look
        .as_ref()
        .map(|compiled| (compiled.notes.clone(), compiled.refused))
        .unwrap_or_default();
    let tokens = c.apply_base_path(&c.cdn.apply(&theme.tokens_css()));
    let mut html = inline_tokens(&document.contents, &c.theme, &tokens);
    if let Some(mode) = mode {
        html = html.replacen("<html", &format!("<html data-theme=\"{mode}\""), 1);
    }
    // Links in a preview lead nowhere: they would only load the live site inside the frame.
    let html = html.replacen(
        "<head>",
        "<head>
<base target=\"_blank\">",
        1,
    );
    let token = match auth::random_token() {
        Ok(token) => token,
        Err(error) => return Response::error(500, &error),
    };
    let csp = preview_csp(c);
    store_preview(state, &token, html, csp);
    Response::json(
        200,
        &json!({
            "previewUrl": format!("/admin/api/preview/{token}"),
            "adjustments": notes,
            "refused": refused,
        }),
    )
}

/// The page with the link to the theme's `tokens.css` replaced by the stylesheet itself, or with the
/// stylesheet added to the head when the page has no such link.
fn inline_tokens(html: &str, theme: &str, css: &str) -> String {
    let style = format!("<style>{}</style>", css.replace("</", r"<\/"));
    let needle = format!("themes/{theme}/tokens.css");
    if let Some(at) = html.find(&needle) {
        if let (Some(start), Some(end)) = (html[..at].rfind("<link"), html[at..].find('>')) {
            let mut out = String::with_capacity(html.len() + style.len());
            out.push_str(&html[..start]);
            out.push_str(&style);
            out.push_str(&html[at + end + 1..]);
            return out;
        }
    }
    html.replacen(
        "</head>",
        &format!(
            "{style}
</head>"
        ),
        1,
    )
}

#[cfg(test)]
mod preview_tests {
    use super::inline_tokens;

    #[test]
    fn the_tokens_link_becomes_the_stylesheet() {
        let html = "<head><link rel=\"stylesheet\" href=\"/themes/base/tokens.css?v=1\"><link href=\"/x.css\"></head>";
        let out = inline_tokens(html, "base", ":root{--a:1}");
        assert_eq!(
            out,
            "<head><style>:root{--a:1}</style><link href=\"/x.css\"></head>"
        );
    }

    #[test]
    fn a_page_without_the_link_gets_the_stylesheet_in_the_head() {
        let out = inline_tokens("<head></head>", "base", "a{}");
        assert_eq!(
            out,
            "<head><style>a{}</style>
</head>"
        );
    }
}
