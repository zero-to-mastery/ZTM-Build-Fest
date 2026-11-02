//! Changing one top-level member of `openblog.json` without touching the rest.
//!
//! Parsing the file and writing it back sorts every key and drops the owner's layout. A settings
//! screen that only owns one member (`business`) must leave every other member exactly where and
//! as the owner wrote it, so this edits the text: it finds the member's value, replaces just that
//! span, or adds or removes just that member. The result is the same file with one member changed.

use serde_json::Value;

/// One top-level member found in the text.
struct Member {
    key: String,
    /// Byte offset of the opening quote of the key.
    start: usize,
    value_start: usize,
    value_end: usize,
}

/// Set (`Some`) or remove (`None`) the top-level `key` of a JSON object text. Everything else,
/// including key order, spacing and line endings, is kept byte for byte.
pub fn set_member(text: &str, key: &str, value: Option<&Value>) -> Result<String, String> {
    let bytes = text.as_bytes();
    let (members, open, close) = scan(bytes)?;
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let found = members.iter().position(|m| m.key == key);
    match (found, value) {
        (None, None) => Ok(text.to_string()),
        (Some(index), Some(value)) => {
            let member = &members[index];
            let indent = line_indent(text, member.start);
            let rendered = render(value, &indent, newline)?;
            Ok(format!(
                "{}{}{}",
                &text[..member.value_start],
                rendered,
                &text[member.value_end..]
            ))
        }
        (Some(index), None) => {
            let member = &members[index];
            let (from, to) = match members.get(index + 1) {
                // Remove through the start of the next member: the comma and the gap go too.
                Some(next) => (member.start, next.start),
                // The last member: its separating comma goes with it.
                None if index > 0 => (members[index - 1].value_end, member.value_end),
                None => (open + 1, close),
            };
            let mut out = format!("{}{}", &text[..from], &text[to..]);
            if members.len() == 1 {
                out = format!("{}{newline}{}", &text[..open + 1], &text[close..]);
            }
            Ok(out)
        }
        (None, Some(value)) => {
            let indent = members
                .last()
                .map(|m| line_indent(text, m.start))
                .unwrap_or_else(|| "  ".to_string());
            let rendered = render(value, &indent, newline)?;
            let quoted = serde_json::to_string(key).map_err(|error| error.to_string())?;
            let member = format!("{quoted}: {rendered}");
            match members.last() {
                Some(last) => Ok(format!(
                    "{},{newline}{indent}{member}{}",
                    &text[..last.value_end],
                    &text[last.value_end..]
                )),
                None => Ok(format!(
                    "{}{newline}{indent}{member}{newline}{}",
                    &text[..open + 1],
                    &text[close..]
                )),
            }
        }
    }
}

/// The value as pretty JSON whose continuation lines sit under `indent`.
fn render(value: &Value, indent: &str, newline: &str) -> Result<String, String> {
    let pretty = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let mut lines = pretty.lines();
    let mut out = lines.next().unwrap_or("").to_string();
    for line in lines {
        out.push_str(newline);
        out.push_str(indent);
        out.push_str(line);
    }
    Ok(out)
}

/// The whitespace that starts the line holding `offset`, when only whitespace precedes it there.
fn line_indent(text: &str, offset: usize) -> String {
    let line_start = text[..offset].rfind('\n').map_or(0, |i| i + 1);
    let before = &text[line_start..offset];
    if before.chars().all(|c| c == ' ' || c == '\t') {
        before.to_string()
    } else {
        "  ".to_string()
    }
}

fn skip_space(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

fn skip_string(bytes: &[u8], start: usize) -> Result<usize, String> {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Ok(i + 1),
            _ => i += 1,
        }
    }
    Err("openblog.json has an unterminated string".into())
}

fn skip_value(bytes: &[u8], start: usize) -> Result<usize, String> {
    match bytes.get(start) {
        Some(b'"') => skip_string(bytes, start),
        Some(b'{') | Some(b'[') => {
            let mut depth = 0usize;
            let mut i = start;
            while i < bytes.len() {
                match bytes[i] {
                    b'"' => {
                        i = skip_string(bytes, i)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Ok(i + 1);
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            Err("openblog.json ends inside a value".into())
        }
        Some(_) => {
            let mut i = start;
            while i < bytes.len()
                && !matches!(bytes[i], b',' | b'}' | b']')
                && !bytes[i].is_ascii_whitespace()
            {
                i += 1;
            }
            Ok(i)
        }
        None => Err("openblog.json ends where a value should be".into()),
    }
}

/// The members of the top-level object, with the offsets of its braces.
fn scan(bytes: &[u8]) -> Result<(Vec<Member>, usize, usize), String> {
    let invalid = || "openblog.json must contain a valid JSON object".to_string();
    let open = skip_space(
        bytes,
        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            3
        } else {
            0
        },
    );
    if bytes.get(open) != Some(&b'{') {
        return Err(invalid());
    }
    let mut members = Vec::new();
    let mut i = skip_space(bytes, open + 1);
    loop {
        match bytes.get(i) {
            Some(b'}') => return Ok((members, open, i)),
            Some(b'"') => {
                let end = skip_string(bytes, i)?;
                let key: String = serde_json::from_slice(&bytes[i..end]).map_err(|_| invalid())?;
                let colon = skip_space(bytes, end);
                if bytes.get(colon) != Some(&b':') {
                    return Err(invalid());
                }
                let value_start = skip_space(bytes, colon + 1);
                let value_end = skip_value(bytes, value_start)?;
                members.push(Member {
                    key,
                    start: i,
                    value_start,
                    value_end,
                });
                i = skip_space(bytes, value_end);
                if bytes.get(i) == Some(&b',') {
                    i = skip_space(bytes, i + 1);
                }
            }
            _ => return Err(invalid()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FILE: &str = "{\n  \"zeta\": 1,\n  \"title\": \"A \\\"quoted\\\" } brace\",\n  \"business\": {\n    \"phone\": \"+1\"\n  },\n  \"alpha\": [1, 2, {\"a\": \"}\"}]\n}\n";

    fn keys(text: &str) -> Vec<String> {
        scan(text.as_bytes())
            .unwrap()
            .0
            .into_iter()
            .map(|m| m.key)
            .collect()
    }

    #[test]
    fn replacing_a_member_changes_only_that_span() {
        let out = set_member(
            FILE,
            "business",
            Some(&json!({"version": 1, "insured": true})),
        )
        .unwrap();
        assert!(out.starts_with("{\n  \"zeta\": 1,\n  \"title\": \"A \\\"quoted\\\" } brace\",\n  \"business\": {\n    \"insured\": true,\n    \"version\": 1\n  },\n  \"alpha\""));
        assert!(out.ends_with("\"alpha\": [1, 2, {\"a\": \"}\"}]\n}\n"));
        assert_eq!(keys(&out), ["zeta", "title", "business", "alpha"]);
        serde_json::from_str::<Value>(&out).unwrap();
    }

    #[test]
    fn adding_a_member_goes_last_and_nothing_else_moves() {
        let without = set_member(FILE, "business", None).unwrap();
        assert_eq!(keys(&without), ["zeta", "title", "alpha"]);
        let added = set_member(&without, "business", Some(&json!({"insured": true}))).unwrap();
        assert_eq!(keys(&added), ["zeta", "title", "alpha", "business"]);
        assert!(added.starts_with("{\n  \"zeta\": 1,\n  \"title\""));
        serde_json::from_str::<Value>(&added).unwrap();
    }

    #[test]
    fn removing_a_member_keeps_the_file_valid_wherever_it_is() {
        for key in ["zeta", "title", "business", "alpha"] {
            let out = set_member(FILE, key, None).unwrap();
            let value: Value = serde_json::from_str(&out).unwrap();
            assert!(value.get(key).is_none(), "{key}");
            assert_eq!(value.as_object().unwrap().len(), 3, "{key}");
        }
        assert_eq!(set_member(FILE, "missing", None).unwrap(), FILE);
        let only = set_member("{\n  \"a\": 1\n}\n", "a", None).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&only).unwrap(), json!({}));
    }

    #[test]
    fn an_empty_object_and_other_layouts_work() {
        let added = set_member("{}", "business", Some(&json!({"a": 1}))).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&added).unwrap(),
            json!({"business": {"a": 1}})
        );
        let compact = set_member("{\"b\":2,\"a\":1}", "n", Some(&json!(true))).unwrap();
        assert_eq!(compact, "{\"b\":2,\"a\":1,\n  \"n\": true}");
        let crlf = set_member("{\r\n  \"a\": 1\r\n}\r\n", "b", Some(&json!({"c": 1}))).unwrap();
        assert!(crlf.contains("\r\n  \"b\": {\r\n    \"c\": 1\r\n  }"));
        assert!(!crlf.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn text_that_is_not_an_object_is_refused() {
        assert!(set_member("[]", "a", Some(&json!(1))).is_err());
        assert!(set_member("", "a", Some(&json!(1))).is_err());
    }
}
