use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

#[derive(Serialize, Debug, PartialEq)]
struct Stats {
    lines: usize,
    words: usize,
    characters: usize,
    bytes: usize,
}
#[derive(Deserialize)]
struct Heading {
    level: u8,
    start: usize,
    end: usize,
}
fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn stats(source: &str) -> Stats {
    let (mut lines, mut words, mut characters, mut in_word, mut previous) = (1, 0, 0, false, '\0');
    for c in source.chars() {
        characters += c.len_utf16();
        if c == '\r' || c == '\n' && previous != '\r' {
            lines += 1;
        }
        let next = !whitespace(c);
        if next && !in_word {
            words += 1;
        }
        in_word = next;
        previous = c;
    }
    Stats {
        lines,
        words,
        characters,
        bytes: source.len(),
    }
}
fn headings(input: &str, length: usize) -> Result<Vec<Heading>, String> {
    let values: Vec<Heading> =
        serde_json::from_str(input).map_err(|_| "Invalid heading JSON".to_string())?;
    if values.len() > 100_000 {
        return Err("Too many headings".into());
    }
    let mut previous = 0;
    for h in &values {
        if h.level < 1 || h.level > 6 || h.start < previous || h.end < h.start || h.end > length {
            return Err("Invalid heading range or level".into());
        }
        previous = h.start;
    }
    Ok(values)
}
fn sections(length: usize, heads: &[Heading]) -> Value {
    let mut output = Vec::with_capacity(heads.len() + 1);
    output.push(json!({"start":0,"bodyStart":0,"end":heads.first().map_or(length,|h|h.start)}));
    for (i, h) in heads.iter().enumerate() {
        output.push(json!({"start":h.start,"bodyStart":h.end,"end":heads.get(i+1).map_or(length,|next|next.start)}));
    }
    Value::Array(output)
}
fn lint(heads: &[Heading]) -> Value {
    let mut previous = 0;
    let mut output = Vec::new();
    for (index, h) in heads.iter().enumerate() {
        if previous > 0 && h.level > previous + 1 {
            output.push(json!({"index":index,"previous":previous,"level":h.level}));
        }
        previous = h.level;
    }
    Value::Array(output)
}
fn success(value: Value) -> String {
    json!({"ok":true,"value":value}).to_string()
}
fn error(message: &str) -> String {
    json!({"ok":false,"error":message}).to_string()
}
#[wasm_bindgen]
pub fn document_stats(source: &str) -> String {
    success(json!(stats(source)))
}
#[wasm_bindgen]
pub fn extract_sections(length: usize, input: &str) -> String {
    match headings(input, length) {
        Ok(h) => success(sections(length, &h)),
        Err(e) => error(&e),
    }
}
#[wasm_bindgen]
pub fn lint_structure(length: usize, input: &str) -> String {
    match headings(input, length) {
        Ok(h) => success(lint(&h)),
        Err(e) => error(&e),
    }
}
#[wasm_bindgen]
pub fn analyze_readme(source: &str, input: &str) -> String {
    let counts = stats(source);
    match headings(input, counts.characters) {
        Ok(h) => success(
            json!({"stats":counts,"sections":sections(counts.characters,&h),"headingSkips":lint(&h)}),
        ),
        Err(e) => error(&e),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_and_lines() {
        assert_eq!(
            stats("🌍\r\nHi\rbye\n"),
            Stats {
                lines: 4,
                words: 3,
                characters: 11,
                bytes: 13
            }
        );
    }
    #[test]
    fn whitespace_matches_ecmascript() {
        assert_eq!(stats("a\u{feff}b\u{0085}c").words, 2);
    }
    #[test]
    fn errors_are_structured() {
        assert!(analyze_readme("# A", "invalid").contains("\"ok\":false"));
        assert!(
            extract_sections(1, "[{\"level\":2,\"start\":9,\"end\":10}]").contains("\"ok\":false")
        );
    }
    #[test]
    fn malformed_markdown_is_only_text() {
        assert!(document_stats("<script>\n```\n🌍").contains("\"ok\":true"));
    }
    #[test]
    fn boundaries_and_lint() {
        let input = r#"[{"level":1,"start":0,"end":4},{"level":3,"start":6,"end":10}]"#;
        assert!(lint_structure(10, input).contains("\"index\":1"));
        assert!(extract_sections(10, input).contains("\"bodyStart\":4"));
    }
}
