//! A pure contrast model for the owner's look (ADR 0248): from a chosen accent and the page and
//! surface colors of a scheme, derive an accent that stays readable, the text color on it, and soft
//! tints, enforcing WCAG 2 AA (4.5:1 for text, 3:1 for interface parts).
//!
//! Everything here is deterministic arithmetic on `#rrggbb` values. Nothing touches CSS.

/// WCAG AA contrast for normal text.
pub const TEXT: f64 = 4.5;
/// WCAG AA contrast for interface parts (borders, focus rings).
pub const PART: f64 = 3.0;
/// The stricter target used under `prefers-contrast: more` (WCAG AAA for text).
pub const HIGH: f64 = 7.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    /// Parse `#rgb` or `#rrggbb`. Anything else (named colors, functions) is `None`.
    pub fn parse(text: &str) -> Option<Rgb> {
        let hex = crate::look::normalize_hex(text.trim())?;
        let n = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16).ok();
        Some(Rgb(n(1..3)?, n(3..5)?, n(5..7)?))
    }

    pub fn hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }

    /// WCAG relative luminance.
    pub fn luminance(self) -> f64 {
        let channel = |v: u8| {
            let v = f64::from(v) / 255.0;
            if v <= 0.039_28 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * channel(self.0) + 0.7152 * channel(self.1) + 0.0722 * channel(self.2)
    }

    /// Linear mix in sRGB space: `t` of `other`, the rest of `self`.
    pub fn mix(self, other: Rgb, t: f64) -> Rgb {
        let m = |a: u8, b: u8| (f64::from(a) * (1.0 - t) + f64::from(b) * t).round() as u8;
        Rgb(m(self.0, other.0), m(self.1, other.1), m(self.2, other.2))
    }

    fn to_hsl(self) -> (f64, f64, f64) {
        let (r, g, b) = (
            f64::from(self.0) / 255.0,
            f64::from(self.1) / 255.0,
            f64::from(self.2) / 255.0,
        );
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        let l = (max + min) / 2.0;
        if (max - min).abs() < f64::EPSILON {
            return (0.0, 0.0, l);
        }
        let d = max - min;
        let s = if l > 0.5 {
            d / (2.0 - max - min)
        } else {
            d / (max + min)
        };
        let h = if (max - r).abs() < f64::EPSILON {
            (g - b) / d + if g < b { 6.0 } else { 0.0 }
        } else if (max - g).abs() < f64::EPSILON {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        };
        (h * 60.0, s, l)
    }

    fn from_hsl(h: f64, s: f64, l: f64) -> Rgb {
        if s == 0.0 {
            let v = (l * 255.0).round() as u8;
            return Rgb(v, v, v);
        }
        let q = if l < 0.5 {
            l * (1.0 + s)
        } else {
            l + s - l * s
        };
        let p = 2.0 * l - q;
        let channel = |mut t: f64| {
            if t < 0.0 {
                t += 1.0;
            }
            if t > 1.0 {
                t -= 1.0;
            }
            let v = if t < 1.0 / 6.0 {
                p + (q - p) * 6.0 * t
            } else if t < 0.5 {
                q
            } else if t < 2.0 / 3.0 {
                p + (q - p) * (2.0 / 3.0 - t) * 6.0
            } else {
                p
            };
            (v * 255.0).round() as u8
        };
        let h = h / 360.0;
        Rgb(channel(h + 1.0 / 3.0), channel(h), channel(h - 1.0 / 3.0))
    }
}

/// WCAG contrast ratio between two colors, from 1 to 21.
pub fn contrast(a: Rgb, b: Rgb) -> f64 {
    let (la, lb) = (a.luminance(), b.luminance());
    let (hi, lo) = if la > lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

fn min_contrast(color: Rgb, backgrounds: &[Rgb]) -> f64 {
    backgrounds
        .iter()
        .map(|b| contrast(color, *b))
        .fold(f64::INFINITY, f64::min)
}

/// How an accent had to change to stay readable.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shift {
    Unchanged,
    Darker,
    Lighter,
}

/// Move `color`'s lightness the least that reaches `target` against every background, keeping hue and
/// saturation. `None` when neither direction can reach it.
pub fn readable_on(color: Rgb, backgrounds: &[Rgb], target: f64) -> Option<(Rgb, Shift)> {
    if min_contrast(color, backgrounds) >= target {
        return Some((color, Shift::Unchanged));
    }
    let (h, s, l) = color.to_hsl();
    let search = |direction: f64| -> Option<(Rgb, f64)> {
        let mut step = 1;
        loop {
            let next = l + direction * f64::from(step) * 0.005;
            if !(0.0..=1.0).contains(&next) {
                return None;
            }
            let candidate = Rgb::from_hsl(h, s, next);
            if min_contrast(candidate, backgrounds) >= target {
                return Some((candidate, f64::from(step) * 0.005));
            }
            step += 1;
        }
    };
    match (search(-1.0), search(1.0)) {
        (Some((dark, d)), Some((light, u))) => Some(if d <= u {
            (dark, Shift::Darker)
        } else {
            (light, Shift::Lighter)
        }),
        (Some((dark, _)), None) => Some((dark, Shift::Darker)),
        (None, Some((light, _))) => Some((light, Shift::Lighter)),
        (None, None) => None,
    }
}

/// The text color to put on `background`: white, the theme's ink, or pure black, whichever reads best
/// (white and ink first; black only when neither reaches AA).
pub fn text_on(background: Rgb, ink: Rgb) -> Rgb {
    let white = Rgb(255, 255, 255);
    let best = if contrast(white, background) >= contrast(ink, background) {
        white
    } else {
        ink
    };
    if contrast(best, background) >= TEXT {
        best
    } else if contrast(white, background) >= contrast(Rgb(0, 0, 0), background) {
        white
    } else {
        Rgb(0, 0, 0)
    }
}

/// The colors of a scheme the accent has to be readable against.
#[derive(Clone, Debug, PartialEq)]
pub struct Ground {
    pub page: Rgb,
    pub surface: Rgb,
    pub surface_raised: Option<Rgb>,
    pub text: Rgb,
    pub ink: Rgb,
}

impl Ground {
    fn backgrounds(&self) -> Vec<Rgb> {
        let mut all = vec![self.page, self.surface];
        all.extend(self.surface_raised);
        all
    }
}

/// Everything derived from an accent for one scheme.
#[derive(Clone, Debug, PartialEq)]
pub struct AccentSet {
    pub accent: Rgb,
    pub accent_border: Rgb,
    pub accent_contrast: Rgb,
    pub glow: Rgb,
    pub shift: Shift,
}

/// Derive the accent set for one scheme at a contrast target (`TEXT` or `HIGH`). `None` means the
/// accent cannot be made readable on this ground.
pub fn derive_accent(accent: Rgb, ground: &Ground, target: f64) -> Option<AccentSet> {
    let backgrounds = ground.backgrounds();
    let (accent, shift) = readable_on(accent, &backgrounds, target)?;
    let accent_contrast = text_on(accent, ground.ink);

    // Border tint: as light a mix as still gives interface parts 3:1 on every background.
    let mut accent_border = accent;
    for step in 9..=20 {
        let candidate = ground.page.mix(accent, f64::from(step) * 0.05);
        if min_contrast(candidate, &backgrounds) >= PART {
            accent_border = candidate;
            break;
        }
    }

    // Glow: a faint wash of the accent that body text and accent text must stay readable on.
    let mut glow = ground.page;
    for step in (1..=6).rev() {
        let candidate = ground.page.mix(accent, f64::from(step) * 0.02);
        if contrast(ground.text, candidate) >= target.max(TEXT)
            && contrast(accent, candidate) >= target
        {
            glow = candidate;
            break;
        }
    }
    Some(AccentSet {
        accent,
        accent_border,
        accent_contrast,
        glow,
        shift,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const WHITE: Rgb = Rgb(255, 255, 255);

    fn rgb(hex: &str) -> Rgb {
        Rgb::parse(hex).unwrap()
    }

    fn light() -> Ground {
        Ground {
            page: rgb("#ffffff"),
            surface: rgb("#ffffff"),
            surface_raised: Some(rgb("#f1f3f6")),
            text: rgb("#14171c"),
            ink: rgb("#0b0d11"),
        }
    }

    fn dark() -> Ground {
        Ground {
            page: rgb("#0f1217"),
            surface: rgb("#161a21"),
            surface_raised: Some(rgb("#1d222b")),
            text: rgb("#eceff4"),
            ink: rgb("#0b0d11"),
        }
    }

    #[test]
    fn contrast_matches_the_wcag_reference_values() {
        assert!((contrast(Rgb(0, 0, 0), WHITE) - 21.0).abs() < 1e-9);
        assert!((contrast(WHITE, WHITE) - 1.0).abs() < 1e-9);
        // #767676 on white is the classic 4.54:1 pass.
        assert!((contrast(rgb("#767676"), WHITE) - 4.54).abs() < 0.01);
        assert!(contrast(rgb("#777777"), WHITE) > 4.4 && contrast(rgb("#777777"), WHITE) < 4.5);
    }

    #[test]
    fn hex_round_trips_and_rejects_non_hex() {
        assert_eq!(rgb("#2457d6").hex(), "#2457d6");
        assert_eq!(rgb("#ABC").hex(), "#aabbcc");
        assert_eq!(Rgb::parse("red"), None);
        assert_eq!(Rgb::parse("rgb(1,2,3)"), None);
        assert_eq!(Rgb::parse("#12345"), None);
    }

    #[test]
    fn a_readable_accent_is_left_alone_and_a_pale_one_is_darkened_minimally() {
        let (same, shift) = readable_on(rgb("#1d4bc2"), &[WHITE], TEXT).unwrap();
        assert_eq!((same, shift), (rgb("#1d4bc2"), Shift::Unchanged));
        let (fixed, shift) = readable_on(rgb("#ffe066"), &[WHITE], TEXT).unwrap();
        assert_eq!(shift, Shift::Darker);
        assert!(contrast(fixed, WHITE) >= TEXT);
        // Minimal: one step lighter would fail.
        assert!(
            contrast(fixed, WHITE) < TEXT + 0.35,
            "{}",
            contrast(fixed, WHITE)
        );
        // On a dark ground the same color is fine as is.
        let (_, shift) = readable_on(rgb("#ffe066"), &[rgb("#0f1217")], TEXT).unwrap();
        assert_eq!(shift, Shift::Unchanged);
    }

    #[test]
    fn every_accent_is_readable_in_both_schemes_or_clearly_refused() {
        let mut checked = 0;
        for r in (0..=255).step_by(51) {
            for g in (0..=255).step_by(51) {
                for b in (0..=255).step_by(51) {
                    let accent = Rgb(r as u8, g as u8, b as u8);
                    for ground in [light(), dark()] {
                        let backgrounds = ground.backgrounds();
                        let set = derive_accent(accent, &ground, TEXT)
                            .unwrap_or_else(|| panic!("{} should be fixable", accent.hex()));
                        assert!(
                            min_contrast(set.accent, &backgrounds) >= TEXT,
                            "{}",
                            accent.hex()
                        );
                        assert!(contrast(set.accent_contrast, set.accent) >= TEXT);
                        assert!(min_contrast(set.accent_border, &backgrounds) >= PART);
                        assert!(contrast(ground.text, set.glow) >= TEXT);
                        // A focus ring drawn in the accent is visible on every background.
                        assert!(min_contrast(set.accent, &backgrounds) >= PART);
                        checked += 1;
                    }
                }
            }
        }
        assert_eq!(checked, 6 * 6 * 6 * 2);
    }

    #[test]
    fn a_mid_gray_ground_can_make_an_accent_impossible() {
        let gray = Ground {
            page: rgb("#808080"),
            surface: rgb("#808080"),
            surface_raised: None,
            text: rgb("#000000"),
            ink: rgb("#000000"),
        };
        // Black on #808080 is only 5.3:1, so a 7:1 target cannot be met in either direction.
        assert!(derive_accent(rgb("#336699"), &gray, TEXT).is_some());
        assert!(derive_accent(rgb("#336699"), &gray, HIGH).is_none());
    }

    #[test]
    fn text_on_accent_prefers_white_or_ink_and_always_passes() {
        let ink = rgb("#0b0d11");
        for hex in [
            "#2457d6", "#ffe066", "#7aa2ff", "#b5451b", "#00ff00", "#777777",
        ] {
            let bg = rgb(hex);
            let fg = text_on(bg, ink);
            assert!(contrast(fg, bg) >= TEXT, "{hex}: {}", contrast(fg, bg));
        }
        assert_eq!(text_on(rgb("#2457d6"), ink), WHITE);
        assert_eq!(text_on(rgb("#ffe066"), ink), ink);
        // Mid tones where ink alone falls short fall back to pure black or white.
        assert_eq!(text_on(rgb("#777777"), ink), Rgb(0, 0, 0));
    }

    #[test]
    fn derivation_is_deterministic_and_golden() {
        let set = derive_accent(rgb("#b5451b"), &light(), TEXT).unwrap();
        assert_eq!(set, derive_accent(rgb("#b5451b"), &light(), TEXT).unwrap());
        assert_eq!(set.accent.hex(), "#b5451b");
        assert_eq!(set.accent_contrast, WHITE);
        let on_dark = derive_accent(rgb("#b5451b"), &dark(), TEXT).unwrap();
        assert_eq!(on_dark.shift, Shift::Lighter);
        assert_eq!(on_dark.accent.hex(), "#e06132");
    }

    #[test]
    fn higher_contrast_asks_for_more() {
        let standard = derive_accent(rgb("#2457d6"), &light(), TEXT).unwrap();
        let high = derive_accent(rgb("#2457d6"), &light(), HIGH).unwrap();
        assert!(contrast(high.accent, WHITE) >= HIGH);
        assert!(contrast(high.accent, WHITE) > contrast(standard.accent, WHITE));
    }
}
