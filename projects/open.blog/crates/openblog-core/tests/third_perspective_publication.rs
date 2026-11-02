//! Approved Third Perspectives on the canonical page (#222, ADRs 0111 and
//! 0115): a versioned public file Admin writes from a hosted copy only while
//! the one projection shows it, read back strictly, and rendered on the
//! canonical page as a reader's reflection under RD12's published mode.
//! Portable copies, feeds, search and `llms` files carry a labelled link to
//! the canonical page and nothing of the reflections; a site that leaves the
//! kind off is byte-for-byte what it was.

use std::collections::BTreeMap;

use openblog_core::participation::ParticipationMode;
use openblog_core::passage_target::PassageDocument;
use openblog_core::perspective_publication::{
    PublishedPerspective, ThirdPerspectivesFile, THIRD_PERSPECTIVES_FILE,
};
use openblog_core::portability::PortableProjection;
use openblog_core::third_perspective::{
    ConsentChange, ConsentChoices, FeatureChange, HostedPerspective, Intake, LocalReflection,
    ModerationFacts, ModerationState, PerspectiveTarget, PublishedWork, ReaderAttribution,
    ResponseCategory, SubmittedCopy, TargetStatus,
};
use openblog_core::{
    generate, DateTime, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};
use serde_json::{json, Value};

const ID_1: &str = "00000000-0000-4000-8000-000000000001";
const ID_2: &str = "00000000-0000-4000-8000-000000000002";
const BODY: &str =
    "The moon causes the tides.\n\n## Methods\n\nWe measured the tides twice a day.\n";
const REFLECTION: &str = "Tides as a <conversation> & a rhythm.\n\nA second paragraph.";
const DIGEST: &str = "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";

const HOSTED: &str =
    r#""engagement":{"enabled":true,"endpoint":"https://t.dev/api","receipts":true}"#;
const OFF_TRANSPORT: &str = r#""engagement":{"enabled":false}"#;
const OPEN_KIND: &str = r#","participation":{"kinds":{"third-perspective":"open"}}"#;
const LOCKED_KIND: &str = r#","participation":{"kinds":{"third-perspective":"locked"}}"#;

fn time(value: &str) -> DateTime {
    DateTime::parse(value).unwrap()
}

fn config(engagement: &str, participation: &str) -> SiteConfig {
    SiteConfig::from_json(&format!(
        r#"{{"title":"T","url":"https://t.dev","postPath":"/posts/{{slug}}/","author":{{"name":"Ada Lovelace"}},{engagement}{participation}}}"#
    ))
    .unwrap()
}

fn post_source(name: &str, front: &str, body: &str) -> SourceFile {
    SourceFile {
        path: format!("posts/{name}.md"),
        contents: format!("---\ntitle: Tides\ndate: 2026-01-01\n{front}---\n{body}"),
    }
}

fn load(config: SiteConfig, posts: Vec<SourceFile>, file: Option<String>) -> Site {
    Site::load(
        config,
        Sources {
            posts,
            third_perspectives: file.map(|contents| SourceFile {
                path: format!("content/{THIRD_PERSPECTIVES_FILE}"),
                contents,
            }),
            ..Sources::default()
        },
        LoadOptions::default(),
    )
    .unwrap()
}

fn build(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

fn site_with(engagement: &str, participation: &str, file: Option<String>) -> Site {
    load(
        config(engagement, participation),
        vec![post_source("tides", "", BODY)],
        file,
    )
}

/// The revision and section target of the fixture post's Methods section.
fn methods(site: &Site) -> (String, Value) {
    let document = PassageDocument::of_post(&site.posts[0], &site.config);
    let target = PerspectiveTarget::try_from(document.section_target(1).unwrap()).unwrap();
    (document.revision.clone(), target.to_value())
}

/// One published record, as Admin writes it.
fn record(id: &str, revision: &str, target: Value, name: Option<&str>) -> Value {
    let mut value = json!({
        "id": id, "post": "posts/tides.md", "work": "/posts/tides/", "revision": revision,
        "target": target, "category": "connection", "body": REFLECTION,
        "received": "2026-10-26", "approved": "2026-10-27",
    });
    if let Some(name) = name {
        value["name"] = json!(name);
    }
    value
}

fn file(items: Vec<Value>) -> String {
    serde_json::to_string_pretty(&json!({"version": 1, "items": items})).unwrap()
}

fn section(page: &str) -> &str {
    let start = page
        .find("<section id=\"ob-third-perspectives\"")
        .expect("Third Perspectives section");
    let end = start + page[start..].find("</section>\n").unwrap() + "</section>\n".len();
    &page[start..end]
}

// ---- The file

#[test]
fn the_file_holds_only_public_parts_and_refuses_anything_else() {
    let site = site_with(HOSTED, OPEN_KIND, None);
    let (revision, target) = methods(&site);
    let good = record(ID_1, &revision, target.clone(), Some("Mina"));
    let read = ThirdPerspectivesFile::from_json(&file(vec![good.clone()])).unwrap();
    assert_eq!(read.items.len(), 1);
    assert_eq!(read.items[0].name.as_deref(), Some("Mina"));
    // Canonical text round-trips.
    assert_eq!(
        ThirdPerspectivesFile::from_json(&read.to_json()).unwrap(),
        read
    );
    assert!(read.to_json().ends_with("}\n"));

    // Every private field a copy has is refused by name, as is anything
    // unknown, a quotation target, a newer version and a repeated id.
    for (field, value) in [
        ("consents", json!([])),
        ("intake", json!({"receiptDigest": DIGEST})),
        ("receiptDigest", json!(DIGEST)),
        ("readerName", json!("Private")),
        ("publishName", json!(false)),
        ("seenAt", json!("2026-10-26T10:00:00Z")),
        ("channel", json!("hosted")),
        ("moderator", json!("mikey")),
        ("reason", json!("spam")),
        ("status", json!("approved")),
        ("approvedConsent", json!(1)),
        ("rank", json!(1)),
    ] {
        let mut bad = good.clone();
        bad[field] = value;
        let error = ThirdPerspectivesFile::from_json(&file(vec![bad])).unwrap_err();
        assert!(error.starts_with("item 1:"), "{field}: {error}");
        assert!(
            !error.contains("Private") && !error.contains(DIGEST),
            "{error}"
        );
    }
    let mut quote = good.clone();
    quote["target"] = json!({"version": 1, "kind": "quote", "section": "methods", "exact": "tides", "prefix": "", "suffix": "", "start": 0});
    assert!(ThirdPerspectivesFile::from_json(&file(vec![quote])).is_err());
    for (field, value) in [
        ("body", json!("  untrimmed  ")),
        ("body", json!("")),
        ("body", json!("bidi \u{202e} override")),
        ("name", json!("")),
        ("name", json!("two  spaces")),
        ("received", json!("2026-13-01")),
        ("approved", json!("2026-10-25")),
        ("category", json!("best")),
        ("id", json!("00000000-0000-4000-8000-00000000000A")),
        ("post", json!("../secret.md")),
        ("work", json!("https://evil.example/")),
        ("revision", json!("latest")),
    ] {
        let mut bad = good.clone();
        bad[field] = value;
        assert!(
            ThirdPerspectivesFile::from_json(&file(vec![bad])).is_err(),
            "{field}"
        );
    }
    assert!(
        ThirdPerspectivesFile::from_json(&file(vec![good.clone(), good.clone()]))
            .unwrap_err()
            .contains("repeats the id")
    );
    assert!(
        ThirdPerspectivesFile::from_json(r#"{"version":3,"items":[]}"#)
            .unwrap_err()
            .contains("newer")
    );
    assert!(ThirdPerspectivesFile::from_json("not json").is_err());
}

/// A received copy about the fixture's Methods section from `name`.
fn copy(site: &Site, name: &str, publish_name: bool) -> SubmittedCopy {
    let post = &site.posts[0];
    let document = PassageDocument::of_post(post, &site.config);
    LocalReflection {
        work: post.url.clone(),
        revision: document.revision.clone(),
        target: PerspectiveTarget::try_from(document.section_target(1).unwrap()).unwrap(),
        category: Some(ResponseCategory::Connection),
        body: REFLECTION.into(),
        attribution: ReaderAttribution::named(name, publish_name),
        seen_at: None,
    }
    .submission(ConsentChoices {
        publish: true,
        clarification: true,
        feature: false,
    })
    .receive(
        time("2026-10-26T10:00:00Z"),
        Intake::Hosted {
            receipt_digest: DIGEST.into(),
        },
    )
    .unwrap()
}

fn hosted(copy: &SubmittedCopy, status: &str, approved_consent: Option<u32>) -> HostedPerspective {
    let record: Value = serde_json::from_str(&copy.to_json()).unwrap();
    HostedPerspective::from_value(&json!({
        "id": ID_1, "status": status, "version": 2,
        "moderatedAt": "2026-10-27T09:00:00Z", "reason": null,
        "feedback": {"version": 1, "kind": "third-perspective", "body": copy.body, "details": copy.stored_details(), "provenance": record["provenance"]},
        "itemRevision": copy.revision, "approvedRevision": if status == "approved" { json!(copy.revision) } else { Value::Null },
        "clarificationAsked": null, "clarificationConsent": true, "approvedConsent": approved_consent,
    }))
    .unwrap()
}

#[test]
fn admin_publishes_only_what_the_projection_shows_now_and_never_a_private_field() {
    let site = site_with(HOSTED, OPEN_KIND, None);
    let post = &site.posts[0];
    let at = time("2026-10-27T09:00:00Z");
    let publish = |copy: &SubmittedCopy, status: &str, consent: Option<u32>| {
        PublishedPerspective::from_hosted(
            "posts/tides.md",
            &hosted(copy, status, consent),
            post,
            &site.config,
            at,
        )
    };
    let shown = publish(&copy(&site, "Mina", true), "approved", Some(1)).unwrap();
    assert_eq!(shown.name.as_deref(), Some("Mina"));
    assert_eq!(shown.received, "2026-10-26");
    assert_eq!(shown.approved, "2026-10-27");
    assert_eq!(shown.body, REFLECTION);
    let text = ThirdPerspectivesFile {
        items: vec![shown.clone()],
    }
    .to_json();
    for private in [
        DIGEST,
        "consents",
        "intake",
        "receipt",
        "hosted",
        "10:00",
        "publishName",
    ] {
        assert!(!text.contains(private), "{private} in {text}");
    }

    // A private name is never written; neither is a name the work credits.
    let private = publish(&copy(&site, "Private Reader", false), "approved", Some(1)).unwrap();
    assert_eq!(private.name, None);
    let file = ThirdPerspectivesFile {
        items: vec![private],
    }
    .to_json();
    assert!(!file.contains("Private Reader"));
    let author = publish(&copy(&site, "ada  LOVELACE", true), "approved", Some(1)).unwrap();
    assert_eq!(author.name, None, "a look-alike of the site author's name");

    // Nothing that is not approved under a consent allowing it is published.
    for status in [
        "pending",
        "clarification",
        "rejected",
        "removed",
        "withdrawn",
    ] {
        assert!(
            publish(&copy(&site, "Mina", true), status, None).is_err(),
            "{status}"
        );
    }
    assert!(
        publish(&copy(&site, "Mina", true), "approved", None).is_err(),
        "an approval that recorded no consent"
    );
    let mut revoked = copy(&site, "Mina", true);
    let facts = ModerationFacts {
        state: ModerationState::Approved,
        revision: 1,
        approved_revision: Some(1),
        approved_consent: Some(1),
        clarification_asked: None,
        content_retained: true,
    };
    revoked
        .revise_consent(
            &facts,
            ConsentChange {
                publish: true,
                attribution: ReaderAttribution::named("Mina", false),
                clarification: true,
                feature: FeatureChange::Decline,
            },
            time("2026-10-28T10:00:00Z"),
        )
        .unwrap();
    // The reader hid their name after approval: still published, without it.
    let narrowed = publish(&revoked, "approved", Some(1)).unwrap();
    assert_eq!(narrowed.name, None);
}

// ---- The canonical page

#[test]
fn an_approved_reflection_is_shown_on_the_canonical_page_as_a_readers() {
    let base = site_with(HOSTED, OPEN_KIND, None);
    let (revision, target) = methods(&base);
    let site = site_with(
        HOSTED,
        OPEN_KIND,
        Some(file(vec![
            record(ID_1, &revision, target.clone(), Some("Mina")),
            record(ID_2, &revision, json!({"version": 1, "kind": "work"}), None),
        ])),
    );
    assert!(site.third_perspectives_error.is_none());
    let files = build(&site);
    let page = &files["posts/tides/index.html"];
    let list = section(page);
    assert!(list.contains("aria-labelledby=\"ob-third-perspectives-title\""));
    assert!(list.contains("<h2 id=\"ob-third-perspectives-title\">Third Perspectives</h2>"));
    assert!(list.contains("never as one of the authors’"));
    assert!(list.contains(&format!(
        "<h3 id=\"ob-perspective-{ID_1}-title\">Third Perspective from Mina, a reader</h3>"
    )));
    assert!(list.contains(&format!(
        "<h3 id=\"ob-perspective-{ID_2}-title\">Third Perspective from a reader</h3>"
    )));
    assert!(list.contains("About <a href=\"#methods\">Methods</a> · Prompt: A connection · received <time datetime=\"2026-10-26\">2026-10-26</time>"));
    assert!(list.contains("About the whole work"));
    // Text stays text, paragraph by paragraph.
    assert!(list.contains(
        "<p>Tides as a &lt;conversation&gt; &amp; a rhythm.</p>\n<p>A second paragraph.</p>"
    ));
    assert!(!list.contains("<conversation>"));
    assert!(!list.contains("earlier version"));
    // Nothing counts, ranks or votes; no private field reaches the page.
    for absent in [
        "vote",
        "score",
        "likes",
        "consent record",
        DIGEST,
        "approved 2026-10-27",
    ] {
        assert!(!list.contains(absent), "{absent}");
    }
    // Apart from the authors' text and after it, before the form asking for more.
    assert!(page.find("ob-prose").unwrap() < page.find("id=\"ob-third-perspectives\"").unwrap());
    assert!(
        page.find("id=\"ob-third-perspectives\"").unwrap()
            < page.find("<section id=\"ob-third-perspective\"").unwrap()
    );
    let prose_end = page.find("ob-third-perspectives").unwrap();
    assert!(!page[..prose_end].contains("Tides as a &lt;conversation"));
}

#[test]
fn feeds_portable_copies_search_and_llms_carry_only_a_labelled_canonical_link() {
    let base = site_with(HOSTED, OPEN_KIND, None);
    let (revision, target) = methods(&base);
    let site = site_with(
        HOSTED,
        LOCKED_KIND,
        Some(file(vec![record(
            ID_1,
            &revision,
            target,
            Some("Mina Unique"),
        )])),
    );
    let files = build(&site);
    assert!(
        files["posts/tides/index.html"].contains("Third Perspective from Mina Unique, a reader")
    );
    for (path, contents) in &files {
        if path == "posts/tides/index.html" {
            continue;
        }
        for secret in [
            "Tides as a",
            "conversation",
            "Mina Unique",
            ID_1,
            // The section itself, never copied; the link's anchor is allowed.
            "ob-third-perspectives-title",
        ] {
            assert!(!contents.contains(secret), "{secret} in {path}");
        }
    }
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let html = projection.portable_html().unwrap();
    assert!(
        html.html.contains("<p class=\"ob-portable-note\"><strong>Third Perspectives</strong>: see it on <a href=\"https://t.dev/posts/tides/#ob-third-perspectives\">the original article</a>.</p>"),
        "{}",
        html.html
    );
    assert!(!html.html.contains("<form") && !html.html.contains("t.dev/api"));
    let capability = html
        .capabilities
        .iter()
        .find(|capability| capability.id == "third-perspectives")
        .unwrap();
    assert_eq!(capability.fallback_renderer, Some("labeled-canonical-link"));
    assert_eq!(
        capability.native_renderer, None,
        "the canonical section is plain HTML with no renderer"
    );
    let markdown = projection.portable_markdown().unwrap();
    assert!(markdown.contains("> **Third Perspectives:** see it on the [canonical article](https://t.dev/posts/tides/#ob-third-perspectives)."));
    assert!(!markdown.contains("Mina Unique") && !markdown.contains("conversation"));
    // The feed's copy of the post links the same way.
    assert!(files["llms-full.txt"]
        .contains("- Third Perspectives: on the canonical page, <https://t.dev/posts/tides/>\n"));
    for feed in ["rss.xml", "feed.json"] {
        assert!(
            files[feed].contains("Third Perspectives"),
            "{feed}: {}",
            files[feed]
        );
    }
}

#[test]
fn published_mode_decides_where_they_show_even_without_a_transport() {
    let base = site_with(HOSTED, OPEN_KIND, None);
    let (revision, target) = methods(&base);
    let published = file(vec![record(ID_1, &revision, target, None)]);
    // A site that left its hosted service keeps showing what was approved,
    // and offers no form.
    let without = build(&site_with(
        OFF_TRANSPORT,
        OPEN_KIND,
        Some(published.clone()),
    ));
    let page = &without["posts/tides/index.html"];
    assert!(page.contains("id=\"ob-third-perspectives\""));
    assert!(!page.contains("<section id=\"ob-third-perspective\""));
    assert!(
        !page.contains("<ob-abuse-report"),
        "no reports without a transport"
    );
    // A post that hides the kind, or a site that leaves it off, shows none,
    // and carries no link either.
    let hidden = load(
        config(HOSTED, OPEN_KIND),
        vec![post_source(
            "tides",
            "participation:\n  - third-perspective: hidden\n",
            BODY,
        )],
        Some(published.clone()),
    );
    assert!(hidden.posts[0].third_perspectives().is_empty());
    assert!(!build(&hidden)["posts/tides/index.html"].contains("ob-third-perspectives"));
    assert!(!hidden.posts[0]
        .capabilities
        .iter()
        .any(|capability| capability.id == "third-perspectives"));
    let off = site_with(HOSTED, "", Some(published.clone()));
    assert!(off.posts[0].third_perspectives().is_empty());
    // Legacy output: with the kind off, the file changes no byte of any file.
    assert_eq!(build(&off), build(&site_with(HOSTED, "", None)));
}

#[test]
fn an_open_post_without_approved_reflections_links_portable_copies_to_its_form() {
    let site = site_with(HOSTED, OPEN_KIND, None);
    let capability = site.posts[0]
        .capabilities
        .iter()
        .find(|capability| capability.id == "third-perspectives")
        .unwrap();
    assert_eq!(capability.native_renderer, Some("ob-third-perspective"));
    let html = PortableProjection::from_post(&site.posts[0], &site.config)
        .unwrap()
        .portable_html()
        .unwrap()
        .html;
    assert!(html.contains("<strong>Third Perspectives</strong>: take part on <a href=\"https://t.dev/posts/tides/#ob-third-perspective\">the original article</a>."));
    assert!(!html.contains("id=\"ob-third-perspective\"") && !html.contains("<section"));
    let markdown = PortableProjection::from_post(&site.posts[0], &site.config)
        .unwrap()
        .portable_markdown()
        .unwrap();
    assert!(markdown.contains("> **Third Perspectives:** take part on the [canonical article](https://t.dev/posts/tides/#ob-third-perspective)."));
    // Locked with nothing approved: nothing to see there, so no link.
    let locked = site_with(HOSTED, LOCKED_KIND, None);
    assert!(!locked.posts[0]
        .capabilities
        .iter()
        .any(|capability| capability.id == "third-perspectives"));
}

#[test]
fn names_follow_the_credits_now_and_targets_their_standing_in_the_text_now() {
    let base = site_with(HOSTED, OPEN_KIND, None);
    let (revision, target) = methods(&base);
    // A name that later matches a credit (here the site author, written
    // with a zero-width space and a decomposed accent) is withheld.
    for name in [
        "Ada Love\u{200b}lace",
        "Ada Lovelace",
        "ÁDA LOVELACE",
        "A\u{0301}da Lovelace",
    ] {
        let site = site_with(
            HOSTED,
            OPEN_KIND,
            Some(file(vec![record(
                ID_1,
                &revision,
                target.clone(),
                Some(name),
            )])),
        );
        let response = &site.posts[0].third_perspectives()[0].response;
        assert_eq!(response.name, None, "{name}");
        assert_eq!(response.heading(), "Third Perspective from a reader");
        assert_eq!(response.role, "reader");
    }
    // The section changed since: shown, said to be revised, never re-quoted.
    let changed = load(
        config(HOSTED, OPEN_KIND),
        vec![post_source(
            "tides",
            "",
            "The moon causes the tides.\n\n## Methods\n\nWe now measure them hourly.\n",
        )],
        Some(file(vec![record(ID_1, &revision, target.clone(), None)])),
    );
    let response = &changed.posts[0].third_perspectives()[0].response;
    assert!(response.stale);
    assert!(response.earlier_revision);
    let page = build(&changed);
    let list = section(&page["posts/tides/index.html"]);
    assert!(list.contains("About <a href=\"#methods\">Methods</a>, since revised"));
    assert!(list.contains("Written about an earlier version of this work."));
    assert!(!list.contains("twice a day"));
    // The section gone altogether.
    let gone = load(
        config(HOSTED, OPEN_KIND),
        vec![post_source("tides", "", "The moon causes the tides.\n")],
        Some(file(vec![record(ID_1, &revision, target, None)])),
    );
    let list = section(&build(&gone)["posts/tides/index.html"]).to_string();
    assert!(list.contains("About a section since revised or removed"));
}

#[test]
fn a_moved_post_a_missing_post_and_an_unreadable_file_show_nothing_and_say_why() {
    let base = site_with(HOSTED, OPEN_KIND, None);
    let (revision, target) = methods(&base);
    let mut moved = record(ID_1, &revision, target.clone(), None);
    moved["work"] = json!("/posts/old-tides/");
    let mut missing = record(ID_2, &revision, target, None);
    missing["post"] = json!("posts/gone.md");
    let site = site_with(HOSTED, OPEN_KIND, Some(file(vec![moved, missing])));
    assert!(site.posts[0].third_perspectives().is_empty());
    assert!(site
        .warnings
        .iter()
        .any(|warning| warning.contains("is now published at /posts/tides/")));
    assert!(site
        .warnings
        .iter()
        .any(|warning| warning.contains("posts/gone.md, which is not a post")));
    let broken = site_with(
        HOSTED,
        OPEN_KIND,
        Some("{\"version\":1,\"items\":[{\"id\":1}]}".into()),
    );
    let error = broken.third_perspectives_error.clone().unwrap();
    assert!(
        error.starts_with("content/third-perspectives.json: item 1:"),
        "{error}"
    );
    assert!(broken.posts[0].third_perspectives().is_empty());
}

#[test]
fn the_page_projection_is_the_inboxs_projection() {
    // The record and the hosted copy project to the same public response.
    let site = site_with(HOSTED, OPEN_KIND, None);
    let post = &site.posts[0];
    let copy = copy(&site, "Mina", true);
    let hosted = hosted(&copy, "approved", Some(1));
    let record = PublishedPerspective::from_hosted(
        "posts/tides.md",
        &hosted,
        post,
        &site.config,
        time("2026-10-27T09:00:00Z"),
    )
    .unwrap();
    let work = PublishedWork::of_post(post, &site.config);
    let document = PassageDocument::of_post(post, &site.config);
    let target = TargetStatus::from(
        &document.resolve(&copy.provenance.target, Some(&copy.provenance.revision)),
    );
    let facts = ModerationFacts {
        state: ModerationState::Approved,
        revision: 1,
        approved_revision: Some(1),
        approved_consent: Some(1),
        clarification_asked: None,
        content_retained: true,
    };
    for mode in [ParticipationMode::Open, ParticipationMode::Locked] {
        assert_eq!(
            record.response(mode, &work, &target),
            copy.approved_response(&facts, mode, &work, &target)
        );
    }
    assert_eq!(
        record.response(ParticipationMode::Hidden, &work, &target),
        None
    );
}
