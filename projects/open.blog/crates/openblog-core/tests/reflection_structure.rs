use openblog_core::collaboration::CollaborationContract;
use openblog_core::draft::DraftSet;
use openblog_core::reflection::{split_parts, ReflectionLayout, ReflectionStructure, PART_MARKER};

/// A contract with `participants` people and no contributions, as real publications have, and a
/// real draft set. Every person in `texts` saves one draft. With `reveal`, all writers exchange
/// revision 1 with each other, so each can read every draft.
fn world(
    participants: usize,
    texts: &[(usize, &str)],
    reveal: bool,
) -> (CollaborationContract, DraftSet) {
    let people: Vec<String> = (0..participants)
        .map(|i| format!(r#"{{"id":"p{i}","displayName":"Person {i}"}}"#))
        .collect();
    let contract = CollaborationContract::from_json(&format!(
        r#"{{"version":1,"revision":1,"participants":[{}],"contributions":[],"reveals":[],"layout":[],"approvals":[]}}"#,
        people.join(",")
    ))
    .unwrap();
    let ids: Vec<String> = (0..participants).map(|i| format!("p{i}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let mut drafts = DraftSet::new(&refs).unwrap();
    for (who, text) in texts {
        let id = format!("p{who}");
        drafts.save(&id, &id, 0, text, 1).unwrap();
    }
    if reveal && texts.len() > 1 {
        let writers: Vec<String> = texts.iter().map(|(who, _)| format!("p{who}")).collect();
        let members: Vec<&str> = writers.iter().map(String::as_str).collect();
        drafts.open_exchange(members[0], "x1", &members).unwrap();
        for w in &members {
            drafts.commit(w, "x1", w, 1).unwrap();
        }
    }
    (contract, drafts)
}

fn active(participants: usize) -> Vec<String> {
    (0..participants).map(|i| format!("p{i}")).collect()
}

/// The reading order p0 sees, as (draft, part, prose) triples.
fn read(
    s: &ReflectionStructure,
    contract: &CollaborationContract,
    drafts: &DraftSet,
    n: usize,
) -> Vec<(String, usize, Option<String>)> {
    let ids = active(n);
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    s.reading_order_for(contract, drafts, "p0", &refs)
        .unwrap()
        .into_iter()
        .map(|e| (e.draft_id.to_string(), e.part, e.markdown))
        .collect()
}

fn structure(layout: &str, rounds: &str) -> String {
    format!(r#"{{"version":1,"revision":1,"layout":"{layout}","rounds":{rounds}}}"#)
}

fn t(draft: &str, part: usize) -> String {
    format!(r#"{{"draft":"{draft}","part":{part}}}"#)
}

const MARK: &str = "<!-- openblog:part -->";

/// p0 and p1 answer round one under a round prompt; p2 writes two parts for round two.
fn rounds() -> String {
    format!(
        r#"[{{"id":"r1","roundPrompt":"What stayed with you?","turns":[{},{}]}},{{"id":"r2","turns":[{},{}]}}]"#,
        t("p0", 0),
        t("p1", 0),
        t("p2", 0),
        t("p2", 1)
    )
}

fn three() -> (CollaborationContract, DraftSet) {
    world(
        3,
        &[
            (0, "zero"),
            (1, "one"),
            (
                2,
                &format!(
                    "two
{MARK}
three"
                ),
            ),
        ],
        true,
    )
}

#[test]
fn every_mode_reads_the_same_model_in_the_same_order() {
    let (contract, drafts) = three();
    let base = ReflectionStructure::from_json(&structure("sequential", &rounds())).unwrap();
    for layout in ReflectionLayout::ALL {
        let order = read(&base.with_layout(layout), &contract, &drafts, 3);
        assert_eq!(
            order
                .iter()
                .map(|(d, p, m)| (d.as_str(), *p, m.as_deref().unwrap().trim()))
                .collect::<Vec<_>>(),
            [
                ("p0", 0, "zero"),
                ("p1", 0, "one"),
                ("p2", 0, "two"),
                ("p2", 1, "three")
            ],
            "{}",
            layout.key()
        );
        let ids = active(3);
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let entries = base
            .reading_order_for(&contract, &drafts, "p0", &refs)
            .unwrap();
        let placements = ReflectionStructure::placements(layout, &entries);
        assert_eq!(placements.len(), 4);
        assert!(placements.iter().all(|p| p.lane < p.lanes));
    }
}

#[test]
fn layout_names_parse_and_changing_layout_leaves_everything_else() {
    for key in [
        "sequential",
        "sideBySide",
        "pointCounterpoint",
        "alternatingDialogue",
        "roundtable",
    ] {
        ReflectionStructure::from_json(&structure(key, &rounds())).unwrap();
    }
    let base = ReflectionStructure::from_json(&structure("sequential", &rounds())).unwrap();
    let changed = base.with_layout(ReflectionLayout::Roundtable);
    assert_eq!(base.rounds, changed.rounds);
    assert_eq!(base.revision, changed.revision);
    let (contract, drafts) = three();
    assert_eq!(
        read(&base, &contract, &drafts, 3),
        read(&changed, &contract, &drafts, 3)
    );
}

#[test]
fn round_prompt_is_read_once_before_a_rounds_answers() {
    let (contract, drafts) = three();
    let s = ReflectionStructure::from_json(&structure("sequential", &rounds())).unwrap();
    let ids = active(3);
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let order = s
        .reading_order_for(&contract, &drafts, "p0", &refs)
        .unwrap();
    assert_eq!(order[0].round_prompt, Some("What stayed with you?"));
    assert!(order[1..].iter().all(|e| e.round_prompt.is_none()));
    assert_eq!((order[1].round, order[2].round), (0, 1));
}

#[test]
fn unequal_counts_are_parts_of_one_draft_per_participant() {
    // p0 speaks three times (three parts of one draft), p1 once, p2 never.
    let text = format!("one\n{MARK}\ntwo\n{MARK}\n");
    let (contract, drafts) = world(3, &[(0, &text), (1, "b")], true);
    assert_eq!(split_parts(&text), ["one\n", "two\n", ""]);
    let s = ReflectionStructure::from_json(&structure(
        "sideBySide",
        &format!(
            r#"[{{"id":"r1","turns":[{},{}]}},{{"id":"r2","turns":[{},{}]}}]"#,
            t("p0", 0),
            t("p1", 0),
            t("p0", 1),
            t("p0", 2)
        ),
    ))
    .unwrap();
    let order = read(&s, &contract, &drafts, 3);
    assert_eq!(
        order
            .iter()
            .map(|(d, p, _)| (d.as_str(), *p))
            .collect::<Vec<_>>(),
        [("p0", 0), ("p1", 0), ("p0", 1), ("p0", 2)]
    );
    // A blank trailing part keeps its place as a placeholder.
    assert!(order[3].2.is_none() && order[0].2.is_some());
    let ids = active(3);
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let entries = s
        .reading_order_for(&contract, &drafts, "p0", &refs)
        .unwrap();
    let lanes = ReflectionStructure::placements(ReflectionLayout::SideBySide, &entries);
    assert_eq!(
        lanes.iter().map(|p| p.lane).collect::<Vec<_>>(),
        [0, 1, 0, 0]
    );
    assert!(lanes.iter().all(|p| p.lanes == 2));
}

#[test]
fn placements_follow_first_appearance_for_many_participants() {
    let texts: Vec<(usize, String)> = (0..10).map(|i| (i, format!("t{i}"))).collect();
    let refs: Vec<(usize, &str)> = texts.iter().map(|(i, t)| (*i, t.as_str())).collect();
    let (contract, drafts) = world(10, &refs, true);
    let turns: Vec<String> = (0..10).map(|i| t(&format!("p{i}"), 0)).collect();
    let s = ReflectionStructure::from_json(&structure(
        "sequential",
        &format!(r#"[{{"id":"r","turns":[{}]}}]"#, turns.join(",")),
    ))
    .unwrap();
    let ids = active(10);
    let active: Vec<&str> = ids.iter().map(String::as_str).collect();
    let order = s
        .reading_order_for(&contract, &drafts, "p0", &active)
        .unwrap();
    let table = ReflectionStructure::placements(ReflectionLayout::Roundtable, &order);
    assert_eq!(
        table.iter().map(|p| p.lane).collect::<Vec<_>>(),
        (0..10).collect::<Vec<_>>()
    );
    let pc = ReflectionStructure::placements(ReflectionLayout::PointCounterpoint, &order);
    // Ten voices are one column, not the first speaker against nine others.
    assert!(pc.iter().all(|p| p.lane == 0 && p.lanes == 1));
    let alt = ReflectionStructure::placements(ReflectionLayout::AlternatingDialogue, &order);
    assert_eq!(
        alt.iter().map(|p| p.lane).collect::<Vec<_>>(),
        [0, 1, 0, 1, 0, 1, 0, 1, 0, 1]
    );
    let seq = ReflectionStructure::placements(ReflectionLayout::Sequential, &order);
    assert!(seq.iter().all(|p| p.lanes == 1));
}

#[test]
fn single_participant_reads_their_own_draft_unrevealed() {
    let (contract, drafts) = world(1, &[(0, "solo")], false);
    let s = ReflectionStructure::from_json(&structure(
        "sequential",
        &format!(r#"[{{"id":"r","turns":[{}]}}]"#, t("p0", 0)),
    ))
    .unwrap();
    assert_eq!(
        read(&s, &contract, &drafts, 1)[0].2.as_deref(),
        Some("solo")
    );
}

#[test]
fn long_content_is_carried_unchanged_and_structure_is_bounded() {
    let long = "word ".repeat(10_000);
    let (contract, drafts) = world(2, &[(0, &long), (1, "short")], true);
    let s = ReflectionStructure::from_json(&structure(
        "sequential",
        &format!(r#"[{{"id":"r","turns":[{}]}}]"#, t("p0", 0)),
    ))
    .unwrap();
    assert_eq!(
        read(&s, &contract, &drafts, 2)[0].2.as_deref(),
        Some(long.as_str())
    );
    let big_prompt = "x".repeat(1_001);
    assert!(ReflectionStructure::from_json(&structure(
        "sequential",
        &format!(
            r#"[{{"id":"r","roundPrompt":"{big_prompt}","turns":[{}]}}]"#,
            t("p0", 0)
        )
    ))
    .is_err());
    let many: Vec<String> = (0..201)
        .map(|i| format!(r#"{{"id":"r{i}","turns":[{}]}}"#, t(&format!("c{i}"), 0)))
        .collect();
    assert!(ReflectionStructure::from_json(&structure(
        "sequential",
        &format!("[{}]", many.join(","))
    ))
    .is_err());
    assert!(ReflectionStructure::from_json(&structure(
        "sequential",
        &format!(r#"[{{"id":"r","turns":[{}]}}]"#, t("p0", 1_000))
    ))
    .is_err());
    let huge = format!(
        r#"{{"version":1,"revision":1,"layout":"sequential","rounds":[],"pad":"{}"}}"#,
        "x".repeat(200_000)
    );
    assert!(ReflectionStructure::from_json(&huge).is_err());
}

#[test]
fn identity_and_positional_fields_are_forbidden() {
    for field in [
        r#""left":"p0""#,
        r#""right":"p1""#,
        r#""authorA":"p0""#,
        r#""gender":"f""#,
        r#""pronouns":"she""#,
        r#""side":"left""#,
        r#""participantId":"p0""#,
        r#""contributionId":"p0""#,
        r#""author":"p0""#,
    ] {
        let turn_level = format!(r#"[{{"id":"r","turns":[{{"draft":"p0","part":0,{field}}}]}}]"#);
        let round_level = format!(r#"[{{"id":"r",{field},"turns":[{}]}}]"#, t("p0", 0));
        let top =
            format!(r#"{{"version":1,"revision":1,"layout":"sequential",{field},"rounds":[]}}"#);
        assert!(
            ReflectionStructure::from_json(&structure("sequential", &turn_level)).is_err(),
            "{field}"
        );
        assert!(
            ReflectionStructure::from_json(&structure("sequential", &round_level)).is_err(),
            "{field}"
        );
        assert!(ReflectionStructure::from_json(&top).is_err(), "{field}");
    }
    // Positional or gendered layout names are not modes.
    for layout in ["leftRight", "herHim", "left"] {
        assert!(ReflectionStructure::from_json(&structure(layout, "[]")).is_err());
    }
}

#[test]
fn untrusted_values_fail_with_one_opaque_error() {
    let bad = [
        r#"[{"id":"r","turns":[]}]"#.to_string(),
        format!(r#"[{{"id":"r","turns":[{},{}]}}]"#, t("p0", 0), t("P0", 0)),
        format!(
            r#"[{{"id":"r","turns":[{}]}},{{"id":"R","turns":[{}]}}]"#,
            t("p0", 0),
            t("p1", 0)
        ),
        format!(r#"[{{"id":"has space","turns":[{}]}}]"#, t("p0", 0)),
        format!(r#"[{{"id":"r","turns":[{}]}}]"#, t("<script>", 0)),
        format!(
            r#"[{{"id":"r","turns":[{}]}}]"#,
            t("https://x.test/?token=s3cret", 0)
        ),
        format!(
            r#"[{{"id":"r","roundPrompt":"a\u202eb","turns":[{}]}}]"#,
            t("p0", 0)
        ),
        format!(
            r#"[{{"id":"r","roundPrompt":"line\nbreak","turns":[{}]}}]"#,
            t("p0", 0)
        ),
        format!(
            r#"[{{"id":"r","roundPrompt":"   ","turns":[{}]}}]"#,
            t("p0", 0)
        ),
        r#"[{"id":"r","turns":[{"draft":"p0"}]}]"#.to_string(),
    ];
    for rounds in bad {
        let err = ReflectionStructure::from_json(&structure("sequential", &rounds)).unwrap_err();
        let text = format!("{err} {err:?}");
        assert!(!text.contains("s3cret") && !text.contains("script"));
    }
    assert!(ReflectionStructure::from_json("not json").is_err());
}

#[test]
fn one_draft_may_fill_several_parts() {
    let ok = format!(r#"[{{"id":"r","turns":[{},{}]}}]"#, t("p0", 1), t("p0", 0));
    ReflectionStructure::from_json(&structure("sequential", &ok)).unwrap();
}

#[test]
fn unresolvable_turns_return_nothing_and_leak_nothing() {
    let (contract, drafts) = world(2, &[(0, "SECRET prose")], false);
    let ids = active(2);
    let active: Vec<&str> = ids.iter().map(String::as_str).collect();
    let stranger = ReflectionStructure::from_json(&structure(
        "sequential",
        &format!(
            r#"[{{"id":"r","turns":[{},{}]}}]"#,
            t("p0", 0),
            t("gone", 0)
        ),
    ))
    .unwrap();
    let err = stranger
        .reading_order_for(&contract, &drafts, "p0", &active)
        .unwrap_err();
    let text = format!("{err} {err:?}");
    assert!(!text.contains("SECRET") && !text.contains("gone"));
    // A part the readable draft does not have is the same failure as a missing participant.
    let missing_part = ReflectionStructure::from_json(&structure(
        "sequential",
        &format!(r#"[{{"id":"r","turns":[{},{}]}}]"#, t("p0", 0), t("p0", 1)),
    ))
    .unwrap();
    let err = missing_part
        .reading_order_for(&contract, &drafts, "p0", &active)
        .unwrap_err();
    assert!(!format!("{err} {err:?}").contains("SECRET"));
}

#[test]
fn markdown_is_carried_verbatim_not_interpreted() {
    let hostile = "# heading\n<script>alert(1)</script> [x](javascript:alert(1))";
    let (contract, drafts) = world(1, &[(0, hostile)], false);
    let s = ReflectionStructure::from_json(&structure(
        "sequential",
        &format!(r#"[{{"id":"r","turns":[{}]}}]"#, t("p0", 0)),
    ))
    .unwrap();
    assert_eq!(
        read(&s, &contract, &drafts, 1)[0].2.as_deref(),
        Some(hostile)
    );
}

#[test]
fn replacement_is_revision_checked_and_never_partial() {
    let base = ReflectionStructure::from_json(&structure("sequential", &rounds())).unwrap();
    let next = format!(
        r#"{{"version":1,"revision":2,"layout":"roundtable","rounds":[{{"id":"r1","turns":[{}]}}]}}"#,
        t("p0", 0)
    );
    let ok = base.replace_from_json(&next, 1).unwrap();
    assert_eq!(ok.layout, ReflectionLayout::Roundtable);
    assert!(
        base.replace_from_json(&next, 2).is_err(),
        "stale expectation"
    );
    assert!(base
        .replace_from_json(&next.replace("\"revision\":2", "\"revision\":5"), 1)
        .is_err());
    assert!(base
        .replace_from_json(&next.replace("p0", "bad id"), 1)
        .is_err());
    assert_eq!(base.layout, ReflectionLayout::Sequential);
}

#[test]
fn structure_round_trips_as_json() {
    let base =
        ReflectionStructure::from_json(&structure("alternatingDialogue", &rounds())).unwrap();
    let again = ReflectionStructure::from_json(&serde_json::to_string(&base).unwrap()).unwrap();
    assert_eq!(base, again);
}

#[test]
fn parts_split_only_at_the_exact_marker_line_and_change_nothing() {
    assert_eq!(
        split_parts("no marker\n---\n* * *"),
        ["no marker\n---\n* * *"]
    );
    assert_eq!(split_parts(""), [""]);
    // Not a marker: indented, trailing space, inline, or a thematic break.
    for near in [
        format!(" {MARK}\n"),
        format!("{MARK} \n"),
        format!("text {MARK}\n"),
        "---\n".to_string(),
    ] {
        assert_eq!(split_parts(&near).len(), 1, "{near:?}");
    }
    // CRLF and a final line without a newline both split.
    let crlf = format!("a\r\n{MARK}\r\nb\r\n{MARK}");
    assert_eq!(split_parts(&crlf), ["a\r\n", "b\r\n", ""]);
    // Deterministic, and the draft is recoverable byte for byte.
    for source in [
        format!("{MARK}\nx\n{MARK}\n{MARK}\ny"),
        format!("a\n{MARK}\nb"),
    ] {
        let parts = split_parts(&source);
        assert_eq!(parts, split_parts(&source));
        assert!(parts.iter().all(|p| !p.contains(MARK)));
        assert_eq!(parts.join(&format!("{PART_MARKER}\n")), source);
    }
}

#[test]
fn reading_never_changes_a_draft_so_approval_digests_hold() {
    let text = format!("one\n{MARK}\ntwo");
    let (contract, drafts) = world(2, &[(0, &text), (1, "b")], true);
    let before = drafts.view("p0", "p0", &["p0", "p1"]).unwrap();
    let s = ReflectionStructure::from_json(&structure(
        "sequential",
        &format!(r#"[{{"id":"r","turns":[{},{}]}}]"#, t("p0", 0), t("p0", 1)),
    ))
    .unwrap();
    let order = read(&s, &contract, &drafts, 2);
    let after = drafts.view("p0", "p0", &["p0", "p1"]).unwrap();
    assert_eq!(before.stamp.digest, after.stamp.digest);
    assert_eq!(after.markdown, text);
    assert!(order
        .iter()
        .all(|(_, _, m)| !m.as_deref().unwrap_or("").contains(PART_MARKER)));
}

#[test]
fn scoped_order_gives_one_identical_placeholder_for_everything_unreadable() {
    // p1 never shares, p2 wrote then withdrew, p3 wrote nothing, p0 has a blank part, and p4
    // exchanges only with p0.
    let blank = format!("{MARK}\nreal");
    let (contract, mut drafts) = world(
        5,
        &[
            (0, &blank),
            (1, "SECRET one"),
            (2, "SECRET two"),
            (4, "four"),
        ],
        false,
    );
    drafts.withdraw("p2", "p2").unwrap();
    drafts.open_exchange("p0", "x", &["p0", "p4"]).unwrap();
    drafts.commit("p0", "x", "p0", 1).unwrap();
    drafts.commit("p4", "x", "p4", 1).unwrap();
    let s = ReflectionStructure::from_json(&structure(
        "sequential",
        &format!(
            r#"[{{"id":"r","turns":[{},{},{},{},{},{}]}}]"#,
            t("p0", 0),
            t("p1", 0),
            t("p2", 0),
            t("p3", 0),
            t("p4", 0),
            t("p0", 1)
        ),
    ))
    .unwrap();
    let ids = active(5);
    let active: Vec<&str> = ids.iter().map(String::as_str).collect();
    let order = s
        .reading_order_for(&contract, &drafts, "p0", &active)
        .unwrap();
    let markdown: Vec<Option<&str>> = order.iter().map(|e| e.markdown.as_deref()).collect();
    // p0's blank part, p1 (unshared), p2 (withdrawn) and p3 (nothing) are all None.
    assert_eq!(
        markdown,
        [None, None, None, None, Some("four"), Some("real")]
    );
    assert!(!format!("{order:?}").contains("SECRET"));
    // A participant who wrote nothing and was shown nothing reads only placeholders.
    let from_p3 = s
        .reading_order_for(&contract, &drafts, "p3", &active)
        .unwrap();
    assert!(from_p3.iter().all(|e| e.markdown.is_none()));
    // A requester outside the draft set reads nothing and learns nothing.
    let outsider = s
        .reading_order_for(&contract, &drafts, "nobody", &active)
        .unwrap();
    assert!(outsider.iter().all(|e| e.markdown.is_none()));
}

#[test]
fn unreadable_drafts_do_not_reveal_their_part_counts() {
    let (contract, drafts) = world(2, &[(0, "a"), (1, &format!("x\n{MARK}\ny"))], false);
    let s = ReflectionStructure::from_json(&structure(
        "sequential",
        &format!(r#"[{{"id":"r","turns":[{},{}]}}]"#, t("p0", 0), t("p1", 7)),
    ))
    .unwrap();
    let ids = active(2);
    let active: Vec<&str> = ids.iter().map(String::as_str).collect();
    let order = s
        .reading_order_for(&contract, &drafts, "p0", &active)
        .unwrap();
    assert!(order[1].markdown.is_none());
}

#[test]
fn binding_frame_changes_with_order_round_prompts_parts_and_layout() {
    let base = ReflectionStructure::from_json(&structure("sequential", &rounds())).unwrap();
    let frame = base.binding_frame();
    assert_eq!(frame, base.binding_frame());
    assert_eq!(frame.len(), 64);
    let variants = [
        base.with_layout(ReflectionLayout::Roundtable),
        {
            let mut v = base.clone();
            v.rounds[0].turns.swap(0, 1);
            v
        },
        {
            let mut v = base.clone();
            v.rounds[0].round_prompt = Some("Another question?".into());
            v
        },
        {
            let mut v = base.clone();
            v.rounds[0].round_prompt = None;
            v
        },
        {
            let mut v = base.clone();
            v.rounds[1].turns[1].part = 2;
            v
        },
        {
            let mut v = base.clone();
            v.rounds[1].id = "other".into();
            v
        },
        {
            let mut v = base.clone();
            v.rounds.swap(0, 1);
            v
        },
        {
            let mut v = base.clone();
            let moved = v.rounds[0].turns.pop().unwrap();
            v.rounds[1].turns.push(moved);
            v
        },
    ];
    for variant in variants {
        assert_ne!(variant.binding_frame(), frame);
    }
    // Only the revision counter is outside the binding, and prose never enters it.
    let mut bumped = base.clone();
    bumped.revision += 1;
    assert_eq!(bumped.binding_frame(), frame);
}

#[test]
fn turn_labels_are_optional_short_single_line_text_and_part_of_the_binding() {
    let plain = ReflectionStructure::from_json(&structure("pointCounterpoint", &rounds())).unwrap();
    // An absent label is not written back, so the stored text and the digest of an arrangement
    // without labels are what they were before labels existed.
    assert!(plain.rounds[0].turns[0].label.is_none());
    assert!(!serde_json::to_string(&plain).unwrap().contains("label"));
    let mut labelled = plain.clone();
    labelled.rounds[0].turns[0].label = Some("Point".into());
    assert_ne!(labelled.binding_frame(), plain.binding_frame());
    let mut renamed = labelled.clone();
    renamed.rounds[0].turns[0].label = Some("Counterpoint".into());
    assert_ne!(renamed.binding_frame(), labelled.binding_frame());
    let json = |label: &str| {
        structure(
            "pointCounterpoint",
            &format!(
                r#"[{{"id":"r1","turns":[{{"draft":"p0","part":0,"label":{}}}]}}]"#,
                serde_json::to_string(label).unwrap()
            ),
        )
    };
    assert!(ReflectionStructure::from_json(&json("Point")).is_ok());
    assert!(ReflectionStructure::from_json(&json("Réplique 反論 رد")).is_ok());
    for bad in [
        "",
        "   ",
        "two\nlines",
        "\u{202e}flip",
        "\u{0}",
        &"x".repeat(81),
    ] {
        assert!(
            ReflectionStructure::from_json(&json(bad)).is_err(),
            "{bad:?}"
        );
    }
    // Neither a side nor a gender is a field of a turn.
    let sided = structure(
        "pointCounterpoint",
        r#"[{"id":"r1","turns":[{"draft":"p0","part":0,"side":"left"}]}]"#,
    );
    assert!(ReflectionStructure::from_json(&sided).is_err());
}

#[test]
fn point_counterpoint_and_dialogue_use_only_the_lanes_that_are_present() {
    use openblog_core::reflection::ReadingEntry;
    let entry = |id| ReadingEntry {
        ordinal: 0,
        round: 0,
        round_id: "r",
        round_prompt: None,
        label: None,
        participant_id: id,
        display_name: id,
        draft_id: id,
        part: 0,
        markdown: Some("x".into()),
    };
    let one = [entry("a")];
    for layout in [
        ReflectionLayout::PointCounterpoint,
        ReflectionLayout::AlternatingDialogue,
    ] {
        assert!(ReflectionStructure::placements(layout, &one)
            .iter()
            .all(|p| p.lanes == 1));
    }
    // One voice answering twice has one lane in both layouts, and a dialogue does not stagger an
    // author's own consecutive turns.
    let same = [entry("a"), entry("a")];
    assert!(
        ReflectionStructure::placements(ReflectionLayout::PointCounterpoint, &same)
            .iter()
            .all(|p| p.lanes == 1 && p.lane == 0)
    );
    assert!(
        ReflectionStructure::placements(ReflectionLayout::AlternatingDialogue, &same)
            .iter()
            .all(|p| p.lanes == 1 && p.lane == 0)
    );
    let lanes = |layout, ids: &[&'static str]| {
        let entries: Vec<_> = ids.iter().map(|id| entry(id)).collect();
        ReflectionStructure::placements(layout, &entries)
            .iter()
            .map(|p| (p.lane, p.lanes))
            .collect::<Vec<_>>()
    };
    // The lane flips only when the speaker changes: a a b a c reads 0 0 1 0 1, and A, B, C puts
    // C on the edge opposite B, not on A's.
    assert_eq!(
        lanes(
            ReflectionLayout::AlternatingDialogue,
            &["a", "a", "b", "a", "c"]
        ),
        [(0, 2), (0, 2), (1, 2), (0, 2), (1, 2)]
    );
    // Three voices are one column; exactly two are two columns by first appearance.
    assert_eq!(
        lanes(ReflectionLayout::PointCounterpoint, &["a", "b", "c", "b"]),
        [(0, 1); 4]
    );
    assert_eq!(
        lanes(ReflectionLayout::PointCounterpoint, &["b", "a", "b"]),
        [(0, 2), (1, 2), (0, 2)]
    );
}
