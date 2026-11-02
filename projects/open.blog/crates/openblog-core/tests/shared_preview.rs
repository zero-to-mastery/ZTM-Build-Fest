//! The approval-aware combined preview: mixed states, hostile Markdown, the privacy of unshared
//! prose, and staleness. The preview only reads, so these tests also check that nothing is
//! returned that the requester could not read through the draft module itself.

use openblog_core::approval::{ApprovalPolicy, ApprovalRequirement};
use openblog_core::approval::{ApprovalSet, ApprovalState, ApprovalSubject, Section};
use openblog_core::collaboration::{
    NewParticipant, NewSharedPublication, NewSourceReference, Participant, SharedPublication,
    SourceKind,
};
use openblog_core::config::SiteConfig;
use openblog_core::draft::{DraftSet, RevealPolicy};
use openblog_core::media_moment::MomentSet;
use openblog_core::preview::{CombinedPreview, PreviewError, PREVIEW_CSP};
use openblog_core::SourceFile;

const T: i64 = 1_800_000_000;

/// The preview under the site's own production Markdown options.
fn build_with(
    config: &SiteConfig,
    record: &SharedPublication,
    set: &DraftSet,
    approvals: &ApprovalSet,
    requester: &str,
    active: &[&str],
) -> Result<CombinedPreview, PreviewError> {
    openblog_core::preview::build(
        record,
        None,
        set,
        &openblog_core::synthesis::SynthesisSet::new(),
        &MomentSet::new(),
        approvals,
        requester,
        active,
        true,
        config.render_options(),
    )
}

fn build(
    record: &SharedPublication,
    set: &DraftSet,
    approvals: &ApprovalSet,
    requester: &str,
    active: &[&str],
) -> Result<CombinedPreview, PreviewError> {
    build_with(
        &SiteConfig::default(),
        record,
        set,
        approvals,
        requester,
        active,
    )
}

fn record() -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: "shared-0a1b2c3d4e5f".into(),
        title: "On <attention>".into(),
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
    }
    record
}

fn drafts() -> DraftSet {
    let mut set = DraftSet::new(&["ann", "bo", "cy"]).unwrap();
    set.set_policy(RevealPolicy::Voluntary);
    set
}

const ALL: [&str; 3] = ["ann", "bo", "cy"];

fn subject_for(set: &DraftSet, authors: &[&str]) -> Vec<(String, String, u64, String)> {
    authors
        .iter()
        .filter_map(|id| set.current_stamp(id))
        .map(|s| {
            (
                s.contribution_id,
                s.author_participant_id,
                s.number,
                s.digest,
            )
        })
        .collect()
}

/// Approve for `who` the exact piece `set` holds now, through the token the preview issued.
fn approve(set: &DraftSet, approvals: &mut ApprovalSet, who: &str, authors: &[&str]) {
    let preview = build(&record(), set, approvals, who, authors).unwrap();
    let seen = preview.seen.expect("a complete piece issues a token");
    let sections = subject_for(set, authors);
    let sections: Vec<Section<'_>> = sections
        .iter()
        .map(|(id, owner, revision, digest)| Section {
            contribution_id: id,
            owner,
            revision: *revision,
            digest,
        })
        .collect();
    let metadata = openblog_core::approval::public_metadata(&record());
    let metadata: Vec<&str> = metadata.iter().map(String::as_str).collect();
    let subject = ApprovalSubject {
        authors,
        sections: &sections,
        metadata: &metadata,
        attributed: &[],
        roles: &[],
    };
    approvals
        .approve(who, who, &subject, &seen, true, T)
        .unwrap();
}

#[test]
fn private_prose_is_never_rendered_for_another_author() {
    let mut set = drafts();
    set.save("ann", "ann", 0, "Ann private words", T).unwrap();
    set.save("bo", "bo", 0, "Bo private words", T).unwrap();
    let approvals = ApprovalSet::new();
    let preview = build(&record(), &set, &approvals, "ann", &["ann", "bo"]).unwrap();
    assert!(preview.document.contains("Ann private words"));
    let everything = format!(
        "{}{}",
        preview.document,
        serde_json::to_string(&preview).unwrap()
    );
    assert!(!everything.contains("Bo private words"));
    assert!(!preview.complete && !preview.ready && preview.seen.is_none());
    let bo = &preview.sections[1];
    assert!(!bo.shown && bo.revision.is_none() && bo.errors.is_empty());
    assert!(preview.document.contains("not shared with you"));
}

#[test]
fn a_draft_nobody_wrote_looks_like_a_draft_that_is_not_shared() {
    let mut written = drafts();
    written.save("ann", "ann", 0, "Ann", T).unwrap();
    written.save("bo", "bo", 0, "Bo secret", T).unwrap();
    let mut empty = drafts();
    empty.save("ann", "ann", 0, "Ann", T).unwrap();
    let a = build(
        &record(),
        &written,
        &ApprovalSet::new(),
        "ann",
        &["ann", "bo"],
    )
    .unwrap();
    let b = build(
        &record(),
        &empty,
        &ApprovalSet::new(),
        "ann",
        &["ann", "bo"],
    )
    .unwrap();
    // Per-section output is identical, so a section never says why it is absent. Whether the
    // piece is complete follows the sections that exist (ADR 0021), which is what lets an
    // author who wrote nothing still approve.
    assert_eq!(a.sections, b.sections);
    assert!(!a.complete && a.seen.is_none());
    assert!(b.complete && b.seen.is_some());
}

#[test]
fn an_author_who_wrote_nothing_does_not_block_the_others_approving() {
    let mut set = drafts();
    set.save("ann", "ann", 0, "Ann", T).unwrap();
    set.save("bo", "bo", 0, "Bo words", T).unwrap();
    set.mark_ready("ann", 1, &["ann", "bo", "cy"]).unwrap();
    set.mark_ready("bo", 1, &["ann", "bo", "cy"]).unwrap();
    // Ann and Bo can review and approve although Cy wrote nothing. Cy has no draft to offer, so
    // the reveal rules show Cy nothing and Cy's own preview stays incomplete.
    let mut approvals = ApprovalSet::new();
    let ann = build(&record(), &set, &approvals, "ann", &ALL).unwrap();
    assert!(ann.complete && ann.seen.is_some() && !ann.ready);
    assert!(ann.document.contains("Bo words"));
    let cy = build(&record(), &set, &approvals, "cy", &ALL).unwrap();
    assert!(!cy.complete && cy.seen.is_none());
    assert!(!cy.document.contains("Bo words"));
    approve(&set, &mut approvals, "ann", &ALL);
    approve(&set, &mut approvals, "bo", &ALL);
    assert!(
        !build(&record(), &set, &approvals, "ann", &ALL)
            .unwrap()
            .ready
    );

    // Under contributingAuthors the piece is ready without Cy.
    let mut approvals = ApprovalSet::new();
    approvals.set_policy(ApprovalPolicy {
        requirement: ApprovalRequirement::ContributingAuthors,
        ..ApprovalPolicy::default()
    });
    approve(&set, &mut approvals, "ann", &ALL);
    approve(&set, &mut approvals, "bo", &ALL);
    let ready = build(&record(), &set, &approvals, "ann", &ALL).unwrap();
    assert!(ready.complete && ready.ready);
    assert!(!ready.sections[2].required);
}

#[test]
fn mutual_reveal_shows_the_exact_revision_both_ways_with_approval_states() {
    let mut set = drafts();
    set.save("ann", "ann", 0, "Ann first take", T).unwrap();
    set.save("bo", "bo", 0, "Bo first take", T).unwrap();
    set.mark_ready("ann", 1, &["ann", "bo"]).unwrap();
    set.mark_ready("bo", 1, &["ann", "bo"]).unwrap();
    let mut approvals = ApprovalSet::new();
    let ann = build(&record(), &set, &approvals, "ann", &["ann", "bo"]).unwrap();
    let bo = build(&record(), &set, &approvals, "bo", &["ann", "bo"]).unwrap();
    for preview in [&ann, &bo] {
        assert!(preview.complete && !preview.ready);
        assert!(preview.document.contains("Ann first take"));
        assert!(preview.document.contains("Bo first take"));
        assert!(preview
            .sections
            .iter()
            .all(|s| s.shown && s.revision == Some(1)));
        assert!(preview
            .sections
            .iter()
            .all(|s| s.approval == ApprovalState::Awaiting && s.required));
    }
    // Section order is participant order, and the document leads with the preview marking.
    let first = ann.document.find("Ann first take").unwrap();
    assert!(first < ann.document.find("Bo first take").unwrap());
    assert!(ann.document.contains("Preview, not published."));
    assert!(ann.document.contains("noindex"));

    approve(&set, &mut approvals, "ann", &["ann", "bo"]);
    let mid = build(&record(), &set, &approvals, "bo", &["ann", "bo"]).unwrap();
    assert_eq!(mid.sections[0].approval, ApprovalState::Approved);
    assert_eq!(mid.sections[1].approval, ApprovalState::Awaiting);
    assert!(!mid.ready);
    approve(&set, &mut approvals, "bo", &["ann", "bo"]);
    let done = build(&record(), &set, &approvals, "ann", &["ann", "bo"]).unwrap();
    assert!(done.ready);
    assert!(done.document.contains("Every required author has approved"));
}

#[test]
fn an_edit_after_approval_is_flagged_stale_and_blocks_ready() {
    let mut set = drafts();
    set.save("ann", "ann", 0, "Ann", T).unwrap();
    set.save("bo", "bo", 0, "Bo", T).unwrap();
    set.mark_ready("ann", 1, &["ann", "bo"]).unwrap();
    set.mark_ready("bo", 1, &["ann", "bo"]).unwrap();
    let mut approvals = ApprovalSet::new();
    approve(&set, &mut approvals, "ann", &["ann", "bo"]);
    approve(&set, &mut approvals, "bo", &["ann", "bo"]);
    set.save("bo", "bo", 1, "Bo changed her mind", T).unwrap();
    // Bo's new revision is not offered, so Ann cannot see it: her view hides Bo's section and
    // nothing of it leaks, but both approvals are flagged as no longer counting.
    let ann = build(&record(), &set, &approvals, "ann", &["ann", "bo"]).unwrap();
    assert_eq!(ann.sections[1].approval, ApprovalState::Stale);
    assert!(!ann.sections[1].shown && !ann.complete && !ann.ready);
    assert!(!ann.document.contains("changed her mind"));
    assert!(ann.document.contains("out of date"));
    // Bo sees their own latest revision.
    let bo = build(&record(), &set, &approvals, "bo", &["ann", "bo"]).unwrap();
    assert!(bo.sections[1].shown && bo.sections[1].revision == Some(2));
    assert_eq!(bo.sections[1].approval, ApprovalState::Stale);
    assert!(!bo.ready);
}

#[test]
fn someone_who_left_or_was_withdrawn_is_not_in_the_preview() {
    let mut set = drafts();
    set.save("ann", "ann", 0, "Ann", T).unwrap();
    set.save("bo", "bo", 0, "Bo words", T).unwrap();
    set.save("cy", "cy", 0, "Cy secret", T).unwrap();
    set.mark_ready("ann", 1, &["ann", "bo"]).unwrap();
    set.mark_ready("bo", 1, &["ann", "bo"]).unwrap();
    // Cy is not an active author: no preview for Cy, and no section about Cy for Ann.
    assert_eq!(
        build(&record(), &set, &ApprovalSet::new(), "cy", &["ann", "bo"]).unwrap_err(),
        PreviewError::Denied
    );
    let ann = build(&record(), &set, &ApprovalSet::new(), "ann", &["ann", "bo"]).unwrap();
    assert_eq!(ann.sections.len(), 2);
    assert!(!ann.document.contains("Cy"));
    // Once Bo withdraws, Ann no longer sees Bo's prose.
    set.withdraw("bo", "bo").unwrap();
    let ann = build(&record(), &set, &ApprovalSet::new(), "ann", &["ann", "bo"]).unwrap();
    assert!(!ann.sections[1].shown);
    assert!(!ann.document.contains("Bo words"));
}

#[test]
fn a_non_participant_or_unknown_id_is_denied() {
    let set = drafts();
    for who in ["", "nobody", "ANN", "ann "] {
        assert_eq!(
            build(&record(), &set, &ApprovalSet::new(), who, &ALL).unwrap_err(),
            PreviewError::Denied
        );
    }
}

#[test]
fn hostile_markdown_cannot_run_or_fetch_anything_in_the_preview() {
    let mut set = drafts();
    set.save(
        "ann",
        "ann",
        0,
        "<script>alert(1)</script>\n\n[bad](javascript:alert(2))\n\n![t](https://tracker.example/p.png)\n\n<iframe src=\"https://evil.example\"></iframe>",
        T,
    )
    .unwrap();
    let preview = build(&record(), &set, &ApprovalSet::new(), "ann", &["ann"]).unwrap();
    let doc = &preview.document;
    // The policy is the first thing in the head and forbids scripts, frames, images and fetches.
    let policy = doc.find("Content-Security-Policy").unwrap();
    assert!(policy < doc.find("<style>").unwrap());
    assert!(doc.contains("default-src &#39;none&#39;"));
    assert!(PREVIEW_CSP.starts_with("default-src 'none'"));
    assert!(!PREVIEW_CSP.contains("script-src") && !PREVIEW_CSP.contains("img-src"));
    assert!(!PREVIEW_CSP.contains("https:"));
    // The page's own chrome carries no script of its own.
    let chrome = &doc[..doc.find("<section").unwrap()];
    assert!(!chrome.contains("<script"));
    // Title and names are escaped wherever they appear.
    assert!(doc.contains("On &lt;attention&gt;"));
    assert!(!doc.contains("<attention>"));
}

#[test]
fn hostile_names_are_escaped() {
    let mut record = record();
    record.collaboration.participants[1].display_name = "<img src=x onerror=alert(1)>".into();
    let mut set = drafts();
    set.save("ann", "ann", 0, "Ann", T).unwrap();
    let preview = build(&record, &set, &ApprovalSet::new(), "ann", &["ann", "bo"]).unwrap();
    assert!(!preview.document.contains("<img src=x"));
    assert!(preview
        .document
        .contains("&lt;img src=x onerror=alert(1)&gt;"));
}

#[test]
fn the_preview_renders_prose_as_the_post_pipeline_does() {
    let markdown = "# Heading

It's \"quoted\" -- and *plain*.

## Part

```rust
fn main() {}
```
";
    let mut set = drafts();
    set.save("ann", "ann", 0, markdown, T).unwrap();
    for (smart, anchors) in [(false, false), (true, true), (true, false), (false, true)] {
        let mut config = SiteConfig::default();
        config.markdown.smart_punctuation = smart;
        config.markdown.heading_anchors = anchors;
        let file = SourceFile {
            path: "posts/a.md".into(),
            contents: format!(
                "---
title: A
date: 2026-01-01
---
{markdown}"
            ),
        };
        let post = openblog_core::model::load_post(&file, &config, config.render_options())
            .expect("the post loads");
        let preview = build_with(
            &config,
            &record(),
            &set,
            &ApprovalSet::new(),
            "ann",
            &["ann"],
        )
        .unwrap();
        assert!(
            preview.document.contains(&post.html),
            "smart={smart} anchors={anchors}: preview differs from the published html"
        );
    }
}

#[test]
fn no_sections_is_an_incomplete_empty_piece_not_an_error() {
    let set = drafts();
    let preview = build(&record(), &set, &ApprovalSet::new(), "ann", &["ann"]).unwrap();
    assert!(!preview.complete && !preview.ready && preview.seen.is_none());
    assert_eq!(preview.sections.len(), 1);
}

#[test]
fn attribution_is_the_public_subset_only() {
    let mut set = drafts();
    set.save("ann", "ann", 0, "Ann", T).unwrap();
    let preview = build(&record(), &set, &ApprovalSet::new(), "ann", &["ann"]).unwrap();
    assert!(preview.document.contains("What did you notice?"));
    assert!(preview.document.contains("The Art of Noticing"));
    for private in ["ann-admin", "shared-0a1b2c3d4e5f", "source-1", "adminUser"] {
        assert!(!preview.document.contains(private), "{private}");
    }
}

#[test]
fn the_series_placement_is_shown_and_bound_into_the_issued_token() {
    use openblog_core::shared_series::SeriesPlacement;
    let mut set = drafts();
    set.save("ann", "ann", 0, "Ann", T).unwrap();
    let placed = |series: &str, order: Option<u32>| {
        record()
            .with_series(Some(SeriesPlacement::new(series, order).unwrap()))
            .unwrap()
    };
    let none = build(&record(), &set, &ApprovalSet::new(), "ann", &["ann"]).unwrap();
    assert!(!none.document.contains("ob-preview-series"));

    let first = placed("Letters <across> time", Some(2));
    let first = build(&first, &set, &ApprovalSet::new(), "ann", &["ann"]).unwrap();
    assert!(first
        .document
        .contains("<strong>Series:</strong> Letters &lt;across&gt; time, part 2</p>"));
    assert!(!first.document.contains("<across>"));

    let unordered = placed("Letters <across> time", None);
    let unordered = build(&unordered, &set, &ApprovalSet::new(), "ann", &["ann"]).unwrap();
    assert!(unordered
        .document
        .contains("<strong>Series:</strong> Letters &lt;across&gt; time</p>"));
    assert!(!unordered.document.contains(", part "));

    let renamed = placed("Another series", Some(2));
    let renamed = build(&renamed, &set, &ApprovalSet::new(), "ann", &["ann"]).unwrap();
    let tokens = [&none.seen, &first.seen, &unordered.seen, &renamed.seen];
    for (i, a) in tokens.iter().enumerate() {
        assert!(a.is_some());
        for b in &tokens[i + 1..] {
            assert_ne!(
                a, b,
                "every placement change must change the approval binding"
            );
        }
    }
}
