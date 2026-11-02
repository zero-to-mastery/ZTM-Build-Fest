//! Sequential and side-by-side presentation of one approved reflection (ADR 0031): the arranged
//! Post, the arranged preview, the approval binding of the arrangement, and the part marker.

use openblog_core::approval::ApprovalSet;
use openblog_core::assembly::{assemble, with_subject, AssemblyError};
use openblog_core::collaboration::{
    AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference,
    Participant, SharedPublication, SourceKind,
};
use openblog_core::config::SiteConfig;
use openblog_core::contributor::Contributor;
use openblog_core::draft::DraftSet;
use openblog_core::media_moment::MomentSet;
use openblog_core::preview::build;
use openblog_core::reflection::{ReflectionLayout, ReflectionStructure, LAYOUT_CSS, PART_MARKER};
use openblog_core::synthesis::SynthesisSet;
use openblog_core::SourceFile;

const T: i64 = 1_800_000_000;
const DATE: &str = "2030-01-31T09:00:00Z";
const ALL: [&str; 3] = ["ann", "bo", "cy"];

fn record() -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: "shared-0a1b2c3d4e5f".into(),
        title: "On \"attention\": a <b>duet</b>".into(),
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
            display_name: "Ann".into(),
        },
    })
    .unwrap();
    record.collaboration.participants[0].id = "ann".into();
    record.authorization.bindings[0].participant_id = "ann".into();
    for (id, name) in [("bo", "Bo"), ("cy", "Cy")] {
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

fn drafts(texts: &[(&str, &str)]) -> DraftSet {
    let mut set = DraftSet::new(&ALL).unwrap();
    for (who, text) in texts {
        set.save(who, who, 0, text, T).unwrap();
    }
    set
}

fn structure(json: &str) -> ReflectionStructure {
    ReflectionStructure::from_json(json).unwrap()
}

/// Ann and Bo answer twice each, interleaved: a1 b1 a2 b2.
fn interleaved(layout: &str, revision: u64) -> ReflectionStructure {
    structure(&format!(
        r#"{{"version":1,"revision":{revision},"layout":"{layout}","rounds":[
            {{"id":"r1","roundPrompt":"What stood out? <b>x</b>","turns":[{{"draft":"ann","part":0}},{{"draft":"bo","part":0}}]}},
            {{"id":"r2","turns":[{{"draft":"ann","part":1}},{{"draft":"bo","part":1}}]}}]}}"#
    ))
}

fn two_part(first: &str, second: &str) -> String {
    format!("{first}\n{PART_MARKER}\n{second}")
}

fn world() -> DraftSet {
    drafts(&[
        ("ann", &two_part("ANN-ONE", "ANN-TWO")),
        ("bo", &two_part("BO-ONE", "BO-TWO")),
    ])
}

fn approve_all(
    record: &SharedPublication,
    s: Option<&ReflectionStructure>,
    set: &DraftSet,
) -> ApprovalSet {
    let mut approvals = ApprovalSet::new();
    for who in ALL {
        let seen = with_subject(
            record,
            s,
            set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &ALL,
            |subject| approvals.binding_for(subject, who).unwrap(),
        );
        with_subject(
            record,
            s,
            set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &ALL,
            |subject| approvals.approve(who, who, subject, &seen, true, T),
        )
        .unwrap();
    }
    approvals
}

fn index(haystack: &str, needle: &str) -> usize {
    haystack
        .find(needle)
        .unwrap_or_else(|| panic!("missing {needle}"))
}

/// The Post's body: everything after its front matter, whose automatic `description` repeats the
/// start of the prose and so says nothing about reading order.
fn body(source: &str) -> &str {
    source
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---\n"))
        .map_or(source, |(_, body)| body)
}

fn in_order(haystack: &str, needles: &[&str]) -> bool {
    let at: Vec<usize> = needles.iter().map(|n| index(haystack, n)).collect();
    at.windows(2).all(|pair| pair[0] < pair[1])
}

const READING: [&str; 4] = ["ANN-ONE", "BO-ONE", "ANN-TWO", "BO-TWO"];

#[test]
fn a_piece_without_a_structure_keeps_participant_order_and_never_shows_the_marker() {
    let record = record();
    let set = world();
    let approvals = approve_all(&record, None, &set);
    let made = assemble(
        &record,
        None,
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    assert!(!made.source.contains("openblog:part"), "{}", made.source);
    assert!(!made.source.contains("ob-reflection"));
    assert!(index(&made.source, "ANN-TWO") < index(&made.source, "BO-ONE"));
    // The parts of a draft stay separate paragraphs.
    assert!(made.source.contains("ANN-ONE\n\nANN-TWO"));
}

#[test]
fn the_arranged_post_follows_the_reading_order_and_credits_each_author_once() {
    let record = record();
    let set = world();
    let s = interleaved("sequential", 1);
    let approvals = approve_all(&record, Some(&s), &set);
    let made = assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    assert!(in_order(&made.source, &READING), "{}", made.source);
    assert!(!made.source.contains("openblog:part"));
    assert_eq!(made.credits.matches("\"contributor\"").count(), 2);
    assert!(index(&made.credits, "ann") < index(&made.credits, "bo"));
    // Every turn has its own heading, so attribution never depends on position.
    assert_eq!(
        made.source.matches("<h2 class=\"ob-turn-author\">").count(),
        4
    );
    // The round prompt is escaped text, once, before the answers.
    assert!(made.source.contains("What stood out? &lt;b&gt;x&lt;/b&gt;"));
    assert!(!made.source.contains("<b>x</b>"));
    assert!(index(body(&made.source), "What stood out") < index(body(&made.source), "ANN-ONE"));
    assert!(made.source.contains("ob-reflection-sequential ob-lanes-1"));
}

#[test]
fn side_by_side_is_the_same_dom_order_with_lane_classes_only() {
    let record = record();
    let set = world();
    let side = interleaved("sequential", 1).with_layout(ReflectionLayout::SideBySide);
    let approvals = approve_all(&record, Some(&side), &set);
    let made = assemble(
        &record,
        Some(&side),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    assert!(made
        .source
        .contains("ob-reflection-side-by-side ob-lanes-2"));
    assert!(made.source.contains("ob-lane-0") && made.source.contains("ob-lane-1"));
    assert!(in_order(&made.source, &READING));
    // No inline style, script or position is written: CSS alone places the lanes.
    for forbidden in ["style=", "<script", "data-"] {
        assert!(!made.source.contains(forbidden), "{forbidden}");
    }
}

#[test]
fn unequal_numbers_of_parts_arrange_without_blank_gaps() {
    let record = record();
    let set = drafts(&[("ann", &two_part("ANN-ONE", "ANN-TWO")), ("bo", "BO-ONLY")]);
    let s = structure(
        r#"{"version":1,"revision":1,"layout":"sideBySide","rounds":[{"id":"r1","turns":[
            {"draft":"ann","part":0},{"draft":"bo","part":0},{"draft":"ann","part":1}]}]}"#,
    );
    let approvals = approve_all(&record, Some(&s), &set);
    let made = assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    assert_eq!(made.source.matches("<section class=\"ob-turn").count(), 3);
    assert!(index(&made.source, "BO-ONLY") < index(&made.source, "ANN-TWO"));
}

#[test]
fn changing_the_layout_or_the_arrangement_makes_standing_approvals_stale_at_the_gate() {
    let record = record();
    let set = world();
    let s = interleaved("sequential", 1);
    let approvals = approve_all(&record, Some(&s), &set);
    assert!(assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE
    )
    .is_ok());
    let blocked = |changed: Option<&ReflectionStructure>| {
        matches!(
            assemble(&record, changed, &set, &SynthesisSet::new(), &MomentSet::new(), &approvals, &ALL, DATE),
            Err(AssemblyError::Blocked { missing }) if missing == ["Ann", "Bo", "Cy"]
        )
    };
    // The layout alone.
    assert!(blocked(Some(&s.with_layout(ReflectionLayout::SideBySide))));
    // The turn order alone.
    let mut reordered = s.clone();
    reordered.rounds[0].turns.reverse();
    assert!(blocked(Some(&reordered)));
    // A round prompt alone.
    let mut prompted = s.clone();
    prompted.rounds[1].round_prompt = Some("New".into());
    assert!(blocked(Some(&prompted)));
    // Removing the structure is also a change to what readers see.
    assert!(blocked(None));
    // Saving an identical arrangement under a newer revision changes nothing a reader sees.
    let mut resaved = s.clone();
    resaved.revision = 2;
    assert!(assemble(
        &record,
        Some(&resaved),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE
    )
    .is_ok());
    // Approvals given before any structure existed do not survive the first one either.
    let plain = approve_all(&record, None, &set);
    assert!(assemble(
        &record,
        None,
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &plain,
        &ALL,
        DATE
    )
    .is_ok());
    assert!(assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &plain,
        &ALL,
        DATE
    )
    .is_err());
}

#[test]
fn a_stale_or_unsupported_arrangement_publishes_nothing() {
    let record = record();
    let set = world();
    let missing_part = structure(
        r#"{"version":1,"revision":1,"layout":"sequential","rounds":[{"id":"r1","turns":[{"draft":"ann","part":5}]}]}"#,
    );
    let approvals = approve_all(&record, Some(&missing_part), &set);
    assert_eq!(
        assemble(
            &record,
            Some(&missing_part),
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &approvals,
            &ALL,
            DATE
        ),
        Err(AssemblyError::ArrangementMismatch)
    );
    // Without the approvals the gate refuses for them, whether or not the part exists, so the
    // refusal says nothing about a draft to someone who may arrange but not read it (ADR 0031).
    let present_part = structure(
        r#"{"version":1,"revision":1,"layout":"sequential","rounds":[{"id":"r1","turns":[{"draft":"ann","part":0}]}]}"#,
    );
    let unapproved = |s: &ReflectionStructure| {
        assemble(
            &record,
            Some(s),
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &ApprovalSet::new(),
            &ALL,
            DATE,
        )
    };
    assert!(matches!(
        unapproved(&missing_part),
        Err(AssemblyError::Blocked { .. })
    ));
    assert_eq!(unapproved(&missing_part), unapproved(&present_part));
}

#[test]
fn hostile_names_and_markup_cannot_break_out_of_the_arrangement() {
    let mut record = record();
    record.collaboration.participants[0].display_name = "<script>alert(1)</script> Ann".into();
    let s = structure(
        r#"{"version":1,"revision":1,"layout":"sideBySide","rounds":[{"id":"r1","turns":[{"draft":"ann","part":0},{"draft":"bo","part":0}]}]}"#,
    );
    let set = drafts(&[("ann", "Ann words"), ("bo", "Bo <script>x</script>")]);
    let approvals = approve_all(&record, Some(&s), &set);
    assert_eq!(
        assemble(
            &record,
            Some(&s),
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &approvals,
            &ALL,
            DATE
        ),
        Err(AssemblyError::UnsafeMarkup)
    );
    let set = drafts(&[("ann", "Ann words"), ("bo", "Bo words")]);
    let approvals = approve_all(&record, Some(&s), &set);
    let made = assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    assert!(!made.source.contains("<script>"));
    assert!(made
        .source
        .contains("&lt;script&gt;alert&#40;1&#41;&lt;/script&gt; Ann"));
}

#[test]
fn the_arranged_post_loads_through_the_production_pipeline_in_reading_order() {
    let record = record();
    let set = world();
    let s = interleaved("sideBySide", 1);
    let approvals = approve_all(&record, Some(&s), &set);
    let made = assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    let mut config = SiteConfig::default();
    for (id, name) in [("ann", "Ann"), ("bo", "Bo"), ("cy", "Cy")] {
        config.contributors.insert(
            id.into(),
            Contributor {
                name: name.into(),
                ..Contributor::default()
            },
        );
    }
    let post = openblog_core::model::load_post_with_credits(
        &SourceFile {
            path: made.path.clone(),
            contents: made.source.clone(),
        },
        &config,
        config.render_options(),
        Some(&SourceFile {
            path: made.credits_path.clone(),
            contents: made.credits.clone(),
        }),
    )
    .unwrap();
    let html = &post.html;
    assert!(
        html.contains("class=\"ob-reflection ob-reflection-side-by-side ob-lanes-2\""),
        "{html}"
    );
    assert!(in_order(html, &READING), "{html}");
    assert!(
        !html.contains("openblog:part") && !html.contains("<!--"),
        "{html}"
    );
    assert_eq!(
        html.matches("<section class=\"ob-turn").count(),
        4,
        "{html}"
    );
    assert_eq!(html.matches("</section>").count(), 4, "{html}");
}

#[test]
fn the_preview_arranges_what_the_requester_may_read_and_shows_one_placeholder_for_the_rest() {
    let record = record();
    let set = world();
    let s = interleaved("sideBySide", 1);
    let approvals = ApprovalSet::new();
    let config = SiteConfig::default();
    let options = config.render_options();
    let shown = build(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        "ann",
        &ALL,
        true,
        options,
    )
    .unwrap();
    // Bo's draft is private to Bo: nothing of it reaches Ann's preview, and neither does the marker.
    assert!(!shown.document.contains("BO-ONE") && !shown.document.contains("BO-TWO"));
    assert!(!shown.document.contains("openblog:part"));
    assert!(shown.document.contains("ANN-ONE") && shown.document.contains("ANN-TWO"));
    assert!(shown.document.contains("ob-reflection-side-by-side"));
    assert!(!shown.complete && shown.seen.is_none());
    assert!(
        shown
            .document
            .matches("Not shared with you at its current revision")
            .count()
            >= 2
    );
    // The same piece for Bo reads Bo's turns and hides Ann's.
    let theirs = build(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        "bo",
        &ALL,
        true,
        options,
    )
    .unwrap();
    assert!(theirs.document.contains("BO-ONE") && !theirs.document.contains("ANN-ONE"));
    assert!(
        shown.document.contains("grid-column"),
        "the preview carries the layout rules"
    );
}

#[test]
fn a_complete_arranged_preview_hands_out_the_binding_the_gate_checks() {
    let record = record();
    let mut set = world();
    set.set_policy(openblog_core::draft::RevealPolicy::Voluntary);
    set.mark_ready("ann", 1, &ALL).unwrap();
    set.mark_ready("bo", 1, &ALL).unwrap();
    let s = interleaved("sequential", 1);
    let approvals = ApprovalSet::new();
    let config = SiteConfig::default();
    let options = config.render_options();
    let shown = build(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        "ann",
        &ALL,
        true,
        options,
    )
    .unwrap();
    assert!(shown.complete);
    let gate = with_subject(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &ALL,
        |subject| approvals.binding_for(subject, "ann").unwrap(),
    );
    assert_eq!(shown.seen.as_deref(), Some(gate.as_str()));
    assert!(in_order(&shown.document, &READING));
    // A preview of another arrangement hands out a different binding.
    let other = build(
        &record,
        Some(&s.with_layout(ReflectionLayout::SideBySide)),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        "ann",
        &ALL,
        true,
        options,
    )
    .unwrap();
    assert_ne!(other.seen, shown.seen);
    // An arrangement that cannot be read against the drafts is never complete or approvable.
    let broken = structure(
        r#"{"version":1,"revision":1,"layout":"sequential","rounds":[{"id":"r1","turns":[{"draft":"ann","part":9}]}]}"#,
    );
    let refused = build(
        &record,
        Some(&broken),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        "ann",
        &ALL,
        true,
        options,
    )
    .unwrap();
    assert!(!refused.complete && refused.seen.is_none());
    assert!(!refused.document.contains("ANN-ONE"));
}

#[test]
fn the_preview_without_a_structure_strips_the_marker_too() {
    let record = record();
    let set = world();
    let config = SiteConfig::default();
    let options = config.render_options();
    let shown = build(
        &record,
        None,
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &ApprovalSet::new(),
        "ann",
        &ALL,
        true,
        options,
    )
    .unwrap();
    assert!(!shown.document.contains("openblog:part") && !shown.document.contains("<!--"));
    assert!(shown.document.contains("ANN-ONE") && shown.document.contains("ANN-TWO"));
}

#[test]
fn the_public_stylesheet_carries_exactly_the_layout_rules_the_preview_uses() {
    let base = include_str!("../../../web/base.css");
    assert!(base.contains(LAYOUT_CSS.trim()));
    // Placement is gated to wide screens and never to print, and the narrow default is a flow.
    assert!(LAYOUT_CSS.contains("@media screen and (min-width: 48em)"));
    assert!(!LAYOUT_CSS.contains("order:"));
    assert!(!LAYOUT_CSS.contains("float"));
}

#[test]
fn an_unclosed_fence_in_the_last_turn_cannot_swallow_the_arrangement_markup() {
    let record = record();
    let s = structure(
        r#"{"version":1,"revision":1,"layout":"sideBySide","rounds":[{"id":"r1","turns":[{"draft":"ann","part":0},{"draft":"bo","part":0}]}]}"#,
    );
    let set = drafts(&[
        ("ann", "Ann words"),
        ("bo", "Bo words\n\n```\nnever closed"),
    ]);
    let approvals = approve_all(&record, Some(&s), &set);
    assert_eq!(
        assemble(
            &record,
            Some(&s),
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &approvals,
            &ALL,
            DATE
        ),
        Err(AssemblyError::UnsafeMarkup)
    );
    // The unarranged path refuses it too, so the two paths agree.
    let approvals = approve_all(&record, None, &set);
    assert_eq!(
        assemble(
            &record,
            None,
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &approvals,
            &ALL,
            DATE
        ),
        Err(AssemblyError::UnsafeMarkup)
    );
    // A closed fence is ordinary prose.
    let set = drafts(&[("ann", "Ann words"), ("bo", "```\nclosed\n```")]);
    let approvals = approve_all(&record, Some(&s), &set);
    assert!(assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE
    )
    .is_ok());
}

#[test]
fn the_preview_drops_the_turns_of_an_author_with_nothing_written() {
    let record = record();
    let s = structure(
        r#"{"version":1,"revision":1,"layout":"sequential","rounds":[{"id":"r1","turns":[{"draft":"ann","part":0},{"draft":"bo","part":0}]}]}"#,
    );
    let set = drafts(&[("ann", "Ann words")]);
    let approvals = ApprovalSet::new();
    let config = SiteConfig::default();
    let shown = build(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        "ann",
        &ALL,
        true,
        config.render_options(),
    )
    .unwrap();
    assert!(shown.complete);
    assert!(shown.document.contains("Ann words"));
    assert!(!shown.document.contains("Not shared with you"));
    assert!(!shown.document.contains(">Bo<"), "{}", shown.document);
}

const NEW_LAYOUTS: [(&str, &str); 3] = [
    ("pointCounterpoint", "point-counterpoint"),
    ("alternatingDialogue", "alternating-dialogue"),
    ("roundtable", "roundtable"),
];

#[test]
fn the_other_three_layouts_publish_in_reading_order_with_only_classes_to_place_them() {
    let record = record();
    let set = world();
    for (name, key) in NEW_LAYOUTS {
        let s = interleaved(name, 1);
        let approvals = approve_all(&record, Some(&s), &set);
        let made = assemble(
            &record,
            Some(&s),
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &approvals,
            &ALL,
            DATE,
        )
        .unwrap();
        assert!(
            made.source
                .contains(&format!("ob-reflection-{key} ob-lanes-")),
            "{key}"
        );
        assert!(in_order(&made.source, &READING), "{key}");
        // Every turn names its author in its own heading, and nothing positional is written.
        assert_eq!(
            made.source.matches("<h2 class=\"ob-turn-author\">").count(),
            4
        );
        for forbidden in ["style=", "<script", "data-", "left", "right"] {
            assert!(!made.source.contains(forbidden), "{key}: {forbidden}");
        }
        assert_eq!(made.credits.matches("\"contributor\"").count(), 2);
    }
}

#[test]
fn point_counterpoint_lanes_follow_first_appearance_not_identity() {
    let record = record();
    let set = world();
    // Bo speaks first this time, so Bo takes the first lane; no field names a side.
    let s = structure(
        r#"{"version":1,"revision":1,"layout":"pointCounterpoint","rounds":[
            {"id":"r1","turns":[{"draft":"bo","part":0},{"draft":"ann","part":0}]},
            {"id":"r2","turns":[{"draft":"ann","part":1},{"draft":"bo","part":1}]}]}"#,
    );
    let approvals = approve_all(&record, Some(&s), &set);
    let made = assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    let lanes: Vec<&str> = made
        .source
        .split("class=\"ob-turn ob-lane-")
        .skip(1)
        .map(|rest| &rest[..1])
        .collect();
    assert_eq!(lanes, ["0", "1", "1", "0"]);
    assert!(made.source.contains("ob-lanes-2"));
}

#[test]
fn a_roundtable_has_a_place_for_any_number_of_participants() {
    use openblog_core::reflection::{compose, ComposedTurn, Placement};
    let names: Vec<String> = (0..9).map(|i| format!("Person {i}")).collect();
    let turns: Vec<ComposedTurn<'_>> = names
        .iter()
        .enumerate()
        .map(|(i, name)| ComposedTurn {
            round: 0,
            round_prompt: (i == 0).then_some("Around the table"),
            display_name: name,
            label: None,
            placement: Placement { lane: i, lanes: 9 },
            body: format!("<p>WORDS-{i}</p>"),
        })
        .collect();
    let html = compose(ReflectionLayout::Roundtable, &turns);
    assert!(html.contains("ob-reflection-roundtable ob-lanes-4"));
    assert_eq!(html.matches("<section").count(), 9);
    for i in 0..8 {
        assert!(index(&html, &format!("WORDS-{i}")) < index(&html, &format!("WORDS-{}", i + 1)));
    }
    // The stylesheet needs no rule per person: columns come from the width, not the lane.
    assert!(LAYOUT_CSS.contains("repeat(auto-fit, minmax(min(100%, 16rem), 1fr))"));
}

#[test]
fn labels_are_escaped_optional_and_dropped_with_the_turn_they_belong_to() {
    let record = record();
    let s = structure(
        r#"{"version":1,"revision":1,"layout":"pointCounterpoint","rounds":[{"id":"r1","turns":[
            {"draft":"ann","part":0,"label":"Point <img src=x onerror=alert(1)>"},
            {"draft":"bo","part":0,"label":"Réplique 反論"},
            {"draft":"cy","part":0}]}]}"#,
    );
    let set = drafts(&[("ann", "Ann words"), ("bo", "Bo words"), ("cy", "Cy words")]);
    let approvals = approve_all(&record, Some(&s), &set);
    let made = assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    assert!(!made.source.contains("<img"));
    assert!(made.source.contains(
        "<p class=\"ob-turn-label\">Point &lt;img src=x onerror=alert&#40;1&#41;&gt;</p>"
    ));
    assert!(made
        .source
        .contains("<p class=\"ob-turn-label\">Réplique 反論</p>"));
    // No label is invented for the unlabelled turn.
    assert_eq!(made.source.matches("ob-turn-label").count(), 2);
    // The label reads right after the author's name and before the words.
    assert!(in_order(
        body(&made.source),
        &[">Ann</h2>", "Point &lt;img", "Ann words"]
    ));
    // Bo writes nothing: Bo's turn, label and credit are gone and the others still read fine.
    let set = drafts(&[("ann", "Ann words"), ("cy", "Cy words")]);
    let approvals = approve_all(&record, Some(&s), &set);
    let made = assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    assert!(!made.source.contains("Réplique") && !made.source.contains(">Bo<"));
    assert_eq!(made.credits.matches("\"contributor\"").count(), 2);
    assert!(made.source.contains("ob-lanes-2"));
}

#[test]
fn when_only_one_voice_remains_the_layout_is_one_honest_column() {
    let record = record();
    let set = drafts(&[("ann", "Ann words")]);
    let s = structure(
        r#"{"version":1,"revision":1,"layout":"pointCounterpoint","rounds":[{"id":"r1","turns":[{"draft":"ann","part":0},{"draft":"bo","part":0}]}]}"#,
    );
    let approvals = approve_all(&record, Some(&s), &set);
    let made = assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    assert!(made.source.contains("ob-lanes-1"), "{}", made.source);
    assert!(!made.source.contains("ob-lane-1"));
    assert!(!made.source.contains(">Bo<"));
    // A dialogue of one turn is not staggered either.
    let s = structure(
        r#"{"version":1,"revision":1,"layout":"alternatingDialogue","rounds":[{"id":"r1","turns":[{"draft":"ann","part":0}]}]}"#,
    );
    let approvals = approve_all(&record, Some(&s), &set);
    let made = assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    assert!(made.source.contains("ob-lanes-1"));
}

#[test]
fn the_preview_arranges_the_new_layouts_and_their_labels_like_the_post() {
    let record = record();
    let set = world();
    let config = SiteConfig::default();
    for (name, key) in NEW_LAYOUTS {
        let mut s = interleaved(name, 1);
        s.rounds[0].turns[0].label = Some("Opening <i>words</i>".into());
        let approvals = ApprovalSet::new();
        let shown = build(
            &record,
            Some(&s),
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &approvals,
            "ann",
            &ALL,
            true,
            config.render_options(),
        )
        .unwrap();
        assert!(
            shown.document.contains(&format!("ob-reflection-{key}")),
            "{key}"
        );
        assert!(shown.document.contains("Opening &lt;i&gt;words&lt;/i&gt;"));
        assert!(
            shown.document.contains("auto-fit"),
            "the preview carries the rules"
        );
        assert!(!shown.document.contains("BO-ONE"));
    }
}

#[test]
fn a_last_turn_ending_in_an_indented_code_block_is_published_not_refused() {
    let record = record();
    let s = structure(
        r#"{"version":1,"revision":1,"layout":"sideBySide","rounds":[{"id":"r1","turns":[{"draft":"ann","part":0},{"draft":"bo","part":0}]}]}"#,
    );
    let set = drafts(&[("ann", "Ann words"), ("bo", "Bo shows:\n\n    code line")]);
    let approvals = approve_all(&record, Some(&s), &set);
    let made = assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    assert!(made.source.contains("    code line"));
    // The unarranged path agrees.
    let approvals = approve_all(&record, None, &set);
    assert!(assemble(
        &record,
        None,
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE
    )
    .is_ok());
}

#[test]
fn a_dialogue_changes_side_only_when_the_speaker_changes() {
    let record = record();
    let set = drafts(&[
        ("ann", &two_part("ANN-ONE", "ANN-TWO")),
        ("bo", "BO-ONE"),
        ("cy", "CY-ONE"),
    ]);
    let s = structure(
        r#"{"version":1,"revision":1,"layout":"alternatingDialogue","rounds":[{"id":"r1","turns":[
            {"draft":"ann","part":0},{"draft":"ann","part":1},{"draft":"bo","part":0},{"draft":"cy","part":0}]}]}"#,
    );
    let approvals = approve_all(&record, Some(&s), &set);
    let made = assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    let lanes: Vec<&str> = made
        .source
        .split("class=\"ob-turn ob-lane-")
        .skip(1)
        .map(|rest| &rest[..1])
        .collect();
    assert_eq!(lanes, ["0", "0", "1", "0"]);
    assert!(made.source.contains("ob-lanes-2"));
}

#[test]
fn point_counterpoint_with_three_voices_is_one_column() {
    let record = record();
    let set = drafts(&[("ann", "ANN-ONE"), ("bo", "BO-ONE"), ("cy", "CY-ONE")]);
    let s = structure(
        r#"{"version":1,"revision":1,"layout":"pointCounterpoint","rounds":[{"id":"r1","turns":[
            {"draft":"ann","part":0},{"draft":"bo","part":0},{"draft":"cy","part":0}]}]}"#,
    );
    let approvals = approve_all(&record, Some(&s), &set);
    let made = assemble(
        &record,
        Some(&s),
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &approvals,
        &ALL,
        DATE,
    )
    .unwrap();
    assert!(made.source.contains("ob-lanes-1"), "{}", made.source);
    assert!(!made.source.contains("ob-lane-1"));
    assert_eq!(made.source.matches("ob-lane-0").count(), 3);
}
