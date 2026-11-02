//! The contract of the `job-draft` Assistant task (ADR 0303): what a provider may return when asked to turn a
//! job's notes into words, and the one deterministic check that stands between that result and the author's
//! editor. Pure: no file, clock or network.
//!
//! A draft is a title, a one-sentence description and the four scaffold sections (ADR 0287). It is plain text:
//! no HTML, no code fences, no headings, no front matter, no images. It can never carry a `job` field, because
//! the strict shape has no place for one; a result with any other key is refused whole.

use crate::job::SCAFFOLD_HEADINGS;
use serde::Serialize;
use serde_json::Value;

/// Longest title, in characters.
pub const MAX_TITLE_CHARS: usize = 120;
/// Longest description, in characters.
pub const MAX_DESCRIPTION_CHARS: usize = 300;
/// Longest text of one section, in characters.
pub const MAX_SECTION_CHARS: usize = 1_500;
/// The section keys, in the order of the scaffold headings.
pub const SECTION_KEYS: [&str; 4] = ["problem", "found", "did", "result"];

/// A validated job draft. Held as text only; applying it is the author's act.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct JobDraft {
    pub title: String,
    pub description: String,
    pub sections: JobDraftSections,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct JobDraftSections {
    pub problem: String,
    pub found: String,
    pub did: String,
    pub result: String,
}

impl JobDraftSections {
    fn in_order(&self) -> [&str; 4] {
        [&self.problem, &self.found, &self.did, &self.result]
    }
}

impl JobDraft {
    /// The scaffold body this draft fills: each heading with its section under it. An empty section keeps
    /// its heading and an empty line, exactly as the blank scaffold does.
    pub fn body(&self) -> String {
        let mut body = String::new();
        for (heading, text) in SCAFFOLD_HEADINGS.iter().zip(self.sections.in_order()) {
            body.push_str(&format!("## {heading}\n\n"));
            if !text.is_empty() {
                body.push_str(text);
                body.push_str("\n\n");
            }
        }
        body
    }

    /// Check a provider's result against the contract. The reason is one plain sentence fragment and names
    /// nothing from the result itself, so it is safe to show.
    pub fn from_json(value: &Value) -> Result<Self, String> {
        let object = value.as_object().ok_or("the result was not an object")?;
        for key in object.keys() {
            if !["title", "description", "sections"].contains(&key.as_str()) {
                return Err("it carried a field other than title, description and sections".into());
            }
        }
        let title = line(object.get("title"), "title", MAX_TITLE_CHARS)?;
        if title.is_empty() {
            return Err("the title was empty".into());
        }
        let description = line(
            object.get("description"),
            "description",
            MAX_DESCRIPTION_CHARS,
        )?;
        let sections = object
            .get("sections")
            .and_then(Value::as_object)
            .ok_or("it had no sections")?;
        for key in sections.keys() {
            if !SECTION_KEYS.contains(&key.as_str()) {
                return Err(
                    "it carried a section other than problem, found, did and result".into(),
                );
            }
        }
        let section = |key: &str| block(sections.get(key), key);
        let sections = JobDraftSections {
            problem: section("problem")?,
            found: section("found")?,
            did: section("did")?,
            result: section("result")?,
        };
        if sections.in_order().iter().all(|text| text.is_empty()) {
            return Err("every section was empty".into());
        }
        Ok(Self {
            title,
            description,
            sections,
        })
    }
}

/// Why a text is not plain prose, or `None`. Shared by every field.
fn markup_problem(text: &str) -> Option<&'static str> {
    let bytes = text.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'<' {
            let next = bytes.get(index + 1).copied().unwrap_or(b' ');
            if next.is_ascii_alphabetic() || matches!(next, b'/' | b'!' | b'?') {
                return Some("it contained HTML");
            }
        }
    }
    if text.contains("```") || text.contains("~~~") {
        return Some("it contained a code fence");
    }
    if text.contains("![") {
        return Some("it contained an image");
    }
    for line in text.lines() {
        let line = line.trim();
        if line == "---" || line == "+++" || line == "..." {
            return Some("it contained front matter");
        }
        if line.starts_with('#') {
            return Some("it contained a heading");
        }
    }
    None
}

fn line(value: Option<&Value>, name: &str, max: usize) -> Result<String, String> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("the {name} was missing or not text"))?
        .trim();
    if text.chars().any(char::is_control) {
        return Err(format!("the {name} was not a single line of text"));
    }
    if text.chars().count() > max {
        return Err(format!("the {name} was longer than {max} characters"));
    }
    if let Some(problem) = markup_problem(text) {
        return Err(format!("the {name} was refused because {problem}"));
    }
    Ok(text.to_string())
}

fn block(value: Option<&Value>, name: &str) -> Result<String, String> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("the {name} section was missing or not text"))?
        .replace("\r\n", "\n");
    let text = text.trim();
    if text.chars().any(|c| c.is_control() && c != '\n') {
        return Err(format!("the {name} section held a control character"));
    }
    if text.chars().count() > MAX_SECTION_CHARS {
        return Err(format!(
            "the {name} section was longer than {MAX_SECTION_CHARS} characters"
        ));
    }
    if let Some(problem) = markup_problem(text) {
        return Err(format!("the {name} section was refused because {problem}"));
    }
    Ok(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn good() -> Value {
        json!({
            "title": "Water heater swap in Dunmore",
            "description": "Replaced a leaking tank heater in an afternoon.",
            "sections": {
                "problem": "The old tank leaked at the base.",
                "found": "A corroded drain valve.",
                "did": "Drained it and fitted a new 40 gallon tank.",
                "result": ""
            }
        })
    }

    #[test]
    fn a_good_draft_is_kept_and_fills_the_scaffold() {
        let draft = JobDraft::from_json(&good()).unwrap();
        assert_eq!(draft.title, "Water heater swap in Dunmore");
        let body = draft.body();
        assert!(body
            .starts_with("## Problem\n\nThe old tank leaked at the base.\n\n## What we found\n"));
        assert!(body.ends_with("## Result\n\n"));
    }

    #[test]
    fn a_blank_draft_body_is_the_blank_scaffold() {
        let mut value = good();
        value["sections"] = json!({ "problem": "", "found": "", "did": "", "result": "" });
        assert!(JobDraft::from_json(&value).is_err());
        let empty = JobDraft {
            title: "t".into(),
            description: String::new(),
            sections: JobDraftSections {
                problem: String::new(),
                found: String::new(),
                did: String::new(),
                result: String::new(),
            },
        };
        assert_eq!(empty.body(), crate::job::scaffold_body());
    }

    #[test]
    fn an_extra_field_is_refused_so_a_draft_can_never_fill_job_fields() {
        for extra in ["job", "frontMatter", "slug", "draft"] {
            let mut value = good();
            value[extra] = json!({ "trade": "plumbing" });
            let reason = JobDraft::from_json(&value).unwrap_err();
            assert!(reason.contains("other than title"), "{extra}: {reason}");
        }
        let mut value = good();
        value["sections"]["extra"] = json!("x");
        assert!(JobDraft::from_json(&value).is_err());
    }

    #[test]
    fn markup_fences_headings_front_matter_and_images_are_refused() {
        for bad in [
            "<b>bold</b>",
            "<script>x</script>",
            "```rust\nfn main(){}\n```",
            "~~~\ncode\n~~~",
            "## A heading",
            "---\ntitle: x\n---",
            "![photo](/x.png)",
        ] {
            let mut value = good();
            value["sections"]["did"] = json!(bad);
            assert!(JobDraft::from_json(&value).is_err(), "{bad}");
        }
        let mut value = good();
        value["title"] = json!("Two\nlines");
        assert!(JobDraft::from_json(&value).is_err());
        value["title"] = json!("a < b and 3 < 5");
        assert!(JobDraft::from_json(&value).is_ok());
    }

    #[test]
    fn every_field_is_bounded() {
        let mut value = good();
        value["title"] = json!("x".repeat(MAX_TITLE_CHARS + 1));
        assert!(JobDraft::from_json(&value).unwrap_err().contains("title"));
        let mut value = good();
        value["description"] = json!("x".repeat(MAX_DESCRIPTION_CHARS + 1));
        assert!(JobDraft::from_json(&value).is_err());
        let mut value = good();
        value["sections"]["result"] = json!("x".repeat(MAX_SECTION_CHARS + 1));
        assert!(JobDraft::from_json(&value).is_err());
        let mut value = good();
        value["title"] = json!("   ");
        assert!(JobDraft::from_json(&value).is_err());
        assert!(JobDraft::from_json(&json!("text")).is_err());
    }
}
