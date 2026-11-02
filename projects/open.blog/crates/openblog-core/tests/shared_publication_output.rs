//! A published shared reflection reaches the native page, portable HTML/Markdown/text, RSS and
//! JSON Feed with every author's section in order, every author credited consistently, the shared
//! source attributed, and nothing private (ADR 0023).

use openblog_core::approval::ApprovalSet;
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
use openblog_core::portability::PortableProjection;
use openblog_core::render;
use openblog_core::synthesis::SynthesisSet;
use openblog_core::theme::ThemeSet;

const T: i64 = 1_800_000_000;
const DATE: &str = "2030-01-31T09:00:00Z";
const ALL: [&str; 3] = ["ann", "bo", "cy"];
const NAMES: [&str; 3] = ["Ann Ames", "Bo <Bee> & Co", "Cy \"Quote\" Cole"];
const SECRET_OLD: &str = "OLDSECRETREVISION";

/// Values that must never appear in any public output.
const PRIVATE: &[&str] = &[
    "ann-admin",
    "bo-admin",
    "cy-admin",
    "shared-0a1b2c3d4e5f",
    SECRET_OLD,
    "invitation",
    "approval",
    "approved",
    "revision",
    "reveal",
    "participant",
    "adminUser",
    "contributorId",
    "contributionId",
    "digest",
    ".openblog",
    "C:\\Users",
    "/home/",
];

fn record_titled(title: &str) -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: "shared-0a1b2c3d4e5f".into(),
        title: title.into(),
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
            display_name: NAMES[0].into(),
        },
    })
    .unwrap();
    record.collaboration.participants[0].id = "ann".into();
    record.authorization.bindings[0].participant_id = "ann".into();
    for (id, name) in [("bo", NAMES[1]), ("cy", NAMES[2])] {
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

fn config() -> SiteConfig {
    config_with_full_content(true)
}

fn config_with_full_content(full: bool) -> SiteConfig {
    let mut config = SiteConfig::from_json(&format!(
        r#"{{"title":"T","url":"https://example.test","postPath":"/{{slug}}/","author":{{"name":"Site Owner"}},"feeds":{{"fullContent":{full}}}}}"#
    ))
    .unwrap();
    for (id, name) in ALL.iter().zip(NAMES) {
        config.contributors.insert(
            (*id).into(),
            Contributor {
                name: name.into(),
                url: format!("https://example.org/{id}"),
                ..Contributor::default()
            },
        );
    }
    config
}

fn approved(texts: &[(&str, &str)]) -> Assembly {
    approved_titled("Noticing, together", texts)
}

fn approved_titled(title: &str, texts: &[(&str, &str)]) -> Assembly {
    let record = record_titled(title);
    let mut set = DraftSet::new(&ALL).unwrap();
    for (who, text) in texts {
        if *who == "bo" {
            // An earlier revision that is then replaced: it must never be published.
            set.save("bo", "bo", 0, SECRET_OLD, T).unwrap();
            set.save("bo", "bo", 1, text, T + 1).unwrap();
        } else {
            set.save(who, who, 0, text, T + 1).unwrap();
        }
    }
    let mut approvals = ApprovalSet::new();
    for who in ALL {
        let seen = with_subject(
            &record,
            None,
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &ALL,
            |s| approvals.binding_for(s, who).unwrap(),
        );
        with_subject(
            &record,
            None,
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &ALL,
            |s| approvals.approve(who, who, s, &seen, true, T),
        )
        .unwrap();
    }
    assemble(
        &record,
        None,
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap()
}

fn site(made: &Assembly) -> Site {
    Site::load(
        config(),
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

fn clean(label: &str, output: &str) {
    let lower = output.to_ascii_lowercase();
    for needle in PRIVATE {
        assert!(
            !lower.contains(&needle.to_ascii_lowercase()),
            "{label} leaked `{needle}`"
        );
    }
}

fn in_order(label: &str, output: &str, needles: &[&str]) {
    let mut from = 0;
    for needle in needles {
        let at = output[from..]
            .find(needle)
            .unwrap_or_else(|| panic!("{label} lost or reordered `{needle}`"));
        from += at + needle.len();
    }
}

const SECTIONS: [&str; 3] = [
    "Ann noticed the light.",
    "Bo noticed the **sound** of rain.",
    "Our shared conclusion: slow down.",
];

#[test]
fn every_section_author_and_the_source_reach_every_representation_in_order() {
    let made = approved(&[
        ("ann", SECTIONS[0]),
        ("bo", SECTIONS[1]),
        ("cy", SECTIONS[2]),
    ]);
    let site = site(&made);
    let post = &site.posts[0];
    let projection = PortableProjection::from_post(post, &site.config).unwrap();
    let canonical = projection.canonical_url().to_string();
    assert!(
        canonical.starts_with("https://example.test/"),
        "{canonical}"
    );

    let files = render::generate(&site, &ThemeSet::new()).unwrap();
    let page = &files
        .iter()
        .find(|file| file.path.ends_with("noticing-together/index.html"))
        .expect("native page")
        .contents;
    in_order(
        "page",
        page,
        &[
            "Ann noticed the light.",
            "<strong>sound</strong>",
            "Our shared conclusion: slow down.",
        ],
    );
    assert!(page.contains("Guiding question:") && page.contains("The Art of Noticing"));
    for file in &files {
        clean(&file.path, &file.contents);
    }

    let html = projection.portable_html().unwrap().html;
    let markdown = projection.portable_markdown().unwrap();
    let text = projection.portable_text().unwrap();
    in_order(
        "html",
        &html,
        &["Ann noticed", "sound", "shared conclusion"],
    );
    in_order(
        "markdown",
        &markdown,
        &["Ann noticed", "**sound**", "shared conclusion"],
    );
    in_order(
        "text",
        &text,
        &["Ann noticed", "sound", "shared conclusion"],
    );
    for (label, output) in [("html", &html), ("markdown", &markdown), ("text", &text)] {
        assert!(output.contains("The Art of Noticing"), "{label}");
        assert!(output.contains("What did you notice?"), "{label}");
        clean(label, output);
    }

    // RSS: one dc:creator per author in section order, full content in order, canonical link.
    let rss = feeds::rss(&site).unwrap();
    in_order(
        "rss creators",
        &rss,
        &[
            "<dc:creator>Ann Ames</dc:creator>",
            "<dc:creator>Bo &lt;Bee&gt; &amp; Co</dc:creator>",
            "Cole</dc:creator>",
        ],
    );
    assert!(!rss.contains("Site Owner</dc:creator>"));
    assert!(rss.contains(&format!("<link>{canonical}</link>")));
    well_formed_xml(&rss);
    assert!(page.contains(&format!("<link rel=\"canonical\" href=\"{canonical}\">")));
    assert!(markdown.contains(&format!("Canonical: <{canonical}>")));
    in_order(
        "rss content",
        &rss,
        &["Ann noticed", "sound", "shared conclusion"],
    );
    clean("rss", &rss);

    // JSON Feed: parsed, authors ordered and equal to the RSS creators, canonical id and url.
    let json = feeds::json_feed(&site).unwrap();
    let feed: serde_json::Value = serde_json::from_str(&json).unwrap();
    let item = &feed["items"][0];
    assert_eq!(item["url"], canonical.as_str());
    assert_eq!(item["id"], canonical.as_str());
    let authors: Vec<&str> = item["authors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(authors, NAMES);
    assert_eq!(item["authors"][1]["url"], "https://example.org/bo");
    in_order(
        "json html",
        item["content_html"].as_str().unwrap(),
        &["Ann noticed", "sound", "shared conclusion"],
    );
    in_order(
        "json text",
        item["content_text"].as_str().unwrap(),
        &["Ann noticed", "sound", "shared conclusion"],
    );
    clean("json feed", &json);

    for (label, output) in [
        ("llms-full", feeds::llms_full(&site).unwrap()),
        ("llms", feeds::llms_index(&site).unwrap()),
        ("sitemap", feeds::sitemap(&site, &[])),
        ("search", feeds::search_index(&site)),
    ] {
        clean(label, &output);
    }
}

#[test]
fn an_author_who_wrote_nothing_is_not_credited_in_any_feed() {
    let made = approved(&[("ann", SECTIONS[0]), ("cy", SECTIONS[2])]);
    let site = site(&made);
    let rss = feeds::rss(&site).unwrap();
    assert!(rss.contains("Ann Ames") && rss.contains("Cole</dc:creator>"));
    assert!(!rss.contains("Bee"));
    let json = feeds::json_feed(&site).unwrap();
    assert!(!json.contains("Bee"));
    clean("rss", &rss);
    clean("json feed", &json);
}

#[test]
fn a_replaced_revision_never_publishes_and_markup_shown_as_code_stays_text() {
    let made = approved(&[
        ("ann", "Ann says ]]> and `<b>` and & more."),
        ("bo", "Bo words"),
        ("cy", "Cy: [safe](https://example.org/a?x=1&y=2)"),
    ]);
    let site = site(&made);
    let rss = feeds::rss(&site).unwrap();
    clean("rss", &rss);
    assert!(!rss.contains("<b>"));
    let json: serde_json::Value = serde_json::from_str(&feeds::json_feed(&site).unwrap()).unwrap();
    let html = json["items"][0]["content_html"].as_str().unwrap();
    assert!(html.contains("&lt;b&gt;") && !html.contains("<b>"));
    for file in render::generate(&site, &ThemeSet::new()).unwrap() {
        clean(&file.path, &file.contents);
        if file.path.ends_with(".html") {
            assert!(!file.contents.contains("<b>"), "{}", file.path);
        }
    }
}

/// A small well-formedness check (no XML dependency): balanced tags, closed CDATA and comments,
/// no bare `<`, and only the five predefined or numeric entities.
fn well_formed_xml(xml: &str) {
    let mut stack: Vec<String> = Vec::new();
    let mut rest = xml;
    while let Some(at) = rest.find(['<', '&']) {
        let (_, here) = rest.split_at(at);
        if let Some(entity) = here.strip_prefix('&') {
            let end = entity.find(';').expect("unterminated entity");
            let name = &entity[..end];
            assert!(
                matches!(name, "amp" | "lt" | "gt" | "quot" | "apos")
                    || name.strip_prefix('#').is_some_and(|n| !n.is_empty()),
                "bad entity &{name};"
            );
            rest = &entity[end + 1..];
        } else if let Some(cdata) = here.strip_prefix("<![CDATA[") {
            rest = &cdata[cdata.find("]]>").expect("unterminated CDATA") + 3..];
        } else if let Some(comment) = here.strip_prefix("<!--") {
            rest = &comment[comment.find("-->").expect("unterminated comment") + 3..];
        } else if let Some(pi) = here.strip_prefix("<?") {
            rest = &pi[pi.find("?>").expect("unterminated declaration") + 2..];
        } else {
            let end = here.find('>').expect("unterminated tag");
            let tag = &here[1..end];
            assert!(!tag.contains('<'), "bare `<` in {tag}");
            if let Some(name) = tag.strip_prefix('/') {
                assert_eq!(
                    stack.pop().as_deref(),
                    Some(name.trim()),
                    "mismatched close"
                );
            } else if !tag.ends_with('/') {
                stack.push(tag.split_whitespace().next().unwrap().to_string());
            }
            rest = &here[end + 1..];
        }
    }
    assert!(stack.is_empty(), "unclosed tags {stack:?}");
}

#[test]
fn rss_stays_well_formed_with_hostile_content() {
    let made = approved(&[
        ("ann", "Ann says ]]> and `<b>` and & more."),
        ("bo", "Bo words"),
        ("cy", "Cy words"),
    ]);
    well_formed_xml(&feeds::rss(&site(&made)).unwrap());
}

#[test]
fn a_hostile_title_never_becomes_markup_in_any_output() {
    let title = "Hi <img src=x onerror=alert(1)> & more";
    let made = approved_titled(title, &[("ann", "A"), ("bo", "B"), ("cy", "C")]);
    let site = site(&made);
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let markdown = projection.portable_markdown().unwrap();
    assert!(!markdown.contains(" <img"), "{markdown}");
    assert!(markdown.starts_with(r"# Hi \<img"), "{markdown}");
    for file in render::generate(&site, &ThemeSet::new()).unwrap() {
        if file.path.ends_with(".html") || file.path.ends_with(".xml") {
            assert!(!file.contents.contains("<img src=x"), "{}", file.path);
        }
    }
    let rss = feeds::rss(&site).unwrap();
    assert!(!rss.contains("<img src=x"));
    well_formed_xml(&rss);
    // JSON Feed titles are plain text by spec; the HTML content must not carry the tag.
    let json: serde_json::Value = serde_json::from_str(&feeds::json_feed(&site).unwrap()).unwrap();
    assert!(!json["items"][0]["content_html"]
        .as_str()
        .unwrap()
        .contains("<img src=x"));
}

#[test]
fn summary_only_feeds_carry_an_excerpt_and_no_private_values() {
    let made = approved(&[
        ("ann", SECTIONS[0]),
        ("bo", SECTIONS[1]),
        ("cy", SECTIONS[2]),
    ]);
    let site = Site::load(
        config_with_full_content(false),
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
    .unwrap_or_else(|errors| panic!("{errors:?}"));
    let rss = feeds::rss(&site).unwrap();
    well_formed_xml(&rss);
    assert!(rss.contains("Ann noticed"));
    assert!(rss.contains("<dc:creator>Ann Ames</dc:creator>"));
    clean("rss", &rss);
    clean("json feed", &feeds::json_feed(&site).unwrap());
}

#[test]
fn an_arranged_reflection_reaches_every_representation_in_reading_order_without_the_marker() {
    use openblog_core::reflection::{ReflectionStructure, PART_MARKER};
    let record = record_titled("Noticing, together");
    let mut set = DraftSet::new(&ALL).unwrap();
    set.save(
        "ann",
        "ann",
        0,
        &format!("ANNONE\n{PART_MARKER}\nANNTWO"),
        T,
    )
    .unwrap();
    set.save("bo", "bo", 0, "BOONE", T).unwrap();
    set.save("cy", "cy", 0, "CYONE", T).unwrap();
    // Cy first, then Ann's two parts around Bo.
    let structure = ReflectionStructure::from_json(
        r#"{"version":1,"revision":1,"layout":"sideBySide","rounds":[
            {"id":"r1","roundPrompt":"First impressions","turns":[{"draft":"cy","part":0},{"draft":"ann","part":0}]},
            {"id":"r2","turns":[{"draft":"bo","part":0},{"draft":"ann","part":1}]}]}"#,
    )
    .unwrap();
    let mut approvals = ApprovalSet::new();
    for who in ALL {
        let seen = with_subject(
            &record,
            Some(&structure),
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &ALL,
            |s| approvals.binding_for(s, who).unwrap(),
        );
        with_subject(
            &record,
            Some(&structure),
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &ALL,
            |s| approvals.approve(who, who, s, &seen, true, T),
        )
        .unwrap();
    }
    let made = assemble(
        &record,
        Some(&structure),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    let site = site(&made);
    let post = &site.posts[0];
    let projection = PortableProjection::from_post(post, &site.config).unwrap();
    let files = render::generate(&site, &ThemeSet::new()).unwrap();
    let page = &files
        .iter()
        .find(|file| file.path.ends_with("noticing-together/index.html"))
        .expect("native page")
        .contents;
    let reading = ["CYONE", "ANNONE", "BOONE", "ANNTWO"];
    in_order("page", page, &reading);
    assert!(page.contains("ob-reflection-side-by-side"));
    assert!(page.contains("First impressions"));
    for file in &files {
        clean(&file.path, &file.contents);
        assert!(!file.contents.contains("openblog:part"), "{}", file.path);
    }
    let html = projection.portable_html().unwrap().html;
    let markdown = projection.portable_markdown().unwrap();
    let text = projection.portable_text().unwrap();
    for (label, output) in [("html", &html), ("markdown", &markdown), ("text", &text)] {
        in_order(label, output, &reading);
        in_order(label, output, &["Cy", "Ann Ames"]);
        assert!(!output.contains("openblog:part"), "{label}");
        clean(label, output);
    }
    let rss = feeds::rss(&site).unwrap();
    in_order("rss", &rss, &reading);
    in_order(
        "rss creators",
        &rss,
        &[
            "Cole</dc:creator>",
            "<dc:creator>Ann Ames</dc:creator>",
            "<dc:creator>Bo &lt;Bee&gt; &amp; Co</dc:creator>",
        ],
    );
    clean("rss", &rss);
    let json = feeds::json_feed(&site).unwrap();
    in_order("json feed", &json, &reading);
    clean("json feed", &json);
}
