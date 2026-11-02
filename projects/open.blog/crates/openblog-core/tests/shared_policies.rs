//! Configurable group approval rules (ADR 0052): all, named and role-based requirements over one
//! author set, under membership churn, ties, coordinator loss, concurrent approvals and stale
//! policy versions. Every rule needs each writer's own approval; none fabricates one.

use openblog_core::approval::{
    ApprovalPolicy, ApprovalRequirement, ApprovalScope, ApprovalSet, PolicyChange, PolicyError,
    Readiness, RuleAuthority, RuleGaps,
};
use openblog_core::assembly::{assemble, with_subject, AssemblyError};
use openblog_core::collaboration::{
    AuthorizationRole, IdentityBinding, NewParticipant, NewSharedPublication, NewSourceReference,
    Participant, SharedPublication, SourceKind,
};
use openblog_core::draft::DraftSet;
use openblog_core::media_moment::MomentSet;
use openblog_core::synthesis::SynthesisSet;

const T: i64 = 1_800_000_000;
const DATE: &str = "2030-01-31T09:00:00Z";
const ALL: [&str; 4] = ["ann", "bo", "cy", "di"];

/// Ann owns and writes; Bo writes; Cy coordinates and writes nothing; Di contributes.
fn record() -> SharedPublication {
    let mut record = SharedPublication::create(&NewSharedPublication {
        publication_id: "shared-0a1b2c3d4e5f".into(),
        title: "On attention".into(),
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
    for (id, name, roles) in [
        ("bo", "Bo", vec![AuthorizationRole::Contributor]),
        (
            "cy",
            "Cy",
            vec![
                AuthorizationRole::Coordinator,
                AuthorizationRole::Contributor,
            ],
        ),
        ("di", "Di", vec![AuthorizationRole::Contributor]),
    ] {
        record.collaboration.participants.push(Participant {
            id: id.into(),
            display_name: name.into(),
            profile_url: None,
        });
        record.authorization.bindings.push(IdentityBinding {
            admin_user: format!("{id}-admin"),
            contributor_id: id.into(),
            participant_id: id.into(),
            roles,
        });
    }
    record
}

fn drafts(writers: &[&str]) -> DraftSet {
    let mut set = DraftSet::new(&ALL).unwrap();
    for who in writers {
        set.save(who, who, 0, &format!("{who} words"), T).unwrap();
    }
    set
}

fn approve(
    record: &SharedPublication,
    set: &DraftSet,
    approvals: &mut ApprovalSet,
    active: &[&str],
    who: &str,
) {
    with_subject(
        record,
        None,
        set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        active,
        |subject| {
            let seen = approvals.binding_for(subject, who).unwrap();
            approvals.approve(who, who, subject, &seen, true, T)
        },
    )
    .unwrap();
}

fn gate(
    record: &SharedPublication,
    set: &DraftSet,
    approvals: &ApprovalSet,
    active: &[&str],
) -> Result<(), AssemblyError> {
    assemble(
        record,
        None,
        set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        approvals,
        active,
        DATE,
    )
    .map(|_| ())
}

fn policy(requirement: ApprovalRequirement) -> ApprovalPolicy {
    ApprovalPolicy {
        requirement,
        scope: ApprovalScope::OwnSections,
    }
}

fn change(
    record: &SharedPublication,
    set: &DraftSet,
    approvals: &mut ApprovalSet,
    active: &[&str],
    next: ApprovalPolicy,
    expected: u64,
) -> Result<PolicyChange, PolicyError> {
    with_subject(
        record,
        None,
        set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        active,
        |subject| {
            approvals.change_policy(
                next,
                expected,
                true,
                RuleAuthority::SiteOwner,
                subject,
                active,
            )
        },
    )
}

#[test]
fn a_role_rule_reads_the_roles_from_the_bindings_and_losing_the_coordinator_blocks() {
    let record = record();
    let set = drafts(&["ann", "bo"]);
    let mut approvals = ApprovalSet::new();
    let coordinators = policy(ApprovalRequirement::AuthorsWithRoles(vec![
        AuthorizationRole::Coordinator,
    ]));
    assert_eq!(
        change(&record, &set, &mut approvals, &ALL, coordinators, 0),
        Ok(PolicyChange::Changed { cleared: 0 })
    );
    for who in ["ann", "bo"] {
        approve(&record, &set, &mut approvals, &ALL, who);
    }
    // Cy coordinates and is an author, so Cy must approve; Di is not required.
    assert_eq!(
        gate(&record, &set, &approvals, &ALL),
        Err(AssemblyError::Blocked {
            missing: vec!["Cy".into()]
        })
    );
    approve(&record, &set, &mut approvals, &ALL, "cy");
    assert_eq!(gate(&record, &set, &approvals, &ALL), Ok(()));
    // Cy loses access: no remaining author holds the role, so the bar is not silently lowered.
    let without_cy = ["ann", "bo", "di"];
    assert_eq!(
        gate(&record, &set, &approvals, &without_cy),
        Err(AssemblyError::RuleUnmet {
            named: vec![],
            roles: vec![AuthorizationRole::Coordinator],
        })
    );
    // Promoting another author to coordinator satisfies the rule once they approve.
    let mut promoted = record.clone();
    promoted.authorization.bindings[3].roles = vec![
        AuthorizationRole::Coordinator,
        AuthorizationRole::Contributor,
    ];
    let mut fresh = ApprovalSet::new();
    fresh.set_policy(policy(ApprovalRequirement::AuthorsWithRoles(vec![
        AuthorizationRole::Coordinator,
    ])));
    for who in ["ann", "bo"] {
        approve(&promoted, &set, &mut fresh, &without_cy, who);
    }
    assert!(matches!(
        gate(&promoted, &set, &fresh, &without_cy),
        Err(AssemblyError::Blocked { missing }) if missing == ["Di"]
    ));
    approve(&promoted, &set, &mut fresh, &without_cy, "di");
    assert_eq!(gate(&promoted, &set, &fresh, &without_cy), Ok(()));
}

#[test]
fn a_withdrawn_writer_has_an_explicit_resolution_under_every_author() {
    let record = record();
    // Di wrote and then withdrew: Di has no section, so the piece is Ann's and Bo's.
    let mut set = drafts(&["ann", "bo", "di"]);
    set.withdraw("di", "di").unwrap();
    let mut approvals = ApprovalSet::new();
    for who in ["ann", "bo", "cy"] {
        approve(&record, &set, &mut approvals, &ALL, who);
    }
    // Under "every author" Di still blocks; nobody can approve for them.
    assert_eq!(
        gate(&record, &set, &approvals, &ALL),
        Err(AssemblyError::Blocked {
            missing: vec!["Di".into()]
        })
    );
    // Resolution one: Di approves the piece without their section.
    let mut by_di = approvals.clone();
    approve(&record, &set, &mut by_di, &ALL, "di");
    assert_eq!(gate(&record, &set, &by_di, &ALL), Ok(()));
    // Resolution two: a coordinator names who must approve; every writer is still required.
    let named = policy(ApprovalRequirement::NamedAuthors(vec!["cy".into()]));
    assert_eq!(
        change(&record, &set, &mut approvals, &ALL, named, 0),
        Ok(PolicyChange::Changed { cleared: 3 })
    );
    assert!(gate(&record, &set, &approvals, &ALL).is_err());
    for who in ["ann", "bo", "cy"] {
        approve(&record, &set, &mut approvals, &ALL, who);
    }
    assert_eq!(gate(&record, &set, &approvals, &ALL), Ok(()));
}

#[test]
fn a_concurrent_approval_and_policy_change_cannot_both_count() {
    let record = record();
    let set = drafts(&["ann", "bo"]);
    let loaded = ApprovalSet::new();
    // Ann reads her token, then a coordinator changes the policy from the same loaded state.
    let seen = with_subject(
        &record,
        None,
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &ALL,
        |s| loaded.binding_for(s, "ann").unwrap(),
    );
    let mut changed = loaded.clone();
    change(
        &record,
        &set,
        &mut changed,
        &ALL,
        policy(ApprovalRequirement::ContributingAuthors),
        0,
    )
    .unwrap();
    // Approving against the changed set with the old token is stale; nothing is recorded.
    let before = changed.clone();
    let result = with_subject(
        &record,
        None,
        &set,
        &SynthesisSet::new(),
        &MomentSet::new(),
        &ALL,
        |s| changed.approve("ann", "ann", s, &seen, true, T),
    );
    assert_eq!(result, Err(openblog_core::approval::ApprovalError::Stale));
    assert_eq!(changed, before);
    // And an approval that landed first is cleared by the change that follows it.
    let mut approved = loaded.clone();
    approve(&record, &set, &mut approved, &ALL, "ann");
    assert_eq!(
        change(
            &record,
            &set,
            &mut approved,
            &ALL,
            policy(ApprovalRequirement::ContributingAuthors),
            0,
        ),
        Ok(PolicyChange::Changed { cleared: 1 })
    );
    assert_eq!(
        gate(&record, &set, &approved, &ALL),
        Err(AssemblyError::Blocked {
            missing: vec!["Ann".into(), "Bo".into()]
        })
    );
}

/// A small deterministic generator, so the property test needs no dependency and replays.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
    fn pick(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn coin(&mut self) -> bool {
        self.next().is_multiple_of(2)
    }
}

#[test]
fn under_membership_churn_no_rule_publishes_without_every_writers_own_approval() {
    let base = record();
    let mut rng = Lcg(0x5eed);
    let requirements = |rng: &mut Lcg| -> ApprovalRequirement {
        match rng.pick(4) {
            0 => ApprovalRequirement::AllAuthors,
            1 => ApprovalRequirement::ContributingAuthors,
            2 => {
                let mut named: Vec<String> = ALL
                    .iter()
                    .filter(|_| rng.coin())
                    .map(|id| id.to_string())
                    .collect();
                if named.is_empty() {
                    named.push("cy".into());
                }
                ApprovalRequirement::NamedAuthors(named)
            }
            _ => ApprovalRequirement::AuthorsWithRoles(
                [
                    AuthorizationRole::SiteOwner,
                    AuthorizationRole::Coordinator,
                    AuthorizationRole::Contributor,
                ]
                .into_iter()
                .filter(|_| rng.coin())
                .chain([AuthorizationRole::Coordinator])
                .fold(Vec::new(), |mut roles, role| {
                    if !roles.contains(&role) {
                        roles.push(role);
                    }
                    roles
                }),
            ),
        }
    };
    let mut ready_seen = 0;
    for _ in 0..400 {
        // Ann always stays (she is the last owner); the others churn.
        let active: Vec<&str> = ALL
            .iter()
            .copied()
            .filter(|id| *id == "ann" || rng.coin())
            .collect();
        let writers: Vec<&str> = active
            .iter()
            .copied()
            .filter(|id| *id == "ann" || rng.coin())
            .collect();
        let set = drafts(&writers);
        let mut approvals = ApprovalSet::new();
        let requirement = requirements(&mut rng);
        approvals.set_policy(policy(requirement.clone()));
        let mut approved = Vec::new();
        for who in &active {
            if rng.pick(4) != 0 {
                approve(&base, &set, &mut approvals, &active, who);
                approved.push(*who);
            }
        }
        let readiness = with_subject(
            &base,
            None,
            &set,
            &SynthesisSet::new(),
            &MomentSet::new(),
            &active,
            |s| approvals.evaluate(s).unwrap(),
        );
        // The named list in another order is the same rule with the same answer.
        if let ApprovalRequirement::NamedAuthors(named) = &requirement {
            let mut reversed = approvals.clone();
            let mut other = named.clone();
            other.reverse();
            assert!(!reversed.set_policy(policy(ApprovalRequirement::NamedAuthors(other))));
            assert_eq!(reversed, approvals);
        }
        match &readiness {
            Readiness::Ready => {
                ready_seen += 1;
                // Every writer approved for themselves, and the gate agrees.
                for writer in &writers {
                    assert!(approved.contains(writer), "{writer} {requirement:?}");
                }
                assert_eq!(gate(&base, &set, &approvals, &active), Ok(()));
                // Every named participant is an active author who approved.
                if let ApprovalRequirement::NamedAuthors(named) = &requirement {
                    for name in named {
                        assert!(approved.contains(&name.as_str()), "{name}");
                    }
                }
            }
            Readiness::Blocked { missing, gaps } => {
                assert!(gate(&base, &set, &approvals, &active).is_err());
                // Nobody missing is someone who approved this exact piece.
                for id in missing {
                    assert!(!approved.contains(&id.as_str()) || !active.contains(&id.as_str()));
                }
                if let ApprovalRequirement::NamedAuthors(named) = &requirement {
                    let gone: Vec<String> = named
                        .iter()
                        .filter(|n| !active.contains(&n.as_str()))
                        .cloned()
                        .collect();
                    assert_eq!(gaps.named, gone);
                }
            }
        }
        // The stored set never holds an approval for someone who did not give one.
        let stored: serde_json::Value = serde_json::from_str(&approvals.to_json()).unwrap();
        for approval in stored["approvals"].as_array().unwrap() {
            let id = approval["participantId"].as_str().unwrap();
            assert!(approved.contains(&id), "{id}");
        }
    }
    assert!(
        ready_seen > 20,
        "the generator reaches ready pieces: {ready_seen}"
    );
}

#[test]
fn rule_gaps_name_ids_and_roles_only() {
    let gaps = RuleGaps {
        named: vec!["cy".into()],
        roles: vec![AuthorizationRole::SiteOwner],
    };
    assert_eq!(
        serde_json::to_string(&gaps).unwrap(),
        r#"{"named":["cy"],"roles":["siteOwner"]}"#
    );
}
