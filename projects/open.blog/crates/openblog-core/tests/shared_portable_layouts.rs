//! Every layout of a published reflection has a faithful static equivalent in portable HTML,
//! Markdown, text, RSS, JSON Feed and llms-full.txt (ADR 0033): the same prompts, authors,
//! labels and words in the same reading order, with no CSS, placeholder, part marker, layout
//! class in the plain forms, or private value, and hostile labels, prompts and names stay inert.

use openblog_core::approval::ApprovalSet;
use openblog_core::arrangement::Arrangement;
use openblog_core::assembly::{assemble, with_subject, Assembly};
use openblog_core::collaboration::{
    AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference,
    Participant, SharedPublication, SourceKind,
};
use openblog_core::config::SiteConfig;
use openblog_core::contributor::Contributor;
use openblog_core::draft::DraftSet;
use openblog_core::feeds;
use openblog_core::media_moment::MomentSet;
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::portability::{DiagnosticSeverity, PortableProjection};
use openblog_core::reflection::{
    compose, ComposedTurn, Placement, ReflectionLayout, ReflectionStructure, PART_MARKER,
};
use openblog_core::synthesis::SynthesisSet;
use openblog_core::theme::ThemeSet;
use pulldown_cmark::{Event, Parser, Tag};

const T: i64 = 1_800_000_000;
const DATE: &str = "2030-01-31T09:00:00Z";
const ALL: [&str; 3] = ["ann", "bo", "cy"];
const NAMES: [&str; 3] = ["Ann Ames", "Bo Bee", "Cy Cole"];

/// Values that must never appear in any public output.
const PRIVATE: &[&str] = &[
    "ann-admin",
    "bo-admin",
    "shared-0a1b2c3d4e5f",
    "invitation",
    "adminUser",
    "contributorId",
    ".openblog",
    "not shared with you",
];

fn record(names: [&str; 3]) -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: "shared-0a1b2c3d4e5f".into(),
        title: "Noticing, together".into(),
        guiding_question: "What did you notice?".into(),
        sources: vec![NewSourceReference {
            kind: SourceKind::Video,
            title: "The Art of Noticing".into(),
            url: "https://www.youtube.com/watch?v=abc123".into(),
            ..NewSourceReference::default()
        }],
        creator: NewParticipant {
            admin_user: "ann-admin".into(),
            contributor_id: "ann".into(),
            display_name: names[0].into(),
        },
    })
    .unwrap();
    record.collaboration.participants[0].id = "ann".into();
    record.authorization.bindings[0].participant_id = "ann".into();
    for (id, name) in [("bo", names[1]), ("cy", names[2])] {
        record.collaboration.participants.push(Participant {
            id: id.into(),
            display_name: name.into(),
            profile_url: None,
        });
        record.authorization.bindings.push(IdentityBinding {
            admin_user: format!("{id}-admin"),
            contributor_id: id.into(),
            participant_id: id.into(),
            roles: vec![AuthorizationRole::Contributor],
        });
    }
    record
}

fn config(names: [&str; 3]) -> SiteConfig {
    let mut config = SiteConfig::from_json(
        r#"{"title":"T","url":"https://example.test","postPath":"/{slug}/","author":{"name":"Site Owner"},"feeds":{"fullContent":true}}"#,
    )
    .unwrap();
    for (id, name) in ALL.iter().zip(names) {
        config.contributors.insert(
            (*id).into(),
            Contributor {
                name: name.into(),
                ..Contributor::default()
            },
        );
    }
    config
}

fn two(first: &str, second: &str) -> String {
    format!("{first}\n{PART_MARKER}\n{second}")
}

fn structure(layout: &str, labels: [&str; 2], prompts: [&str; 2]) -> ReflectionStructure {
    let json = |text: &str| serde_json::to_string(text).unwrap();
    ReflectionStructure::from_json(&format!(
        r#"{{"version":1,"revision":1,"layout":"{layout}","rounds":[
            {{"id":"r1","roundPrompt":{},"turns":[
                {{"draft":"ann","part":0,"label":{}}},
                {{"draft":"bo","part":0,"label":{}}},
                {{"draft":"cy","part":0}}]}},
            {{"id":"r2","roundPrompt":{},"turns":[{{"draft":"ann","part":1}},{{"draft":"bo","part":1}}]}}]}}"#,
        json(prompts[0]),
        json(labels[0]),
        json(labels[1]),
        json(prompts[1]),
    ))
    .unwrap()
}

fn publish(
    record: &SharedPublication,
    s: &ReflectionStructure,
    drafts: &[(&str, String)],
) -> Assembly {
    let mut set = DraftSet::new(&ALL).unwrap();
    for (who, text) in drafts {
        set.save(who, who, 0, text, T).unwrap();
    }
    let mut approvals = ApprovalSet::new();
    for who in ALL {
        let seen = with_subject(
            record,
            Some(s),
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &ALL,
            |subject| approvals.binding_for(subject, who).unwrap(),
        );
        with_subject(
            record,
            Some(s),
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &ALL,
            |subject| approvals.approve(who, who, subject, &seen, true, T),
        )
        .unwrap();
    }
    assemble(
        record,
        Some(s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap()
}

fn site(made: &Assembly, names: [&str; 3]) -> Site {
    Site::load(
        config(names),
        Sources {
            posts: vec![SourceFile {
                path: made.path.clone(),
                contents: made.source.clone(),
            }],
            credits: vec![SourceFile {
                path: made.credits_path.clone(),
                contents: made.credits.clone(),
            }],
            ..Default::default()
        },
        LoadOptions::default(),
    )
    .unwrap_or_else(|errors| panic!("{errors:?}"))
}

fn default_drafts() -> Vec<(&'static str, String)> {
    vec![
        ("ann", two("ANN-ONE", "ANN-TWO")),
        (
            "bo",
            two("BO-ONE with **bold** and\n\n```\n</section>\n```", "BO-TWO"),
        ),
        ("cy", "CY-ONE".to_string()),
    ]
}

/// Every needle appears, each after the one before it.
fn in_order(label: &str, haystack: &str, needles: &[&str]) {
    let mut from = 0;
    for needle in needles {
        let at = haystack[from..]
            .find(needle)
            .unwrap_or_else(|| panic!("{label}: `{needle}` missing or out of order\n{haystack}"));
        from += at + needle.len();
    }
}

const PROMPTS: [&str; 2] = ["What stood out?", "What now?"];
const LABELS: [&str; 2] = ["Opening", "Reply"];

/// The reading order every representation must keep.
fn reading() -> Vec<&'static str> {
    vec![
        PROMPTS[0], NAMES[0], LABELS[0], "ANN-ONE", NAMES[1], LABELS[1], "BO-ONE", "bold",
        NAMES[2], "CY-ONE", PROMPTS[1], NAMES[0], "ANN-TWO", NAMES[1], "BO-TWO",
    ]
}

fn plain_clean(label: &str, output: &str) {
    for forbidden in [
        "<div",
        "<section",
        "<h2",
        "ob-reflection",
        "ob-lane",
        "ob-turn",
        "ob-round",
        "openblog:part",
        "<!--",
        "raw HTML fragment",
    ] {
        assert!(
            !output.contains(forbidden),
            "{label} shows `{forbidden}`\n{output}"
        );
    }
}

fn clean(label: &str, output: &str) {
    let lower = output.to_ascii_lowercase();
    for needle in PRIVATE {
        assert!(
            !lower.contains(&needle.to_ascii_lowercase()),
            "{label} leaked `{needle}`"
        );
    }
    assert!(
        !output.contains("openblog:part"),
        "{label} has a part marker"
    );
}

/// A portable form carries no CSS and no script of its own.
fn no_css_or_script(label: &str, output: &str) {
    for forbidden in ["style=", "<style", "<script", "<link rel", "onclick"] {
        assert!(!output.contains(forbidden), "{label} has `{forbidden}`");
    }
}

fn markdown_links(markdown: &str) -> Vec<String> {
    Parser::new_ext(markdown, pulldown_cmark::Options::all())
        .filter_map(|event| match event {
            Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) => {
                Some(dest_url.to_string())
            }
            _ => None,
        })
        .collect()
}

#[test]
fn every_layout_has_a_faithful_static_equivalent_in_every_representation() {
    let record = record(NAMES);
    let mut first_markdown: Option<String> = None;
    let mut first_text: Option<String> = None;
    for layout in ReflectionLayout::ALL {
        let key = layout.key();
        let name = match layout {
            ReflectionLayout::Sequential => "sequential",
            ReflectionLayout::SideBySide => "sideBySide",
            ReflectionLayout::PointCounterpoint => "pointCounterpoint",
            ReflectionLayout::AlternatingDialogue => "alternatingDialogue",
            ReflectionLayout::Roundtable => "roundtable",
        };
        let made = publish(
            &record,
            &structure(name, LABELS, PROMPTS),
            &default_drafts(),
        );
        let site = site(&made, NAMES);
        let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
        let canonical = projection.canonical_url().to_string();
        let needles = reading();

        // Portable HTML: sections in order, each turn under its author's heading.
        let output = projection.portable_html().unwrap();
        in_order(&format!("{key} html"), &output.html, &needles);
        assert_eq!(
            output.html.matches("<h2 class=\"ob-turn-author\">").count(),
            5
        );
        assert_eq!(output.html.matches("<section").count(), 5);
        clean(&format!("{key} html"), &output.html);
        no_css_or_script(&format!("{key} html"), &output.html);
        // The layout is reported once as a placement the portable forms do not carry.
        let sequenced: Vec<_> = output
            .diagnostics
            .iter()
            .filter(|d| d.code == "reflection-layout-sequenced")
            .collect();
        if layout == ReflectionLayout::Sequential {
            assert!(sequenced.is_empty(), "{key}");
        } else {
            assert_eq!(sequenced.len(), 1, "{key}");
            assert_eq!(sequenced[0].severity, DiagnosticSeverity::Info);
            assert!(sequenced[0].message.contains(key));
        }

        // Markdown and text: real Markdown and real text, never the HTML shown as source.
        let markdown = projection.portable_markdown().unwrap();
        let text = projection.portable_text().unwrap();
        in_order(&format!("{key} markdown"), &markdown, &needles);
        in_order(&format!("{key} text"), &text, &needles);
        for (label, output) in [("markdown", &markdown), ("text", &text)] {
            plain_clean(&format!("{key} {label}"), output);
            clean(&format!("{key} {label}"), output);
        }
        assert!(markdown.contains("**bold**") && markdown.contains("</section>"));
        assert!(markdown.contains(&format!("Canonical: <{canonical}>")));
        assert!(markdown.contains("Guiding question: What did you notice?"));
        // The layout changes how the page places turns, not what a portable copy says.
        assert_eq!(
            markdown,
            *first_markdown.get_or_insert_with(|| markdown.clone()),
            "{key}"
        );
        assert_eq!(
            text,
            *first_text.get_or_insert_with(|| text.clone()),
            "{key}"
        );

        // RSS: creators, and the full content in order.
        let rss = feeds::rss(&site).unwrap();
        in_order(
            &format!("{key} rss creators"),
            &rss,
            &[
                "<dc:creator>Ann Ames</dc:creator>",
                "<dc:creator>Bo Bee</dc:creator>",
                "<dc:creator>Cy Cole</dc:creator>",
            ],
        );
        let encoded = &rss[rss.find("<content:encoded>").unwrap()..];
        in_order(&format!("{key} rss content"), encoded, &needles);
        clean(&format!("{key} rss"), &rss);
        no_css_or_script(&format!("{key} rss"), &rss);

        // JSON Feed: html and text both complete and in order.
        let feed: serde_json::Value =
            serde_json::from_str(&feeds::json_feed(&site).unwrap()).unwrap();
        let item = &feed["items"][0];
        in_order(
            &format!("{key} json html"),
            item["content_html"].as_str().unwrap(),
            &needles,
        );
        let json_text = item["content_text"].as_str().unwrap();
        in_order(&format!("{key} json text"), json_text, &needles);
        plain_clean(&format!("{key} json text"), json_text);
        assert_eq!(json_text, text, "{key}");
        assert_eq!(item["url"], canonical.as_str());

        // llms-full.txt: prompts, names, labels and words, in order.
        let llms = feeds::llms_full(&site).unwrap();
        in_order(&format!("{key} llms"), &llms, &needles);
        plain_clean(&format!("{key} llms"), &llms);
        clean(&format!("{key} llms"), &llms);

        // The native page still arranges the same turns, so nothing portable invented a turn.
        let files = openblog_core::render::generate(&site, &ThemeSet::new()).unwrap();
        let page = &files
            .iter()
            .find(|file| file.path.ends_with("noticing-together/index.html"))
            .unwrap()
            .contents;
        assert!(page.contains(&format!("ob-reflection-{key}")));
        assert_eq!(page.matches("<section class=\"ob-turn").count(), 5);
        for file in &files {
            clean(&file.path, &file.contents);
        }
    }
}

#[test]
fn an_author_with_nothing_written_leaves_no_trace_in_any_equivalent() {
    let record = record(NAMES);
    let made = publish(
        &record,
        &structure("pointCounterpoint", LABELS, PROMPTS),
        &[("ann", two("ANN-ONE", "ANN-TWO")), ("cy", "CY-ONE".into())],
    );
    let site = site(&made, NAMES);
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    for (label, output) in [
        ("html", projection.portable_html().unwrap().html),
        ("markdown", projection.portable_markdown().unwrap()),
        ("text", projection.portable_text().unwrap()),
        ("llms", feeds::llms_full(&site).unwrap()),
        ("rss", feeds::rss(&site).unwrap()),
    ] {
        assert!(
            !output.contains("Bo Bee") && !output.contains(LABELS[1]),
            "{label}"
        );
        assert!(output.contains("CY-ONE"), "{label}");
        clean(label, &output);
    }
}

fn hostile_names() -> [&'static str; 3] {
    ["Ann [n](javascript:alert(1))", "Bo Bee", "Cy Cole"]
}

#[test]
fn a_hostile_label_prompt_or_name_stays_inert_text_in_every_representation() {
    let label = "Point [l](javascript:alert(1)) ![i](https://evil.example/x.png) *em* `c` <b>";
    let prompt = "Why? [p](https://evil.example/p) **x** _y_ ~z~ # h | t | &amp; <i>";
    let record = record(hostile_names());
    let s = structure("sideBySide", [label, "Reply"], [prompt, "What now?"]);
    let made = publish(&record, &s, &default_drafts());
    let site = site(&made, hostile_names());

    // The page builds and shows the text, not a link, an image or a tag.
    let files = openblog_core::render::generate(&site, &ThemeSet::new())
        .expect("a hostile label must not break the build");
    for file in &files {
        assert!(
            !file.contents.contains("href=\"javascript"),
            "{}",
            file.path
        );
        assert!(
            !file.contents.contains("href=\"https://evil"),
            "{}",
            file.path
        );
        assert!(
            !file.contents.contains("src=\"https://evil"),
            "{}",
            file.path
        );
        if file.path.ends_with(".html") || file.path.ends_with(".xml") {
            assert!(!file.contents.contains("<b>"), "{}", file.path);
        }
    }
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let html = projection.portable_html().unwrap().html;
    assert!(!html.contains("href=\"javascript") && !html.contains("<b>"));
    assert!(!html.contains("href=\"https://evil") && !html.contains("src=\"https://evil"));

    let markdown = projection.portable_markdown().unwrap();
    // No active link or image except the canonical address and the source's own.
    assert_eq!(
        markdown_links(&markdown),
        [
            "https://example.test/noticing-together/",
            "https://www.youtube.com/watch?v=abc123"
        ],
        "{markdown}"
    );
    let text = projection.portable_text().unwrap();
    // Markdown shows the angle brackets escaped; text shows them as the words they are.
    assert!(!markdown.contains("<b>") && !markdown.contains("<i>"));
    // The words themselves survive, as text.
    for needle in [
        "[l](javascript:alert(1))",
        "![i](https://evil.example/x.png)",
        "[p](https://evil.example/p)",
        "Ann [n](javascript:alert(1))",
        "<b>",
        "&amp;",
    ] {
        assert!(text.contains(needle), "text lost `{needle}`\n{text}");
    }
    let llms = feeds::llms_full(&site).unwrap();
    assert!(llms.contains("[l](javascript:alert(1))"));
}

#[test]
fn the_composed_arrangement_never_lets_markdown_in_a_label_become_live() {
    let hostile = "Point [l](javascript:alert(1)) *x* _y_ `z` ! \\ ~ # | & @ http://e.example";
    let turns = [ComposedTurn {
        round: 0,
        round_prompt: Some(hostile),
        display_name: hostile,
        label: Some(hostile),
        placement: Placement { lane: 0, lanes: 1 },
        body: "words".into(),
    }];
    let composed = compose(ReflectionLayout::Sequential, &turns);
    // As raw HTML nothing in the three values is Markdown-significant, so showing the block as
    // literal Markdown (the portable export) cannot turn it into a link.
    for line in composed.lines().filter(|l| l.contains("class=\"ob-turn-")) {
        let inner = &line[line.find('>').unwrap() + 1..line.rfind("</").unwrap()];
        // Numeric references are the escape itself: take them out, then nothing may remain.
        let mut stripped = String::new();
        let mut rest = inner;
        while let Some(at) = rest.find("&#") {
            stripped.push_str(&rest[..at]);
            rest = &rest[rest.find(';').unwrap() + 1..];
        }
        stripped.push_str(rest);
        let inner = stripped.as_str();
        for significant in [
            '[', ']', '(', ')', '*', '_', '`', '!', '\\', '~', '#', '|', '@',
        ] {
            assert!(!inner.contains(significant), "`{significant}` in {inner}");
        }
        assert!(!inner.contains(':') && !inner.contains('<'));
    }
    let shown = Arrangement::parse(&composed).expect("compose output reads back");
    assert_eq!(shown.rounds[0].prompt.as_deref(), Some(hostile));
    assert_eq!(shown.rounds[0].turns[0].author, hostile);
    assert_eq!(shown.rounds[0].turns[0].label.as_deref(), Some(hostile));
}

#[test]
fn only_what_compose_writes_is_read_back_as_an_arrangement() {
    let turns = [
        ComposedTurn {
            round: 0,
            round_prompt: Some("Q"),
            display_name: "A",
            label: Some("L"),
            placement: Placement { lane: 0, lanes: 2 },
            body: "one\n\n```\n</section>\n```".into(),
        },
        ComposedTurn {
            round: 1,
            round_prompt: None,
            display_name: "B",
            label: None,
            placement: Placement { lane: 1, lanes: 2 },
            body: "two".into(),
        },
    ];
    let composed = compose(ReflectionLayout::SideBySide, &turns);
    let read = Arrangement::parse(&composed).unwrap();
    assert_eq!(read.layout, ReflectionLayout::SideBySide);
    assert_eq!(read.rounds.len(), 2);
    assert_eq!(read.rounds[0].turns[0].body, "one\n\n```\n</section>\n```");
    assert_eq!(read.rounds[1].prompt, None);
    // Anything outside the grammar is not an arrangement, so it keeps the ordinary handling.
    for bad in [
        composed.replace("<h2 class=\"ob-turn-author\">A</h2>", "<h2>A</h2>"),
        composed.replace("ob-reflection-side-by-side", "ob-reflection-diagonal"),
        composed.replace("one", "one <script>x</script>"),
        format!("intro\n\n{composed}"),
        format!("{composed}\ntrailing words\n"),
        composed.replace(
            "<section class=\"ob-turn ob-lane-0\">",
            "<section onclick=\"x\">",
        ),
        composed.replace(">L</p>", ">&copy;</p>"),
        "plain text".to_string(),
    ] {
        assert!(Arrangement::parse(&bad).is_none(), "{bad}");
    }
}

#[test]
fn a_tampered_equivalent_with_reordered_or_missing_turns_is_refused() {
    use openblog_core::portability::RepresentationFormat;
    let record = record(NAMES);
    let made = publish(
        &record,
        &structure("sequential", LABELS, PROMPTS),
        &default_drafts(),
    );
    let site = site(&made, NAMES);
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let html = projection.portable_html().unwrap().html;
    let markdown = projection.portable_markdown().unwrap();
    // The credits repeat every name, so they must not satisfy a missing or moved heading.
    assert!(markdown.contains("Contributions") && html.contains("Cy Cole"));
    for (format, artifact) in [
        (RepresentationFormat::Html, &html),
        (RepresentationFormat::Markdown, &markdown),
    ] {
        assert!(projection
            .analyze_portable_artifact(format, artifact)
            .unwrap()
            .is_empty());
    }
    let heading = |format: RepresentationFormat, name: &str| match format {
        RepresentationFormat::Html => format!("<h2 class=\"ob-turn-author\">{name}</h2>"),
        _ => format!("## {name}"),
    };
    for (format, artifact) in [
        (RepresentationFormat::Html, html),
        (RepresentationFormat::Markdown, markdown),
    ] {
        let ann = heading(format, "Ann Ames");
        let bo = heading(format, "Bo Bee");
        let swapped = artifact
            .replacen(&ann, "@@A@@", 1)
            .replacen(&bo, &ann, 1)
            .replacen("@@A@@", &bo, 1);
        let dropped = artifact.replacen(&bo, "", 1);
        let last = artifact.rfind(&bo).unwrap();
        let dropped_last = format!("{}{}", &artifact[..last], &artifact[last + bo.len()..]);
        for (what, tampered) in [
            ("swapped", swapped),
            ("dropped", dropped),
            ("dropped last", dropped_last),
        ] {
            assert_ne!(tampered, artifact, "{format:?} {what}");
            let findings = projection
                .analyze_portable_artifact(format, &tampered)
                .unwrap();
            assert!(
                findings
                    .iter()
                    .any(|f| f.code == "reflection-order" || f.code == "missing-semantic-fact"),
                "{format:?} {what} was accepted"
            );
        }
    }
}

#[test]
fn a_layout_frame_is_not_reported_as_authored_raw_html_for_a_markdown_destination() {
    use openblog_core::portability::{destination_content_plan, destination_policies};
    let record = record(NAMES);
    let made = publish(
        &record,
        &structure("sideBySide", LABELS, PROMPTS),
        &default_drafts(),
    );
    let site = site(&made, NAMES);
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let output = projection.portable_html().unwrap();
    assert!(!output.has_raw_html, "the frame is the layout's own markup");
    for policy in destination_policies() {
        let plan = destination_content_plan(policy.provider, "posts/work.md", &output);
        assert!(
            !plan
                .diagnostics
                .iter()
                .any(|d| d.code == "destination-raw-html-literal"),
            "{:?}",
            policy.provider
        );
    }
}
