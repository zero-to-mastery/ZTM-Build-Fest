//! URL slug generation.

/// Convert free text into a lowercase, hyphen-separated slug.
///
/// Letters and digits (including non-ASCII letters) are kept, everything else
/// becomes a single hyphen, and leading/trailing hyphens are trimmed.
pub fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_dash = false;
    for ch in input.chars() {
        if ch.is_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
        } else {
            pending_dash = true;
        }
    }
    out
}

/// Cut a slug to at most `max` characters, preferring a hyphen boundary, so
/// a pathological tag can never produce an over-long directory name.
pub fn limit(slug: &str, max: usize) -> String {
    if slug.chars().count() <= max {
        return slug.to_string();
    }
    let cut: String = slug.chars().take(max).collect();
    let trimmed = match cut.rfind('-') {
        Some(pos) if pos > max / 2 => &cut[..pos],
        _ => cut.as_str(),
    };
    trimmed.trim_end_matches('-').to_string()
}

/// Slug for a file stem: strips a leading `YYYY-MM-DD-` date prefix so
/// `2026-10-21-my-post.md` and `my-post.md` both map to `my-post`.
pub fn from_file_stem(stem: &str) -> String {
    let bytes = stem.as_bytes();
    let has_date_prefix = bytes.len() > 11
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if has_date_prefix {
        slugify(&stem[11..])
    } else {
        slugify(stem)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies_punctuation_and_case() {
        assert_eq!(
            slugify(" `false` Is Not an Answer. "),
            "false-is-not-an-answer"
        );
        assert_eq!(slugify("Rust & WASM: a tale"), "rust-wasm-a-tale");
        assert_eq!(slugify("Déjà vu"), "déjà-vu");
    }

    #[test]
    fn limits_long_slugs_at_a_hyphen() {
        assert_eq!(limit("short", 10), "short");
        assert_eq!(limit("alpha-beta-gamma-delta", 14), "alpha-beta");
        assert_eq!(limit("abcdefghijklmnop", 5), "abcde");
    }

    #[test]
    fn strips_date_prefix_from_file_stems() {
        assert_eq!(from_file_stem("2026-10-21-hello-world"), "hello-world");
        assert_eq!(from_file_stem("hello-world"), "hello-world");
        assert_eq!(from_file_stem("2026-1-21-x"), "2026-1-21-x");
    }
}
