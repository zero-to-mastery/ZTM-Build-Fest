//! HTML escaping helpers shared by the renderer and the feeds.

/// Escape text for placement inside an HTML element or attribute.
pub fn text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    push_text(&mut out, input);
    out
}

/// Append escaped text to an existing buffer.
pub fn push_text(out: &mut String, input: &str) {
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
}

/// Escape text for placement inside a double-quoted attribute value.
pub fn attr(input: &str) -> String {
    text(input)
}

/// Escape text for an XML text node or attribute (feeds, sitemaps).
pub fn xml(input: &str) -> String {
    text(input)
}

/// Percent-encode a value for use inside a URL query component. Everything
/// except unreserved characters (`A-Z a-z 0-9 - _ . ~`) is encoded, which is
/// what `encodeURIComponent` does in JavaScript.
pub fn url_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Wrap arbitrary HTML in a CDATA section, splitting any `]]>` sequences.
pub fn cdata(input: &str) -> String {
    format!("<![CDATA[{}]]>", input.replace("]]>", "]]]]><![CDATA[>"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_all_special_characters() {
        assert_eq!(
            text("<a href=\"x\">'&'</a>"),
            "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
        );
    }

    #[test]
    fn url_components_match_encode_uri_component() {
        assert_eq!(url_component("a b&c=d/é~"), "a%20b%26c%3Dd%2F%C3%A9~");
        assert_eq!(
            url_component("https://x.dev/p/"),
            "https%3A%2F%2Fx.dev%2Fp%2F"
        );
    }

    #[test]
    fn cdata_splits_terminator() {
        assert_eq!(cdata("a]]>b"), "<![CDATA[a]]]]><![CDATA[>b]]>");
    }
}
