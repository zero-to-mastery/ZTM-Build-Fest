//! Recipes: a post with `profile: recipe` in its front matter gets a summary card
//! (times, servings), interactive ingredients and steps, and schema.org
//! `Recipe` data so search engines can show it as a recipe.
//!
//! Writers use plain Markdown: an "Ingredients" heading followed by a list, and
//! a "Steps" (or "Method", "Instructions", "Directions") heading followed by a
//! list. Times and servings come from the front matter.

use crate::frontmatter::FrontMatter;

/// What a heading introduces, if it starts a recipe section.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Ingredients,
    Steps,
}

impl Section {
    pub fn class(self) -> &'static str {
        match self {
            Section::Ingredients => "ingredients",
            Section::Steps => "steps",
        }
    }
}

/// Classify a heading's text. Matches whole words: "Steps", "Ingredients for
/// the sauce" and "Method:" count, "Stephanie's story" and "Methodology" do
/// not. Common equivalents in a few other languages work too.
pub fn classify_heading(text: &str) -> Option<Section> {
    // Word processors type a curly apostrophe: "You’ll need".
    let t = text
        .trim()
        .trim_end_matches(':')
        .trim()
        .to_lowercase()
        .replace('\u{2019}', "'");
    const INGREDIENTS: &[&str] = &[
        "ingredient",
        "ingrédient",
        "ingrediente",
        "ingredienti",
        "ingrediënten",
        "zutaten",
        "what you need",
        "you will need",
        "you'll need",
    ];
    const STEPS: &[&str] = &[
        "step",
        "method",
        "instruction",
        "direction",
        "preparation",
        "how to make",
        "étapes",
        "préparation",
        "instrucciones",
        "preparación",
        "pasos",
        "elaboración",
        "procedimiento",
        "procedimento",
        "preparazione",
        "zubereitung",
        "anleitung",
        "bereiding",
    ];
    // The keyword, an optional plural ending, then the end or a non-letter.
    let matches = |word: &str| {
        let Some(rest) = t.strip_prefix(word) else {
            return false;
        };
        let rest = ["es", "s", "en", "i"]
            .iter()
            .find_map(|suffix| rest.strip_prefix(suffix))
            .filter(|r| !r.starts_with(char::is_alphanumeric))
            .unwrap_or(rest);
        !rest.starts_with(char::is_alphanumeric)
    };
    if INGREDIENTS.iter().any(|w| matches(w)) {
        Some(Section::Ingredients)
    } else if STEPS.iter().any(|w| matches(w)) {
        Some(Section::Steps)
    } else {
        None
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Recipe {
    /// Number of servings (the first number in `servings`); enables scaling.
    pub servings: Option<u32>,
    /// `servings` as written ("4", "4-6").
    pub servings_text: Option<String>,
    /// What the recipe makes ("12 cookies", "1 loaf"), from `yield` or `makes`.
    pub yield_text: Option<String>,
    /// Minutes, when the time could be read.
    pub prep: Option<u32>,
    pub cook: Option<u32>,
    pub total: Option<u32>,
    /// A time as written when it is not a single length ("overnight",
    /// "10-15 min"): shown on the card as is, left out of the search data.
    pub prep_text: Option<String>,
    pub cook_text: Option<String>,
    pub total_text: Option<String>,
    pub cuisine: Option<String>,
    pub category: Option<String>,
    /// Free text, for example "520 kcal".
    pub calories: Option<String>,
    /// Plain text of each ingredient line, in order.
    pub ingredients: Vec<String>,
    /// Plain text of each step, in order.
    pub steps: Vec<String>,
    /// Id of the first recipe heading, the target of "Jump to recipe".
    pub anchor: Option<String>,
}

/// True when the front matter marks the post as a recipe.
pub fn is_recipe(fm: &FrontMatter) -> bool {
    crate::profile::resolve(fm).behavior == crate::profile::ProfileBehavior::Recipe
}

impl Recipe {
    /// The card's facts (`<div><dt>..</dt><dd>..</dd></div>` rows, escaped):
    /// times, servings, yield, cuisine, course, and calories. `scalable` wraps
    /// a plain servings number in the span the scaling component updates.
    pub(crate) fn facts_html(&self, scalable: bool) -> String {
        use crate::escape::text;
        let mut facts = String::new();
        let mut fact = |label: &str, value: String| {
            facts.push_str(&format!("<div><dt>{label}</dt><dd>{value}</dd></div>"));
        };
        for (label, minutes, written) in [
            ("Prep", self.prep, &self.prep_text),
            ("Cook", self.cook, &self.cook_text),
            ("Total", self.total, &self.total_text),
        ] {
            if let Some(m) = minutes {
                fact(
                    label,
                    format!(
                        "<time datetime=\"{}\">{}</time>",
                        iso_duration(m),
                        format_minutes(m)
                    ),
                );
            } else if let Some(w) = written {
                // "overnight", "10-15 min": shown as written.
                fact(label, text(w));
            }
        }
        if let Some(s) = &self.servings_text {
            let value = if scalable && self.servings.is_some_and(|n| s.parse::<u32>() == Ok(n)) {
                format!("<span class=\"ob-recipe-servings\">{}</span>", text(s))
            } else {
                text(s)
            };
            fact("Serves", value);
        }
        for (label, value) in [
            ("Makes", &self.yield_text),
            ("Cuisine", &self.cuisine),
            ("Course", &self.category),
            ("Calories", &self.calories),
        ] {
            if let Some(v) = value {
                fact(label, text(v));
            }
        }
        facts
    }

    /// Read the recipe facts from front matter; the lists come from the body.
    /// A time that is not one length of time is kept as text rather than
    /// failing the build: cooks write "overnight" and "10-15 min".
    pub fn from_front_matter(
        fm: &FrontMatter,
        ingredients: Vec<String>,
        steps: Vec<String>,
    ) -> Recipe {
        let get = |keys: &[&str]| {
            keys.iter()
                .find_map(|k| fm.get(k))
                .map(str::trim)
                .filter(|v| !v.is_empty())
        };
        let time = |keys: &[&str]| -> (Option<u32>, Option<String>) {
            match get(keys) {
                None => (None, None),
                Some(raw) => match parse_minutes(raw) {
                    Some(m) => (Some(m), None),
                    None => (None, Some(raw.to_string())),
                },
            }
        };
        let servings_raw = get(&["servings", "serves"]);
        let servings = servings_raw.and_then(|s| {
            s.split(|c: char| !c.is_ascii_digit())
                .find(|p| !p.is_empty())
                .and_then(|n| n.parse::<u32>().ok())
                .filter(|n| (1..=10_000).contains(n))
        });
        let (prep, prep_text) = time(&["prepTime", "prep", "prep_time"]);
        let (cook, cook_text) = time(&["cookTime", "cook", "cook_time"]);
        let (total, total_text) = time(&["totalTime", "total", "total_time"]);
        let total = total.or(match (prep, cook) {
            (Some(p), Some(c)) if total_text.is_none() => p.checked_add(c),
            _ => None,
        });
        Recipe {
            servings,
            servings_text: servings_raw.map(str::to_string),
            yield_text: get(&["yield", "makes"]).map(str::to_string),
            prep,
            cook,
            total,
            prep_text,
            cook_text,
            total_text,
            cuisine: get(&["cuisine"]).map(str::to_string),
            category: get(&["course", "category", "recipeCategory"]).map(str::to_string),
            calories: get(&["calories"]).map(str::to_string),
            ingredients,
            steps,
            anchor: None,
        }
    }
}

/// Longest time accepted: 30 days. Anything longer is surely a typo.
const MAX_MINUTES: f64 = 60.0 * 24.0 * 30.0;

/// Minutes in a duration written by a person: `15`, `15 min`, `1 hr 30 min`,
/// `1h30m`, `1.5 hours`, `1 1/2 hours`, `1½ hours`, `1:30` (hours:minutes),
/// or ISO 8601 `PT1H30M`. `None` for anything else, including ranges.
pub fn parse_minutes(input: &str) -> Option<u32> {
    let s = input.trim().to_lowercase();
    if s.is_empty() {
        return None;
    }
    if let Some(iso) = s.strip_prefix("pt") {
        return parse_units(iso);
    }
    if let Some((h, m)) = s.split_once(':') {
        let h: u32 = h.trim().parse().ok()?;
        let m: u32 = m.trim().parse().ok()?;
        let total = h.checked_mul(60)?.checked_add(m)?;
        return (m < 60 && f64::from(total) <= MAX_MINUTES).then_some(total);
    }
    parse_units(&s)
}

const UNICODE_FRACTIONS: &[(char, f64)] = &[
    ('½', 0.5),
    ('⅓', 1.0 / 3.0),
    ('⅔', 2.0 / 3.0),
    ('¼', 0.25),
    ('¾', 0.75),
    ('⅛', 0.125),
    ('⅜', 0.375),
    ('⅝', 0.625),
    ('⅞', 0.875),
];

/// A number at the start of `s`: `2`, `1.5`, `1,5`, `1/2`, `1 1/2`, `1½`,
/// `1 ½`, or `½`. Returns the value and the rest of the text.
fn leading_number(s: &str) -> Option<(f64, &str)> {
    let unicode = |c: char| {
        UNICODE_FRACTIONS
            .iter()
            .find(|(u, _)| *u == c)
            .map(|(_, v)| *v)
    };
    let digits = |t: &str| t.find(|c: char| !c.is_ascii_digit()).unwrap_or(t.len());
    if let Some(v) = s.chars().next().and_then(unicode) {
        return Some((v, &s[s.chars().next()?.len_utf8()..]));
    }
    let whole_len = digits(s);
    if whole_len == 0 {
        return None;
    }
    let mut value: f64 = s[..whole_len].parse().ok()?;
    let mut rest = &s[whole_len..];
    // A decimal part: 1.5 or 1,5.
    if let Some(after) = rest.strip_prefix(['.', ',']) {
        let n = digits(after);
        if n > 0 {
            value = format!("{}.{}", &s[..whole_len], &after[..n])
                .parse()
                .ok()?;
            return Some((value, &after[n..]));
        }
    }
    // A fraction right after: 1/2 (then the whole part was the numerator).
    if let Some(after) = rest.strip_prefix(['/', '⁄']) {
        let n = digits(after);
        let den: f64 = after[..n].parse().ok().filter(|d: &f64| *d > 0.0)?;
        return Some((value / den, &after[n..]));
    }
    // A mixed number: 1 1/2, 1½, 1 ½.
    let spaced = rest.trim_start_matches(' ');
    if let Some(v) = spaced.chars().next().and_then(unicode) {
        return Some((value + v, &spaced[spaced.chars().next()?.len_utf8()..]));
    }
    let num_len = digits(spaced);
    // strip_prefix respects the width of '⁄' (three bytes), unlike slicing past it.
    let slash = spaced[num_len..].strip_prefix(['/', '⁄']);
    if let (true, Some(after)) = (num_len > 0 && spaced.len() != rest.len(), slash) {
        let den_len = digits(after);
        if den_len > 0 {
            let num: f64 = spaced[..num_len].parse().ok()?;
            let den: f64 = after[..den_len].parse().ok()?;
            if den > 0.0 && num < den {
                value += num / den;
                rest = &after[den_len..];
            }
        }
    }
    Some((value, rest))
}

/// Sum `<number><unit>` pairs; units are hours, minutes and seconds in their
/// usual spellings, and a bare number is minutes. Anything else (a range,
/// "overnight", days) makes the whole value unrecognised.
fn parse_units(s: &str) -> Option<u32> {
    let mut total = 0.0f64;
    let mut rest = s.trim();
    let mut found = false;
    while !rest.is_empty() {
        let (n, after) = leading_number(rest)?;
        rest = after.trim_start();
        let unit_len = rest
            .find(|c: char| !c.is_alphabetic())
            .unwrap_or(rest.len());
        let unit = &rest[..unit_len];
        let factor = match unit {
            "h" | "hr" | "hrs" | "hour" | "hours" => 60.0,
            "" | "m" | "min" | "mins" | "minute" | "minutes" => 1.0,
            "s" | "sec" | "secs" | "second" | "seconds" => 1.0 / 60.0,
            _ => return None,
        };
        total += n * factor;
        found = true;
        rest = rest[unit_len..].trim_start_matches([' ', ',', '+']);
        rest = rest.strip_prefix("and").unwrap_or(rest).trim_start();
    }
    (found && total.is_finite() && (0.0..=MAX_MINUTES).contains(&total))
        .then_some(total.round() as u32)
}

/// `90` -> `1 hr 30 min`; `45` -> `45 min`.
pub fn format_minutes(minutes: u32) -> String {
    let (h, m) = (minutes / 60, minutes % 60);
    match (h, m) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} hr"),
        (h, m) => format!("{h} hr {m} min"),
    }
}

/// ISO 8601 duration for schema.org: `90` -> `PT1H30M`.
pub fn iso_duration(minutes: u32) -> String {
    let (h, m) = (minutes / 60, minutes % 60);
    match (h, m) {
        (0, m) => format!("PT{m}M"),
        (h, 0) => format!("PT{h}H"),
        (h, m) => format!("PT{h}H{m}M"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter;

    #[test]
    fn parses_durations_people_write() {
        for (input, want) in [
            ("15", Some(15)),
            ("15 min", Some(15)),
            ("15 minutes", Some(15)),
            ("1 hr 30 min", Some(90)),
            ("1h30m", Some(90)),
            ("1.5 hours", Some(90)),
            ("2 hours and 5 minutes", Some(125)),
            ("1:30", Some(90)),
            ("PT1H30M", Some(90)),
            ("pt45m", Some(45)),
            ("90 sec", Some(2)),
            ("1 1/2 hours", Some(90)),
            ("1 1⁄2 hours", Some(90)),
            ("1⁄2 hr", Some(30)),
            ("1½ hours", Some(90)),
            ("1 ½ hr", Some(90)),
            ("½ hour", Some(30)),
            ("10-15 min", None),
            ("inf", None),
            ("1e3", None),
            ("4294967295", None),
            ("71582789:00", None),
            ("overnight", None),
            ("1:75", None),
            ("", None),
        ] {
            assert_eq!(parse_minutes(input), want, "{input}");
        }
        assert_eq!(format_minutes(90), "1 hr 30 min");
        assert_eq!(format_minutes(120), "2 hr");
        assert_eq!(format_minutes(5), "5 min");
        assert_eq!(iso_duration(90), "PT1H30M");
        assert_eq!(iso_duration(60), "PT1H");
    }

    #[test]
    fn classifies_section_headings() {
        assert_eq!(classify_heading("Ingredients"), Some(Section::Ingredients));
        assert_eq!(
            classify_heading("Ingredients for the sauce:"),
            Some(Section::Ingredients)
        );
        assert_eq!(classify_heading("Zutaten"), Some(Section::Ingredients));
        assert_eq!(classify_heading("Method"), Some(Section::Steps));
        assert_eq!(classify_heading("Instructions"), Some(Section::Steps));
        assert_eq!(classify_heading("Steps"), Some(Section::Steps));
        assert_eq!(classify_heading("Préparation"), Some(Section::Steps));
        assert_eq!(classify_heading("Why this works"), None);
        assert_eq!(classify_heading("Ingrédients"), Some(Section::Ingredients));
        assert_eq!(classify_heading("Pasos"), Some(Section::Steps));
        assert_eq!(classify_heading("You’ll need"), Some(Section::Ingredients));
        assert_eq!(classify_heading("Step 1: the dough"), Some(Section::Steps));
        for not_a_section in [
            "Stephanie's story",
            "Stepping back",
            "Methodology",
            "Ingredientsfoo",
        ] {
            assert_eq!(classify_heading(not_a_section), None, "{not_a_section}");
        }
    }

    #[test]
    fn reads_recipe_front_matter() {
        let doc = frontmatter::parse(
            "---\ntitle: Pasta\nrecipe: true\nservings: 4\nprep: 10 min\ncook: 20 min\ncuisine: Italian\ncourse: Dinner\n---\nbody",
        )
        .unwrap();
        assert!(is_recipe(&doc.front_matter));
        let r = Recipe::from_front_matter(&doc.front_matter, vec!["a".into()], vec![]);
        assert_eq!(r.servings, Some(4));
        assert_eq!(r.servings_text.as_deref(), Some("4"));
        assert_eq!(r.yield_text, None);
        assert_eq!((r.prep, r.cook, r.total), (Some(10), Some(20), Some(30)));
        assert_eq!(r.cuisine.as_deref(), Some("Italian"));
        assert_eq!(r.category.as_deref(), Some("Dinner"));

        let doc = frontmatter::parse(
            "---\ntype: recipe\nserves: 4-6\nmakes: 1 loaf\ncook: overnight\n---\n",
        )
        .unwrap();
        assert!(is_recipe(&doc.front_matter));
        let r = Recipe::from_front_matter(&doc.front_matter, vec![], vec![]);
        assert_eq!(r.cook, None, "not one length of time");
        assert_eq!(
            r.cook_text.as_deref(),
            Some("overnight"),
            "kept to show as written"
        );
        let doc = frontmatter::parse("---\ntype: recipe\nserves: 4-6\n---\n").unwrap();
        let r = Recipe::from_front_matter(&doc.front_matter, vec![], vec![]);
        assert_eq!(r.servings, Some(4), "scaling starts from the first number");
        assert_eq!(r.servings_text.as_deref(), Some("4-6"));
        assert_eq!(r.yield_text, None);
        let doc = frontmatter::parse("---\nrecipe: true\nmakes: 1 loaf\n---\n").unwrap();
        let r = Recipe::from_front_matter(&doc.front_matter, vec![], vec![]);
        assert_eq!(
            (r.servings, r.yield_text.as_deref()),
            (None, Some("1 loaf"))
        );
        assert!(!is_recipe(
            &frontmatter::parse("---\ntitle: x\n---\n")
                .unwrap()
                .front_matter
        ));
    }
}
