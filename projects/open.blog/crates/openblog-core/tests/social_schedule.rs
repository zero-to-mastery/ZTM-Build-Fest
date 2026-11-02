//! Optional social publishing, the announcement model (ADR 0308): held to
//! `tests/fixtures/social-schedule.json`, which the hosted function's tests read too.

use openblog_core::social_schedule::*;
use openblog_core::{DateTime, LoadOptions, Post, Site, SiteConfig, SourceFile, Sources};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/social-schedule.json")).unwrap()
}

fn now() -> DateTime {
    DateTime::parse(fixture()["now"].as_str().unwrap()).unwrap()
}

fn pairs(value: &Value) -> Vec<(String, String)> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p[0].as_str().unwrap().to_string(),
                p[1].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn providers_match_the_fixture_and_unsupported_ones_fail_explicitly() {
    let f = fixture();
    for p in strings(&f["providers"]["accepted"]) {
        assert_eq!(Provider::parse(&p).unwrap().as_str(), p);
    }
    for p in strings(&f["providers"]["refused"]) {
        assert_eq!(
            Provider::parse(&p),
            Err(ScheduleError::UnsupportedProvider),
            "{p:?}"
        );
    }
}

#[test]
fn captions_match_the_fixture_and_are_bounded_per_provider() {
    let f = fixture();
    let limit = f["captionLimit"].as_u64().unwrap() as usize;
    for provider in [Provider::LinkedIn, Provider::Facebook] {
        assert_eq!(provider.caption_limit(), limit);
        for (input, stored) in pairs(&f["captions"]["accepted"]) {
            assert_eq!(check_caption(provider, &input).unwrap(), stored);
        }
        for (input, code) in pairs(&f["captions"]["refused"]) {
            assert_eq!(
                check_caption(provider, &input).unwrap_err().code(),
                code,
                "{input:?}"
            );
        }
        assert!(
            check_caption(provider, &"é".repeat(limit)).is_ok(),
            "the limit counts characters"
        );
        assert_eq!(
            check_caption(provider, &"a".repeat(limit + 1))
                .unwrap_err()
                .code(),
            "caption-too-long"
        );
    }
}

#[test]
fn schedule_times_match_the_fixture() {
    let f = fixture();
    for (input, utc) in pairs(&f["times"]["accepted"]) {
        assert_eq!(
            utc_instant(parse_schedule(&input, now()).unwrap()),
            utc,
            "{input:?}"
        );
    }
    for (input, code) in pairs(&f["times"]["refused"]) {
        assert_eq!(
            parse_schedule(&input, now()).unwrap_err().code(),
            code,
            "{input:?}"
        );
    }
}

#[test]
fn time_zones_keys_and_urls_match_the_fixture() {
    let f = fixture();
    for z in strings(&f["timeZones"]["accepted"]) {
        assert!(check_time_zone(&z).is_ok(), "{z:?}");
    }
    for z in strings(&f["timeZones"]["refused"]) {
        assert!(check_time_zone(&z).is_err(), "{z:?}");
    }
    for k in strings(&f["keys"]["accepted"]) {
        assert!(check_idempotency_key(&k).is_ok(), "{k:?}");
    }
    for k in strings(&f["keys"]["refused"]) {
        assert!(check_idempotency_key(&k).is_err(), "{k:?}");
    }
    for (url, work) in pairs(&f["urls"]["accepted"]) {
        assert!(check_canonical_url(&url, &work).is_ok(), "{url:?}");
    }
    for (url, work) in pairs(&f["urls"]["refused"]) {
        assert!(
            check_canonical_url(&url, &work).is_err(),
            "{url:?} {work:?}"
        );
    }
}

#[test]
fn statuses_and_transitions_match_the_fixture() {
    let f = fixture();
    let all: Vec<Status> = strings(&f["statuses"])
        .iter()
        .map(|s| Status::parse(s).unwrap())
        .collect();
    assert_eq!(Status::parse("pending"), None);
    let allowed = pairs(&f["transitions"]);
    let editable = strings(&f["editable"]);
    for from in &all {
        assert_eq!(
            from.editable(),
            editable.contains(&from.as_str().to_string())
        );
        for to in &all {
            let listed = allowed.contains(&(from.as_str().to_string(), to.as_str().to_string()));
            assert_eq!(from.can_become(*to), listed, "{from:?} -> {to:?}");
        }
    }
}

const POSTS: [(&str, &str); 5] = [
    (
        "posts/2026-01-02-hello.md",
        "---\ntitle: Hello\ndate: 2026-01-02\n---\n\nBody.\n",
    ),
    (
        "posts/2026-01-03-draft.md",
        "---\ntitle: Draft\ndate: 2026-01-03\ndraft: true\n---\n\nBody.\n",
    ),
    (
        "posts/2099-01-01-later.md",
        "---\ntitle: Later\ndate: 2099-01-01\n---\n\nBody.\n",
    ),
    (
        "posts/2026-01-04-away.md",
        "---\ntitle: Away\ndate: 2026-01-04\ncanonical: https://dev.to/me/away\n---\n\nBody.\n",
    ),
    (
        "posts/2026-01-05-home.md",
        "---\ntitle: Home\ndate: 2026-01-05\ncanonical: https://blog.example.org/posts/home/\n---\n\nBody.\n",
    ),
];

fn site_at(url: &str) -> (Site, SiteConfig) {
    let config = SiteConfig {
        url: url.to_string(),
        ..SiteConfig::default()
    };
    let sources = Sources {
        posts: POSTS
            .iter()
            .map(|(path, contents)| SourceFile {
                path: path.to_string(),
                contents: contents.to_string(),
            })
            .collect(),
        ..Sources::default()
    };
    let site = Site::load(
        config.clone(),
        sources,
        LoadOptions {
            include_drafts: true,
            now: Some(now()),
            preview_source: None,
        },
    )
    .expect("site");
    (site, config)
}

fn by<'a>(site: &'a Site, slug: &str) -> &'a Post {
    site.posts
        .iter()
        .find(|p| p.slug == slug)
        .unwrap_or_else(|| panic!("post {slug}"))
}

#[test]
fn only_a_public_post_with_a_public_address_can_be_announced() {
    let (site, config) = site_at("https://blog.example.org");
    let ok = announceable(&site, &config, by(&site, "hello"), now()).unwrap();
    assert_eq!(ok.work, "/posts/hello/");
    assert_eq!(ok.canonical_url, "https://blog.example.org/posts/hello/");
    let refuse = |slug: &str| announceable(&site, &config, by(&site, slug), now()).unwrap_err();
    assert_eq!(refuse("draft"), ScheduleError::PostNotPublished);
    assert_eq!(refuse("later"), ScheduleError::PostScheduled);
    assert_eq!(refuse("away"), ScheduleError::CanonicalElsewhere);
    assert!(announceable(&site, &config, by(&site, "home"), now()).is_ok());

    for url in ["http://blog.example.org", "https://localhost:3000", ""] {
        let (site, config) = site_at(url);
        assert_eq!(
            announceable(&site, &config, by(&site, "hello"), now()).unwrap_err(),
            ScheduleError::UrlNotPublic,
            "{url:?}"
        );
    }
}

#[test]
fn a_site_under_a_folder_keeps_the_site_relative_post_path_as_its_work() {
    let (site, config) = site_at("https://user.github.io/blog");
    let found = announceable(&site, &config, by(&site, "hello"), now()).unwrap();
    assert_eq!(found.work, "/posts/hello/");
    assert_eq!(
        found.canonical_url,
        "https://user.github.io/blog/posts/hello/"
    );
}
