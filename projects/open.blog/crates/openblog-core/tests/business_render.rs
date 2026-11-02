//! Business facts on the built site (ADR 0305, ADR 0306, #507).
//!
//! The invariant: a site that never states business facts builds exactly as it did before. When it
//! does, one block appears identically on every page and the home page carries `LocalBusiness`
//! structured data with only the fields that were stated.

use std::collections::BTreeMap;

use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};
use serde_json::{json, Value};

fn config(business: Option<Value>) -> SiteConfig {
    let mut value = json!({
        "title": "Maple Falls Flooring",
        "url": "https://example.com",
        "author": {"name": "Ada", "url": "https://example.com/about/"},
        "postsPerPage": 2,
        "feeds": {"rss": true}
    });
    if let Some(business) = business {
        value["business"] = business;
    }
    SiteConfig::from_json(&value.to_string()).unwrap()
}

fn post(slug: &str, day: u32) -> SourceFile {
    SourceFile {
        path: format!("posts/{slug}.md"),
        contents: format!(
            "---\ntitle: Post {slug}\ndate: 2026-10-{day:02}\n---\nBody of {slug}.\n"
        ),
    }
}

fn sources(landing: Option<Value>) -> Sources {
    Sources {
        posts: vec![post("one", 1), post("two", 2), post("three", 3)],
        landing: landing.map(|value| SourceFile {
            path: "content/landing.json".into(),
            contents: value.to_string(),
        }),
        ..Default::default()
    }
}

fn build(config: SiteConfig, landing: Option<Value>) -> BTreeMap<String, String> {
    let site = Site::load(config, sources(landing), LoadOptions::default()).expect("site");
    generate(&site, &ThemeSet::new())
        .expect("generated")
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

fn full() -> Value {
    json!({
        "version": 1,
        "legalName": "Maple Falls Flooring LLC",
        "displayName": "Maple Falls Flooring",
        "trade": "flooring",
        "phone": "+13605550142",
        "email": "office@example.com",
        "hours": {
            "monday": {"open": "08:00", "close": "17:00"},
            "tuesday": {"open": "08:00", "close": "17:00"},
            "wednesday": {"open": "08:00", "close": "17:00"},
            "thursday": {"open": "08:00", "close": "17:00"},
            "friday": {"open": "08:00", "close": "17:00"},
            "saturday": {"open": "09:00", "close": "12:30"},
            "sunday": {"closed": true}
        },
        "licenseNumber": "MAPLEF*123",
        "licenseIssuer": "WA L&I",
        "insured": true,
        "paymentMethods": ["cash", "check", "credit-card"],
        "foundedYear": 1998
    })
}

/// Every JSON-LD script on a page, parsed.
fn json_ld(page: &str) -> Vec<Value> {
    let marker = "<script type=\"application/ld+json\">";
    page.match_indices(marker)
        .map(|(start, _)| {
            let rest = &page[start + marker.len()..];
            let end = rest.find("</script>").expect("closed script");
            serde_json::from_str(&rest[..end]).expect("JSON-LD is valid JSON")
        })
        .collect()
}

fn block(page: &str) -> &str {
    let start = page
        .find("<section class=\"ob-footer-business\"")
        .expect("business block");
    let end = page[start..].find("</section>").unwrap() + start + "</section>".len();
    &page[start..end]
}

/// schema.org types that are `LocalBusiness` or one of its subtypes, as this feature may emit them.
const LOCAL_BUSINESS_TYPES: &[&str] = &[
    "LocalBusiness",
    "GeneralContractor",
    "HomeAndConstructionBusiness",
    "RoofingContractor",
    "Plumber",
    "Electrician",
    "HVACBusiness",
    "HousePainter",
    "AutoRepair",
    "AutoBodyShop",
    "Locksmith",
];

const SCHEMA_DAYS: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];

fn is_clock(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && value[..2].parse::<u8>().is_ok_and(|h| h < 24)
        && value[3..].parse::<u8>().is_ok_and(|m| m < 60)
}

/// A structural check of the `LocalBusiness` shape this engine emits, against schema.org's types
/// and property value types.
fn assert_valid_local_business(node: &Value) {
    let object = node.as_object().expect("an object");
    assert_eq!(object["@context"], "https://schema.org");
    let kind = object["@type"].as_str().expect("@type is text");
    assert!(LOCAL_BUSINESS_TYPES.contains(&kind), "{kind}");
    for key in ["@id", "name", "url"] {
        assert!(object[key].as_str().is_some_and(|s| !s.is_empty()), "{key}");
    }
    assert!(object["@id"].as_str().unwrap().starts_with("https://"));
    if let Some(phone) = object.get("telephone") {
        let phone = phone.as_str().unwrap();
        assert!(phone.starts_with('+') && phone[1..].bytes().all(|b| b.is_ascii_digit()));
    }
    if let Some(email) = object.get("email") {
        assert!(email.as_str().unwrap().contains('@'));
    }
    if let Some(date) = object.get("foundingDate") {
        assert!(date.as_str().unwrap().parse::<u16>().is_ok());
    }
    if let Some(specs) = object.get("openingHoursSpecification") {
        let specs = specs.as_array().expect("a list");
        assert!(!specs.is_empty());
        for spec in specs {
            assert_eq!(spec["@type"], "OpeningHoursSpecification");
            let day = spec["dayOfWeek"].as_str().unwrap();
            let day = day
                .strip_prefix("https://schema.org/")
                .expect("a schema.org day");
            assert!(SCHEMA_DAYS.contains(&day), "{day}");
            assert!(is_clock(spec["opens"].as_str().unwrap()));
            assert!(is_clock(spec["closes"].as_str().unwrap()));
        }
    }
    if let Some(credential) = object.get("hasCredential") {
        assert_eq!(credential["@type"], "EducationalOccupationalCredential");
        assert!(credential["identifier"]
            .as_str()
            .is_some_and(|s| !s.is_empty()));
    }
    const ALLOWED: &[&str] = &[
        "@context",
        "@type",
        "@id",
        "name",
        "legalName",
        "url",
        "telephone",
        "email",
        "foundingDate",
        "openingHoursSpecification",
        "paymentAccepted",
        "hasCredential",
    ];
    for key in object.keys() {
        assert!(ALLOWED.contains(&key.as_str()), "unexpected property {key}");
    }
}

// ----- the invariant -------------------------------------------------------

#[test]
fn a_site_without_business_facts_builds_exactly_as_before() {
    let plain = build(config(None), None);
    for empty in [json!({}), json!({"version": 1}), json!(null)] {
        assert_eq!(build(config(Some(empty.clone())), None), plain, "{empty}");
    }
    for (path, contents) in &plain {
        assert!(!contents.contains("ob-business"), "{path}");
        assert!(!contents.contains("LocalBusiness"), "{path}");
    }
}

#[test]
fn a_landing_section_with_no_facts_stated_renders_nothing() {
    let landing = json!({"format": "openblog-landing", "version": 2, "sections": [
        {"id": "latest", "type": "latest-posts", "heading": "News"},
        {"id": "facts", "type": "business-facts", "heading": "Find us"}
    ]});
    let with = build(config(None), Some(landing));
    let without = build(
        config(None),
        Some(
            json!({"format": "openblog-landing", "version": 1, "sections": [
                {"id": "latest", "type": "latest-posts", "heading": "News"}
            ]}),
        ),
    );
    assert_eq!(with["index.html"], without["index.html"]);
}

// ----- the block -----------------------------------------------------------

#[test]
fn the_same_block_is_on_every_page() {
    let files = build(config(Some(full())), None);
    let home = block(&files["index.html"]).to_string();
    let mut pages = 0;
    for (path, contents) in files.iter().filter(|(p, _)| p.ends_with(".html")) {
        // Redirect stubs and the like carry no footer; every real page does.
        if !contents.contains("<footer class=\"ob-footer\">") {
            continue;
        }
        pages += 1;
        assert_eq!(block(contents), home, "{path}");
    }
    assert!(pages >= 5, "{pages}");
}

#[test]
fn the_block_snapshot() {
    let files = build(config(Some(full())), None);
    let expected = r#"<section class="ob-footer-business" aria-label="Business details">
<div class="ob-business">
<p class="ob-business-name">Maple Falls Flooring</p>
<p class="ob-business-badge"><span class="ob-badge">Licensed and insured</span></p>
<ul class="ob-business-contact">
<li class="ob-business-phone"><a href="tel:+13605550142">(360) 555-0142</a></li>
<li class="ob-business-email"><a href="mailto:office@example.com">office@example.com</a></li>
</ul>
<dl class="ob-business-hours">
<div><dt>Mon to Fri</dt><dd>8:00 am to 5:00 pm</dd></div>
<div><dt>Saturday</dt><dd>9:00 am to 12:30 pm</dd></div>
<div><dt>Sunday</dt><dd>Closed</dd></div>
</dl>
<ul class="ob-business-notes">
<li>License MAPLEF*123, WA L&amp;I</li>
<li>We accept Cash, Check, Credit card</li>
<li>Serving customers since 1998</li>
</ul>
</div>
</section>"#;
    assert_eq!(block(&files["index.html"]), expected);
}

#[test]
fn no_customer_data_and_no_script_in_the_block() {
    let files = build(config(Some(full())), None);
    let html = block(&files["index.html"]);
    assert!(!html.contains("<script") && !html.contains("<form"));
}

// ----- structured data -----------------------------------------------------

#[test]
fn the_home_page_carries_valid_local_business_data_and_other_pages_do_not() {
    let files = build(config(Some(full())), None);
    let nodes = json_ld(&files["index.html"]);
    assert_eq!(nodes.len(), 2, "the blog node and the business node");
    let business = nodes.iter().find(|n| n["@type"] != "Blog").unwrap();
    assert_valid_local_business(business);
    assert_eq!(business["@type"], "HomeAndConstructionBusiness");
    assert_eq!(business["name"], "Maple Falls Flooring");
    assert_eq!(business["legalName"], "Maple Falls Flooring LLC");
    assert_eq!(business["telephone"], "+13605550142");
    assert_eq!(business["foundingDate"], "1998");
    assert_eq!(business["paymentAccepted"], "Cash, Check, Credit card");
    assert_eq!(business["hasCredential"]["recognizedBy"]["name"], "WA L&I");
    let specs = business["openingHoursSpecification"].as_array().unwrap();
    assert_eq!(specs.len(), 6, "the closed Sunday is not listed");
    for (path, contents) in &files {
        if path != "index.html" {
            assert!(
                !contents.contains("\"LocalBusiness\"")
                    && !contents.contains("HomeAndConstruction"),
                "{path}"
            );
        }
    }
}

#[test]
fn only_the_fields_that_are_stated_are_emitted() {
    let files = build(config(Some(json!({"phone": "+13605550142"}))), None);
    let nodes = json_ld(&files["index.html"]);
    let business = nodes.iter().find(|n| n["@type"] != "Blog").unwrap();
    assert_valid_local_business(business);
    let keys: Vec<&str> = business
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        ["@context", "@id", "@type", "name", "telephone", "url"],
        "the site title stands in for the name"
    );
    assert_eq!(business["@type"], "LocalBusiness");
    assert_eq!(business["name"], "Maple Falls Flooring");
}

#[test]
fn every_trade_gets_a_valid_type() {
    for trade in openblog_core::job::TRADES.iter().chain(&["locksmith"]) {
        let config = SiteConfig::from_json(
            &json!({"extraTrades": ["locksmith"], "business": {"displayName": "X", "trade": trade}})
                .to_string(),
        )
        .unwrap();
        let ld = config
            .business
            .local_business_json_ld("https://e.dev/#b", "https://e.dev/", "X");
        assert_valid_local_business(&ld);
    }
}

#[test]
fn text_from_the_config_cannot_break_the_page_or_the_data() {
    let evil = "</script><img src=x> & Co";
    let files = build(
        config(Some(
            json!({"displayName": evil, "licenseNumber": evil, "licenseIssuer": evil}),
        )),
        None,
    );
    let home = &files["index.html"];
    assert!(!home.contains("<img src=x"), "raw markup reached the page");
    assert_eq!(
        home.matches("</script>").count(),
        home.matches("<script").count()
    );
    let nodes = json_ld(home);
    let business = nodes.iter().find(|n| n["@type"] != "Blog").unwrap();
    assert_eq!(business["name"], evil);
}

// ----- the landing section -------------------------------------------------

#[test]
fn the_landing_section_places_the_same_facts_under_its_heading() {
    let landing = json!({"format": "openblog-landing", "version": 2, "sections": [
        {"id": "welcome", "type": "welcome", "heading": "Floors that last"},
        {"id": "facts", "type": "business-facts", "heading": "Find us"}
    ]});
    let files = build(config(Some(full())), Some(landing));
    let home = &files["index.html"];
    let start = home.find("id=\"ob-home-facts\"").expect("the section");
    let section = &home[start..start + home[start..].find("</section>").unwrap()];
    assert!(
        section.contains("Find us") && section.contains("<h2"),
        "{section}"
    );
    assert!(section.contains("(360) 555-0142") && section.contains("Licensed and insured"));
    assert_eq!(home.matches("<h1").count(), 1);
}
