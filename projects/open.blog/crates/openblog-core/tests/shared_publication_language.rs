//! Terminology and compatibility fixtures for the shared-publication language (ADR 0005).

use openblog_core::{
    collaboration::{
        AuthorizationAction, AuthorizationContext, AuthorizationPolicy, AuthorizationTarget,
        CollaborationContract,
    },
    contributor::CreditProvenance,
    frontmatter, generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};
use serde_json::json;

const GLOSSARY: &str = include_str!("../../../CONTEXT.md");
const COLLABORATION_SECTION: &str = "Shared publication collaboration";

/// One glossary entry: the section it appears in, its term, and its `_Avoid_` line.
struct Entry<'a> {
    section: &'a str,
    term: &'a str,
    avoid: Option<&'a str>,
}

fn glossary_entries() -> Vec<Entry<'static>> {
    let mut section = "";
    let mut entries: Vec<Entry<'static>> = Vec::new();
    for line in GLOSSARY.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            section = heading.trim();
        } else if let Some(term) = line
            .strip_prefix("**")
            .and_then(|rest| rest.strip_suffix("**:"))
        {
            entries.push(Entry {
                section,
                term,
                avoid: None,
            });
        } else if let Some(avoid) = line.strip_prefix("_Avoid_:") {
            let entry = entries.last_mut().expect("an _Avoid_ line follows a term");
            assert!(
                entry.avoid.is_none(),
                "{} has two _Avoid_ lines",
                entry.term
            );
            entry.avoid = Some(avoid.trim());
        }
    }
    entries
}

fn entry<'a>(entries: &'a [Entry<'static>], term: &str) -> &'a Entry<'static> {
    let matches = entries
        .iter()
        .filter(|entry| entry.term == term)
        .collect::<Vec<_>>();
    assert_eq!(matches.len(), 1, "{term} is defined exactly once");
    matches[0]
}

#[test]
fn collaboration_terms_are_defined_apart_from_public_publishing_terms() {
    let entries = glossary_entries();

    // Each collaboration term names the public term it must not be confused with.
    for (term, avoided) in [
        ("Shared publication", &["post", "pair"][..]),
        ("Shared publication record", &["post", "front matter"][..]),
        ("Source reference", &["citation"][..]),
        ("Participant", &["contributor", "admin user", "left"][..]),
        ("Collaboration role", &["work credit", "admin"][..]),
        ("Contribution draft", &["post", "canonical content"][..]),
        ("Reveal", &["publication", "approval"][..]),
        ("Approval", &["publication", "work credit"][..]),
        ("Published assembly", &["post", "byline"][..]),
    ] {
        let entry = entry(&entries, term);
        assert_eq!(entry.section, COLLABORATION_SECTION, "{term} section");
        let avoid = entry
            .avoid
            .unwrap_or_else(|| panic!("{term} has an _Avoid_ line"))
            .to_lowercase();
        for avoided in avoided {
            assert!(avoid.contains(avoided), "{term} avoids {avoided}");
        }
    }

    // Public attribution, authentication, and publishing keep their own definitions.
    for term in [
        "Post",
        "Contributor",
        "Contributor registry entry",
        "Author",
        "Work credit",
        "Admin user",
    ] {
        let entry = entry(&entries, term);
        assert_ne!(entry.section, COLLABORATION_SECTION, "{term} section");
        assert!(entry.avoid.is_some(), "{term} has an _Avoid_ line");
    }

    // A binding reaches a registry entry, which is not a Contributor until a Work credit names it.
    let registry = entry(&entries, "Contributor registry entry")
        .avoid
        .unwrap()
        .to_lowercase();
    for avoided in ["contributor before any work credit", "participant"] {
        assert!(
            registry.contains(avoided),
            "registry entry avoids {avoided}"
        );
    }
    let unwrapped = GLOSSARY.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        unwrapped.contains("Admin user and a contributor registry entry"),
        "Participant binds a registry entry, not a Contributor"
    );
    assert!(!unwrapped.contains("Admin user and a Contributor"));
    assert!(!unwrapped.contains("approved contribution-draft revision"));
}

fn source(path: &str, contents: &str) -> SourceFile {
    SourceFile {
        path: path.into(),
        contents: contents.into(),
    }
}

/// A shared publication of `count` participants, each bound to a registry contributor.
fn shared_publication(count: usize) -> (CollaborationContract, AuthorizationPolicy) {
    let participants = (0..count)
        .map(|index| {
            json!({
                "id": format!("p{index}"),
                "displayName": format!("Écrivain {index} ✍️")
            })
        })
        .collect::<Vec<_>>();
    let contributions = (0..count)
        .map(|index| {
            json!({
                "id": format!("c{index}"),
                "participantId": format!("p{index}"),
                "markdown": format!("Private draft {index}")
            })
        })
        .collect::<Vec<_>>();
    let approvals = (0..count)
        .map(|index| json!({ "participantId": format!("p{index}"), "revision": 2 }))
        .collect::<Vec<_>>();
    let bindings = (0..count)
        .map(|index| {
            json!({
                "adminUser": format!("admin-{index}"),
                "contributorId": format!("writer-{index}"),
                "participantId": format!("p{index}"),
                "roles": ["coordinator", "contributor"]
            })
        })
        .collect::<Vec<_>>();
    let contract = CollaborationContract::from_json(
        &json!({
            "version": 1,
            "revision": 2,
            "participants": participants,
            "contributions": contributions,
            "reveals": [],
            "layout": [],
            "approvals": approvals
        })
        .to_string(),
    )
    .expect("valid shared publication contract");
    let policy = AuthorizationPolicy::from_json(
        &json!({
            "version": 1,
            "revision": 1,
            "publicationId": "reflection",
            "bindings": bindings
        })
        .to_string(),
    )
    .expect("valid shared publication policy");
    (contract, policy)
}

fn site_with_registry(count: usize, sidecar: Option<String>) -> Site {
    let contributors = (0..count)
        .map(|index| {
            (
                format!("writer-{index}"),
                json!({ "name": format!("Writer {index}") }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let config = SiteConfig::from_json(
        &json!({ "author": { "name": "Site Author" }, "contributors": contributors }).to_string(),
    )
    .unwrap();
    Site::load(
        config,
        Sources {
            posts: vec![source(
                "posts/reflection.md",
                "---\ntitle: Reflection\ndate: 2026-10-24\n---\nPublished body.",
            )],
            credits: sidecar
                .map(|contents| vec![source("posts/reflection.credits.json", &contents)])
                .unwrap_or_default(),
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap()
}

/// Pins the current isolation: `Site::load` and `generate` take no collaboration input, so the
/// contract and policy built here cannot reach credits through any seam today. The first
/// collaboration-to-publication seam (#156/#158) must route bindings, roles, and approvals
/// through that seam and assert that credits stay unchanged end to end.
#[test]
fn site_without_collaboration_input_derives_no_credits_from_participants() {
    for count in [1, 2, 3, 10] {
        let (contract, policy) = shared_publication(count);
        let admin_users = (0..count)
            .map(|index| format!("admin-{index}"))
            .collect::<Vec<_>>();
        let admin_users = admin_users.iter().map(String::as_str).collect::<Vec<_>>();
        let contributor_ids = (0..count)
            .map(|index| format!("writer-{index}"))
            .collect::<Vec<_>>();
        let contributor_ids = contributor_ids
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let context = AuthorizationContext {
            publication_id: "reflection",
            authenticated_admin_user: admin_users[0],
            active_admin_users: &admin_users,
            contributor_ids: &contributor_ids,
            collaboration: &contract,
            target: AuthorizationTarget::Publication,
        };
        assert!(policy
            .authorize(&context, AuthorizationAction::Publish)
            .is_ok());
        assert_eq!(contract.pair_projection().is_some(), count == 2);

        // A legacy post keeps its site-author fallback even when every participant is a
        // bound, approving coordinator whose contributor ID exists in the registry.
        let legacy = site_with_registry(count, None);
        assert_eq!(
            legacy.posts[0].credit_provenance,
            CreditProvenance::LegacySiteAuthor
        );
        assert_eq!(
            legacy.posts[0]
                .credits
                .iter()
                .map(|credit| credit.contributor.name.as_str())
                .collect::<Vec<_>>(),
            ["Site Author"]
        );

        // Explicit public credit follows the work-credit sidecar order, not participant order.
        let reversed = (0..count)
            .rev()
            .map(|index| {
                json!({
                    "contributor": format!("writer-{index}"),
                    "roles": [{ "vocabulary": "crossref", "role": "author" }]
                })
            })
            .collect::<Vec<_>>();
        let credited = site_with_registry(
            count,
            Some(json!({ "version": 1, "credits": reversed }).to_string()),
        );
        assert_eq!(
            credited.posts[0]
                .credits
                .iter()
                .map(|credit| credit.contributor_id.as_str())
                .collect::<Vec<_>>(),
            (0..count)
                .rev()
                .map(|index| format!("writer-{index}"))
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn legacy_posts_keep_collaboration_shaped_front_matter_lossless_and_inert() {
    // Hand-written keys that look like collaboration state are ordinary unknown front matter:
    // they survive an edit, never become credits, and never change generated output.
    const LOOKALIKE: &str = concat!(
        "participants: [Ada, Grace]\n",
        "left: Ada\n",
        "right: Grace\n",
        "contribution: Private draft fragment\n",
        "reveal: grace\n",
        "approval: 2\n",
        "coordinator: Ada\n",
    );
    let post = |extra: &str| {
        format!(
            "---\ntitle: Legacy\ndate: 2026-10-24\n{extra}---\n\
             A legacy post with a [link](https://example.org/)."
        )
    };
    let build = |contents: String| {
        let site = Site::load(
            SiteConfig::from_json(r#"{"author":{"name":"Legacy Author"}}"#).unwrap(),
            Sources {
                posts: vec![source("posts/legacy.md", &contents)],
                ..Default::default()
            },
            LoadOptions::default(),
        )
        .unwrap();
        assert_eq!(
            site.posts[0].credit_provenance,
            CreditProvenance::LegacySiteAuthor
        );
        assert_eq!(site.posts[0].credits.len(), 1);
        generate(&site, &ThemeSet::new())
            .unwrap()
            .into_iter()
            .map(|file| (file.path, file.contents))
            .collect::<Vec<_>>()
    };

    let plain = build(post(""));
    let lookalike = build(post(LOOKALIKE));
    assert!(plain.iter().any(|(path, contents)| {
        path.ends_with("legacy/index.html") && contents.contains("https://example.org/")
    }));
    assert_eq!(plain, lookalike);
    for (_, contents) in &lookalike {
        assert!(!contents.contains("Private draft fragment"));
    }

    let document = frontmatter::parse(&post(LOOKALIKE)).unwrap();
    let recomposed = frontmatter::compose(&document.front_matter.fields, &document.body);
    assert_eq!(
        frontmatter::parse(&recomposed).unwrap().front_matter,
        document.front_matter
    );
    for key in [
        "participants",
        "left",
        "right",
        "contribution",
        "reveal",
        "approval",
    ] {
        assert!(document.front_matter.fields.contains_key(key), "{key} kept");
    }
}
