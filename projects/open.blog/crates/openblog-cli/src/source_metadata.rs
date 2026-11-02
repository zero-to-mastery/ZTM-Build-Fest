//! Optional, bounded metadata suggestions for the source of a shared reflection.
//!
//! An author may ask for details about a link to a supported provider (the providers that
//! `openblog_core::embed` already renders). The request goes to the provider's fixed oEmbed
//! endpoint with an address rebuilt from validated parts, through the shared public-address HTTP
//! policy, with no redirects, one total deadline, and a small response limit. Only a title, a
//! creator, and a provider name are read. Transcripts, captions, and pages are never fetched.
//! Suggestions are labelled with their provider, are never stored by this module, and the caller
//! applies them only to fields the author left empty.

use std::time::Duration;

use openblog_core::embed::{self, Embed};
use serde::Serialize;
use ureq::config::Config;
use url::Url;

use crate::safe_http::{public_agent, PublicResolver};

const MAX_RESPONSE_BYTES: u64 = 16 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_TITLE_BYTES: usize = 300;
const MAX_NAME_BYTES: usize = 200;
const UNAVAILABLE: &str = "The provider did not give details for this link.";
const REJECTED: &str = "The provider's answer was not in a form we accept.";

/// A provider's values for one link, bounded and reduced to single-line plain text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub provider: &'static str,
    /// Always `"provider"`: these values were not typed by the author.
    pub provenance: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Lookup {
    /// Not a link to a supported provider; nothing was fetched.
    Unsupported,
    /// Recognised, but the provider did not give usable details.
    Unavailable(&'static str, Embed),
    Found(Suggestion, Embed),
}

/// Recognise the link offline, then ask the provider for details. Failure is a normal outcome.
pub fn lookup(raw_url: &str) -> Lookup {
    let Some(found) = embed::detect(raw_url) else {
        return Lookup::Unsupported;
    };
    let Some(endpoint) = endpoint(&found) else {
        return Lookup::Unavailable(UNAVAILABLE, found);
    };
    match fetch(
        &endpoint,
        found.provider,
        PublicResolver::default(),
        FETCH_TIMEOUT,
    ) {
        Ok(suggestion) => Lookup::Found(suggestion, found),
        Err(reason) => Lookup::Unavailable(reason, found),
    }
}

/// The provider's fixed oEmbed address for the canonical link rebuilt by the embed renderer.
fn endpoint(found: &Embed) -> Option<Url> {
    let base = match found.provider {
        "youtube" => "https://www.youtube.com/oembed",
        "codepen" => "https://codepen.io/api/oembed",
        _ => return None,
    };
    Url::parse_with_params(base, [("url", found.link.as_str()), ("format", "json")]).ok()
}

fn provider_name(provider: &str) -> Option<&'static str> {
    match provider {
        "youtube" => Some("YouTube"),
        "codepen" => Some("CodePen"),
        _ => None,
    }
}

fn fetch(
    endpoint: &Url,
    provider: &'static str,
    resolver: PublicResolver,
    timeout: Duration,
) -> Result<Suggestion, &'static str> {
    let config = Config::builder()
        .max_redirects(0)
        .proxy(None)
        .timeout_global(Some(timeout))
        .user_agent(concat!("open.blog-admin/", env!("CARGO_PKG_VERSION")))
        .build();
    let mut response = public_agent(config, resolver)
        .get(endpoint.as_str())
        .header("Accept", "application/json")
        .header("Accept-Encoding", "identity")
        .call()
        .map_err(|error| match error {
            ureq::Error::Timeout(_) => "The provider took too long to answer.",
            _ => UNAVAILABLE,
        })?;
    if !response.status().is_success() {
        return Err(UNAVAILABLE);
    }
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.trim().to_ascii_lowercase())
    };
    let is_json = header("content-type").is_some_and(|value| {
        let value = value.split(';').next().unwrap_or("").trim();
        value == "application/json" || value.ends_with("+json")
    });
    let compressed = header("content-encoding").is_some_and(|value| value != "identity");
    if !is_json || compressed {
        return Err(REJECTED);
    }
    let bytes = response
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE_BYTES)
        .read_to_vec()
        .map_err(|error| match error {
            ureq::Error::Timeout(_) => "The provider took too long to answer.",
            _ => "The provider's answer was too large or could not be read.",
        })?;
    parse(&bytes, provider)
}

fn parse(bytes: &[u8], provider: &'static str) -> Result<Suggestion, &'static str> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| REJECTED)?;
    let object = value.as_object().ok_or(REJECTED)?;
    let field = |key: &str, limit: usize| {
        object
            .get(key)
            .and_then(|value| value.as_str())
            .and_then(|text| plain_line(text, limit))
    };
    let suggestion = Suggestion {
        provider,
        provenance: "provider",
        title: field("title", MAX_TITLE_BYTES),
        creator: field("author_name", MAX_NAME_BYTES),
        publisher: provider_name(provider).map(str::to_string),
    };
    if suggestion.title.is_none() && suggestion.creator.is_none() {
        return Err("The provider had no details for this link.");
    }
    Ok(suggestion)
}

/// One line of visible text within `limit` bytes: control and format characters dropped,
/// whitespace collapsed, cut at a character boundary. Markup is kept as inert text; the Admin
/// form shows it in text fields and the renderer escapes it on output.
fn plain_line(text: &str, limit: usize) -> Option<String> {
    let mut out = String::new();
    let mut pending_space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if c.is_control()
            || matches!(
                c,
                '\u{200b}'..='\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2060}'..='\u{2064}'
                    | '\u{2066}'..='\u{2069}'
                    | '\u{feff}'
            )
        {
            continue;
        }
        let width = c.len_utf8() + usize::from(pending_space);
        if out.len() + width > limit {
            break;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(c);
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::thread;
    use std::time::Instant;

    fn serve(responses: Vec<String>) -> (SocketAddr, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buffer = [0_u8; 4096];
                let n = stream.read(&mut buffer).unwrap();
                requests.push(String::from_utf8_lossy(&buffer[..n]).into_owned());
                let _ = stream.write_all(response.as_bytes());
            }
            requests
        });
        (address, handle)
    }

    fn json_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn run(address: SocketAddr, timeout: Duration) -> Result<Suggestion, &'static str> {
        let endpoint = Url::parse(&format!(
            "http://oembed.test:{}/oembed?format=json",
            address.port()
        ))
        .unwrap();
        fetch(
            &endpoint,
            "youtube",
            PublicResolver::mapped_for_local_test("oembed.test", address),
            timeout,
        )
    }

    #[test]
    fn reads_only_bounded_labelled_fields_and_never_asks_for_a_transcript() {
        let body = r#"{"title":"  The Art\u0000 of\n Noticing ","author_name":"A <b>channel</b>","html":"<iframe src=//evil>","thumbnail_url":"http://127.0.0.1/x","provider_name":"Spoof"}"#;
        let (address, server) = serve(vec![json_response(body)]);
        let suggestion = run(address, Duration::from_secs(5)).unwrap();
        let requests = server.join().unwrap();
        assert_eq!(suggestion.title.as_deref(), Some("The Art of Noticing"));
        assert_eq!(suggestion.creator.as_deref(), Some("A <b>channel</b>"));
        assert_eq!(suggestion.publisher.as_deref(), Some("YouTube"));
        assert_eq!(suggestion.provenance, "provider");
        let serialized = serde_json::to_string(&suggestion).unwrap();
        assert!(!serialized.contains("iframe") && !serialized.contains("127.0.0.1"));
        assert_eq!(requests.len(), 1, "one request, no follow-up fetches");
        assert!(requests[0].starts_with("GET /oembed"));
        let request = requests[0].to_ascii_lowercase();
        assert!(!request.contains("transcript") && !request.contains("caption"));
    }

    #[test]
    fn hostile_values_are_truncated_to_one_line_of_text() {
        let long = "é".repeat(1000);
        let body =
            format!("{{\"title\":\"{long}\",\"author_name\":\"a\\u202eb\\u200bc\\r\\n\\t d\"}}");
        let (address, server) = serve(vec![json_response(&body)]);
        let suggestion = run(address, Duration::from_secs(5)).unwrap();
        server.join().unwrap();
        let title = suggestion.title.unwrap();
        assert!(title.len() <= MAX_TITLE_BYTES && title.chars().all(|c| c == 'é'));
        assert_eq!(suggestion.creator.as_deref(), Some("abc d"));
    }

    #[test]
    fn missing_wrong_or_changed_metadata_is_unavailable() {
        for body in [
            "{}",
            "[]",
            "null",
            r#"{"title":42,"author_name":["x"]}"#,
            r#"{"title":"   ","author_name":"\u0007"}"#,
            "not json",
        ] {
            let (address, server) = serve(vec![json_response(body)]);
            assert!(run(address, Duration::from_secs(5)).is_err(), "{body}");
            server.join().unwrap();
        }
    }

    #[test]
    fn refuses_redirects_oversize_wrong_type_compression_and_status_failures() {
        let big = format!(
            r#"{{"title":"{}"}}"#,
            "x".repeat(MAX_RESPONSE_BYTES as usize + 10)
        );
        for response in [
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_string(),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_string(),
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
            "HTTP/1.1 500 Oops\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
            json_response(&big),
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{big}"),
        ] {
            let (address, server) = serve(vec![response.clone()]);
            assert!(run(address, Duration::from_secs(5)).is_err(), "{response:.80}");
            // The server accepts exactly one connection, so a redirect is never followed.
            server.join().unwrap();
        }
    }

    #[test]
    fn a_slow_provider_times_out_without_blocking() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 2048];
            let _ = stream.read(&mut buffer);
            thread::sleep(Duration::from_millis(400));
            let _ = stream.write_all(json_response(r#"{"title":"late"}"#).as_bytes());
        });
        let started = Instant::now();
        let error = run(address, Duration::from_millis(40)).unwrap_err();
        assert!(error.contains("too long"), "{error}");
        assert!(started.elapsed() < Duration::from_millis(350));
        server.join().unwrap();
    }

    #[test]
    fn public_policy_refuses_private_targets_before_connecting() {
        for target in ["http://127.0.0.1:9/oembed", "http://localhost:9/oembed"] {
            let endpoint = Url::parse(target).unwrap();
            assert!(fetch(
                &endpoint,
                "youtube",
                PublicResolver::default(),
                Duration::from_secs(2)
            )
            .is_err());
        }
    }

    #[test]
    fn only_supported_links_are_fetched_from_fixed_endpoints() {
        for url in [
            "https://example.com/video",
            "http://127.0.0.1/admin",
            "https://evil.test/?u=https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "javascript:alert(1)",
            "",
        ] {
            assert_eq!(lookup(url), Lookup::Unsupported, "{url}");
        }
        let found =
            embed::detect("https://youtu.be/dQw4w9WgXcQ?si=track&x=http://127.0.0.1").unwrap();
        let youtube = endpoint(&found).unwrap();
        assert_eq!(youtube.host_str(), Some("www.youtube.com"));
        assert_eq!(youtube.path(), "/oembed");
        let pairs: Vec<_> = youtube.query_pairs().into_owned().collect();
        assert_eq!(
            pairs,
            vec![
                (
                    "url".to_string(),
                    "https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_string()
                ),
                ("format".to_string(), "json".to_string())
            ]
        );
        let pen = embed::detect("https://codepen.io/a/pen/b").unwrap();
        assert_eq!(endpoint(&pen).unwrap().host_str(), Some("codepen.io"));
    }
}
