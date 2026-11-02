//! The design system: a theme is a JSON file of design tokens that becomes a
//! stylesheet of CSS custom properties, plus optional extra stylesheets and
//! assets. Themes can extend one another, so a child theme only states what differs
//! from `base`. The same renderer output is restyled by swapping tokens.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::look::LookSettings;
use crate::look_css::{self, CompiledLook};

/// The on-disk shape of `themes/<name>/theme.json`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ThemeFile {
    /// Human-readable name shown in theme pickers.
    pub label: String,
    /// Parent theme whose values this theme overrides.
    pub extends: Option<String>,
    /// `"dark"` or `"light"`: the scheme used when the visitor has no preference.
    pub color_scheme: Option<String>,
    /// `colors.dark.accent`, `colors.light.accent`, ... Any key becomes `--ob-color-<kebab-key>`.
    pub colors: BTreeMap<String, BTreeMap<String, String>>,
    pub fonts: Fonts,
    /// Any other token: `maxWidth` becomes `--ob-max-width`.
    pub tokens: BTreeMap<String, String>,
    pub options: ThemeOptions,
    /// Extra stylesheets relative to the theme directory, linked after `base.css`.
    pub stylesheets: Vec<String>,
    /// ES module scripts relative to the theme directory, loaded after `openblog.js`.
    /// This is how a theme ships its own web components.
    pub scripts: Vec<String>,
    /// The look controls this theme honors (`accent`, `palette`, `fontStyle`, `textSize`, `roundness`,
    /// `spacing`, `pageWidth`, `headingWeight`). Omitted inherits the parent's list; `base` honors all.
    /// A theme with bespoke CSS or scripts lists only the controls its own rules leave alone (ADR 0248).
    pub customizable: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Fonts {
    pub body: Option<String>,
    pub heading: Option<String>,
    pub mono: Option<String>,
    /// `@font-face` declarations. `src` is relative to the theme directory.
    pub faces: Vec<FontFace>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FontFace {
    pub family: String,
    pub src: String,
    pub format: Option<String>,
    pub weight: Option<String>,
    pub style: Option<String>,
    pub display: Option<String>,
    pub unicode_range: Option<String>,
}

/// Rendering behaviour a theme can switch on. Everything else is CSS.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ThemeOptions {
    /// Offer a saved light/dark override; false follows the system preference only.
    pub color_scheme_toggle: Option<bool>,
    /// Decorate headings with `<h2>` / `</h2>` code labels, a code-themed look.
    pub heading_code_labels: Option<bool>,
    /// Template for navigation labels, e.g. `//{index}. <{label}/>`.
    pub nav_label: Option<String>,
    /// A custom element name (e.g. `demo-reveal`) to wrap page and section
    /// titles in, so a theme's own script can animate them. Empty disables it.
    pub heading_wrapper: Option<String>,
    /// `"rows"` (compact list) or `"cards"` (cover images).
    pub list_style: Option<String>,
    /// Show cover images on post pages.
    pub post_covers: Option<bool>,
    /// Colour code blocks with the built-in highlighter. Turn off when the
    /// theme ships its own through `scripts`.
    pub code_highlighting: Option<bool>,
    /// Number the lines of code blocks that have more than one line.
    pub code_line_numbers: Option<bool>,
}

/// A fully resolved theme with its inheritance chain flattened.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Theme {
    pub name: String,
    pub label: String,
    /// Theme names from the root ancestor to this theme.
    pub chain: Vec<String>,
    pub color_scheme: String,
    pub color_scheme_toggle: bool,
    pub colors: BTreeMap<String, BTreeMap<String, String>>,
    pub font_body: String,
    pub font_heading: String,
    pub font_mono: String,
    /// Faces with `src` resolved to an absolute site URL.
    pub faces: Vec<FontFace>,
    pub tokens: BTreeMap<String, String>,
    pub heading_code_labels: bool,
    pub nav_label: Option<String>,
    /// Custom element that wraps titles, validated as a custom element name.
    pub heading_wrapper: Option<String>,
    pub list_style: String,
    pub post_covers: bool,
    pub code_highlighting: bool,
    pub code_line_numbers: bool,
    /// Absolute site URLs of extra stylesheets, in link order.
    pub stylesheets: Vec<String>,
    /// Absolute site URLs of theme scripts, in load order.
    pub scripts: Vec<String>,
    /// The look controls honored, in the order of [`crate::look::CONTROLS`].
    pub customizable: Vec<String>,
    /// The owner's look compiled for this theme (ADR 0248); `None` leaves the theme untouched.
    pub look: Option<CompiledLook>,
}

/// A valid custom element name: lowercase ASCII, starts with a letter, and
/// contains a hyphen. Anything else would be an HTML injection vector.
pub fn valid_custom_element_name(name: &str) -> bool {
    name.len() <= 64
        && name.contains('-')
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && name.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.' || c == '_'
        })
}

/// Every theme available to a build, keyed by directory name.
#[derive(Clone, Debug, Default)]
pub struct ThemeSet {
    files: HashMap<String, ThemeFile>,
    resolved: HashMap<String, Theme>,
}

impl ThemeSet {
    pub fn new() -> Self {
        let mut set = Self::default();
        set.insert("base", ThemeFile::builtin_base());
        set
    }

    /// Register a theme file. Registering `base` replaces the built-in default.
    pub fn insert(&mut self, name: &str, file: ThemeFile) {
        self.files.insert(name.to_string(), file);
        self.resolved.clear();
    }

    pub fn contains(&self, name: &str) -> bool {
        self.files.contains_key(name)
    }

    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.files.keys().cloned().collect();
        names.sort();
        names
    }

    pub fn resolve(&self, name: &str) -> Result<Theme, String> {
        if let Some(theme) = self.resolved.get(name) {
            return Ok(theme.clone());
        }
        let mut chain = Vec::new();
        let mut current = Some(name.to_string());
        while let Some(n) = current {
            if chain.contains(&n) {
                return Err(format!(
                    "theme `{n}` extends itself (chain: {})",
                    chain.join(" -> ")
                ));
            }
            let file = self.files.get(&n).ok_or_else(|| {
                if n == name {
                    format!(
                        "theme `{n}` not found (available: {})",
                        self.names().join(", ")
                    )
                } else {
                    format!("theme `{name}` extends unknown theme `{n}`")
                }
            })?;
            chain.push(n.clone());
            current = file.extends.clone();
        }
        chain.reverse();

        let mut theme = Theme {
            name: name.to_string(),
            chain: chain.clone(),
            color_scheme: "dark".into(),
            color_scheme_toggle: true,
            customizable: crate::look::CONTROLS
                .iter()
                .map(|c| c.to_string())
                .collect(),
            list_style: "rows".into(),
            post_covers: true,
            code_highlighting: true,
            code_line_numbers: true,
            ..Theme::default()
        };
        for n in &chain {
            let file = &self.files[n];
            let base_url = format!("/themes/{n}/");
            if !file.label.is_empty() {
                theme.label = file.label.clone();
            }
            if let Some(scheme) = &file.color_scheme {
                theme.color_scheme = scheme.clone();
            }
            for (scheme, colors) in &file.colors {
                let entry = theme.colors.entry(scheme.clone()).or_default();
                for (k, v) in colors {
                    entry.insert(k.clone(), v.clone());
                }
            }
            if let Some(f) = &file.fonts.body {
                theme.font_body = f.clone();
            }
            if let Some(f) = &file.fonts.heading {
                theme.font_heading = f.clone();
            }
            if let Some(f) = &file.fonts.mono {
                theme.font_mono = f.clone();
            }
            for face in &file.fonts.faces {
                let mut face = face.clone();
                face.src = absolutize(&base_url, &face.src);
                theme.faces.push(face);
            }
            for (k, v) in &file.tokens {
                theme.tokens.insert(k.clone(), v.clone());
            }
            if let Some(v) = file.options.heading_code_labels {
                theme.heading_code_labels = v;
            }
            if let Some(v) = file.options.color_scheme_toggle {
                theme.color_scheme_toggle = v;
            }
            if let Some(v) = &file.options.nav_label {
                theme.nav_label = if v.is_empty() { None } else { Some(v.clone()) };
            }
            if let Some(v) = &file.options.heading_wrapper {
                let v = v.trim();
                if v.is_empty() {
                    theme.heading_wrapper = None;
                } else if valid_custom_element_name(v) {
                    theme.heading_wrapper = Some(v.to_string());
                } else {
                    return Err(format!(
                        "theme `{n}`: headingWrapper `{v}` is not a valid custom element name (lowercase, with a hyphen, like `my-effect`)"
                    ));
                }
            }
            if let Some(v) = &file.options.list_style {
                theme.list_style = v.clone();
            }
            if let Some(v) = file.options.post_covers {
                theme.post_covers = v;
            }
            if let Some(v) = file.options.code_highlighting {
                theme.code_highlighting = v;
            }
            if let Some(v) = file.options.code_line_numbers {
                theme.code_line_numbers = v;
            }
            if let Some(list) = &file.customizable {
                for control in list {
                    if !crate::look::CONTROLS.contains(&control.as_str()) {
                        return Err(format!(
                            "theme `{n}`: customizable `{control}` is not a look control (use: {})",
                            crate::look::CONTROLS.join(", ")
                        ));
                    }
                }
                theme.customizable = crate::look::CONTROLS
                    .iter()
                    .filter(|c| list.iter().any(|l| l == *c))
                    .map(|c| c.to_string())
                    .collect();
            }
            for sheet in &file.stylesheets {
                theme.stylesheets.push(absolutize(&base_url, sheet));
            }
            for script in &file.scripts {
                theme.scripts.push(absolutize(&base_url, script));
            }
        }
        if theme.label.is_empty() {
            theme.label = name.to_string();
        }
        if theme.font_heading.is_empty() {
            theme.font_heading = theme.font_body.clone();
        }
        Ok(theme)
    }

    /// Resolve and cache every registered theme, failing on the first error.
    pub fn resolve_all(&mut self) -> Result<(), String> {
        let names = self.names();
        for name in names {
            let theme = self.resolve(&name)?;
            self.resolved.insert(name, theme);
        }
        Ok(())
    }
}

fn absolutize(base_url: &str, rel: &str) -> String {
    if rel.starts_with('/')
        || rel.starts_with("http://")
        || rel.starts_with("https://")
        || rel.starts_with("data:")
    {
        rel.to_string()
    } else {
        format!("{base_url}{rel}")
    }
}

/// `surfaceRaised` -> `surface-raised`, `max_width` -> `max-width`.
pub fn kebab(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for (i, ch) in key.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0 {
                out.push('-');
            }
            out.push(ch.to_ascii_lowercase());
        } else if ch == '_' || ch == ' ' {
            out.push('-');
        } else {
            out.push(ch);
        }
    }
    out
}

impl Theme {
    /// Whether this theme honors a look control.
    pub fn honors(&self, control: &str) -> bool {
        self.customizable.iter().any(|c| c == control)
    }

    pub fn tokens_url(&self) -> String {
        match &self.look {
            Some(look) => format!("/themes/{}/tokens.css?v={}", self.name, look.hash),
            None => format!("/themes/{}/tokens.css", self.name),
        }
    }

    /// This theme with the owner's look compiled over it. A look that changes nothing here returns the
    /// theme unchanged, so its output stays byte-identical.
    pub fn with_look(mut self, look: &LookSettings) -> Theme {
        self.look = look_css::compile(look, &self);
        self
    }

    /// The generated `tokens.css` for this theme.
    pub fn tokens_css(&self) -> String {
        let mut css = String::new();
        css.push_str(
            "/* Generated by open.blog from theme.json. Edit the JSON, not this file. */\n",
        );
        for face in &self.faces {
            css.push_str("@font-face {\n");
            css.push_str(&format!(
                "  font-family: \"{}\";\n",
                face.family.replace('"', "")
            ));
            match &face.format {
                Some(fmt) => css.push_str(&format!(
                    "  src: url(\"{}\") format(\"{}\");\n",
                    face.src, fmt
                )),
                None => css.push_str(&format!("  src: url(\"{}\");\n", face.src)),
            }
            css.push_str(&format!(
                "  font-weight: {};\n",
                face.weight.as_deref().unwrap_or("400")
            ));
            css.push_str(&format!(
                "  font-style: {};\n",
                face.style.as_deref().unwrap_or("normal")
            ));
            css.push_str(&format!(
                "  font-display: {};\n",
                face.display.as_deref().unwrap_or("swap")
            ));
            if let Some(range) = &face.unicode_range {
                css.push_str(&format!("  unicode-range: {range};\n"));
            }
            css.push_str("}\n");
        }

        let default_scheme = if self.color_scheme == "light" {
            "light"
        } else {
            "dark"
        };
        let other_scheme = if default_scheme == "light" {
            "dark"
        } else {
            "light"
        };

        css.push_str(":root {\n");
        css.push_str(&format!("  color-scheme: {default_scheme};\n"));
        css.push_str(&format!("  --ob-font-body: {};\n", self.font_body));
        css.push_str(&format!("  --ob-font-heading: {};\n", self.font_heading));
        css.push_str(&format!("  --ob-font-mono: {};\n", self.font_mono));
        for (k, v) in &self.tokens {
            css.push_str(&format!("  --ob-{}: {};\n", kebab(k), v));
        }
        if let Some(colors) = self.colors.get(default_scheme) {
            push_colors(&mut css, colors, "  ");
        }
        css.push_str("}\n");

        if let Some(colors) = self.colors.get(other_scheme) {
            css.push_str(&format!(
                "@media (prefers-color-scheme: {other_scheme}) {{\n"
            ));
            css.push_str(&format!(
                "  :root:not([data-theme=\"{default_scheme}\"]) {{\n"
            ));
            css.push_str(&format!("    color-scheme: {other_scheme};\n"));
            push_colors(&mut css, colors, "    ");
            css.push_str("  }\n}\n");
            css.push_str(&format!(":root[data-theme=\"{other_scheme}\"] {{\n"));
            css.push_str(&format!("  color-scheme: {other_scheme};\n"));
            push_colors(&mut css, colors, "  ");
            css.push_str("}\n");
        }
        // Paper is white: print with the light palette whatever the screen uses.
        // This comes last, so it wins over the dark rules of equal specificity.
        if let Some(colors) = self.colors.get("light") {
            css.push_str(
                "@media print {\n  :root,\n  :root[data-theme] {\n    color-scheme: light;\n",
            );
            push_colors(&mut css, colors, "    ");
            css.push_str("  }\n}\n");
        }
        // The owner's look comes last so it layers over the theme and its print rule (ADR 0248).
        if let Some(look) = &self.look {
            css.push_str(&look.css);
        }
        css
    }

    /// Theme metadata for the browser (`/themes/<name>/theme.json` is also
    /// copied verbatim, but this is the resolved view).
    pub fn manifest_json(&self) -> String {
        serde_json::json!({
            "name": self.name,
            "label": self.label,
            "chain": self.chain,
            "colorScheme": self.color_scheme,
            "colors": self.colors,
            "fonts": { "body": self.font_body, "heading": self.font_heading, "mono": self.font_mono },
            "tokens": self.tokens,
            "options": {
                "colorSchemeToggle": self.color_scheme_toggle,
                "headingCodeLabels": self.heading_code_labels,
                "navLabel": self.nav_label,
                "headingWrapper": self.heading_wrapper,
                "listStyle": self.list_style,
                "postCovers": self.post_covers,
                "codeHighlighting": self.code_highlighting,
                "codeLineNumbers": self.code_line_numbers,
            },
            "stylesheets": self.stylesheets,
            "scripts": self.scripts,
        })
        .to_string()
    }
}

fn push_colors(css: &mut String, colors: &BTreeMap<String, String>, indent: &str) {
    for (k, v) in colors {
        css.push_str(&format!("{indent}--ob-color-{}: {};\n", kebab(k), v));
    }
}

impl ThemeFile {
    /// The neutral default theme. Every token the base stylesheet uses is defined here,
    /// so a custom theme only needs to override what it changes.
    pub fn builtin_base() -> Self {
        let json = include_str!("../../../themes/base/theme.json");
        serde_json::from_str(json).expect("themes/base/theme.json is valid")
    }

    pub fn from_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("invalid theme.json: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_theme_resolves_and_emits_tokens() {
        let set = ThemeSet::new();
        let theme = set.resolve("base").unwrap();
        let css = theme.tokens_css();
        assert!(css.contains("--ob-color-accent:"));
        assert!(css.contains("--ob-font-body:"));
        assert!(css.contains("@media (prefers-color-scheme:"));
        assert_eq!(theme.chain, vec!["base"]);
        assert!(theme.color_scheme_toggle);
    }

    #[test]
    fn color_scheme_toggle_can_be_disabled_inherited_and_reenabled() {
        let mut set = ThemeSet::new();
        for (name, json) in [
            (
                "system",
                r#"{"extends":"base","options":{"colorSchemeToggle":false}}"#,
            ),
            ("child", r#"{"extends":"system"}"#),
            (
                "override",
                r#"{"extends":"system","options":{"colorSchemeToggle":true}}"#,
            ),
        ] {
            set.insert(name, ThemeFile::from_json(json).unwrap());
        }
        for name in ["system", "child"] {
            let theme = set.resolve(name).unwrap();
            assert!(!theme.color_scheme_toggle);
            let manifest: serde_json::Value = serde_json::from_str(&theme.manifest_json()).unwrap();
            assert_eq!(manifest["options"]["colorSchemeToggle"], false);
            assert!(theme.tokens_css().contains("@media (prefers-color-scheme:"));
        }
        assert!(set.resolve("override").unwrap().color_scheme_toggle);
    }

    #[test]
    fn child_overrides_and_inherits() {
        let mut set = ThemeSet::new();
        let child = ThemeFile::from_json(
            r##"{"extends":"base","label":"Kid","colors":{"dark":{"accent":"#e3de13"}},"stylesheets":["theme.css"],"scripts":["fx.js"],"options":{"headingCodeLabels":true,"headingWrapper":"kid-fx"},"fonts":{"faces":[{"family":"X","src":"fonts/x.woff2"}]}}"##,
        )
        .unwrap();
        set.insert("kid", child);
        let theme = set.resolve("kid").unwrap();
        assert_eq!(theme.chain, vec!["base", "kid"]);
        assert_eq!(theme.colors["dark"]["accent"], "#e3de13");
        assert!(theme.colors["dark"].contains_key("text"));
        assert!(theme.heading_code_labels);
        assert_eq!(theme.stylesheets, vec!["/themes/kid/theme.css"]);
        assert_eq!(theme.scripts, vec!["/themes/kid/fx.js"]);
        assert_eq!(theme.heading_wrapper.as_deref(), Some("kid-fx"));
        let grandchild =
            ThemeFile::from_json(r#"{"extends":"kid","options":{"headingWrapper":""}}"#).unwrap();
        set.insert("grandkid", grandchild);
        let theme = set.resolve("grandkid").unwrap();
        assert_eq!(
            theme.heading_wrapper, None,
            "an empty wrapper switches the parent's off"
        );
        assert_eq!(
            theme.scripts,
            vec!["/themes/kid/fx.js"],
            "parent scripts are inherited"
        );
        for bad in ["noHyphen", "Upper-Case", "<x-y>", "x-y onclick=", "-x"] {
            set.insert(
                "bad",
                ThemeFile::from_json(&format!(r#"{{"options":{{"headingWrapper":"{bad}"}}}}"#))
                    .unwrap(),
            );
            assert!(
                set.resolve("bad")
                    .unwrap_err()
                    .contains("not a valid custom element name"),
                "{bad}"
            );
        }
        assert_eq!(theme.faces[0].src, "/themes/kid/fonts/x.woff2");
        assert!(theme.tokens_css().contains("--ob-color-accent: #e3de13;"));
    }

    #[test]
    fn detects_cycles_and_missing_parents() {
        let mut set = ThemeSet::new();
        set.insert(
            "a",
            ThemeFile {
                extends: Some("b".into()),
                ..Default::default()
            },
        );
        set.insert(
            "b",
            ThemeFile {
                extends: Some("a".into()),
                ..Default::default()
            },
        );
        assert!(set.resolve("a").unwrap_err().contains("extends itself"));
        set.insert(
            "c",
            ThemeFile {
                extends: Some("nope".into()),
                ..Default::default()
            },
        );
        assert!(set.resolve("c").unwrap_err().contains("unknown theme"));
        assert_eq!(kebab("surfaceRaised"), "surface-raised");
    }

    #[test]
    fn customizable_defaults_to_all_inherits_and_rejects_unknown_controls() {
        let mut set = ThemeSet::new();
        let all: Vec<String> = crate::look::CONTROLS
            .iter()
            .map(|c| c.to_string())
            .collect();
        assert_eq!(set.resolve("base").unwrap().customizable, all);
        set.insert(
            "plain",
            ThemeFile::from_json(r#"{"extends":"base","customizable":["roundness","accent"]}"#)
                .unwrap(),
        );
        set.insert(
            "child",
            ThemeFile::from_json(r#"{"extends":"plain"}"#).unwrap(),
        );
        set.insert(
            "reset",
            ThemeFile::from_json(r#"{"extends":"plain","customizable":[]}"#).unwrap(),
        );
        set.insert(
            "lax",
            ThemeFile::from_json(r#"{"extends":"base"}"#).unwrap(),
        );
        let plain = set.resolve("plain").unwrap();
        // Canonical order, whatever order the theme wrote.
        assert_eq!(plain.customizable, ["accent", "roundness"]);
        assert!(plain.honors("accent") && !plain.honors("fontStyle"));
        assert_eq!(
            set.resolve("child").unwrap().customizable,
            plain.customizable
        );
        assert!(set.resolve("reset").unwrap().customizable.is_empty());
        assert_eq!(set.resolve("lax").unwrap().customizable, all);
        set.insert(
            "bad",
            ThemeFile::from_json(r#"{"extends":"base","customizable":["css"]}"#).unwrap(),
        );
        let error = set.resolve("bad").unwrap_err();
        assert!(error.contains("`css` is not a look control"), "{error}");
        // The resolved manifest is unchanged for existing sites.
        assert!(!set
            .resolve("plain")
            .unwrap()
            .manifest_json()
            .contains("customizable"));
    }

    #[test]
    fn a_look_only_changes_what_the_theme_honors() {
        let mut set = ThemeSet::new();
        set.insert(
            "plain",
            ThemeFile::from_json(r#"{"extends":"base","customizable":["roundness"]}"#).unwrap(),
        );
        let look = crate::look::LookSettings::from_value(&serde_json::json!({
            "roundness": "square", "textSize": "large", "accent": "#aa3300", "pageWidth": "wide"
        }))
        .unwrap();
        let theme = set.resolve("plain").unwrap().with_look(&look);
        let css = theme.look.as_ref().unwrap().css.clone();
        assert!(css.contains("--ob-radius: 0;"));
        assert!(!css.contains("--ob-text-scale") && !css.contains("--ob-color-accent"));
        assert!(!css.contains("--ob-max-width"));
        // Nothing honored, nothing compiled.
        set.insert(
            "locked",
            ThemeFile::from_json(r#"{"extends":"base","customizable":[]}"#).unwrap(),
        );
        let locked = set.resolve("locked").unwrap().with_look(&look);
        assert!(locked.look.is_none());
        assert_eq!(locked.tokens_url(), "/themes/locked/tokens.css");
    }

    /// Every bundled theme declares or inherits an accurate list: each control it honors really is
    /// compiled for it, each it does not honor is not, and no honored control's tokens are overridden by
    /// the theme's own stylesheet (which would load after, and silently defeat, the owner's choice).
    #[test]
    fn bundled_themes_honor_exactly_what_they_declare() {
        let themes_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../themes");
        let mut set = ThemeSet::new();
        let mut names = Vec::new();
        for entry in std::fs::read_dir(&themes_dir).unwrap() {
            let dir = entry.unwrap().path();
            let json = dir.join("theme.json");
            if json.exists() {
                let name = dir.file_name().unwrap().to_string_lossy().to_string();
                let file = ThemeFile::from_json(&std::fs::read_to_string(&json).unwrap()).unwrap();
                set.insert(&name, file);
                names.push((name, dir));
            }
        }
        assert!(names.len() >= 3);
        let everything = crate::look::LookSettings::from_value(&serde_json::json!({
            "accent": "#aa3300", "palette": "calm", "fontStyle": "classic-serif",
            "textSize": "large", "roundness": "round", "spacing": "airy",
            "pageWidth": "wide", "headingWeight": "normal"
        }))
        .unwrap();
        let properties = |control: &str| -> &'static [&'static str] {
            match control {
                "accent" => &["--ob-color-accent", "--ob-color-link"],
                "palette" => &["--ob-color-page", "--ob-color-surface", "--ob-color-text"],
                "fontStyle" => &["--ob-font-body", "--ob-font-heading"],
                "textSize" => &["--ob-text-scale", "--ob-body-size"],
                "roundness" => &["--ob-radius", "--ob-radius-sm"],
                "spacing" => &[
                    "--ob-space-4",
                    "--ob-space-5",
                    "--ob-space-6",
                    "--ob-space-8",
                ],
                "pageWidth" => &["--ob-max-width", "--ob-reading-width"],
                _ => &["--ob-heading-weight"],
            }
        };
        for (name, dir) in names {
            let theme = set.resolve(&name).unwrap();
            let compiled = theme.clone().with_look(&everything);
            let css = compiled.look.as_ref().map(|l| l.css.as_str()).unwrap_or("");
            for control in crate::look::CONTROLS {
                let first = properties(control)[0];
                assert_eq!(
                    css.contains(&format!("{first}:")),
                    theme.honors(control),
                    "{name}: {control}"
                );
                if theme.honors(control) {
                    for sheet in &theme.stylesheets {
                        let path = dir.join(sheet.rsplit('/').next().unwrap());
                        let text = std::fs::read_to_string(path).unwrap_or_default();
                        for property in properties(control) {
                            assert!(
                                !text.contains(&format!("{property}:")),
                                "{name}: {sheet} overrides {property} but declares {control}"
                            );
                        }
                    }
                }
            }
        }
    }
}
