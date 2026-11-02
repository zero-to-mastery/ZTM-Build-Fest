//! The `compare` fence: a before and after pair as data the engine understands (ADR 0291).
//!
//! ````text
//! ```compare
//! before: /images/floor-before.jpg
//! before-alt: The old floor, stained and cracked along the door
//! before-caption: Day one
//! after: /images/floor-after.jpg
//! after-alt: The same floor, sanded and sealed
//! after-label: Finished
//! ```
//! ````
//!
//! One `key: value` per line. `before`, `before-alt`, `after` and `after-alt` are required; a
//! caption and a label are optional, and the labels default to "Before" and "After". Anything
//! else that reads the Markdown shows an ordinary code block, so the source is never lost.
//!
//! The native page gets an `ob-compare` element holding two captioned figures, so a reader
//! without JavaScript, or one who prefers reduced motion, sees the two pictures side by side.
//! A portable copy (feeds, syndication, export) is those same two figures and nothing else.

use crate::escape::{attr, text};
use crate::landing::{safe_address, MAX_ALT_CHARS, MAX_LABEL_CHARS, MAX_LINE_CHARS, MAX_URL_BYTES};

/// The capability a `compare` fence reports.
pub const CAPABILITY_ID: &str = "before-after";
/// The fence's info string.
pub const FENCE: &str = "compare";
/// The custom element that presents the pair on a page.
pub const ELEMENT: &str = "ob-compare";

const MAX_LABEL: usize = MAX_LABEL_CHARS / 2;

/// One side of the pair.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Side {
    pub src: String,
    pub alt: String,
    pub caption: String,
    pub label: String,
}

impl Side {
    /// The text under the picture: its label, then its caption when there is one.
    fn caption_text(&self) -> String {
        if self.caption.is_empty() {
            self.label.clone()
        } else {
            format!("{}: {}", self.label, self.caption)
        }
    }
}

/// A validated before and after pair.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Comparison {
    pub before: Side,
    pub after: Side,
}

#[derive(Default)]
struct Draft {
    src: Option<String>,
    alt: Option<String>,
    caption: Option<String>,
    label: Option<String>,
}

fn is_image_line(key: &str) -> bool {
    matches!(key, "before" | "after")
}

/// Read and check a fence body. Every problem is a plain sentence the author can act on.
pub fn parse(source: &str) -> Result<Comparison, Vec<String>> {
    let mut problems = Vec::new();
    let mut before = Draft::default();
    let mut after = Draft::default();
    for line in source.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            problems.push(format!(
                "`{line}` is not a `key: value` line; write lines such as `before: /images/a.jpg`"
            ));
            continue;
        };
        let (key, value) = (key.trim().to_ascii_lowercase(), value.trim());
        let (side, field) = match key.split_once('-') {
            Some((side, field)) => (side, field),
            None => (key.as_str(), "src"),
        };
        let draft = match side {
            "before" => &mut before,
            "after" => &mut after,
            _ => {
                problems.push(format!(
                    "`{key}` is not a field of a before and after pair; use before, before-alt, before-caption, before-label, and the same four for after"
                ));
                continue;
            }
        };
        let slot = match field {
            "src" => &mut draft.src,
            "alt" => &mut draft.alt,
            "caption" => &mut draft.caption,
            "label" => &mut draft.label,
            _ => {
                problems.push(format!(
                    "`{key}` is not a field of a before and after pair; use before, before-alt, before-caption, before-label, and the same four for after"
                ));
                continue;
            }
        };
        if slot.is_some() {
            problems.push(format!("`{key}` is written twice; keep one"));
            continue;
        }
        *slot = Some(value.to_string());
    }
    let before = side("before", "Before", before, &mut problems);
    let after = side("after", "After", after, &mut problems);
    match (before, after, problems.is_empty()) {
        (Some(before), Some(after), true) => Ok(Comparison { before, after }),
        _ => Err(problems),
    }
}

fn side(name: &str, default_label: &str, draft: Draft, problems: &mut Vec<String>) -> Option<Side> {
    let start = problems.len();
    let src = draft.src.unwrap_or_default();
    if src.is_empty() {
        problems.push(format!(
            "the {name} picture is missing; add a `{name}:` line with its address"
        ));
    } else if src.len() > MAX_URL_BYTES || !safe_address(&src, true) {
        problems.push(format!(
            "the {name} picture's address must be an https:// address or a file on this site such as /images/{name}.jpg"
        ));
    }
    let alt = draft.alt.unwrap_or_default();
    if alt.is_empty() {
        problems.push(format!(
            "the {name} picture needs a description for people who cannot see it; add a `{name}-alt:` line"
        ));
    } else if alt.chars().count() > MAX_ALT_CHARS {
        problems.push(format!(
            "`{name}-alt` is longer than {MAX_ALT_CHARS} characters"
        ));
    }
    let caption = draft.caption.unwrap_or_default();
    if caption.chars().count() > MAX_LINE_CHARS {
        problems.push(format!(
            "`{name}-caption` is longer than {MAX_LINE_CHARS} characters"
        ));
    }
    let label = draft
        .label
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| default_label.to_string());
    if label.chars().count() > MAX_LABEL {
        problems.push(format!(
            "`{name}-label` is longer than {MAX_LABEL} characters"
        ));
    }
    for (field, value) in [("alt", &alt), ("caption", &caption), ("label", &label)] {
        if value.chars().any(char::is_control) {
            problems.push(format!("`{name}-{field}` has a control character"));
        }
    }
    (problems.len() == start).then_some(Side {
        src,
        alt,
        caption,
        label,
    })
}

/// Rewrite the address on each `before:` and `after:` line, leaving every other line as it was.
/// A portable copy uses this to turn site paths into absolute ones before it is checked.
pub fn map_sources(source: &str, mut map: impl FnMut(&str) -> String) -> String {
    let mut out = String::with_capacity(source.len());
    for line in source.split_inclusive('\n') {
        let body = line.trim_end_matches(['\r', '\n']);
        let ending = &line[body.len()..];
        let rewritten = body.split_once(':').and_then(|(key, value)| {
            let key = key.trim().to_ascii_lowercase();
            (is_image_line(&key) && !value.trim().is_empty())
                .then(|| format!("{key}: {}", map(value.trim())))
        });
        out.push_str(rewritten.as_deref().unwrap_or(body));
        out.push_str(ending);
    }
    out
}

impl Comparison {
    /// The pair as the page shows it: an `ob-compare` element around two captioned figures.
    /// The `<img src=` form is exact so the build's lazy-loading pass reaches both pictures.
    pub fn page_html(&self) -> String {
        format!(
            "<ob-compare class=\"ob-compare\">\n{}{}</ob-compare>\n",
            figure(&self.before, "ob-compare-pane ob-compare-before", true),
            figure(&self.after, "ob-compare-pane ob-compare-after", true),
        )
    }

    /// The pair in a feed, syndicated copy or export: two figures with captions and nothing else.
    /// Each address must already be absolute.
    pub fn portable_html(&self) -> String {
        format!(
            "{}{}",
            figure(&self.before, "ob-compare-pane", false),
            figure(&self.after, "ob-compare-pane", false)
        )
    }

    /// The pair as Markdown: each picture, then its caption in italics.
    pub fn portable_markdown(
        &self,
        resolve: &dyn Fn(&str) -> Result<String, String>,
    ) -> Result<String, String> {
        let mut out = String::new();
        for side in [&self.before, &self.after] {
            out.push_str(&format!(
                "![{}]({})\n\n*{}*\n\n",
                crate::portability::markdown_text(&side.alt),
                crate::portability::markdown_destination(&resolve(&side.src)?),
                crate::portability::markdown_text(&side.caption_text())
            ));
        }
        Ok(out.trim_end().to_string() + "\n")
    }

    /// Whether both pictures are at absolute `http` or `https` addresses.
    pub fn is_absolute(&self) -> bool {
        [&self.before, &self.after].iter().all(|side| {
            let lower = side.src.to_ascii_lowercase();
            lower.starts_with("https://") || lower.starts_with("http://")
        })
    }

    /// Words a portable copy must keep: both captions as they read.
    pub fn visible_text(&self) -> Vec<String> {
        vec![self.before.caption_text(), self.after.caption_text()]
    }
}

fn figure(side: &Side, class: &str, label_span: bool) -> String {
    let caption = if label_span {
        let rest = if side.caption.is_empty() {
            String::new()
        } else {
            format!(": {}", text(&side.caption))
        };
        format!(
            "<span class=\"ob-compare-label\">{}</span>{rest}",
            text(&side.label)
        )
    } else {
        text(&side.caption_text())
    };
    format!(
        "<figure class=\"{class}\"><img src=\"{}\" alt=\"{}\"><figcaption>{caption}</figcaption></figure>\n",
        attr(&side.src),
        attr(&side.alt),
    )
}

const KEYS: [&str; 8] = [
    "before",
    "before-alt",
    "before-caption",
    "before-label",
    "after",
    "after-alt",
    "after-caption",
    "after-label",
];

/// The form for a pair, in the same shape as a piece's (`piece::schema_json`), so the Admin's
/// Add something dialog can show it. It is kept apart from the pieces: a pair has no landing section.
pub fn schema_json() -> serde_json::Value {
    let field = |name: &str, label: &str, hint: &str, input: &str, required: bool, max: usize| {
        serde_json::json!({
            "name": name, "label": label, "hint": hint, "input": input,
            "required": required, "max": max,
        })
    };
    let side = |key: &str, title: &str, default_label: &str| {
        [
            field(
                key,
                &format!("{title} picture"),
                "Choose a file to upload, or type an https:// address or a file on this site such as /images/floor.jpg.",
                "image",
                true,
                MAX_URL_BYTES,
            ),
            field(
                &format!("{key}-alt"),
                &format!("{title} description"),
                "Describe the picture for someone who cannot see it. Required.",
                "text",
                true,
                MAX_ALT_CHARS,
            ),
            field(
                &format!("{key}-caption"),
                &format!("{title} caption"),
                "Optional text shown after the label.",
                "text",
                false,
                MAX_LINE_CHARS,
            ),
            field(
                &format!("{key}-label"),
                &format!("{title} label"),
                &format!("Leave empty for “{default_label}”."),
                "text",
                false,
                MAX_LABEL,
            ),
        ]
    };
    let mut fields = Vec::new();
    fields.extend(side("before", "Before", "Before"));
    fields.extend(side("after", "After", "After"));
    // Pictures and descriptions first, then captions and labels, as the dialog reads best that way.
    fields.sort_by_key(|f| {
        let name = f["name"].as_str().unwrap_or("");
        let rank = if name.ends_with("-caption") {
            2
        } else if name.ends_with("-label") {
            3
        } else {
            0
        };
        (rank, name.starts_with("after"))
    });
    serde_json::json!({
        "kind": FENCE, "section": null, "label": "Before and after",
        "summary": "Two pictures of the same thing, with a slider to compare them.",
        "fields": fields, "markdown": "directive",
    })
}

/// Build a pair from form values and validate it; every problem is reported.
pub fn from_values(values: &[(String, String)]) -> Result<Comparison, Vec<String>> {
    let mut problems = Vec::new();
    let mut source = String::new();
    for (name, value) in values {
        if !KEYS.contains(&name.as_str()) {
            problems.push(format!(
                "`{name}` is not a field of a before and after pair"
            ));
        } else if value.contains(['\n', '\r']) {
            problems.push(format!("`{name}` must be on one line"));
        } else {
            source.push_str(&format!("{name}: {value}\n"));
        }
    }
    match parse(&source) {
        Ok(pair) if problems.is_empty() => Ok(pair),
        Ok(_) => Err(problems),
        Err(found) => {
            problems.extend(found);
            Err(problems)
        }
    }
}

impl Comparison {
    /// The fence an author would write, with a label only where it is not the default.
    pub fn to_markdown(&self) -> String {
        let mut out = format!("```{FENCE}\n");
        for (key, side, default_label) in [
            ("before", &self.before, "Before"),
            ("after", &self.after, "After"),
        ] {
            out.push_str(&format!("{key}: {}\n{key}-alt: {}\n", side.src, side.alt));
            if !side.caption.is_empty() {
                out.push_str(&format!("{key}-caption: {}\n", side.caption));
            }
            if side.label != default_label {
                out.push_str(&format!("{key}-label: {}\n", side.label));
            }
        }
        out.push_str("```\n");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = "before: /images/a.jpg\nbefore-alt: A stained floor\nbefore-caption: Day one\nafter: https://example.com/b.jpg\nafter-alt: A sealed floor\nafter-label: Finished\n";

    #[test]
    fn reads_a_pair_with_default_and_custom_labels() {
        let pair = parse(FULL).unwrap();
        assert_eq!(pair.before.label, "Before");
        assert_eq!(pair.after.label, "Finished");
        assert_eq!(pair.before.caption_text(), "Before: Day one");
        assert_eq!(pair.after.caption_text(), "Finished");
    }

    #[test]
    fn missing_alt_text_is_a_plain_error() {
        let problems = parse("before: /a.jpg\nafter: /b.jpg\nafter-alt: B\n").unwrap_err();
        assert_eq!(
            problems,
            vec!["the before picture needs a description for people who cannot see it; add a `before-alt:` line"]
        );
    }

    #[test]
    fn reports_every_problem_at_once() {
        let problems = parse(
            "before: javascript:alert(1)\nbefore-alt: x\nsides: no\nafter-alt: y\nbefore-alt: z",
        )
        .unwrap_err();
        assert!(problems
            .iter()
            .any(|p| p.contains("before picture's address")));
        assert!(problems.iter().any(|p| p.contains("`sides`")));
        assert!(problems
            .iter()
            .any(|p| p.contains("`before-alt` is written twice")));
        assert!(problems
            .iter()
            .any(|p| p.contains("after picture is missing")));
    }

    #[test]
    fn page_html_is_one_element_around_two_captioned_figures() {
        let html = parse(FULL).unwrap().page_html();
        assert!(html.starts_with("<ob-compare class=\"ob-compare\">"));
        assert_eq!(html.matches("<figure").count(), 2);
        assert!(html.contains("<img src=\"/images/a.jpg\" alt=\"A stained floor\">"));
        assert!(html.contains("<span class=\"ob-compare-label\">Before</span>: Day one"));
    }

    #[test]
    fn portable_html_is_only_figures_images_and_captions() {
        let html = parse(FULL).unwrap().portable_html();
        let mut tags: Vec<_> = html
            .split('<')
            .skip(1)
            .map(|t| {
                t.split([' ', '>', '/'])
                    .find(|part| !part.is_empty())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        tags.sort();
        tags.dedup();
        assert_eq!(tags, ["figcaption", "figure", "img"]);
        assert!(html.contains("<figcaption>Before: Day one</figcaption>"));
    }

    #[test]
    fn values_are_escaped() {
        let pair = parse("before: /a.jpg\nbefore-alt: \"<b>\"\nafter: /b.jpg\nafter-alt: ok\nafter-caption: <script>").unwrap();
        let html = pair.page_html();
        assert!(
            !html.contains("<b>") && !html.contains("<script>"),
            "{html}"
        );
    }

    #[test]
    fn map_sources_only_touches_picture_lines() {
        let out = map_sources(FULL, |src| format!("https://x.test{src}"));
        assert!(out.contains("before: https://x.test/images/a.jpg\n"));
        assert!(out.contains("before-alt: A stained floor\n"));
    }

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn the_form_writes_a_fence_that_reads_back_the_same() {
        let pair = parse(FULL).unwrap();
        let markdown = pair.to_markdown();
        assert_eq!(
            markdown,
            "```compare\nbefore: /images/a.jpg\nbefore-alt: A stained floor\nbefore-caption: Day one\nafter: https://example.com/b.jpg\nafter-alt: A sealed floor\nafter-label: Finished\n```\n"
        );
        let body = markdown
            .trim_start_matches("```compare\n")
            .trim_end_matches("```\n");
        assert_eq!(parse(body).unwrap(), pair);
    }

    #[test]
    fn form_values_are_checked_and_every_problem_is_reported() {
        let ok = from_values(&pairs(&[
            ("before", "/a.jpg"),
            ("before-alt", "A"),
            ("after", "/b.jpg"),
            ("after-alt", "B"),
        ]))
        .unwrap();
        assert_eq!(ok.before.label, "Before");
        let problems = from_values(&pairs(&[
            ("before", "/a.jpg"),
            ("before-alt", ""),
            ("after", ""),
            ("after-alt", "B\nafter: /x.jpg"),
            ("shade", "dark"),
        ]))
        .unwrap_err();
        assert!(problems.iter().any(|p| p.contains("`shade`")));
        assert!(problems
            .iter()
            .any(|p| p.contains("`after-alt` must be on one line")));
        assert!(problems
            .iter()
            .any(|p| p.contains("before picture needs a description")));
        assert!(problems
            .iter()
            .any(|p| p.contains("after picture is missing")));
    }

    #[test]
    fn the_schema_asks_for_both_pictures_and_descriptions_first() {
        let schema = schema_json();
        let names: Vec<_> = schema["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, KEYS_IN_FORM_ORDER);
        assert_eq!(schema["fields"][0]["input"], "image");
        assert_eq!(schema["fields"][0]["required"], true);
        assert_eq!(schema["fields"][4]["required"], false);
    }

    const KEYS_IN_FORM_ORDER: [&str; 8] = [
        "before",
        "before-alt",
        "after",
        "after-alt",
        "before-caption",
        "after-caption",
        "before-label",
        "after-label",
    ];
}
