//! WebAssembly bindings. The browser gets the same Markdown renderer, search,
//! and theme compiler the CLI uses, so what you see in a live preview or the
//! theme playground is exactly what the build produces.
//!
//! Every function takes and returns plain strings (JSON where structured) to
//! keep the JavaScript side trivial and the module free of glue dependencies.

use openblog_core::markdown::{self, RenderOptions};
use openblog_core::search::{self, Index};
use openblog_core::theme::{ThemeFile, ThemeSet};
use wasm_bindgen::prelude::*;

/// Render Markdown to HTML. Returns JSON:
/// `{ "html", "headings": [{level,id,text}], "wordCount", "readingMinutes", "text" }`.
#[wasm_bindgen(js_name = renderMarkdown)]
pub fn render_markdown(source: &str) -> String {
    let rendered = markdown::render(source, RenderOptions::default());
    serde_json::json!({
        "html": rendered.html,
        "headings": rendered.headings,
        "wordCount": rendered.word_count,
        "readingMinutes": markdown::reading_minutes(rendered.word_count),
        "text": rendered.text,
        "errors": rendered.errors,
    })
    .to_string()
}

/// Search a `search.json` payload. Returns a JSON array of hits, best first.
/// Returns `[]` for an empty query and an `{ "error": ... }` object if the index is invalid.
#[wasm_bindgen]
pub fn search(index_json: &str, query: &str, limit: u32) -> String {
    match serde_json::from_str::<Index>(index_json) {
        Ok(index) => {
            let hits = search::query(&index, query, limit.clamp(1, 100) as usize);
            serde_json::to_string(&hits).unwrap_or_else(|_| "[]".into())
        }
        Err(e) => serde_json::json!({ "error": format!("invalid search index: {e}") }).to_string(),
    }
}

/// Compile themes to CSS. `themes_json` is an object mapping theme names to
/// `theme.json` contents; `name` picks the theme to compile. Inheritance via
/// `extends` is resolved. The built-in `base` theme is always available.
/// Returns the CSS, or a string starting with `/* error:` on failure.
#[wasm_bindgen(js_name = themeCss)]
pub fn theme_css(themes_json: &str, name: &str) -> String {
    match compile(themes_json, name) {
        Ok(css) => css,
        Err(e) => format!("/* error: {} */", e.replace("*/", "* /")),
    }
}

fn compile(themes_json: &str, name: &str) -> Result<String, String> {
    let files: std::collections::BTreeMap<String, ThemeFile> =
        serde_json::from_str(themes_json).map_err(|e| format!("invalid themes JSON: {e}"))?;
    let mut set = ThemeSet::new();
    for (theme_name, file) in files {
        set.insert(&theme_name, file);
    }
    Ok(set.resolve(name)?.tokens_css())
}

/// The built-in base theme as JSON, a starting point for new themes.
#[wasm_bindgen(js_name = baseTheme)]
pub fn base_theme() -> String {
    serde_json::to_string_pretty(&ThemeFile::builtin_base()).unwrap_or_default()
}

/// The version of the open.blog engine in this module.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_markdown_returns_json() {
        let v: serde_json::Value = serde_json::from_str(&render_markdown("# Hi\n\ntext")).unwrap();
        assert!(v["html"].as_str().unwrap().contains("<h1 id=\"hi\">"));
        assert_eq!(v["readingMinutes"], 1);
    }

    #[test]
    fn theme_css_compiles_with_extends_and_reports_errors() {
        let css = theme_css(
            r##"{"x":{"extends":"base","colors":{"light":{"accent":"#f00"}}}}"##,
            "x",
        );
        assert!(css.contains("--ob-color-accent: #f00;"));
        assert!(theme_css("{}", "missing").starts_with("/* error:"));
        assert!(theme_css("not json", "base").starts_with("/* error:"));
    }

    #[test]
    fn search_handles_bad_index() {
        assert!(search("nope", "rust", 5).contains("error"));
        assert_eq!(search("{\"version\":1,\"entries\":[]}", "rust", 5), "[]");
    }
}
