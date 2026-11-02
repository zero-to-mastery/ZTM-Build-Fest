//! The participation registry, its site and post settings, and how comments
//! and B5's interim feedback rule map onto it (ADR 0101).

use openblog_core::model::CommentsPolicy;
use openblog_core::participation::{
    effective_mode, manifest, ParticipationKind, ParticipationMode, PostParticipation, SiteSetting,
};
use openblog_core::{generate, LoadOptions, Site, SiteConfig, SourceFile, Sources, ThemeSet};

const HOSTED: &str = r#""engagement":{"enabled":true,"endpoint":"https://t.dev/api"}"#;

fn config(extra: &str) -> SiteConfig {
    let separator = if extra.is_empty() { "" } else { "," };
    SiteConfig::from_json(&format!(
        r#"{{"title":"T","url":"https://t.dev","postPath":"/{{slug}}/"{separator}{extra}}}"#
    ))
    .unwrap()
}

fn config_error(extra: &str) -> String {
    SiteConfig::from_json(&format!(r#"{{"title":"T","url":"https://t.dev",{extra}}}"#)).unwrap_err()
}

fn post(front_matter: &str) -> String {
    format!("---\ntitle: P\ndate: 2026-01-01\n{front_matter}---\nText")
}

fn site(config: SiteConfig, posts: &[(&str, String)]) -> Result<Site, String> {
    Site::load(
        config,
        Sources {
            posts: posts
                .iter()
                .map(|(path, contents)| SourceFile {
                    path: (*path).into(),
                    contents: contents.clone(),
                })
                .collect(),
            ..Sources::default()
        },
        LoadOptions::default(),
    )
    .map_err(|errors| {
        errors.join(
            "
",
        )
    })
}

fn entries(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn output<'a>(files: &'a [openblog_core::OutputFile], path: &str) -> Option<&'a str> {
    files
        .iter()
        .find(|file| file.path == path)
        .map(|file| file.contents.as_str())
}

#[test]
fn the_registry_is_closed_and_ids_round_trip() {
    let ids: Vec<_> = ParticipationKind::ALL
        .iter()
        .map(|kind| kind.id())
        .collect();
    assert_eq!(
        ids,
        [
            "comment",
            "question",
            "source-suggestion",
            "correction-suggestion",
            "alternative-interpretation",
            "third-perspective",
            "author-response",
            "abuse-report",
            "future-suggestion",
        ]
    );
    for kind in ParticipationKind::ALL {
        assert_eq!(ParticipationKind::from_id(kind.id()), Some(kind));
        // The stored kind shape of ADR 0080 (hosted feedback table).
        let id = kind.id();
        assert!(id.len() <= 40 && id.starts_with(|c: char| c.is_ascii_lowercase()));
        assert!(id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
    }
    assert_eq!(ParticipationKind::from_id("Comment"), None);
    assert_eq!(ParticipationKind::from_id("vote"), None);
    // Only abuse reports and future suggestions are never public (a
    // suggestion's approval admits it to the editors' queue, ADR 0152); only
    // authors write responses.
    for kind in ParticipationKind::ALL {
        let rules = kind.rules();
        assert_eq!(
            rules.publishable,
            !matches!(
                kind,
                ParticipationKind::AbuseReport | ParticipationKind::FutureSuggestion
            )
        );
        assert_eq!(rules.editorial, kind == ParticipationKind::FutureSuggestion);
        assert_eq!(
            rules.origin == openblog_core::participation::Origin::Author,
            kind == ParticipationKind::AuthorResponse
        );
    }
}

#[test]
fn every_kind_beyond_comments_is_off_by_default_and_the_config_file_is_unchanged() {
    let default = SiteConfig::default();
    assert!(default.participation.is_default());
    assert!(!default.to_json().contains("participation"));
    for kind in ParticipationKind::ALL {
        assert_eq!(default.participation.setting(kind), SiteSetting::Off);
    }
    let hosted = config(HOSTED);
    assert!(!hosted.to_json().contains("participation"));
    let site = site(
        hosted.clone(),
        &[(
            "posts/a.md",
            post("participation: [question: open, third-perspective: open]\n"),
        )],
    )
    .unwrap();
    for kind in ParticipationKind::ALL {
        let expected = if kind == ParticipationKind::Comment {
            ParticipationMode::Open
        } else {
            ParticipationMode::Hidden
        };
        assert_eq!(
            effective_mode(&hosted, &site.posts[0], kind),
            expected,
            "{kind}"
        );
    }
    assert_eq!(manifest(&site), None);
}

#[test]
fn site_settings_parse_by_kind_id_and_round_trip() {
    let parsed = config(&format!(
        r#"{HOSTED},"participation":{{"kinds":{{"question":"open","third-perspective":"hidden","source-suggestion":"follow-comments","abuse-report":"open"}},"retention":{{"pendingDays":60}}}}"#
    ));
    let kinds = &parsed.participation;
    assert_eq!(
        kinds.setting(ParticipationKind::Question),
        SiteSetting::Open
    );
    assert_eq!(
        kinds.setting(ParticipationKind::ThirdPerspective),
        SiteSetting::Hidden
    );
    assert_eq!(
        kinds.setting(ParticipationKind::SourceSuggestion),
        SiteSetting::FollowComments
    );
    assert_eq!(
        kinds.setting(ParticipationKind::AbuseReport),
        SiteSetting::Open
    );
    assert_eq!(
        kinds.setting(ParticipationKind::CorrectionSuggestion),
        SiteSetting::Off
    );
    let retention = kinds.retention.expect("retention was set");
    assert_eq!(retention.pending_days, 60);
    assert_eq!(retention.audit_days, 365);
    let again = SiteConfig::from_json(&parsed.to_json()).unwrap();
    assert_eq!(again.participation, parsed.participation);
}

/// Retention left unset keeps comments out of it; naming it, even as `{}`,
/// opts comments in and is written back (ADR 0104).
#[test]
fn retention_is_unset_by_default_and_naming_it_opts_comments_in() {
    use openblog_core::moderation::{ModerationPolicy, RetentionPolicy};

    let unchanged = config(HOSTED);
    assert_eq!(unchanged.participation.retention, None);
    let policy = ModerationPolicy::from_config(&unchanged);
    assert_eq!(policy, ModerationPolicy::default());
    assert_eq!(policy.retention, RetentionPolicy::default());
    assert!(!policy.comment_retention);

    // Switching a kind on does not opt comments in either.
    let kinds = config(&format!(
        r#"{HOSTED},"participation":{{"kinds":{{"question":"open"}}}}"#
    ));
    assert!(!ModerationPolicy::from_config(&kinds).comment_retention);

    let explicit = config(&format!(r#"{HOSTED},"participation":{{"retention":{{}}}}"#));
    assert_eq!(
        explicit.participation.retention,
        Some(RetentionPolicy::default())
    );
    let policy = ModerationPolicy::from_config(&explicit);
    assert!(policy.comment_retention);
    assert_eq!(policy.retention, RetentionPolicy::default());
    assert!(explicit.to_json().contains(r#""retention""#));
    let again = SiteConfig::from_json(&explicit.to_json()).unwrap();
    assert_eq!(again.participation, explicit.participation);
}

#[test]
fn invalid_site_settings_are_refused_with_a_named_field() {
    let cases = [
        (
            r#""participation":{"kinds":{"vote":"open"}}"#,
            "unknown participation kind `vote`",
        ),
        (
            r#""participation":{"kinds":{"comment":"open"}}"#,
            "comments keep `engagement.comments`",
        ),
        (
            r#""participation":{"kinds":{"abuse-report":"locked"}}"#,
            "abuse-report must be `off` or `open`",
        ),
        (
            r#""participation":{"kinds":{"abuse-report":"follow-comments"}}"#,
            "abuse-report must be `off` or `open`",
        ),
        (
            r#""participation":{"kinds":{"question":"maybe"}}"#,
            "unknown variant",
        ),
        (r#""participation":{"moderators":[]}"#, "unknown field"),
        (
            r#""participation":{"retention":{"pendingDays":0}}"#,
            "retention.pendingDays must be between 1 and 3650",
        ),
        (
            r#""participation":{"retention":{"closedDays":3651}}"#,
            "retention.closedDays must be between 1 and 3650",
        ),
        (
            r#""participation":{"retention":{"closedDays":90,"auditDays":30}}"#,
            "auditDays must be at least closedDays",
        ),
        (
            r#""participation":{"retention":{"forever":true}}"#,
            "unknown field",
        ),
    ];
    for (json, expected) in cases {
        let error = config_error(json);
        assert!(error.contains(expected), "{json}: {error}");
        assert!(error.starts_with("invalid openblog.json"), "{error}");
    }
}

#[test]
fn post_front_matter_names_kinds_as_a_block_or_an_inline_list() {
    let site = site(
        config(""),
        &[
            (
                "posts/block.md",
                post("participation:\n  - question: open\n  - third-perspective: LOCKED\n"),
            ),
            (
                "posts/inline.md",
                post("participation: [author-response: hidden, source-suggestion: open]\n"),
            ),
            ("posts/single.md", post("participation: question: locked\n")),
            ("posts/none.md", post("")),
        ],
    )
    .unwrap();
    let find = |slug: &str| site.posts.iter().find(|post| post.slug == slug).unwrap();
    let block = &find("block").participation;
    assert_eq!(
        block.get(ParticipationKind::Question),
        Some(ParticipationMode::Open)
    );
    assert_eq!(
        block.get(ParticipationKind::ThirdPerspective),
        Some(ParticipationMode::Locked)
    );
    let inline = &find("inline").participation;
    assert_eq!(
        inline.get(ParticipationKind::AuthorResponse),
        Some(ParticipationMode::Hidden)
    );
    assert_eq!(
        inline.get(ParticipationKind::SourceSuggestion),
        Some(ParticipationMode::Open)
    );
    assert_eq!(
        find("single")
            .participation
            .get(ParticipationKind::Question),
        Some(ParticipationMode::Locked)
    );
    assert!(find("none").participation.is_empty());
}

#[test]
fn invalid_post_settings_are_refused() {
    let cases = [
        (&["question"][..], "participation entries are `kind: mode`"),
        (&["vote: open"][..], "unknown participation kind `vote`"),
        (&["comment: open"][..], "set comments with `comments:`"),
        (
            &["abuse-report: open"][..],
            "abuse reports are set for the whole site",
        ),
        (
            &["question: sometimes"][..],
            "must be `open`, `locked`, or `hidden`",
        ),
        (
            &["question: open", "question: hidden"][..],
            "participation names `question` twice",
        ),
    ];
    for (values, expected) in cases {
        let error = PostParticipation::parse(&entries(values)).unwrap_err();
        assert!(error.contains(expected), "{values:?}: {error}");
    }
    let error = site(
        config(""),
        &[("posts/bad.md", post("participation: [vote: open]\n"))],
    )
    .unwrap_err();
    assert!(error.contains("unknown participation kind"), "{error}");
}

/// The comment row of the policy reproduces the rule pages used before it:
/// hosted engagement on, `engagement.comments` on, an endpoint, and the
/// post's `comments:` setting.
#[test]
fn existing_comment_settings_keep_their_meaning() {
    for enabled in [false, true] {
        for comments in [false, true] {
            for endpoint in ["", "https://t.dev/api"] {
                let json = format!(
                    r#""engagement":{{"enabled":{enabled},"comments":{comments},"endpoint":"{endpoint}"}}"#
                );
                // An enabled engagement needs an endpoint to load at all.
                let Ok(config) = SiteConfig::from_json(&format!(
                    r#"{{"title":"T","url":"https://t.dev",{json}}}"#
                )) else {
                    assert!(enabled && endpoint.is_empty());
                    continue;
                };
                for (value, policy) in [
                    ("", CommentsPolicy::Open),
                    ("comments: open\n", CommentsPolicy::Open),
                    ("comments: locked\n", CommentsPolicy::Locked),
                    ("comments: hidden\n", CommentsPolicy::Hidden),
                    ("comments: false\n", CommentsPolicy::Hidden),
                ] {
                    let site = site(config.clone(), &[("posts/a.md", post(value))]).unwrap();
                    let post = &site.posts[0];
                    assert_eq!(post.comments, policy);
                    let before = if enabled && comments && !endpoint.is_empty() {
                        policy.into()
                    } else {
                        ParticipationMode::Hidden
                    };
                    assert_eq!(
                        effective_mode(&config, post, ParticipationKind::Comment),
                        before,
                        "{json} {value}"
                    );
                }
            }
        }
    }
}

/// The discussion section of a generated post page, exactly as written, or
/// `None` when the page has no comments element at all.
fn discussion(page: &str) -> Option<&str> {
    let start = page.find("<section id=\"ob-discussion\"")?;
    let end = start + page[start..].find("</section>\n")? + "</section>\n".len();
    Some(&page[start..end])
}

/// The comment manifest and every post's `<ob-comments>` element, generated
/// for representative configurations and compared byte for byte with what
/// builds wrote before the participation policy existed. Switching new kinds
/// on, or setting retention, changes neither, nor any post page.
#[test]
fn generated_comment_output_is_byte_for_byte_what_it_was() {
    let posts = [
        ("posts/a.md", post("")),
        ("posts/b.md", post("comments: locked\n")),
        ("posts/c.md", post("comments: hidden\n")),
        ("posts/d.md", post("comments: false\n")),
    ];
    let all_hidden = r#"{"/a/":"hidden","/b/":"hidden","/c/":"hidden","/d/":"hidden"}"#;
    let by_post = r#"{"/a/":"open","/b/":"locked","/c/":"hidden","/d/":"hidden"}"#;
    let open_a = "<section id=\"ob-discussion\" aria-label=\"Discussion\"><ob-comments path=\"/a/\" endpoint=\"https://t.dev/api\"><p>Comments require JavaScript.</p></ob-comments></section>\n";
    let locked_b = "<section id=\"ob-discussion\" aria-label=\"Discussion\"><ob-comments path=\"/b/\" endpoint=\"https://t.dev/api\" mode=\"locked\"><p>Comments require JavaScript.</p></ob-comments></section>\n";
    let hosted = r#""engagement":{"enabled":true,"endpoint":"https://t.dev/api/"}"#;
    let cases: [(String, &str, [Option<&str>; 4]); 5] = [
        (String::new(), all_hidden, [None; 4]),
        (
            r#""engagement":{"enabled":false,"endpoint":"https://t.dev/api"}"#.into(),
            all_hidden,
            [None; 4],
        ),
        (
            r#""engagement":{"enabled":true,"comments":false,"endpoint":"https://t.dev/api"}"#
                .into(),
            all_hidden,
            [None; 4],
        ),
        (
            hosted.into(),
            by_post,
            [Some(open_a), Some(locked_b), None, None],
        ),
        (
            format!(
                r#"{hosted},"participation":{{"kinds":{{"author-response":"follow-comments"}},"retention":{{"pendingDays":7}}}}"#
            ),
            by_post,
            [Some(open_a), Some(locked_b), None, None],
        ),
    ];
    let mut pages_by_case = Vec::new();
    for (extra, manifest, sections) in &cases {
        let files = generate(&site(config(extra), &posts).unwrap(), &ThemeSet::new()).unwrap();
        assert_eq!(
            output(&files, "openblog-comments.json"),
            Some(*manifest),
            "{extra}"
        );
        let mut pages = Vec::new();
        for (slug, expected) in ["a", "b", "c", "d"].into_iter().zip(sections) {
            let page = output(&files, &format!("{slug}/index.html")).expect("post page");
            assert_eq!(discussion(page), *expected, "{extra} /{slug}/");
            assert_eq!(page.contains("<ob-comments"), expected.is_some());
            pages.push(page.to_string());
        }
        pages_by_case.push(pages);
    }
    // The hosted site with kinds that have no page element yet, and
    // retention, renders every post page exactly as the same site without
    // them. (B5's kinds add their own form, see the B5 mapping tests, and
    // abuse reports a report form under comments and notes, see
    // participation_protection.rs, and Third Perspectives their own region,
    // see third_perspective_forms.rs.)
    assert_eq!(pages_by_case[4], pages_by_case[3]);
}

/// B5's interim rule (ADR 0081, hosted feedback transport): feedback follows each post's `comments:`
/// setting, whatever `engagement.comments` says. `follow-comments` is that
/// rule; a post's own setting for the kind wins over it.
#[test]
fn follow_comments_is_the_b5_interim_rule_and_a_post_can_override_it() {
    let feedback = [
        ParticipationKind::Question,
        ParticipationKind::SourceSuggestion,
        ParticipationKind::CorrectionSuggestion,
        ParticipationKind::AlternativeInterpretation,
    ];
    let kinds = feedback
        .iter()
        .map(|kind| format!(r#""{}":"follow-comments""#, kind.id()))
        .collect::<Vec<_>>()
        .join(",");
    for comments_switch in [true, false] {
        let config = config(&format!(
            r#""engagement":{{"enabled":true,"comments":{comments_switch},"endpoint":"https://t.dev/api"}},"participation":{{"kinds":{{{kinds}}}}}"#
        ));
        let site = site(
            config.clone(),
            &[
                ("posts/open.md", post("")),
                ("posts/locked.md", post("comments: locked\n")),
                ("posts/hidden.md", post("comments: hidden\n")),
                (
                    "posts/override.md",
                    post("comments: hidden\nparticipation: [question: open]\n"),
                ),
            ],
        )
        .unwrap();
        for post in &site.posts {
            for kind in feedback {
                let expected = match (post.slug.as_str(), kind) {
                    ("override", ParticipationKind::Question) => ParticipationMode::Open,
                    _ => post.comments.into(),
                };
                assert_eq!(
                    effective_mode(&config, post, kind),
                    expected,
                    "{}",
                    post.slug
                );
            }
        }
    }
}

#[test]
fn a_site_default_applies_where_a_post_is_silent_and_off_cannot_be_overridden() {
    let config = config(&format!(
        r#"{HOSTED},"participation":{{"kinds":{{"question":"hidden","third-perspective":"open","abuse-report":"open"}}}}"#
    ));
    let site = site(
        config.clone(),
        &[
            ("posts/silent.md", post("comments: hidden\n")),
            (
                "posts/chosen.md",
                post("participation: [question: open, third-perspective: locked, correction-suggestion: open]\n"),
            ),
        ],
    )
    .unwrap();
    let find = |slug: &str| site.posts.iter().find(|post| post.slug == slug).unwrap();
    let mode = |slug: &str, kind| effective_mode(&config, find(slug), kind);
    assert_eq!(
        mode("silent", ParticipationKind::Question),
        ParticipationMode::Hidden
    );
    assert_eq!(
        mode("silent", ParticipationKind::ThirdPerspective),
        ParticipationMode::Open
    );
    assert_eq!(
        mode("chosen", ParticipationKind::Question),
        ParticipationMode::Open
    );
    assert_eq!(
        mode("chosen", ParticipationKind::ThirdPerspective),
        ParticipationMode::Locked
    );
    // The site never switched suggested corrections on.
    assert_eq!(
        mode("chosen", ParticipationKind::CorrectionSuggestion),
        ParticipationMode::Hidden
    );
    // Abuse reports are site-wide, even on a post whose comments are hidden.
    assert_eq!(
        mode("silent", ParticipationKind::AbuseReport),
        ParticipationMode::Open
    );
    assert_eq!(
        mode("chosen", ParticipationKind::AuthorResponse),
        ParticipationMode::Hidden
    );

    // Without the hosted transport everything is hidden.
    let offline = SiteConfig {
        engagement: Default::default(),
        ..config.clone()
    };
    for kind in ParticipationKind::ALL {
        assert_eq!(
            effective_mode(&offline, find("chosen"), kind),
            ParticipationMode::Hidden
        );
    }
}

#[test]
fn the_participation_manifest_is_published_only_once_a_new_kind_is_switched_on() {
    let posts = [
        ("posts/open.md", post("")),
        ("posts/hidden.md", post("comments: hidden\n")),
        (
            "posts/questions.md",
            post("comments: locked\nparticipation: [question: open]\n"),
        ),
    ];
    // Default: no new file, and the comment manifest is what it always was.
    let plain = generate(&site(config(HOSTED), &posts).unwrap(), &ThemeSet::new()).unwrap();
    assert_eq!(output(&plain, "openblog-participation.json"), None);
    assert_eq!(
        output(&plain, "openblog-comments.json"),
        Some(r#"{"/hidden/":"hidden","/open/":"open","/questions/":"locked"}"#)
    );

    let enabled = config(&format!(
        r#"{HOSTED},"participation":{{"kinds":{{"question":"hidden","abuse-report":"open"}}}}"#
    ));
    let files = generate(&site(enabled.clone(), &posts).unwrap(), &ThemeSet::new()).unwrap();
    assert_eq!(
        output(&files, "openblog-participation.json"),
        Some(
            r#"{"/hidden/":{"abuse-report":"open"},"/open/":{"abuse-report":"open","comment":"open"},"/questions/":{"abuse-report":"open","comment":"locked","question":"open"}}"#
        )
    );
    assert_eq!(
        output(&files, "openblog-comments.json"),
        output(&plain, "openblog-comments.json")
    );

    // Switched on but no hosted transport: nothing to publish.
    let offline = SiteConfig {
        engagement: Default::default(),
        ..enabled
    };
    let files = generate(&site(offline, &posts).unwrap(), &ThemeSet::new()).unwrap();
    assert_eq!(output(&files, "openblog-participation.json"), None);
}

/// ADR 0101: B5's `FeedbackKind` is the registry of its submission format,
/// and every one of its ids is the participation kind it maps to.
#[test]
fn every_feedback_kind_id_is_its_participation_kind_id() {
    use openblog_core::scholarly_feedback::FeedbackKind;
    let mapped: Vec<ParticipationKind> = FeedbackKind::ALL
        .iter()
        .map(|kind| kind.participation_kind())
        .collect();
    assert_eq!(mapped, ParticipationKind::PASSAGE_FEEDBACK);
    for kind in FeedbackKind::ALL {
        assert_eq!(
            ParticipationKind::from_id(kind.id()),
            Some(kind.participation_kind())
        );
        assert_eq!(kind.participation_kind().id(), kind.id());
        assert_eq!(kind.participation_kind().label(), kind.label());
    }
}

/// ADR 0101: `engagement.feedback` folds into `participation.kinds` at load,
/// as `follow-comments` for B5's kinds the site does not name, before
/// anything reads the policy, and is never written back as the owner's.
#[test]
fn engagement_feedback_folds_into_the_policy_at_load_and_is_never_written_back() {
    let folded =
        config(r#""engagement":{"enabled":true,"feedback":true,"endpoint":"https://t.dev/api"}"#);
    for kind in ParticipationKind::PASSAGE_FEEDBACK {
        assert_eq!(
            folded.participation.setting(kind),
            SiteSetting::FollowComments
        );
    }
    assert_eq!(
        folded
            .participation
            .setting(ParticipationKind::ThirdPerspective),
        SiteSetting::Off
    );
    assert!(folded.participation.any_enabled());
    assert!(folded.participation.is_default());
    let written = folded.to_json();
    assert!(!written.contains("participation"), "{written}");
    assert!(written.contains("\"feedback\": true"), "{written}");
    // Reading it back gives the same policy.
    assert_eq!(SiteConfig::from_json(&written).unwrap(), folded);

    // A kind the site names wins over the fold.
    let named = config(
        r#""engagement":{"enabled":true,"feedback":true,"endpoint":"https://t.dev/api"},"participation":{"kinds":{"question":"locked","correction-suggestion":"off"}}"#,
    );
    assert_eq!(
        named.participation.setting(ParticipationKind::Question),
        SiteSetting::Locked
    );
    assert_eq!(
        named
            .participation
            .setting(ParticipationKind::CorrectionSuggestion),
        SiteSetting::Off
    );
    assert_eq!(
        named
            .participation
            .setting(ParticipationKind::SourceSuggestion),
        SiteSetting::FollowComments
    );
    let written = named.to_json();
    assert!(!written.contains("source-suggestion"), "{written}");

    // Off adds nothing.
    let off = config(HOSTED);
    for kind in ParticipationKind::PASSAGE_FEEDBACK {
        assert_eq!(off.participation.setting(kind), SiteSetting::Off);
    }
    assert!(!off.participation.any_enabled());
}

fn feedback_form(page: &str) -> Option<&str> {
    let start = page.find("<ob-passage-feedback")?;
    let end = start + page[start..].find('>').unwrap() + 1;
    Some(&page[start..end])
}

/// ADR 0101: a site that only set `engagement.feedback` publishes what B5
/// published, byte for byte, plus the participation manifest; the form is
/// shown where a kind is open and offers exactly the open kinds.
#[test]
fn b5s_form_and_manifests_come_from_the_policy() {
    let posts = [
        ("posts/open.md", post("")),
        ("posts/locked.md", post("comments: locked\n")),
        ("posts/hidden.md", post("comments: hidden\n")),
    ];
    let b5 = config(
        r#""engagement":{"enabled":true,"comments":false,"feedback":true,"endpoint":"https://t.dev/api"}"#,
    );
    let files = generate(&site(b5, &posts).unwrap(), &ThemeSet::new()).unwrap();
    assert_eq!(
        output(&files, "openblog-feedback.json"),
        Some(r#"{"/hidden/":"hidden","/locked/":"locked","/open/":"open"}"#)
    );
    let manifest: serde_json::Value =
        serde_json::from_str(output(&files, "openblog-participation.json").unwrap()).unwrap();
    assert_eq!(manifest["/open/"]["question"], "open");
    assert_eq!(manifest["/locked/"]["correction-suggestion"], "locked");
    assert!(manifest.get("/hidden/").is_none());
    let open = output(&files, "open/index.html").unwrap();
    assert!(!feedback_form(open).unwrap().contains("kinds="));
    assert!(feedback_form(output(&files, "locked/index.html").unwrap()).is_none());

    // Per kind: questions open, suggested sources locked, the rest off.
    let per_kind = config(&format!(
        r#"{HOSTED},"participation":{{"kinds":{{"question":"open","source-suggestion":"locked"}}}}"#
    ));
    let files = generate(&site(per_kind, &posts).unwrap(), &ThemeSet::new()).unwrap();
    let form = feedback_form(output(&files, "hidden/index.html").unwrap()).unwrap();
    assert!(form.contains(r#"kinds="question""#), "{form}");
    // An older function reads B5's file, which is never more open than any
    // of the four kinds: two are off, so nothing is open there.
    assert_eq!(
        output(&files, "openblog-feedback.json"),
        Some(r#"{"/hidden/":"hidden","/locked/":"hidden","/open/":"hidden"}"#)
    );

    // No passage kind on: neither file, and no form.
    let files = generate(&site(config(HOSTED), &posts).unwrap(), &ThemeSet::new()).unwrap();
    assert_eq!(output(&files, "openblog-feedback.json"), None);
    assert!(feedback_form(output(&files, "open/index.html").unwrap()).is_none());
}
