//! Approved media moments publish through the ordinary Post pipeline (ADR 0066, 0067): one public
//! projection, one frame rendered by the production renderer for the page and the preview,
//! resilient links and human-readable times, portable equivalents in every format checked by the
//! portable semantic facts, and nothing private (rights, rights notes, provenance, participant
//! ids, moment ids, seals, private or unapproved moments) in any public output.

use std::collections::BTreeMap;

use openblog_core::approval::ApprovalSet;
use openblog_core::assembly::{assemble, with_subject, Assembly, AssemblyError};
use openblog_core::collaboration::{
    AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference,
    Participant, SharedPublication, SourceKind,
};
use openblog_core::config::{SiteConfig, SyndicationProvider};
use openblog_core::contributor::Contributor;
use openblog_core::draft::DraftSet;
use openblog_core::feeds;
use openblog_core::media_moment::{
    MomentInput, MomentIntent, MomentSet, Quotation, QuotationProvenance, QuotationRights,
    RIGHTS_STATEMENT,
};
use openblog_core::model::{LoadOptions, Site, SourceFile, Sources};
use openblog_core::portability::{
    destination_content_plan, PortableProjection, RepresentationFormat,
};
use openblog_core::preview::{build as preview, render_section};
use openblog_core::published_moment::{moment_markdown, MomentsBlock, PublicMoment};
use openblog_core::reflection::ReflectionStructure;
use openblog_core::render;
use openblog_core::research_notes::{Locator, LocatorKind};
use openblog_core::synthesis::{NewSynthesisItem, SynthesisKind, SynthesisSet};
use openblog_core::theme::ThemeSet;

const T: i64 = 1_800_000_000;
const DATE: &str = "2030-01-31T09:00:00Z";
/// Participant ids are internal and must never be published, so they are distinctive here.
const ALL: [&str; 2] = ["pzqann", "pzqbo"];
const VIDEO: &str = "source-1";
const PODCAST: &str = "source-2";
const TALK: &str = "source-3";
const RIGHTS_NOTE: &str = "RIGHTSNOTE-SENTINEL permission emailed by the host";
const YOUTUBE_AT: &str = "https://www.youtube.com/watch?v=abcdefghijk&t=62s";

fn record() -> SharedPublication {
    let source = |kind, title: &str, url: &str| NewSourceReference {
        kind,
        title: title.into(),
        url: url.into(),
        ..NewSourceReference::default()
    };
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: "shared-0a1b2c3d4e5f".into(),
        title: "Attention, together".into(),
        guiding_question: "What did you notice?".into(),
        sources: vec![
            source(
                SourceKind::Video,
                "The Art of Noticing",
                "https://www.youtube.com/watch?v=abcdefghijk",
            ),
            source(
                SourceKind::Podcast,
                "Slow Radio, episode 12",
                "https://podcasts.example/slow-radio/12",
            ),
            source(SourceKind::Other, "A talk in the park", ""),
        ],
        creator: NewParticipant {
            admin_user: "ann-admin".into(),
            contributor_id: "ann".into(),
            display_name: "Ann Ames".into(),
        },
    })
    .unwrap();
    record.collaboration.participants[0].id = ALL[0].into();
    record.authorization.bindings[0].participant_id = ALL[0].into();
    record.collaboration.participants.push(Participant {
        id: ALL[1].into(),
        display_name: "Bo <Bee>".into(),
        profile_url: None,
    });
    record.authorization.bindings.push(IdentityBinding {
        admin_user: "bo-admin".into(),
        contributor_id: "bo".into(),
        participant_id: ALL[1].into(),
        roles: vec![AuthorizationRole::Contributor],
    });
    record
}

fn config_with_full_content(full: bool) -> SiteConfig {
    let mut config = SiteConfig::from_json(&format!(
        r#"{{"title":"T","url":"https://example.test","postPath":"/{{slug}}/","author":{{"name":"Site Owner"}},"feeds":{{"fullContent":{full}}}}}"#
    ))
    .unwrap();
    for (id, name) in [("ann", "Ann Ames"), ("bo", "Bo <Bee>")] {
        config.contributors.insert(
            id.into(),
            Contributor {
                name: name.into(),
                url: format!("https://example.org/{id}"),
                ..Contributor::default()
            },
        );
    }
    config
}

fn config() -> SiteConfig {
    config_with_full_content(true)
}

fn locator(kind: LocatorKind, value: &str, to: Option<&str>) -> Locator {
    Locator {
        kind,
        value: value.into(),
        to: to.map(str::to_string),
        extra: BTreeMap::new(),
    }
}

fn quotation(text: &str, speaker: Option<&str>, rights: QuotationRights) -> Quotation {
    Quotation {
        text: text.into(),
        speaker: speaker.map(str::to_string),
        language: None,
        rights,
        provenance: QuotationProvenance::Transcribed,
        rights_note: None,
    }
}

struct Fixture {
    record: SharedPublication,
    structure: Option<ReflectionStructure>,
    drafts: DraftSet,
    synthesis: SynthesisSet,
    moments: MomentSet,
    approvals: ApprovalSet,
}

impl Fixture {
    fn new() -> Self {
        let mut drafts = DraftSet::new(&ALL).unwrap();
        drafts.save(ALL[0], ALL[0], 0, "Ann words.", T).unwrap();
        drafts.save(ALL[1], ALL[1], 0, "Bo words.", T).unwrap();
        Self {
            record: record(),
            structure: None,
            drafts,
            synthesis: SynthesisSet::new(),
            moments: MomentSet::new(),
            approvals: ApprovalSet::new(),
        }
    }

    fn add(&mut self, who: &str, input: MomentInput) -> String {
        let revision = self.moments.revision();
        self.moments
            .add(who, &ALL, revision, &self.record.sources, input)
            .unwrap()
    }

    /// Three moments proposed for the piece and one private one:
    /// 1. Ann, the YouTube video at 62 seconds: a French quotation with a speaker, a rights note
    ///    and an observation with a link.
    /// 2. Bo, the podcast from 1:02:03 to 1:02:10: an observation only.
    /// 3. Ann, the talk with no address, chapter 3: a quotation without a speaker.
    /// 4. Bo, private: a quotation whose rights are unknown.
    fn with_moments() -> Self {
        let mut f = Self::new();
        let mut words = quotation(
            "Attention is the rarest\nand purest form of generosity.",
            Some("The host <b>"),
            QuotationRights::BriefQuotation,
        );
        words.language = Some("fr".into());
        words.rights_note = Some(RIGHTS_NOTE.into());
        f.add(
            ALL[0],
            MomentInput {
                source: VIDEO.into(),
                locators: vec![locator(LocatorKind::Timestamp, "62", None)],
                quotation: Some(words),
                observation: Some(
                    "I *noticed* the pause. See [my notes](https://example.org/notes).".into(),
                ),
                intent: MomentIntent::Publication,
            },
        );
        f.add(
            ALL[1],
            MomentInput {
                source: PODCAST.into(),
                locators: vec![locator(LocatorKind::Timestamp, "1:02:03", Some("3730"))],
                quotation: None,
                observation: Some("The host changes her mind here.".into()),
                intent: MomentIntent::Publication,
            },
        );
        f.add(
            ALL[0],
            MomentInput {
                source: TALK.into(),
                locators: vec![locator(LocatorKind::Chapter, "3", None)],
                quotation: Some(quotation("Look up.", None, QuotationRights::OwnWords)),
                observation: None,
                intent: MomentIntent::Publication,
            },
        );
        f.add(
            ALL[1],
            MomentInput {
                source: VIDEO.into(),
                locators: vec![locator(LocatorKind::Timestamp, "5", None)],
                quotation: Some(quotation(
                    "PRIVATE-QUOTE-SENTINEL",
                    Some("PRIVATE-SPEAKER-SENTINEL"),
                    QuotationRights::Unknown,
                )),
                observation: Some("PRIVATE-MOMENT-SENTINEL".into()),
                intent: MomentIntent::Private,
            },
        );
        // Both authors reveal; the seals are private state that must never be published.
        f.moments.seal(ALL[0], &ALL, 1).unwrap();
        f.moments.seal(ALL[1], &ALL, 1).unwrap();
        f
    }

    fn approve_all(&mut self) {
        for who in ALL {
            let seen = with_subject(
                &self.record,
                self.structure.as_ref(),
                &self.drafts,
                &self.synthesis,
                &self.moments,
                &ALL,
                |s| self.approvals.binding_for(s, who).unwrap(),
            );
            with_subject(
                &self.record,
                self.structure.as_ref(),
                &self.drafts,
                &self.synthesis,
                &self.moments,
                &ALL,
                |s| self.approvals.approve(who, who, s, &seen, true, T),
            )
            .unwrap();
        }
    }

    fn assemble(&self) -> Result<Assembly, AssemblyError> {
        assemble(
            &self.record,
            self.structure.as_ref(),
            &self.drafts,
            &self.synthesis,
            &self.moments,
            &self.approvals,
            &ALL,
            DATE,
        )
    }

    fn published(&mut self) -> Assembly {
        self.approve_all();
        self.assemble().unwrap()
    }
}

fn site_with(made: &Assembly, config: SiteConfig) -> Site {
    Site::load(
        config,
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

fn site(made: &Assembly) -> Site {
    site_with(made, config())
}

fn page_of(site: &Site) -> String {
    render::generate(site, &ThemeSet::new())
        .unwrap()
        .into_iter()
        .find(|file| file.path.ends_with("attention-together/index.html"))
        .expect("native page")
        .contents
}

fn body_of(source: &str) -> &str {
    source
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---\n"))
        .map_or(source, |(_, body)| body)
}

fn in_order(label: &str, haystack: &str, needles: &[&str]) {
    let mut from = 0;
    for needle in needles {
        let at = haystack[from..]
            .find(needle)
            .unwrap_or_else(|| panic!("{label}: `{needle}` missing or out of order\n{haystack}"));
        from += at + needle.len();
    }
}

#[test]
fn approved_moments_publish_after_the_piece_as_accessible_static_html() {
    let mut f = Fixture::with_moments();
    let made = f.published();
    let page = page_of(&site(&made));
    in_order(
        "page",
        &page,
        &[
            "Ann words.",
            "Bo words.",
            "<section class=\"ob-moments\" aria-labelledby=\"moments-in-the-sources\">",
            "<h2 id=\"moments-in-the-sources\">Moments in the sources</h2>",
            "<div class=\"ob-moment\" id=\"moments-in-the-sources-1\">",
            "<h3>The Art of Noticing (Video), at 1:02</h3>",
            "<p class=\"ob-moment-by\">Noted by Ann Ames</p>",
            "<figure class=\"ob-moment-quotation\">",
            "<blockquote lang=\"fr\"><p>Attention is the rarest<br>and purest form of generosity.</p></blockquote>",
            "<figcaption>The host &lt;b&gt;, in The Art of Noticing (Video), at 1:02</figcaption>",
            "<p class=\"ob-moment-link\"><a href=\"https://www.youtube.com/watch?v=abcdefghijk&amp;t=62s\">Open The Art of Noticing at 1:02</a></p>",
            "I <em>noticed</em> the pause.",
            "<div class=\"ob-moment\" id=\"moments-in-the-sources-2\">",
            "<h3>Slow Radio, episode 12 (Podcast), from 1:02:03 to 1:02:10</h3>",
            "Noted by Bo &lt;Bee&gt;",
            // Another provider keeps its original link, without a time it cannot honour.
            "<a href=\"https://podcasts.example/slow-radio/12\">Open Slow Radio, episode 12</a>",
            "The host changes her mind here.",
            "<div class=\"ob-moment\" id=\"moments-in-the-sources-3\">",
            "<h3>A talk in the park (Other), chapter 3</h3>",
            "<blockquote><p>Look up.</p></blockquote>",
            "<figcaption>A talk in the park (Other), chapter 3</figcaption>",
            "</section>",
        ],
    );
    // A source with no address keeps its title and location as text, with no link.
    let third = &page[page.find("moments-in-the-sources-3").unwrap()..];
    let third = &third[..third.find("</div>").unwrap()];
    assert!(
        !third.contains("<a ") && !third.contains("ob-moment-link"),
        "{third}"
    );
    // No player, frame, script or style: the moments read the same without JavaScript.
    let block = &page[page.find("class=\"ob-moments\"").unwrap()..];
    let block = &block[..block.find("</section>").unwrap()];
    for banned in [
        "<script",
        "<iframe",
        "<video",
        "<audio",
        "youtube.com/embed",
        "<style",
        "style=",
        "onclick",
        "javascript:",
        "<ob-",
    ] {
        assert!(!block.contains(banned), "moments carry `{banned}`");
    }
    // The block sits inside the post's prose, after everything else.
    let prose = page[..page.find("class=\"ob-moments\"").unwrap()]
        .rfind("class=\"ob-prose")
        .expect("inside .ob-prose");
    assert!(prose > 0);
    // The automatic summary is drawn from the sections only.
    assert_eq!(site(&made).posts[0].description, "Ann words. Bo words.");
}

#[test]
fn the_authors_prose_and_reading_order_are_unchanged_and_moment_free_pieces_are_byte_identical() {
    // A piece with no moments, and one with only private moments, publish byte for byte the same.
    let mut plain = Fixture::new();
    let without = plain.published();
    let mut private = Fixture::new();
    private.add(
        ALL[1],
        MomentInput {
            source: VIDEO.into(),
            locators: vec![locator(LocatorKind::Timestamp, "5", None)],
            quotation: None,
            observation: Some("PRIVATE-MOMENT-SENTINEL".into()),
            intent: MomentIntent::Private,
        },
    );
    let with_private = private.published();
    assert_eq!(without, with_private);
    assert!(!with_private.source.contains("PRIVATE-MOMENT-SENTINEL"));
    assert!(!with_private.source.contains("moments-in-the-sources"));

    // With published moments, everything before them is exactly the moment-free Post body.
    let mut f = Fixture::with_moments();
    let made = f.published();
    let body = body_of(&made.source);
    let block = MomentsBlock::parse(body).expect("the gate writes a block the reader recognises");
    assert_eq!(&body[..block.before], body_of(&without.source).trim_end());
    assert_eq!(made.credits, without.credits);
    assert_eq!(block.moments.len(), 3);
}

#[test]
fn private_and_unapproved_moments_never_appear() {
    let mut f = Fixture::with_moments();
    f.approve_all();
    // A moment edited after the approvals stales them: nothing is published.
    let revision = f.moments.revision();
    f.moments
        .edit(
            ALL[1],
            &ALL,
            revision,
            &f.record.sources,
            "moment-2",
            MomentInput {
                source: PODCAST.into(),
                locators: vec![locator(LocatorKind::Timestamp, "10", None)],
                quotation: None,
                observation: Some("UNAPPROVED-EDIT-SENTINEL".into()),
                intent: MomentIntent::Publication,
            },
        )
        .unwrap();
    assert!(matches!(f.assemble(), Err(AssemblyError::Blocked { .. })));
    // A moment proposed after the approvals stales them too.
    let mut g = Fixture::with_moments();
    g.approve_all();
    g.add(
        ALL[0],
        MomentInput {
            source: VIDEO.into(),
            locators: vec![locator(LocatorKind::Timestamp, "99", None)],
            quotation: None,
            observation: Some("LATE-MOMENT-SENTINEL".into()),
            intent: MomentIntent::Publication,
        },
    );
    assert!(matches!(g.assemble(), Err(AssemblyError::Blocked { .. })));
    // Once approved again, exactly the current moments publish, and the private one never does.
    f.approve_all();
    let made = f.assemble().unwrap();
    assert!(made.source.contains("UNAPPROVED-EDIT-SENTINEL"));
    assert!(!made.source.contains("The host changes her mind here."));
    for hidden in [
        "PRIVATE-MOMENT-SENTINEL",
        "PRIVATE-QUOTE-SENTINEL",
        "PRIVATE-SPEAKER-SENTINEL",
    ] {
        assert!(!made.source.contains(hidden), "{hidden}");
    }
}

/// Every value that must never be public, gathered from the private state itself.
fn sentinels(f: &Fixture) -> Vec<String> {
    let mut values: Vec<String> = [
        RIGHTS_NOTE,
        "RIGHTSNOTE-SENTINEL",
        "PRIVATE-MOMENT-SENTINEL",
        "PRIVATE-QUOTE-SENTINEL",
        "PRIVATE-SPEAKER-SENTINEL",
        "pzqann",
        "pzqbo",
        "ann-admin",
        "bo-admin",
        "shared-0a1b2c3d4e5f",
        "moment-1",
        "moment-2",
        "moment-3",
        "moment-4",
        "\"intent\"",
        "rightsNote",
        "rights note",
        "Rights note",
        "briefQuotation",
        "ownWords",
        "transcribed",
        "Transcribed from the media",
        QuotationRights::BriefQuotation.label(),
        QuotationRights::BriefQuotation.guidance(),
        QuotationRights::OwnWords.label(),
        RIGHTS_STATEMENT,
        "as the author states them",
        "provenance",
        "seal",
    ]
    .iter()
    .map(|value| value.to_string())
    .collect();
    let stored: serde_json::Value = serde_json::from_str(&f.moments.to_json()).unwrap();
    for seal in stored["seals"].as_array().unwrap() {
        values.push(seal["digest"].as_str().unwrap().to_string());
    }
    values.extend(
        f.moments
            .binding_frame(&f.record.sources)
            .into_iter()
            .skip(1),
    );
    values
}

fn assert_clean(label: &str, output: &str, sentinels: &[String]) {
    for value in sentinels {
        assert!(!output.contains(value.as_str()), "{label} leaked `{value}`");
    }
}

#[test]
fn no_rights_note_or_private_field_reaches_any_public_output() {
    let mut f = Fixture::with_moments();
    let made = f.published();
    let sentinels = sentinels(&f);
    assert!(sentinels.len() > 30);
    // The Post itself, then everything a build derives from it.
    assert_clean("post", &made.source, &sentinels);
    assert_clean("credits", &made.credits, &sentinels);
    for full in [true, false] {
        let site = site_with(&made, config_with_full_content(full));
        for file in render::generate(&site, &ThemeSet::new()).unwrap() {
            assert_clean(&file.path, &file.contents, &sentinels);
        }
        let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
        let html = projection.portable_html().unwrap();
        let outputs = [
            ("portable html", html.html.clone()),
            ("portable markdown", projection.portable_markdown().unwrap()),
            ("portable text", projection.portable_text().unwrap()),
            ("rss", feeds::rss(&site).unwrap()),
            ("json feed", feeds::json_feed(&site).unwrap()),
            ("llms", feeds::llms_index(&site).unwrap()),
            ("llms-full", feeds::llms_full(&site).unwrap()),
            ("search", feeds::search_index(&site)),
            ("sitemap", feeds::sitemap(&site, &[])),
            ("diagnostics", format!("{:?}", html.diagnostics)),
        ];
        for (label, output) in &outputs {
            assert_clean(label, output, &sentinels);
        }
        for provider in [
            SyndicationProvider::Dev,
            SyndicationProvider::Hashnode,
            SyndicationProvider::Ghost,
            SyndicationProvider::Wordpress,
            SyndicationProvider::Medium,
        ] {
            // The plan names the source file the CLI passes; the content is what is tested.
            let plan = destination_content_plan(provider, "posts/example.md", &html);
            assert!(plan.validate().is_ok(), "{provider:?}");
            assert_clean(
                &format!("{provider:?} plan"),
                &serde_json::to_string(&plan).unwrap(),
                &sentinels,
            );
        }
    }
}

#[test]
fn portable_forms_keep_attribution_order_and_timestamped_links_without_html() {
    let mut f = Fixture::with_moments();
    let made = f.published();
    let site = site(&made);
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let html = projection.portable_html().unwrap();
    // Portable HTML keeps the semantic frame, the language and the link.
    in_order(
        "portable html",
        &html.html,
        &[
            "<h2 id=\"moments-in-the-sources\">",
            "<blockquote lang=\"fr\">",
            "<figcaption>The host &lt;b&gt;, in The Art of Noticing (Video), at 1:02</figcaption>",
            "https://www.youtube.com/watch?v=abcdefghijk&amp;t=62s",
            "Slow Radio, episode 12 (Podcast), from 1:02:03 to 1:02:10",
            "A talk in the park (Other), chapter 3",
        ],
    );
    assert!(!html.has_raw_html, "the frame is open.blog's own markup");
    assert!(
        html.diagnostics.is_empty(),
        "plain moments lose no presentation: {:?}",
        html.diagnostics
    );
    // Markdown states the same facts as Markdown, never as HTML source.
    let markdown = projection.portable_markdown().unwrap();
    in_order(
        "portable markdown",
        &markdown,
        &[
            "Ann words.",
            "Bo words.",
            "## Moments in the sources {#moments-in-the-sources}",
            "### The Art of Noticing (Video), at 1:02 {#moments-in-the-sources-1}",
            "Noted by Ann Ames",
            "> Attention is the rarest\\\n> and purest form of generosity.",
            "\u{2014} The host \\<b\\>, in The Art of Noticing (Video), at 1:02",
            "[Open The Art of Noticing at 1:02](https://www.youtube.com/watch?v=abcdefghijk&t=62s)",
            "I *noticed* the pause. See [my notes](https://example.org/notes).",
            "{#moments-in-the-sources-2}",
            "Noted by Bo \\<Bee\\>",
            "[Open Slow Radio, episode 12](https://podcasts.example/slow-radio/12)",
            "### A talk in the park (Other), chapter 3 {#moments-in-the-sources-3}",
            "> Look up.",
            "\u{2014} A talk in the park (Other), chapter 3",
        ],
    );
    for forbidden in [
        "<section",
        "<div",
        "<figure",
        "<blockquote",
        "&#",
        "ob-moment",
    ] {
        assert!(
            !markdown.contains(forbidden),
            "markdown shows `{forbidden}`\n{markdown}"
        );
    }
    // Text keeps every fact, the link written out after its label.
    let text = projection.portable_text().unwrap();
    in_order(
        "portable text",
        &text,
        &[
            "Moments in the sources",
            "The Art of Noticing (Video), at 1:02",
            "Noted by Ann Ames",
            "Attention is the rarest",
            "and purest form of generosity.",
            "The host <b>, in The Art of Noticing (Video), at 1:02",
            &format!("Open The Art of Noticing at 1:02 ({YOUTUBE_AT})"),
            "Slow Radio, episode 12 (Podcast), from 1:02:03 to 1:02:10",
            "Noted by Bo <Bee>",
            "A talk in the park (Other), chapter 3",
            "Look up.",
        ],
    );
    assert!(!text.contains("<figure") && !text.contains("<br>"));
    // Feeds and llms-full carry them too; summary-only feeds carry none.
    let llms = feeds::llms_full(&site).unwrap();
    in_order(
        "llms-full",
        &llms,
        &[
            "Bo words.",
            "Moments in the sources",
            "Noted by Ann Ames",
            "The host <b>, in The Art of Noticing (Video), at 1:02",
            YOUTUBE_AT,
        ],
    );
    let rss = feeds::rss(&site).unwrap();
    assert!(rss.contains("<blockquote lang=\"fr\">") && rss.contains("Noted by Ann Ames"));
    let json: serde_json::Value = serde_json::from_str(&feeds::json_feed(&site).unwrap()).unwrap();
    let content_text = json["items"][0]["content_text"].as_str().unwrap();
    assert!(content_text.contains("Open The Art of Noticing at 1:02"));
    let summary = site_with(&made, config_with_full_content(false));
    for output in [
        feeds::rss(&summary).unwrap(),
        feeds::json_feed(&summary).unwrap(),
    ] {
        assert!(!output.contains("Moments in the sources") && !output.contains("Noted by"));
    }
}

#[test]
fn the_portable_semantic_check_fails_closed_when_a_moment_fact_is_lost_or_reordered() {
    let mut f = Fixture::with_moments();
    let made = f.published();
    let site = site(&made);
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let markdown = projection.portable_markdown().unwrap();
    let html = projection.portable_html().unwrap().html;
    let lost = |format, artifact: &str, field: &str| {
        let findings = projection
            .analyze_portable_artifact(format, artifact)
            .unwrap();
        assert!(
            findings
                .iter()
                .any(|finding| finding.code == "missing-semantic-fact"
                    && finding.context.affected_semantics.as_deref() == Some(field)),
            "{format:?} without the {field} was accepted: {findings:?}"
        );
    };
    assert!(projection
        .analyze_portable_artifact(RepresentationFormat::Markdown, &markdown)
        .unwrap()
        .is_empty());
    lost(
        RepresentationFormat::Markdown,
        &markdown.replace(
            "[Open The Art of Noticing at 1:02](https://www.youtube.com/watch?v=abcdefghijk&t=62s)",
            "",
        ),
        "source link",
    );
    lost(
        RepresentationFormat::Markdown,
        &markdown.replace("and purest form of generosity.", ""),
        "quotation",
    );
    lost(
        RepresentationFormat::Markdown,
        &markdown.replace(
            "\u{2014} The host \\<b\\>, in The Art of Noticing (Video), at 1:02",
            "",
        ),
        "quotation attribution",
    );
    lost(
        RepresentationFormat::Html,
        &html.replace("Noted by Bo &lt;Bee&gt;", "Noted by someone"),
        "moment author",
    );
    lost(
        RepresentationFormat::Text,
        &projection.portable_text().unwrap().replace(
            "Slow Radio, episode 12 (Podcast), from 1:02:03 to 1:02:10",
            "",
        ),
        "moment location",
    );
    // A copy that moves the last moment first says something other than what was approved.
    let third = markdown.find("### A talk in the park").unwrap();
    let moments_start = markdown.find("### The Art of Noticing").unwrap();
    let end = markdown[third..]
        .find("\n## ")
        .map_or(markdown.len(), |at| third + at);
    let reordered = format!(
        "{}{}\n\n{}{}",
        &markdown[..moments_start],
        markdown[third..end].trim_end(),
        &markdown[moments_start..third],
        &markdown[end..]
    );
    let findings = projection
        .analyze_portable_artifact(RepresentationFormat::Markdown, &reordered)
        .unwrap();
    assert!(
        findings
            .iter()
            .any(|finding| finding.code == "moment-order"),
        "{findings:?}"
    );
}

#[test]
fn the_preview_renders_each_moment_with_the_markup_the_page_publishes() {
    let mut f = Fixture::with_moments();
    // Both drafts are revealed, so each author reads the other's moments sealed to them.
    f.drafts
        .set_policy(openblog_core::draft::RevealPolicy::Voluntary);
    for who in ALL {
        f.drafts.mark_ready(who, 1, &ALL).unwrap();
    }
    f.approve_all();
    let config = config();
    let options = config.render_options();
    let shown = preview(
        &f.record,
        None,
        &f.drafts,
        &f.synthesis,
        &f.moments,
        &f.approvals,
        ALL[0],
        &ALL,
        true,
        options,
    )
    .unwrap();
    let page = page_of(&site(&f.assemble().unwrap()));
    let publication = f.moments.publication_moments();
    for (index, moment) in publication.iter().enumerate() {
        let public = PublicMoment::from_moment(moment, &f.record).unwrap();
        let rendered = render_section(&moment_markdown(&public, index + 1), options).html;
        assert!(
            shown.document.contains(&rendered),
            "preview of moment {index}"
        );
        assert!(
            page.contains(&rendered),
            "page and preview share one renderer"
        );
    }
    // The rights statement and note are review aids in the preview only.
    assert!(shown.document.contains(RIGHTS_NOTE));
    assert!(!page.contains("RIGHTSNOTE-SENTINEL"));
    assert!(!shown.document.contains("PRIVATE-MOMENT-SENTINEL"));
}

#[test]
fn untrusted_values_stay_text_and_unsafe_observations_or_anchors_refuse_the_piece() {
    // Hostile titles, names and words are escaped text in every form.
    let mut f = Fixture::new();
    f.record.sources[0].title = "<script>alert(1)</script> [x](javascript:alert(1)) *t*".into();
    f.record.collaboration.participants[0].display_name = "Ann <img src=x onerror=alert(1)>".into();
    f.add(
        ALL[0],
        MomentInput {
            source: VIDEO.into(),
            locators: vec![locator(LocatorKind::Timestamp, "62", None)],
            quotation: Some(quotation(
                "[click](javascript:alert(1)) <iframe src=x>\n1. not a list\n- nor this",
                Some("Dr <b>Host</b>"),
                QuotationRights::BriefQuotation,
            )),
            observation: None,
            intent: MomentIntent::Publication,
        },
    );
    // A source whose stored address is not a safe web address (however it got there) gives no
    // link: the moment keeps its title and location as text.
    f.record.sources[2].url = Some("javascript:alert(1)//https://example.org/".into());
    f.add(
        ALL[0],
        MomentInput {
            source: TALK.into(),
            locators: vec![locator(LocatorKind::Chapter, "1", None)],
            quotation: None,
            observation: Some("UNSAFE-SOURCE-MOMENT".into()),
            intent: MomentIntent::Publication,
        },
    );
    let made = f.published();
    let site = site(&made);
    let page = page_of(&site);
    let unsafe_moment = &page[page.find("moments-in-the-sources-2").unwrap()..];
    let unsafe_moment = &unsafe_moment[..unsafe_moment.find("</div>").unwrap()];
    assert!(unsafe_moment.contains("<h3>A talk in the park (Other), chapter 1</h3>"));
    assert!(unsafe_moment.contains("UNSAFE-SOURCE-MOMENT"));
    assert!(!unsafe_moment.contains("<a "), "{unsafe_moment}");
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    let markdown = projection.portable_markdown().unwrap();
    let mut rendered_markdown = String::new();
    pulldown_cmark::html::push_html(
        &mut rendered_markdown,
        pulldown_cmark::Parser::new_ext(&markdown, pulldown_cmark::Options::all()),
    );
    for (label, output) in [
        ("page", page.as_str()),
        (
            "portable html",
            projection.portable_html().unwrap().html.as_str(),
        ),
        ("portable markdown rendered", rendered_markdown.as_str()),
        ("rss", feeds::rss(&site).unwrap().as_str()),
    ] {
        for banned in [
            "<script>alert",
            "<img src=x",
            "<iframe src=x",
            "href=\"javascript",
            "<b>Host",
        ] {
            assert!(!output.contains(banned), "{label} carries `{banned}`");
        }
    }
    let moments = &rendered_markdown[rendered_markdown.find("Moments in the sources").unwrap()..];
    let moments = &moments[..moments.find("Contributions").unwrap_or(moments.len())];
    assert!(
        !moments.contains("<ol") && !moments.contains("<ul"),
        "{moments}"
    );

    // An observation whose reference definition would change a section refuses the piece.
    let mut g = Fixture::new();
    g.drafts
        .save(ALL[0], ALL[0], 1, "Ann cites [the talk].", T)
        .unwrap();
    g.add(
        ALL[1],
        MomentInput {
            source: VIDEO.into(),
            locators: vec![locator(LocatorKind::Timestamp, "1", None)],
            quotation: None,
            observation: Some("Mine.\n\n[the talk]: https://evil.example/".into()),
            intent: MomentIntent::Publication,
        },
    );
    g.approve_all();
    assert_eq!(g.assemble(), Err(AssemblyError::UnsafeMoment));

    // So does an observation that leaves a code fence open past its moment.
    let mut h = Fixture::new();
    h.add(
        ALL[1],
        MomentInput {
            source: VIDEO.into(),
            locators: vec![locator(LocatorKind::Timestamp, "1", None)],
            quotation: None,
            observation: Some("Mine.\n\n```\nopen".into()),
            intent: MomentIntent::Publication,
        },
    );
    h.approve_all();
    assert_eq!(h.assemble(), Err(AssemblyError::UnsafeMoment));

    // A section heading may not claim the moments' anchors.
    for heading in [
        "## Moments in the sources",
        "## Mine {#moments-in-the-sources-2}",
    ] {
        let mut k = Fixture::with_moments();
        k.drafts
            .save(ALL[0], ALL[0], 1, &format!("{heading}\n\nAnn words."), T)
            .unwrap();
        k.approve_all();
        assert_eq!(
            k.assemble(),
            Err(AssemblyError::ReservedSectionAnchor),
            "{heading}"
        );
    }
}

#[test]
fn an_arranged_reflection_with_a_conversation_and_moments_exports_everything_in_order() {
    let mut f = Fixture::with_moments();
    f.structure = Some(
        ReflectionStructure::from_json(
            r#"{"version":1,"revision":1,"layout":"sideBySide","rounds":[
                {"id":"r1","roundPrompt":"What stood out?","turns":[
                    {"draft":"pzqbo","part":0,"label":"Opening"},
                    {"draft":"pzqann","part":0}]}]}"#,
        )
        .unwrap(),
    );
    let revision = f.synthesis.revision();
    let item = f
        .synthesis
        .add(
            ALL[0],
            &ALL,
            revision,
            NewSynthesisItem {
                kind: SynthesisKind::Agreement,
                markdown: "We both slowed down.",
                others: &[ALL[1]],
            },
        )
        .unwrap();
    for who in ALL {
        let revision = f.synthesis.revision();
        f.synthesis
            .approve_item(who, &ALL, revision, &item)
            .unwrap();
    }
    let made = f.published();
    let needles = [
        "What stood out?",
        "Opening",
        "Bo words.",
        "Ann words.",
        "Continuing the conversation",
        "We both slowed down.",
        "Moments in the sources",
        "Noted by Ann Ames",
        "Attention is the rarest",
        "The host changes her mind here.",
        "Look up.",
    ];
    in_order("post body", body_of(&made.source), &needles);
    let site = site(&made);
    in_order("page", &page_of(&site), &needles);
    let projection = PortableProjection::from_post(&site.posts[0], &site.config).unwrap();
    in_order(
        "portable html",
        &projection.portable_html().unwrap().html,
        &needles,
    );
    let markdown = projection.portable_markdown().unwrap();
    in_order("portable markdown", &markdown, &needles);
    for forbidden in ["<div", "<section", "ob-turn", "ob-moment"] {
        assert!(
            !markdown.contains(forbidden),
            "markdown shows `{forbidden}`"
        );
    }
    in_order(
        "portable text",
        &projection.portable_text().unwrap(),
        &needles,
    );
    in_order("llms-full", &feeds::llms_full(&site).unwrap(), &needles);
    in_order("rss", &feeds::rss(&site).unwrap(), &needles);
}
