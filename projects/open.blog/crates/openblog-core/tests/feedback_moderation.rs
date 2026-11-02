//! Moderating passage feedback and publishing what was approved (#83, ADR
//! 0083): the shared moderation rules, the passage check a moderator sees
//! before acting, the public file of approved notes and its hostile-input
//! refusals, the canonical-page-only section with its portable link, the
//! revision notes a feedback site publishes, and privacy leaks.

use std::collections::BTreeMap;

use openblog_core::date::DateTime;
use openblog_core::feedback_moderation::{
    available, plan, reasons, review_passage, rules, ModerationAction, ModerationState,
    PassageCheck, PolicyError, ReasonCode,
};
use openblog_core::feedback_provenance::FeedbackChannel;
use openblog_core::feedback_publication::{
    is_day, is_post_source, PublishedFeedback, ReaderFeedbackFile, MAX_PUBLISHED_FEEDBACK,
    READER_FEEDBACK_ANCHOR,
};
use openblog_core::invitation::Identities;
use openblog_core::moderation::{ModerationPolicy, Principal, SharedWorks};
use openblog_core::moderation_inbox::{Inbox, InboxItem, Protocol};
use openblog_core::passage_target::PassageDocument;
use openblog_core::portability::PortableProjection;
use openblog_core::scholarly_feedback::{FeedbackSubmission, HostedFeedback, ScholarlyFeedback};
use openblog_core::{
    feeds, generate, LoadOptions, Post, Site, SiteConfig, SourceFile, Sources, ThemeSet,
};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/feedback-moderation.json"
    ))
    .unwrap()
}

#[test]
fn the_rules_are_the_shared_fixture_and_every_case_agrees() {
    let fixture = fixture();
    assert_eq!(rules(), fixture["rules"]);
    for case in fixture["cases"].as_array().unwrap() {
        let from = ModerationState::from_id(case["from"].as_str().unwrap()).unwrap();
        let outcome = plan(
            from,
            case["action"].as_str().unwrap(),
            case["reason"].as_str(),
        );
        match case["refused"].as_str() {
            Some(code) => {
                let error = outcome.expect_err(&case.to_string());
                assert_eq!(error.code(), code, "{case}");
            }
            None => {
                let change = outcome.unwrap_or_else(|error| panic!("{case}: {error}"));
                assert_eq!(change.to.id(), case["to"].as_str().unwrap(), "{case}");
                assert_eq!(change.from, from);
                assert_eq!(change.reason.map(ReasonCode::id), case["reason"].as_str());
            }
        }
    }
}

#[test]
fn states_are_the_participation_policys_and_reasons_never_judge_facts() {
    let ids: Vec<&str> = ModerationState::ALL
        .iter()
        .map(|state| state.id())
        .collect();
    assert_eq!(
        ids,
        [
            "pending",
            "clarification",
            "approved",
            "rejected",
            "removed",
            "withdrawn"
        ]
    );
    for state in ModerationState::ALL {
        assert_eq!(ModerationState::from_id(state.id()), Some(state));
    }
    for reason in ReasonCode::ALL {
        for verdict in [
            "incorrect",
            "false",
            "wrong",
            "misinformation",
            "correct",
            "true",
        ] {
            assert!(!reason.id().contains(verdict), "{}", reason.id());
            assert!(
                !reason.label().to_lowercase().contains(verdict),
                "{}",
                reason.label()
            );
        }
    }
    // Only an approval publishes, and nothing reopens or deletes.
    assert_eq!(
        available(ModerationState::Pending),
        [ModerationAction::Approve, ModerationAction::Reject]
    );
    assert_eq!(
        available(ModerationState::Approved),
        [ModerationAction::Remove]
    );
    for closed in [
        ModerationState::Rejected,
        ModerationState::Removed,
        ModerationState::Withdrawn,
    ] {
        assert!(available(closed).is_empty());
    }
    assert_eq!(
        plan(ModerationState::Pending, "reject", None).unwrap_err(),
        PolicyError::ReasonRequired
    );
}

const TIDES: &str = "---
title: Tides
date: 2026-10-20
---
The moon causes the tides. The sun matters too.

## Methods

We measured the tides twice a day. The tides rose.

## Results

The tides rose again.
";
/// The same post after the author edited the Methods section.
const TIDES_EDITED: &str = "---
title: Tides
date: 2026-10-20
---
Most agree: the moon causes the tides. The sun matters too.

## Methods

We measured once. The tides rose.

## Results

The tides rose again.
";
const LOCKED: &str = "---
title: Locked
date: 2026-10-19
comments: locked
---
## Part

Locked text stays.
";
const HIDDEN: &str = "---
title: Hidden
date: 2026-10-18
comments: hidden
---
## Part

Hidden text stays.
";
const FEEDBACK_SITE: &str = r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","author":{"name":"A"},
  "feeds":{"fullContent":true,"llms":true},
  "engagement":{"enabled":true,"feedback":true,"endpoint":"https://t.dev/api"}}"#;
const PLAIN_SITE: &str = r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","author":{"name":"A"},
  "feeds":{"fullContent":true,"llms":true}}"#;

const HOSTILE: &str = "<img src=x onerror=alert(1)> & \"quotes\"";
const PRIVATE_NAME: &str = "Grace Private";
const SEEN_TIME: &str = "2026-10-26T09:58:00Z";

fn source(path: &str, contents: &str) -> SourceFile {
    SourceFile {
        path: path.into(),
        contents: contents.into(),
    }
}

fn load(config: &str, tides: &str, feedback: Option<String>) -> Site {
    let sources = Sources {
        posts: vec![
            source("posts/tides.md", tides),
            source("posts/locked.md", LOCKED),
            source("posts/hidden.md", HIDDEN),
        ],
        reader_feedback: feedback.map(|text| source("content/reader-feedback.json", &text)),
        ..Sources::default()
    };
    Site::load(
        SiteConfig::from_json(config).unwrap(),
        sources,
        LoadOptions::default(),
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"))
}

fn build(site: &Site) -> BTreeMap<String, String> {
    generate(site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .map(|file| (file.path, file.contents))
        .collect()
}

fn post<'a>(site: &'a Site, slug: &str) -> &'a Post {
    site.posts.iter().find(|post| post.slug == slug).unwrap()
}

fn at(text: &str) -> DateTime {
    DateTime::parse(text).unwrap()
}

/// A received record about `words` in section `index` of the post as `site`
/// publishes it (or the whole post), from a reader whose name is private
/// unless `publish_name`.
fn received(
    site: &Site,
    slug: &str,
    kind: &str,
    target: Option<(usize, &str)>,
    body: &str,
    publish_name: bool,
) -> ScholarlyFeedback {
    let post = post(site, slug);
    let document = PassageDocument::of_post(post, &site.config);
    let target = match target {
        None => document.work_target(),
        Some((index, words)) => {
            let text: Vec<char> = document.sections[index].text.chars().collect();
            let joined: String = text.iter().collect();
            let byte = joined.find(words).unwrap();
            let start = joined[..byte].chars().count();
            document
                .quote(index, start, start + words.chars().count())
                .unwrap()
        }
    };
    let mut submission = json!({
        "version": 1,
        "kind": kind,
        "work": post.url,
        "revision": document.revision,
        "target": target.to_value(),
        "body": body,
        "seenAt": SEEN_TIME,
        "attribution": {"name": PRIVATE_NAME, "publishName": publish_name},
    });
    if kind == "correction-suggestion" {
        submission["details"] = json!({"suggestedText": "The moon and the sun cause the tides.", "sourceUrl": "https://example.org/tides?x=1"});
    }
    FeedbackSubmission::from_value(&submission)
        .unwrap()
        .receive(at("2026-10-26T10:00:00Z"), FeedbackChannel::Hosted)
        .unwrap()
}

/// The item as the site Admin sees it in the moderation inbox (ADR 0105).
fn moderation_view(item: &HostedFeedback, site: &Site) -> Value {
    let value = json!({
        "source": "feedback", "id": item.id, "status": item.status.id(), "version": item.version,
        "moderatedAt": null, "reason": null, "feedback": item.feedback.to_value(),
    });
    let item = InboxItem::from_value(&value).unwrap();
    let works = SharedWorks::new(&[], site);
    let identities = Identities {
        active_admin_users: &[],
        contributor_ids: &[],
    };
    Inbox {
        site,
        works: &works,
        principal: Principal::ModerationToken,
        identities: &identities,
        policy: ModerationPolicy::default(),
        protocol: Protocol::Full,
        third_perspectives: false,
        now: at("2026-10-27T10:00:00Z"),
    }
    .view(&item)
    .unwrap()
}

fn hosted(record: &ScholarlyFeedback, id: &str, status: &str) -> HostedFeedback {
    HostedFeedback::from_value(&json!({
        "id": id, "status": status, "version": 1, "moderatedAt": null, "reason": null,
        "feedback": record.to_value(),
    }))
    .unwrap()
}

const ID_A: &str = "00000000-0000-4000-8000-00000000000a";
const ID_B: &str = "00000000-0000-4000-8000-00000000000b";
const ID_C: &str = "00000000-0000-4000-8000-00000000000c";

#[test]
fn a_moderator_sees_whether_the_passage_is_current_reanchored_or_stale() {
    let seen = load(FEEDBACK_SITE, TIDES, None);
    let edited = load(FEEDBACK_SITE, TIDES_EDITED, None);
    let still_there = received(
        &seen,
        "tides",
        "question",
        Some((0, "The sun matters too.")),
        "Why?",
        false,
    );
    let gone = received(
        &seen,
        "tides",
        "correction-suggestion",
        Some((1, "twice a day")),
        "Three times.",
        false,
    );

    let check = |site: &Site, record: &ScholarlyFeedback| {
        let post = post(site, "tides");
        let document = PassageDocument::of_post(post, &site.config);
        review_passage(record, Some((post, &document)))
    };
    assert_eq!(check(&seen, &still_there).check, PassageCheck::Current);
    let moved = check(&edited, &still_there);
    assert_eq!(moved.check, PassageCheck::Reanchored);
    assert!(moved.explanation.contains("Check that they still mean"));
    let stale = check(&edited, &gone);
    assert!(matches!(stale.check, PassageCheck::Stale(_)));
    assert!(stale.check.needs_acknowledgement());
    assert!(stale.explanation.contains("will not be quoted on the post"));
    assert_eq!(review_passage(&gone, None).check, PassageCheck::UnknownWork);

    // The view: the passage check with both revisions, the reader's own
    // quotation for the moderator, the public preview without the removed
    // words, and the actions open to the item. The reader's clock never.
    let view = moderation_view(&hosted(&gone, ID_A, "pending"), &edited);
    assert_eq!(view["passage"]["check"], "stale");
    assert_eq!(view["passage"]["acknowledge"], true);
    assert_eq!(view["passage"]["quoted"], "twice a day");
    assert_eq!(view["passage"]["sectionSeen"], "methods");
    assert_ne!(
        view["passage"]["revisionSeen"],
        view["passage"]["revisionNow"]
    );
    assert_eq!(view["publicPreview"]["stale"], true);
    assert!(view["publicPreview"].get("quote").is_none());
    assert!(view["publicPreview"].get("name").is_none());
    assert_eq!(
        view["reader"],
        json!({"name": PRIVATE_NAME, "publishName": false})
    );
    assert_eq!(view["kindLabel"], "Suggested correction");
    let actions: Vec<&str> = view["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["action"].as_str().unwrap())
        .collect();
    assert_eq!(actions, ["approve", "reject"]);
    let text = view.to_string();
    assert!(
        !text.contains(SEEN_TIME) && !text.contains("seenAt"),
        "{text}"
    );

    let current = moderation_view(&hosted(&still_there, ID_B, "approved"), &seen);
    assert_eq!(current["passage"]["check"], "current");
    assert_eq!(current["passage"]["acknowledge"], false);
    assert_eq!(current["post"]["source"], "posts/tides.md");
    assert_eq!(current["actions"][0]["action"], "remove");
    assert_eq!(
        current["actions"][0]["reasons"].as_array().unwrap().len(),
        reasons(ModerationAction::Remove).len()
    );
}

fn published_file(site: &Site) -> ReaderFeedbackFile {
    let question = received(
        site,
        "tides",
        "question",
        Some((0, "The sun matters too.")),
        &format!("Why the sun? {HOSTILE}\n\nSecond paragraph."),
        true,
    );
    let correction = received(
        site,
        "tides",
        "correction-suggestion",
        Some((1, "twice a day")),
        "It was three times.",
        false,
    );
    let whole = received(
        site,
        "locked",
        "alternative-interpretation",
        None,
        "Another reading of all of it.",
        false,
    );
    let hidden = received(
        site,
        "hidden",
        "question",
        None,
        "A question on a hidden post.",
        true,
    );
    let mut file = ReaderFeedbackFile::default();
    for (id, post, record) in [
        (ID_A, "posts/tides.md", &question),
        (ID_B, "posts/tides.md", &correction),
        (ID_C, "posts/locked.md", &whole),
        (
            "00000000-0000-4000-8000-00000000000d",
            "posts/hidden.md",
            &hidden,
        ),
    ] {
        file.publish(
            PublishedFeedback::from_record(id, post, record, at("2026-10-27T08:00:00Z")).unwrap(),
        )
        .unwrap();
    }
    file.respond(
        ID_A,
        Some(&format!("Because of gravity. {HOSTILE}")),
        at("2026-10-28T12:00:00Z"),
    )
    .unwrap();
    file
}

#[test]
fn the_published_file_holds_only_public_data_and_reads_back_exactly() {
    let site = load(FEEDBACK_SITE, TIDES, None);
    let file = published_file(&site);
    let text = file.to_json();
    assert!(text.ends_with("}\n"));
    let read = ReaderFeedbackFile::from_json(&text).unwrap();
    assert_eq!(read.to_json(), text);
    assert_eq!(read.items.len(), file.items.len());
    for item in &file.items {
        assert_eq!(read.get(&item.id), Some(item));
    }
    let value: Value = serde_json::from_str(&text).unwrap();
    let by_id = |id: &str| {
        value["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .unwrap()
            .clone()
    };
    // Sorted by post, so the hidden post's note comes first.
    assert_eq!(value["items"][0]["post"], "posts/hidden.md");
    let first = &by_id(ID_A);
    assert_eq!(first["received"], "2026-10-26");
    assert_eq!(first["approved"], "2026-10-27");
    assert_eq!(
        first["name"], PRIVATE_NAME,
        "the first reader agreed to show it"
    );
    assert_eq!(first["response"]["date"], "2026-10-28");
    // The second reader did not agree: the file never holds their name, and
    // no reader's clock, time of day, channel or moderation detail is kept.
    assert!(by_id(ID_B).get("name").is_none());
    for leak in [
        SEEN_TIME,
        "seenAt",
        "T10:00",
        "channel",
        "hosted",
        "status",
        "reason",
        "version\": 2",
    ] {
        assert!(!text.contains(leak), "{leak}");
    }
    assert_eq!(
        text.matches(PRIVATE_NAME).count(),
        2,
        "only the two consenting readers"
    );

    // Republishing keeps the author's response; clearing it removes it.
    let mut again = file.clone();
    let record = received(
        &site,
        "tides",
        "question",
        Some((0, "The sun matters too.")),
        "Changed text.",
        true,
    );
    again
        .publish(
            PublishedFeedback::from_record(
                ID_A,
                "posts/tides.md",
                &record,
                at("2026-10-29T00:00:00Z"),
            )
            .unwrap(),
        )
        .unwrap();
    assert!(again.get(ID_A).unwrap().response.is_some());
    again
        .respond(ID_A, None, at("2026-10-29T00:00:00Z"))
        .unwrap();
    assert!(again.get(ID_A).unwrap().response.is_none());
    assert!(again
        .respond(
            ID_C.replace('c', "e").as_str(),
            Some("x"),
            at("2026-10-29T00:00:00Z")
        )
        .is_err());
    assert!(again
        .respond(ID_A, Some("bad \u{202e} text"), at("2026-10-29T00:00:00Z"))
        .is_err());
    assert!(again.unpublish(ID_B));
    assert!(!again.unpublish(ID_B));
}

#[test]
fn a_hostile_or_broken_file_is_refused_naming_the_item_and_never_repeating_it() {
    let site = load(FEEDBACK_SITE, TIDES, None);
    let good: Value = serde_json::from_str(&published_file(&site).to_json()).unwrap();
    let item = good["items"][0].clone();
    let with = |change: &dyn Fn(&mut Value)| {
        let mut item = item.clone();
        change(&mut item);
        json!({"version": 1, "items": [item]}).to_string()
    };
    let cases: Vec<(&str, String)> = vec![
        (
            "unknown field",
            with(&|item| item["email"] = json!("ada@example.org")),
        ),
        ("seen time", with(&|item| item["seenAt"] = json!(SEEN_TIME))),
        ("bad id", with(&|item| item["id"] = json!("1; drop table"))),
        (
            "upper-case id",
            with(&|item| item["id"] = json!(ID_A.to_uppercase())),
        ),
        (
            "traversal",
            with(&|item| item["post"] = json!("../secret.md")),
        ),
        (
            "inner traversal",
            with(&|item| item["post"] = json!("posts/../../secret.md")),
        ),
        (
            "absolute",
            with(&|item| item["post"] = json!("/posts/tides.md")),
        ),
        (
            "backslash",
            with(&|item| item["post"] = json!("posts\\tides.md")),
        ),
        (
            "not a post",
            with(&|item| item["post"] = json!("pages/about.md")),
        ),
        (
            "bad day",
            with(&|item| item["received"] = json!("2026-02-30")),
        ),
        (
            "time not day",
            with(&|item| item["received"] = json!("2026-10-26T10:00:00Z")),
        ),
        (
            "approved first",
            with(&|item| item["approved"] = json!("2026-10-01")),
        ),
        (
            "unknown kind",
            with(&|item| item["kind"] = json!("correction")),
        ),
        (
            "bidi name",
            with(&|item| item["name"] = json!("Ada \u{202e}secret")),
        ),
        (
            "padded body",
            with(&|item| item["body"] = json!("  secret padded  ")),
        ),
        (
            "control in response",
            with(&|item| item["response"]["text"] = json!("secret\u{0007}")),
        ),
        (
            "unsafe source",
            with(&|item| {
                item["kind"] = json!("source-suggestion");
                item["details"] = json!({"sourceUrl": "javascript:alert('secret')"});
            }),
        ),
        (
            "newer version",
            json!({"version": 3, "items": []}).to_string(),
        ),
        (
            "duplicate id",
            json!({"version": 1, "items": [item.clone(), item.clone()]}).to_string(),
        ),
        ("not json", "{\"version\": 1, \"items\": [".into()),
        (
            "too many",
            json!({"version": 1, "items": vec![Value::Null; MAX_PUBLISHED_FEEDBACK + 1]})
                .to_string(),
        ),
    ];
    for (name, text) in cases {
        let error = ReaderFeedbackFile::from_json(&text).expect_err(name);
        assert!(
            !error.contains("secret") && !error.contains("ada@"),
            "{name}: {error}"
        );
        if !matches!(name, "newer version" | "not json" | "too many") {
            assert!(error.starts_with("item "), "{name}: {error}");
        }
    }
    assert!(ReaderFeedbackFile::from_json(&" ".repeat(9 * 1024 * 1024)).is_err());
    for day in ["2026-10-26", "2024-02-29"] {
        assert!(is_day(day), "{day}");
    }
    for day in ["2026-1-01", "0000-01-01", "2023-02-29", "２０２６-10-26"] {
        assert!(!is_day(day), "{day}");
    }
    assert!(is_post_source("posts/2026/tides.md") && is_post_source("loose.md"));
    assert!(!is_post_source("posts/tides.md:stream") && !is_post_source("posts//tides.md"));

    // A broken file never stops a load: a full build refuses it instead
    // (see the CLI), naming the file without repeating its contents.
    let broken = load(
        FEEDBACK_SITE,
        TIDES,
        Some(with(&|item| item["body"] = json!("  secret  "))),
    );
    let error = broken.reader_feedback_error.clone().unwrap();
    assert!(
        error.starts_with("content/reader-feedback.json: item 1:"),
        "{error}"
    );
    assert!(!error.contains("secret"));
    assert!(post(&broken, "tides").reader_feedback().is_empty());
}

fn section(page: &str) -> &str {
    let start = page
        .find(&format!("<section id=\"{READER_FEEDBACK_ANCHOR}\""))
        .expect("reader feedback section");
    let end = start + page[start..].find("</section>\n").unwrap() + "</section>\n".len();
    &page[start..end]
}

#[test]
fn approved_notes_appear_only_on_the_canonical_page_escaped_and_without_private_data() {
    let site = load(FEEDBACK_SITE, TIDES, None);
    let file = published_file(&site).to_json();
    let published = load(FEEDBACK_SITE, TIDES, Some(file.clone()));
    assert!(published.reader_feedback_error.is_none());
    let files = build(&published);
    let page = &files["tides/index.html"];
    let notes = section(page);
    // Before the feedback form, after the article.
    assert!(page.find(notes).unwrap() < page.find("<section id=\"ob-feedback\"").unwrap());
    assert!(
        notes.contains("<h2 id=\"ob-reader-feedback-title\">Reader questions and responses</h2>")
    );
    assert!(notes.contains("Publishing a note does not mean the author agrees with it."));
    // The question: its quotation (still published), its section link, the
    // consenting reader's name, the day received and the revision seen.
    assert!(notes.contains("<h3 id=\"ob-reader-note-00000000-0000-4000-8000-00000000000a-title\">Question about the opening</h3>"));
    assert!(notes.contains(
        "<blockquote class=\"ob-reader-note-quote\"><p>The sun matters too.</p></blockquote>"
    ));
    assert!(notes.contains(&format!(
        "From {PRIVATE_NAME} · received <time datetime=\"2026-10-26\">2026-10-26</time>"
    )));
    assert!(notes.contains("<p>Why the sun? &lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;</p>\n<p>Second paragraph.</p>"));
    assert!(notes.contains("<h4>The author’s response <time datetime=\"2026-10-28\">2026-10-28</time></h4>\n<p>Because of gravity. &lt;img"));
    // The suggested correction keeps the reader's label, never "Correction".
    assert!(notes.contains("Suggested correction about <a href=\"#methods\">Methods</a></h3>"));
    assert!(!notes.contains(">Correction"));
    assert!(notes.contains(
        "<a href=\"https://example.org/tides?x=1\" rel=\"nofollow ugc noopener noreferrer\">"
    ));
    assert!(notes.contains("From a reader ·"));
    assert!(!notes.contains("<img") && !notes.contains("<script"));

    // Leaks: the private name, the reader's clock and anything about
    // moderation never reach any output; the notes reach no output but the
    // canonical page: no feed, no llms.txt, no search index, no other page.
    for (path, contents) in &files {
        assert!(!contents.contains(SEEN_TIME), "{path}");
        assert!(!contents.contains("T10:00:00"), "{path}");
        if path != "tides/index.html" && path != "locked/index.html" {
            assert!(!contents.contains("Why the sun?"), "{path}");
            assert!(!contents.contains("Because of gravity"), "{path}");
            assert!(!contents.contains(PRIVATE_NAME), "{path}");
        }
    }
    let llms = feeds::llms_full(&published).unwrap();
    assert!(!llms.contains("Why the sun?") && !llms.contains(PRIVATE_NAME));

    // A locked post still shows what was approved; a hidden one shows none.
    assert!(section(&files["locked/index.html"])
        .contains("Another interpretation about the whole post"));
    assert!(!files["hidden/index.html"].contains(READER_FEEDBACK_ANCHOR));
    assert!(!files["hidden/index.html"].contains("A question on a hidden post"));

    // Portable copies carry a labelled link to the canonical page (P6.2),
    // never the notes.
    let projection =
        PortableProjection::from_post(post(&published, "tides"), &published.config).unwrap();
    let html = projection.portable_html().unwrap().html;
    let markdown = projection.portable_markdown().unwrap();
    let text = projection.portable_text().unwrap();
    for (name, output) in [("html", &html), ("markdown", &markdown), ("text", &text)] {
        assert!(
            output.contains("Questions and corrections"),
            "{name}: {output}"
        );
        assert!(
            !output.contains("Why the sun?") && !output.contains(PRIVATE_NAME),
            "{name}"
        );
    }
    assert!(html.contains("<strong>Questions and corrections</strong>: see it on <a href=\"https://t.dev/tides/\">the original article</a>."));

    // Every other page is exactly what it is without the file; full-content
    // feeds gain only the labelled link of the posts that publish notes.
    let before = build(&site);
    let mut changed = Vec::new();
    for (path, contents) in &before {
        if files.get(path) != Some(contents) {
            changed.push(path.as_str());
        }
    }
    assert_eq!(
        changed,
        [
            "feed.json",
            "locked/index.html",
            "rss.xml",
            "tides/index.html"
        ]
    );
    for feed in ["feed.json", "rss.xml"] {
        assert!(files[feed].contains("Questions and corrections"), "{feed}");
        assert!(
            !files[feed].contains(
                "Questions and corrections</strong>: see it on <a href=\\\"https://t.dev/hidden/"
            ),
            "{feed}"
        );
    }
}

#[test]
fn a_passage_the_author_removed_is_never_quoted_again() {
    let seen = load(FEEDBACK_SITE, TIDES, None);
    let file = published_file(&seen).to_json();
    let edited = load(FEEDBACK_SITE, TIDES_EDITED, Some(file));
    let notes = post(&edited, "tides").reader_feedback();
    let correction = notes.iter().find(|note| note.id == ID_B).unwrap();
    assert!(correction.provenance.stale);
    assert_eq!(correction.provenance.quote, None);
    let page = &build(&edited)["tides/index.html"];
    let notes = section(page);
    assert!(notes.contains(
        "Suggested correction about <a href=\"#methods\">Methods</a>, since revised</h3>"
    ));
    assert!(notes.contains("The post has changed since this note was sent"));
    assert!(!notes.contains("twice a day"));
    // The moved question is still quoted: its words are still published.
    assert!(notes.contains("<p>The sun matters too.</p>"));
}

#[test]
fn a_note_about_a_missing_post_is_a_warning_and_nothing_else_changes() {
    let site = load(FEEDBACK_SITE, TIDES, None);
    let mut file = published_file(&site);
    let mut orphan = file.get(ID_A).unwrap().clone();
    orphan.id = "00000000-0000-4000-8000-0000000000ff".into();
    orphan.post = "posts/gone.md".into();
    file.publish(orphan).unwrap();
    let loaded = load(FEEDBACK_SITE, TIDES, Some(file.to_json()));
    assert!(loaded.reader_feedback_error.is_none());
    assert!(loaded
        .warnings
        .iter()
        .any(|warning| warning.contains("is about posts/gone.md, which is not a post")));
    assert_eq!(post(&loaded, "tides").reader_feedback().len(), 2);
}

const WITH_NOTE: &str = "---
title: Tides
date: 2026-10-20
evidenceRevisions:
  - \"2026-10-28: Corrected how often the tides were measured.\"
---
The moon causes the tides.
";

#[test]
fn a_feedback_site_publishes_the_authors_revision_notes_through_the_evidence_section() {
    let feedback = load(FEEDBACK_SITE, WITH_NOTE, None);
    let page = &build(&feedback)["tides/index.html"];
    assert!(page.contains("Revision notes"), "{page}");
    assert!(page.contains("Corrected how often the tides were measured."));
    // The note is part of the post's publication text, so portable copies
    // carry it too (ADR 0075); it names no reader.
    let projection =
        PortableProjection::from_post(post(&feedback, "tides"), &feedback.config).unwrap();
    assert!(projection
        .portable_markdown()
        .unwrap()
        .contains("Corrected how often"));

    // Without the feedback opt-in or claim evidence, A4's rule stands: no
    // notes are published and the post is as before.
    let plain = load(PLAIN_SITE, WITH_NOTE, None);
    assert!(!build(&plain)["tides/index.html"].contains("Corrected how often"));
}

/// ADR 0101: each published note is shown only where its own kind's mode on
/// the post shows approved items, whatever the other kinds do.
#[test]
fn a_published_note_follows_its_own_kinds_mode_on_the_post() {
    let site = load(FEEDBACK_SITE, TIDES, None);
    let file = published_file(&site).to_json();
    let per_kind = r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","author":{"name":"A"},
  "engagement":{"enabled":true,"endpoint":"https://t.dev/api"},
  "participation":{"kinds":{"question":"locked","correction-suggestion":"hidden"}}}"#;
    let site = load(per_kind, TIDES, Some(file));
    let pages = build(&site);
    let tides = section(&pages["tides/index.html"]);
    // The question is locked: still shown. The suggested correction is
    // hidden on every post: never shown.
    assert!(tides.contains("Why the sun?"), "{tides}");
    assert!(!tides.contains("It was three times."), "{tides}");
    // Nothing is open, so no post asks for more.
    assert!(!pages["tides/index.html"].contains("<ob-passage-feedback"));
}

/// ADR 0101 and ADR 0083: a site that turns hosted engagement off, or leaves
/// its hosted service, keeps every note it published, while a kind it
/// switches off or hides still shows none. Nothing is offered without a
/// transport.
#[test]
fn published_notes_stay_on_the_pages_of_a_site_without_hosted_engagement() {
    let site = load(FEEDBACK_SITE, TIDES, None);
    let file = published_file(&site).to_json();
    for config in [
        r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","author":{"name":"A"},
  "engagement":{"enabled":false,"feedback":true,"endpoint":"https://t.dev/api"}}"#,
        r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","author":{"name":"A"},
  "engagement":{"feedback":true}}"#,
        r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","author":{"name":"A"},
  "participation":{"kinds":{"question":"follow-comments","correction-suggestion":"open",
    "alternative-interpretation":"locked"}}}"#,
    ] {
        let site = load(config, TIDES, Some(file.clone()));
        let pages = build(&site);
        let tides = section(&pages["tides/index.html"]);
        assert!(tides.contains("Why the sun?"), "{config}: {tides}");
        assert!(tides.contains("It was three times."), "{config}: {tides}");
        assert!(
            section(&pages["locked/index.html"]).contains("Another reading of all of it."),
            "{config}"
        );
        // A post that hides comments, which the kinds follow, still shows none.
        assert!(
            !pages["hidden/index.html"].contains("A question on a hidden post"),
            "{config}"
        );
        // Without a transport nothing is accepted.
        assert!(!pages["tides/index.html"].contains("<ob-passage-feedback"));
    }
    // Switching a kind off, or hiding it, takes its notes off the pages.
    let off = r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","author":{"name":"A"},
  "participation":{"kinds":{"question":"hidden"}}}"#;
    let site = load(off, TIDES, Some(file));
    let pages = build(&site);
    assert!(!pages["tides/index.html"].contains("Why the sun?"));
    assert!(!pages["tides/index.html"].contains("It was three times."));
}

/// ADR 0107: while abuse reports are open, every published note and the
/// comments carry a report form whose static text works without a script;
/// a site that offers receipts lets readers use them in the form. No
/// service credential reaches any page.
#[test]
fn reports_and_receipts_are_offered_only_where_the_site_turns_them_on() {
    let site = load(FEEDBACK_SITE, TIDES, None);
    let file = published_file(&site).to_json();
    let protected = r#"{"title":"T","url":"https://t.dev","postPath":"/{slug}/","author":{"name":"A"},
  "engagement":{"enabled":true,"feedback":true,"receipts":true,"endpoint":"https://t.dev/api"},
  "participation":{"kinds":{"abuse-report":"open"}}}"#;
    let pages = build(&load(protected, TIDES, Some(file.clone())));
    let tides = &pages["tides/index.html"];
    for id in [ID_A, ID_B] {
        assert!(
            tides.contains(&format!(
                "<ob-abuse-report endpoint=\"https://t.dev/api\" source=\"feedback\" item=\"{id}\" subject=\"this note\"><p class=\"ob-abuse-report-static\">To report this note as abusive, write to the author.</p></ob-abuse-report>"
            )),
            "{tides}"
        );
    }
    assert!(tides.contains(" receipts>"), "{tides}");
    assert!(tides.contains("<ob-comments path=\"/tides/\" endpoint=\"https://t.dev/api\" reports>"));
    // Off by default: the same site without them has neither.
    let plain = build(&load(FEEDBACK_SITE, TIDES, Some(file)));
    for page in plain.values().chain(pages.values()) {
        for secret in [
            "sb_secret",
            "SUPABASE",
            "service_role",
            "OPENBLOG_ADMIN_API_KEY",
            "receipt_hash",
        ] {
            assert!(!page.contains(secret), "{secret}");
        }
    }
    let plain = &plain["tides/index.html"];
    assert!(
        !plain.contains("ob-abuse-report")
            && !plain.contains(" receipts>")
            && !plain.contains(" reports>")
    );
    // Written back, the setting stays out of a file that never set it.
    let config = SiteConfig::from_json(FEEDBACK_SITE).unwrap();
    assert!(!serde_json::to_string(&config).unwrap().contains("receipts"));
}
