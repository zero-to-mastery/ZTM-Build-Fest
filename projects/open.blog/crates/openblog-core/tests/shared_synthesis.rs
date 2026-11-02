//! Shared synthesis items: optional kinds, attribution to one, some or all authors, disagreement
//! never an error, withdrawal, reordering, revision-bound approval, and safe failure.

use openblog_core::approval::{
    ApprovalPolicy, ApprovalRequirement, ApprovalSet, ApprovalSubject, Readiness, Section,
};
use openblog_core::synthesis::{
    NewSynthesisItem, SynthesisEdit, SynthesisError, SynthesisKind, SynthesisSet,
    MAX_SYNTHESIS_ITEMS, MAX_SYNTHESIS_MARKDOWN_BYTES,
};

const AUTHORS: [&str; 4] = ["ann", "bo", "cy", "di"];

fn item(
    kind: SynthesisKind,
    text: &'static str,
    others: &'static [&'static str],
) -> NewSynthesisItem<'static> {
    NewSynthesisItem {
        kind,
        markdown: text,
        others,
    }
}

#[test]
fn an_empty_synthesis_is_valid_and_changes_nothing_for_approval() {
    let set = SynthesisSet::new();
    assert!(set.is_empty());
    assert!(set.binding_frame().is_empty());
    assert_eq!(set.view("ann", &AUTHORS).unwrap().len(), 0);
    let round = SynthesisSet::from_json(&set.to_json()).unwrap();
    assert_eq!(round, set);
}

#[test]
fn no_kind_is_mandatory_and_any_single_kind_stands_alone() {
    for kind in [
        SynthesisKind::Agreement,
        SynthesisKind::Difference,
        SynthesisKind::Question,
        SynthesisKind::Application,
        SynthesisKind::Uncertainty,
    ] {
        let mut set = SynthesisSet::new();
        set.add("ann", &AUTHORS, 0, item(kind, "Only this.", &[]))
            .unwrap();
        assert_eq!(set.view("ann", &AUTHORS).unwrap()[0].kind(), kind);
    }
}

#[test]
fn an_item_speaks_for_one_some_or_all_in_order() {
    let mut set = SynthesisSet::new();
    set.add(
        "ann",
        &AUTHORS,
        0,
        item(SynthesisKind::Agreement, "One.", &[]),
    )
    .unwrap();
    set.add(
        "bo",
        &AUTHORS,
        1,
        item(SynthesisKind::Question, "Some.", &["di", "ann"]),
    )
    .unwrap();
    set.add(
        "cy",
        &AUTHORS,
        2,
        item(SynthesisKind::Application, "All.", &["bo", "ann", "di"]),
    )
    .unwrap();
    let items = set.view("di", &AUTHORS).unwrap();
    assert_eq!(items[0].contributors(), ["ann"]);
    assert_eq!(items[1].contributors(), ["bo", "di", "ann"]);
    assert_eq!(items[2].contributors(), ["cy", "bo", "ann", "di"]);
}

#[test]
fn disagreement_and_overlapping_groups_are_never_an_error() {
    let mut set = SynthesisSet::new();
    set.add(
        "ann",
        &AUTHORS,
        0,
        item(
            SynthesisKind::Agreement,
            "We all liked it.",
            &["bo", "cy", "di"],
        ),
    )
    .unwrap();
    // Contradicting statements, overlapping groups, same text, opposite claims.
    set.add(
        "ann",
        &AUTHORS,
        1,
        item(SynthesisKind::Difference, "It works.", &["bo"]),
    )
    .unwrap();
    set.add(
        "cy",
        &AUTHORS,
        2,
        item(
            SynthesisKind::Difference,
            "It does not work.",
            &["di", "bo"],
        ),
    )
    .unwrap();
    set.add(
        "di",
        &AUTHORS,
        3,
        item(SynthesisKind::Uncertainty, "It does not work.", &[]),
    )
    .unwrap();
    assert_eq!(set.view("ann", &AUTHORS).unwrap().len(), 4);
}

#[test]
fn withdrawal_removes_only_the_requesters_name_and_drops_orphans() {
    let mut set = SynthesisSet::new();
    let id = set
        .add(
            "ann",
            &AUTHORS,
            0,
            item(SynthesisKind::Agreement, "Shared.", &["bo", "cy"]),
        )
        .unwrap();
    set.withdraw("bo", &AUTHORS, 1, &id).unwrap();
    assert_eq!(
        set.view("ann", &AUTHORS).unwrap()[0].contributors(),
        ["ann", "cy"]
    );
    // Bo is no longer attributed, so cannot touch or withdraw again, and cannot tell why.
    assert_eq!(
        set.withdraw("bo", &AUTHORS, 2, &id),
        Err(SynthesisError::Denied)
    );
    assert_eq!(
        set.withdraw("bo", &AUTHORS, 2, "syn-99"),
        Err(SynthesisError::Denied)
    );
    set.withdraw("ann", &AUTHORS, 2, &id).unwrap();
    set.withdraw("cy", &AUTHORS, 3, &id).unwrap();
    assert!(set.is_empty());
}

#[test]
fn reordering_needs_every_item_once_and_changes_the_binding() {
    let mut set = SynthesisSet::new();
    let a = set
        .add(
            "ann",
            &AUTHORS,
            0,
            item(SynthesisKind::Agreement, "A.", &[]),
        )
        .unwrap();
    let b = set
        .add("ann", &AUTHORS, 1, item(SynthesisKind::Question, "B.", &[]))
        .unwrap();
    let c = set
        .add(
            "ann",
            &AUTHORS,
            2,
            item(SynthesisKind::Difference, "C.", &[]),
        )
        .unwrap();
    let before = set.binding_frame();
    for bad in [
        vec![a.as_str(), b.as_str()],
        vec![a.as_str(), a.as_str(), b.as_str()],
        vec![a.as_str(), b.as_str(), "x"],
    ] {
        let snapshot = set.clone();
        assert_eq!(
            set.reorder("bo", &AUTHORS, 3, &bad),
            Err(SynthesisError::Invalid)
        );
        assert_eq!(set, snapshot);
    }
    set.reorder("bo", &AUTHORS, 3, &[&c, &a, &b]).unwrap();
    let ids: Vec<_> = set
        .view("ann", &AUTHORS)
        .unwrap()
        .iter()
        .map(|i| i.id().to_owned())
        .collect();
    assert_eq!(ids, [c, a, b]);
    assert_ne!(set.binding_frame(), before);
}

#[test]
fn editing_is_for_attributed_authors_and_only_grows_attribution() {
    let mut set = SynthesisSet::new();
    let id = set
        .add(
            "ann",
            &AUTHORS,
            0,
            item(SynthesisKind::Agreement, "Draft.", &[]),
        )
        .unwrap();
    let edit = SynthesisEdit {
        markdown: Some("Better."),
        add_contributors: &["bo"],
        ..SynthesisEdit::default()
    };
    assert_eq!(
        set.edit("cy", &AUTHORS, 1, &id, edit),
        Err(SynthesisError::Denied)
    );
    set.edit("ann", &AUTHORS, 1, &id, edit).unwrap();
    let shown = &set.view("bo", &AUTHORS).unwrap()[0];
    assert_eq!(
        (shown.markdown(), shown.contributors(), shown.revision()),
        ("Better.", &["ann".to_string(), "bo".to_string()][..], 2)
    );
    // A no-op edit changes nothing, not even the revision.
    let rev = set.revision();
    set.edit("ann", &AUTHORS, rev, &id, SynthesisEdit::default())
        .unwrap();
    assert_eq!(set.revision(), rev);
}

#[test]
fn concurrent_state_is_refused_and_nothing_changes() {
    let mut set = SynthesisSet::new();
    set.add(
        "ann",
        &AUTHORS,
        0,
        item(SynthesisKind::Agreement, "A.", &[]),
    )
    .unwrap();
    let snapshot = set.clone();
    assert_eq!(
        set.add("bo", &AUTHORS, 0, item(SynthesisKind::Question, "B.", &[])),
        Err(SynthesisError::Stale)
    );
    assert_eq!(set, snapshot);
}

#[test]
fn outsiders_and_bad_input_fail_without_changing_or_exposing_anything() {
    let mut set = SynthesisSet::new();
    set.add(
        "ann",
        &AUTHORS,
        0,
        item(SynthesisKind::Agreement, "Secret prose.", &[]),
    )
    .unwrap();
    let snapshot = set.clone();
    // Not an author: no view, no write, and the same refusal either way.
    assert_eq!(
        set.view("mallory", &AUTHORS).err(),
        Some(SynthesisError::Denied)
    );
    assert_eq!(
        set.add(
            "mallory",
            &AUTHORS,
            1,
            item(SynthesisKind::Agreement, "x", &[])
        ),
        Err(SynthesisError::Denied)
    );
    // Attributing a non-author, a duplicate, the requester twice, or a path-like id.
    for others in [&["mallory"][..], &["bo", "bo"], &["ann"], &["../x"]] {
        assert_eq!(
            set.add(
                "ann",
                &AUTHORS,
                1,
                NewSynthesisItem {
                    kind: SynthesisKind::Question,
                    markdown: "x",
                    others
                }
            ),
            Err(SynthesisError::Invalid)
        );
    }
    let big = "x".repeat(MAX_SYNTHESIS_MARKDOWN_BYTES + 1);
    for text in [
        "",
        "   \n",
        "nul\0byte",
        "esc\u{1b}[31m",
        "line\u{2028}sep",
        big.as_str(),
    ] {
        assert_eq!(
            set.add(
                "ann",
                &AUTHORS,
                1,
                NewSynthesisItem {
                    kind: SynthesisKind::Question,
                    markdown: text,
                    others: &[]
                }
            ),
            Err(SynthesisError::Invalid),
            "{text:?}"
        );
    }
    assert_eq!(set, snapshot);
}

#[test]
fn untrusted_markdown_is_kept_verbatim_as_data() {
    let hostile = "<script>alert(1)</script> [x](javascript:alert(1)) ![t](https://tracker.example/p.png)\n\ttoken=abc";
    let mut set = SynthesisSet::new();
    set.add(
        "ann",
        &AUTHORS,
        0,
        item(SynthesisKind::Application, hostile, &[]),
    )
    .unwrap();
    let json = set.to_json();
    let loaded = SynthesisSet::from_json(&json).unwrap();
    assert_eq!(loaded.view("ann", &AUTHORS).unwrap()[0].markdown(), hostile);
    // The approval frame carries digests only, never prose or URLs.
    for value in set.binding_frame() {
        assert!(
            !value.contains("script") && !value.contains("tracker") && !value.contains("token")
        );
    }
}

#[test]
fn the_item_count_is_bounded() {
    let mut set = SynthesisSet::new();
    for n in 0..MAX_SYNTHESIS_ITEMS {
        set.add(
            "ann",
            &AUTHORS,
            n as u64,
            item(SynthesisKind::Question, "Q.", &[]),
        )
        .unwrap();
    }
    assert_eq!(
        set.add(
            "ann",
            &AUTHORS,
            MAX_SYNTHESIS_ITEMS as u64,
            item(SynthesisKind::Question, "Q.", &[])
        ),
        Err(SynthesisError::Invalid)
    );
}

#[test]
fn stored_sets_are_strict() {
    let good = SynthesisSet::new().to_json();
    assert!(SynthesisSet::from_json(&good).is_ok());
    for bad in [
        "{}",
        r#"{"version":2}"#,
        r#"{"version":1,"extra":true}"#,
        r#"{"version":1,"items":[{"id":"a","kind":"consensus","markdown":"x","contributors":["ann"],"revision":1}]}"#,
        r#"{"version":1,"items":[{"id":"a","kind":"question","markdown":"x","contributors":[],"revision":1}]}"#,
        r#"{"version":1,"items":[{"id":"a","kind":"question","markdown":"x","contributors":["ann","ANN"],"revision":1}]}"#,
        r#"{"version":1,"items":[{"id":"a","kind":"question","markdown":"x","contributors":["ann"],"revision":1},{"id":"A","kind":"question","markdown":"x","contributors":["ann"],"revision":1}]}"#,
        r#"{"version":1,"items":[{"id":"..","kind":"question","markdown":"x","contributors":["ann"],"revision":1}]}"#,
    ] {
        assert_eq!(
            SynthesisSet::from_json(bad),
            Err(SynthesisError::Invalid),
            "{bad}"
        );
    }
    assert_eq!(
        SynthesisSet::from_json(&" ".repeat(2 * 1024 * 1024)),
        Err(SynthesisError::Invalid)
    );
}

#[test]
fn removing_an_author_drops_their_attribution_and_orphaned_items() {
    let mut set = SynthesisSet::new();
    set.add(
        "ann",
        &AUTHORS,
        0,
        item(SynthesisKind::Agreement, "Both.", &["bo"]),
    )
    .unwrap();
    set.add(
        "bo",
        &AUTHORS,
        1,
        item(SynthesisKind::Question, "Only bo.", &[]),
    )
    .unwrap();
    assert!(!set.reconcile(&AUTHORS));
    assert!(set.reconcile(&["ann", "cy"]));
    let items = set.view("ann", &["ann", "cy"]).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].contributors(), ["ann"]);
    // Re-adding the author does not restore the old attribution.
    assert!(!set.reconcile(&AUTHORS));
    assert_eq!(
        set.view("ann", &AUTHORS).unwrap()[0].contributors(),
        ["ann"]
    );
}

fn binding(set: &SynthesisSet, approvals: &ApprovalSet, who: &str) -> String {
    let sections = [Section {
        contribution_id: "c1",
        owner: "ann",
        revision: 1,
        digest: "d1",
    }];
    let authors = ["ann", "bo"];
    let frame = set.binding_frame();
    let mut metadata = vec!["Title"];
    metadata.extend(frame.iter().map(String::as_str));
    approvals
        .binding_for(
            &ApprovalSubject {
                authors: &authors,
                sections: &sections,
                metadata: &metadata,
                attributed: &[],
                roles: &[],
            },
            who,
        )
        .unwrap()
}

#[test]
fn approval_binds_to_exact_items_order_and_attribution() {
    let approvals = ApprovalSet::new();
    let mut set = SynthesisSet::new();
    let empty = binding(&set, &approvals, "bo");
    // An empty synthesis binds exactly as a piece that never had one.
    let sections = [Section {
        contribution_id: "c1",
        owner: "ann",
        revision: 1,
        digest: "d1",
    }];
    let plain = approvals
        .binding_for(
            &ApprovalSubject {
                authors: &["ann", "bo"],
                sections: &sections,
                metadata: &["Title"],
                attributed: &[],
                roles: &[],
            },
            "bo",
        )
        .unwrap();
    assert_eq!(empty, plain);

    let authors = ["ann", "bo"];
    let a = set
        .add(
            "ann",
            &authors,
            0,
            item(SynthesisKind::Agreement, "A.", &[]),
        )
        .unwrap();
    let b = set
        .add(
            "ann",
            &authors,
            1,
            item(SynthesisKind::Difference, "B.", &[]),
        )
        .unwrap();
    let mut seen = vec![binding(&set, &approvals, "bo")];
    assert_ne!(seen[0], empty);
    set.reorder("bo", &authors, 2, &[&b, &a]).unwrap();
    seen.push(binding(&set, &approvals, "bo"));
    set.edit(
        "ann",
        &authors,
        3,
        &a,
        SynthesisEdit {
            add_contributors: &["bo"],
            ..SynthesisEdit::default()
        },
    )
    .unwrap();
    seen.push(binding(&set, &approvals, "bo"));
    set.edit(
        "ann",
        &authors,
        4,
        &a,
        SynthesisEdit {
            markdown: Some("A!"),
            ..SynthesisEdit::default()
        },
    )
    .unwrap();
    seen.push(binding(&set, &approvals, "bo"));
    set.withdraw("bo", &authors, 5, &a).unwrap();
    seen.push(binding(&set, &approvals, "bo"));
    let unique: std::collections::HashSet<_> = seen.iter().collect();
    assert_eq!(
        unique.len(),
        seen.len(),
        "every change yields a different binding"
    );
}

#[test]
fn a_standing_approval_goes_stale_when_the_synthesis_changes() {
    let authors = ["ann", "bo"];
    let sections = [Section {
        contribution_id: "c1",
        owner: "ann",
        revision: 1,
        digest: "d1",
    }];
    let mut set = SynthesisSet::new();
    set.add(
        "ann",
        &authors,
        0,
        item(SynthesisKind::Uncertainty, "Maybe.", &[]),
    )
    .unwrap();
    let mut approvals = ApprovalSet::new();
    let subject = |set: &SynthesisSet| {
        let mut metadata = vec!["Title".to_string()];
        metadata.extend(set.binding_frame());
        metadata
    };
    let metadata = subject(&set);
    let refs: Vec<&str> = metadata.iter().map(String::as_str).collect();
    let view = ApprovalSubject {
        authors: &authors,
        sections: &sections,
        metadata: &refs,
        attributed: &[],
        roles: &[],
    };
    for who in authors {
        let seen = approvals.binding_for(&view, who).unwrap();
        approvals
            .approve(who, who, &view, &seen, true, 1_800_000_000)
            .unwrap();
    }
    assert_eq!(approvals.evaluate(&view).unwrap(), Readiness::Ready);

    set.edit(
        "ann",
        &authors,
        1,
        "syn-1",
        SynthesisEdit {
            markdown: Some("Definitely."),
            ..SynthesisEdit::default()
        },
    )
    .unwrap();
    let metadata = subject(&set);
    let refs: Vec<&str> = metadata.iter().map(String::as_str).collect();
    let changed = ApprovalSubject {
        authors: &authors,
        sections: &sections,
        metadata: &refs,
        attributed: &[],
        roles: &[],
    };
    assert!(matches!(
        approvals.evaluate(&changed).unwrap(),
        Readiness::Blocked { .. }
    ));
}

#[test]
fn a_named_author_must_approve_even_under_contributing_authors() {
    let authors = ["ann", "bo"];
    let sections = [Section {
        contribution_id: "c1",
        owner: "ann",
        revision: 1,
        digest: "d1",
    }];
    let mut set = SynthesisSet::new();
    set.add(
        "ann",
        &authors,
        0,
        item(SynthesisKind::Agreement, "Bo agrees with me.", &["bo"]),
    )
    .unwrap();
    let mut approvals = ApprovalSet::new();
    approvals.set_policy(ApprovalPolicy {
        requirement: ApprovalRequirement::ContributingAuthors,
        ..ApprovalPolicy::default()
    });
    let metadata = set.binding_frame();
    let refs: Vec<&str> = metadata.iter().map(String::as_str).collect();
    let attributed = set.attributed_authors();
    let view = ApprovalSubject {
        authors: &authors,
        sections: &sections,
        metadata: &refs,
        attributed: &attributed,
        roles: &[],
    };
    let seen = approvals.binding_for(&view, "ann").unwrap();
    approvals
        .approve("ann", "ann", &view, &seen, true, 1_800_000_000)
        .unwrap();
    assert!(matches!(
        approvals.evaluate(&view).unwrap(),
        Readiness::Blocked { .. }
    ));
    let seen = approvals.binding_for(&view, "bo").unwrap();
    approvals
        .approve("bo", "bo", &view, &seen, true, 1_800_000_000)
        .unwrap();
    assert_eq!(approvals.evaluate(&view).unwrap(), Readiness::Ready);
}

#[test]
fn items_record_partial_approval_per_author() {
    let mut set = SynthesisSet::new();
    set.add(
        "ann",
        &AUTHORS,
        0,
        item(SynthesisKind::Agreement, "Shared.", &["bo"]),
    )
    .unwrap();
    set.add(
        "cy",
        &AUTHORS,
        1,
        item(SynthesisKind::Question, "Mine.", &[]),
    )
    .unwrap();
    let before = set.binding_frame();
    set.approve_item("ann", &AUTHORS, 2, "syn-1").unwrap();
    let status = set.item_approvals("di", &AUTHORS).unwrap();
    assert_eq!(status[0].approved, ["ann"]);
    assert_eq!(status[0].awaiting, ["bo"]);
    assert!(!status[0].is_approved());
    assert!(!set.view("ann", &AUTHORS).unwrap()[0].is_approved());
    set.approve_item("bo", &AUTHORS, 3, "syn-1").unwrap();
    set.approve_item("cy", &AUTHORS, 4, "syn-2").unwrap();
    let status = set.item_approvals("ann", &AUTHORS).unwrap();
    assert!(status.iter().all(|s| s.is_approved()));
    // Repeating an approval changes nothing; item approvals do not move the piece binding.
    let revision = set.revision();
    set.approve_item("bo", &AUTHORS, revision, "syn-1").unwrap();
    assert_eq!(set.revision(), revision);
    assert_eq!(set.binding_frame(), before);
    let round = SynthesisSet::from_json(&set.to_json()).unwrap();
    assert_eq!(round, set);
    assert!(round.view("ann", &AUTHORS).unwrap()[0].is_approved());
}

#[test]
fn any_change_to_an_item_clears_its_approvals_only() {
    let mut set = SynthesisSet::new();
    set.add(
        "ann",
        &AUTHORS,
        0,
        item(SynthesisKind::Agreement, "One.", &["bo"]),
    )
    .unwrap();
    set.add(
        "ann",
        &AUTHORS,
        1,
        item(SynthesisKind::Agreement, "Two.", &["bo"]),
    )
    .unwrap();
    let approve_all = |set: &mut SynthesisSet| {
        for id in ["syn-1", "syn-2"] {
            for who in ["ann", "bo", "cy"] {
                let revision = set.revision();
                // Non-attributed authors are refused; the rest approve.
                let _ = set.approve_item(who, &AUTHORS, revision, id);
            }
        }
    };
    let approved = |set: &SynthesisSet| -> Vec<bool> {
        set.view("ann", &AUTHORS)
            .unwrap()
            .iter()
            .map(|i| i.is_approved())
            .collect()
    };
    approve_all(&mut set);
    assert_eq!(approved(&set), [true, true]);

    let edits = [
        SynthesisEdit {
            markdown: Some("One, changed."),
            ..SynthesisEdit::default()
        },
        SynthesisEdit {
            kind: Some(SynthesisKind::Difference),
            ..SynthesisEdit::default()
        },
        SynthesisEdit {
            add_contributors: &["cy"],
            ..SynthesisEdit::default()
        },
    ];
    for edit in edits {
        let revision = set.revision();
        set.edit("ann", &AUTHORS, revision, "syn-1", edit).unwrap();
        assert_eq!(approved(&set), [false, true]);
        approve_all(&mut set);
    }
    assert_eq!(approved(&set), [true, true]);
    // A no-op edit keeps approvals.
    let revision = set.revision();
    set.edit("ann", &AUTHORS, revision, "syn-1", SynthesisEdit::default())
        .unwrap();
    assert_eq!(approved(&set), [true, true]);

    let revision = set.revision();
    set.withdraw("bo", &AUTHORS, revision, "syn-2").unwrap();
    let status = set.item_approvals("ann", &AUTHORS).unwrap();
    assert!(status[1].approved.is_empty());
    assert_eq!(status[1].awaiting, ["ann"]);

    let revision = set.revision();
    set.approve_item("ann", &AUTHORS, revision, "syn-2")
        .unwrap();
    assert!(set.reconcile(&["ann", "cy", "di"]));
    // syn-1 lost bo, so its approvals are cleared; syn-2 was untouched.
    let status = set.item_approvals("ann", &AUTHORS).unwrap();
    assert!(status[0].approved.is_empty());
    assert!(status[1].is_approved());
}

#[test]
fn only_an_attributed_author_may_approve_an_item_and_a_stale_read_is_refused() {
    let mut set = SynthesisSet::new();
    set.add(
        "ann",
        &AUTHORS,
        0,
        item(SynthesisKind::Agreement, "Mine.", &[]),
    )
    .unwrap();
    let before = set.clone();
    for (who, id) in [("bo", "syn-1"), ("ann", "syn-9"), ("zed", "syn-1")] {
        assert_eq!(
            set.approve_item(who, &AUTHORS, 1, id),
            Err(SynthesisError::Denied),
            "{who} {id}"
        );
    }
    assert_eq!(
        set.item_approvals("zed", &AUTHORS),
        Err(SynthesisError::Denied)
    );
    assert_eq!(
        set.approve_item("ann", &AUTHORS, 0, "syn-1"),
        Err(SynthesisError::Stale)
    );
    assert_eq!(set, before);
}

#[test]
fn the_id_counter_must_cover_stored_ids_and_counters_do_not_overflow() {
    let stored = |id: &str, revision: u64| {
        format!(
            r#"{{"id":"{id}","kind":"question","markdown":"x","contributors":["ann"],"revision":{revision}}}"#
        )
    };
    for bad in [
        format!(r#"{{"version":1,"items":[{}]}}"#, stored("syn-1", 1)),
        format!(
            r#"{{"version":1,"nextId":1,"items":[{}]}}"#,
            stored("syn-2", 1)
        ),
        format!(
            r#"{{"version":1,"nextId":1,"items":[{}]}}"#,
            stored("SYN-2", 1)
        ),
    ] {
        assert_eq!(
            SynthesisSet::from_json(&bad),
            Err(SynthesisError::Invalid),
            "{bad}"
        );
    }
    let ok = format!(
        r#"{{"version":1,"nextId":1,"items":[{}]}}"#,
        stored("syn-1", 1)
    );
    let mut set = SynthesisSet::from_json(&ok).unwrap();
    let id = set
        .add("ann", &AUTHORS, 0, item(SynthesisKind::Question, "y", &[]))
        .unwrap();
    assert_eq!(id, "syn-2");
    assert!(SynthesisSet::from_json(&set.to_json()).is_ok());

    let max = format!(
        r#"{{"version":1,"revision":{},"nextId":{}}}"#,
        u64::MAX,
        u64::MAX
    );
    let mut set = SynthesisSet::from_json(&max).unwrap();
    let before = set.clone();
    assert_eq!(
        set.add(
            "ann",
            &AUTHORS,
            u64::MAX,
            item(SynthesisKind::Question, "y", &[])
        ),
        Err(SynthesisError::Invalid)
    );
    assert_eq!(set, before);

    let maxed = format!(
        r#"{{"version":1,"nextId":1,"items":[{}]}}"#,
        stored("syn-1", u64::MAX)
    );
    let mut set = SynthesisSet::from_json(&maxed).unwrap();
    let before = set.clone();
    let edit = SynthesisEdit {
        markdown: Some("z"),
        ..SynthesisEdit::default()
    };
    assert_eq!(
        set.edit("ann", &AUTHORS, 0, "syn-1", edit),
        Err(SynthesisError::Invalid)
    );
    assert_eq!(
        set.withdraw("ann", &AUTHORS, 0, "syn-1"),
        Err(SynthesisError::Invalid)
    );
    assert_eq!(set, before);
}
