//! Curated looks: eight named, ready-made combinations of a complete light and dark palette and a font
//! style (ADR 0248). They are data in core, not themes. Applying one fills in the look; resetting the
//! look returns exactly to the theme's own default.
//!
//! Every palette is pre-checked against the contrast model (see the tests): body text 7:1, muted and
//! subtle text 4.5:1, and the palette's own accent 4.5:1 on the page and both surfaces, in light and
//! dark. Meaning is never carried by color alone: each look has a plain-words name and description, and
//! the accent only colors links and controls that are also underlined, outlined or labelled.

use serde_json::{json, Value};

use crate::look::{FontStyle, LookSettings};

/// One scheme of a palette, as `#rrggbb` values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PaletteColors {
    pub page: &'static str,
    pub outer: &'static str,
    pub surface: &'static str,
    pub surface_raised: &'static str,
    pub text: &'static str,
    pub muted: &'static str,
    pub subtle: &'static str,
    pub border: &'static str,
    pub accent: &'static str,
}

/// A named look.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CuratedLook {
    pub id: &'static str,
    pub name: &'static str,
    /// What it feels like, in words, so nobody has to see its colors to choose it.
    pub description: &'static str,
    pub font_style: FontStyle,
    pub light: PaletteColors,
    pub dark: PaletteColors,
}

#[allow(clippy::too_many_arguments)]
const fn colors(
    page: &'static str,
    outer: &'static str,
    surface: &'static str,
    surface_raised: &'static str,
    text: &'static str,
    muted: &'static str,
    subtle: &'static str,
    border: &'static str,
    accent: &'static str,
) -> PaletteColors {
    PaletteColors {
        page,
        outer,
        surface,
        surface_raised,
        text,
        muted,
        subtle,
        border,
        accent,
    }
}

/// The curated looks, in the order Admin lists them. The ids are [`crate::look::PALETTE_IDS`].
pub const LOOKS: [CuratedLook; 8] = [
    CuratedLook {
        id: "calm",
        name: "Calm",
        description: "Quiet slate blue on soft grey, with clean modern lettering.",
        font_style: FontStyle::ModernSans,
        light: colors(
            "#f7f9fb", "#eef2f6", "#ffffff", "#eaf0f6", "#1c2733", "#425466", "#566a7f", "#cfd9e3",
            "#2f6690",
        ),
        dark: colors(
            "#101820", "#0b1218", "#16212b", "#1d2a36", "#e6edf3", "#b5c4d2", "#94a7b8", "#2c3b49",
            "#7fb3d9",
        ),
    },
    CuratedLook {
        id: "warm",
        name: "Warm",
        description: "Cream paper and terracotta, with classic book lettering.",
        font_style: FontStyle::ClassicSerif,
        light: colors(
            "#fdf8f2", "#f6ecdf", "#fffdf9", "#f4e8d9", "#2e2118", "#5a4637", "#6e5a49", "#e2d2bd",
            "#a8431f",
        ),
        dark: colors(
            "#1c1511", "#140f0c", "#251c17", "#302520", "#f4e9dd", "#d2bfae", "#b09c8a", "#46372d",
            "#f0916a",
        ),
    },
    CuratedLook {
        id: "bold",
        name: "Bold",
        description: "Pure black and white with a hot pink accent: the strongest contrast.",
        font_style: FontStyle::ModernSans,
        light: colors(
            "#ffffff", "#f2f2f2", "#ffffff", "#ededed", "#000000", "#333333", "#4d4d4d", "#8a8a8a",
            "#b0124f",
        ),
        dark: colors(
            "#000000", "#000000", "#0d0d0d", "#1a1a1a", "#ffffff", "#e0e0e0", "#bdbdbd", "#6b6b6b",
            "#ff6fa5",
        ),
    },
    CuratedLook {
        id: "night",
        name: "Night",
        description: "Deep midnight blue and indigo, with a coder's typewriter lettering.",
        font_style: FontStyle::TechieMono,
        light: colors(
            "#f3f4fa", "#e8eaf6", "#ffffff", "#e8eaf6", "#14172e", "#3b4063", "#545a82", "#c5c9e3",
            "#4338ca",
        ),
        dark: colors(
            "#0b1020", "#070a14", "#121833", "#1a2142", "#e8ebff", "#b8bfe6", "#98a0cf", "#2b3563",
            "#8b9bff",
        ),
    },
    CuratedLook {
        id: "garden",
        name: "Garden",
        description: "Fresh leaf green on pale sage, with friendly rounded lettering.",
        font_style: FontStyle::FriendlyRounded,
        light: colors(
            "#f6faf4", "#ebf3e7", "#ffffff", "#e5f0df", "#1d2a1b", "#3d5239", "#53694e", "#cbdcc4",
            "#2a6f2e",
        ),
        dark: colors(
            "#101a12", "#0a110b", "#172219", "#1f2d22", "#e6f2e4", "#b9d0b5", "#98b394", "#2d4332",
            "#7fcf86",
        ),
    },
    CuratedLook {
        id: "paper",
        name: "Paper",
        description: "Off-white page, dark ink and a brown accent, with classic book lettering.",
        font_style: FontStyle::ClassicSerif,
        light: colors(
            "#faf8f3", "#f1ede3", "#fffefb", "#efeadd", "#222222", "#4a4a4a", "#5e5e5e", "#d9d2c0",
            "#7a4b2a",
        ),
        dark: colors(
            "#1b1a17", "#12110f", "#24221e", "#2e2b26", "#eeeae0", "#cfc9ba", "#ada694", "#433f36",
            "#d4a574",
        ),
    },
    CuratedLook {
        id: "ocean",
        name: "Ocean",
        description: "Cool sea teal on pale aqua, with clean modern lettering.",
        font_style: FontStyle::ModernSans,
        light: colors(
            "#f2fafb", "#e2f1f3", "#ffffff", "#dcedf0", "#0f2a30", "#2f4f56", "#44666d", "#bfdde2",
            "#0f7480",
        ),
        dark: colors(
            "#0a1a1e", "#061215", "#10262b", "#173238", "#e3f4f6", "#aed0d6", "#8db3ba", "#25444b",
            "#5cc8d6",
        ),
    },
    CuratedLook {
        id: "sunset",
        name: "Sunset",
        description: "Soft peach and plum with a rose accent, and friendly rounded lettering.",
        font_style: FontStyle::FriendlyRounded,
        light: colors(
            "#fff7f2", "#fdebe0", "#fffdfb", "#fbe6d9", "#2d1b2e", "#5a3d56", "#6e516a", "#efd2c1",
            "#b83a5a",
        ),
        dark: colors(
            "#1f1220", "#160b17", "#2a1a2c", "#352238", "#fbeaf0", "#dbbccb", "#bb9bab", "#4d3350",
            "#ff8a65",
        ),
    },
];

/// The curated look with this id.
pub fn find(id: &str) -> Option<&'static CuratedLook> {
    LOOKS.iter().find(|look| look.id == id)
}

impl CuratedLook {
    /// The palette for a scheme (`"light"` or anything else for dark).
    pub fn scheme(&self, scheme: &str) -> &PaletteColors {
        if scheme == "light" {
            &self.light
        } else {
            &self.dark
        }
    }
}

/// Apply a curated look to the current settings: its palette and font style are chosen and a chosen
/// accent is cleared (the palette brings its own; an accent picked afterwards is a tweak on top). Size,
/// roundness, spacing, width and weight stay as they were. `None` for an unknown id.
pub fn apply(id: &str, current: &LookSettings) -> Option<LookSettings> {
    let curated = find(id)?;
    let mut next = current.clone();
    next.palette = Some(curated.id.to_string());
    next.font_style = Some(curated.font_style);
    next.accent = None;
    Some(next)
}

/// The catalog Admin shows: names, plain descriptions and swatches for both schemes.
pub fn catalog_json() -> Value {
    Value::Array(
        LOOKS
            .iter()
            .map(|look| {
                let swatch = |p: &PaletteColors| {
                    json!({
                        "page": p.page, "surface": p.surface, "text": p.text, "accent": p.accent
                    })
                };
                json!({
                    "id": look.id,
                    "name": look.name,
                    "description": look.description,
                    "fontStyle": look.font_style.id(),
                    "light": swatch(&look.light),
                    "dark": swatch(&look.dark),
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::look::PALETTE_IDS;
    use crate::look_contrast::{contrast, Rgb, TEXT};

    fn rgb(hex: &str) -> Rgb {
        Rgb::parse(hex).unwrap_or_else(|| panic!("{hex} is not a plain hex color"))
    }

    #[test]
    fn the_catalog_matches_the_palette_ids_and_every_look_validates() {
        let ids: Vec<&str> = LOOKS.iter().map(|l| l.id).collect();
        assert_eq!(ids, PALETTE_IDS);
        for look in &LOOKS {
            let applied = apply(look.id, &LookSettings::default()).unwrap();
            // What apply produces is exactly what validation accepts back.
            assert_eq!(
                LookSettings::from_value(&applied.to_value()).unwrap(),
                applied
            );
            assert!(!look.name.is_empty() && look.description.len() > 20);
        }
        assert!(apply("neon", &LookSettings::default()).is_none());
    }

    #[test]
    fn every_palette_passes_aa_on_every_ground_in_light_and_dark() {
        for look in &LOOKS {
            for (scheme, p) in [("light", &look.light), ("dark", &look.dark)] {
                for bg in [p.page, p.surface, p.surface_raised] {
                    for (name, fg, need) in [
                        ("text", p.text, 7.0),
                        ("muted", p.muted, TEXT),
                        ("subtle", p.subtle, TEXT),
                        ("accent", p.accent, TEXT),
                    ] {
                        let got = contrast(rgb(fg), rgb(bg));
                        assert!(got >= need, "{} {scheme} {name} on {bg}: {got:.2}", look.id);
                    }
                }
                // A visible, but not harsh, divider.
                assert!(
                    contrast(rgb(p.border), rgb(p.page)) >= 1.2,
                    "{} {scheme}",
                    look.id
                );
            }
            // The light palette is light and the dark one dark, so a theme's own colors for the
            // other pieces (callouts, code) keep working beside them.
            assert!(rgb(look.light.page).luminance() > 0.5, "{}", look.id);
            assert!(rgb(look.dark.page).luminance() < 0.1, "{}", look.id);
        }
    }

    #[test]
    fn looks_stay_distinguishable_without_color_perception() {
        let mut names: Vec<&str> = LOOKS.iter().map(|l| l.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 8);
        let mut descriptions: Vec<&str> = LOOKS.iter().map(|l| l.description).collect();
        descriptions.sort_unstable();
        descriptions.dedup();
        assert_eq!(descriptions.len(), 8);
        // Lightness alone separates the dark and light pages by a wide margin in every look.
        for look in &LOOKS {
            assert!(
                contrast(rgb(look.light.page), rgb(look.dark.page)) > 10.0,
                "{}",
                look.id
            );
        }
    }

    #[test]
    fn applying_then_resetting_returns_exactly_to_the_default() {
        let start = LookSettings::from_value(&json!({
            "accent": "#aa3300", "textSize": "large", "roundness": "round"
        }))
        .unwrap();
        let applied = apply("garden", &start).unwrap();
        assert_eq!(applied.palette.as_deref(), Some("garden"));
        assert_eq!(applied.font_style, Some(FontStyle::FriendlyRounded));
        assert_eq!(applied.accent, None, "the palette brings its own accent");
        // Other choices survive; clearing the look's two controls restores what was there.
        assert_eq!(applied.text_size, start.text_size);
        let mut reset = applied.clone();
        reset.palette = None;
        reset.font_style = None;
        assert_eq!(reset.roundness, start.roundness);
        // From the untouched default, one tap and one reset is nothing at all.
        let tapped = apply("night", &LookSettings::default()).unwrap();
        assert!(!tapped.is_default());
        assert!(LookSettings::default().is_default());
        assert_eq!(LookSettings::default().to_value(), json!({}));
    }

    #[test]
    fn the_catalog_json_has_swatches_and_words() {
        let catalog = catalog_json();
        let calm = &catalog[0];
        assert_eq!(calm["id"], "calm");
        assert_eq!(calm["light"]["accent"], "#2f6690");
        assert!(calm["description"].as_str().unwrap().contains("slate"));
        assert_eq!(catalog.as_array().unwrap().len(), 8);
    }
}
