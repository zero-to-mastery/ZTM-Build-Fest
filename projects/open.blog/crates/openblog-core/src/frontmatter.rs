//! A deliberately small YAML-subset front matter parser.
//!
//! Supported:
//! - `key: value` scalars (bare, "double quoted", or 'single quoted')
//! - `key: [a, b, "c d"]` inline lists
//! - block lists:
//!   ```yaml
//!   tags:
//!     - rust
//!     - wasm
//!   ```
//! - `#` comments on their own line
//!
//! That covers what blog posts actually use (Hashnode, Hugo, Jekyll, Astro
//! exports) without pulling in a YAML dependency.

use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Scalar(String),
    List(Vec<String>),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FrontMatter {
    pub fields: BTreeMap<String, Value>,
}

/// A document split into front matter and body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Document {
    pub front_matter: FrontMatter,
    pub body: String,
    /// Line number (1-based) where the body starts; useful for error messages.
    pub body_line: usize,
}

impl FrontMatter {
    pub fn get(&self, key: &str) -> Option<&str> {
        match self.fields.get(key)? {
            Value::Scalar(s) => Some(s.as_str()),
            Value::List(items) => items.first().map(String::as_str),
        }
    }

    pub fn get_list(&self, key: &str) -> Vec<String> {
        match self.fields.get(key) {
            Some(Value::List(items)) => items.clone(),
            Some(Value::Scalar(s)) if !s.is_empty() => s
                .split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect(),
            _ => Vec::new(),
        }
    }

    pub fn get_bool(&self, key: &str) -> Option<bool> {
        match self.get(key)?.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" => Some(true),
            "false" | "no" | "off" => Some(false),
            _ => None,
        }
    }

    pub fn get_u32(&self, key: &str) -> Option<u32> {
        self.get(key)?.trim().parse().ok()
    }
}

/// Split `---` delimited front matter from the body and parse it.
/// Documents without front matter return an empty `FrontMatter`.
pub fn parse(source: &str) -> Result<Document, String> {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut lines = source.lines();
    let first = lines.next().unwrap_or("");
    if first.trim_end() != "---" {
        return Ok(Document {
            front_matter: FrontMatter::default(),
            body: source.to_string(),
            body_line: 1,
        });
    }
    let mut fm_lines = Vec::new();
    let mut line_no = 1;
    let mut closed = false;
    for line in lines.by_ref() {
        line_no += 1;
        let trimmed = line.trim_end();
        if trimmed == "---" || trimmed == "..." {
            closed = true;
            break;
        }
        fm_lines.push(line);
    }
    if !closed {
        return Err("front matter opened with --- but never closed".to_string());
    }
    let front_matter = parse_fields(&fm_lines)?;
    let body: Vec<&str> = lines.collect();
    Ok(Document {
        front_matter,
        body: body.join("\n"),
        body_line: line_no + 1,
    })
}

fn parse_fields(lines: &[&str]) -> Result<FrontMatter, String> {
    let mut fields = BTreeMap::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim_end();
        i += 1;
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            return Err(format!("unexpected indentation in front matter: `{line}`"));
        }
        let Some(colon) = find_key_colon(line) else {
            return Err(format!(
                "expected `key: value` in front matter, found `{line}`"
            ));
        };
        let key = line[..colon].trim().to_string();
        let rest = line[colon + 1..].trim();
        if rest.is_empty() && key == NESTED_KEY && next_is_mapping(lines, i) {
            let indent = indent_of(lines[next_significant(lines, i)])?;
            parse_nested(lines, &mut i, indent, &key, 1, &mut fields)?;
        } else if rest.is_empty() && key == FAQ_KEY && next_is_faq_entry(lines, i) {
            parse_faq(lines, &mut i, &mut fields)?;
        } else if rest.is_empty() {
            // A block list (or an empty scalar) follows.
            let mut items = Vec::new();
            while i < lines.len() {
                let next = lines[i];
                let t = next.trim();
                if t.is_empty() || t.starts_with('#') {
                    i += 1;
                    continue;
                }
                let indented = next.starts_with(' ') || next.starts_with('\t');
                if let Some(item) = t.strip_prefix("- ").or_else(|| (t == "-").then_some("")) {
                    items.push(unquote(item.trim()));
                    i += 1;
                } else if indented {
                    return Err(format!("unsupported nested value under `{key}`: `{t}`"));
                } else {
                    break;
                }
            }
            if items.is_empty() {
                fields.insert(key, Value::Scalar(String::new()));
            } else {
                fields.insert(key, Value::List(items));
            }
        } else if rest.starts_with('[') {
            let inner = rest.strip_prefix('[').and_then(|r| r.strip_suffix(']'));
            let Some(inner) = inner else {
                return Err(format!("unterminated inline list for `{key}`"));
            };
            fields.insert(key, Value::List(split_inline_list(inner)));
        } else {
            fields.insert(key, Value::Scalar(unquote(rest)));
        }
    }
    Ok(FrontMatter { fields })
}

/// The one key whose value may be a nested mapping (the `job` profile, ADR
/// 0285). It is stored flattened to dotted keys (`job.place.town`), so the
/// `Value` shape and every other key are exactly as before.
const NESTED_KEY: &str = "job";
const MAX_NESTING: usize = 3;

/// The one key whose value may be a list of mappings (a service's questions
/// and answers, ADR 0311). Entry `n` (counting from 1) is stored flattened as
/// `faq.<n>.question` and `faq.<n>.answer`, so the `Value` shape is unchanged.
/// A list whose first entry does not start `- question:` is an ordinary list.
const FAQ_KEY: &str = "faq";
const FAQ_PREFIX: &str = "faq.";
const MAX_FAQ_ENTRIES: usize = 100;

fn next_is_faq_entry(lines: &[&str], from: usize) -> bool {
    lines
        .get(next_significant(lines, from))
        .is_some_and(|line| line.starts_with(' ') && line.trim().starts_with("- question:"))
}

fn parse_faq(
    lines: &[&str],
    i: &mut usize,
    fields: &mut BTreeMap<String, Value>,
) -> Result<(), String> {
    let mut entry = 0;
    while *i < lines.len() {
        let line = lines[*i].trim_end();
        if is_skipped(line) {
            *i += 1;
            continue;
        }
        if !line.starts_with(' ') {
            break;
        }
        let dash = indent_of(line)?;
        let Some(first) = line.trim_start().strip_prefix("- ") else {
            return Err(format!(
                "each `faq` entry starts with `- question:`, found `{}`",
                line.trim()
            ));
        };
        entry += 1;
        if entry > MAX_FAQ_ENTRIES {
            return Err(format!("`faq` has more than {MAX_FAQ_ENTRIES} entries"));
        }
        *i += 1;
        let mut pending = Some(first.trim().to_string());
        loop {
            let text = match pending.take() {
                Some(text) => text,
                None => {
                    let Some(next) = lines.get(*i).map(|l| l.trim_end()) else {
                        break;
                    };
                    if is_skipped(next) {
                        *i += 1;
                        continue;
                    }
                    if !next.starts_with(' ') || indent_of(next)? != dash + 2 {
                        break;
                    }
                    *i += 1;
                    next.trim().to_string()
                }
            };
            let Some(colon) = find_key_colon(&text) else {
                return Err(format!(
                    "expected `key: value` in a `faq` entry, found `{text}`"
                ));
            };
            let name = text[..colon].trim();
            fields.insert(
                format!("{FAQ_PREFIX}{entry}.{name}"),
                Value::Scalar(unquote(text[colon + 1..].trim())),
            );
        }
    }
    Ok(())
}

/// Write the flattened `faq.*` keys back as one block list, entry by entry in
/// numeric order, `question` then `answer` then any other key.
fn serialize_faq(fields: &[(&str, Value)], out: &mut String) {
    let mut entries: BTreeMap<usize, Vec<(&str, &str)>> = BTreeMap::new();
    for (key, value) in fields {
        let Some(rest) = key.strip_prefix(FAQ_PREFIX) else {
            continue;
        };
        let (Some((number, name)), Value::Scalar(text)) = (rest.split_once('.'), value) else {
            continue;
        };
        if let Ok(number) = number.parse::<usize>() {
            entries.entry(number).or_default().push((name, text));
        }
    }
    out.push_str(FAQ_KEY);
    out.push_str(":\n");
    for (_, mut keys) in entries {
        keys.sort_by_key(|(name, _)| match *name {
            "question" => (0, String::new()),
            "answer" => (1, String::new()),
            other => (2, other.to_string()),
        });
        for (position, (name, text)) in keys.into_iter().enumerate() {
            let lead = if position == 0 { "  - " } else { "    " };
            out.push_str(&format!("{lead}{name}: {}\n", quote_scalar(text)));
        }
    }
}

fn is_skipped(line: &str) -> bool {
    line.trim().is_empty() || line.trim_start().starts_with('#')
}

fn next_significant(lines: &[&str], from: usize) -> usize {
    (from..lines.len())
        .find(|&at| !is_skipped(lines[at]))
        .unwrap_or(lines.len())
}

fn next_is_mapping(lines: &[&str], from: usize) -> bool {
    let at = next_significant(lines, from);
    let Some(line) = lines.get(at) else {
        return false;
    };
    let trimmed = line.trim();
    line.starts_with(' ') && !trimmed.starts_with("- ") && trimmed != "-"
}

fn indent_of(line: &str) -> Result<usize, String> {
    if line.starts_with('\t') {
        return Err(format!("use spaces, not tabs, to indent `{}`", line.trim()));
    }
    Ok(line.len() - line.trim_start_matches(' ').len())
}

fn parse_nested(
    lines: &[&str],
    i: &mut usize,
    indent: usize,
    prefix: &str,
    depth: usize,
    fields: &mut BTreeMap<String, Value>,
) -> Result<(), String> {
    if depth > MAX_NESTING {
        return Err(format!("`{prefix}` is nested too deeply"));
    }
    while *i < lines.len() {
        let line = lines[*i].trim_end();
        if is_skipped(line) {
            *i += 1;
            continue;
        }
        let here = indent_of(line)?;
        if here < indent {
            break;
        }
        if here > indent {
            return Err(format!(
                "unexpected indentation under `{prefix}`: `{}`",
                line.trim()
            ));
        }
        let Some(colon) = find_key_colon(line.trim_start()) else {
            return Err(format!(
                "expected `key: value` under `{prefix}`, found `{}`",
                line.trim()
            ));
        };
        let content = line.trim_start();
        let key = format!("{prefix}.{}", content[..colon].trim());
        let rest = content[colon + 1..].trim();
        *i += 1;
        if !rest.is_empty() {
            let value = match rest.strip_prefix('[') {
                Some(inner) => match inner.strip_suffix(']') {
                    Some(inner) => Value::List(split_inline_list(inner)),
                    None => return Err(format!("unterminated inline list for `{key}`")),
                },
                None => Value::Scalar(unquote(rest)),
            };
            fields.insert(key, value);
            continue;
        }
        let at = next_significant(lines, *i);
        let Some(next) = lines.get(at) else {
            fields.insert(key, Value::Scalar(String::new()));
            continue;
        };
        let next_indent = indent_of(next)?;
        let trimmed = next.trim();
        if next_indent <= indent {
            fields.insert(key, Value::Scalar(String::new()));
        } else if let Some(first) = trimmed
            .strip_prefix("- ")
            .or((trimmed == "-").then_some(""))
        {
            let mut items = vec![unquote(first.trim())];
            *i = at + 1;
            while *i < lines.len() {
                let item_line = lines[*i];
                if is_skipped(item_line) {
                    *i += 1;
                    continue;
                }
                let item = item_line.trim();
                match item.strip_prefix("- ").or((item == "-").then_some("")) {
                    Some(item) if indent_of(item_line)? > indent => {
                        items.push(unquote(item.trim()));
                        *i += 1;
                    }
                    _ => break,
                }
            }
            fields.insert(key, Value::List(items));
        } else {
            *i = at;
            parse_nested(lines, i, next_indent, &key, depth + 1, fields)?;
        }
    }
    Ok(())
}

/// Find the colon that separates key from value. Keys never contain `:`;
/// values may (`url: https://…`), so the first colon followed by whitespace
/// or end of line wins.
fn find_key_colon(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    (0..bytes.len()).find(|&idx| {
        bytes[idx] == b':'
            && (idx + 1 == bytes.len() || bytes[idx + 1] == b' ' || bytes[idx + 1] == b'\t')
    })
}

fn split_inline_list(inner: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        match quote {
            Some(q) => {
                if ch == '\\' && q == '"' {
                    if let Some(next) = chars.next() {
                        current.push(next);
                    }
                } else if ch == q {
                    quote = None;
                } else {
                    current.push(ch);
                }
            }
            None => match ch {
                '"' | '\'' => quote = Some(ch),
                ',' => {
                    let item = current.trim().to_string();
                    if !item.is_empty() {
                        items.push(item);
                    }
                    current.clear();
                }
                _ => current.push(ch),
            },
        }
    }
    let item = current.trim().to_string();
    if !item.is_empty() {
        items.push(item);
    }
    items
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2 {
        let first = v.as_bytes()[0];
        let last = v.as_bytes()[v.len() - 1];
        if first == b'"' && last == b'"' {
            return unescape_double(&v[1..v.len() - 1]);
        }
        if first == b'\'' && last == b'\'' {
            return v[1..v.len() - 1].replace("''", "'");
        }
    }
    // Strip a trailing comment on bare scalars: `draft: true # not yet`
    match v.find(" #") {
        Some(idx) => v[..idx].trim_end().to_string(),
        None => v.to_string(),
    }
}

fn unescape_double(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Serialize front matter back to text. Used by the importer and `new`.
pub fn serialize(fields: &[(&str, Value)]) -> String {
    let mut out = String::from("---\n");
    let nested_prefix = format!("{NESTED_KEY}.");
    let mut nested_written = false;
    let mut faq_written = false;
    for (key, value) in fields {
        if key.starts_with(FAQ_PREFIX) {
            if !faq_written {
                faq_written = true;
                serialize_faq(fields, &mut out);
            }
            continue;
        }
        if key.starts_with(&nested_prefix) {
            if !nested_written {
                nested_written = true;
                serialize_nested(fields, &nested_prefix, &mut out);
            }
            continue;
        }
        match value {
            Value::Scalar(s) => {
                out.push_str(key);
                out.push_str(": ");
                out.push_str(&quote_scalar(s));
                out.push('\n');
            }
            Value::List(items) => {
                out.push_str(key);
                out.push_str(":\n");
                for item in items {
                    out.push_str("  - ");
                    out.push_str(&quote_scalar(item));
                    out.push('\n');
                }
            }
        }
    }
    out.push_str("---\n");
    out
}

/// Write the flattened `job.*` keys back as one nested mapping, in key order,
/// so parsing the result gives the same fields.
fn serialize_nested(fields: &[(&str, Value)], prefix: &str, out: &mut String) {
    let mut entries: Vec<(Vec<&str>, &Value)> = fields
        .iter()
        .filter(|(key, _)| key.starts_with(prefix))
        .map(|(key, value)| (key.split('.').collect(), value))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    out.push_str(NESTED_KEY);
    out.push_str(":\n");
    let mut open: Vec<&str> = Vec::new();
    for (path, value) in entries {
        let parents = &path[1..path.len() - 1];
        let common = open
            .iter()
            .zip(parents)
            .take_while(|(left, right)| left == right)
            .count();
        open.truncate(common);
        for (depth, name) in parents.iter().enumerate().skip(common) {
            out.push_str(&"  ".repeat(depth + 1));
            out.push_str(name);
            out.push_str(":\n");
            open.push(name);
        }
        let indent = "  ".repeat(path.len() - 1);
        let name = path[path.len() - 1];
        match value {
            Value::Scalar(s) => {
                out.push_str(&format!("{indent}{name}: {}\n", quote_scalar(s)));
            }
            Value::List(items) => {
                out.push_str(&format!("{indent}{name}:\n"));
                for item in items {
                    out.push_str(&format!("{indent}  - {}\n", quote_scalar(item)));
                }
            }
        }
    }
}

/// Preferred key order when writing a document, so edits produce stable diffs.
const KEY_ORDER: &[&str] = &[
    "title",
    "subtitle",
    "slug",
    "date",
    "updated",
    "description",
    "tags",
    "series",
    "seriesOrder",
    "cover",
    "coverAlt",
    "theme",
    "canonical",
    "sourceUrl",
    "draft",
    "name",
    "order",
    "nav",
];

/// Write a full document from a field map and a body. Known keys come first in
/// a fixed order and any other keys follow alphabetically, so unknown fields a
/// user added by hand survive an edit in the admin UI. Empty scalars and empty
/// lists are omitted.
pub fn compose(fields: &BTreeMap<String, Value>, body: &str) -> String {
    let mut ordered: Vec<(&str, Value)> = Vec::new();
    for key in KEY_ORDER {
        if let Some(v) = fields.get(*key) {
            ordered.push((key, v.clone()));
        }
    }
    for (key, v) in fields {
        if !KEY_ORDER.contains(&key.as_str()) {
            ordered.push((key.as_str(), v.clone()));
        }
    }
    ordered.retain(|(_, v)| match v {
        Value::Scalar(s) => !s.trim().is_empty(),
        Value::List(items) => !items.is_empty(),
    });
    let mut out = serialize(&ordered);
    out.push('\n');
    out.push_str(body.trim_start_matches(['\r', '\n']));
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn quote_scalar(s: &str) -> String {
    let needs_quotes = s.is_empty()
        || s.contains(": ")
        || s.contains(" #")
        || s.starts_with(['[', '{', '"', '\'', '-', '&', '*', '!', '|', '>', '%', '@', '`', '#'])
        // A raw newline would let a value smuggle in extra front matter fields.
        || s.chars().any(char::is_control)
        || s.ends_with(':')
        || s.trim() != s
        || matches!(s.to_ascii_lowercase().as_str(), "true" | "false" | "yes" | "no" | "null" | "~");
    if needs_quotes {
        let escaped = s
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\r', "")
            .replace('\n', "\\n")
            .replace('\t', "\\t");
        format!("\"{escaped}\"")
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_scalars_lists_and_body() {
        let doc = parse(
            "---\ntitle: \"Hello: World\"\nurl: https://example.com/a\ndraft: true # soon\ntags: [rust, \"web assembly\", 'c']\nseries:\n  - guide\n---\n# Body\n\ntext\n",
        )
        .unwrap();
        let fm = doc.front_matter;
        assert_eq!(fm.get("title"), Some("Hello: World"));
        assert_eq!(fm.get("url"), Some("https://example.com/a"));
        assert_eq!(fm.get_bool("draft"), Some(true));
        assert_eq!(fm.get_list("tags"), vec!["rust", "web assembly", "c"]);
        assert_eq!(fm.get("series"), Some("guide"));
        assert_eq!(doc.body, "# Body\n\ntext");
        assert_eq!(doc.body_line, 9);
    }

    #[test]
    fn no_front_matter_is_fine() {
        let doc = parse("# Just markdown").unwrap();
        assert!(doc.front_matter.fields.is_empty());
        assert_eq!(doc.body, "# Just markdown");
    }

    #[test]
    fn unterminated_is_an_error() {
        assert!(parse("---\ntitle: x\n").is_err());
    }

    #[test]
    fn compose_orders_keys_keeps_unknown_and_drops_empties() {
        let mut fields = BTreeMap::new();
        fields.insert("zeta".to_string(), Value::Scalar("kept".into()));
        fields.insert("date".to_string(), Value::Scalar("2026-10-21".into()));
        fields.insert("title".to_string(), Value::Scalar("T: x".into()));
        fields.insert("tags".to_string(), Value::List(vec!["a".into()]));
        fields.insert("series".to_string(), Value::Scalar("".into()));
        fields.insert("draft".to_string(), Value::List(vec![]));
        let text = compose(&fields, "\n\nBody text");
        assert_eq!(
            text,
            "---\ntitle: \"T: x\"\ndate: 2026-10-21\ntags:\n  - a\nzeta: kept\n---\n\nBody text\n"
        );
        let doc = parse(&text).unwrap();
        assert_eq!(doc.front_matter.get("zeta"), Some("kept"));
        assert_eq!(doc.body.trim(), "Body text");
    }

    #[test]
    fn values_with_newlines_cannot_inject_fields() {
        let mut fields = BTreeMap::new();
        fields.insert("title".to_string(), Value::Scalar("T".into()));
        fields.insert(
            "description".to_string(),
            Value::Scalar("line one\nslug: evil\r\n---\ndraft: true".into()),
        );
        let text = compose(&fields, "body");
        let doc = parse(&text).unwrap();
        assert_eq!(doc.front_matter.get("slug"), None);
        assert_eq!(doc.front_matter.get("draft"), None);
        assert_eq!(
            doc.front_matter.get("description"),
            Some("line one\nslug: evil\n---\ndraft: true")
        );
        assert_eq!(doc.body.trim(), "body");
    }

    #[test]
    fn subtitles_are_written_directly_under_the_title() {
        let mut fields = BTreeMap::new();
        fields.insert("description".to_string(), Value::Scalar("D".into()));
        fields.insert("subtitle".to_string(), Value::Scalar("S".into()));
        fields.insert("title".to_string(), Value::Scalar("T".into()));
        let text = compose(&fields, "body");
        assert!(text.starts_with("---\ntitle: T\nsubtitle: S\n"), "{text}");
    }

    #[test]
    fn faq_entries_are_flattened_and_written_back_in_order() {
        let text = "---\nid: a\nfaq:\n  - question: How long?\n    answer: \"Two days: maybe three.\"\n  - question: Cost?\n    answer: Ask.\nnext: x\n---\nbody";
        let doc = parse(text).unwrap();
        let fm = &doc.front_matter;
        assert_eq!(fm.get("faq.1.question"), Some("How long?"));
        assert_eq!(fm.get("faq.1.answer"), Some("Two days: maybe three."));
        assert_eq!(fm.get("faq.2.answer"), Some("Ask."));
        assert_eq!(fm.get("next"), Some("x"));
        let mut fields = fm.fields.clone();
        for n in 3..=10 {
            fields.insert(format!("faq.{n}.question"), Value::Scalar(format!("Q{n}")));
            fields.insert(format!("faq.{n}.answer"), Value::Scalar(format!("A{n}")));
        }
        let written = compose(&fields, "body");
        let again = parse(&written).unwrap();
        assert_eq!(again.front_matter.fields, fields);
        let order: Vec<&str> = written
            .lines()
            .filter(|line| line.contains("question:"))
            .collect();
        assert_eq!(order[1], "  - question: Cost?");
        assert_eq!(order[9], "  - question: Q10");
    }

    #[test]
    fn a_plain_faq_list_stays_a_list() {
        let doc = parse("---\nfaq:\n  - one\n  - two\n---\n").unwrap();
        assert_eq!(doc.front_matter.get_list("faq"), vec!["one", "two"]);
    }

    #[test]
    fn serialize_round_trips() {
        let text = serialize(&[
            ("title", Value::Scalar("A: colon".into())),
            (
                "tags",
                Value::List(vec!["rust".into(), "web assembly".into()]),
            ),
            ("draft", Value::Scalar("true".into())),
        ]);
        let doc = parse(&format!("{text}body")).unwrap();
        assert_eq!(doc.front_matter.get("title"), Some("A: colon"));
        assert_eq!(
            doc.front_matter.get_list("tags"),
            vec!["rust", "web assembly"]
        );
        assert_eq!(doc.front_matter.get("draft"), Some("true"));
    }
}
