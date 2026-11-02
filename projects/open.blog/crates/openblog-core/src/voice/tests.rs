use super::*;
use crate::{LoadOptions, Site, SiteConfig, SourceFile, Sources};

const ROUGH_NAME: &str = "2026-10-28-a-mistake-i-made-rough.md";

fn rough() -> VoiceSample {
    VoiceSample {
        title: "A mistake I made".into(),
        subtitle: None,
        slug: "a-mistake-i-made".into(),
        date: "2026-10-28T09:30:00Z".into(),
        description: None,
        tags: Vec::new(),
        voice: VoiceMeta {
            catalog: 1,
            pack: "stories".into(),
            prompt: "a-mistake-i-made".into(),
            stage: VoiceStage::Rough,
            time_limit_seconds: 180,
            words: 5,
            rough_of: None,
        },
        body: "so i deleted the wrong folder".into(),
        extra: BTreeMap::new(),
    }
}

fn polished() -> VoiceSample {
    let mut sample = rough();
    sample.voice.stage = VoiceStage::Polished;
    sample.voice.time_limit_seconds = 0;
    sample.voice.rough_of = Some(ROUGH_NAME.into());
    sample.body = "I deleted the wrong folder.".into();
    sample.voice.words = 5;
    sample
}

fn full() -> VoiceSample {
    let mut sample = polished();
    sample.subtitle = Some("And what it taught me".into());
    sample.description = Some("A short story: with a colon".into());
    sample.tags = vec!["stories".into(), "rust".into()];
    sample
        .extra
        .insert("mood".into(), Value::Scalar("wry".into()));
    sample.body = "Línea uno — café ☕\n\nSecond paragraph.\n".into();
    sample
}

fn refused(result: Result<VoiceSample, String>) -> String {
    result.unwrap_err()
}

#[test]
fn a_valid_sample_round_trips_byte_for_byte() {
    for sample in [rough(), polished(), full()] {
        let text = sample.serialize().unwrap();
        let parsed = VoiceSample::parse(&text).unwrap();
        assert_eq!(parsed, sample);
        assert_eq!(parsed.serialize().unwrap(), text);
    }
}

#[test]
fn the_file_text_is_deterministic_and_canonical() {
    assert_eq!(
        rough().serialize().unwrap(),
        "---\ntitle: A mistake I made\nslug: a-mistake-i-made\ndate: 2026-10-28T09:30:00Z\nvoice.format: 1\nvoice.catalog: 1\nvoice.pack: stories\nvoice.prompt: a-mistake-i-made\nvoice.stage: rough\nvoice.timeLimitSeconds: 180\nvoice.words: 5\n---\n\nso i deleted the wrong folder\n"
    );
}

#[test]
fn crlf_input_is_read_as_lf_and_written_as_lf() {
    let text = rough().serialize().unwrap().replace('\n', "\r\n");
    let parsed = VoiceSample::parse(&text).unwrap();
    assert_eq!(parsed, rough());
    assert!(!parsed.serialize().unwrap().contains('\r'));
    let mut multi = rough();
    multi.body = "one\ntwo".into();
    let crlf = multi.serialize().unwrap().replace('\n', "\r\n");
    assert_eq!(VoiceSample::parse(&crlf).unwrap().body, "one\ntwo");
}

#[test]
fn non_ascii_text_and_trailing_blank_lines_survive() {
    let mut sample = rough();
    sample.body = "\n  indented, naïve, 日本語, emoji 🙂\n\n".into();
    let parsed = VoiceSample::parse(&sample.serialize().unwrap()).unwrap();
    assert_eq!(parsed.body, sample.body);
}

#[test]
fn non_utf8_is_refused() {
    let mut bytes = rough().serialize().unwrap().into_bytes();
    bytes.push(0xff);
    assert_eq!(
        VoiceSample::parse_bytes(&bytes).unwrap_err(),
        "The sample is not valid UTF-8 text."
    );
}

#[test]
fn unknown_keys_are_preserved_in_a_fixed_order() {
    let text = rough().serialize().unwrap().replace(
        "---\n\n",
        "zeta: last\nalpha: first\nvoice.future: yes\nlist:\n  - a\n  - b\n---\n\n",
    );
    let parsed = VoiceSample::parse(&text).unwrap();
    assert_eq!(parsed.extra.len(), 4);
    let again = parsed.serialize().unwrap();
    let alpha = again.find("alpha: first").unwrap();
    let list = again.find("list:").unwrap();
    let voice = again.find("voice.future").unwrap();
    let zeta = again.find("zeta: last").unwrap();
    assert!(alpha < list && list < voice && voice < zeta);
    assert_eq!(VoiceSample::parse(&again).unwrap(), parsed);
    assert_eq!(parsed.serialize().unwrap(), again);
}

#[test]
fn every_field_domain_is_checked_with_a_sentence_naming_the_field() {
    type Change = Box<dyn Fn(&mut VoiceSample)>;
    let cases: Vec<(Change, &str)> = vec![
        (Box::new(|s| s.title = "  ".into()), "`title`"),
        (Box::new(|s| s.title = "a\nb".into()), "`title`"),
        (Box::new(|s| s.title = "x".repeat(201)), "`title`"),
        (
            Box::new(|s| s.subtitle = Some("x".repeat(201))),
            "`subtitle`",
        ),
        (Box::new(|s| s.slug = "Not Kebab".into()), "`slug`"),
        (Box::new(|s| s.slug = "a--b".into()), "`slug`"),
        (Box::new(|s| s.date = "2026-10-28".into()), "`date`"),
        (Box::new(|s| s.date = "yesterday".into()), "`date`"),
        (
            Box::new(|s| s.description = Some("x".repeat(501))),
            "`description`",
        ),
        (Box::new(|s| s.tags = vec!["a,b".into()]), "tag"),
        (Box::new(|s| s.tags = vec![String::new()]), "tag"),
        (Box::new(|s| s.tags = vec!["t".into(); 21]), "`tags`"),
        (Box::new(|s| s.voice.catalog = 0), "`voice.catalog`"),
        (Box::new(|s| s.voice.catalog = 2), "newer"),
        (
            Box::new(|s| s.voice.pack = "Bad Pack".into()),
            "`voice.pack`",
        ),
        (Box::new(|s| s.voice.prompt = "".into()), "`voice.prompt`"),
        (
            Box::new(|s| s.voice.time_limit_seconds = 3601),
            "`voice.timeLimitSeconds`",
        ),
        (
            Box::new(|s| s.voice.time_limit_seconds = 0),
            "writing window",
        ),
        (Box::new(|s| s.body = " \n ".into()), "no text"),
        (Box::new(|s| s.body = "a\0b".into()), "null"),
        (
            Box::new(|s| {
                s.extra.insert("bad key".into(), Value::Scalar("x".into()));
            }),
            "An extra field",
        ),
        (
            Box::new(|s| {
                s.extra.insert("title".into(), Value::Scalar("x".into()));
            }),
            "`title`",
        ),
    ];
    for (change, expected) in cases {
        let mut sample = rough();
        change(&mut sample);
        let error = sample.validate().unwrap_err();
        assert!(error.contains(expected), "{error} should name {expected}");
        assert!(error.ends_with('.'), "{error}");
        assert!(sample.serialize().is_err());
    }
}

#[test]
fn polished_needs_a_matching_rough_and_a_rough_cannot_name_one() {
    let mut missing = polished();
    missing.voice.rough_of = None;
    assert!(missing.validate().unwrap_err().contains("`voice.roughOf`"));
    let mut named = rough();
    named.voice.rough_of = Some(ROUGH_NAME.into());
    assert!(named.validate().unwrap_err().contains("`voice.roughOf`"));
    for bad in [
        "../x-rough.md",
        "2026-10-28-a-mistake-i-made-polished.md",
        "2026-10-28-another-prompt-rough.md",
        "rough.md",
    ] {
        let mut sample = polished();
        sample.voice.rough_of = Some(bad.into());
        let message = sample.validate().unwrap_err();
        assert!(message.contains("`voice.roughOf`"));
        assert!(!message.contains(bad), "{message}");
    }
}

#[test]
fn unknown_stage_future_format_and_future_catalog_are_refused() {
    let text = rough().serialize().unwrap();
    let stage = refused(VoiceSample::parse(
        &text.replace("voice.stage: rough", "voice.stage: draft"),
    ));
    assert!(stage.contains("`voice.stage`") && !stage.contains("`draft`"));
    let format = refused(VoiceSample::parse(
        &text.replace("voice.format: 1", "voice.format: 2"),
    ));
    assert!(format.contains("format 2") && format.contains("Update open.blog"));
    let catalog = refused(VoiceSample::parse(
        &text.replace("voice.catalog: 1", "voice.catalog: 9"),
    ));
    assert!(catalog.contains("catalog 9"));
}

#[test]
fn missing_and_malformed_fields_are_named() {
    let text = rough().serialize().unwrap();
    for (line, field) in [
        ("title: A mistake I made\n", "`title`"),
        ("slug: a-mistake-i-made\n", "`slug`"),
        ("voice.format: 1\n", "`voice.format`"),
        ("voice.pack: stories\n", "`voice.pack`"),
        ("voice.words: 5\n", "`voice.words`"),
    ] {
        let error = refused(VoiceSample::parse(&text.replace(line, "")));
        assert!(error.contains(field), "{error}");
    }
    let error = refused(VoiceSample::parse(
        &text.replace("voice.words: 5", "voice.words: many"),
    ));
    assert!(error.contains("`voice.words`") && error.contains("whole number"));
    assert!(VoiceSample::parse("no front matter\n").is_err());
    assert!(VoiceSample::parse("---\ntitle: x\n")
        .unwrap_err()
        .contains("never closed"));
}

#[test]
fn an_oversize_file_is_refused() {
    let mut sample = rough();
    sample.body = "word ".repeat(MAX_FILE_BYTES / 4);
    assert!(sample.serialize().unwrap_err().contains("64 KiB"));
    assert!(VoiceSample::parse(&"x".repeat(MAX_FILE_BYTES + 1))
        .unwrap_err()
        .contains("64 KiB"));
}

#[test]
fn file_names_follow_the_day_prompt_and_stage() {
    assert_eq!(rough().file_name().unwrap(), ROUGH_NAME);
    assert_eq!(
        parse_file_name(ROUGH_NAME),
        Some(("2026-10-28", "a-mistake-i-made", VoiceStage::Rough))
    );
    assert_eq!(
        parse_file_name("2026-10-28-x-polished.md"),
        Some(("2026-10-28", "x", VoiceStage::Polished))
    );
    for bad in [
        "x-rough.md",
        "2026-10-28-rough.md",
        "2026-13-40-x-rough.md",
        "2026-10-28-X-rough.md",
        "2026-10-28-x-final.md",
        "2026-10-28-x-rough.txt",
    ] {
        assert!(parse_file_name(bad).is_none(), "{bad}");
    }
    assert_eq!(count_words("one  two\nthree"), 3);
}

fn site_with(markdown: &str, include_drafts: bool) -> Result<Site, Vec<String>> {
    let config = SiteConfig::from_json(
        r#"{"title":"T","url":"https://t.dev","theme":"base","postPath":"/{slug}/"}"#,
    )
    .unwrap();
    Site::load(
        config,
        Sources {
            posts: vec![SourceFile {
                path: "posts/draft.md".into(),
                contents: markdown.into(),
            }],
            ..Sources::default()
        },
        LoadOptions {
            include_drafts,
            ..LoadOptions::default()
        },
    )
    .map_err(|errors| errors.into_iter().map(|e| e.to_string()).collect())
}

#[test]
fn a_polished_sample_becomes_an_unpublished_post_draft_the_post_parser_accepts() {
    for sample in [polished(), full()] {
        let draft = sample.to_post_draft(&[]).unwrap();
        assert!(!draft.markdown.contains("voice"));
        assert!(!draft.markdown.contains("mood"));
        assert!(
            draft.markdown.contains("draft: \"true\"") || draft.markdown.contains("draft: true")
        );
        assert_eq!(draft.file_name, format!("2026-10-28-{}.md", sample.slug));
        assert!(site_with(&draft.markdown, false).unwrap().posts.is_empty());
        let site = site_with(&draft.markdown, true).unwrap();
        let post = &site.posts[0];
        assert!(post.draft);
        assert_eq!(post.title, sample.title);
        assert_eq!(post.slug, sample.slug);
    }
    let draft = full().to_post_draft(&[]).unwrap();
    assert!(draft.markdown.contains("subtitle: And what it taught me"));
    assert!(draft.markdown.ends_with("Second paragraph.\n"));
}

#[test]
fn a_sample_with_every_optional_field_absent_still_makes_a_post_draft() {
    let sample = polished();
    assert!(sample.subtitle.is_none() && sample.description.is_none() && sample.tags.is_empty());
    let draft = sample.to_post_draft(&[]).unwrap();
    assert!(draft.markdown.starts_with("---\n"));
    assert!(site_with(&draft.markdown, true).unwrap().posts.len() == 1);
}

#[test]
fn a_slug_collision_is_reported_and_a_rough_draft_never_becomes_a_post() {
    let error = polished()
        .to_post_draft(&["other", "a-mistake-i-made"])
        .unwrap_err();
    assert!(error.contains("`a-mistake-i-made`") && error.contains("already exists"));
    let error = rough().to_post_draft(&[]).unwrap_err();
    assert!(error.contains("polished"));
}

#[test]
fn a_refusal_never_repeats_text_from_the_file() {
    let base = "---\ntitle: A mistake I made\nslug: a-mistake-i-made\ndate: 2026-10-28T09:30:00Z\nvoice.format: 1\nvoice.catalog: 1\nvoice.pack: stories\nvoice.prompt: a-mistake-i-made\nvoice.stage: rough\nvoice.timeLimitSeconds: 180\nvoice.words: 5\n---\n\nso i deleted the wrong folder\n";
    let marker = "PRIVATE-MARKER-words-from-my-diary";
    let stage = base.replace("voice.stage: rough", &format!("voice.stage: {marker}"));
    let message = refused(VoiceSample::parse(&stage));
    assert!(
        message.contains("voice.stage") && !message.contains(marker),
        "{message}"
    );
    let long = format!("{marker} {}", "x".repeat(200));
    let tag = base.replace(
        "voice.words: 5\n",
        &format!("voice.words: 5\ntags: [{long}]\n"),
    );
    let message = refused(VoiceSample::parse(&tag));
    assert!(!message.contains(marker), "{message}");
}
