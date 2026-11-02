//! Accessible attributed perspective conversations (#224, ADRs 0137 and
//! 0138): an approved author response is published in the versioned public
//! file under the reflection it answers, shown after that author's own section
//! on the canonical page as static HTML, labelled as the author's and never a
//! reader's, bounded, escaped and anchored; portable copies, feeds and `llms`
//! files carry only the labelled canonical link; and with author responses
//! hidden the page is exactly as it was.

use std::collections::{BTreeMap, BTreeSet};

use openblog_core::attributed_perspective::AttributedSections;
use openblog_core::perspective_publication::{
    PublishedAnswer, ThirdPerspectivesFile, MAX_IN_SECTION,
};
use openblog_core::portability::PortableProjection;
use openblog_core::reflection::{compose_bound, ComposedTurn, Placement, ReflectionLayout};
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};
use serde_json::{json, Value};

const TURNS: [(&str, &str); 3] = [
    (
        "MINA",
        "The moon pulls the water, and the water answers it twice a day along the whole shore.",
    ),
    ("JOE", "It is also the sun."),
    ("MINA", "Neither explains the harbour."),
];
const CREDITS: &str = r#"{"version":1,"credits":[
  {"contributor":"mina","roles":[{"vocabulary":"crossref","role":"author"}]},
  {"contributor":"joe","roles":[{"vocabulary":"crossref","role":"author"}]}]}"#;
const HOSTED: &str = r#"{"enabled":true,"endpoint":"https://t.dev/api/","receipts":true,"feedbackContact":"mailto:author@t.dev"}"#;
const BOTH_OPEN: &str =
    r#"{"third-perspective":"open","author-response":"open","abuse-report":"open"}"#;
const ANSWERS_OFF: &str =
    r#"{"third-perspective":"open","author-response":"off","abuse-report":"open"}"#;
const PERSPECTIVES_OFF: &str = r#"{"third-perspective":"off","author-response":"open"}"#;

fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn arranged(turns: &[(&str, &str)]) -> String {
    let composed: Vec<ComposedTurn<'_>> = turns
        .iter()
        .enumerate()
        .map(|(round, (name, text))| ComposedTurn {
            round,
            round_prompt: None,
            display_name: name,
            label: None,
            placement: Placement { lane: 0, lanes: 1 },
            body: (*text).to_string(),
        })
        .collect();
    let keys: Vec<String> = turns.iter().map(|(name, _)| name.to_lowercase()).collect();
    let bound: Vec<Option<&str>> = keys.iter().map(|key| Some(key.as_str())).collect();
    compose_bound(ReflectionLayout::Sequential, &composed, &bound)
}

fn load(kinds: &str, turns: &[(&str, &str)], items: Option<Vec<Value>>, version: u32) -> Site {
    let config = SiteConfig::from_json(&format!(
        r#"{{"title":"T","url":"https://t.dev","postPath":"/{{slug}}/","author":{{"name":"A"}},
        "contributors":{{"mina":{{"name":"MINA"}},"joe":{{"name":"JOE"}}}},
        "engagement":{HOSTED},"participation":{{"kinds":{kinds}}}}}"#
    ))
    .unwrap();
    Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: "posts/shared-tides.md".into(),
                contents: format!(
                    "---\ntitle: Tides, together\ndate: 2026-10-01\n---\n{}",
                    arranged(turns)
                ),
            }],
            credits: vec![SourceFile {
                path: "posts/shared-tides.credits.json".into(),
                contents: CREDITS.into(),
            }],
            third_perspectives: items.map(|items| SourceFile {
                path: "content/third-perspectives.json".into(),
                contents: serde_json::to_string_pretty(
                    &json!({"version": version, "items": items}),
                )
                .unwrap(),
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

/// A published reflection about the `nth` section of the original body, as
/// Admin writes it, with an optional answer.
fn item(n: u32, section: usize, body: &str, answer: Option<Value>) -> Value {
    item_in(&TURNS, n, section, body, answer)
}

fn item_in(
    turns: &[(&str, &str)],
    n: u32,
    section: usize,
    body: &str,
    answer: Option<Value>,
) -> Value {
    let original = load(BOTH_OPEN, turns, None, 1);
    let target = AttributedSections::of_post(&original.posts[0]).sections()[section]
        .target()
        .perspective_target()
        .to_value();
    let revision = openblog_core::passage_target::PassageDocument::of_post(
        &original.posts[0],
        &original.config,
    )
    .revision;
    let mut value = json!({
        "id": id(n), "post": "posts/shared-tides.md", "work": "/shared-tides/",
        "revision": revision, "target": target, "body": body,
        "received": format!("2026-10-{:02}", 10 + n % 10), "approved": "2026-10-27",
    });
    if let Some(answer) = answer {
        value["answer"] = answer;
    }
    value
}

fn answer(n: u32, contributor: &str, author: &str, body: &str) -> Value {
    json!({
        "id": id(n), "contributor": contributor, "author": author, "body": body,
        "received": "2026-10-26", "approved": "2026-10-27",
    })
}

fn page(files: &BTreeMap<String, String>) -> &str {
    &files["shared-tides/index.html"]
}

/// The turn the `ob-by-` anchor names: from its opening tag to its end.
fn turn<'a>(page: &'a str, anchor: &str) -> &'a str {
    let start = page
        .find(&format!("id=\"{anchor}\""))
        .unwrap_or_else(|| panic!("no section with {anchor}"));
    let end = start + page[start..].find("</section>").unwrap();
    &page[start..end]
}

fn parse_ids(html: &str) -> Vec<String> {
    html.split(" id=\"")
        .skip(1)
        .map(|rest| rest[..rest.find('"').unwrap()].to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// The versioned file

#[test]
fn the_file_is_version_1_until_an_answer_is_published_and_then_2() {
    let plain = format!(
        "{{\"version\":1,\"items\":[{}]}}",
        item(1, 0, "I read the harbour differently.", None)
    );
    let file = ThirdPerspectivesFile::from_json(&plain).unwrap();
    assert!(file.to_json().contains("\"version\": 1"));
    assert!(!file.to_json().contains("answer"));

    let mut with = file.clone();
    with.set_answer(
        &id(1),
        PublishedAnswer {
            id: id(2),
            contributor: "mina".into(),
            author: "MINA".into(),
            body: "I meant the harbour.".into(),
            received: "2026-10-26".into(),
            approved: "2026-10-27".into(),
        },
    )
    .unwrap();
    let text = with.to_json();
    assert!(text.contains("\"version\": 2"), "{text}");
    assert_eq!(ThirdPerspectivesFile::from_json(&text).unwrap(), with);
    // Taking the answer off returns the file to version 1, byte for byte.
    assert!(with.unpublish_answer(&id(2)));
    assert_eq!(with.to_json(), file.to_json());
    assert!(!with.unpublish_answer(&id(2)));
    // Publishing the reflection again keeps the answer it has.
    let mut again = ThirdPerspectivesFile::from_json(&text).unwrap();
    let record = again.get(&id(1)).unwrap().clone();
    again
        .publish(
            openblog_core::perspective_publication::PublishedPerspective {
                answer: None,
                ..record
            },
        )
        .unwrap();
    assert!(again.get(&id(1)).unwrap().answer.is_some());
}

#[test]
fn the_file_holds_only_the_answers_public_fields_and_refuses_anything_else() {
    let good = item(
        1,
        0,
        "I read the harbour differently.",
        Some(answer(2, "mina", "MINA", "I meant the harbour.")),
    );
    let read = |item: &Value, version: u32| {
        ThirdPerspectivesFile::from_json(&json!({"version": version, "items": [item]}).to_string())
    };
    assert!(read(&good, 2).is_ok());
    // An answer needs version 2: an older reader would have ignored it.
    assert!(read(&good, 1).unwrap_err().contains("version"));
    for (field, value) in [
        ("participant", json!("p-mina")),
        ("account", json!("mina-admin")),
        ("moderator", json!("coord-admin")),
        ("standing", json!({"state": "current"})),
    ] {
        let mut bad = good.clone();
        bad["answer"][field] = value;
        assert!(read(&bad, 2).is_err(), "{field}");
    }
    // Only the section's own contributor answers it.
    let mut other = good.clone();
    other["answer"]["contributor"] = json!("joe");
    assert!(read(&other, 2)
        .unwrap_err()
        .contains("its own author's section"));
    // An answer to a reflection about the whole work, or an ordinary heading, has no author.
    let mut whole = good.clone();
    whole["target"] = json!({"version": 1, "kind": "work"});
    assert!(read(&whole, 2).is_err());
    for (field, value) in [
        ("id", json!("not-an-id")),
        ("contributor", json!("Mina")),
        ("author", json!("")),
        ("body", json!(" padded ")),
        ("approved", json!("2026-10-01")),
        ("received", json!("2026-13-01")),
    ] {
        let mut bad = good.clone();
        bad["answer"][field] = value;
        assert!(read(&bad, 2).is_err(), "{field}");
    }
    // The answer's id is its own, never the reflection's or another's.
    let mut clash = good.clone();
    clash["answer"]["id"] = good["id"].clone();
    assert!(read(&clash, 2).unwrap_err().contains("repeats"));
    // Errors name the item and never what it holds.
    let mut hostile = good.clone();
    hostile["answer"]["body"] = json!("SECRET-ANSWER <script>");
    hostile["answer"]["extra"] = json!(1);
    assert!(!read(&hostile, 2).unwrap_err().contains("SECRET-ANSWER"));
}

// ---------------------------------------------------------------------------
// The page

fn conversation_site() -> Site {
    load(
        BOTH_OPEN,
        &TURNS,
        Some(vec![item(
            1,
            0,
            "I read the harbour differently.",
            Some(answer(
                2,
                "mina",
                "MINA",
                "I meant the harbour, not the open sea.",
            )),
        )]),
        2,
    )
}

#[test]
fn the_conversation_follows_its_section_and_labels_who_wrote_what() {
    let files = build(&conversation_site());
    let html = page(&files);
    // The author's section carries its anchor; the other author's is anchored too.
    assert!(html.contains("id=\"ob-by-mina-0\""));
    assert!(html.contains("id=\"ob-by-joe-0\"") && html.contains("id=\"ob-by-mina-1\""));
    let section = turn(html, "ob-by-mina-0");
    // The conversation is inside her own turn, after her words, never before.
    let words = section.find(TURNS[0].1).unwrap();
    let aside = section.find("<aside class=\"ob-conversation\"").unwrap();
    assert!(words < aside, "the conversation never precedes the prose");
    assert!(section.contains("aria-labelledby=\"ob-conversation-ob-by-mina-0-title\""));
    assert!(section.contains(
        "<h3 id=\"ob-conversation-ob-by-mina-0-title\">Reader reflections on MINA’s section 1</h3>"
    ));
    // The landmark is named for its section, so two on a page never share a name.
    assert!(!html.contains("Reader reflections on this section"));
    // The reader's words and the author's are told apart by their headings,
    // their classes and their order, never by colour or position alone.
    let reader = section.find("Third Perspective from a reader").unwrap();
    let author = section.find("Author’s response from MINA").unwrap();
    assert!(aside < reader && reader < author);
    // The answer is nested in the reflection it answers, for reply semantics.
    let reflection = section.find("<article class=\"ob-perspective\"").unwrap();
    let reflection_end = section.rfind("</article>").unwrap();
    let response = section
        .find("<article class=\"ob-author-response\"")
        .unwrap();
    assert!(reflection < response && response < reflection_end);
    assert_eq!(section.matches("</article>").count(), 2);
    assert!(section.contains("<article class=\"ob-perspective\""));
    assert!(section.contains("<article class=\"ob-author-response\""));
    assert!(section.contains("Written by the author of the section this answers"));
    assert!(section.contains("<time datetime=\"2026-10-27\">2026-10-27</time>"));
    assert!(section.contains("I read the harbour differently."));
    assert!(section.contains("I meant the harbour, not the open sea."));
    // A reflection about another section is not under this one.
    assert!(!turn(html, "ob-by-joe-0").contains("ob-conversation"));
    // Report forms follow each, with their static fallback text.
    assert!(
        section.contains("subject=\"this reflection\"")
            && section.contains("subject=\"this response\"")
    );
    assert!(section.contains(&format!("item=\"{}\"", id(2))));
    // Shown once: the canonical section only points to it, with a link.
    let list = &html[html.find("id=\"ob-third-perspectives\"").unwrap()..];
    let list = &list[..list.find("</section>").unwrap()];
    assert!(!list.contains("I read the harbour differently."));
    assert!(list.contains(
        "<a href=\"#ob-conversation-ob-by-mina-0\">1 reflection about a section by MINA</a>"
    ));
    // And the page's own prose is untouched: removing the conversation and the
    // ids gives back the body.
    assert!(html.contains(TURNS[2].1) && html.contains(TURNS[1].1));
}

#[test]
fn every_id_is_unique_every_label_names_a_heading_and_headings_descend() {
    let files = build(&conversation_site());
    let html = page(&files);
    let ids = parse_ids(html);
    let unique: BTreeSet<&String> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len(), "duplicate ids: {ids:?}");
    for part in html.split("aria-labelledby=\"").skip(1) {
        let target = &part[..part.find('"').unwrap()];
        assert!(ids.iter().any(|id| id == target), "{target} names nothing");
    }
    let section = turn(html, "ob-by-mina-0");
    // The turn's heading is h2, then h3 (conversation), h4 (reflection), h5 (answer).
    let levels: Vec<char> = section
        .match_indices("<h")
        .filter_map(|(at, _)| {
            section[at + 2..]
                .chars()
                .next()
                .filter(char::is_ascii_digit)
        })
        .collect();
    assert_eq!(levels, ['2', '3', '4', '5']);
}

#[test]
fn hostile_text_is_escaped_everywhere_it_is_shown() {
    let hostile = "<img src=x onerror=alert(1)> & \"quotes\" <script>alert(2)</script>";
    let site = load(
        BOTH_OPEN,
        &TURNS,
        Some(vec![item(
            1,
            0,
            hostile,
            Some(answer(2, "mina", "MINA", hostile)),
        )]),
        2,
    );
    let files = build(&site);
    let html = page(&files);
    assert!(!html.contains("<img src=x"), "{html}");
    assert!(!html.contains("<script>alert"));
    assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;"));
    assert!(html.contains("&lt;script&gt;alert(2)&lt;/script&gt;"));
    // The author's name is the section's published name, escaped like any text.
    let mut bad = answer(2, "mina", "MINA", "ok");
    bad["author"] = json!("<b>MINA</b>");
    let refused = ThirdPerspectivesFile::from_json(
        &json!({"version": 2, "items": [item(1, 0, "x", Some(bad))]}).to_string(),
    );
    assert!(
        refused.is_ok(),
        "an angle bracket is plain text, escaped on output"
    );
}

#[test]
fn a_long_thread_is_bounded_and_the_rest_are_listed_once() {
    let total = MAX_IN_SECTION as u32 + 4;
    let items: Vec<Value> = (1..=total)
        .map(|n| {
            item(
                n * 2,
                0,
                &format!("Reflection number {n}."),
                (n == 1).then(|| answer(1000, "mina", "MINA", "One answer only.")),
            )
        })
        .collect();
    let site = load(BOTH_OPEN, &TURNS, Some(items), 2);
    let files = build(&site);
    let html = page(&files);
    let section = turn(html, "ob-by-mina-0");
    assert_eq!(
        section.matches("<article class=\"ob-perspective\"").count(),
        MAX_IN_SECTION
    );
    let list = &html[html.find("id=\"ob-third-perspectives\"").unwrap()..];
    let list = &list[..list.find("</section>").unwrap()];
    assert_eq!(
        list.matches("<article class=\"ob-perspective\"").count(),
        total as usize - MAX_IN_SECTION
    );
    // Each of them is on the page exactly once.
    for n in 1..=total {
        assert_eq!(
            html.matches(&format!("Reflection number {n}.")).count(),
            1,
            "{n}"
        );
    }
    // The pointer counts only what is shown after the section.
    assert!(list.contains(&format!(
        "{MAX_IN_SECTION} reflections about a section by MINA"
    )));
    // Oldest first, as the file orders them: nothing is ranked.
    assert!(
        section.find("Reflection number 1.").unwrap()
            < section.find("Reflection number 2.").unwrap()
    );
}

#[test]
fn a_changed_section_keeps_its_reflection_in_the_list_with_its_answer() {
    let edited = [("MINA", "Rewritten."), TURNS[1], TURNS[2]];
    let site = load(
        BOTH_OPEN,
        &edited,
        Some(vec![item(
            1,
            0,
            "I read the harbour differently.",
            Some(answer(2, "mina", "MINA", "I meant the harbour.")),
        )]),
        2,
    );
    let files = build(&site);
    let html = page(&files);
    // The text the reader read is gone: no section is pointed at, nothing is
    // retargeted, and the reflection stays in the list, say so, with its answer.
    assert!(!turn(html, "ob-by-mina-0").contains("ob-conversation"));
    let list = &html[html.find("id=\"ob-third-perspectives\"").unwrap()..];
    let list = &list[..list.find("</section>").unwrap()];
    assert!(list.contains("About a section by MINA, since changed or removed"));
    assert!(list.contains("I read the harbour differently."));
    assert!(list.contains("Author’s response from MINA"));
    assert!(!list.contains("href=\"#ob-by-"));
}

#[test]
fn an_answer_is_never_shown_where_its_kinds_are_not_shown() {
    let items = || {
        Some(vec![item(
            1,
            0,
            "I read the harbour differently.",
            Some(answer(2, "mina", "MINA", "I meant the harbour.")),
        )])
    };
    // Author responses off: no anchors, no conversation, no answer, and the
    // page is byte for byte what it is with no answer in the file.
    let off = build(&load(ANSWERS_OFF, &TURNS, items(), 2));
    let none = build(&load(
        ANSWERS_OFF,
        &TURNS,
        Some(vec![item(1, 0, "I read the harbour differently.", None)]),
        1,
    ));
    assert_eq!(page(&off), page(&none), "answers off is the page as it was");
    for gone in [
        "ob-by-",
        "ob-conversation",
        "ob-author-response",
        "I meant the harbour",
    ] {
        assert!(!page(&off).contains(gone), "{gone}");
    }
    assert!(page(&off).contains("I read the harbour differently."));
    // The reflection's own kind off hides everything under it, answer included.
    let hidden = build(&load(PERSPECTIVES_OFF, &TURNS, items(), 2));
    for gone in [
        "I read the harbour",
        "I meant the harbour",
        "ob-third-perspectives",
    ] {
        assert!(!page(&hidden).contains(gone), "{gone}");
    }
}

#[test]
fn a_post_with_no_file_or_no_answers_is_exactly_what_it_was() {
    // No third-perspectives file: where author responses are open each
    // author's section has its anchor (the form's own list names it), and
    // nothing else is added to the prose.
    let bare = build(&load(BOTH_OPEN, &TURNS, None, 1));
    assert!(page(&bare).contains("id=\"ob-by-mina-0\""));
    assert!(!page(&bare).contains("ob-conversation"));
    // Where they are off, the page has neither.
    let off = build(&load(ANSWERS_OFF, &TURNS, None, 1));
    assert!(!page(&off).contains("ob-by-mina-0"));
    // The reflection is there but unanswered: it follows its section without an answer.
    let unanswered = build(&load(
        BOTH_OPEN,
        &TURNS,
        Some(vec![item(1, 0, "I read the harbour differently.", None)]),
        1,
    ));
    let section = turn(page(&unanswered), "ob-by-mina-0");
    assert!(section.contains("Third Perspective from a reader"));
    assert!(!section.contains("ob-author-response"));
}

// ---------------------------------------------------------------------------
// Portable copies, feeds and llms files

#[test]
fn feeds_portable_copies_and_llms_files_carry_only_the_canonical_link() {
    let site = conversation_site();
    let files = build(&site);
    assert!(page(&files).contains("I meant the harbour, not the open sea."));
    for (path, contents) in &files {
        if path == "shared-tides/index.html" {
            continue;
        }
        for secret in [
            "I meant the harbour",
            "I read the harbour",
            "Author’s response",
            "ob-author-response",
            "ob-conversation",
            "Reader reflections on",
            "mina-admin",
            "p-mina",
            &id(2),
            &id(1),
        ] {
            assert!(!contents.contains(secret), "{secret} in {path}");
        }
    }
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let html = projection.portable_html().unwrap();
    let markdown = projection.portable_markdown().unwrap();
    for copy in [html.html.as_str(), markdown.as_str()] {
        for secret in [
            "I meant the harbour",
            "I read the harbour",
            "Author’s response",
            "ob-conversation",
        ] {
            assert!(!copy.contains(secret), "{secret}");
        }
    }
    assert!(
        html.html
            .contains("https://t.dev/shared-tides/#ob-third-perspectives"),
        "a portable copy links to the canonical reflections: {}",
        html.html
    );
    assert!(markdown.contains("https://t.dev/shared-tides/#ob-third-perspectives"));
    // The link's target exists on the canonical page even when every
    // reflection is shown after its own section.
    assert!(page(&files).contains("id=\"ob-third-perspectives\""));
    assert!(files["llms-full.txt"].contains("Third Perspectives"));
}

#[test]
fn a_nested_section_inside_a_turn_does_not_pull_the_conversation_ahead_of_the_words() {
    let quiz = "Before the quiz.

```quiz
Which pulls the tide?
- [x] The moon
- [ ] Cheese
```

After the quiz, the author's last words.";
    let turns = [("MINA", quiz), ("JOE", "It is also the sun.")];
    let site = load(
        BOTH_OPEN,
        &turns,
        Some(vec![item_in(
            &turns,
            1,
            0,
            "I read the harbour differently.",
            Some(answer(2, "mina", "MINA", "I meant the harbour.")),
        )]),
        2,
    );
    let files = build(&site);
    let html = page(&files);
    assert!(html.contains("class=\"ob-knowledge-check\""), "{html}");
    let start = html.find("id=\"ob-by-mina-0\"").unwrap();
    let conversation = html[start..]
        .find("<aside class=\"ob-conversation\"")
        .unwrap()
        + start;
    let last_words = html[start..].find("After the quiz").unwrap() + start;
    let check_close = html[start..].find("</ob-quiz>").unwrap() + start;
    assert!(
        check_close < last_words && last_words < conversation,
        "the conversation follows the whole turn, nested sections included"
    );
    // And it is still inside the turn, before the next author's.
    let next = html.find("id=\"ob-by-joe-0\"").unwrap();
    assert!(conversation < next);
}

#[test]
fn a_different_answer_is_refused_while_the_reflection_shows_one() {
    let mut file = ThirdPerspectivesFile::from_json(
        &json!({"version": 2, "items": [item(
            1, 0, "I read the harbour differently.",
            Some(answer(2, "mina", "MINA", "I meant the harbour.")),
        )]})
        .to_string(),
    )
    .unwrap();
    let other = |n: u32, body: &str| PublishedAnswer {
        id: id(n),
        contributor: "mina".into(),
        author: "MINA".into(),
        body: body.into(),
        received: "2026-10-26".into(),
        approved: "2026-10-27".into(),
    };
    let refused = file
        .set_answer(&id(1), other(3, "A second answer."))
        .unwrap_err();
    assert!(refused.contains("different answer"), "{refused}");
    assert_eq!(file.get(&id(1)).unwrap().answer.as_ref().unwrap().id, id(2));
    // The same answer, edited and approved again, is replaced in place.
    file.set_answer(&id(1), other(2, "I meant the harbour, truly."))
        .unwrap();
    assert_eq!(
        file.get(&id(1)).unwrap().answer.as_ref().unwrap().body,
        "I meant the harbour, truly."
    );
    // After take-off, another answer may be published.
    assert!(file.unpublish_answer(&id(2)));
    file.set_answer(&id(1), other(3, "A second answer."))
        .unwrap();
}

#[test]
fn the_pointers_follow_the_order_reflections_arrived_not_the_anchors_alphabet() {
    // MINA's section is written about first (n = 1), JOE's after (n = 2).
    let site = load(
        BOTH_OPEN,
        &TURNS,
        Some(vec![
            item(1, 0, "About the moon.", None),
            item(2, 1, "About the sun.", None),
        ]),
        1,
    );
    let files = build(&site);
    let html = page(&files);
    let joe = html.find("#ob-conversation-ob-by-joe-0").unwrap();
    let mina = html.find("#ob-conversation-ob-by-mina-0").unwrap();
    assert!(mina < joe, "first appearance, not alphabetical order");
}
