//! Compile a validated [`LookSettings`] into an override block of allowlisted `--ob-*` tokens
//! (ADR 0248).
//!
//! Safety comes from construction, not escaping: property names come from fixed tables, every value is
//! either a table constant or formatted from typed data (a number, or a `#rrggbb` built from three
//! bytes). No string from the settings is ever copied into the output. The block is appended to a
//! theme's `tokens.css`, so it layers over whichever theme a page uses.

use blake2::{Blake2s256, Digest};

use crate::look::{
    FontStyle, HeadingWeight, LookSettings, PageWidth, Roundness, Spacing, TextSize,
};
use crate::look_contrast::{derive_accent, Ground, Rgb, Shift, HIGH, TEXT};
use crate::look_presets::{self, CuratedLook};
use crate::theme::Theme;

/// The generated override block and its content hash.
#[derive(Clone, Debug, PartialEq)]
pub struct CompiledLook {
    pub css: String,
    /// 16 hex characters of the BLAKE2s digest of `css`, used to bust caches.
    pub hash: String,
    /// One plain sentence per adjustment made so the look stays readable.
    pub notes: Vec<String>,
    /// True when an accent could not be made readable in some scheme and was left out there.
    pub refused: bool,
}

/// Every custom property the look is allowed to write. Anything else is a bug.
pub const ALLOWED_PROPERTIES: &[&str] = &[
    "--ob-font-body",
    "--ob-font-heading",
    "--ob-text-scale",
    "--ob-radius",
    "--ob-radius-sm",
    "--ob-space-4",
    "--ob-space-5",
    "--ob-space-6",
    "--ob-space-8",
    "--ob-max-width",
    "--ob-reading-width",
    "--ob-heading-weight",
    "--ob-color-accent",
    "--ob-color-accent-soft",
    "--ob-color-accent-border",
    "--ob-color-accent-contrast",
    "--ob-color-link",
    "--ob-color-glow",
    "--ob-hover-text",
    "--ob-hover-ink",
    "--ob-color-page",
    "--ob-color-outer",
    "--ob-color-surface",
    "--ob-color-surface-raised",
    "--ob-color-text",
    "--ob-color-muted",
    "--ob-color-subtle",
    "--ob-color-border",
];

pub(crate) fn font_stack(style: FontStyle) -> &'static str {
    match style {
        FontStyle::ModernSans => {
            "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
        }
        FontStyle::ClassicSerif => {
            "Georgia, \"Iowan Old Style\", \"Palatino Linotype\", \"Times New Roman\", serif"
        }
        FontStyle::FriendlyRounded => {
            "ui-rounded, \"SF Pro Rounded\", \"Hiragino Maru Gothic ProN\", Quicksand, Nunito, \"Varela Round\", system-ui, sans-serif"
        }
        FontStyle::TechieMono => {
            "ui-monospace, SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace"
        }
    }
}

fn text_scale(size: TextSize) -> &'static str {
    match size {
        TextSize::Small => "0.9375",
        TextSize::Medium => "1",
        TextSize::Large => "1.125",
        TextSize::ExtraLarge => "1.25",
    }
}

fn radius(roundness: Roundness) -> (&'static str, &'static str) {
    match roundness {
        Roundness::Square => ("0", "0"),
        Roundness::Soft => ("8px", "4px"),
        Roundness::Round => ("20px", "10px"),
    }
}

/// `--ob-space-4`, `-5`, `-6` and `-8`.
fn spacing(spacing: Spacing) -> [&'static str; 4] {
    match spacing {
        Spacing::Compact => ["0.75rem", "1.125rem", "1.25rem", "1.5rem"],
        Spacing::Comfortable => ["1rem", "1.5rem", "1.75rem", "2rem"],
        Spacing::Airy => ["1.25rem", "1.875rem", "2.25rem", "3rem"],
    }
}

fn page_width(width: PageWidth) -> (&'static str, &'static str) {
    match width {
        PageWidth::Narrow => ("56rem", "36rem"),
        PageWidth::Medium => ("70rem", "46rem"),
        PageWidth::Wide => ("84rem", "56rem"),
    }
}

fn heading_weight(weight: HeadingWeight) -> &'static str {
    match weight {
        HeadingWeight::Normal => "400",
        HeadingWeight::Bold => "700",
    }
}

/// The color custom properties a look may write, in output order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ColorToken {
    Page,
    Outer,
    Surface,
    SurfaceRaised,
    Text,
    Muted,
    Subtle,
    Border,
    Accent,
    AccentSoft,
    AccentBorder,
    AccentContrast,
    Link,
    Glow,
    HoverText,
    HoverInk,
}

impl ColorToken {
    pub fn property(self) -> &'static str {
        match self {
            ColorToken::Page => "--ob-color-page",
            ColorToken::Outer => "--ob-color-outer",
            ColorToken::Surface => "--ob-color-surface",
            ColorToken::SurfaceRaised => "--ob-color-surface-raised",
            ColorToken::Text => "--ob-color-text",
            ColorToken::Muted => "--ob-color-muted",
            ColorToken::Subtle => "--ob-color-subtle",
            ColorToken::Border => "--ob-color-border",
            ColorToken::Accent => "--ob-color-accent",
            ColorToken::AccentSoft => "--ob-color-accent-soft",
            ColorToken::AccentBorder => "--ob-color-accent-border",
            ColorToken::AccentContrast => "--ob-color-accent-contrast",
            ColorToken::Link => "--ob-color-link",
            ColorToken::Glow => "--ob-color-glow",
            ColorToken::HoverText => "--ob-hover-text",
            ColorToken::HoverInk => "--ob-hover-ink",
        }
    }
}

/// What one scheme's colors came to: the declarations, how the accent moved, and whether it was refused.
struct SchemeColors {
    colors: Vec<(ColorToken, String)>,
    shift: Shift,
    refused: bool,
}

impl SchemeColors {
    fn none() -> SchemeColors {
        SchemeColors {
            colors: Vec::new(),
            shift: Shift::Unchanged,
            refused: false,
        }
    }
}

/// The curated palette the look chose, if the theme honors palettes.
fn palette_of(look: &LookSettings, theme: &Theme) -> Option<&'static CuratedLook> {
    look.palette
        .as_deref()
        .filter(|_| theme.honors("palette"))
        .and_then(look_presets::find)
}

/// The page and surface colors an accent has to be readable against: the chosen palette's, or the
/// theme's own with the base theme's colors as the fallback for anything that is not a plain hex value.
fn ground(theme: &Theme, scheme: &str, palette: Option<&CuratedLook>) -> Ground {
    let (page, surface, raised, text, ink) = if scheme == "light" {
        ("#ffffff", "#ffffff", "#f1f3f6", "#14171c", "#0b0d11")
    } else {
        ("#0f1217", "#161a21", "#1d222b", "#eceff4", "#0b0d11")
    };
    let read = |key: &str, fallback: &str| {
        theme
            .colors
            .get(scheme)
            .and_then(|colors| colors.get(key))
            .and_then(|value| Rgb::parse(value))
            .or_else(|| Rgb::parse(fallback))
            .unwrap_or(Rgb(0, 0, 0))
    };
    let from_palette = |hex: &str| Rgb::parse(hex).unwrap_or(Rgb(0, 0, 0));
    match palette.map(|p| p.scheme(scheme)) {
        Some(p) => Ground {
            page: from_palette(p.page),
            surface: from_palette(p.surface),
            surface_raised: Some(from_palette(p.surface_raised)),
            text: from_palette(p.text),
            ink: read("ink", ink),
        },
        None => Ground {
            page: read("page", page),
            surface: read("surface", surface),
            surface_raised: Some(read("surfaceRaised", raised)),
            text: read("text", text),
            ink: read("ink", ink),
        },
    }
}

/// The colors a look sets for one scheme at a contrast target.
fn scheme_colors(look: &LookSettings, theme: &Theme, scheme: &str, target: f64) -> SchemeColors {
    let mut out = SchemeColors::none();
    let palette = palette_of(look, theme);
    if let Some(palette) = palette {
        let p = palette.scheme(scheme);
        out.colors = vec![
            (ColorToken::Page, p.page.to_string()),
            (ColorToken::Outer, p.outer.to_string()),
            (ColorToken::Surface, p.surface.to_string()),
            (ColorToken::SurfaceRaised, p.surface_raised.to_string()),
            (ColorToken::Text, p.text.to_string()),
            (ColorToken::Muted, p.muted.to_string()),
            (ColorToken::Subtle, p.subtle.to_string()),
            (ColorToken::Border, p.border.to_string()),
        ];
    }
    // An accent the owner picked wins over the palette's own.
    let chosen = look.accent.as_deref().filter(|_| theme.honors("accent"));
    let accent = chosen
        .or_else(|| palette.map(|p| p.scheme(scheme).accent))
        .and_then(Rgb::parse);
    let Some(accent) = accent else {
        return out;
    };
    match derive_accent(accent, &ground(theme, scheme, palette), target) {
        Some(set) => {
            out.shift = set.shift;
            let accent = set.accent.hex();
            let on_accent = set.accent_contrast.hex();
            out.colors.extend([
                (ColorToken::Accent, accent.clone()),
                (ColorToken::AccentSoft, accent.clone()),
                (ColorToken::AccentBorder, set.accent_border.hex()),
                (ColorToken::AccentContrast, on_accent.clone()),
                (ColorToken::Link, accent),
                (ColorToken::Glow, set.glow.hex()),
                (ColorToken::HoverText, on_accent.clone()),
                (ColorToken::HoverInk, on_accent),
            ]);
        }
        None => out.refused = true,
    }
    out
}

fn push_decls(css: &mut String, indent: &str, decls: &[(&'static str, String)]) {
    for (property, value) in decls {
        css.push_str(&format!("{indent}{property}: {value};\n"));
    }
}

fn push_colors(css: &mut String, indent: &str, colors: &[(ColorToken, String)]) {
    for (token, value) in colors {
        css.push_str(&format!("{indent}{}: {value};\n", token.property()));
    }
}

/// Compile the override block for one resolved theme. `None` when the look changes nothing for this
/// theme, so the theme's stylesheet is untouched.
pub fn compile(look: &LookSettings, theme: &Theme) -> Option<CompiledLook> {
    let mut plain: Vec<(&'static str, String)> = Vec::new();
    if theme.honors("fontStyle") {
        if let Some(style) = look.font_style {
            plain.push(("--ob-font-body", font_stack(style).to_string()));
            plain.push(("--ob-font-heading", font_stack(style).to_string()));
        }
    }
    if theme.honors("textSize") {
        if let Some(size) = look.text_size {
            plain.push(("--ob-text-scale", text_scale(size).to_string()));
        }
    }
    if theme.honors("roundness") {
        if let Some(round) = look.roundness {
            let (radius, small) = radius(round);
            plain.push(("--ob-radius", radius.to_string()));
            plain.push(("--ob-radius-sm", small.to_string()));
        }
    }
    if theme.honors("spacing") {
        if let Some(space) = look.spacing {
            let values = spacing(space);
            for (property, value) in [
                "--ob-space-4",
                "--ob-space-5",
                "--ob-space-6",
                "--ob-space-8",
            ]
            .into_iter()
            .zip(values)
            {
                plain.push((property, value.to_string()));
            }
        }
    }
    if theme.honors("pageWidth") {
        if let Some(width) = look.page_width {
            let (max, reading) = page_width(width);
            plain.push(("--ob-max-width", max.to_string()));
            plain.push(("--ob-reading-width", reading.to_string()));
        }
    }
    if theme.honors("headingWeight") {
        if let Some(weight) = look.heading_weight {
            plain.push(("--ob-heading-weight", heading_weight(weight).to_string()));
        }
    }

    let default_scheme = if theme.color_scheme == "light" {
        "light"
    } else {
        "dark"
    };
    let other_scheme = if default_scheme == "light" {
        "dark"
    } else {
        "light"
    };
    let present = |name: &str| theme.colors.contains_key(name);
    let standard = |name: &str| {
        if present(name) {
            scheme_colors(look, theme, name, TEXT)
        } else {
            SchemeColors::none()
        }
    };
    // Higher contrast is only worth a second block where it differs from the standard one.
    let more = |name: &str, standard: &SchemeColors| {
        if !present(name) || standard.refused || standard.colors.is_empty() {
            return Vec::new();
        }
        let high = scheme_colors(look, theme, name, HIGH);
        if high.refused || high.colors == standard.colors {
            Vec::new()
        } else {
            high.colors
        }
    };
    let default_std = standard(default_scheme);
    let other_std = standard(other_scheme);
    let default_more = more(default_scheme, &default_std);
    let other_more = more(other_scheme, &other_std);
    let light_colors = if default_scheme == "light" {
        &default_std.colors
    } else {
        &other_std.colors
    };

    let mut notes = Vec::new();
    for (name, result) in [(default_scheme, &default_std), (other_scheme, &other_std)] {
        let mode = if name == "light" { "light" } else { "dark" };
        match result.shift {
            Shift::Unchanged => {}
            Shift::Darker => notes.push(format!(
                "Your accent color was made a little darker in {mode} mode so text stays easy to read."
            )),
            Shift::Lighter => notes.push(format!(
                "Your accent color was made a little lighter in {mode} mode so text stays easy to read."
            )),
        }
        if result.refused {
            notes.push(format!(
                "Your accent color cannot be made easy to read in {mode} mode on this theme, so it was not used there. Try a deeper or a lighter color."
            ));
        }
    }

    if plain.is_empty() && default_std.colors.is_empty() && other_std.colors.is_empty() {
        return None;
    }

    let mut css = String::from(
        "/* Look: generated by open.blog from the owner's appearance settings. Do not edit. */\n",
    );
    if !plain.is_empty() || !default_std.colors.is_empty() {
        css.push_str(":root {\n");
        push_decls(&mut css, "  ", &plain);
        push_colors(&mut css, "  ", &default_std.colors);
        css.push_str("}\n");
    }
    if !other_std.colors.is_empty() {
        css.push_str(&format!(
            "@media (prefers-color-scheme: {other_scheme}) {{\n  :root:not([data-theme=\"{default_scheme}\"]) {{\n"
        ));
        push_colors(&mut css, "    ", &other_std.colors);
        css.push_str("  }\n}\n");
        css.push_str(&format!(":root[data-theme=\"{other_scheme}\"] {{\n"));
        push_colors(&mut css, "  ", &other_std.colors);
        css.push_str("}\n");
    }
    // People who ask for more contrast get a stricter accent. The selectors repeat the ones above, in
    // the same order, so each scheme's rule still wins over the other's.
    if !default_more.is_empty() || !other_more.is_empty() {
        css.push_str("@media (prefers-contrast: more) {\n");
        if !default_more.is_empty() {
            css.push_str("  :root {\n");
            push_colors(&mut css, "    ", &default_more);
            css.push_str("  }\n");
        }
        if !other_more.is_empty() {
            css.push_str(&format!(
                "  @media (prefers-color-scheme: {other_scheme}) {{\n    :root:not([data-theme=\"{default_scheme}\"]) {{\n"
            ));
            push_colors(&mut css, "      ", &other_more);
            css.push_str("    }\n  }\n");
            css.push_str(&format!("  :root[data-theme=\"{other_scheme}\"] {{\n"));
            push_colors(&mut css, "    ", &other_more);
            css.push_str("  }\n");
        }
        css.push_str("}\n");
    }
    // Paper is white, so print last, with the light accent, as the theme's own print rule does.
    if !light_colors.is_empty() {
        css.push_str("@media print {\n  :root,\n  :root[data-theme] {\n");
        push_colors(&mut css, "    ", light_colors);
        css.push_str("  }\n}\n");
    }
    let digest = Blake2s256::digest(css.as_bytes());
    let hash: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Some(CompiledLook {
        css,
        hash,
        notes,
        refused: default_std.refused || other_std.refused,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::look_contrast::contrast;
    use crate::theme::ThemeSet;
    use serde_json::{json, Value};

    fn base() -> Theme {
        ThemeSet::new().resolve("base").unwrap()
    }

    fn look(value: Value) -> LookSettings {
        LookSettings::from_value(&value).unwrap()
    }

    /// Every declaration in a compiled block, as `(property, value)`.
    fn declarations(css: &str) -> Vec<(String, String)> {
        css.lines()
            .filter_map(|line| line.trim().strip_suffix(';'))
            .filter_map(|line| line.split_once(": "))
            .map(|(p, v)| (p.to_string(), v.to_string()))
            .collect()
    }

    const HEADER: &str =
        "/* Look: generated by open.blog from the owner's appearance settings. Do not edit. */";

    /// The whole block is made of the header, fixed selectors, and allowlisted declarations whose
    /// values come from fixed tables or are a formatted number or color.
    fn assert_confined(css: &str) {
        for line in css.lines() {
            let t = line.trim();
            if t.is_empty() || t == "}" || t == HEADER {
                continue;
            }
            if t.ends_with('{') || t == ":root," {
                let fixed = [
                    ":root {",
                    "@media print {",
                    "@media (prefers-contrast: more) {",
                    ":root,",
                    ":root[data-theme] {",
                    "@media (prefers-color-scheme: light) {",
                    "@media (prefers-color-scheme: dark) {",
                    ":root[data-theme=\"light\"] {",
                    ":root[data-theme=\"dark\"] {",
                    ":root:not([data-theme=\"light\"]) {",
                    ":root:not([data-theme=\"dark\"]) {",
                ];
                assert!(fixed.contains(&t), "unexpected selector {t:?}");
                continue;
            }
            let decl = t
                .strip_suffix(';')
                .unwrap_or_else(|| panic!("bad line {t:?}"));
            let (property, value) = decl.split_once(": ").unwrap();
            assert!(
                ALLOWED_PROPERTIES.contains(&property),
                "property {property}"
            );
            let hex = value.len() == 7
                && value.starts_with('#')
                && value[1..].bytes().all(|b| b.is_ascii_hexdigit());
            let number = value.bytes().all(|b| b.is_ascii_digit() || b == b'.');
            let length = ["rem", "px"].iter().any(|u| {
                value
                    .strip_suffix(u)
                    .is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit() || b == b'.'))
            });
            let stack = FontStyle::ALL.iter().any(|s| font_stack(*s) == value);
            assert!(
                hex || number || length || stack,
                "value {value:?} for {property} is not from a fixed table"
            );
        }
    }

    #[test]
    fn no_look_adds_nothing() {
        assert!(compile(&LookSettings::default(), &base()).is_none());
        assert!(compile(&look(json!({"futureKnob": 1})), &base()).is_none());
        let plain = base();
        let with = plain.clone().with_look(&LookSettings::default());
        assert_eq!(with.tokens_css(), plain.tokens_css());
        assert_eq!(with.tokens_url(), plain.tokens_url());
    }

    #[test]
    fn plain_controls_compile_to_fixed_values() {
        let compiled = compile(
            &look(json!({
                "fontStyle": "classic-serif", "textSize": "large", "roundness": "round",
                "spacing": "airy", "pageWidth": "wide", "headingWeight": "normal"
            })),
            &base(),
        )
        .unwrap();
        let got = declarations(&compiled.css);
        let get = |p: &str| got.iter().find(|(k, _)| k == p).map(|(_, v)| v.as_str());
        assert_eq!(get("--ob-text-scale"), Some("1.125"));
        assert_eq!(get("--ob-radius"), Some("20px"));
        assert_eq!(get("--ob-space-8"), Some("3rem"));
        assert_eq!(get("--ob-max-width"), Some("84rem"));
        assert_eq!(get("--ob-reading-width"), Some("56rem"));
        assert_eq!(get("--ob-heading-weight"), Some("400"));
        assert!(get("--ob-font-body").unwrap().starts_with("Georgia"));
        assert_confined(&compiled.css);
        // Plain controls leave colors alone.
        assert!(!compiled.css.contains("--ob-color"));
    }

    #[test]
    fn golden_accent_block() {
        let chosen = look(json!({"accent": "#B5451B", "textSize": "small"}));
        let compiled = compile(&chosen, &base()).unwrap();
        assert!(compiled.css.starts_with(HEADER));
        assert!(compiled
            .css
            .contains(":root {\n  --ob-text-scale: 0.9375;\n"));
        assert!(compiled.css.contains("--ob-color-accent: "));
        assert!(compiled.css.contains(":root[data-theme=\"dark\"] {\n"));
        assert!(compiled.css.contains("@media print {\n"));
        assert_confined(&compiled.css);
        // Deterministic, and the hash follows the content.
        let again = compile(
            &look(json!({"accent": "#b5451b", "textSize": "small"})),
            &base(),
        );
        assert_eq!(Some(&compiled), again.as_ref());
        assert_eq!(compiled.hash.len(), 16);
        let other = compile(
            &look(json!({"accent": "#b5451c", "textSize": "small"})),
            &base(),
        )
        .unwrap();
        assert_ne!(compiled.hash, other.hash);
    }

    #[test]
    fn the_look_follows_the_theme_tokens_and_busts_the_cache() {
        let plain = base();
        let styled = plain
            .clone()
            .with_look(&look(json!({"roundness": "square"})));
        assert!(styled.tokens_css().starts_with(&plain.tokens_css()));
        assert!(styled.tokens_css().len() > plain.tokens_css().len());
        assert!(styled
            .tokens_url()
            .starts_with("/themes/base/tokens.css?v="));
        assert_ne!(styled.tokens_url(), plain.tokens_url());
    }

    /// A small deterministic generator, so the fuzz test needs no dependency and never flakes.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
            &items[(self.next() % items.len() as u64) as usize]
        }
    }

    #[test]
    fn arbitrary_settings_never_produce_output_outside_the_allowlist() {
        let hostile = [
            "#fff;}*{display:none}",
            "</style><script>alert(1)</script>",
            "url(https://evil.test/x)",
            "expression(alert(1))",
            "x; background: red; y",
            "\\0000",
            "#12345",
            "calm",
            "round",
            "extra-large",
            "#ABCDEF",
            "#0a0",
        ];
        let keys = [
            "accent",
            "palette",
            "fontStyle",
            "textSize",
            "roundness",
            "spacing",
            "pageWidth",
            "headingWeight",
            "version",
            "mystery",
            "--ob-radius",
            "}{",
        ];
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let theme = base();
        let mut compiled_any = 0;
        for _ in 0..3000 {
            let mut object = serde_json::Map::new();
            for _ in 0..(rng.next() % 7) {
                let key = *rng.pick(&keys);
                let valid: &[&str] = match key {
                    "accent" => &["#ABCDEF", "#0a0", "#102030", "#fafafa"],
                    "palette" => &["calm", "night", "theme"],
                    "fontStyle" => &["classic-serif", "techie-mono", "theme"],
                    "textSize" => &["small", "extra-large"],
                    "roundness" => &["square", "round"],
                    "spacing" => &["compact", "airy"],
                    "pageWidth" => &["narrow", "wide"],
                    "headingWeight" => &["normal", "bold"],
                    _ => &["x"],
                };
                let value = match rng.next() % 6 {
                    0 => json!(rng.next() % 5),
                    1 => json!(null),
                    2 => json!([rng.pick(&hostile)]),
                    3 => json!(rng.pick(&hostile)),
                    _ => json!(rng.pick(valid)),
                };
                object.insert(key.to_string(), value);
            }
            let Ok(settings) = LookSettings::from_value(&Value::Object(object)) else {
                continue;
            };
            if let Some(compiled) = compile(&settings, &theme) {
                compiled_any += 1;
                assert_confined(&compiled.css);
                assert!(!compiled.css.contains("evil") && !compiled.css.contains("script"));
            }
        }
        assert!(compiled_any > 20, "the generator should reach the compiler");
    }

    /// The colors a block sets inside one selector group, read back from the generated CSS.
    fn block<'a>(css: &'a str, opener: &str) -> &'a str {
        let start = css.find(opener).unwrap_or_else(|| panic!("no {opener}")) + opener.len();
        let end = css[start..].find('}').unwrap() + start;
        &css[start..end]
    }

    fn color_in(block: &str, property: &str) -> Rgb {
        let value = block
            .lines()
            .find_map(|l| l.trim().strip_prefix(&format!("{property}: ")))
            .unwrap_or_else(|| panic!("no {property} in {block}"))
            .trim_end_matches(';');
        Rgb::parse(value).unwrap()
    }

    fn bundled_themes() -> Vec<Theme> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../themes");
        let mut set = ThemeSet::new();
        let mut names = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path().join("theme.json");
            if path.exists() {
                let name = path
                    .parent()
                    .unwrap()
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string();
                let text = std::fs::read_to_string(&path).unwrap();
                set.insert(&name, crate::theme::ThemeFile::from_json(&text).unwrap());
                names.push(name);
            }
        }
        names.iter().map(|n| set.resolve(n).unwrap()).collect()
    }

    #[test]
    fn any_accent_is_readable_on_every_bundled_theme_in_light_and_dark() {
        let themes = bundled_themes();
        assert!(themes.len() >= 3);
        let mut checked = 0;
        for theme in &themes {
            for r in (0..=255).step_by(85) {
                for g in (0..=255).step_by(85) {
                    for b in (0..=255).step_by(85) {
                        let accent = Rgb(r as u8, g as u8, b as u8).hex();
                        let chosen = look(json!({ "accent": accent }));
                        let compiled = compile(&chosen, theme).unwrap();
                        assert_confined(&compiled.css);
                        for scheme in ["light", "dark"] {
                            let ground = ground(theme, scheme, None);
                            let opener = if theme.color_scheme == scheme {
                                ":root {\n".to_string()
                            } else {
                                format!(":root[data-theme=\"{scheme}\"] {{\n")
                            };
                            let colors = block(&compiled.css, &opener);
                            let accent = color_in(colors, "--ob-color-accent");
                            let soft = color_in(colors, "--ob-color-accent-soft");
                            let link = color_in(colors, "--ob-color-link");
                            let on = color_in(colors, "--ob-color-accent-contrast");
                            let border = color_in(colors, "--ob-color-accent-border");
                            let glow = color_in(colors, "--ob-color-glow");
                            let mut grounds = vec![ground.page, ground.surface];
                            grounds.extend(ground.surface_raised);
                            for bg in grounds {
                                for text in [accent, soft, link] {
                                    assert!(contrast(text, bg) >= TEXT, "{} {scheme}", theme.name);
                                }
                                assert!(contrast(border, bg) >= 3.0);
                            }
                            assert!(contrast(on, accent) >= TEXT);
                            assert!(contrast(ground.text, glow) >= TEXT);
                            checked += 1;
                        }
                    }
                }
            }
        }
        assert_eq!(checked, themes.len() * 4 * 4 * 4 * 2);
    }

    #[test]
    fn the_owner_is_told_when_a_color_had_to_change() {
        let theme = base();
        let kept = compile(&look(json!({"accent": "#1d4bc2"})), &theme).unwrap();
        assert!(
            kept.notes.iter().all(|n| !n.contains("in light mode")),
            "{:?}",
            kept.notes
        );
        let pale = compile(&look(json!({"accent": "#ffe066"})), &theme).unwrap();
        assert_eq!(
            pale.notes,
            ["Your accent color was made a little darker in light mode so text stays easy to read."]
        );
        let dark_blue = compile(&look(json!({"accent": "#0a1f5c"})), &theme).unwrap();
        assert_eq!(
            dark_blue.notes,
            ["Your accent color was made a little lighter in dark mode so text stays easy to read."]
        );
    }

    #[test]
    fn an_impossible_accent_is_refused_with_a_suggestion_and_does_not_break_the_page() {
        // Black, white and mid gray backgrounds at once: no color is 4.5:1 against all three.
        let mut theme = base();
        let colors: std::collections::BTreeMap<String, String> = [
            ("page", "#000000"),
            ("surface", "#ffffff"),
            ("surfaceRaised", "#808080"),
            ("text", "#000000"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        theme.colors.insert("light".into(), colors);
        let compiled = compile(
            &look(json!({"accent": "#336699", "roundness": "soft"})),
            &theme,
        )
        .unwrap();
        assert!(compiled
            .notes
            .iter()
            .any(|n| n.contains("light mode") && n.contains("Try a deeper or a lighter color")));
        // The other choices still apply, and no half-derived accent leaks into the refused scheme.
        assert!(compiled.css.contains("--ob-radius: 8px;"));
        assert!(!compiled.css.contains("@media print"));
    }

    #[test]
    fn higher_contrast_and_print_are_handled_and_focus_stays_visible() {
        let compiled = compile(&look(json!({"accent": "#7aa2ff"})), &base()).unwrap();
        assert!(compiled.css.contains("@media (prefers-contrast: more) {"));
        let more = block(
            &compiled.css,
            "@media (prefers-contrast: more) {\n  :root {\n",
        );
        let page = Rgb::parse("#ffffff").unwrap();
        assert!(contrast(color_in(more, "--ob-color-accent"), page) >= HIGH);
        // Print is last and carries the light accent, so dark-mode screens do not print pale text.
        let printed = compiled.css.rfind("@media print").unwrap();
        assert!(printed > compiled.css.find("prefers-contrast").unwrap());
        let print = block(
            &compiled.css,
            "@media print {\n  :root,\n  :root[data-theme] {\n",
        );
        assert!(contrast(color_in(print, "--ob-color-accent"), page) >= TEXT);
        // The focus ring is drawn in the accent, so it is as visible as the accent text: 3:1 or better
        // on the page and surfaces in each scheme, for every accent swept above.
        assert!(base()
            .tokens
            .get("focusRing")
            .unwrap()
            .contains("--ob-color-accent"));
        // Only custom properties are written, so forced-colors mode (which ignores them) is untouched.
        assert!(!compiled.css.contains("!important") && !compiled.css.contains("forced-colors"));
    }

    #[test]
    fn every_curated_look_is_readable_on_every_theme_that_honors_palettes() {
        let mut checked = 0;
        for theme in bundled_themes().iter().filter(|t| t.honors("palette")) {
            for curated in &look_presets::LOOKS {
                let chosen = look_presets::apply(curated.id, &LookSettings::default()).unwrap();
                let compiled = compile(&chosen, theme).unwrap();
                assert_confined(&compiled.css);
                assert!(compiled.notes.is_empty(), "{} {}", theme.name, curated.id);
                assert!(
                    compiled.css.contains("--ob-font-body"),
                    "font style comes with the look"
                );
                for scheme in ["light", "dark"] {
                    let opener = if theme.color_scheme == scheme {
                        ":root {\n".to_string()
                    } else {
                        format!(":root[data-theme=\"{scheme}\"] {{\n")
                    };
                    let colors = block(&compiled.css, &opener);
                    let page = color_in(colors, "--ob-color-page");
                    let surface = color_in(colors, "--ob-color-surface");
                    let raised = color_in(colors, "--ob-color-surface-raised");
                    let accent = color_in(colors, "--ob-color-accent");
                    for bg in [page, surface, raised] {
                        for token in [
                            "--ob-color-muted",
                            "--ob-color-subtle",
                            "--ob-color-accent",
                            "--ob-color-link",
                        ] {
                            assert!(
                                contrast(color_in(colors, token), bg) >= TEXT,
                                "{} {} {scheme} {token}",
                                theme.name,
                                curated.id
                            );
                        }
                        assert!(contrast(color_in(colors, "--ob-color-text"), bg) >= 7.0);
                        // The theme's own callout colors keep working on the palette's grounds.
                        for key in [
                            "calloutNote",
                            "calloutTip",
                            "calloutWarning",
                            "calloutCaution",
                        ] {
                            if let Some(value) = theme.colors[scheme].get(key) {
                                let callout = Rgb::parse(value).unwrap();
                                assert!(
                                    contrast(callout, bg) >= 3.0,
                                    "{} {} {scheme} {key}: {:.2}",
                                    theme.name,
                                    curated.id,
                                    contrast(callout, bg)
                                );
                            }
                        }
                    }
                    assert!(
                        contrast(color_in(colors, "--ob-color-accent-contrast"), accent) >= TEXT
                    );
                    checked += 1;
                }
            }
        }
        assert!(checked >= 3 * 8 * 2);
    }

    #[test]
    fn a_chosen_accent_wins_over_the_palette_accent_and_both_stay_readable() {
        let theme = base();
        let with_palette = compile(&look(json!({"palette": "night"})), &theme).unwrap();
        let tweaked = compile(
            &look(json!({"palette": "night", "accent": "#00aa44"})),
            &theme,
        )
        .unwrap();
        let light = ":root {\n";
        assert_ne!(
            color_in(block(&with_palette.css, light), "--ob-color-accent"),
            color_in(block(&tweaked.css, light), "--ob-color-accent")
        );
        // The palette's page is kept either way.
        assert_eq!(
            color_in(block(&with_palette.css, light), "--ob-color-page"),
            color_in(block(&tweaked.css, light), "--ob-color-page")
        );
        // A theme that does not honor palettes ignores the palette but still honors the accent.
        let mut limited = base();
        limited.customizable = vec!["accent".into()];
        let only_accent = compile(
            &look(json!({"palette": "night", "accent": "#00aa44"})),
            &limited,
        )
        .unwrap();
        assert!(!only_accent.css.contains("--ob-color-page"));
        assert!(only_accent.css.contains("--ob-color-accent"));
    }
}
