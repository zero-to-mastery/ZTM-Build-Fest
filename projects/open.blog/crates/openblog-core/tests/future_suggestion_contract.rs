//! The contracts a suggestion keeps with the hosted function and the browser (#227, ADRs 0153 and
//! 0154): the one rule for a public address and the one submission format, each read by this crate
//! and by `web/components/public-url.js` / `web/components/future-suggestion.js` from the same
//! fixture. The Rust side decides; the fixtures are regenerated with `OPENBLOG_BLESS=1` after a
//! reviewed change, and the node tests must agree case by case.

use openblog_core::citations::public_url_problem;
use openblog_core::date::DateTime;
use openblog_core::feedback_provenance::{FeedbackChannel, ReaderAttribution};
use openblog_core::future_suggestion::{
    identity_scrub_due, normalize_suggestion_url, Conversion, ConversionKind, ErrorCode, Outcome,
    Standing, Submission, Suggestion, MAX_SUBMISSION_BYTES,
};
use openblog_core::moderation::{Actor, ItemFacts, ModerationPolicy, ModerationState};
use serde_json::{json, Value};

const URLS_PATH: &str = "../../tests/fixtures/public-urls.json";
const SUBMISSIONS_PATH: &str = "../../tests/fixtures/future-suggestion-submissions.json";
const WORK: &str = "/posts/tides/";
const RECEIVED_AT: &str = "2026-10-26T10:00:00Z";

fn bless_or_compare(path: &str, produced: &Value) {
    let text = format!("{}\n", serde_json::to_string_pretty(produced).unwrap());
    let full = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    if std::env::var_os("OPENBLOG_BLESS").is_some() {
        std::fs::write(&full, &text).unwrap();
        return;
    }
    let stored = std::fs::read_to_string(&full).unwrap_or_default();
    assert!(
        stored.replace("\r\n", "\n") == text,
        "{path} is not what the Rust side decides; review the change and regenerate it with OPENBLOG_BLESS=1"
    );
}

// ---- Public addresses

fn url_cases() -> Vec<&'static str> {
    vec![
        // Allowed.
        "https://example.org/",
        "https://example.org/a/b?c=d#e",
        "http://example.org:8080/x",
        "https://EXAMPLE.org/Path",
        "https://sub.example.co.uk/x",
        "https://münchen.example/x",
        "https://example.org./x",
        "https://doi.org/10.1234/abc",
        "http://198.20.0.1/x",
        "http://8.8.8.8/",
        "http://[::8.8.8.8]/x",
        "http://[2002:808:808::1]/x",
        "http://[2606:4700:4700::1111]/",
        "http://192.0.2.1/x",
        "http://203.0.113.9/x",
        "http://[2001:db8::1]/x",
        "https://example.org/x?author=ada&keyword=tides",
        "https://example.org/x?sid=google&genre=book",
        "https://example.org/x#Authorship",
        "https://example.org/x#section-2",
        "https://example.org/list?sortKey=title",
        "https://example.org/mss?siglum=A",
        // Not web addresses, other schemes, credentials.
        "",
        "example.org/x",
        "//example.org/x",
        "not a url",
        "javascript:alert(1)",
        "data:text/html,x",
        "file:///etc/passwd",
        "ftp://example.org/x",
        "https://user:pw@example.org/x",
        "https://user@example.org/x",
        // Private and local names.
        "https://localhost/x",
        "http://localhost.localdomain/x",
        "http://localhost.localdomain./x",
        "http://app.localhost/x",
        "http://intranet/x",
        "http://printer.local/x",
        "http://service.internal/x",
        "http://box.lan/x",
        "http://router.home.arpa/x",
        "http://wiki.corp/x",
        "http://build.test/x",
        "http://nas.home/x",
        "http://nas.localdomain/x",
        "http://site.intranet/x",
        // IPv4 in every way it can be written.
        "http://127.0.0.1/x",
        "http://127.1/x",
        "http://2130706433/x",
        "http://0x7f.1/x",
        "http://017700000001/x",
        "http://10.0.0.5/x",
        "http://172.16.0.1/x",
        "http://172.31.255.255/x",
        "http://172.32.0.1/x",
        "http://192.168.1.1/x",
        "http://169.254.169.254/latest",
        "http://100.64.0.1/x",
        "http://100.127.255.255/x",
        "http://100.128.0.1/x",
        "http://198.18.0.1/x",
        "http://198.19.255.254/x",
        "http://224.0.0.1/x",
        "http://239.255.255.250/x",
        "http://240.0.0.1/x",
        "http://255.255.255.255/",
        "http://0.0.0.0/",
        "http://0.1.2.3/",
        // IPv6.
        "http://[::1]/x",
        "http://[::]/x",
        "http://[::127.0.0.1]/",
        "http://[::10.0.0.1]/x",
        "http://[::ffff:127.0.0.1]/",
        "http://[::ffff:10.0.0.1]/",
        "http://[::ffff:8.8.8.8]/",
        "http://[2002:7f00:1::]/",
        "http://[2002:c0a8:104::1]/x",
        "http://[64:ff9b::7f00:1]/",
        "http://[64:ff9b::808:808]/",
        "http://[fec0::1]/",
        "http://[fd00::1]/x",
        "http://[fc00::1]/x",
        "http://[fe80::1]/x",
        "http://[ff02::1]/x",
        // Secret-like parameters.
        "https://example.org/x?access_token=abc",
        "https://example.org/x?apiKey=abc",
        "https://example.org/x?X-Amz-Signature=abc",
        "https://example.org/x?authorization=abc",
        "https://example.org/x?client_secret=abc",
        "https://example.org/x?user_pass=abc",
        "https://example.org/x?sig=abc",
        "https://example.org/x?key=abc",
        "https://example.org/x?API_KEY=abc",
        "https://example.org/x?apikey=abc",
        "https://example.org/x?oauth_token=abc",
        "https://example.org/x?auth=abc",
        "https://example.org/x?userPass=abc",
        "https://example.org/x?sortKey=title&monkey=1&passage=2",
        "https://example.org/x?session_id=1",
        "https://example.org/x#access_token=abc&state=1",
        "https://example.org/x#token=abc",
        "https://example.org/x#a=1&secret=2",
        "https://example.org/x#/route?token=abc",
        "https://example.org/x#Passwords-and-secrets",
        "https://example.org/x?a=1#/route?token=abc",
        "https://books.google.com/books?id=abc&sig=ACfU3U",
    ]
}

#[test]
fn the_public_address_rule_is_the_one_the_browser_reads() {
    let cases: Vec<Value> = url_cases()
        .into_iter()
        .map(|url| json!({ "url": url, "problem": public_url_problem(url) }))
        .collect();
    // A suggestion's link is that rule and nothing more (after B5's own
    // normalization), so one fixture covers both.
    for case in &cases {
        let url = case["url"].as_str().unwrap();
        if let Some(normalized) = normalize_suggestion_url(url) {
            assert!(public_url_problem(&normalized).is_none(), "{url}");
        }
    }
    bless_or_compare(
        URLS_PATH,
        &json!({
            "description": "Web addresses and why each may not be reached as public, or null when it may: read by crates/openblog-core/src/citations.rs (public_url_problem) and web/components/public-url.js, which must agree on every address and every reason. Regenerate with OPENBLOG_BLESS=1 cargo test -p openblog-core --test future_suggestion_contract.",
            "cases": cases,
        }),
    );
}

// ---- Submissions

enum Request {
    Json(Value),
    Text(String),
}

fn base() -> Value {
    json!({
        "version": 1,
        "kind": "future-suggestion",
        "type": "text",
        "text": "Her letters from the 1850 survey would help with the tide tables.",
    })
}

fn with(extra: Value) -> Request {
    let mut value = base();
    for (key, field) in extra.as_object().unwrap() {
        if field.is_null() && key.starts_with('-') {
            value.as_object_mut().unwrap().remove(&key[1..]);
        } else {
            value[key] = field.clone();
        }
    }
    Request::Json(value)
}

fn submission_cases() -> Vec<(String, Request)> {
    let mut cases: Vec<(String, Request)> = Vec::new();
    let mut add = |name: &str, request: Request| cases.push((name.to_string(), request));
    add("the smallest suggestion: words only", with(json!({})));
    add(
        "a question is words only",
        with(json!({ "type": "question", "text": "  What did the 1850 survey leave out?  " })),
    );
    for kind in ["text", "video", "audio", "source"] {
        add(
            &format!("a {kind} with a link and tracking left out"),
            with(json!({ "type": kind, "url": "HTTPS://Example.ORG:443/a/../c?utm_source=x" })),
        );
    }
    add(
        "everything at once",
        with(json!({
            "type": "video",
            "url": "https://Example.org/watch?v=1",
            "hints": {
                "title": "The 1850 survey",
                "creators": ["A. Surveyor", " B. Cartographer "],
                "year": "c. 1850",
                "publisher": "Admiralty",
                "identifiers": [
                    { "scheme": "doi", "value": "10.1234/example" },
                    { "scheme": "isbn", "value": "978-0-306-40615-7" },
                    { "scheme": "issn", "value": "0378-5955" },
                    { "scheme": "url", "value": "https://Example.ORG/a/../b" }
                ]
            },
            "about": { "series": "tides" },
            "attribution": { "name": "  Ada   Lovelace ", "publishName": true },
            "contact": { "address": "ada@example.org", "followUp": true }
        })),
    );
    add(
        "the numbered archives schemes",
        with(json!({ "hints": { "identifiers": [
            { "scheme": "pmid", "value": "123456" },
            { "scheme": "pmcid", "value": "PMC123" }
        ] } })),
    );
    add(
        "an article it is about, a private name and a contact",
        with(json!({
            "about": { "article": "/posts/tides/" },
            "attribution": { "name": "Ada" },
            "contact": { "address": "ada@example.org", "followUp": true }
        })),
    );
    add(
        "a series named in the site's own slugs",
        with(json!({ "about": { "series": "marées-水" } })),
    );
    add("the type is required", with(json!({ "-type": null })));
    add(
        "text at its limit",
        with(json!({ "text": "x".repeat(2_000) })),
    );
    add(
        "text over its limit",
        with(json!({ "text": "x".repeat(2_001) })),
    );
    add(
        "text counts characters not bytes",
        with(json!({ "text": "水".repeat(2_000) })),
    );
    add("empty text", with(json!({ "text": "" })));
    add("blank text", with(json!({ "text": " \u{3000}\n" })));
    add(
        "text with a control character",
        with(json!({ "text": "a\u{7}b" })),
    );
    add(
        "text with a direction override",
        with(json!({ "text": "a\u{202e}b" })),
    );
    add(
        "text keeps tabs and line breaks",
        with(json!({ "text": "line one\r\nline\ttwo" })),
    );
    add("unknown type", with(json!({ "type": "poem" })));
    add("wrong kind", with(json!({ "kind": "question" })));
    add("an unknown field", with(json!({ "rank": 3 })));
    add("a vote", with(json!({ "votes": 3 })));
    add("a wrongly typed text", with(json!({ "text": 5 })));
    add("a null url is none", with(json!({ "url": null })));
    add("a wrongly typed url", with(json!({ "url": 5 })));
    add(
        "a question with a link",
        with(json!({ "type": "question", "url": "https://example.org/" })),
    );
    add(
        "a question with hints",
        with(json!({ "type": "question", "hints": { "title": "t" } })),
    );
    add(
        "a question with empty hints",
        with(json!({ "type": "question", "hints": {} })),
    );
    for (name, url) in [
        ("a link with javascript", "javascript:alert(1)"),
        ("a link with credentials", "https://user:pw@example.org/x"),
        ("a link to this machine", "https://localhost/x"),
        ("a link to a private address", "http://192.168.1.1/x"),
        ("a link to an embedded loopback", "http://[::127.0.0.1]/"),
        ("a link to a 6to4 loopback", "http://[2002:7f00:1::]/"),
        ("a link to a NAT64 loopback", "http://[64:ff9b::7f00:1]/"),
        ("a link to a site-local address", "http://[fec0::1]/"),
        ("a link to a benchmarking address", "http://198.18.0.1/"),
        ("a link to a private suffix", "http://wiki.corp/x"),
        (
            "a link with a token",
            "https://example.org/x?access_token=abc",
        ),
        ("a link with a space", "https://exa mple.org/x"),
        (
            "a link with a direction override",
            "https://example.org/\u{202e}x",
        ),
        ("a link with leading space", " https://example.org/x"),
        ("an empty link", ""),
    ] {
        add(name, with(json!({ "url": url })));
    }
    add(
        "a link over its limit",
        with(json!({ "url": format!("https://example.org/{}", "a".repeat(2_100)) })),
    );
    add(
        "hints are strict",
        with(json!({ "hints": { "title": "t", "rating": 5 } })),
    );
    add(
        "too many creators",
        with(json!({ "hints": { "creators": vec!["a"; 9] } })),
    );
    add(
        "a creator over its limit",
        with(json!({ "hints": { "creators": ["a".repeat(201)] } })),
    );
    add(
        "a blank creator",
        with(json!({ "hints": { "creators": ["  "] } })),
    );
    add(
        "a title over its limit",
        with(json!({ "hints": { "title": "x".repeat(301) } })),
    );
    add(
        "a year over its limit",
        with(json!({ "hints": { "year": "x".repeat(33) } })),
    );
    add(
        "a publisher with a control character",
        with(json!({ "hints": { "publisher": "a\u{0}b" } })),
    );
    add(
        "too many identifiers",
        with(
            json!({ "hints": { "identifiers": vec![json!({ "scheme": "pmid", "value": "1" }); 5] } }),
        ),
    );
    for (name, scheme, value) in [
        ("an ISBN with a bad check digit", "isbn", "9780306406158"),
        ("an ISBN that is too short", "isbn", "123"),
        ("a DOI that is not one", "doi", "not-a-doi"),
        (
            "a DOI with a direction override",
            "doi",
            "10.1234/a\u{202e}b",
        ),
        ("a DOI with a control character", "doi", "10.1234/a\nb"),
        ("an empty identifier", "doi", ""),
        ("a blank identifier", "doi", "   "),
        (
            "a link identifier to a private address",
            "url",
            "http://127.0.0.1/x",
        ),
        (
            "a link identifier with a token",
            "url",
            "https://example.org/x?token=1",
        ),
        (
            "a link identifier that is not http",
            "url",
            "javascript:alert(1)",
        ),
        ("an unknown scheme", "oclc", "12345"),
        ("an upper-case scheme", "DOI", "10.1234/abc"),
        ("a PMID that is not digits", "pmid", "12ab"),
        ("a PMCID that is not PMC and digits", "pmcid", "123"),
        ("an ISSN with a bad check digit", "issn", "0378-5956"),
    ] {
        add(
            name,
            with(json!({ "hints": { "identifiers": [{ "scheme": scheme, "value": value }] } })),
        );
    }
    add(
        "an identifier with an unknown field",
        with(
            json!({ "hints": { "identifiers": [{ "scheme": "doi", "value": "10.1234/a", "x": 1 }] } }),
        ),
    );
    for (name, about) in [
        ("about names nothing", json!({})),
        (
            "about names a series in capitals",
            json!({ "series": "Tides" }),
        ),
        (
            "about names both",
            json!({ "series": "a", "article": "/posts/a/" }),
        ),
        (
            "about an article without a slash",
            json!({ "article": "posts/a" }),
        ),
        (
            "about an article that climbs",
            json!({ "article": "/posts/../a/" }),
        ),
        ("about an unknown topic", json!({ "topic": "x" })),
        ("about is a string", json!("tides")),
        (
            "about a series with two hyphens",
            json!({ "series": "a--b" }),
        ),
        ("about a series with a space", json!({ "series": "a b" })),
        (
            "about a series over its limit",
            json!({ "series": "a".repeat(65) }),
        ),
        (
            "about a series at its limit",
            json!({ "series": "a".repeat(64) }),
        ),
        ("about a non-string series", json!({ "series": 5 })),
    ] {
        add(name, with(json!({ "about": about })));
    }
    add(
        "a name is collapsed and trimmed",
        with(json!({ "attribution": { "name": "\u{a0} Ada \t Lovelace\n" } })),
    );
    add(
        "a name over its limit",
        with(json!({ "attribution": { "name": "x".repeat(81) } })),
    );
    add(
        "a name with a control character",
        with(json!({ "attribution": { "name": "A\u{7}da" } })),
    );
    add(
        "publishing a name needs a name",
        with(json!({ "attribution": { "publishName": true } })),
    );
    add(
        "a blank name cannot be published",
        with(json!({ "attribution": { "name": "   ", "publishName": true } })),
    );
    add(
        "an anonymous attribution is dropped",
        with(json!({ "attribution": { "publishName": false } })),
    );
    add(
        "attribution with an unknown field",
        with(json!({ "attribution": { "name": "Ada", "email": "a@b.c" } })),
    );
    add(
        "contact without agreement",
        with(json!({ "contact": { "address": "ada@example.org", "followUp": false } })),
    );
    add(
        "contact without the agreement field",
        with(json!({ "contact": { "address": "ada@example.org" } })),
    );
    for (name, address) in [
        ("an address without a domain", "ada@"),
        ("an address with a display name", "Ada <ada@example.org>"),
        ("two addresses", "ada@example.org, bob@example.org"),
        ("an address with a space", "ada @example.org"),
        ("an address with doubled dots", "ada..b@example.org"),
        ("an address with a quoted name", "\"ada\"@example.org"),
        (
            "an address with a line break",
            "ada@example.org\r\nBcc: x@y.z",
        ),
        ("an address with a non-ASCII domain", "ada@exämple.org"),
        ("an address with a single-label domain", "ada@example"),
        (
            "an address that is too long",
            &format!("{}@example.org", "a".repeat(64) + &".b".repeat(100)),
        ),
    ] {
        add(
            name,
            with(json!({ "contact": { "address": address, "followUp": true } })),
        );
    }
    add(
        "an address with plus and dots",
        with(json!({ "contact": { "address": "a.b+tag@sub.example.org", "followUp": true } })),
    );
    add("a newer version", with(json!({ "version": 2 })));
    add("version zero", with(json!({ "version": 0 })));
    add(
        "a version written as a string",
        with(json!({ "version": "1" })),
    );
    add(
        "a version written as a float",
        Request::Text(
            base()
                .to_string()
                .replace("\"version\":1", "\"version\":1.0"),
        ),
    );
    add(
        "a version written with an exponent",
        Request::Text(
            base()
                .to_string()
                .replace("\"version\":1", "\"version\":1e0"),
        ),
    );
    add(
        "a version beyond 64 bits",
        Request::Text(
            base()
                .to_string()
                .replace("\"version\":1", "\"version\":18446744073709551616"),
        ),
    );
    add("no version", with(json!({ "-version": null })));
    add("not json", Request::Text("not json".into()));
    add("an array", Request::Text("[]".into()));
    add("a string", Request::Text("\"hello\"".into()));
    add("null", Request::Text("null".into()));
    add("an empty object", Request::Text("{}".into()));
    add(
        "a repeated key keeps the last",
        Request::Text(
            r#"{"version":1,"kind":"future-suggestion","type":"video","type":"audio","text":"A recording of the survey."}"#.into(),
        ),
    );
    add(
        "a lone surrogate",
        Request::Text(
            r#"{"version":1,"kind":"future-suggestion","type":"text","text":"a\ud800b"}"#.into(),
        ),
    );
    add(
        "a number too large to hold",
        Request::Text(
            r#"{"version":1,"kind":"future-suggestion","type":"text","text":"x","x":1e999}"#.into(),
        ),
    );
    add(
        "nesting too deep",
        Request::Text(format!(
            r#"{{"version":1,"kind":"future-suggestion","type":"text","text":"x","x":{}{}}}"#,
            "[".repeat(200),
            "]".repeat(200)
        )),
    );
    add(
        "over the submission bound",
        Request::Text(format!("{}{}", base(), " ".repeat(MAX_SUBMISSION_BYTES))),
    );
    add(
        "text and link at their limits",
        with(json!({
            "text": "x".repeat(2_000),
            "url": format!("https://example.org/{}", "a".repeat(2_000)),
            "hints": { "title": "t".repeat(300), "creators": vec!["c".repeat(200); 8], "publisher": "p".repeat(300) }
        })),
    );
    add(
        "four-byte characters up to the submission bound",
        with(json!({
            "text": "\u{1F4DA}".repeat(2_000),
            "hints": { "title": "\u{1F4DA}".repeat(300), "creators": vec!["\u{1F4DA}".repeat(200); 8], "publisher": "\u{1F4DA}".repeat(300) }
        })),
    );
    // A link of three-byte characters is nine bytes once percent-encoded; five
    // of them, with the hints, fit the submission bound and not the stored row.
    let wide = format!("https://example.org/{}", "\u{6F22}".repeat(225));
    add(
        "links that percent-encoding makes too large for the stored row",
        with(json!({
            "url": wide,
            "hints": {
                "title": "\u{1F600}".repeat(300),
                "publisher": "\u{1F600}".repeat(300),
                "creators": vec!["\u{1F600}".repeat(200); 7],
                "identifiers": vec![json!({ "scheme": "url", "value": wide }); 4]
            }
        })),
    );
    // Details that fit their own bound, beside a text of four-byte characters:
    // the whole record is larger than 16 KiB and must still read back.
    let wide = |tag: &str| format!("https://example.org/{tag}{}", "\u{6C34}".repeat(225));
    add(
        "text and links that make a record larger than 16 KiB",
        with(json!({
            "text": "\u{1F4DA}".repeat(2_000),
            "url": wide(""),
            "hints": { "identifiers": (0..4).map(|i| json!({ "scheme": "url", "value": wide(&i.to_string()) })).collect::<Vec<_>>() }
        })),
    );
    cases
}

fn row_of(suggestion: &Suggestion) -> Value {
    let attribution = &suggestion.submission.attribution;
    json!({
        "format_version": 1,
        "kind": "future-suggestion",
        "work": suggestion.receipt.work,
        "revision": null,
        "target": null,
        "body": suggestion.submission.text,
        "details": suggestion.stored_details(),
        "seen_at": null,
        "received_at": suggestion.receipt.received_at.rfc3339(),
        "channel": "hosted",
        "reader_name": attribution.name,
        "publish_name": attribution.publish_name,
    })
}

#[test]
fn the_submission_format_is_the_one_the_hosted_function_reads() {
    let received = DateTime::parse(RECEIVED_AT).unwrap();
    let mut cases = Vec::new();
    for (name, request) in submission_cases() {
        let text = match &request {
            Request::Json(value) => value.to_string(),
            Request::Text(text) => text.clone(),
        };
        let mut case = match &request {
            Request::Json(value) => json!({ "name": name, "request": value }),
            Request::Text(text) => json!({ "name": name, "text": text }),
        };
        case["expect"] = match Submission::from_json(&text) {
            Ok(submission) => {
                let suggestion =
                    Suggestion::receive(submission, WORK, received, FeedbackChannel::Hosted)
                        .unwrap();
                let record: Value = serde_json::from_str(&suggestion.to_json()).unwrap();
                let row = row_of(&suggestion);
                // The stored row reads back to the same suggestion.
                let back = Suggestion::from_stored(
                    &suggestion.submission.text,
                    1,
                    &row["details"],
                    &record["receipt"],
                    &ReaderAttribution {
                        name: row["reader_name"].as_str().map(str::to_string),
                        publish_name: row["publish_name"].as_bool().unwrap(),
                    },
                )
                .unwrap_or_else(|error| panic!("{name}: {error}"));
                assert_eq!(back, suggestion, "{name}");
                assert!(
                    record.to_string().len() <= openblog_core::future_suggestion::MAX_JSON_BYTES,
                    "{name}"
                );
                json!({ "record": record, "row": row })
            }
            Err(error) => {
                let code = serde_json::to_value(error.code).unwrap();
                json!({ "code": code })
            }
        };
        cases.push(case);
    }
    // Every code the format can give is covered by some case.
    let seen: std::collections::BTreeSet<String> = cases
        .iter()
        .filter_map(|case| case["expect"]["code"].as_str().map(str::to_string))
        .collect();
    for code in [
        ErrorCode::TooLarge,
        ErrorCode::Malformed,
        ErrorCode::UnsupportedVersion,
        ErrorCode::WrongKind,
        ErrorCode::UnknownType,
        ErrorCode::InvalidText,
        ErrorCode::NotForQuestion,
        ErrorCode::InvalidUrl,
        ErrorCode::InvalidHint,
        ErrorCode::InvalidAbout,
        ErrorCode::InvalidName,
        ErrorCode::ConsentWithoutName,
        ErrorCode::InvalidContact,
        ErrorCode::ContactWithoutConsent,
    ] {
        let id = serde_json::to_value(code).unwrap();
        assert!(seen.contains(id.as_str().unwrap()), "no case for {code:?}");
    }
    bless_or_compare(
        SUBMISSIONS_PATH,
        &json!({
            "description": "Suggestions for future work (RD13, ADRs 0152 to 0157), read and received by both crates/openblog-core/src/future_suggestion.rs and web/components/future-suggestion.js. A case's `request` (or its exact `text`) is received for the page `work` at `receivedAt`; `expect` is the canonical record and the openblog_feedback row it is stored as, or the code of the first problem. Regenerate with OPENBLOG_BLESS=1 cargo test -p openblog-core --test future_suggestion_contract.",
            "work": WORK,
            "receivedAt": RECEIVED_AT,
            "cases": cases,
        }),
    );
}

// ---- Standing, outcomes, links and the clearing of private identity (RD13.3, ADRs 0162 to 0164)

const OUTCOMES_PATH: &str = "../../tests/fixtures/future-suggestion-outcomes.json";
const WORKS: [&str; 1] = [WORK];

fn link_value(kind: &str, id: &str, by: &str) -> Value {
    json!({ "kind": kind, "id": id, "at": "2026-10-27T10:00:00Z", "by": by })
}

fn stored_row(status: &str, details: Value, extra: Value) -> Value {
    let mut row = json!({
        "kind": "future-suggestion",
        "status": status,
        "item_revision": 1,
        "approved_revision": if status == "approved" { json!(1) } else { Value::Null },
        "clarification_asked": null,
        "purged_at": null,
        "body": "Her letters from the 1850 survey would help with the tide tables.",
        "details": details,
        "reader_name": null,
        "publish_name": false,
    });
    for (key, field) in extra.as_object().unwrap() {
        row[key] = field.clone();
    }
    row
}

fn suggestion_of(
    row: &Value,
) -> Result<Suggestion, openblog_core::future_suggestion::SuggestionError> {
    Suggestion::from_stored(
        row["body"].as_str().unwrap(),
        row["item_revision"].as_u64().unwrap() as u32,
        &row["details"],
        &json!({ "work": WORK, "receivedAt": RECEIVED_AT, "channel": "hosted" }),
        &ReaderAttribution {
            name: row["reader_name"].as_str().map(str::to_string),
            publish_name: row["publish_name"].as_bool().unwrap(),
        },
    )
}

fn facts_of(row: &Value) -> ItemFacts<'_> {
    ItemFacts {
        id: "item",
        kind: openblog_core::future_suggestion::KIND,
        work: Some(WORK),
        parent: None,
        state: ModerationState::from_id(row["status"].as_str().unwrap()).unwrap(),
        version: 3,
        revision: row["item_revision"].as_u64().unwrap() as u32,
        approved_revision: row["approved_revision"].as_u64().map(|r| r as u32),
        clarification_asked: row["clarification_asked"].as_u64().map(|r| r as u32),
        clarification_consent: false,
        content_retained: row["purged_at"].is_null(),
        state_since: DateTime::parse(RECEIVED_AT).unwrap(),
    }
}

fn link_case(
    links: &mut Vec<Value>,
    name: &str,
    role: &str,
    row: Value,
    kind: &str,
    target: &str,
    actor: &str,
) {
    let at = DateTime::parse("2026-11-01T09:00:00Z").unwrap();
    let request =
        json!({ "role": role, "kind": kind, "target": target, "actor": actor, "at": at.rfc3339() });
    let expect = (|| {
        let suggestion = match suggestion_of(&row) {
            Ok(suggestion) => suggestion,
            Err(error) => return json!({ "code": serde_json::to_value(error.code).unwrap() }),
        };
        let item = facts_of(&row);
        let acting = match role {
            "site-admin" => Actor::SiteAdmin { admin_user: actor },
            "coordinator" => Actor::Coordinator {
                admin_user: actor,
                works: &WORKS,
            },
            "contributing-author" => Actor::ContributingAuthor {
                admin_user: actor,
                works: &WORKS,
            },
            "submitter" => Actor::Submitter,
            _ => Actor::Public,
        };
        let Some(kind) = ConversionKind::from_id(kind) else {
            return json!({ "code": "invalidTarget" });
        };
        match suggestion.linked(&acting, &item, kind, target, at) {
            Ok(next) => json!({ "conversions": next.stored_details()["conversions"] }),
            Err(error) => json!({ "code": error.code() }),
        }
    })();
    links.push(json!({ "name": name, "row": row, "request": request, "expect": expect }));
}

fn details_case(details: &mut Vec<Value>, name: &str, value: Value) {
    let row = stored_row("approved", value.clone(), json!({}));
    let expect = match suggestion_of(&row) {
        Ok(suggestion) => json!({
            "conversions": suggestion.conversions.iter().map(Conversion::to_value).collect::<Vec<_>>()
        }),
        Err(error) => json!({ "code": serde_json::to_value(error.code).unwrap() }),
    };
    details.push(json!({ "name": name, "details": value, "expect": expect }));
}

#[test]
fn standing_outcomes_links_and_clearing_are_the_ones_the_hosted_function_reads() {
    // Standing, outcome and the reader's receipt text, for every state with and without a link.
    let mut standings = Vec::new();
    for state in ModerationState::ALL {
        for linked in [false, true] {
            let links = if linked {
                vec![Conversion::from_value(&link_value("draft", "tide-tables", "owner")).unwrap()]
            } else {
                Vec::new()
            };
            let standing = Standing::of(state, &links);
            let outcome = Outcome::of(state, &links);
            standings.push(json!({
                "state": state.id(),
                "linked": linked,
                "expect": {
                    "standing": { "id": standing.id(), "label": standing.label() },
                    "outcome": outcome.map(|o| json!({ "id": o.id(), "label": o.label() })),
                    "reader": {
                        "note": standing.reader_note(),
                        "acceptance": standing.shows_acceptance_notice(),
                    },
                },
            }));
        }
    }

    // Links: who may record one, on what, and what the stored details become.
    let mut links = Vec::new();
    let approved = || stored_row("approved", json!({ "type": "text" }), json!({}));
    let one = json!([link_value("draft", "tide-tables", "owner")]);
    let l = &mut links;
    link_case(
        l,
        "the site Admin links an accepted suggestion to a draft",
        "site-admin",
        approved(),
        "draft",
        "tide-tables",
        "owner",
    );
    link_case(
        l,
        "a coordinator links it to a series",
        "coordinator",
        approved(),
        "series",
        "the-tides",
        "coord",
    );
    link_case(
        l,
        "a library source is its lowercase ascii id",
        "site-admin",
        approved(),
        "library-source",
        "survey-1850",
        "owner",
    );
    link_case(
        l,
        "a library source id is not a slug with capitals",
        "site-admin",
        approved(),
        "library-source",
        "Survey-1850",
        "owner",
    );
    link_case(
        l,
        "a slug may keep a non-ascii letter",
        "site-admin",
        approved(),
        "draft",
        "mar\u{e9}es-hautes",
        "owner",
    );
    link_case(
        l,
        "a slug is not words",
        "site-admin",
        approved(),
        "draft",
        "Tide Tables",
        "owner",
    );
    link_case(
        l,
        "a slug is not empty",
        "site-admin",
        approved(),
        "series",
        "",
        "owner",
    );
    link_case(
        l,
        "a slug is at most 64 characters",
        "site-admin",
        approved(),
        "series",
        &"a".repeat(65),
        "owner",
    );
    link_case(
        l,
        "an unknown kind",
        "site-admin",
        approved(),
        "post",
        "tide-tables",
        "owner",
    );
    link_case(
        l,
        "a contributing author may not",
        "contributing-author",
        approved(),
        "draft",
        "tide-tables",
        "writer",
    );
    link_case(
        l,
        "a submitter may not",
        "submitter",
        approved(),
        "draft",
        "tide-tables",
        "owner",
    );
    link_case(
        l,
        "the public may not",
        "public",
        approved(),
        "draft",
        "tide-tables",
        "owner",
    );
    for status in [
        "pending",
        "clarification",
        "rejected",
        "removed",
        "withdrawn",
    ] {
        link_case(
            l,
            &format!("a {status} suggestion cannot be linked"),
            "site-admin",
            stored_row(status, json!({ "type": "text" }), json!({})),
            "draft",
            "tide-tables",
            "owner",
        );
    }
    link_case(
        l,
        "an approval of an older text does not count",
        "site-admin",
        stored_row(
            "approved",
            json!({ "type": "text" }),
            json!({ "item_revision": 2, "approved_revision": 1 }),
        ),
        "draft",
        "tide-tables",
        "owner",
    );
    link_case(
        l,
        "a text the reader was asked about cannot be linked",
        "site-admin",
        stored_row(
            "approved",
            json!({ "type": "text" }),
            json!({ "clarification_asked": 1 }),
        ),
        "draft",
        "tide-tables",
        "owner",
    );
    link_case(
        l,
        "a purged suggestion cannot be linked",
        "site-admin",
        stored_row(
            "approved",
            json!({ "type": "text" }),
            json!({ "purged_at": "2026-12-01T00:00:00Z" }),
        ),
        "draft",
        "tide-tables",
        "owner",
    );
    link_case(
        l,
        "the same target twice",
        "site-admin",
        stored_row(
            "approved",
            json!({ "type": "text", "conversions": one }),
            json!({}),
        ),
        "draft",
        "tide-tables",
        "owner",
    );
    link_case(
        l,
        "the same id as another kind is another link",
        "site-admin",
        stored_row(
            "approved",
            json!({ "type": "text", "conversions": one }),
            json!({}),
        ),
        "series",
        "tide-tables",
        "owner",
    );
    link_case(
        l,
        "a second link is added after the first",
        "coordinator",
        stored_row(
            "approved",
            json!({ "type": "text", "conversions": one }),
            json!({}),
        ),
        "library-source",
        "survey-1850",
        "coord",
    );
    let full: Vec<Value> = (0..8)
        .map(|n| link_value("draft", &format!("draft-{n}"), "owner"))
        .collect();
    link_case(
        l,
        "a ninth link",
        "site-admin",
        stored_row(
            "approved",
            json!({ "type": "text", "conversions": full }),
            json!({}),
        ),
        "draft",
        "draft-9",
        "owner",
    );
    link_case(
        l,
        "an Admin account is named",
        "site-admin",
        approved(),
        "draft",
        "tide-tables",
        "",
    );
    link_case(
        l,
        "an Admin account name is at most 64 characters",
        "site-admin",
        approved(),
        "draft",
        "tide-tables",
        &"a".repeat(65),
    );
    link_case(
        l,
        "a link keeps the contact and name out of its record",
        "site-admin",
        stored_row(
            "approved",
            json!({ "type": "text", "contact": { "address": "ada@example.org", "followUp": true } }),
            json!({ "reader_name": "Ada" }),
        ),
        "draft",
        "tide-tables",
        "owner",
    );
    link_case(
        l,
        "links are refused on details that were already malformed",
        "site-admin",
        stored_row(
            "approved",
            json!({ "type": "text", "conversions": [] }),
            json!({}),
        ),
        "draft",
        "tide-tables",
        "owner",
    );

    // Stored details that carry links, read as the build reads them.
    let mut details = Vec::new();
    let d = &mut details;
    details_case(d, "no links", json!({ "type": "text" }));
    details_case(d, "one link", json!({ "type": "text", "conversions": one }));
    let many = |n: usize| -> Vec<Value> {
        (0..n)
            .map(|i| link_value("series", &format!("s-{i}"), "owner"))
            .collect()
    };
    details_case(
        d,
        "eight links",
        json!({ "type": "text", "conversions": many(8) }),
    );
    details_case(
        d,
        "nine links",
        json!({ "type": "text", "conversions": many(9) }),
    );
    details_case(
        d,
        "an empty list",
        json!({ "type": "text", "conversions": [] }),
    );
    details_case(
        d,
        "not a list",
        json!({ "type": "text", "conversions": "draft" }),
    );
    details_case(
        d,
        "a repeated target",
        json!({ "type": "text", "conversions": [link_value("draft", "a", "owner"), link_value("draft", "a", "owner")] }),
    );
    details_case(
        d,
        "an unknown kind",
        json!({ "type": "text", "conversions": [link_value("page", "a", "owner")] }),
    );
    details_case(
        d,
        "an uppercase library id",
        json!({ "type": "text", "conversions": [link_value("library-source", "Survey", "owner")] }),
    );
    details_case(
        d,
        "a time that is not canonical",
        json!({ "type": "text", "conversions": [{ "kind": "draft", "id": "a", "at": "yesterday", "by": "owner" }] }),
    );
    details_case(
        d,
        "an extra field",
        json!({ "type": "text", "conversions": [{ "kind": "draft", "id": "a", "at": "2026-10-27T10:00:00Z", "by": "owner", "note": "x" }] }),
    );
    details_case(
        d,
        "a missing account",
        json!({ "type": "text", "conversions": [{ "kind": "draft", "id": "a", "at": "2026-10-27T10:00:00Z" }] }),
    );
    details_case(
        d,
        "an account with a control character",
        json!({ "type": "text", "conversions": [link_value("draft", "a", "ow\u{7}ner")] }),
    );
    details_case(
        d,
        "an account of 65 characters",
        json!({ "type": "text", "conversions": [link_value("draft", "a", &"o".repeat(65))] }),
    );
    details_case(
        d,
        "links beside a contact",
        json!({ "type": "text", "contact": { "address": "ada@example.org", "followUp": true }, "conversions": one }),
    );

    // The clearing of private identity: once the period has passed, or at once when linked.
    let policy = ModerationPolicy::default();
    let mut scrub = Vec::new();
    for status in ["approved", "pending", "rejected", "removed"] {
        for identity in [
            "a contact",
            "an unshown name",
            "a shown name",
            "nothing private",
        ] {
            for linked in [false, true] {
                for passed in [false, true] {
                    for purged in [false, true] {
                        let mut value = json!({ "type": "text" });
                        if identity == "a contact" {
                            value["contact"] =
                                json!({ "address": "ada@example.org", "followUp": true });
                        }
                        if linked {
                            value["conversions"] = one.clone();
                        }
                        let (name, publish) = match identity {
                            "an unshown name" => (json!("Ada"), false),
                            "a shown name" => (json!("Ada"), true),
                            _ => (Value::Null, false),
                        };
                        let row = stored_row(
                            status,
                            value,
                            json!({
                                "reader_name": name,
                                "publish_name": publish,
                                "purged_at": if purged { json!("2026-12-01T00:00:00Z") } else { Value::Null },
                            }),
                        );
                        let suggestion = suggestion_of(&row).unwrap();
                        let item = facts_of(&row);
                        let now = if passed {
                            "2026-11-25T10:00:00Z"
                        } else {
                            "2026-10-28T10:00:00Z"
                        };
                        let due = identity_scrub_due(
                            &policy,
                            &item,
                            &suggestion,
                            &suggestion.conversions,
                            DateTime::parse(now).unwrap(),
                        );
                        scrub.push(json!({
                            "status": status, "identity": identity, "linked": linked,
                            "periodPassed": passed, "purged": purged,
                            "row": row, "expect": due,
                        }));
                    }
                }
            }
        }
    }
    assert!(scrub.iter().any(|case| case["expect"] == true));
    assert!(scrub.iter().any(|case| case["expect"] == false));

    bless_or_compare(
        OUTCOMES_PATH,
        &json!({
            "description": "Editorial standing, outcomes, links to future work and the clearing of private identity (RD13.3, ADRs 0162 to 0164), decided by crates/openblog-core/src/future_suggestion.rs and read by web/components/future-suggestion.js and the hosted function. `standings`: a moderation state with and without a recorded link, and the standing, outcome and reader's receipt text derived. `links`: a stored row and a request, and the links the details hold afterwards or the code that refused it. `details`: stored details read for their links. `scrub`: a stored row, and whether it owes the clearing of its contact and unshown name now (`periodPassed` says the closed-item period has passed). Regenerate with OPENBLOG_BLESS=1 cargo test -p openblog-core --test future_suggestion_contract.",
            "standings": standings,
            "links": links,
            "details": details,
            "scrub": scrub,
        }),
    );
}
