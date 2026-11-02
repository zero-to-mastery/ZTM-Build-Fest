//! Word shingles of text, for the publication boundary's text guard (#63,
//! ADR 0125).
//!
//! Private text and every generated output are normalised the same way and
//! compared as hashes of [`SHINGLE_WORDS`] consecutive words. The same
//! sentence therefore matches whether an output wrapped it across lines,
//! joined it into a search index, stripped its emphasis and links, escaped it
//! as HTML entities or JSON, or changed its case or punctuation.
//!
//! Every text, private or generated, is normalised in the same order: markup
//! is removed (tag and attribute names vanish, while the text of `content`,
//! `alt`, `title` and similar attributes stays, each as its own run), HTML
//! entities are decoded, and markup that was escaped inside the text (a
//! feed's `&lt;p&gt;`) is removed once more. A private note that wrote `<i>`
//! around a word therefore matches the same note in a page that dropped the
//! tag. Then the text is folded and split into words: every non-alphanumeric
//! run (punctuation, markup remnants, newlines) separates words, letters are
//! lower-cased, full-width forms and ligatures are mapped to their plain
//! letters, and zero-width characters are dropped. No Unicode normalisation
//! tables are bundled, so a decomposed accent does not equal its precomposed
//! form: a stated gap.
//!
//! JSON escapes are decoded only where JSON is meant. A file that parses as
//! JSON is read field by field: each string value is a run of its own, so no
//! shingle spans two fields. Any other generated text is read as written and,
//! when it holds a backslash, once more with its JSON escapes decoded, so a
//! JSON string literal inside a page or a script is still found while `\theta`
//! and `C:\new` are never turned into a letter and a newline.
//!
//! Known public short strings (a title, a heading, a tag, a navigation label)
//! are cut out of a generated text's word stream, so the theme placing two of
//! them side by side (a table of contents, a series list) never makes a shingle
//! that spans the pair.

use std::collections::{HashMap, HashSet};

/// How many consecutive words make one shingle. Six words are a clause: long
/// enough that common phrases rarely repeat by chance across a site's own
/// prose and generated boilerplate, short enough that a sentence fragment
/// of a note or passage is still found. Text of fewer words is not guarded.
pub const SHINGLE_WORDS: usize = 6;

/// How a text reaches the guard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
    /// Text as written: a private field, a post's text, a title.
    Plain,
    /// A generated file: HTML, JSON, XML, plain text or a feed.
    Output,
}

/// Separates runs that must not form a shingle across their boundary.
const BARRIER: char = '\u{E000}';
/// Marks where a tag stood, so a short string that is a whole element can be
/// told from the same word inside a sentence.
const EDGE: char = '\u{E001}';
/// The word value of a barrier.
const BARRIER_WORD: u64 = 0;
/// The word value of an edge.
const EDGE_WORD: u64 = 1;
/// The attributes whose value is text a reader or a crawler sees.
const TEXT_ATTRIBUTES: &[&str] = &[
    "content",
    "alt",
    "title",
    "aria-label",
    "aria-description",
    "placeholder",
    "label",
    "summary",
    "value",
    "data-title",
    "data-label",
];
/// The longest tag the markup remover recognises.
const MAX_TAG: usize = 16 * 1024;

/// Known public short strings, as word sequences, cut out of generated text.
#[derive(Debug, Default)]
pub struct Cuts {
    by_first: HashMap<u64, Vec<Vec<u64>>>,
}

impl Cuts {
    /// Cut generated text at the edges of `text`. Text with no words adds
    /// nothing.
    pub fn add(&mut self, text: &str) {
        let words: Vec<u64> = stream(text, Form::Plain)
            .into_iter()
            .filter(|&word| word > EDGE_WORD)
            .collect();
        let Some(&first) = words.first() else {
            return;
        };
        let known = self.by_first.entry(first).or_default();
        if !known.contains(&words) {
            known.push(words);
        }
    }

    /// Put a barrier before and after every occurrence of a known string. A
    /// one-word string is cut only when it stands alone in its element, so a
    /// tag named like an ordinary word does not cut every sentence using it.
    fn apply(&self, words: Vec<u64>) -> Vec<u64> {
        if self.by_first.is_empty() {
            return words;
        }
        let open = |at: Option<&u64>| matches!(at, None | Some(&BARRIER_WORD | &EDGE_WORD));
        let mut cut_at = vec![false; words.len() + 1];
        let mut index = 0;
        while index < words.len() {
            let mut longest = 0;
            if let Some(known) = self.by_first.get(&words[index]) {
                for sequence in known {
                    let end = index + sequence.len();
                    if end <= words.len()
                        && words[index..end] == sequence[..]
                        && (sequence.len() > 1
                            || (open(index.checked_sub(1).map(|at| &words[at]))
                                && open(words.get(end))))
                    {
                        longest = longest.max(sequence.len());
                    }
                }
            }
            if longest > 0 {
                cut_at[index] = true;
                cut_at[index + longest] = true;
                index += longest;
            } else {
                index += 1;
            }
        }
        let mut out = Vec::with_capacity(words.len() + 8);
        for (index, word) in words.into_iter().enumerate() {
            if cut_at[index] {
                out.push(BARRIER_WORD);
            }
            out.push(word);
        }
        out
    }
}

/// The text of every heading element in `html`, tags removed.
pub fn headings(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(open) = lower[at..].find("<h") {
        let start = at + open;
        at = start + 2;
        let level = lower.as_bytes().get(start + 2).copied();
        let after = lower.as_bytes().get(start + 3).copied();
        let Some(level @ b'1'..=b'6') = level else {
            continue;
        };
        if !matches!(after, Some(b'>' | b' ' | b'\t' | b'\n' | b'\r')) {
            continue;
        }
        let Some(tag_close) = lower[start..].find('>') else {
            break;
        };
        let body_from = start + tag_close + 1;
        let close = format!("</h{}", char::from(level));
        let Some(end) = lower[body_from..].find(&close) else {
            continue;
        };
        let inner = &html[body_from..body_from + end];
        let text = decode_entities(&strip_markup(inner).replace([EDGE, BARRIER], " "));
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !text.is_empty() {
            found.push(text);
        }
        at = body_from + end;
    }
    found
}

/// The word hashes of `text` as the guard compares them, with `0` between
/// runs that are not adjacent.
pub fn words(text: &str, form: Form) -> Vec<u64> {
    clean(stream(text, form))
}

/// Call `each` with the hash of every shingle in `text`.
pub fn each_shingle(text: &str, form: Form, each: impl FnMut(u64)) {
    shingles_of(stream(text, form), None, each);
}

/// Call `each` with the hash of every shingle of a generated file. A file that
/// parses as JSON is read field by field; any other is read as text. `cuts`,
/// when given, are cut out first.
pub fn each_output_shingle(text: &str, cuts: Option<&Cuts>, each: impl FnMut(u64)) {
    shingles_of(output_stream(text), cuts, each);
}

/// The distinct shingle hashes of `text`.
pub fn shingle_set(text: &str, form: Form) -> HashSet<u64> {
    let mut set = HashSet::new();
    each_shingle(text, form, |hash| {
        set.insert(hash);
    });
    set
}

fn clean(stream: Vec<u64>) -> Vec<u64> {
    let mut out = Vec::with_capacity(stream.len());
    for word in stream {
        if word == EDGE_WORD {
            continue;
        }
        if word == BARRIER_WORD && matches!(out.last(), None | Some(&BARRIER_WORD)) {
            continue;
        }
        out.push(word);
    }
    out
}

fn shingles_of(stream: Vec<u64>, cuts: Option<&Cuts>, mut each: impl FnMut(u64)) {
    let stream = match cuts {
        Some(cuts) => cuts.apply(stream),
        None => stream,
    };
    let words = clean(stream);
    for run in words.split(|&word| word == BARRIER_WORD) {
        if run.len() < SHINGLE_WORDS {
            continue;
        }
        for window in run.windows(SHINGLE_WORDS) {
            let mut hash = 0xcbf2_9ce4_8422_2325u64;
            for &word in window {
                hash = (hash.rotate_left(7) ^ word).wrapping_mul(0x0100_0000_01b3);
            }
            each(hash);
        }
    }
}

/// The word stream of one text, with barriers and edges in it.
fn stream(text: &str, form: Form) -> Vec<u64> {
    let mut words = split(&prepare(text));
    if form == Form::Output && text.contains('\\') {
        words.push(BARRIER_WORD);
        words.extend(split(&prepare(&json_unescape(text))));
    }
    words
}

/// The word stream of a generated file.
fn output_stream(text: &str) -> Vec<u64> {
    let trimmed = text.trim_start();
    if trimmed.starts_with(['{', '[']) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            let mut words = Vec::new();
            json_leaves(&value, &mut words);
            return words;
        }
    }
    stream(text, Form::Output)
}

fn json_leaves(value: &serde_json::Value, words: &mut Vec<u64>) {
    match value {
        serde_json::Value::String(text) => {
            words.push(BARRIER_WORD);
            words.extend(stream(text, Form::Output));
            words.push(BARRIER_WORD);
        }
        serde_json::Value::Array(items) => {
            for item in items {
                json_leaves(item, words);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                json_leaves(item, words);
            }
        }
        _ => {}
    }
}

fn prepare(text: &str) -> String {
    let stripped = strip_markup(text);
    let decoded = decode_entities(&stripped);
    if decoded.contains('<') {
        decode_entities(&strip_markup(&decoded))
    } else {
        decoded
    }
}

fn json_unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('u') => {
                let mut ahead = chars.clone();
                ahead.next();
                let code = hex4(&mut ahead);
                match code {
                    Some(high @ 0xD800..=0xDBFF) => {
                        let mut pair = ahead.clone();
                        let low = (pair.next() == Some('\\') && pair.next() == Some('u'))
                            .then(|| hex4(&mut pair))
                            .flatten()
                            .filter(|low| (0xDC00..=0xDFFF).contains(low));
                        if let Some(low) = low {
                            let scalar = 0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00);
                            out.push(char::from_u32(scalar).unwrap_or(' '));
                            chars = pair;
                        } else {
                            out.push(' ');
                            chars = ahead;
                        }
                    }
                    Some(code) => {
                        out.push(char::from_u32(code).unwrap_or(' '));
                        chars = ahead;
                    }
                    None => out.push('\\'),
                }
            }
            Some('n' | 'r' | 't' | 'b' | 'f') => {
                chars.next();
                out.push(' ');
            }
            Some(escaped @ ('"' | '/' | '\\')) => {
                chars.next();
                out.push(escaped);
            }
            _ => out.push('\\'),
        }
    }
    out
}

fn hex4(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> Option<u32> {
    let mut code = 0;
    for _ in 0..4 {
        code = code * 16 + chars.next()?.to_digit(16)?;
    }
    Some(code)
}

/// Remove tags, keeping the text inside comments and CDATA, and the text of
/// text-bearing attributes, each as a run of its own after the document, so
/// the words around a tag stay adjacent.
fn strip_markup(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut attributes = String::new();
    let mut index = 0;
    let mut plain = 0;
    while index < bytes.len() {
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        let rest = &text[index..];
        let marker = rest
            .strip_prefix("<!--")
            .map(|_| 4)
            .or_else(|| rest.strip_prefix("<![CDATA[").map(|_| 9));
        let starts_tag = matches!(
            bytes.get(index + 1),
            Some(b'a'..=b'z' | b'A'..=b'Z' | b'/' | b'!' | b'?')
        );
        if marker.is_none() && !starts_tag {
            index += 1;
            continue;
        }
        out.push_str(&text[plain..index]);
        out.push(EDGE);
        if let Some(length) = marker {
            index += length;
            plain = index;
            continue;
        }
        match tag_end(rest) {
            Some(end) => {
                attribute_text(&rest[1..end], &mut attributes);
                index += end + 1;
            }
            None => {
                out.push('<');
                index += 1;
            }
        }
        plain = index;
    }
    out.push_str(&text[plain..]);
    out.push_str(&attributes);
    out
}

/// The offset of the `>` that closes the tag at the start of `rest`.
fn tag_end(rest: &str) -> Option<usize> {
    let mut quote = None;
    for (offset, byte) in rest.bytes().enumerate().take(MAX_TAG) {
        match (quote, byte) {
            (Some(open), byte) if byte == open => quote = None,
            (Some(_), _) => {}
            (None, b'"' | b'\'') => quote = Some(byte),
            (None, b'>') => return Some(offset),
            _ => {}
        }
    }
    None
}

/// Push the text-bearing attribute values of the tag body `tag` (the text
/// between `<` and `>`), each between barriers.
fn attribute_text(tag: &str, out: &mut String) {
    let mut chars = tag.char_indices().peekable();
    while let Some(&(_, c)) = chars.peek() {
        if c.is_whitespace() || c == '/' {
            chars.next();
            continue;
        }
        let start = chars.peek().map_or(tag.len(), |&(at, _)| at);
        let mut end = start;
        while let Some(&(at, c)) = chars.peek() {
            if c.is_whitespace() || c == '=' || c == '>' || c == '/' {
                break;
            }
            end = at + c.len_utf8();
            chars.next();
        }
        let name = tag[start..end].to_ascii_lowercase();
        if name.is_empty() && chars.peek().map(|&(_, c)| c) != Some('=') {
            // A stray character (`>` inside a quoted run that is not an
            // attribute) must still be consumed, or this never ends.
            chars.next();
            continue;
        }
        while chars.peek().is_some_and(|&(_, c)| c.is_whitespace()) {
            chars.next();
        }
        if chars.peek().map(|&(_, c)| c) != Some('=') {
            continue;
        }
        chars.next();
        while chars.peek().is_some_and(|&(_, c)| c.is_whitespace()) {
            chars.next();
        }
        let value = match chars.peek().copied() {
            Some((at, quote @ ('"' | '\''))) => {
                chars.next();
                let from = at + 1;
                let mut to = tag.len();
                for (at, c) in chars.by_ref() {
                    if c == quote {
                        to = at;
                        break;
                    }
                }
                &tag[from.min(to)..to]
            }
            Some((at, _)) => {
                let mut to = tag.len();
                while let Some(&(next, c)) = chars.peek() {
                    if c.is_whitespace() {
                        to = next;
                        break;
                    }
                    chars.next();
                }
                &tag[at..to]
            }
            None => "",
        };
        if TEXT_ATTRIBUTES.contains(&name.as_str()) {
            out.push(BARRIER);
            out.push_str(value);
            out.push(BARRIER);
        }
    }
}

fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 1..];
        let end = tail
            .bytes()
            .take(12)
            .position(|byte| byte == b';')
            .filter(|&end| end > 0);
        match end {
            Some(end)
                if tail[..end]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'#') =>
            {
                match entity(&tail[..end]) {
                    Some(decoded) => out.push_str(decoded.as_str()),
                    None => out.push(' '),
                }
                rest = &tail[end + 1..];
            }
            _ => {
                out.push('&');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

fn entity(name: &str) -> Option<String> {
    if let Some(number) = name.strip_prefix('#') {
        let code = match number.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => number.parse().ok()?,
        };
        return char::from_u32(code).map(String::from);
    }
    let decoded = match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "agrave" => "\u{e0}",
        "aacute" => "\u{e1}",
        "acirc" => "\u{e2}",
        "auml" => "\u{e4}",
        "ccedil" => "\u{e7}",
        "egrave" => "\u{e8}",
        "eacute" => "\u{e9}",
        "ecirc" => "\u{ea}",
        "euml" => "\u{eb}",
        "iacute" => "\u{ed}",
        "icirc" => "\u{ee}",
        "iuml" => "\u{ef}",
        "ntilde" => "\u{f1}",
        "oacute" => "\u{f3}",
        "ocirc" => "\u{f4}",
        "ouml" => "\u{f6}",
        "uacute" => "\u{fa}",
        "ucirc" => "\u{fb}",
        "uuml" => "\u{fc}",
        "szlig" => "\u{df}",
        _ => return None,
    };
    Some(decoded.to_string())
}

fn split(text: &str) -> Vec<u64> {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0100_0000_01b3;
    fn push(hash: &mut u64, open: &mut bool, words: &mut Vec<u64>) {
        if *open {
            words.push((*hash).max(EDGE_WORD + 1));
        }
        *hash = OFFSET;
        *open = false;
    }
    fn add(c: char, hash: &mut u64, open: &mut bool) {
        let mut buffer = [0u8; 4];
        for byte in c.encode_utf8(&mut buffer).bytes() {
            *hash = (*hash ^ u64::from(byte)).wrapping_mul(PRIME);
        }
        *open = true;
    }
    let mut words = Vec::new();
    let mut hash = OFFSET;
    let mut open = false;
    for c in text.chars() {
        if c == BARRIER {
            push(&mut hash, &mut open, &mut words);
            if words.last() != Some(&BARRIER_WORD) && !words.is_empty() {
                words.push(BARRIER_WORD);
            }
            continue;
        }
        if c == EDGE {
            push(&mut hash, &mut open, &mut words);
            if words.last() != Some(&EDGE_WORD) && !words.is_empty() {
                words.push(EDGE_WORD);
            }
            continue;
        }
        if matches!(
            c,
            '\u{ad}' | '\u{200b}'..='\u{200d}' | '\u{2060}' | '\u{feff}'
        ) {
            continue;
        }
        let c = match c {
            '\u{ff01}'..='\u{ff5e}' => char::from_u32(c as u32 - 0xfee0).unwrap_or(c),
            _ => c,
        };
        let ligature = match c {
            '\u{fb00}' => Some("ff"),
            '\u{fb01}' => Some("fi"),
            '\u{fb02}' => Some("fl"),
            '\u{fb03}' => Some("ffi"),
            '\u{fb04}' => Some("ffl"),
            '\u{fb05}' | '\u{fb06}' => Some("st"),
            _ => None,
        };
        if let Some(letters) = ligature {
            for letter in letters.chars() {
                add(letter, &mut hash, &mut open);
            }
        } else if c.is_alphanumeric() {
            for lower in c.to_lowercase() {
                add(lower, &mut hash, &mut open);
            }
        } else {
            push(&mut hash, &mut open, &mut words);
        }
    }
    push(&mut hash, &mut open, &mut words);
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    fn same(private: &str, output: &str) -> bool {
        let want = shingle_set(private, Form::Plain);
        let got = shingle_set(output, Form::Output);
        assert!(!want.is_empty(), "{private}");
        !want.is_disjoint(&got)
    }

    const NOTE: &str = "Check again: Smith (2003) disagrees, see p. 41; the 1987 letter is key.";

    #[test]
    fn one_sentence_matches_through_wrapping_markup_entities_and_json() {
        for output in [
            "<p>Check again: Smith (2003) disagrees,\nsee p. 41; the 1987\nletter is key.</p>",
            "<p>Check <em>again</em>: <a href=\"https://x.example/a\">Smith</a> (2003) disagrees, see p. 41; the 1987 letter is key.</p>",
            "<meta name=\"description\" content=\"Check again: Smith (2003) disagrees, see p. 41; the 1987 letter is key.\">",
            "{\"text\":\"check again: smith (2003) disagrees, see p. 41; the 1987 letter is\\nkey.\"}",
            "{\"text\":\"Check again: Smith (2003) disagrees, see p. 41; the 1987 letter is key.\"}",
            "<description>&lt;p&gt;Check &lt;b&gt;again&lt;/b&gt;: Smith (2003) disagrees, see p. 41; the 1987 letter is key.&lt;/p&gt;</description>",
            "<p>Check again&#58; Smith &#x28;2003&#41; disagrees&comma; see p. 41&semi; the 1987 letter is key.</p>",
            "<![CDATA[Check again: Smith (2003) disagrees, see p. 41; the 1987 letter is key.]]>",
            "CHECK AGAIN \u{ff1a} Smith (2003) disagrees, see p. 41; the 1987 letter is key.",
        ] {
            assert!(same(NOTE, output), "{output}");
        }
    }

    #[test]
    fn unrelated_text_and_markup_words_do_not_match() {
        assert!(!same(
            NOTE,
            "<p>Check the cave again: a wall, some shadows, and a fire.</p>"
        ));
        assert!(!same(
            "A private reading of the allegory that only the author has seen",
            "<a href=\"a\">A private</a> reading of <em>the</em> cave"
        ));
    }

    #[test]
    fn text_shorter_than_a_shingle_is_not_guarded() {
        assert!(shingle_set("ask Dana before publishing", Form::Plain).is_empty());
        assert!(shingle_set("one two three four five", Form::Plain).is_empty());
        assert_eq!(
            shingle_set("one two three four five six", Form::Plain).len(),
            1
        );
    }

    #[test]
    fn attribute_values_are_runs_of_their_own() {
        // The attribute's words never join the text around the tag.
        let output = "alpha beta gamma <img alt=\"delta epsilon zeta eta\"> theta iota kappa";
        let all = shingle_set(output, Form::Output);
        let across = shingle_set("gamma delta epsilon zeta eta theta", Form::Plain);
        assert!(all.is_disjoint(&across));
        let inside = shingle_set("delta epsilon zeta eta theta iota", Form::Plain);
        assert!(all.is_disjoint(&inside));
        assert!(shingle_set("alpha beta gamma theta iota kappa", Form::Plain).is_subset(&all));
    }

    #[test]
    fn a_stray_quote_and_angle_bracket_in_a_script_does_not_hang_the_markup_remover() {
        let script =
            "if (a<b && x==\"b>c\") { y = 1 < z + 'q>' ; } else { two three four five six seven }";
        assert!(!shingle_set(script, Form::Output).is_empty());
    }

    #[test]
    fn private_text_is_normalised_like_output_and_backslashes_are_not_json_escapes() {
        let note = "A <i>reading</i> of the <i>cave</i> that the <i>author</i> keeps";
        assert!(same(note, "A reading of the cave that the author keeps"));
        let tex =
            r"Set \theta to the new value before the next run, then copy C:\new\tmp\data back";
        assert!(same(tex, tex));
        assert!(same(tex, &format!("<pre>{tex}</pre>")));
        // A JSON string literal inside a page is still decoded.
        assert!(same(
            "Check again: Smith (2003) disagrees, see p. 41",
            r#"<script>var s = "Check again:\nSmith (2003) disagrees, see p. 41";</script>"#
        ));
    }

    #[test]
    fn json_is_read_field_by_field_so_no_shingle_spans_two_fields() {
        let across = shingle_set("alpha beta gamma delta epsilon zeta", Form::Plain);
        let mut got = HashSet::new();
        each_output_shingle(
            r#"{"a":"one alpha beta gamma","b":"delta epsilon zeta two"}"#,
            None,
            |hash| {
                got.insert(hash);
            },
        );
        assert!(got.is_disjoint(&across));
        let mut got = HashSet::new();
        each_output_shingle(
            r#"{"a":"alpha beta gamma delta epsilon zeta"}"#,
            None,
            |hash| {
                got.insert(hash);
            },
        );
        assert!(!got.is_disjoint(&across));
    }

    #[test]
    fn output_is_cut_at_the_edges_of_known_short_strings() {
        let mut cuts = Cuts::default();
        cuts.add("The cave");
        cuts.add("The divided line");
        cuts.add("Sun");
        let outline = shingle_set(
            "Outline The cave The divided line The sun Conclusion",
            Form::Plain,
        );
        let toc = "<ul><li><a>Outline</a></li><li><a>The cave</a></li><li><a>The divided line</a></li><li><a>Sun</a></li></ul> Conclusion";
        let mut cut = HashSet::new();
        each_output_shingle(toc, Some(&cuts), |hash| {
            cut.insert(hash);
        });
        assert!(cut.is_empty(), "{}", cut.len());
        let mut uncut = HashSet::new();
        each_output_shingle(toc, None, |hash| {
            uncut.insert(hash);
        });
        assert!(!uncut.is_empty());
        // A one-word string is cut only when it is a whole element.
        let sentence = shingle_set("we saw the sun rise over the hill today", Form::Plain);
        let mut got = HashSet::new();
        each_output_shingle(
            "<p>we saw the sun rise over the hill today</p>",
            Some(&cuts),
            |hash| {
                got.insert(hash);
            },
        );
        assert!(!got.is_disjoint(&sentence));
        let _ = outline;
    }

    #[test]
    fn headings_are_read_from_html() {
        assert_eq!(
            headings("<h1 id=\"a\">One <em>big</em></h1><p>x</p><h3>Two &amp; three</h3><hr><header>no</header>"),
            vec!["One big".to_string(), "Two & three".to_string()]
        );
    }
}
