//! The owner's look: a small set of typed, bounded presets stored under `appearance` in
//! `openblog.json` (ADR 0248).
//!
//! Every field is an enum or a strict hex color. Nothing is free text, so no value can carry markup,
//! a URL or a style rule into the generated stylesheet. An unset field means "use the theme as it is"
//! and adds nothing to the output. The stored object is versioned; unknown fields are preserved on
//! save (a newer engine's settings survive an older one) and unknown versions are rejected.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

/// The only schema version this engine reads or writes.
pub const LOOK_VERSION: u64 = 1;

/// The controls a theme may honor, as written in `theme.json` `customizable` and shown to Admin.
pub const CONTROLS: [&str; 8] = [
    "accent",
    "palette",
    "fontStyle",
    "textSize",
    "roundness",
    "spacing",
    "pageWidth",
    "headingWeight",
];

/// Curated palette ids (`palette: "theme"` means the theme's own colors). The palette data lives in
/// [`crate::look_presets`].
pub const PALETTE_IDS: [&str; 8] = [
    "calm", "warm", "bold", "night", "garden", "paper", "ocean", "sunset",
];

macro_rules! choice_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $id:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum $name { $($variant),+ }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub fn id(self) -> &'static str {
                match self { $($name::$variant => $id),+ }
            }

            pub fn parse(text: &str) -> Option<$name> {
                match text { $($id => Some($name::$variant),)+ _ => None }
            }

            pub fn ids() -> Vec<&'static str> {
                Self::ALL.iter().map(|v| v.id()).collect()
            }
        }
    };
}

choice_enum!(
    /// A font style mapped to a fixed, safe font stack. `theme` is the absence of a choice.
    FontStyle {
        ModernSans => "modern-sans",
        ClassicSerif => "classic-serif",
        FriendlyRounded => "friendly-rounded",
        TechieMono => "techie-mono",
    }
);
choice_enum!(TextSize {
    Small => "small",
    Medium => "medium",
    Large => "large",
    ExtraLarge => "extra-large",
});
choice_enum!(Roundness {
    Square => "square",
    Soft => "soft",
    Round => "round",
});
choice_enum!(Spacing {
    Compact => "compact",
    Comfortable => "comfortable",
    Airy => "airy",
});
choice_enum!(PageWidth {
    Narrow => "narrow",
    Medium => "medium",
    Wide => "wide",
});
choice_enum!(HeadingWeight {
    Normal => "normal",
    Bold => "bold",
});

/// The validated look. `None` everywhere is the default and produces no output.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LookSettings {
    /// A strict lowercase `#rrggbb` color.
    pub accent: Option<String>,
    /// One of [`PALETTE_IDS`].
    pub palette: Option<String>,
    pub font_style: Option<FontStyle>,
    pub text_size: Option<TextSize>,
    pub roundness: Option<Roundness>,
    pub spacing: Option<Spacing>,
    pub page_width: Option<PageWidth>,
    pub heading_weight: Option<HeadingWeight>,
    /// Fields this engine does not know, kept so saving never drops a newer engine's settings.
    /// They are never read when compiling CSS.
    pub extra: BTreeMap<String, Value>,
}

/// Parse `#rgb` or `#rrggbb` into a normalized lowercase `#rrggbb`. Nothing else is accepted.
pub fn normalize_hex(text: &str) -> Option<String> {
    let digits = text.strip_prefix('#')?;
    if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    match digits.len() {
        6 => Some(format!("#{}", digits.to_ascii_lowercase())),
        3 => {
            let mut out = String::from("#");
            for c in digits.chars() {
                let c = c.to_ascii_lowercase();
                out.push(c);
                out.push(c);
            }
            Some(out)
        }
        _ => None,
    }
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "nothing",
        Value::Bool(_) => "a true/false value",
        Value::Number(_) => "a number",
        Value::String(_) => "text",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

impl LookSettings {
    /// True when nothing is chosen and nothing is preserved: the look adds nothing anywhere.
    pub fn is_default(&self) -> bool {
        *self == LookSettings::default()
    }

    /// True when no known control is chosen (preserved unknown fields do not change the look).
    pub fn is_neutral(&self) -> bool {
        self.accent.is_none()
            && self.palette.is_none()
            && self.font_style.is_none()
            && self.text_size.is_none()
            && self.roundness.is_none()
            && self.spacing.is_none()
            && self.page_width.is_none()
            && self.heading_weight.is_none()
    }

    /// Validate a stored or submitted `appearance` object. All problems are reported, in plain words.
    pub fn from_value(value: &Value) -> Result<LookSettings, Vec<String>> {
        let object = match value {
            Value::Null => return Ok(LookSettings::default()),
            Value::Object(object) => object,
            other => {
                return Err(vec![format!(
                    "appearance must be an object, not {}",
                    kind(other)
                )])
            }
        };
        let mut errors = Vec::new();
        match object.get("version") {
            None | Some(Value::Null) => {}
            Some(Value::Number(n)) if n.as_u64() == Some(LOOK_VERSION) => {}
            Some(Value::Number(n)) if n.as_u64().is_some_and(|v| v > LOOK_VERSION) => errors.push(
                "appearance was saved by a newer version of open.blog; update before editing it"
                    .to_string(),
            ),
            Some(_) => errors.push(format!("appearance version must be {LOOK_VERSION}")),
        }
        let mut look = LookSettings::default();
        for (key, value) in object {
            if key == "version" {
                continue;
            }
            if value.is_null() && CONTROLS.contains(&key.as_str()) {
                continue;
            }
            match key.as_str() {
                "accent" => match value.as_str().and_then(normalize_hex) {
                    Some(hex) => look.accent = Some(hex),
                    None => errors.push(format!(
                        "accent must be a color written like #2457d6, not {}",
                        describe(value)
                    )),
                },
                "palette" => match value.as_str() {
                    Some("theme") => {}
                    Some(id) if PALETTE_IDS.contains(&id) => look.palette = Some(id.to_string()),
                    _ => errors.push(format!(
                        "palette must be one of: theme, {} (not {})",
                        PALETTE_IDS.join(", "),
                        describe(value)
                    )),
                },
                "fontStyle" => match value.as_str() {
                    Some("theme") => {}
                    other => match other.and_then(FontStyle::parse) {
                        Some(v) => look.font_style = Some(v),
                        None => errors.push(choice_error(
                            "fontStyle",
                            &["theme"],
                            &FontStyle::ids(),
                            value,
                        )),
                    },
                },
                "textSize" => set_choice(&mut look.text_size, "textSize", value, &mut errors),
                "roundness" => set_choice(&mut look.roundness, "roundness", value, &mut errors),
                "spacing" => set_choice(&mut look.spacing, "spacing", value, &mut errors),
                "pageWidth" => set_choice(&mut look.page_width, "pageWidth", value, &mut errors),
                "headingWeight" => set_choice(
                    &mut look.heading_weight,
                    "headingWeight",
                    value,
                    &mut errors,
                ),
                _ => {
                    look.extra.insert(key.clone(), value.clone());
                }
            }
        }
        if errors.is_empty() {
            Ok(look)
        } else {
            Err(errors)
        }
    }

    /// The stored shape: versioned, with only the chosen fields. Empty when the look is the default.
    pub fn to_value(&self) -> Value {
        if self.is_default() {
            return Value::Object(Map::new());
        }
        let mut object = Map::new();
        for (key, value) in &self.extra {
            object.insert(key.clone(), value.clone());
        }
        object.insert("version".into(), Value::from(LOOK_VERSION));
        let mut put = |key: &str, value: Option<&str>| {
            if let Some(value) = value {
                object.insert(key.into(), Value::String(value.to_string()));
            }
        };
        put("accent", self.accent.as_deref());
        put("palette", self.palette.as_deref());
        put("fontStyle", self.font_style.map(FontStyle::id));
        put("textSize", self.text_size.map(TextSize::id));
        put("roundness", self.roundness.map(Roundness::id));
        put("spacing", self.spacing.map(Spacing::id));
        put("pageWidth", self.page_width.map(PageWidth::id));
        put("headingWeight", self.heading_weight.map(HeadingWeight::id));
        Value::Object(object)
    }
}

/// Echo a rejected value without letting a long or odd one flood a message.
fn describe(value: &Value) -> String {
    match value {
        // Plain words and colors are shown back; anything with markup or CSS punctuation in it is
        // never repeated (ADR 0263).
        Value::String(text)
            if !text
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '#' | '-' | '_' | '.' | ',')) =>
        {
            "text with characters that are not allowed".to_string()
        }
        Value::String(text) => {
            let shown: String = text.chars().filter(|c| !c.is_control()).take(24).collect();
            if text.chars().count() > 24 {
                format!("\"{shown}...\"")
            } else {
                format!("\"{shown}\"")
            }
        }
        other => kind(other).to_string(),
    }
}

fn choice_error(field: &str, extra: &[&str], ids: &[&str], value: &Value) -> String {
    let mut all: Vec<&str> = extra.to_vec();
    all.extend_from_slice(ids);
    format!(
        "{field} must be one of: {} (not {})",
        all.join(", "),
        describe(value)
    )
}

trait Choice: Sized + Copy {
    fn parse_id(text: &str) -> Option<Self>;
    fn all_ids() -> Vec<&'static str>;
}

macro_rules! impl_choice {
    ($($name:ident),+) => {$(
        impl Choice for $name {
            fn parse_id(text: &str) -> Option<Self> { $name::parse(text) }
            fn all_ids() -> Vec<&'static str> { $name::ids() }
        }
    )+};
}
impl_choice!(TextSize, Roundness, Spacing, PageWidth, HeadingWeight);

fn set_choice<T: Choice>(
    slot: &mut Option<T>,
    field: &str,
    value: &Value,
    errors: &mut Vec<String>,
) {
    match value.as_str().and_then(T::parse_id) {
        Some(parsed) => *slot = Some(parsed),
        None => errors.push(choice_error(field, &[], &T::all_ids(), value)),
    }
}

impl Serialize for LookSettings {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for LookSettings {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        LookSettings::from_value(&value)
            .map_err(|errors| serde::de::Error::custom(errors.join("; ")))
    }
}

/// The plain name Admin shows for a control.
pub fn control_label(control: &str) -> &'static str {
    match control {
        "accent" => "Accent color",
        "palette" => "Color palette",
        "fontStyle" => "Font style",
        "textSize" => "Text size",
        "roundness" => "Corner roundness",
        "spacing" => "Spacing",
        "pageWidth" => "Page width",
        "headingWeight" => "Heading weight",
        _ => "",
    }
}

/// A kind sentence about the controls a theme does not honor, or `None` when it honors them all.
pub fn unhonored_note(theme_label: &str, honored: &[String]) -> Option<String> {
    let missing: Vec<&str> = CONTROLS
        .iter()
        .filter(|c| !honored.iter().any(|h| h == *c))
        .map(|c| control_label(c))
        .collect();
    if missing.is_empty() {
        return None;
    }
    let theme_label: String = theme_label.chars().filter(|c| !c.is_control()).collect();
    Some(format!(
        "The {theme_label} theme has its own design for: {}. Those choices are hidden because they would not change anything here.",
        missing.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn err(value: Value) -> String {
        LookSettings::from_value(&value).unwrap_err().join("; ")
    }

    #[test]
    fn nothing_chosen_is_the_default_and_stores_nothing() {
        for empty in [json!(null), json!({}), json!({"version": 1})] {
            let look = LookSettings::from_value(&empty).unwrap();
            assert!(look.is_default());
            assert_eq!(look.to_value(), json!({}));
        }
        // "theme" is the explicit spelling of the default.
        let look =
            LookSettings::from_value(&json!({"palette": "theme", "fontStyle": "theme"})).unwrap();
        assert!(look.is_default());
    }

    #[test]
    fn every_field_accepts_exactly_its_domain() {
        for id in PALETTE_IDS {
            assert!(LookSettings::from_value(&json!({ "palette": id })).is_ok());
        }
        let domains: [(&str, Vec<&str>); 5] = [
            ("fontStyle", FontStyle::ids()),
            ("textSize", TextSize::ids()),
            ("roundness", Roundness::ids()),
            ("spacing", Spacing::ids()),
            ("pageWidth", PageWidth::ids()),
        ];
        for (field, ids) in domains {
            for id in &ids {
                assert!(
                    LookSettings::from_value(&json!({ field: id })).is_ok(),
                    "{field}={id}"
                );
                assert!(
                    LookSettings::from_value(&json!({ field: id.to_uppercase() })).is_err(),
                    "{field} is case-sensitive"
                );
            }
            assert!(err(json!({ field: "nonsense" })).contains(field));
        }
        assert!(LookSettings::from_value(&json!({"headingWeight": "bold"})).is_ok());
        assert!(LookSettings::from_value(&json!({"headingWeight": "900"})).is_err());
    }

    #[test]
    fn colors_are_strict_hex_and_normalized() {
        let look = LookSettings::from_value(&json!({"accent": "#ABC"})).unwrap();
        assert_eq!(look.accent.as_deref(), Some("#aabbcc"));
        let look = LookSettings::from_value(&json!({"accent": "#2457D6"})).unwrap();
        assert_eq!(look.accent.as_deref(), Some("#2457d6"));
        for bad in [
            "2457d6",
            "#2457d",
            "#2457d6ff",
            "#gggggg",
            "red",
            "rgb(0,0,0)",
            "",
            " #2457d6",
            "#2457d6 ",
            "#2457d6;}",
            "#abc;}body{display:none",
            "url(https://evil.test/x)",
            "#2457d6\n",
            "var(--x)",
            "#\u{ff12}\u{ff14}\u{ff15}\u{ff17}d6",
        ] {
            assert!(
                LookSettings::from_value(&json!({ "accent": bad })).is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn injection_style_values_are_rejected_with_short_plain_messages() {
        let message = err(json!({
            "accent": "#fff;}*{display:none}",
            "fontStyle": "x;}body{background:url(//evil)",
            "roundness": 12,
            "spacing": ["airy"],
            "pageWidth": {"a": 1},
            "textSize": true,
        }));
        for field in [
            "accent",
            "fontStyle",
            "roundness",
            "spacing",
            "pageWidth",
            "textSize",
        ] {
            assert!(message.contains(field), "{message}");
        }
        assert!(message.contains("a number") && message.contains("a list"));
        assert!(
            !message.contains("evil)"),
            "long values are clipped: {message}"
        );
        assert!(message.len() < 900);
    }

    #[test]
    fn wrong_types_and_shapes_fail() {
        assert!(err(json!("calm")).contains("must be an object"));
        assert!(err(json!([])).contains("must be an object"));
        assert!(err(json!({"palette": 3})).contains("palette"));
        assert!(err(json!({"palette": "neon"})).contains("palette"));
    }

    #[test]
    fn versions_are_checked_and_unknown_fields_survive() {
        assert!(err(json!({"version": 2})).contains("newer version"));
        assert!(err(json!({"version": 0})).contains("version"));
        assert!(err(json!({"version": "1"})).contains("version"));
        let look = LookSettings::from_value(
            &json!({"version": 1, "accent": "#112233", "futureKnob": {"a": [1, 2]}}),
        )
        .unwrap();
        let stored = look.to_value();
        assert_eq!(stored["futureKnob"], json!({"a": [1, 2]}));
        assert_eq!(stored["version"], json!(1));
        assert_eq!(LookSettings::from_value(&stored).unwrap(), look);
        // Preserved fields never count as a chosen look.
        let only_extra = LookSettings::from_value(&json!({"futureKnob": 1})).unwrap();
        assert!(only_extra.is_neutral() && !only_extra.is_default());
    }

    #[test]
    fn round_trips_through_serde() {
        let look = LookSettings::from_value(&json!({
            "accent": "#aa5500", "palette": "warm", "fontStyle": "classic-serif",
            "textSize": "large", "roundness": "round", "spacing": "airy",
            "pageWidth": "narrow", "headingWeight": "normal"
        }))
        .unwrap();
        let text = serde_json::to_string(&look).unwrap();
        let back: LookSettings = serde_json::from_str(&text).unwrap();
        assert_eq!(back, look);
    }

    #[test]
    fn unhonored_controls_are_explained_kindly() {
        let all: Vec<String> = CONTROLS.iter().map(|c| c.to_string()).collect();
        assert_eq!(unhonored_note("Base", &all), None);
        let note = unhonored_note("Demo", &["accent".to_string()]).unwrap();
        assert!(note.contains("Font style") && note.contains("Page width"));
        assert!(!note.contains("Accent color"));
        for control in CONTROLS {
            assert!(!control_label(control).is_empty());
        }
    }
}
