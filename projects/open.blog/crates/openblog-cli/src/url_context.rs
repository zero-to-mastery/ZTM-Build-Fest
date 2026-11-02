//! Explicit, bounded URL snapshots used as untrusted Assistant reference data.

use std::net::IpAddr;
#[cfg(test)]
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use openblog_core::frontmatter::{self, Value};
use serde::{Deserialize, Serialize};
use ureq::config::Config;
use url::{Host, Url};

use crate::safe_http::{is_public_ip, public_agent, PublicResolver};

const MAX_REDIRECTS: usize = 4;
const MAX_RESPONSE_BYTES: u64 = 512 * 1024;
const MAX_EXTRACTED_BYTES: usize = 64 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlContextSnapshot {
    pub source_url: String,
    pub canonical_url: String,
    pub retrieved_at: String,
    pub content_type: String,
    pub text: String,
}

pub fn snapshot_markdown(snapshot: &UrlContextSnapshot) -> Result<String, String> {
    validate_snapshot(snapshot)?;
    let fields = std::collections::BTreeMap::from([
        (
            "canonicalUrl".into(),
            Value::Scalar(snapshot.canonical_url.clone()),
        ),
        (
            "contentType".into(),
            Value::Scalar(snapshot.content_type.clone()),
        ),
        (
            "retrievedAt".into(),
            Value::Scalar(snapshot.retrieved_at.clone()),
        ),
        (
            "sourceUrl".into(),
            Value::Scalar(snapshot.source_url.clone()),
        ),
        ("type".into(), Value::Scalar("url-context-snapshot".into())),
    ]);
    Ok(frontmatter::compose(&fields, &snapshot.text))
}

pub fn parse_snapshot_markdown(source: &str) -> Result<UrlContextSnapshot, String> {
    let document = frontmatter::parse(source)?;
    let get = |key| {
        document
            .front_matter
            .get(key)
            .map(str::to_string)
            .ok_or_else(|| format!("URL snapshot is missing `{key}` metadata"))
    };
    if get("type")? != "url-context-snapshot" {
        return Err("Reference is not a URL context snapshot".into());
    }
    let snapshot = UrlContextSnapshot {
        source_url: get("sourceUrl")?,
        canonical_url: get("canonicalUrl")?,
        retrieved_at: get("retrievedAt")?,
        content_type: get("contentType")?,
        text: document.body.trim_matches(['\r', '\n']).to_string(),
    };
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
}

pub fn is_snapshot_markdown(source: &str) -> bool {
    frontmatter::parse(source)
        .ok()
        .and_then(|document| document.front_matter.get("type").map(str::to_string))
        .as_deref()
        == Some("url-context-snapshot")
}

fn validate_snapshot(snapshot: &UrlContextSnapshot) -> Result<(), String> {
    validate_public_url(&snapshot.source_url)?;
    validate_public_url(&snapshot.canonical_url)?;
    if snapshot.retrieved_at.len() > 64
        || openblog_core::DateTime::parse(&snapshot.retrieved_at).is_none()
    {
        return Err("URL snapshot retrieval time is invalid".into());
    }
    if !matches!(
        snapshot.content_type.as_str(),
        "text/html" | "application/xhtml+xml" | "text/plain" | "text/markdown"
    ) {
        return Err("URL snapshot content type is unsupported".into());
    }
    if snapshot.text.trim().is_empty() || snapshot.text.len() > MAX_EXTRACTED_BYTES {
        return Err("URL snapshot text must contain at most 64 KiB".into());
    }
    Ok(())
}

pub fn validate_public_url(source: &str) -> Result<Url, String> {
    let url = Url::parse(source).map_err(|_| "Enter a complete HTTP(S) URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("URL context supports only HTTP(S) addresses".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URL context addresses cannot contain credentials".into());
    }
    let host = url
        .host()
        .ok_or_else(|| "URL context requires a host".to_string())?;
    match host {
        Host::Ipv4(address) if !is_public_ip(IpAddr::V4(address)) => {
            Err("URL context cannot retrieve local or private network addresses".into())
        }
        Host::Ipv6(address) if !is_public_ip(IpAddr::V6(address)) => {
            Err("URL context cannot retrieve local or private network addresses".into())
        }
        Host::Domain(domain)
            if domain.eq_ignore_ascii_case("localhost")
                || domain.to_ascii_lowercase().ends_with(".localhost") =>
        {
            Err("URL context cannot retrieve local or private network addresses".into())
        }
        _ => Ok(url),
    }
}

pub fn fetch_url_snapshot(source: &str, retrieved_at: &str) -> Result<UrlContextSnapshot, String> {
    fetch_url_snapshot_with_resolver(
        source,
        retrieved_at,
        PublicResolver::default(),
        FETCH_TIMEOUT,
    )
}

#[cfg(test)]
fn fetch_url_snapshot_for_test(
    source: &str,
    address: SocketAddr,
    retrieved_at: &str,
) -> Result<UrlContextSnapshot, String> {
    fetch_url_snapshot_with_resolver(
        source,
        retrieved_at,
        PublicResolver::mapped_for_local_test("url-context.test", address),
        FETCH_TIMEOUT,
    )
}

#[cfg(test)]
fn fetch_url_snapshot_for_test_with_timeout(
    source: &str,
    address: SocketAddr,
    retrieved_at: &str,
    timeout: Duration,
) -> Result<UrlContextSnapshot, String> {
    fetch_url_snapshot_with_resolver(
        source,
        retrieved_at,
        PublicResolver::mapped_for_local_test("url-context.test", address),
        timeout,
    )
}

fn fetch_url_snapshot_with_resolver(
    source: &str,
    retrieved_at: &str,
    resolver: PublicResolver,
    timeout: Duration,
) -> Result<UrlContextSnapshot, String> {
    let source_url = validate_public_url(source)?;
    let started = Instant::now();
    let mut current = source_url.clone();
    for redirect_count in 0..=MAX_REDIRECTS {
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err("URL context retrieval timed out".into());
        }
        validate_public_url(current.as_str())?;
        let config = Config::builder()
            .max_redirects(0)
            .proxy(None)
            .timeout_global(Some(remaining))
            .user_agent(concat!("open.blog-admin/", env!("CARGO_PKG_VERSION")))
            .build();
        let agent = public_agent(config, resolver.clone());
        let mut response = agent
            .get(current.as_str())
            .header("Accept", "text/html, text/markdown, text/plain")
            .header("Accept-Encoding", "identity")
            .call()
            .map_err(|error| match error {
                ureq::Error::Timeout(_) => "URL context retrieval timed out".to_string(),
                ureq::Error::StatusCode(status) => {
                    format!("URL context source returned HTTP {status}")
                }
                _ => "URL context source could not be retrieved safely".to_string(),
            })?;
        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err("URL context source redirected too many times".into());
            }
            let location = response
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    "URL context redirect did not provide a valid destination".to_string()
                })?;
            current = current
                .join(location)
                .map_err(|_| "URL context redirect destination is invalid".to_string())?;
            validate_public_url(current.as_str())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "URL context source returned HTTP {}",
                response.status()
            ));
        }
        if response
            .headers()
            .get("content-encoding")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
        {
            return Err("Compressed URL context responses are not supported".into());
        }
        if response
            .headers()
            .get("content-length")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|length| length > MAX_RESPONSE_BYTES)
        {
            return Err("URL context response exceeds the 512 KiB limit".into());
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .map(|value| {
                value
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase()
            })
            .ok_or_else(|| {
                "URL context source did not declare a supported content type".to_string()
            })?;
        if !matches!(
            content_type.as_str(),
            "text/html" | "application/xhtml+xml" | "text/plain" | "text/markdown"
        ) {
            return Err("URL context supports only HTML, Markdown, and plain text".into());
        }
        let bytes = response
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE_BYTES + 1)
            .read_to_vec()
            .map_err(|error| {
                if matches!(error, ureq::Error::BodyExceedsLimit(_)) {
                    "URL context response exceeds the 512 KiB limit".to_string()
                } else {
                    "URL context response could not be read safely".to_string()
                }
            })?;
        if bytes.len() as u64 > MAX_RESPONSE_BYTES {
            return Err("URL context response exceeds the 512 KiB limit".into());
        }
        let body = String::from_utf8(bytes)
            .map_err(|_| "URL context source is not valid UTF-8 text".to_string())?;
        let text = if matches!(content_type.as_str(), "text/html" | "application/xhtml+xml") {
            htmd::convert(&body)
                .map_err(|_| "URL context HTML could not be converted to text".to_string())?
        } else {
            body
        };
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("URL context source contained no usable text".into());
        }
        if text.len() > MAX_EXTRACTED_BYTES {
            return Err("Extracted URL context exceeds the 64 KiB limit".into());
        }
        return Ok(UrlContextSnapshot {
            source_url: source_url.to_string(),
            canonical_url: current.to_string(),
            retrieved_at: retrieved_at.to_string(),
            content_type,
            text,
        });
    }
    Err("URL context source redirected too many times".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn network_policy_rejects_non_public_ipv4_and_ipv6_ranges() {
        for address in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.0.1",
            "192.88.99.1",
            "198.18.0.1",
            "224.0.0.1",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2001::1",
            "2001:2::1",
            "2001:10::1",
            "2001:20::1",
            "2002:7f00:1::",
            "3fff::1",
            "ff02::1",
        ] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }
        for address in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(is_public_ip(address.parse().unwrap()), "{address}");
        }
    }

    #[test]
    fn snapshot_metadata_requires_a_real_retrieval_timestamp() {
        let snapshot = UrlContextSnapshot {
            source_url: "https://example.com/start".into(),
            canonical_url: "https://example.com/final".into(),
            retrieved_at: "not-a-date".into(),
            content_type: "text/plain".into(),
            text: "Reference".into(),
        };
        assert_eq!(
            snapshot_markdown(&snapshot).unwrap_err(),
            "URL snapshot retrieval time is invalid"
        );
    }

    #[test]
    fn explicit_fetch_revalidates_redirects_and_extracts_bounded_html() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let body = "<h1>Reference</h1><p>Useful <b>text</b>.</p>";
            for response in [
                "HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 2048];
                let _ = stream.read(&mut request).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });

        let source = format!("http://url-context.test:{}/start", address.port());
        let snapshot = fetch_url_snapshot_for_test(&source, address, "2026-10-23T12:00:00Z")
            .expect("the controlled public-host fixture should be retrievable");
        server.join().unwrap();
        assert_eq!(snapshot.source_url, source);
        assert_eq!(
            snapshot.canonical_url,
            format!("http://url-context.test:{}/final", address.port())
        );
        assert_eq!(snapshot.retrieved_at, "2026-10-23T12:00:00Z");
        assert_eq!(snapshot.content_type, "text/html");
        assert_eq!(snapshot.text, "# Reference\n\nUseful **text**.");
    }

    #[test]
    fn explicit_fetch_has_one_total_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).unwrap();
            thread::sleep(Duration::from_millis(80));
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        });
        let source = format!("http://url-context.test:{}/slow", address.port());
        let error = fetch_url_snapshot_for_test_with_timeout(
            &source,
            address,
            "2026-10-23T12:00:00Z",
            Duration::from_millis(20),
        )
        .unwrap_err();
        server.join().unwrap();
        assert!(error.contains("timed out"), "{error}");
    }

    #[test]
    fn explicit_fetch_rejects_unsafe_redirects_sizes_encodings_and_content_types() {
        for (response, expected) in [
            (
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                "local or private",
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope".to_string(),
                "only HTML, Markdown, and plain text",
            ),
            (
                format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_RESPONSE_BYTES + 1),
                "512 KiB",
            ),
            (
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n{}",
                    "x".repeat(MAX_RESPONSE_BYTES as usize + 1)
                ),
                "512 KiB",
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Encoding: gzip\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope".to_string(),
                "Compressed",
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 2048];
                let _ = stream.read(&mut request).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            });
            let source = format!("http://url-context.test:{}/reference", address.port());
            let error = fetch_url_snapshot_for_test(&source, address, "2026-10-23T12:00:00Z")
                .unwrap_err();
            server.join().unwrap();
            assert!(error.contains(expected), "expected {expected:?} in {error:?}");
        }
    }

    #[test]
    fn explicit_fetch_limits_redirect_count() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for _ in 0..=MAX_REDIRECTS {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 2048];
                let _ = stream.read(&mut request).unwrap();
                stream
                    .write_all(b"HTTP/1.1 302 Found\r\nLocation: /again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .unwrap();
            }
        });
        let source = format!("http://url-context.test:{}/start", address.port());
        let error =
            fetch_url_snapshot_for_test(&source, address, "2026-10-23T12:00:00Z").unwrap_err();
        server.join().unwrap();
        assert!(error.contains("redirected too many times"), "{error}");
    }
}
