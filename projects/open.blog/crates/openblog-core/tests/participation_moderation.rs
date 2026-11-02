//! The one moderation policy (ADRs 0102 to 0104): every kind, state, action
//! and role, pending by default, clarification, removal, abuse reports,
//! replay, role scope and retention.
//!
//! `participation-moderation-matrix.txt` records the outcome of every
//! kind/state/action/role combination; set `OPENBLOG_UPDATE_GOLDEN=1` to
//! rewrite it after a deliberate policy change, and review the diff.

use openblog_core::moderation::{
    allowed_reasons, is_public, may_view, next_state, Actor, ActorRole, AuditAction, Decision,
    ItemFacts, ModerationAction, ModerationPolicy, ModerationState, PolicyError, ReasonCode,
    Request, RetentionPolicy, RetentionStep, Submission, View,
};
use openblog_core::participation::{ParticipationKind, ParticipationMode, TargetShape};
use openblog_core::DateTime;

const WORK: &str = "/posts/tides/";
const ELSEWHERE: &str = "/posts/other/";
const WORKS: &[&str] = &[WORK];
const OTHER_WORKS: &[&str] = &[ELSEWHERE];
const MATRIX: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/participation-moderation-matrix.txt"
);

fn day(n: i64) -> DateTime {
    DateTime::from_unix(1_800_000_000 + n * 86_400)
}

fn policy() -> ModerationPolicy {
    ModerationPolicy::default()
}

fn item(kind: ParticipationKind, state: ModerationState) -> ItemFacts<'static> {
    ItemFacts {
        id: "item-1",
        kind,
        work: Some(WORK),
        parent: (kind.rules().target == TargetShape::Item).then_some("parent-1"),
        state,
        version: 3,
        revision: 2,
        approved_revision: (state == ModerationState::Approved).then_some(2),
        clarification_asked: None,
        clarification_consent: true,
        content_retained: true,
        state_since: day(0),
    }
}

fn approved_comment(id: &'static str) -> ItemFacts<'static> {
    ItemFacts {
        id,
        kind: ParticipationKind::Comment,
        work: Some(WORK),
        parent: None,
        state: ModerationState::Approved,
        version: 2,
        revision: 1,
        approved_revision: Some(1),
        clarification_asked: None,
        clarification_consent: false,
        content_retained: true,
        state_since: day(0),
    }
}

fn roles() -> [(&'static str, Actor<'static>); 8] {
    [
        ("public", Actor::Public),
        ("submitter", Actor::Submitter),
        (
            "site-admin",
            Actor::SiteAdmin {
                admin_user: "owner",
            },
        ),
        (
            "coordinator",
            Actor::Coordinator {
                admin_user: "coord",
                works: WORKS,
            },
        ),
        (
            "coordinator-elsewhere",
            Actor::Coordinator {
                admin_user: "coord",
                works: OTHER_WORKS,
            },
        ),
        (
            "contributor",
            Actor::ContributingAuthor {
                admin_user: "writer",
                works: WORKS,
            },
        ),
        (
            "contributor-elsewhere",
            Actor::ContributingAuthor {
                admin_user: "writer",
                works: OTHER_WORKS,
            },
        ),
        ("system", Actor::System),
    ]
}

fn admin() -> Actor<'static> {
    Actor::SiteAdmin {
        admin_user: "owner",
    }
}

fn coordinator(works: &'static [&'static str]) -> Actor<'static> {
    Actor::Coordinator {
        admin_user: "coord",
        works,
    }
}

fn contributor() -> Actor<'static> {
    Actor::ContributingAuthor {
        admin_user: "writer",
        works: WORKS,
    }
}

fn request<'a>(
    actor: Actor<'a>,
    action: ModerationAction,
    facts: &ItemFacts<'_>,
    reported: Option<&'a ItemFacts<'a>>,
) -> Request<'a> {
    Request {
        actor,
        action,
        expected_version: facts.version,
        reason: allowed_reasons(action, facts.kind).first().copied(),
        at: day(400),
        reported_item: (action == ModerationAction::UpholdReport)
            .then_some(reported)
            .flatten(),
    }
}

/// Apply a decision to the facts, as a caller's single write would.
fn apply<'a>(facts: &ItemFacts<'a>, decision: &Decision) -> ItemFacts<'a> {
    let change = &decision.item;
    ItemFacts {
        state: change.to,
        version: change.version,
        revision: change.revision,
        approved_revision: change.approved_revision,
        clarification_asked: change.clarification_asked,
        state_since: change.audit.at,
        ..*facts
    }
}

fn outcome(result: &Result<Decision, PolicyError>) -> String {
    match result {
        Ok(decision) => format!("->{}", decision.item.to.id()),
        Err(error) => error.code().to_string(),
    }
}

#[test]
fn every_kind_state_action_and_role_matches_the_reviewed_matrix() {
    let reported = approved_comment("parent-1");
    let roles = roles();
    let mut text = String::from(
        "# Outcome of every kind/state/action/role combination (ADRs 0102 and 0103).\n\
         # `->state` is the state reached; anything else is the refusal code.\n\
         # Each request names the stored version, the first allowed reason, and for\n\
         # uphold-report an approved reported item on the same work. Items have\n\
         # clarification consent, kept text and a retention period that has ended,\n\
         # under the default retention, which leaves comments out (ADR 0104).\n#\n# kind state action |",
    );
    for (name, _) in &roles {
        text.push(' ');
        text.push_str(name);
    }
    text.push('\n');
    for kind in ParticipationKind::ALL {
        for state in ModerationState::ALL {
            let facts = item(kind, state);
            for action in ModerationAction::ALL {
                text.push_str(&format!("{} {} {} |", kind.id(), state.id(), action.id()));
                for (name, actor) in &roles {
                    let result =
                        policy().decide(&facts, &request(*actor, action, &facts, Some(&reported)));
                    check_invariants(name, actor, &facts, action, &result);
                    text.push(' ');
                    text.push_str(&outcome(&result));
                }
                text.push('\n');
            }
        }
    }
    if std::env::var_os("OPENBLOG_UPDATE_GOLDEN").is_some() {
        std::fs::write(MATRIX, &text).unwrap();
    }
    let expected = std::fs::read_to_string(MATRIX)
        .expect("missing participation-moderation-matrix.txt")
        .replace("\r\n", "\n");
    if text != expected {
        let first = text
            .lines()
            .zip(expected.lines())
            .find(|(got, want)| got != want);
        panic!("the moderation matrix changed; first difference: {first:?}");
    }
}

/// Properties every cell must have, whatever the matrix says.
fn check_invariants(
    name: &str,
    actor: &Actor<'_>,
    facts: &ItemFacts<'_>,
    action: ModerationAction,
    result: &Result<Decision, PolicyError>,
) {
    let context = format!("{name} {} {} {}", facts.kind, facts.state.id(), action.id());
    let Ok(decision) = result else {
        // Public and contributing authors never moderate, and out of scope is
        // denied before any state is revealed.
        if matches!(
            name,
            "public" | "contributor" | "contributor-elsewhere" | "coordinator-elsewhere"
        ) {
            assert_eq!(result, &Err(PolicyError::Denied), "{context}");
        }
        return;
    };
    let change = &decision.item;
    assert!(
        matches!(name, "site-admin" | "coordinator" | "submitter" | "system"),
        "{context}"
    );
    assert_eq!(
        Some(change.to),
        next_state(action, facts.state),
        "{context}"
    );
    assert_eq!(change.from, facts.state);
    assert_eq!(change.version, facts.version + 1, "{context}");
    if change.to == ModerationState::Approved {
        assert_eq!(facts.state, ModerationState::Pending, "{context}");
        assert!(
            matches!(
                action,
                ModerationAction::Approve | ModerationAction::UpholdReport
            ),
            "{context}"
        );
        assert!(matches!(name, "site-admin" | "coordinator"), "{context}");
        assert_eq!(change.approved_revision, Some(change.revision));
    } else {
        assert_eq!(change.approved_revision, None, "{context}");
    }
    assert_eq!(
        change.revision,
        facts.revision + u32::from(action == ModerationAction::Clarify),
        "{context}"
    );
    let audit = &change.audit;
    assert_eq!(audit.action, AuditAction::Moderate(action));
    assert_eq!(audit.actor, actor.role());
    assert_eq!(audit.from, Some(facts.state));
    assert_eq!(audit.to, change.to);
    assert_eq!(audit.at, day(400));
    assert_eq!(
        audit.actor_id.is_some(),
        matches!(name, "site-admin" | "coordinator"),
        "{context}"
    );
    if !allowed_reasons(action, facts.kind).is_empty() {
        assert!(audit.reason.is_some(), "{context}");
    }
    // Nothing reached from clarification is public, and abuse reports never are.
    let after = apply(facts, decision);
    if facts.state == ModerationState::Clarification || facts.kind == ParticipationKind::AbuseReport
    {
        assert!(!is_public(&after, ParticipationMode::Open), "{context}");
    }
}

#[test]
fn every_submission_starts_pending_whoever_sends_it() {
    let parent = approved_comment("parent-1");
    for kind in ParticipationKind::ALL {
        for (name, actor) in roles() {
            for mode in ParticipationMode::ALL {
                let item_target = kind.rules().target == TargetShape::Item;
                let submission = Submission {
                    id: "new-1",
                    actor,
                    kind,
                    work: Some(WORK),
                    mode,
                    parent: item_target.then_some((&parent, ParticipationMode::Open)),
                    parent_target: None,
                    author_grant: None,
                    clarification_consent: true,
                    at: day(1),
                };
                let result = policy().admit(&submission);
                let context = format!("{kind} {name} {}", mode.id());
                let permitted = match kind {
                    ParticipationKind::AuthorResponse => {
                        matches!(name, "site-admin" | "coordinator" | "contributor")
                    }
                    _ => name == "public",
                };
                match (permitted, mode) {
                    (false, _) => assert_eq!(result, Err(PolicyError::Denied), "{context}"),
                    (true, ParticipationMode::Hidden) => {
                        assert_eq!(result, Err(PolicyError::Unavailable), "{context}")
                    }
                    (true, ParticipationMode::Locked) => {
                        assert_eq!(result, Err(PolicyError::Closed), "{context}")
                    }
                    (true, ParticipationMode::Open) => {
                        let admission = result.expect(&context);
                        assert_eq!(admission.state, ModerationState::Pending);
                        assert_eq!((admission.version, admission.revision), (1, 1));
                        assert_eq!(admission.clarification_consent, kind.rules().clarification);
                        let audit = &admission.audit;
                        assert_eq!(audit.action, AuditAction::Submit);
                        assert_eq!((audit.from, audit.to), (None, ModerationState::Pending));
                        assert_eq!(audit.item, "new-1");
                        assert_eq!(audit.related.as_deref(), item_target.then_some("parent-1"));
                        assert_eq!(audit.actor_id.is_some(), name != "public", "{context}");
                    }
                }
            }
        }
    }
}

#[test]
fn responses_and_reports_need_a_public_parent_and_reveal_nothing_about_others() {
    let report = |parent: &ItemFacts<'_>, mode| {
        policy().admit(&Submission {
            id: "report-1",
            actor: Actor::Public,
            kind: ParticipationKind::AbuseReport,
            work: Some(WORK),
            mode: ParticipationMode::Open,
            parent: Some((parent, mode)),
            parent_target: None,
            author_grant: None,
            clarification_consent: false,
            at: day(1),
        })
    };
    let approved = approved_comment("parent-1");
    assert!(report(&approved, ParticipationMode::Open).is_ok());
    assert!(report(&approved, ParticipationMode::Locked).is_ok());
    // A pending, removed or hidden item, an approval of an older revision,
    // another work's item or a report about a report is unavailable, exactly
    // as an item that does not exist would be.
    let unavailable = [
        (
            ItemFacts {
                state: ModerationState::Pending,
                approved_revision: None,
                ..approved
            },
            ParticipationMode::Open,
        ),
        (
            ItemFacts {
                state: ModerationState::Removed,
                approved_revision: None,
                ..approved
            },
            ParticipationMode::Open,
        ),
        (approved, ParticipationMode::Hidden),
        (
            ItemFacts {
                revision: 2,
                ..approved
            },
            ParticipationMode::Open,
        ),
        (
            ItemFacts {
                work: Some(ELSEWHERE),
                ..approved
            },
            ParticipationMode::Open,
        ),
        (
            ItemFacts {
                kind: ParticipationKind::AbuseReport,
                ..approved
            },
            ParticipationMode::Open,
        ),
    ];
    for (parent, mode) in unavailable {
        assert_eq!(
            report(&parent, mode),
            Err(PolicyError::Unavailable),
            "{parent:?}"
        );
    }
    // Shapes that do not fit the kind.
    let mut no_parent = Submission {
        id: "x",
        actor: Actor::Public,
        kind: ParticipationKind::AbuseReport,
        work: Some(WORK),
        mode: ParticipationMode::Open,
        parent: None,
        parent_target: None,
        author_grant: None,
        clarification_consent: false,
        at: day(1),
    };
    assert_eq!(policy().admit(&no_parent), Err(PolicyError::InvalidTarget));
    no_parent.kind = ParticipationKind::Comment;
    no_parent.work = None;
    assert_eq!(policy().admit(&no_parent), Err(PolicyError::InvalidTarget));
    no_parent.work = Some(WORK);
    no_parent.parent = Some((&approved, ParticipationMode::Open));
    assert_eq!(policy().admit(&no_parent), Err(PolicyError::InvalidTarget));
    // An author may not answer an author response.
    let response = ItemFacts {
        kind: ParticipationKind::AuthorResponse,
        ..approved
    };
    let answer = policy().admit(&Submission {
        id: "r",
        actor: admin(),
        kind: ParticipationKind::AuthorResponse,
        work: Some(WORK),
        mode: ParticipationMode::Open,
        parent: Some((&response, ParticipationMode::Open)),
        parent_target: None,
        author_grant: None,
        clarification_consent: false,
        at: day(1),
    });
    assert_eq!(answer, Err(PolicyError::Unavailable));
}

/// Nobody, at any version, can approve an item whose current revision a
/// clarification request asked about.
fn assert_unapprovable(policy: &ModerationPolicy, facts: &ItemFacts<'_>, versions: &[u64]) {
    assert!(facts.current_revision_asked());
    for (name, actor) in roles() {
        for version in versions {
            let approve = Request {
                expected_version: *version,
                ..request(actor, ModerationAction::Approve, facts, None)
            };
            assert!(
                policy.decide(facts, &approve).is_err(),
                "{name} approved {} at version {version}",
                facts.state.id()
            );
        }
    }
    assert!(!is_public(
        &ItemFacts {
            state: ModerationState::Approved,
            approved_revision: Some(facts.revision),
            ..*facts
        },
        ParticipationMode::Open
    ));
}

#[test]
fn clarification_never_publishes_the_original() {
    let policy = policy();
    let original = ItemFacts {
        revision: 1,
        version: 1,
        ..item(
            ParticipationKind::ThirdPerspective,
            ModerationState::Pending,
        )
    };
    let ask = Request {
        reason: Some(ReasonCode::Unclear),
        ..request(
            admin(),
            ModerationAction::RequestClarification,
            &original,
            None,
        )
    };
    let asked = policy.decide(&original, &ask).unwrap();
    assert_eq!(asked.item.clarification_asked, Some(1));
    let mut facts = apply(&original, &asked);
    assert_eq!(facts.state, ModerationState::Clarification);
    assert!(!is_public(&facts, ParticipationMode::Open));
    assert_eq!(asked.item.audit.reason, Some(ReasonCode::Unclear));
    let in_clarification = facts;

    // The text asked about cannot be approved, by anyone, at any version.
    assert_unapprovable(&policy, &facts, &[original.version, facts.version]);

    // Rejected, then reopened: back to clarification, never to an approvable
    // pending state, so the original still cannot be approved.
    let reject = request(admin(), ModerationAction::Reject, &facts, None);
    let rejected = apply(&facts, &policy.decide(&facts, &reject).unwrap());
    assert_eq!(rejected.clarification_asked, Some(1));
    let reopen = request(admin(), ModerationAction::Reopen, &rejected, None);
    let reopened = apply(&rejected, &policy.decide(&rejected, &reopen).unwrap());
    assert_eq!(reopened.state, ModerationState::Clarification);
    assert_eq!(reopened.revision, 1);
    assert_unapprovable(
        &policy,
        &reopened,
        &[original.version, rejected.version, reopened.version],
    );

    // Expired unanswered, then reopened: the same.
    let expire = Request {
        at: day(400 + 30),
        ..request(Actor::System, ModerationAction::Expire, &facts, None)
    };
    let expired = apply(&facts, &policy.decide(&facts, &expire).unwrap());
    assert_eq!(expired.state, ModerationState::Rejected);
    let reopen = request(admin(), ModerationAction::Reopen, &expired, None);
    let reopened = apply(&expired, &policy.decide(&expired, &reopen).unwrap());
    assert_eq!(reopened.state, ModerationState::Clarification);
    assert_unapprovable(&policy, &reopened, &[expired.version, reopened.version]);

    // Stored facts that claim pending at the asked revision are still refused.
    let forged = ItemFacts {
        state: ModerationState::Pending,
        ..in_clarification
    };
    assert_unapprovable(&policy, &forged, &[forged.version]);
    let approve = request(admin(), ModerationAction::Approve, &forged, None);
    assert_eq!(
        policy.decide(&forged, &approve),
        Err(PolicyError::NotAllowed)
    );

    // The submitter's answer replaces it as revision 2, pending again.
    let answer = policy
        .decide(
            &facts,
            &request(Actor::Submitter, ModerationAction::Clarify, &facts, None),
        )
        .unwrap();
    assert_eq!(answer.item.superseded_revision, Some(1));
    assert_eq!(answer.item.revision, 2);
    let asked_version = facts.version;
    facts = apply(&facts, &answer);
    assert_eq!(facts.state, ModerationState::Pending);
    assert!(!facts.current_revision_asked());
    assert!(!is_public(&facts, ParticipationMode::Open));

    // An approval prepared against the clarification-era version is stale.
    let late = Request {
        expected_version: asked_version,
        ..request(admin(), ModerationAction::Approve, &facts, None)
    };
    assert_eq!(policy.decide(&facts, &late), Err(PolicyError::Stale));

    // Rejecting and reopening the answer returns it to pending: it is the
    // submitter's new text, not the text asked about.
    let reject = request(admin(), ModerationAction::Reject, &facts, None);
    let rejected = apply(&facts, &policy.decide(&facts, &reject).unwrap());
    let reopen = request(admin(), ModerationAction::Reopen, &rejected, None);
    facts = apply(&rejected, &policy.decide(&rejected, &reopen).unwrap());
    assert_eq!(facts.state, ModerationState::Pending);

    let approved = policy
        .decide(
            &facts,
            &request(admin(), ModerationAction::Approve, &facts, None),
        )
        .unwrap();
    assert_eq!(approved.item.approved_revision, Some(2));
    facts = apply(&facts, &approved);
    assert!(is_public(&facts, ParticipationMode::Open));
    // The approval covers revision 2 only: revision 1 is never public.
    assert!(!is_public(
        &ItemFacts {
            revision: 1,
            ..facts
        },
        ParticipationMode::Open
    ));
}

#[test]
fn clarification_needs_the_submitters_consent_and_a_kind_that_allows_it() {
    let policy = policy();
    let unconsented = ItemFacts {
        clarification_consent: false,
        ..item(ParticipationKind::Question, ModerationState::Pending)
    };
    let ask = request(
        admin(),
        ModerationAction::RequestClarification,
        &unconsented,
        None,
    );
    assert_eq!(
        policy.decide(&unconsented, &ask),
        Err(PolicyError::ConsentRequired)
    );
    for kind in [
        ParticipationKind::Comment,
        ParticipationKind::AuthorResponse,
        ParticipationKind::AbuseReport,
    ] {
        let facts = item(kind, ModerationState::Pending);
        let ask = request(
            admin(),
            ModerationAction::RequestClarification,
            &facts,
            None,
        );
        assert_eq!(
            policy.decide(&facts, &ask),
            Err(PolicyError::NotAllowed),
            "{kind}"
        );
    }
    // A reason is required and must be a clarification reason.
    let facts = item(ParticipationKind::Question, ModerationState::Pending);
    for (reason, expected) in [
        (None, PolicyError::ReasonRequired),
        (Some(ReasonCode::Spam), PolicyError::ReasonNotAllowed),
        (Some(ReasonCode::Expired), PolicyError::ReasonNotAllowed),
    ] {
        let ask = Request {
            reason,
            ..request(
                admin(),
                ModerationAction::RequestClarification,
                &facts,
                None,
            )
        };
        assert_eq!(policy.decide(&facts, &ask), Err(expected));
    }
}

#[test]
fn a_replayed_or_stale_request_changes_nothing() {
    let policy = policy();
    let pending = item(ParticipationKind::Comment, ModerationState::Pending);
    let approve = request(admin(), ModerationAction::Approve, &pending, None);
    let first = policy.decide(&pending, &approve).unwrap();
    let approved = apply(&pending, &first);
    assert_eq!(policy.decide(&approved, &approve), Err(PolicyError::Stale));
    // A reject prepared against the pending version cannot undo the approval.
    let reject = request(admin(), ModerationAction::Reject, &pending, None);
    assert_eq!(policy.decide(&approved, &reject), Err(PolicyError::Stale));

    let remove = request(
        coordinator(WORKS),
        ModerationAction::Remove,
        &approved,
        None,
    );
    let removed = apply(&approved, &policy.decide(&approved, &remove).unwrap());
    assert_eq!(policy.decide(&removed, &remove), Err(PolicyError::Stale));
    // The same request at the new version is simply not allowed any more.
    let again = Request {
        expected_version: removed.version,
        ..remove
    };
    assert_eq!(
        policy.decide(&removed, &again),
        Err(PolicyError::NotAllowed)
    );

    let target = approved_comment("parent-1");
    let report = item(ParticipationKind::AbuseReport, ModerationState::Pending);
    let uphold = request(
        admin(),
        ModerationAction::UpholdReport,
        &report,
        Some(&target),
    );
    let upheld = apply(&report, &policy.decide(&report, &uphold).unwrap());
    assert_eq!(policy.decide(&upheld, &uphold), Err(PolicyError::Stale));
}

#[test]
fn coordinators_moderate_and_remove_only_within_their_publications() {
    let policy = policy();
    let approved = item(ParticipationKind::Comment, ModerationState::Approved);
    let remove = Request {
        reason: Some(ReasonCode::Abusive),
        ..request(
            coordinator(WORKS),
            ModerationAction::Remove,
            &approved,
            None,
        )
    };
    let decision = policy.decide(&approved, &remove).unwrap();
    let removed = apply(&approved, &decision);
    assert_eq!(removed.state, ModerationState::Removed);
    assert!(!is_public(&removed, ParticipationMode::Open));
    let audit = &decision.item.audit;
    assert_eq!(audit.actor, ActorRole::Coordinator);
    assert_eq!(audit.actor_id.as_deref(), Some("coord"));
    assert_eq!(audit.reason, Some(ReasonCode::Abusive));
    assert_eq!((audit.revision, audit.version), (2, 4));

    // A removal always says why.
    let silent = Request {
        reason: None,
        ..remove
    };
    assert_eq!(
        policy.decide(&approved, &silent),
        Err(PolicyError::ReasonRequired)
    );

    // Another publication's coordinator, or one whose binding was removed
    // (no works left), is denied before staleness or state is checked.
    for works in [OTHER_WORKS, &[][..]] {
        let outsider = Request {
            actor: coordinator(works),
            expected_version: 99,
            ..remove
        };
        assert_eq!(
            policy.decide(&approved, &outsider),
            Err(PolicyError::Denied)
        );
    }
    // An item without a work is the site Admin's alone.
    let workless = ItemFacts {
        work: None,
        ..approved
    };
    assert_eq!(policy.decide(&workless, &remove), Err(PolicyError::Denied));
    let by_admin = Request {
        actor: admin(),
        ..remove
    };
    assert!(policy.decide(&workless, &by_admin).is_ok());

    // Only the site Admin may reopen.
    let reopen = request(coordinator(WORKS), ModerationAction::Reopen, &removed, None);
    assert_eq!(policy.decide(&removed, &reopen), Err(PolicyError::Denied));
    let reopen = request(admin(), ModerationAction::Reopen, &removed, None);
    let reopened = apply(&removed, &policy.decide(&removed, &reopen).unwrap());
    assert_eq!(reopened.state, ModerationState::Pending);
    assert!(!is_public(&reopened, ParticipationMode::Open));
}

#[test]
fn contributing_authors_read_and_respond_but_never_moderate() {
    let policy = policy();
    for state in ModerationState::ALL {
        let facts = item(ParticipationKind::ThirdPerspective, state);
        for action in ModerationAction::ALL {
            let attempt = request(contributor(), action, &facts, None);
            assert_eq!(policy.decide(&facts, &attempt), Err(PolicyError::Denied));
        }
    }
    let pending = item(ParticipationKind::Question, ModerationState::Pending);
    let hidden = ParticipationMode::Open;
    assert!(may_view(&contributor(), &pending, hidden, View::Content));
    assert!(!may_view(
        &contributor(),
        &pending,
        hidden,
        View::PrivateIdentity
    ));
    let report = item(ParticipationKind::AbuseReport, ModerationState::Pending);
    assert!(!may_view(&contributor(), &report, hidden, View::Content));
    let elsewhere = Actor::ContributingAuthor {
        admin_user: "writer",
        works: OTHER_WORKS,
    };
    assert!(!may_view(&elsewhere, &pending, hidden, View::Content));
    let approved = item(ParticipationKind::Question, ModerationState::Approved);
    assert!(may_view(
        &elsewhere,
        &approved,
        ParticipationMode::Locked,
        View::Content
    ));
    assert!(!may_view(
        &elsewhere,
        &approved,
        ParticipationMode::Hidden,
        View::Content
    ));

    // A contributing author's response to an approved item enters pending.
    let parent = approved_comment("parent-1");
    let response = policy
        .admit(&Submission {
            id: "response-1",
            actor: contributor(),
            kind: ParticipationKind::AuthorResponse,
            work: Some(WORK),
            mode: ParticipationMode::Open,
            parent: Some((&parent, ParticipationMode::Open)),
            parent_target: None,
            author_grant: None,
            clarification_consent: true,
            at: day(1),
        })
        .unwrap();
    assert_eq!(response.state, ModerationState::Pending);
    assert!(!response.clarification_consent);
    assert_eq!(response.audit.actor, ActorRole::ContributingAuthor);
}

#[test]
fn only_the_site_admin_and_the_submitter_see_a_private_identity() {
    let facts = item(ParticipationKind::Question, ModerationState::Pending);
    for (name, actor) in roles() {
        assert_eq!(
            may_view(
                &actor,
                &facts,
                ParticipationMode::Open,
                View::PrivateIdentity
            ),
            matches!(name, "site-admin" | "submitter"),
            "{name}"
        );
        // Pending text is visible only to moderators in scope, authors in
        // scope and the submitter.
        assert_eq!(
            may_view(&actor, &facts, ParticipationMode::Open, View::Content),
            matches!(
                name,
                "site-admin" | "submitter" | "coordinator" | "contributor"
            ),
            "{name}"
        );
    }
}

#[test]
fn upholding_a_report_removes_its_target_or_changes_nothing() {
    let policy = policy();
    let target = approved_comment("parent-1");
    let report = item(ParticipationKind::AbuseReport, ModerationState::Pending);
    let uphold = request(
        coordinator(WORKS),
        ModerationAction::UpholdReport,
        &report,
        Some(&target),
    );
    let decision = policy.decide(&report, &uphold).unwrap();
    assert_eq!(decision.item.to, ModerationState::Approved);
    assert_eq!(decision.item.audit.related.as_deref(), Some("parent-1"));
    let removal = decision.reported_item.expect("the target is removed");
    assert_eq!(
        (removal.from, removal.to),
        (ModerationState::Approved, ModerationState::Removed)
    );
    assert_eq!(removal.audit.reason, Some(ReasonCode::UpheldReport));
    assert_eq!(removal.audit.related.as_deref(), Some("item-1"));
    assert_eq!(removal.audit.actor_id.as_deref(), Some("coord"));
    assert_eq!(removal.version, target.version + 1);
    // The upheld report itself is never public.
    assert!(!is_public(
        &apply(&report, &decision_of(decision.item)),
        ParticipationMode::Open
    ));

    // A target already out of view: the report is upheld, nothing else moves.
    let gone = ItemFacts {
        state: ModerationState::Withdrawn,
        approved_revision: None,
        ..target
    };
    let decision = policy
        .decide(
            &report,
            &request(
                admin(),
                ModerationAction::UpholdReport,
                &report,
                Some(&gone),
            ),
        )
        .unwrap();
    assert_eq!(decision.reported_item, None);

    // The wrong item, no item, or a target the actor may not remove: refused.
    let stranger = approved_comment("someone-else");
    let wrong = request(
        admin(),
        ModerationAction::UpholdReport,
        &report,
        Some(&stranger),
    );
    assert_eq!(
        policy.decide(&report, &wrong),
        Err(PolicyError::ReportMismatch)
    );
    let missing = Request {
        reported_item: None,
        ..uphold
    };
    assert_eq!(
        policy.decide(&report, &missing),
        Err(PolicyError::ReportMismatch)
    );
    let foreign_target = ItemFacts {
        work: Some(ELSEWHERE),
        ..target
    };
    let out_of_scope = request(
        coordinator(WORKS),
        ModerationAction::UpholdReport,
        &report,
        Some(&foreign_target),
    );
    assert_eq!(
        policy.decide(&report, &out_of_scope),
        Err(PolicyError::Denied)
    );
    // A reported item cannot ride along with another action.
    let smuggled = Request {
        reported_item: Some(&target),
        ..request(admin(), ModerationAction::Reject, &report, None)
    };
    assert_eq!(
        policy.decide(&report, &smuggled),
        Err(PolicyError::ReportMismatch)
    );

    // A report is dismissed with a report reason, never approved directly.
    let approve = request(admin(), ModerationAction::Approve, &report, None);
    assert_eq!(
        policy.decide(&report, &approve),
        Err(PolicyError::NotAllowed)
    );
    let dismiss = request(admin(), ModerationAction::Reject, &report, None);
    let dismissed = policy.decide(&report, &dismiss).unwrap();
    assert_eq!(dismissed.item.audit.reason, Some(ReasonCode::NoAction));
    let policy_reason = Request {
        reason: Some(ReasonCode::UpheldReport),
        ..uphold
    };
    assert_eq!(
        policy.decide(&report, &policy_reason),
        Err(PolicyError::ReasonNotAllowed)
    );
}

/// An upheld report is approved but never public, so nothing keeps its text:
/// it is purged after `closedDays` like a rejected item, and its audit
/// events, which name the removal they caused, stay for `auditDays`.
#[test]
fn an_upheld_reports_text_is_purged_on_schedule_and_its_audit_stays() {
    let policy = policy();
    let target = approved_comment("parent-1");
    let report = ItemFacts {
        state_since: day(0),
        ..item(ParticipationKind::AbuseReport, ModerationState::Pending)
    };
    let uphold = Request {
        at: day(10),
        ..request(
            admin(),
            ModerationAction::UpholdReport,
            &report,
            Some(&target),
        )
    };
    let decision = policy.decide(&report, &uphold).unwrap();
    let upheld = apply(&report, &decision);
    assert_eq!(upheld.state, ModerationState::Approved);
    assert_eq!(upheld.state_since, day(10));

    assert_eq!(policy.retention_due(&upheld, day(39)), None);
    assert_eq!(
        policy.retention_due(&upheld, day(40)),
        Some(RetentionStep::PurgeContent)
    );
    let purge = policy.purge_event(&upheld, day(40)).unwrap();
    assert_eq!(purge.action, AuditAction::PurgeContent);
    assert_eq!(
        (purge.from, purge.to),
        (Some(ModerationState::Approved), ModerationState::Approved)
    );
    let purged = ItemFacts {
        content_retained: false,
        ..upheld
    };
    assert_eq!(policy.retention_due(&purged, day(10_000)), None);
    assert!(!may_view(
        &admin(),
        &purged,
        ParticipationMode::Open,
        View::Content
    ));
    // The upholding and the removal it caused are still on record after the
    // text is gone, until their own period ends.
    for event in [
        &decision.item.audit,
        &decision.reported_item.as_ref().unwrap().audit,
    ] {
        assert!(!policy.audit_due(event.at, day(40)));
        assert!(!policy.audit_due(event.at, day(374)));
        assert!(policy.audit_due(event.at, day(375)));
    }

    // Approved items of every publishable kind are kept while published; an
    // accepted suggestion is kept too, owing only the clearing of its private
    // identity, never a purge.
    for kind in ParticipationKind::ALL {
        let approved = item(kind, ModerationState::Approved);
        let due = policy.retention_due(&approved, day(10_000));
        match kind {
            ParticipationKind::AbuseReport => assert_eq!(due, Some(RetentionStep::PurgeContent)),
            ParticipationKind::FutureSuggestion => {
                assert_eq!(due, Some(RetentionStep::ScrubIdentity))
            }
            _ => assert_eq!(due, None, "{kind}"),
        }
    }
}

fn decision_of(item: openblog_core::moderation::Transition) -> Decision {
    Decision {
        item,
        reported_item: None,
    }
}

#[test]
fn removed_withdrawn_and_unknown_items_are_never_public() {
    for kind in ParticipationKind::ALL {
        for state in ModerationState::ALL {
            let facts = item(kind, state);
            for mode in ParticipationMode::ALL {
                assert_eq!(
                    is_public(&facts, mode),
                    state == ModerationState::Approved
                        && kind.rules().publishable
                        && mode != ParticipationMode::Hidden,
                    "{kind} {} {}",
                    state.id(),
                    mode.id()
                );
            }
        }
    }
    // An approval without a recorded revision is not public either.
    let unbound = ItemFacts {
        approved_revision: None,
        ..item(ParticipationKind::Comment, ModerationState::Approved)
    };
    assert!(!is_public(&unbound, ParticipationMode::Open));
    // Stored state ids beyond this version are unknown, hence not public.
    assert_eq!(ModerationState::from_id("published"), None);
    assert_eq!(ModerationState::from_legacy_comment_status("removed"), None);
    for state in ModerationState::ALL {
        assert_eq!(ModerationState::from_id(state.id()), Some(state));
        let legacy = state.legacy_comment_status();
        assert_eq!(
            legacy == "approved",
            state == ModerationState::Approved,
            "{}",
            state.id()
        );
        assert!(ModerationState::from_legacy_comment_status(legacy).is_some());
    }
}

#[test]
fn withdrawal_belongs_to_the_submitter_and_cannot_be_reopened() {
    let policy = policy();
    let approved = item(
        ParticipationKind::ThirdPerspective,
        ModerationState::Approved,
    );
    let withdraw = request(
        Actor::Submitter,
        ModerationAction::Withdraw,
        &approved,
        None,
    );
    let withdrawn = apply(&approved, &policy.decide(&approved, &withdraw).unwrap());
    assert!(!is_public(&withdrawn, ParticipationMode::Open));
    assert_eq!(
        policy.retention_due(&withdrawn, withdrawn.state_since),
        Some(RetentionStep::PurgeContent)
    );
    let reopen = request(admin(), ModerationAction::Reopen, &withdrawn, None);
    assert_eq!(
        policy.decide(&withdrawn, &reopen),
        Err(PolicyError::NotAllowed)
    );
    // Nobody else can withdraw for the submitter.
    for actor in [admin(), coordinator(WORKS), contributor(), Actor::Public] {
        let attempt = request(actor, ModerationAction::Withdraw, &approved, None);
        assert_eq!(policy.decide(&approved, &attempt), Err(PolicyError::Denied));
    }
}

#[test]
fn retention_expires_unmoderated_items_and_purges_closed_text_on_schedule() {
    // A site that never set retention: the default periods, for every kind
    // but comments.
    let policy = policy();
    let pending = ItemFacts {
        state_since: day(0),
        ..item(ParticipationKind::Question, ModerationState::Pending)
    };
    assert_eq!(policy.retention_due(&pending, day(89)), None);
    assert_eq!(
        policy.retention_due(&pending, day(90)),
        Some(RetentionStep::Expire)
    );
    let early = Request {
        at: day(89),
        ..request(Actor::System, ModerationAction::Expire, &pending, None)
    };
    assert_eq!(policy.decide(&pending, &early), Err(PolicyError::NotDue));
    let due = Request {
        at: day(90),
        ..early
    };
    let expired = policy.decide(&pending, &due).unwrap();
    assert_eq!(expired.item.to, ModerationState::Rejected);
    assert_eq!(expired.item.audit.reason, Some(ReasonCode::Expired));
    assert_eq!(expired.item.audit.actor, ActorRole::System);
    // Only the retention job expires, and it can do nothing else.
    let by_admin = Request {
        actor: admin(),
        ..due
    };
    assert_eq!(policy.decide(&pending, &by_admin), Err(PolicyError::Denied));
    let system_approve = request(Actor::System, ModerationAction::Approve, &pending, None);
    assert_eq!(
        policy.decide(&pending, &system_approve),
        Err(PolicyError::Denied)
    );

    let clarification = ItemFacts {
        state: ModerationState::Clarification,
        ..item(ParticipationKind::Question, ModerationState::Pending)
    };
    assert_eq!(policy.retention_due(&clarification, day(29)), None);
    assert_eq!(
        policy.retention_due(&clarification, day(30)),
        Some(RetentionStep::Expire)
    );

    let rejected = apply(&pending, &expired);
    assert_eq!(rejected.state_since, day(90));
    assert_eq!(policy.retention_due(&rejected, day(119)), None);
    assert_eq!(
        policy.retention_due(&rejected, day(120)),
        Some(RetentionStep::PurgeContent)
    );
    let purge = policy.purge_event(&rejected, day(120)).unwrap();
    assert_eq!(purge.action, AuditAction::PurgeContent);
    assert_eq!(
        (purge.from, purge.to),
        (Some(ModerationState::Rejected), ModerationState::Rejected)
    );
    assert_eq!(policy.purge_event(&rejected, day(100)), None);

    let purged = ItemFacts {
        content_retained: false,
        ..rejected
    };
    assert_eq!(policy.retention_due(&purged, day(500)), None);
    assert!(!may_view(
        &admin(),
        &purged,
        ParticipationMode::Open,
        View::Content
    ));
    assert!(!may_view(
        &admin(),
        &purged,
        ParticipationMode::Open,
        View::PrivateIdentity
    ));
    let reopen = request(admin(), ModerationAction::Reopen, &purged, None);
    assert_eq!(
        policy.decide(&purged, &reopen),
        Err(PolicyError::ContentPurged)
    );

    // Published items are kept while they are published.
    let approved = item(ParticipationKind::Question, ModerationState::Approved);
    assert_eq!(policy.retention_due(&approved, day(10_000)), None);

    // The audit trail outlives the text by default.
    assert!(!policy.audit_due(day(0), day(364)));
    assert!(policy.audit_due(day(0), day(365)));

    // A shorter configured period applies.
    let brisk = ModerationPolicy::new(RetentionPolicy {
        pending_days: 7,
        ..RetentionPolicy::default()
    });
    assert_eq!(
        brisk.retention_due(&pending, day(7)),
        Some(RetentionStep::Expire)
    );
}

/// Comments predate this policy. A site that never sets
/// `participation.retention` keeps every comment as before: nothing expires a
/// pending comment or purges a rejected one. Setting it opts them in.
#[test]
fn comments_are_kept_out_of_retention_until_the_site_sets_it() {
    let unchanged = policy();
    let pending = ItemFacts {
        state_since: day(0),
        ..item(ParticipationKind::Comment, ModerationState::Pending)
    };
    let rejected = ItemFacts {
        state: ModerationState::Rejected,
        ..pending
    };
    let removed = ItemFacts {
        state: ModerationState::Removed,
        ..pending
    };
    for facts in [pending, rejected, removed] {
        assert_eq!(
            unchanged.retention_due(&facts, day(10_000)),
            None,
            "{}",
            facts.state.id()
        );
        assert_eq!(unchanged.purge_event(&facts, day(10_000)), None);
    }
    let expire = Request {
        at: day(10_000),
        ..request(Actor::System, ModerationAction::Expire, &pending, None)
    };
    assert_eq!(
        unchanged.decide(&pending, &expire),
        Err(PolicyError::NotDue)
    );

    // Retention the site set explicitly, even with the default periods,
    // covers comments too.
    let opted_in = ModerationPolicy::new(RetentionPolicy::default());
    assert!(opted_in.comment_retention);
    assert_eq!(opted_in.retention_due(&pending, day(89)), None);
    assert_eq!(
        opted_in.retention_due(&pending, day(90)),
        Some(RetentionStep::Expire)
    );
    let due = Request {
        at: day(90),
        ..expire
    };
    assert_eq!(
        opted_in.decide(&pending, &due).unwrap().item.to,
        ModerationState::Rejected
    );
    assert_eq!(
        opted_in.retention_due(&rejected, day(30)),
        Some(RetentionStep::PurgeContent)
    );
}

#[test]
fn audit_events_hold_who_when_why_and_which_revision_never_what_was_written() {
    let approved = item(ParticipationKind::Question, ModerationState::Approved);
    let remove = Request {
        reason: Some(ReasonCode::PersonalData),
        ..request(admin(), ModerationAction::Remove, &approved, None)
    };
    let decision = policy().decide(&approved, &remove).unwrap();
    let json = decision.item.audit.to_json();
    let keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "action", "actor", "actorId", "at", "from", "item", "kind", "reason", "related",
            "revision", "to", "version"
        ]
    );
    assert_eq!(json["action"], "remove");
    assert_eq!(json["actor"], "site-admin");
    assert_eq!(json["actorId"], "owner");
    assert_eq!(json["reason"], "personal-data");
    assert_eq!(json["from"], "approved");
    assert_eq!(json["to"], "removed");
    assert_eq!(json["kind"], "question");
    assert_eq!(json["revision"], 2);

    // A reader's submission records no identifier at all.
    let admission = policy()
        .admit(&Submission {
            id: "new",
            actor: Actor::Public,
            kind: ParticipationKind::Comment,
            work: Some(WORK),
            mode: ParticipationMode::Open,
            parent: None,
            parent_target: None,
            author_grant: None,
            clarification_consent: false,
            at: day(1),
        })
        .unwrap();
    assert!(admission.audit.to_json()["actorId"].is_null());
}

#[test]
fn reason_codes_are_moderation_grounds_never_verdicts() {
    for reason in ReasonCode::ALL {
        assert_eq!(ReasonCode::from_id(reason.id()), Some(reason));
        assert!(!["incorrect", "false", "misinformation", "wrong", "untrue"].contains(&reason.id()));
    }
    // Policy-set reasons are never accepted from a request.
    for kind in ParticipationKind::ALL {
        for action in ModerationAction::ALL {
            let allowed = allowed_reasons(action, kind);
            assert!(!allowed.contains(&ReasonCode::UpheldReport));
            assert!(!allowed.contains(&ReasonCode::Expired));
            assert_eq!(
                allowed.contains(&ReasonCode::NoAction),
                action == ModerationAction::Reject && kind == ParticipationKind::AbuseReport
            );
        }
    }
    for action in ModerationAction::ALL {
        assert_eq!(ModerationAction::from_id(action.id()), Some(action));
    }
}
